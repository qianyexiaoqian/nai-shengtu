import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

process.env.DATA_DIR = ':memory:';
const { db } = await import('../src/db.js');
const { generateImages } = await import('../src/upstream.js');
const { pullUpstreamModels } = await import('../src/models.js');
const { accountOf, addUpstreamKeys, listUpstreamKeys, updateUpstreamKey, upstreamKeyOrder } = await import('../src/upstreamKeys.js');

const BASE = 'https://up.example.com/v1';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** 假上游：按秘钥返回不同状态，记下每次请求用的秘钥和地址 */
function fakeUpstream(statusByKey) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const key = init.headers.Authorization.replace('Bearer ', '');
    calls.push({ key, url });
    const status = statusByKey[key] ?? 200;
    return json(status, status === 200
      ? { created: 1, data: [{ url: `https://up.example.com/img/${key}.png` }] }
      : { error: { message: `秘钥 ${key} 出错` } });
  };
  return calls;
}

const ids = () => Object.fromEntries(db.prepare('SELECT key, id FROM upstream_keys').all().map((r) => [r.key, r.id]));

test('添加多把秘钥：换行和逗号都能分隔，重复的跳过，列表里不出现原文', () => {
  const added = addUpstreamKeys({ keys: 'sk-aaaaaaaa1\nsk-bbbbbbbb2, sk-cccccccc3', base_url: `${BASE}/`, name: '主', account: '主账号' });
  assert.deepEqual([added.added, added.skipped, added.ids.length, added.type], [3, 0, 3, 'openai']);
  const again = addUpstreamKeys({ keys: 'sk-aaaaaaaa1', base_url: BASE });
  assert.deepEqual([again.added, again.skipped, again.ids], [0, 1, []]);
  const list = listUpstreamKeys();
  assert.deepEqual(list.map((k) => k.name), ['主-1', '主-2', '主-3']);
  assert.ok(list.every((k) => !('key' in k) && k.key_hint.includes('…') && k.base_url === BASE && k.models === ''));
});

test('轮询：每次从下一把开始', () => {
  const firsts = [0, 1, 2, 3].map(() => upstreamKeyOrder()[0].key);
  assert.deepEqual(firsts, ['sk-aaaaaaaa1', 'sk-bbbbbbbb2', 'sk-cccccccc3', 'sk-aaaaaaaa1']);
});

test('秘钥被拒（402）自动换下一把，失败的那把进冷却、排到最后', async () => {
  // 轮询游标此时指向第 2 把
  const calls = fakeUpstream({ 'sk-bbbbbbbb2': 402 });
  const { body, upstreamKey } = await generateImages({ prompt: 'cat' });
  assert.deepEqual(calls.map((c) => c.key), ['sk-bbbbbbbb2', 'sk-cccccccc3']);
  assert.equal(calls[0].url, `${BASE}/images/generations`);
  assert.equal(upstreamKey.key, 'sk-cccccccc3');
  assert.equal(body.data[0].url, 'https://up.example.com/img/sk-cccccccc3.png');

  const failed = listUpstreamKeys().find((k) => k.id === ids()['sk-bbbbbbbb2']);
  assert.ok(failed.cooling_until > Date.now());
  assert.match(failed.last_error, /402/);
  for (let i = 0; i < 3; i++) assert.equal(upstreamKeyOrder().at(-1).key, 'sk-bbbbbbbb2');

  updateUpstreamKey(failed.id, { enabled: true }); // 手动启用清掉冷却
  assert.equal(listUpstreamKeys().find((k) => k.id === failed.id).cooling_until, null);
});

test('超时、5xx、参数错误不换秘钥重试（上游可能已扣点）', async () => {
  const calls = fakeUpstream({ 'sk-aaaaaaaa1': 500, 'sk-bbbbbbbb2': 500, 'sk-cccccccc3': 500 });
  await assert.rejects(generateImages({ prompt: 'cat' }), { status: 500 });
  assert.equal(calls.length, 1);
});

test('所有秘钥都被拒：调用方只看到服务不可用，错误上带着最后用的秘钥', async () => {
  fakeUpstream({ 'sk-aaaaaaaa1': 401, 'sk-bbbbbbbb2': 403, 'sk-cccccccc3': 402 });
  const err = await generateImages({ prompt: 'cat' }).catch((e) => e);
  assert.equal(err.status, 503);
  assert.equal(err.message, '生图失败：服务暂时不可用，请联系管理员');
  assert.match(err.internal, /上游秘钥不可用/);
  assert.ok(err.upstreamKey);
});

test('停用的秘钥不参与轮询；没有可用秘钥时 503', async () => {
  for (const id of Object.values(ids())) updateUpstreamKey(id, { enabled: false });
  assert.deepEqual(upstreamKeyOrder(), []);
  await assert.rejects(generateImages({ prompt: 'cat' }), { status: 503, code: 'not_configured' });
});

test('所属账号：填了用账号名，没填每把单独算', () => {
  assert.equal(accountOf({ id: 7, account: ' 主账号 ' }), '主账号');
  assert.equal(accountOf({ id: 7, account: '' }), '#7');
});

test('接口地址必填，只能是 http(s)', () => {
  assert.throws(() => addUpstreamKeys({ keys: 'sk-xxxxxxxx9' }), { status: 400 });
  assert.throws(() => addUpstreamKeys({ keys: 'sk-xxxxxxxx9', base_url: 'ftp://files.example.com/v1' }), { status: 400 });
  assert.throws(() => updateUpstreamKey(ids()['sk-aaaaaaaa1'], { base_url: '' }), { status: 400 });
});

test('多个上游：只轮到支持这个模型的秘钥，各用各的接口地址', async () => {
  // 误填到具体接口、末尾带斜杠的地址都截成 /v1；模型名中英文逗号、空格都能分隔，重复的去掉
  addUpstreamKeys({ keys: 'sk-flux00001', base_url: 'https://flux.example.net/v1/images/generations', models: 'flux-dev，flux-pro flux-dev' });
  addUpstreamKeys({ keys: 'sk-nai000001', base_url: 'https://nai.example.org/v1/', models: 'nai-diffusion-5-full' });
  const flux = listUpstreamKeys().find((k) => k.id === ids()['sk-flux00001']);
  assert.equal(flux.base_url, 'https://flux.example.net/v1');
  assert.equal(flux.models, 'flux-dev,flux-pro');

  const calls = fakeUpstream({});
  await generateImages({ model: 'flux-dev', prompt: 'cat' });
  await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' });
  assert.deepEqual(calls.map((c) => c.url), [
    'https://flux.example.net/v1/images/generations',
    'https://nai.example.org/v1/images/generations',
  ]);
  // 前面的三把都停用了，剩下两把都不接 sdxl
  await assert.rejects(generateImages({ model: 'sdxl', prompt: 'cat' }), { status: 503, code: 'not_configured' });
});

test('上游说没有这个模型（404）：换下一把，但不冷却', async () => {
  updateUpstreamKey(ids()['sk-flux00001'], { models: '' }); // 改成什么都接，请求 NAI 模型时也会轮到它
  const calls = fakeUpstream({ 'sk-flux00001': 404 });
  // 两把轮流打头，两次里一定有一次先轮到 flux
  for (let i = 0; i < 2; i++) await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' });
  assert.equal(calls.filter((c) => c.key === 'sk-flux00001').length, 1);
  const flux = listUpstreamKeys().find((k) => k.id === ids()['sk-flux00001']);
  assert.equal(flux.cooling_until, null);
  assert.match(flux.last_error, /404/);
});

test('上游只给 b64_json、不认 response_format 也能用', async () => {
  updateUpstreamKey(ids()['sk-nai000001'], { enabled: false });
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const formats = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    formats.push(body.response_format);
    if ('response_format' in body) return json(400, { error: { message: "Unknown parameter: 'response_format'." } });
    return json(200, { created: 1, data: [{ b64_json: png }] });
  };
  const { body } = await generateImages({ model: 'flux-dev', prompt: 'cat' });
  assert.equal(body.data[0].b64_json, png);
  assert.deepEqual(formats, ['url', undefined]);
});

test('点数不足时上游回 200 却给提示图：按生图失败处理，换下一把、这把冷却；混着真图的只留真图', async () => {
  updateUpstreamKey(ids()['sk-nai000001'], { enabled: true, models: '' });
  updateUpstreamKey(ids()['sk-flux00001'], { models: '' });
  const HINT = 'https://up.example.com/img/error/balance-insufficient-20260828.png';
  const replies = { 'sk-flux00001': [HINT], 'sk-nai000001': ['https://up.example.com/img/2026-11-02/nai.png'] };
  globalThis.fetch = async (url, init) =>
    json(200, { created: 1, data: replies[init.headers.Authorization.replace('Bearer ', '')].map((u) => ({ url: u })) });

  // 两把轮流打头：先轮到欠费的那把时换下一把，两次都拿到真图
  for (let i = 0; i < 2; i++) {
    const { body } = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' });
    assert.deepEqual(body.data, [{ url: 'https://up.example.com/img/2026-11-02/nai.png' }]);
  }
  const flux = listUpstreamKeys().find((k) => k.id === ids()['sk-flux00001']);
  assert.ok(flux.cooling_until > Date.now());
  assert.match(flux.last_error, /提示图 balance-insufficient-20260828\.png（账号点数不足）/);

  // 全是提示图：调用方看到生图失败，不会拿到提示图
  replies['sk-nai000001'] = [HINT];
  const err = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' }).catch((e) => e);
  assert.deepEqual([err.status, err.code, err.message], [503, 'upstream_unavailable', '生图失败：服务暂时不可用，请联系管理员']);

  // 批量里混着提示图：只留真图
  replies['sk-nai000001'] = ['https://up.example.com/img/2026-11-02/a.png', HINT];
  replies['sk-flux00001'] = replies['sk-nai000001'];
  const { body } = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat', n: 2 });
  assert.deepEqual(body.data, [{ url: 'https://up.example.com/img/2026-11-02/a.png' }]);
});

test('拉取模型：已添加的秘钥用库里的地址和秘钥，添加表单里的用填的地址和第一把秘钥', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    return json(200, { data: [{ id: 'nai-diffusion-5-full' }, { id: 'director' }, { id: 'flux-dev' }] });
  };
  // director 是 NAI 的图像处理功能，不能文生图，去掉
  const pulled = await pullUpstreamModels({ id: ids()['sk-flux00001'] });
  assert.deepEqual(pulled, {
    base_url: 'https://flux.example.net/v1', type: 'openai', models: ['nai-diffusion-5-full', 'flux-dev'], account: null,
  });
  assert.deepEqual(seen[0], { url: 'https://flux.example.net/v1/models', auth: 'Bearer sk-flux00001' });

  await pullUpstreamModels({ base_url: 'https://new.example.com/v1/images/generations', keys: 'sk-newkey0001\nsk-newkey0002' });
  assert.deepEqual(seen[1], { url: 'https://new.example.com/v1/models', auth: 'Bearer sk-newkey0001' });
  await assert.rejects(pullUpstreamModels({ base_url: 'https://new.example.com/v1' }), { status: 400 }); // 没填秘钥
  await assert.rejects(pullUpstreamModels({ id: 9999 }), { status: 404 });

  globalThis.fetch = async () => json(401, { error: { message: 'invalid key' } });
  await assert.rejects(pullUpstreamModels({ id: ids()['sk-flux00001'] }), { status: 502 });
});
