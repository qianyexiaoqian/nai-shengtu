import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.DATA_DIR = ':memory:';
const { db } = await import('../src/db.js');
const { anlasCost } = await import('../src/anlas.js');
const { executeGeneration, prepareGeneration } = await import('../src/generate.js');
const { createKey } = await import('../src/keys.js');
const { addModels, seedModels } = await import('../src/models.js');
const { refreshAccount } = await import('../src/naiAccounts.js');
const { toUpstreamPayload } = await import('../src/params.js');
const { acquireKey, createJob, dispatch, releaseKey } = await import('../src/queue.js');
const { saveSettings } = await import('../src/settings.js');
const { generateImages } = await import('../src/upstream.js');
const {
  addUpstreamKeys, getUpstreamKey, listUpstreamKeys, liveAccount, saveAccount, savedAccount, updateUpstreamKey,
} = await import('../src/upstreamKeys.js');
const { writeZip } = await import('../src/zip.js');

seedModels();
addModels([{ id: 'nai-diffusion-4-5-full' }]);

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png')]);
const OPUS = { level: 3, tier: 'Opus', active: true, anlas: 5000, usage_negative: false, usage_percent: 40, extra_percent: 0 };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const zipReply = () => new Response(writeZip([{ name: 'image_0.png', data: PNG }]), { headers: { 'Content-Type': 'application/zip' } });
const idOf = (name) => listUpstreamKeys().find((k) => k.name === name).id;
function only(...names) {
  for (const k of listUpstreamKeys()) updateUpstreamKey(k.id, { enabled: names.includes(k.name) });
}

test('NAI5 用量条：上一张出完之前的查询结果不算数，出下一张前先查；用量条扣完就不再发', async () => {
  addUpstreamKeys({ keys: 'pst-guardbar01', type: 'novelai', name: '条' });
  only('条');
  // 用量条只剩 1%：每张都要重新查。出完第一张后 NovelAI 说用量条用完了
  saveAccount(idOf('条'), { ...OPUS, usage_percent: 1 });
  let generated = 0;
  const subscriptionChecks = [];
  globalThis.fetch = async (url) => {
    if (/user\/subscription/.test(url)) {
      subscriptionChecks.push(generated);
      return Response.json({ tier: 3, active: true, usage: { percent: 0, isNegative: generated >= 1 } });
    }
    await tick(30);
    generated++;
    return zipReply();
  };
  const results = await Promise.all([1, 2, 3].map(() =>
    generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' }).then((r) => r.applied.anlas, (e) => e.code)));
  assert.equal(generated, 1);
  assert.deepEqual(results.sort(), [0, 'free_quota_exhausted', 'free_quota_exhausted'].sort());
  assert.ok(subscriptionChecks.length >= 1 && subscriptionChecks.every((g) => g >= 1)); // 只在出过图之后查
  assert.equal(savedAccount(getUpstreamKey(idOf('条'))).usage_negative, true);

  // 用量条还剩很多（≥5%）、查询又是一分钟内的：不用每张都查
  saveAccount(idOf('条'), { ...OPUS, usage_percent: 60 });
  let checks = 0;
  globalThis.fetch = async (url) => {
    if (/user\/subscription/.test(url)) checks++;
    return zipReply();
  };
  for (let i = 0; i < 3; i++) await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' });
  assert.equal(checks, 0);
});

test('查账号：晚到的旧结果不覆盖新的；最近一次查失败就不算数；订阅过期不算 Opus', async () => {
  const id = idOf('条');
  const now = Date.now();
  saveAccount(id, { ...OPUS, usage_negative: true }, null, now);
  saveAccount(id, { ...OPUS, usage_negative: false }, null, now - 1000); // 更早发出的查询后到
  assert.equal(savedAccount(getUpstreamKey(id)).usage_negative, true);

  saveAccount(id, OPUS);
  assert.ok(liveAccount(getUpstreamKey(id)));
  saveAccount(id, null, 'HTTP 500');
  assert.equal(liveAccount(getUpstreamKey(id)), null);

  // 200 但不是订阅信息（反代把别的页面回来）：当查失败，不当成“查到了一个免费账号”
  saveAccount(id, OPUS);
  globalThis.fetch = async () => new Response('<html>hi</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  const saved = await refreshAccount(getUpstreamKey(id));
  assert.deepEqual([saved.level, saved.error], [3, '返回的不是订阅信息']);

  const expired = anlasCost('nai-diffusion-4-5-full', { width: 832, height: 1216, steps: 28 }, { ...OPUS, expires_at: Date.now() - 1000 });
  assert.deepEqual([expired.total, expired.accountReason?.includes('过期')], [20, true]);
  saveAccount(id, OPUS);
});

test('奇怪的请求值（对象、数组）不往下传，调度也不会因为它出异常', async () => {
  const payload = toUpstreamPayload(
    { steps: { toString: 1 }, seed: [1], sampler: { a: 1 }, scale: 5, n: 2 }, 'cat', {}, 'nai-diffusion-4-5-full',
  );
  assert.deepEqual(Object.keys(payload).sort(), ['model', 'n', 'prompt', 'scale']);

  // 排队中的请求，判断接不接时抛异常：当这把不接，dispatch 不能抛出去
  addUpstreamKeys({ keys: 'sk-guardbusy01', base_url: 'https://up.example.com/v1', name: '忙', concurrency: 1 });
  only('忙');
  const holder = createJob('nai-diffusion-4-5-full');
  assert.equal((await acquireKey(holder)).name, '忙');
  let explode = false;
  const job = createJob('nai-diffusion-4-5-full', {
    accepts: () => {
      if (explode) throw new TypeError('Cannot convert object to primitive value');
      return true;
    },
  });
  const waiting = acquireKey(job);
  await tick();
  explode = true;
  assert.doesNotThrow(() => dispatch());
  assert.equal(await waiting, null); // 没有能接的了，正常结束（调用方会拿到错误），进程不受影响
  releaseKey(holder);
});

test('把秘钥改成官方类型：没一起改的并发、出图上限、只出免费图按官方的默认值来；改回去关掉只出免费图', () => {
  addUpstreamKeys({ keys: 'pst-guardtype1', base_url: 'https://image.novelai.net', name: '类型' });
  const id = idOf('类型');
  const row = () => listUpstreamKeys().find((k) => k.id === id);
  assert.deepEqual([row().type, row().concurrency, row().max_pixels, row().free_only], ['openai', 0, 0, 0]);
  // 列表的“保存”会把没动过的并发（0）一起带上
  updateUpstreamKey(id, { type: 'novelai', concurrency: '0', priority: '0', name: '类型' });
  assert.deepEqual(
    [row().type, row().concurrency, row().max_pixels, row().max_steps, row().max_n, row().free_only],
    ['novelai', 1, 1048576, 28, 1, 1],
  );
  updateUpstreamKey(id, { type: 'openai', base_url: 'https://up.example.com/v1' });
  assert.deepEqual([row().free_only, row().max_pixels, row().concurrency], [0, 0, 0]);
  updateUpstreamKey(id, { free_only: true }); // OpenAI 兼容的秘钥打不开
  assert.equal(row().free_only, 0);
});

test('同优先级里有一把一直不接（比如 NAI5 免费额度用完）：其余几把照样平分', async () => {
  addUpstreamKeys({ keys: 'pst-guardskew1', type: 'novelai', name: '拒' });
  addUpstreamKeys({ keys: 'sk-guardskew02', base_url: 'https://a.example.com/v1', name: 'P1' });
  addUpstreamKeys({ keys: 'sk-guardskew03', base_url: 'https://b.example.com/v1', name: 'P2' });
  saveAccount(idOf('拒'), { ...OPUS, usage_negative: true });
  only('拒', 'P1', 'P2');
  const hosts = [];
  globalThis.fetch = async (url) => {
    hosts.push(new URL(url).host);
    return Response.json({ created: 1, data: [{ b64_json: PNG.toString('base64') }] });
  };
  for (let i = 0; i < 6; i++) await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' });
  assert.equal(hosts.filter((h) => h === 'a.example.com').length, 3);
  assert.equal(hosts.filter((h) => h === 'b.example.com').length, 3);
});

test('排队的请求先挑刚变得能用的秘钥，后来的不插队', async () => {
  updateUpstreamKey(idOf('拒'), { priority: 10 });
  updateUpstreamKey(idOf('P1'), { concurrency: 1 });
  only('拒', 'P1');
  // 和真的 NAI5 请求一样：用量条用完时“拒”那把不接
  const accepts = (key) => key.name !== '拒' || !savedAccount(getUpstreamKey(key.id)).usage_negative;
  const holder = createJob('nai-diffusion-5-full', { accepts });
  assert.equal((await acquireKey(holder)).name, 'P1'); // P1 被占着
  const first = createJob('nai-diffusion-5-full', { accepts });
  const firstKey = acquireKey(first);
  await tick();
  saveAccount(idOf('拒'), OPUS); // 用量条恢复了（没调 dispatch）
  const second = createJob('nai-diffusion-5-full', { accepts: first.accepts });
  const secondKey = acquireKey(second);
  assert.equal((await firstKey).name, '拒');
  releaseKey(holder);
  assert.equal((await secondKey).name, 'P1');
  releaseKey(first);
  releaseKey(second);
  updateUpstreamKey(idOf('拒'), { priority: 0 });
  updateUpstreamKey(idOf('P1'), { concurrency: 0 });
});

test('额度按实际会出的张数算；耗时不算 AI 优化的时间；只是请求超出免费范围的返回 400', async () => {
  only('条');
  saveAccount(idOf('条'), OPUS);
  globalThis.fetch = async () => zipReply();
  const key = createKey({ name: '额度', quota_images: 3 });
  db.prepare('UPDATE api_keys SET used_images = 2 WHERE id = ?').run(key.id);
  const ctx = { key: { ...key, used_images: 2 }, baseUrl: 'http://relay', ip: '' };
  // 要 2 张，但官方秘钥一次只出 1 张：只占 1 张额度，不报额度不足
  const result = await executeGeneration(prepareGeneration(ctx, 'images', { model: 'nai-diffusion-4-5-full', n: 2 }, 'cat', {}));
  assert.equal(result.images.length, 1);

  saveSettings({ ai_mode: 'always', ai_base_url: 'https://ai.example.com/v1', ai_api_key: 'sk-ai-test', ai_model: 'm' });
  globalThis.fetch = async (url) => {
    if (/chat\/completions/.test(url)) {
      await tick(300);
      return Response.json({ choices: [{ message: { content: 'cat' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    return zipReply();
  };
  const other = createKey({ name: '耗时' });
  const job = prepareGeneration({ key: other, baseUrl: 'http://relay', ip: '' }, 'images', { model: 'nai-diffusion-4-5-full' }, '一只猫', {});
  await executeGeneration(job);
  assert.ok(db.prepare('SELECT duration_ms FROM logs ORDER BY id DESC LIMIT 1').get().duration_ms < 250);
  saveSettings({ ai_mode: 'off' });

  updateUpstreamKey(idOf('条'), { max_pixels: 0 });
  globalThis.fetch = async () => zipReply();
  const err = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat', size: '1536x1024' }).catch((e) => e);
  assert.deepEqual([err.status, err.code], [400, 'outside_free_range']);
  updateUpstreamKey(idOf('条'), { max_pixels: '1024x1024' });
});
