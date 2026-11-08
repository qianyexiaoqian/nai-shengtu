import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.DATA_DIR = ':memory:';
const { queueSnapshot } = await import('../src/queue.js');
const { saveSettings } = await import('../src/settings.js');
const { generateImages } = await import('../src/upstream.js');
const { addUpstreamKeys, listUpstreamKeys, updateUpstreamKey } = await import('../src/upstreamKeys.js');
const { writeZip } = await import('../src/zip.js');

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png')]);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  saveSettings({ queue_timeout: '300', queue_max: '100' });
});

const zipReply = () => new Response(writeZip([{ name: 'image_0.png', data: PNG }]), { headers: { 'Content-Type': 'application/zip' } });
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const keyId = (name) => listUpstreamKeys().find((k) => k.name === name).id;

/** 假的官方上游：每个请求挂起，按 release() 的顺序一个个放行；记下谁在什么时候开始 */
function gatedUpstream() {
  const started = [];
  const gates = [];
  globalThis.fetch = async (url, init) => {
    const { input } = JSON.parse(init.body);
    const token = init.headers.Authorization.replace('Bearer ', '');
    started.push({ input, token });
    await new Promise((resolve) => gates.push(resolve));
    return zipReply();
  };
  return { started, release: () => gates.shift()?.() };
}

const job = (prompt, opts) =>
  generateImages({ model: 'nai-diffusion-4-5-full', prompt, size: '832x1216' }, { info: { caller: '测试', endpoint: 'images', prompt }, ...opts });

test('并发：默认官方 1、OpenAI 兼容不限，可以改；超出范围报错', () => {
  // 这里只测调度，不管 Anlas：官方秘钥关掉“只出免费图”
  addUpstreamKeys({ keys: 'pst-queue00001', type: 'novelai', name: '官方A', free_only: false });
  addUpstreamKeys({ keys: 'sk-queue000002', base_url: 'https://up.example.com/v1', name: '兼容', models: 'flux-dev' });
  const [nai, openai] = listUpstreamKeys();
  assert.deepEqual([nai.concurrency, openai.concurrency], [1, 0]);
  updateUpstreamKey(nai.id, { concurrency: 2 });
  assert.equal(listUpstreamKeys()[0].concurrency, 2);
  assert.throws(() => updateUpstreamKey(nai.id, { concurrency: -1 }), { status: 400 });
  assert.throws(() => updateUpstreamKey(nai.id, { concurrency: 1.5 }), { status: 400 });
  assert.throws(() => addUpstreamKeys({ keys: 'pst-queue00003', type: 'novelai', concurrency: 101 }), { status: 400 });
});

test('满了就排队：同时最多 2 个，其余按到达顺序等，后台能看到正在出图和排队的', async () => {
  const upstream = gatedUpstream();
  const runs = ['a', 'b', 'c', 'd'].map((p) => job(p));
  await tick();
  assert.deepEqual(upstream.started.map((s) => s.input.split(',')[0]), ['a', 'b']);

  const snap = queueSnapshot();
  assert.deepEqual(snap.keys.map((k) => [k.name, k.active, k.concurrency]), [['官方A', 2, 2], ['兼容', 0, 0]]);
  assert.deepEqual(snap.running.map((r) => [r.prompt, r.key_name, r.caller, r.size]), [['a', '官方A', '测试', '832x1216'], ['b', '官方A', '测试', '832x1216']]);
  assert.deepEqual(snap.waiting.map((w) => [w.position, w.prompt]), [[1, 'c'], [2, 'd']]);
  assert.deepEqual(snap.waiting[0].candidates, [keyId('官方A')]);

  upstream.release();
  await tick();
  assert.deepEqual(upstream.started.map((s) => s.input.split(',')[0]), ['a', 'b', 'c']);
  for (let i = 0; i < 3; i++) {
    upstream.release();
    await tick();
  }
  const results = await Promise.all(runs);
  assert.ok(results.every((r) => r.body.data.length === 1));
  assert.equal(results[0].queueMs, 0);
  assert.ok(results[3].queueMs >= 30); // d 等了两轮
  assert.deepEqual([queueSnapshot().running.length, queueSnapshot().waiting.length], [0, 0]);
});

test('排队超时返回 503；调用方断开时移出队列；排满了直接拒绝', async () => {
  const upstream = gatedUpstream();
  updateUpstreamKey(keyId('官方A'), { concurrency: 1 });
  const first = job('first');
  await tick();

  saveSettings({ queue_timeout: '0.05' });
  const late = await job('late').catch((e) => e);
  assert.deepEqual([late.status, late.code], [503, 'queue_timeout']);
  assert.ok(late.queueMs >= 40);

  saveSettings({ queue_timeout: '300', queue_max: '1' });
  const controller = new AbortController();
  const gone = job('gone', { signal: controller.signal }).catch((e) => e);
  await tick();
  assert.equal(queueSnapshot().waiting.length, 1);
  const full = await job('full').catch((e) => e);
  assert.deepEqual([full.status, full.code], [503, 'queue_full']);

  controller.abort();
  assert.equal((await gone).status, 499);
  assert.equal(queueSnapshot().waiting.length, 0);

  upstream.release();
  await first;
  assert.equal(upstream.started.length, 1); // 超时和断开的都没发到上游
});

test('换秘钥：一把 402 后去下一把；下一把满了就排队，回到原来的位次', async () => {
  addUpstreamKeys({ keys: 'pst-queue00009', type: 'novelai', name: '官方B', free_only: false });
  const started = [];
  const gates = [];
  globalThis.fetch = async (url, init) => {
    const token = init.headers.Authorization.replace('Bearer ', '');
    const { input } = JSON.parse(init.body);
    started.push(`${input.split(',')[0]}@${token.slice(-1)}`);
    await new Promise((resolve) => gates.push(resolve));
    if (token === 'pst-queue00001') return new Response(JSON.stringify({ statusCode: 402, message: 'Insufficient Anlas' }), { status: 402 });
    return zipReply();
  };
  // 两把各 1 个并发：x、y 各占一把，z 排队
  const runs = ['x', 'y', 'z'].map((p) => job(p));
  await tick();
  assert.equal(started.length, 2);
  assert.equal(queueSnapshot().waiting[0].prompt, 'z');

  // 官方A 上的那个 402，换到官方B，但官方B 正忙，排到 z 前面
  const onA = started.findIndex((s) => s.endsWith('@1'));
  gates.splice(onA, 1)[0]();
  await tick();
  const waiting = queueSnapshot().waiting;
  assert.equal(waiting.length, 2);
  assert.ok(waiting[0].retry && !waiting[1].retry);
  assert.equal(waiting[1].prompt, 'z');

  while (gates.length || queueSnapshot().waiting.length) {
    gates.shift()?.();
    await tick();
  }
  const results = await Promise.all(runs);
  assert.ok(results.every((r) => r.upstreamKey.key === 'pst-queue00009'));
  assert.ok(listUpstreamKeys().find((k) => k.id === keyId('官方A')).cooling_until > Date.now());
});
