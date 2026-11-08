import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, test } from 'node:test';

process.env.DATA_DIR = ':memory:';
const { db } = await import('../src/db.js');
const { anlasCost } = await import('../src/anlas.js');
const { executeGeneration, prepareGeneration } = await import('../src/generate.js');
const { createKey } = await import('../src/keys.js');
const { applyLimits, fitArea, limitValue } = await import('../src/limits.js');
const { addModels, seedModels } = await import('../src/models.js');
const { handleNaiGenerate } = await import('../src/naiApi.js');
const { refreshAccount } = await import('../src/naiAccounts.js');
const { novelaiAccount, novelaiShape } = await import('../src/novelai.js');
const { queueSnapshot } = await import('../src/queue.js');
const { generateImages } = await import('../src/upstream.js');
const { saveSettings } = await import('../src/settings.js');
const { addUpstreamKeys, getUpstreamKey, listUpstreamKeys, markKeyFailed, saveAccount, updateUpstreamKey } = await import('../src/upstreamKeys.js');
const { writeZip } = await import('../src/zip.js');

seedModels();
addModels([{ id: 'nai-diffusion-4-5-full' }, { id: 'nai-diffusion-5-full-medium' }, { id: 'nai-diffusion-3' }]);

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png')]);
const OPUS = { level: 3, tier: 'Opus', active: true, anlas: 5000, usage_negative: false, usage_percent: 40 };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const zipReply = () => new Response(writeZip([{ name: 'image_0.png', data: PNG }]), { headers: { 'Content-Type': 'application/zip' } });
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假上游：官方的回 ZIP，OpenAI 兼容的回 b64_json；记下每次发出去的请求体和令牌 */
function fakeUpstream({ gate } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    const body = init.body instanceof FormData ? JSON.parse(await init.body.get('request').text()) : JSON.parse(init.body);
    calls.push({ url: String(url), token: init.headers.Authorization.replace('Bearer ', ''), body });
    if (gate) await gate();
    return /generate-image/.test(url) ? zipReply() : Response.json({ created: 1, data: [{ b64_json: PNG.toString('base64') }] });
  };
  return calls;
}

/** 只留下这几把上游秘钥启用 */
function only(...names) {
  for (const k of listUpstreamKeys()) updateUpstreamKey(k.id, { enabled: names.includes(k.name) });
}
const idOf = (name) => listUpstreamKeys().find((k) => k.name === name).id;

test('等比缩小到面积上限，宽高取 64 的倍数；上限可以写成 1024x1024', () => {
  assert.deepEqual(fitArea(1536, 1024, 1048576), [1216, 832]);
  assert.deepEqual(fitArea(1024, 1536, 1048576), [832, 1216]);
  assert.deepEqual(fitArea(4096, 4096, 1048576), [1024, 1024]);
  assert.deepEqual(fitArea(832, 1216, 1048576), [832, 1216]); // 没超不动
  assert.deepEqual(fitArea(1536, 1024, 0), [1536, 1024]); // 0 = 不限
  for (const [w, h] of [[1088, 1024], [1600, 900], [640, 1536], [2048, 1152]]) {
    const [fw, fh] = fitArea(w, h, 1048576);
    assert.ok(fw * fh <= 1048576 && fw % 64 === 0 && fh % 64 === 0, `${w}x${h} → ${fw}x${fh}`);
  }
  const { shape, changes } = applyLimits({ width: 1536, height: 1024, steps: 40, n: 4 }, { max_pixels: 1048576, max_steps: 28, max_n: 1 });
  assert.deepEqual(shape, { width: 1216, height: 832, steps: 28, n: 1 });
  assert.deepEqual(changes, ['尺寸 1536x1024 → 1216x832', '步数 40 → 28', '张数 4 → 1']);
  assert.equal(limitValue('max_pixels', '1024x1024'), 1048576);
  assert.equal(limitValue('max_pixels', '1024×1536'), 1572864);
  assert.equal(limitValue('max_steps', ''), 0);
  assert.throws(() => limitValue('max_steps', 51));
  assert.throws(() => limitValue('max_n', 5));
  assert.throws(() => limitValue('max_pixels', '10x10'));
});

test('Anlas 计价和官网网页端一致；NAI5 用量条用完、非 Opus、多张时说明原因', () => {
  const price = (model, w, h, steps, extra = {}, account = null) => anlasCost(model, { width: w, height: h, steps, n: 1, ...extra }, account).total;
  assert.equal(price('nai-diffusion-4-5-full', 832, 1216, 28), 20);
  assert.equal(price('nai-diffusion-5-full', 832, 1216, 23), 26);
  assert.equal(price('nai-diffusion-5-full-medium', 832, 1216, 14), 15);
  assert.equal(price('nai-diffusion-5-full', 1472, 1472, 28), 63);
  assert.equal(price('nai-diffusion-3', 832, 1216, 28, { sm: true, sm_dyn: true }), 28);
  assert.equal(price('nai-diffusion-5-full', 832, 1216, 28, {}, OPUS), 0);
  const empty = anlasCost('nai-diffusion-5-full', { width: 832, height: 1216, steps: 28 }, { ...OPUS, usage_negative: true });
  assert.deepEqual([empty.total, empty.barOnly], [30, true]);
  assert.equal(price('nai-diffusion-4-5-full', 832, 1216, 28, {}, { ...OPUS, usage_negative: true }), 0); // 用量条只管 NAI5
  const scroll = anlasCost('nai-diffusion-4-5-full', { width: 832, height: 1216, steps: 28 }, { ...OPUS, level: 2, tier: 'Scroll' });
  assert.deepEqual([scroll.total, scroll.barOnly], [20, false]);
  assert.match(scroll.why, /不是有效的 Opus/);
  assert.equal(anlasCost('nai-diffusion-5-full', { width: 832, height: 1216, steps: 23, n: 4 }, OPUS).total, 78);
  assert.equal(anlasCost('nai-diffusion-4-5-full', { width: 2048, height: 2048, steps: 50 }, OPUS).refused, false);
  assert.equal(anlasCost('nai-diffusion-5-full', { width: 2048, height: 2048, steps: 50 }, OPUS).refused, true); // 单张超过 140
});

test('开关参数严格认：字符串 "false" 不会打开 SMEA；nai_smea 采样器换成 SMEA；NAI4 以后没有 SMEA', () => {
  const shape = (model, extra) => novelaiShape({ model, prompt: 'x', ...extra });
  assert.equal(shape('nai-diffusion-3', { nai: { sm: 'false', sm_dyn: 'false' } }).sm, false);
  assert.equal(shape('nai-diffusion-3', { nai: { sm: 'true' } }).sm, true);
  assert.deepEqual(
    (({ sampler, sm, sm_dyn }) => ({ sampler, sm, sm_dyn }))(shape('nai-diffusion-3', { sampler: 'nai_smea_dyn' })),
    { sampler: 'k_euler_ancestral', sm: true, sm_dyn: true },
  );
  assert.equal(shape('nai-diffusion-4-5-full', { nai: { sm: true } }).sm, false);
  assert.equal(shape('nai-diffusion-3', { sampler: 'ddim', nai: { sm: true } }).sm, false);
});

test('账号状态：套餐、Anlas、Opus 用量条', () => {
  const account = novelaiAccount({
    tier: 3, active: true, expiresAt: 1800000000,
    trainingStepsLeft: { fixedTrainingStepsLeft: 9000, purchasedTrainingSteps: 1500 },
    usage: { percent: 0, purchasedPercent: 0, isNegative: true, timeUntilNextPercent: 600 },
  });
  assert.deepEqual(
    [account.level, account.tier, account.anlas, account.usage_negative, account.usage_percent],
    [3, 'Opus', 10500, true, 0],
  );
  assert.equal(novelaiAccount({ tier: 1, active: true }).usage_percent, null);
});

test('官方秘钥默认按 Opus 免费档压：大图、多步数、多张都压下来；medium 固定 14 步不压', async () => {
  addUpstreamKeys({ keys: 'pst-limits0001', type: 'novelai', name: '官方' });
  saveAccount(idOf('官方'), OPUS);
  only('官方');
  const calls = fakeUpstream();
  const { applied } = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat', size: '1536x1024', steps: 40, n: 4 });
  const p = calls[0].body.parameters;
  assert.deepEqual([p.width, p.height, p.steps, p.n_samples], [1216, 832, 28, 1]);
  assert.deepEqual(applied.changes, ['尺寸 1536x1024 → 1216x832', '步数 40 → 28', '张数 4 → 1']);
  assert.deepEqual([applied.size, applied.n, applied.anlas], ['1216x832', 1, 0]);

  // 四舍五入到 64 后会超过 1MP 的尺寸（1056x992 → 1088x1024）也压回来
  await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat', size: '1056x992' });
  assert.ok(calls[1].body.parameters.width * calls[1].body.parameters.height <= 1048576);

  updateUpstreamKey(idOf('官方'), { max_steps: 10 });
  await generateImages({ model: 'nai-diffusion-5-full-medium', prompt: 'cat' });
  assert.equal(calls[2].body.parameters.steps, 14);
  updateUpstreamKey(idOf('官方'), { max_steps: 28 });
});

test('OpenAI 兼容的秘钥也能设上限：只压请求里写了的，没写尺寸按 1024x1024 算', async () => {
  addUpstreamKeys({ keys: 'sk-limits00002', base_url: 'https://up.example.com/v1', name: '兼容', max_pixels: '1024x1024', max_n: 2 });
  only('兼容');
  const calls = fakeUpstream();
  const big = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat', size: '2048x2048', steps: 50, n: 4 });
  assert.deepEqual([calls[0].body.size, calls[0].body.steps, calls[0].body.n], ['1024x1024', 50, 2]);
  assert.deepEqual(big.applied.changes, ['尺寸 2048x2048 → 1024x1024', '张数 4 → 2']);
  assert.equal(big.applied.anlas, undefined);

  await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat' });
  assert.equal(calls[1].body.size, undefined); // 没写尺寸也没超，不替上游填
  assert.equal(calls[1].body.steps, undefined);
});

test('优先级：数字大的先用；它忙或在冷却的时候用低的', async () => {
  addUpstreamKeys({ keys: 'pst-priohigh01', type: 'novelai', name: '高', priority: 10, free_only: false });
  addUpstreamKeys({ keys: 'pst-priolow001', type: 'novelai', name: '低', priority: 0, free_only: false });
  only('高', '低');
  let release;
  const gate = () => new Promise((resolve) => { release = resolve; });
  const calls = fakeUpstream({ gate });

  const first = generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'a' });
  await tick();
  assert.equal(calls[0].token, 'pst-priohigh01');
  const releaseFirst = release;
  const second = generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'b' });
  await tick();
  assert.equal(calls[1].token, 'pst-priolow001'); // 高的在忙（并发 1），用低的
  assert.deepEqual(queueSnapshot().keys.filter((k) => ['高', '低'].includes(k.name)).map((k) => [k.name, k.priority]), [['高', 10], ['低', 0]]);
  releaseFirst();
  release();
  await Promise.all([first, second]);

  // 都空着时一直用高的，不轮到低的
  globalThis.fetch = realFetch;
  const later = fakeUpstream();
  for (let i = 0; i < 3; i++) await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'c' });
  assert.deepEqual(later.map((c) => c.token), ['pst-priohigh01', 'pst-priohigh01', 'pst-priohigh01']);

  // 高的在冷却（刚被上游拒过）：先用低的
  markKeyFailed(getUpstreamKey(idOf('高')), 402, 'Insufficient Anlas');
  await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'd' });
  assert.equal(later.at(-1).token, 'pst-priolow001');
  only('高', '低'); // 重新启用清掉冷却
});

test('只出免费图：NAI5 免费额度用完时 NAI5 请求不发（换别的秘钥或报错），NAI4.5 照常；非 Opus、状态未知都不接', async () => {
  only('官方');
  const calls = fakeUpstream();
  saveAccount(idOf('官方'), { ...OPUS, usage_negative: true, usage_percent: 0 });
  const err = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' }).catch((e) => e);
  assert.deepEqual([err.status, err.code], [503, 'free_quota_exhausted']);
  assert.match(err.message, /NAI5 的免费额度暂时用完了/);
  assert.match(err.internal, /官方：NAI5 的免费额度（Opus 用量条）用完了，要 30 Anlas/);
  assert.equal(calls.length, 0);
  const ok = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat' });
  assert.deepEqual([calls.length, ok.applied.anlas], [1, 0]);

  // 同一个模型还有一把愿意花 Anlas 的：NAI5 请求换给它，并记下估算的 Anlas
  only('官方', '低');
  const spent = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' });
  assert.equal(spent.upstreamKey.name, '低');
  assert.equal(spent.applied.anlas, null); // 低的账号从没查到过：不估
  saveAccount(idOf('低'), { ...OPUS, level: 1, tier: 'Tablet' });
  const tabletSpent = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat' });
  assert.equal(tabletSpent.applied.anlas, 30); // 非 Opus：1024x1024、28 步的 NAI5

  only('官方');
  saveAccount(idOf('官方'), { ...OPUS, level: 1, tier: 'Tablet' });
  const tablet = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat' }).catch((e) => e);
  assert.deepEqual([tablet.code, tablet.message], ['free_quota_exhausted', '免费出图额度暂时用不了，请稍后再试']);

  // 太久没查成功（30 分钟）就当不知道
  db.prepare('UPDATE upstream_keys SET nai_account = ? WHERE id = ?')
    .run(JSON.stringify({ ...OPUS, checked_at: Date.now() - 31 * 60_000 }), idOf('官方'));
  const stale = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat' }).catch((e) => e);
  assert.match(stale.internal, /账号状态未知/);
  saveAccount(idOf('官方'), OPUS);
});

test('去掉上限后单张超过 140 Anlas：官网也不让发，返回 400', async () => {
  updateUpstreamKey(idOf('官方'), { max_pixels: 0, max_steps: 0, max_n: 0, free_only: false });
  only('官方');
  const calls = fakeUpstream();
  const err = await generateImages({ model: 'nai-diffusion-5-full', prompt: 'cat', size: '2048x2048', steps: 50 }).catch((e) => e);
  assert.deepEqual([err.status, err.code, calls.length], [400, 'too_expensive', 0]);
  const fine = await generateImages({ model: 'nai-diffusion-4-5-full', prompt: 'cat', size: '1024x1536', steps: 28 });
  assert.equal(fine.applied.anlas, 30); // Opus 但超过 1MP：照收
  updateUpstreamKey(idOf('官方'), { max_pixels: '1024x1024', max_steps: 28, max_n: 1, free_only: true });
});

test('调用日志记实际发出的尺寸、张数、改了什么和估算的 Anlas；免费额度用完提前报错、不调 AI', async () => {
  only('官方');
  fakeUpstream();
  const key = createKey({ name: '日志' });
  const ctx = { key, baseUrl: 'http://relay', ip: '' };
  const job = prepareGeneration(ctx, 'images', { model: 'nai-diffusion-4-5-full', size: '1536x1024', n: 3 }, 'cat', {});
  const result = await executeGeneration(job);
  assert.deepEqual(result.adjusted, ['尺寸 1536x1024 → 1216x832', '张数 3 → 1']);
  const log = db.prepare('SELECT size, n, images, adjusted, anlas FROM logs ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual({ ...log }, { size: '1216x832', n: 1, images: 1, adjusted: '尺寸 1536x1024 → 1216x832，张数 3 → 1', anlas: 0 });

  // 配好 AI 优化：要是先调了 AI，假接口会被请求到；免费额度用完应该在那之前就报错
  saveSettings({ ai_mode: 'always', ai_base_url: 'https://ai.example.com/v1', ai_api_key: 'sk-ai-test', ai_model: 'test-model' });
  let aiRequests = 0;
  globalThis.fetch = async (url) => {
    if (/chat\/completions/.test(url)) aiRequests++;
    return Response.json({ choices: [{ message: { content: '1girl' } }] });
  };
  saveAccount(idOf('官方'), { ...OPUS, usage_negative: true });
  const v5 = prepareGeneration(ctx, 'images', { model: 'nai-diffusion-5-full' }, '一只猫', {});
  assert.equal(v5.useAi, true);
  const err = await executeGeneration(v5).catch((e) => e);
  assert.equal(err.code, 'free_quota_exhausted');
  assert.equal(aiRequests, 0);
  assert.equal(db.prepare('SELECT status FROM logs ORDER BY id DESC LIMIT 1').get().status, 'error');
  saveSettings({ ai_mode: 'off' });
  saveAccount(idOf('官方'), OPUS);
});

test('额度：排队中的请求也算进去，不会一起越过额度', async () => {
  only('官方');
  let release;
  fakeUpstream({ gate: () => new Promise((resolve) => { release = resolve; }) });
  const key = createKey({ name: '额度', quota_images: 1 });
  const ctx = { key, baseUrl: 'http://relay', ip: '' };
  const first = executeGeneration(prepareGeneration(ctx, 'images', { model: 'nai-diffusion-4-5-full' }, 'cat', {}));
  await tick();
  const second = await executeGeneration(prepareGeneration(ctx, 'images', { model: 'nai-diffusion-4-5-full' }, 'dog', {})).catch((e) => e);
  assert.deepEqual([second.status, second.code], [429, 'insufficient_quota']);
  release();
  await first;
});

test('查账号：成功的存下来；失败保留上次的状态，只记错误', async () => {
  const id = idOf('官方');
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://image.novelai.net/user/subscription');
    return Response.json({ tier: 3, active: true, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 }, usage: { percent: 55, isNegative: false } });
  };
  const ok = await refreshAccount(getUpstreamKey(id));
  assert.deepEqual([ok.level, ok.anlas, ok.usage_percent, ok.error], [3, 100, 55, null]);
  globalThis.fetch = async () => Response.json({ statusCode: 401, message: 'Unauthorized' }, { status: 401 });
  const failed = await refreshAccount(getUpstreamKey(id));
  assert.deepEqual([failed.anlas, failed.error], [100, 'HTTP 401：Unauthorized']);
  assert.equal(listUpstreamKeys().find((k) => k.id === id).nai_account.anlas, 100);
});

// ---------- NovelAI 格式出口：返回实际发出去的种子 ----------

const server = http.createServer((req, res) => handleNaiGenerate(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());

test('NovelAI 格式返回 JSON 时，种子是实际发给上游的（行内写了不合法的种子会换成随机的）', async () => {
  only('官方');
  saveAccount(idOf('官方'), OPUS);
  const calls = fakeUpstream();
  const relayKey = createKey({ name: '种子' }).key;
  const res = await realFetch(`http://127.0.0.1:${server.address().port}/ai/generate-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${relayKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ input: '1girl --seed -5', model: 'nai-diffusion-4-5-full', action: 'generate', parameters: { width: 832, height: 1216 } }),
  });
  const { images } = await res.json();
  assert.equal(images[0].seed, calls[0].body.parameters.seed);
  assert.ok(images[0].seed >= 0);
});
