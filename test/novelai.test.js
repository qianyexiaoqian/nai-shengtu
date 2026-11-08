import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

process.env.DATA_DIR = ':memory:';
const { createKey } = await import('../src/keys.js');
const { addModels, pullUpstreamModels, seedModels } = await import('../src/models.js');
const { handleNaiGenerate, handleNaiSubscription } = await import('../src/naiApi.js');
const { novelaiBody, novelaiRequest } = await import('../src/novelai.js');
const { toUpstreamPayload } = await import('../src/params.js');
const { generateImages } = await import('../src/upstream.js');
const { addUpstreamKeys, listUpstreamKeys, saveAccount, updateUpstreamKey } = await import('../src/upstreamKeys.js');
const { readZip, writeZip } = await import('../src/zip.js');

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake png')]);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const zipReply = (...images) =>
  new Response(writeZip(images.map((data, i) => ({ name: `image_${i}.png`, data }))), {
    status: 200,
    headers: { 'Content-Type': 'application/zip' },
  });
const jsonReply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// 官方秘钥默认“只出免费图”，要先有账号状态才接请求：这里当成查到了一个有效的 Opus 账号
const opus = (id) => saveAccount(id, { level: 3, tier: 'Opus', active: true, anlas: 10000, usage_negative: false, usage_percent: 80 });
const idOf = (token) => listUpstreamKeys().find((k) => k.key_hint === `${token.slice(0, 6)}…${token.slice(-4)}`).id;

/** 假的 NovelAI 官方：记下每次请求的地址、令牌和解析好的请求体；发给本机测试服务器的请求照常放行 */
function fakeNovelai(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    const call = { url: String(url), token: init.headers?.Authorization?.replace('Bearer ', ''), multipart: init.body instanceof FormData };
    if (call.multipart) call.request = JSON.parse(await init.body.get('request').text());
    else if (init.body) call.request = JSON.parse(init.body);
    calls.push(call);
    return handler(call);
  };
  return calls;
}

test('ZIP：写出来的能读回；也能读 deflate 压缩的条目', () => {
  const files = readZip(writeZip([{ name: 'image_0.png', data: PNG }, { name: 'image_1.png', data: Buffer.from('second') }]));
  assert.deepEqual(files.map((f) => f.name), ['image_0.png', 'image_1.png']);
  assert.deepEqual(files[0].data, PNG);

  // 手拼一个 deflate 条目（method 8）
  const zip = writeZip([{ name: 'a.png', data: PNG }]);
  const packed = deflateRawSync(PNG);
  const nameLength = 5;
  const local = Buffer.from(zip.subarray(0, 30 + nameLength));
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  const central = Buffer.from(zip.subarray(30 + nameLength + PNG.length, zip.length - 22));
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  const end = Buffer.from(zip.subarray(zip.length - 22));
  end.writeUInt32LE(local.length + packed.length, 16);
  assert.deepEqual(readZip(Buffer.concat([local, packed, central, end]))[0].data, PNG);
});

test('OpenAI 格式 → 官方 V5 请求：params_version 4、按名字的预设、拼质量词和负面预设', () => {
  const payload = toUpstreamPayload({ negative_prompt: 'bad hands', seed: 42 }, '1girl, smile', { aspect_ratio: '2:3' }, 'nai-diffusion-5-full');
  const req = novelaiRequest(payload);
  assert.equal(req.model, 'nai-diffusion-5-full');
  assert.equal(req.action, 'generate');
  assert.equal(req.input, '1girl, smile, very aesthetic, masterpiece, no text');
  const p = req.parameters;
  assert.deepEqual([p.params_version, p.width, p.height, p.seed, p.n_samples], [4, 832, 1216, 42, 1]);
  assert.deepEqual([p.ucPreset, p.ucPresetId, p.qualityPresetId, p.skip_cfg_above_sigma], [0, 'heavy', 'standard', null]);
  assert.match(p.negative_prompt, /^nsfw, lowres, artistic error.*blank page, bad hands$/);
  assert.equal(p.v4_prompt.caption.base_caption, req.input);
  assert.equal(p.v4_negative_prompt.caption.base_caption, p.negative_prompt);
  assert.equal(p.noise_schedule, 'karras');
  // V5 照网页端用 multipart，JSON 在 request 部分
  assert.ok(novelaiBody(req).body instanceof FormData);
});

test('提示词里有 nsfw 时负面预设去掉 nsfw；可以关掉质量词、换负面预设；V3 没有 v4_prompt、发 JSON', () => {
  const nsfw = novelaiRequest({ model: 'nai-diffusion-4-5-full', prompt: 'nsfw, 1girl' });
  assert.doesNotMatch(nsfw.parameters.negative_prompt, /nsfw/);
  assert.equal(nsfw.parameters.params_version, 3);
  assert.equal(nsfw.parameters.ucPresetId, undefined);

  const plain = novelaiRequest({ model: 'nai-diffusion-4-5-full', prompt: '1girl', nai: { qualityToggle: false, ucPreset: 4 } });
  assert.equal(plain.input, '1girl');
  assert.equal(plain.parameters.negative_prompt, ''); // 第 5 个预设是 none

  const v3 = novelaiRequest({ model: 'nai-diffusion-3', prompt: '1girl', size: '1000x1500', nai: { sm: true } });
  assert.equal(v3.parameters.v4_prompt, undefined);
  assert.deepEqual([v3.parameters.width, v3.parameters.height], [1024, 1472]); // 取到 64 的倍数
  assert.equal(v3.parameters.sm, true);
  assert.equal(typeof novelaiBody(v3).body, 'string');

  const medium = novelaiRequest({ model: 'nai-diffusion-5-full-medium', prompt: '1girl', steps: 40, sampler: 'k_dpmpp_2m' });
  assert.deepEqual([medium.parameters.steps, medium.parameters.sampler, medium.parameters.ucPresetId], [14, 'k_euler_ancestral', 'heavy']);
});

test('官方上游：请求 /ai/generate-image，ZIP 里的图片转成 b64_json；默认 Opus 免费档、只出免费图', async () => {
  addUpstreamKeys({ keys: 'pst-aaaaaaaa1', type: 'novelai', base_url: '', name: '官方' });
  const [key] = listUpstreamKeys();
  assert.deepEqual([key.type, key.base_url], ['novelai', 'https://image.novelai.net']);
  assert.deepEqual([key.max_pixels, key.max_steps, key.max_n, key.free_only, key.priority], [1048576, 28, 1, 1, 0]);

  // 账号状态还不知道：只出免费图的秘钥不接，直接 503，不发请求
  const calls = fakeNovelai(() => zipReply(PNG, PNG));
  const unknown = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: '1girl' }).catch((e) => e);
  assert.deepEqual([unknown.status, unknown.code, calls.length], [503, 'free_quota_exhausted', 0]);
  assert.match(unknown.internal, /账号状态未知/);

  opus(key.id);
  const one = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: '1girl', n: 2 });
  assert.equal(calls[0].url, 'https://image.novelai.net/ai/generate-image');
  assert.equal(calls[0].token, 'pst-aaaaaaaa1');
  assert.equal(calls[0].multipart, false);
  assert.equal(calls[0].request.parameters.n_samples, 1); // 一次 2 张：第 2 张要花 Anlas，按上限压成 1 张
  assert.deepEqual(one.applied.changes, ['张数 2 → 1']);
  assert.equal(one.applied.anlas, 0);

  // 不限张数、也不限只出免费图：照要的出 2 张
  updateUpstreamKey(key.id, { max_n: 0, free_only: false });
  const { body, applied } = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: '1girl', n: 2 });
  assert.equal(calls[1].request.parameters.n_samples, 2);
  assert.equal(applied.anlas, 20); // Opus 第一张免费，第二张按 V4.5 1024x1024、28 步收 20
  assert.deepEqual(body.data.map((d) => d.b64_json), [PNG.toString('base64'), PNG.toString('base64')]);
  updateUpstreamKey(key.id, { max_n: 1, free_only: true });
});

test('同一把官方秘钥的请求排队，不会并发（官方并发会 429）', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let active = 0;
  let maxActive = 0;
  fakeNovelai(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await gate;
    active--;
    return zipReply(PNG);
  });
  const runs = [1, 2, 3].map(() => generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(active, 1);
  release();
  await Promise.all(runs);
  assert.equal(maxActive, 1);
});

test('官方 402（Anlas 不足）：换下一把，这把冷却；调用方看不到上游原话', async () => {
  addUpstreamKeys({ keys: 'pst-bbbbbbbb2', type: 'novelai' });
  opus(idOf('pst-bbbbbbbb2'));
  const calls = fakeNovelai((call) =>
    call.token === 'pst-aaaaaaaa1' ? jsonReply(402, { statusCode: 402, message: 'Insufficient Anlas' }) : zipReply(PNG));
  for (let i = 0; i < 2; i++) await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' });
  assert.equal(calls.filter((c) => c.token === 'pst-aaaaaaaa1').length, 1);
  const failed = listUpstreamKeys().find((k) => k.key_hint.startsWith('pst-aa'));
  assert.ok(failed.cooling_until > Date.now());
  assert.match(failed.last_error, /402.*Insufficient Anlas/);

  // 都不行：503，原因只进日志
  globalThis.fetch = async () => jsonReply(401, { statusCode: 401, message: 'Invalid accessToken' });
  const err = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' }).catch((e) => e);
  assert.deepEqual([err.status, err.message], [503, '生图失败：服务暂时不可用，请联系管理员']);
  assert.match(err.internal, /Invalid accessToken/);
  for (const k of listUpstreamKeys()) updateUpstreamKey(k.id, { enabled: true }); // 清掉冷却
});

test('官方 400 参数错误原样告诉调用方（去掉网址），不换秘钥', async () => {
  const calls = fakeNovelai(() => jsonReply(400, { statusCode: 400, message: 'width must be <= 2048, see https://novelai.net/docs' }));
  const err = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' }).catch((e) => e);
  assert.deepEqual([err.status, err.message], [400, 'width must be <= 2048, see ***']);
  assert.equal(calls.length, 1);
});

test('拉取模型：官方秘钥给内置模型列表，并查套餐和 Anlas', async () => {
  const calls = fakeNovelai(() =>
    jsonReply(200, { tier: 3, active: true, trainingStepsLeft: { fixedTrainingStepsLeft: 10000, purchasedTrainingSteps: 500 } }));
  const pulled = await pullUpstreamModels({ type: 'novelai', keys: 'pst-cccccccc3' });
  assert.equal(calls[0].url, 'https://image.novelai.net/user/subscription');
  assert.equal(pulled.base_url, 'https://image.novelai.net');
  assert.ok(pulled.models.includes('nai-diffusion-5-full'));
  assert.deepEqual([pulled.account.tier, pulled.account.anlas], ['Opus', 10500]);

  // 令牌不对、反代没转 /user/subscription：照样列出模型，把查账号的错误带回去
  globalThis.fetch = async () => jsonReply(401, { statusCode: 401, message: 'Invalid accessToken' });
  const bad = await pullUpstreamModels({ type: 'novelai', keys: 'pst-badbadbad' });
  assert.deepEqual([bad.account, bad.account_error, bad.models.length > 0], [null, 'HTTP 401：Invalid accessToken', true]);
});

// ---------- 对外的 NovelAI 格式接口 ----------

seedModels();
addModels([{ id: 'nai-diffusion-4-5-full' }]);
const relayKey = createKey({ name: 'NAI 客户端' }).key;

const server = http.createServer((req, res) =>
  req.url.startsWith('/ai/') ? handleNaiGenerate(req, res) : handleNaiSubscription(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const BASE = `http://127.0.0.1:${server.address().port}`;

const naiRequest = (body, headers = {}) =>
  realFetch(`${BASE}/ai/generate-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${relayKey}`, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body),
  });

// 网页端 / SillyTavern 这类客户端发的样子：质量词、负面预设已经拼好，带多角色
const CLIENT_BODY = {
  input: '1girl, smile, very aesthetic, masterpiece, no text',
  model: 'nai-diffusion-4-5-full',
  action: 'generate',
  parameters: {
    params_version: 3, width: 832, height: 1216, scale: 6, sampler: 'k_euler_ancestral', steps: 23, n_samples: 1,
    ucPreset: 0, qualityToggle: true, seed: 12345, noise_schedule: 'karras', cfg_rescale: 0.2,
    negative_prompt: 'lowres, bad anatomy',
    v4_prompt: {
      caption: { base_caption: '1girl, smile', char_captions: [{ char_caption: 'girl, red hair', centers: [{ x: 0.5, y: 0.5 }] }] },
      use_coords: true,
      use_order: true,
    },
    v4_negative_prompt: { caption: { base_caption: 'lowres', char_captions: [] }, legacy_uc: false },
    characterPrompts: [{ prompt: 'girl, red hair', uc: '', center: { x: 0.5, y: 0.5 }, enabled: true }],
  },
};

test('POST /ai/generate-image：官方格式进、ZIP 出，客户端的参数原样带给官方上游，不重复拼质量词', async () => {
  const calls = fakeNovelai(() => zipReply(PNG));
  const res = await naiRequest(CLIENT_BODY);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const files = readZip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(files.map((f) => f.name), ['image_0.png']);
  assert.deepEqual(files[0].data, PNG);

  const { input, model, parameters: p } = calls[0].request;
  assert.equal(model, 'nai-diffusion-4-5-full');
  assert.equal(input, CLIENT_BODY.input);
  assert.deepEqual([p.width, p.height, p.steps, p.scale, p.seed, p.cfg_rescale], [832, 1216, 23, 6, 12345, 0.2]);
  assert.equal(p.negative_prompt, 'lowres, bad anatomy');
  assert.equal(p.v4_prompt.caption.base_caption, CLIENT_BODY.input);
  assert.deepEqual(p.v4_prompt.caption.char_captions, CLIENT_BODY.parameters.v4_prompt.caption.char_captions);
  assert.equal(p.v4_prompt.use_coords, true);
  assert.deepEqual(p.characterPrompts, CLIENT_BODY.parameters.characterPrompts);
});

test('Accept: application/json 时按官方文档回 { images }；也认 multipart 请求体', async () => {
  fakeNovelai(() => zipReply(PNG));
  const res = await naiRequest(CLIENT_BODY, { Accept: 'application/json' });
  assert.deepEqual(await res.json(), { images: [{ image: PNG.toString('base64'), index: 0, seed: 12345 }] });

  const form = new FormData();
  form.append('request', new Blob([JSON.stringify(CLIENT_BODY)], { type: 'application/json' }), 'blob');
  const multipart = await realFetch(`${BASE}/ai/generate-image`, { method: 'POST', headers: { Authorization: `Bearer ${relayKey}` }, body: form });
  assert.equal(multipart.status, 200);
  assert.equal(multipart.headers.get('content-type'), 'application/zip');
});

test('官方格式的错误：{ statusCode, message }；只做文生图', async () => {
  const noKey = await realFetch(`${BASE}/ai/generate-image`, { method: 'POST', body: '{}' });
  assert.equal(noKey.status, 401);
  assert.equal((await noKey.json()).statusCode, 401);

  const img2img = await naiRequest({ ...CLIENT_BODY, action: 'img2img' });
  assert.equal(img2img.status, 400);
  assert.match((await img2img.json()).message, /只能文生图/);

  const vibe = await naiRequest({ ...CLIENT_BODY, parameters: { ...CLIENT_BODY.parameters, reference_image_multiple: ['abc'] } });
  assert.equal(vibe.status, 400);

  const missing = await naiRequest({ ...CLIENT_BODY, model: 'nai-diffusion-3' });
  assert.deepEqual([missing.status, (await missing.json()).message], [400, '模型 nai-diffusion-3 不存在或未启用']);
});

test('GET /user/subscription：按 Opus 回，Anlas 是调用密钥剩下的额度', async () => {
  const unlimited = await (await realFetch(`${BASE}/user/subscription`, { headers: { Authorization: `Bearer ${relayKey}` } })).json();
  assert.deepEqual([unlimited.tier, unlimited.active, unlimited.trainingStepsLeft.fixedTrainingStepsLeft], [3, true, 999999]);

  const limited = createKey({ name: '有额度', quota_images: 10 }).key;
  const body = await (await realFetch(`${BASE}/user/subscription`, { headers: { Authorization: `Bearer ${limited}` } })).json();
  assert.equal(body.trainingStepsLeft.fixedTrainingStepsLeft, 10);
});
