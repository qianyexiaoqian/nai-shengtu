import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATA_DIR = ':memory:';
const { assertQuota, authenticate, createKey, updateKey } = await import('../src/keys.js');
const { addModels, resolveModel, seedModels, updateModel } = await import('../src/models.js');
const { beijingDay, estimatePoints, getStats, modelFamily, recordCall } = await import('../src/usage.js');

const reqWith = (key) => ({ headers: { authorization: `Bearer ${key}` } });

seedModels();

test('生成的 sk 能通过鉴权，禁用后失效，库里不存明文', async () => {
  const { key, id, key_hint: hint } = createKey({ name: '测试' });
  assert.match(key, /^sk-[\w-]{32}$/);
  assert.ok(hint.startsWith(key.slice(0, 7)) && hint.endsWith(key.slice(-4)));
  assert.equal(authenticate(reqWith(key)).id, id);

  updateKey(id, { enabled: false });
  assert.throws(() => authenticate(reqWith(key)), { status: 401, message: 'API Key 已被禁用' });
  assert.throws(() => authenticate(reqWith('sk-nope')), { status: 401 });
  assert.throws(() => authenticate({ headers: {} }), { status: 401 });

  const { db } = await import('../src/db.js');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE key_hash = ?').get(key).c, 0);
});

test('额度检查', () => {
  assertQuota({ quota_images: 0, used_images: 999 }, 4); // 0 = 不限
  assertQuota({ quota_images: 10, used_images: 8 }, 2);
  assert.throws(() => assertQuota({ quota_images: 10, used_images: 9 }, 2), { status: 429 });
});

test('模型解析：已启用的直接用，别家模型名走默认，nai-* 没添加的报错', () => {
  addModels([{ id: 'anime', upstream: 'nai-diffusion-4-5-full' }]);
  assert.equal(resolveModel('anime').upstream, 'nai-diffusion-4-5-full');
  assert.equal(resolveModel('dall-e-3').id, 'nai-diffusion-5-full');
  assert.equal(resolveModel(undefined).id, 'nai-diffusion-5-full');
  assert.throws(() => resolveModel('nai-diffusion-3'), { status: 400 });

  updateModel('anime', { enabled: false });
  assert.equal(resolveModel('anime').id, 'nai-diffusion-5-full'); // 停用后按别家名字处理
});

test('计价：新模型默认不估算；按规则估算每日分档和大图加价', () => {
  assert.deepEqual(resolveModel('nai-diffusion-5-curated').price, 0);
  // 例子：每天前 300 张 5 点，之后 10 点，大图 +5；同代的两个模型都设上
  for (const id of ['nai-diffusion-5-full', 'nai-diffusion-5-curated']) {
    updateModel(id, { price: 5, tier_after: 300, tier_price: 10, large_extra: 5 });
  }
  const nai5 = resolveModel('nai-diffusion-5-full');
  assert.deepEqual([nai5.price, nai5.tier_after, nai5.tier_price, nai5.large_extra], [5, 300, 10, 5]);
  assert.equal(estimatePoints(nai5, 1, '832x1216', 0), 5);
  assert.equal(estimatePoints(nai5, 1, '1024x1536', 0), 10);
  assert.equal(estimatePoints(nai5, 2, '1024x1024', 299), 15); // 第 300 张 5 点，第 301 张 10 点
  assert.equal(estimatePoints(nai5, 1, '1024x1536', 400), 15);
  assert.equal(modelFamily('nai-diffusion-5-curated'), modelFamily('nai-diffusion-5-full'));
  assert.notEqual(modelFamily('nai-diffusion-4-5-full'), modelFamily('nai-diffusion-4-full'));
});

test('记账：同一上游账号的同代模型合并计每日张数，累加到密钥，失败不扣点', () => {
  const key = createKey({ name: '记账' });
  const full = resolveModel('nai-diffusion-5-full');
  const curated = resolveModel('nai-diffusion-5-curated');
  const call = { key, endpoint: 'images', prompt: 'cat', size: '1024x1024', n: 1, durationMs: 1, ip: '', account: '主账号' };

  // 先把今天“主账号”的 NAI5 计数推到 299 张
  recordCall({ ...call, model: full, n: 4, images: 299, status: 'success' });
  const { points } = recordCall({ ...call, model: curated, n: 2, images: 2, status: 'success' });
  assert.equal(points, 15);
  assert.equal(recordCall({ ...call, model: full, status: 'error', error: 'x' }).points, 0);
  // 另一个上游账号有自己的 300 张
  assert.equal(recordCall({ ...call, account: '副账号', model: full, images: 1, status: 'success' }).points, 5);

  const row = getStats().byKey.find((k) => k.key_id === key.id);
  assert.equal(row.calls, 4);
  assert.equal(row.success, 3);
  assert.equal(row.images, 302);
  assert.equal(row.today_images, 302);
  assert.equal(row.points, 299 * 5 + 15 + 5);
  assert.equal(getStats().daily[0].day, beijingDay());
});
