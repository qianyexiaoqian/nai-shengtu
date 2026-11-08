import { db } from './db.js';
import { HttpError, sendJson } from './http.js';
import { getSettings } from './settings.js';
import { fetchModelIds, fetchNovelaiAccount, listModels as listUpstreamModels } from './upstream.js';
import { upstreamTarget } from './upstreamKeys.js';

// 有的 NAI 上游会列出 director，它是图像处理功能，不能文生图
const notImageModel = (id) => id === 'director';

const PRICE_FIELDS = ['price', 'tier_after', 'tier_price', 'large_extra'];

/**
 * 各家上游的价格不一样（NovelAI 官方按 Anlas 计，Opus 订阅普通尺寸免费），新加的模型计价先全填 0（不估算），
 * 管理员在后台“模型”页按实际用的上游填。
 */
export function defaultPricing() {
  return { price: 0, tier_after: 0, tier_price: 0, large_extra: 0 };
}

export function listModelRows() {
  return db.prepare('SELECT * FROM models ORDER BY created_at, id').all();
}

/** 批量添加，已存在的跳过 */
export function addModels(items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'models 不能为空');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (id, upstream, enabled, price, tier_after, tier_price, large_extra, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const added = [];
  const skipped = [];
  for (const item of items) {
    const id = modelId(item?.id);
    const upstream = item.upstream ? modelId(item.upstream, 'upstream') : id;
    const pricing = { ...defaultPricing(upstream), ...pickPricing(item) };
    const { changes } = insert.run(
      id, upstream, item.enabled === false ? 0 : 1,
      pricing.price, pricing.tier_after, pricing.tier_price, pricing.large_extra, Date.now(),
    );
    (changes ? added : skipped).push(id);
  }
  return { added, skipped };
}

export function updateModel(id, patch) {
  const sets = [];
  const args = [];
  if (patch.upstream !== undefined) {
    sets.push('upstream = ?');
    args.push(modelId(patch.upstream, 'upstream'));
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    args.push(patch.enabled ? 1 : 0);
  }
  for (const [field, value] of Object.entries(pickPricing(patch))) {
    sets.push(`${field} = ?`);
    args.push(value);
  }
  if (!sets.length) throw new HttpError(400, '没有要修改的字段');
  const { changes } = db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  if (!changes) throw new HttpError(404, `模型 ${id} 不存在`);
  return db.prepare('SELECT * FROM models WHERE id = ?').get(id);
}

export function deleteModel(id) {
  const { changes } = db.prepare('DELETE FROM models WHERE id = ?').run(id);
  if (!changes) throw new HttpError(404, `模型 ${id} 不存在`);
  return { deleted: id };
}

/**
 * 后台“从上游获取”：各个上游接口地址的模型列表合在一起，标出每个模型来自哪些地址、是否已经添加过。
 * 部分地址查不到时照样返回查到的，查不到的放在 errors 里。
 */
export async function upstreamModelOptions() {
  const results = await listUpstreamModels();
  if (!results.length) throw new HttpError(400, '还没有启用的上游秘钥，先在“上游秘钥”页添加');
  const errors = results.filter((r) => r.error).map(({ baseUrl, error }) => ({ base_url: baseUrl, error }));
  if (errors.length === results.length) {
    const detail = errors.map((e) => `${e.base_url}：${e.error}`).join('；');
    throw new HttpError(502, `获取上游模型列表失败（${detail}）`, { type: 'server_error' });
  }
  const added = new Set(listModelRows().map((m) => m.upstream));
  const bases = new Map(); // 模型 → 有这个模型的接口地址
  for (const { baseUrl, models = [] } of results) {
    for (const id of models.filter((m) => !notImageModel(m))) bases.set(id, [...(bases.get(id) ?? []), baseUrl]);
  }
  return {
    models: [...bases].map(([id, from]) => ({ id, bases: from, added: added.has(id), pricing: defaultPricing(id) })),
    errors,
  };
}

/**
 * 后台“上游秘钥”页的“拉取模型”：查一个上游接口地址的模型列表，用来勾选这把秘钥支持哪些模型。
 * target 是 { id }（已添加的秘钥）或 { type, base_url, keys }（添加表单里填的）。
 * NovelAI 官方没有模型列表接口，给内置的官方模型，同时查一下令牌对应账号的套餐和 Anlas（顺便验证令牌）。
 */
export async function pullUpstreamModels(target) {
  const { baseUrl, key, type } = upstreamTarget(target);
  let ids;
  let account = null;
  try {
    ids = await fetchModelIds(baseUrl, key, type);
    if (type === 'novelai') account = await fetchNovelaiAccount(baseUrl, key);
  } catch (err) {
    const what = type === 'novelai' ? '验证 NovelAI 令牌' : '拉取模型列表';
    throw new HttpError(502, `${what}失败：${err.cause?.message || err.message}`, { type: 'server_error' });
  }
  return { base_url: baseUrl, type, models: ids.filter((id) => !notImageModel(id)), account };
}

/**
 * 请求里的模型名 → 已启用的模型。没写、或写的是 dall-e-3 / gpt-image-1 / gemini-*-image 之类
 * 别家的名字时用默认模型；写了 nai-* 但没添加或没启用的直接报错，免得拼错名字却悄悄换了模型。
 */
export function resolveModel(name) {
  const requested = typeof name === 'string' ? name.trim() : '';
  const findEnabled = (id) => db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(id);
  const notFound = () =>
    new HttpError(400, `模型 ${requested || '(未指定)'} 不存在或未启用`, { param: 'model', code: 'model_not_found' });

  if (requested) {
    const hit = findEnabled(requested);
    if (hit) return hit;
    if (/^nai-/i.test(requested)) throw notFound();
  }
  const fallback = findEnabled(getSettings().defaultModel);
  if (!fallback) throw notFound();
  return fallback;
}

/** 首次启动时放入 NAI5 两个模型，开箱即用 */
export function seedModels() {
  if (db.prepare('SELECT COUNT(*) AS c FROM models').get().c === 0) {
    addModels([{ id: 'nai-diffusion-5-full' }, { id: 'nai-diffusion-5-curated' }]);
  }
}

/** GET /v1/models —— 已启用的模型；只给对外名称，看不出上游 */
export function handleModels(res) {
  const data = db
    .prepare('SELECT id, created_at FROM models WHERE enabled = 1 ORDER BY created_at, id')
    .all()
    .map((m) => ({ id: m.id, object: 'model', created: Math.floor(m.created_at / 1000), owned_by: 'novelai' }));
  sendJson(res, 200, { object: 'list', data });
}

function modelId(value, field = 'id') {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[\w.:/-]{1,100}$/.test(id)) {
    throw new HttpError(400, `${field === 'id' ? '模型名称' : '上游模型'}只能包含字母、数字和 _ . : / -，且不能为空`);
  }
  return id;
}

function pickPricing(source) {
  const out = {};
  for (const field of PRICE_FIELDS) {
    if (source?.[field] === undefined || source[field] === '') continue;
    const value = Number(source[field]);
    if (!Number.isFinite(value) || value < 0) throw new HttpError(400, `${field} 必须是不小于 0 的数字`);
    out[field] = field === 'tier_after' ? Math.trunc(value) : value;
  }
  return out;
}
