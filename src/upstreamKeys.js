import { db } from './db.js';
import { HttpError } from './http.js';
import { NOVELAI_BASE } from './novelai.js';
import { getSettings, saveSettings } from './settings.js';
import { beijingDay } from './usage.js';

// 上游 401/402/403 多半是这把秘钥失效、点数不足或不允许该模型，冷却久一点；429 是限流，很快能恢复
const COOLDOWN_MS = { 429: 60_000, default: 10 * 60_000 };
const cooldowns = new Map(); // 秘钥 id → 冷却到期时间，只在内存里，重启清零
// NovelAI 官方同一个账号同时只能生成一张，并发会被 429 拒绝：同一把官方秘钥的请求排队一个个发
const queues = new Map(); // 秘钥 id → 排在最后的那个请求
let cursor = 0;

export const UPSTREAM_TYPES = ['openai', 'novelai'];

export const keyHint = (key) => `${key.slice(0, 6)}…${key.slice(-4)}`;

/** 每日分档按上游账号计数；没填账号的秘钥自成一个账号 */
export const accountOf = (row) => row.account?.trim() || `#${row.id}`;

const supportedModels = (row) => (row.models ? row.models.split(',') : []);

/**
 * 这次请求依次尝试的秘钥：只取支持这个上游模型的（没限定模型的秘钥什么都接），
 * 从轮询游标开始转一圈，正在出图的官方秘钥往后排，冷却中的排到最后（其它秘钥都失败时仍会再试，避免全部冷却时直接不可用）。
 */
export function upstreamKeyOrder(model) {
  const keys = db.prepare('SELECT * FROM upstream_keys WHERE enabled = 1 ORDER BY id').all()
    .filter((k) => !model || !k.models || supportedModels(k).includes(model));
  if (!keys.length) return [];
  const start = cursor++ % keys.length;
  const rotated = [...keys.slice(start), ...keys.slice(0, start)];
  const now = Date.now();
  const cooling = (k) => (cooldowns.get(k.id) ?? 0) > now;
  const busy = (k) => queues.has(k.id);
  return [
    ...rotated.filter((k) => !cooling(k) && !busy(k)),
    ...rotated.filter((k) => !cooling(k) && busy(k)),
    ...rotated.filter(cooling),
  ];
}

/** 用这把秘钥调上游：官方秘钥排队，前一个请求结束（成功失败都算）才发下一个；别的类型直接调 */
export function withKey(row, fn) {
  if (row.type !== 'novelai') return fn();
  const run = (queues.get(row.id) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  queues.set(row.id, tail);
  tail.then(() => {
    if (queues.get(row.id) === tail) queues.delete(row.id);
  });
  return run;
}

/** 已启用秘钥的接口地址（按类型 + 地址去重），每个地址带一把秘钥，用来查模型列表 */
export function upstreamBases() {
  const bases = new Map();
  for (const row of db.prepare('SELECT base_url, key, type FROM upstream_keys WHERE enabled = 1 ORDER BY id').all()) {
    const id = `${row.type} ${row.base_url}`;
    if (row.base_url && !bases.has(id)) bases.set(id, { baseUrl: row.base_url, key: row.key, type: row.type });
  }
  return [...bases.values()];
}

/**
 * 拉取模型列表用哪个地址、哪把秘钥：已添加的秘钥按 id 取库里的；
 * 还没添加的（后台添加表单里）用填的类型、接口地址和第一把秘钥。
 */
export function upstreamTarget({ id, base_url: baseUrl, keys, type } = {}) {
  if (id) {
    const row = db.prepare('SELECT base_url, key, type FROM upstream_keys WHERE id = ?').get(Number(id));
    if (!row) throw new HttpError(404, '上游秘钥不存在');
    return { baseUrl: row.base_url, key: row.key, type: row.type };
  }
  const key = String(keys ?? '').split(/[\s,，]+/).find(Boolean);
  if (!key) throw new HttpError(400, '先填上游秘钥，拉取模型列表要用它');
  const kind = upstreamType(type);
  return { baseUrl: apiBase(baseUrl, kind), key, type: kind };
}

/** 所有秘钥的接口地址（含停用的）：错误信息里要把这些上游的域名都藏起来 */
export const allBaseUrls = () => db.prepare('SELECT DISTINCT base_url FROM upstream_keys').all().map((r) => r.base_url);

export function markKeyUsed(row) {
  cooldowns.delete(row.id);
  db.prepare('UPDATE upstream_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
}

/** cooldown = false：只记下错误不冷却，比如这个上游没有请求的模型，它接别的模型照样正常 */
export function markKeyFailed(row, status, message, cooldown = true) {
  const now = Date.now();
  if (cooldown) cooldowns.set(row.id, now + (COOLDOWN_MS[status] ?? COOLDOWN_MS.default));
  db.prepare('UPDATE upstream_keys SET last_error = ?, last_error_at = ? WHERE id = ?')
    .run(String(message).slice(0, 500), now, row.id);
}

/** 后台列表：不回传秘钥原文，附带用量统计和冷却状态 */
export function listUpstreamKeys() {
  const today = beijingDay();
  const now = Date.now();
  return db
    .prepare(`
      SELECT u.id, u.name, u.key, u.type, u.base_url, u.models, u.account, u.enabled, u.created_at, u.last_used_at,
             u.last_error, u.last_error_at,
             COUNT(l.id) AS calls,
             COALESCE(SUM(l.status = 'success'), 0) AS success,
             COALESCE(SUM(l.images), 0) AS images,
             COALESCE(SUM(l.points), 0) AS points,
             COALESCE(SUM(CASE WHEN l.day = ? THEN l.images END), 0) AS today_images,
             COALESCE(SUM(CASE WHEN l.day = ? THEN l.points END), 0) AS today_points
      FROM upstream_keys u LEFT JOIN logs l ON l.upstream_key_id = u.id
      GROUP BY u.id ORDER BY u.id`)
    .all(today, today)
    .map(({ key, ...row }) => {
      const coolingUntil = cooldowns.get(row.id) ?? 0;
      return { ...row, key_hint: keyHint(key), cooling_until: coolingUntil > now ? coolingUntil : null };
    });
}

/** keys 可以一次贴多把（换行或逗号分隔），都用同一个类型和接口地址；已存在的跳过 */
export function addUpstreamKeys({ keys, type, base_url: baseUrl, name = '', account = '', models = '' } = {}) {
  const list = String(keys ?? '').split(/[\s,，]+/).filter(Boolean);
  if (!list.length) throw new HttpError(400, '请填写上游秘钥');
  for (const key of list) {
    if (!/^[\x21-\x7e]{8,200}$/.test(key)) throw new HttpError(400, `秘钥格式不对：${keyHint(key)}`);
  }
  const kind = upstreamType(type);
  const base = apiBase(baseUrl, kind);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO upstream_keys (name, key, type, base_url, models, account, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  list.forEach((key, i) => {
    const label = list.length > 1 && name ? `${shortText(name, '名称')}-${i + 1}` : shortText(name, '名称');
    added += insert.run(label, key, kind, base, modelList(models), shortText(account, '所属账号'), Date.now()).changes;
  });
  return { added, skipped: list.length - added };
}

export function updateUpstreamKey(id, patch) {
  const row = db.prepare('SELECT type FROM upstream_keys WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '上游秘钥不存在');
  const kind = patch.type === undefined ? row.type : upstreamType(patch.type);
  const sets = [];
  const args = [];
  if (patch.type !== undefined) {
    sets.push('type = ?');
    args.push(kind);
  }
  for (const field of ['name', 'account']) {
    if (patch[field] === undefined) continue;
    sets.push(`${field} = ?`);
    args.push(shortText(patch[field], field === 'name' ? '名称' : '所属账号'));
  }
  if (patch.base_url !== undefined) {
    sets.push('base_url = ?');
    args.push(apiBase(patch.base_url, kind));
  }
  if (patch.models !== undefined) {
    sets.push('models = ?');
    args.push(modelList(patch.models));
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    args.push(patch.enabled ? 1 : 0);
  }
  if (!sets.length) throw new HttpError(400, '没有要修改的字段');
  db.prepare(`UPDATE upstream_keys SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  cooldowns.delete(id); // 改了配置、启用 / 停用都清掉冷却，下次请求立即参与轮询
  return { ok: true };
}

export function deleteUpstreamKey(id) {
  const { changes } = db.prepare('DELETE FROM upstream_keys WHERE id = ?').run(id);
  if (!changes) throw new HttpError(404, '上游秘钥不存在');
  cooldowns.delete(id);
  return { deleted: id };
}

/**
 * 启动时：旧版只有一个上游，秘钥没有接口地址，补成 UPSTREAM_BASE；
 * 首次启动把环境变量 UPSTREAM_KEY（配 UPSTREAM_BASE）导入秘钥表，只做一次。
 * pst- 开头的是 NovelAI 官方的持久令牌，按官方类型导入，UPSTREAM_BASE 可以不填。
 */
export function seedUpstreamKeys() {
  const { upstreamKeysSeeded, legacyUpstreamKey, upstreamBase } = getSettings();
  if (upstreamBase) db.prepare("UPDATE upstream_keys SET base_url = ? WHERE base_url = ''").run(upstreamBase);
  if (upstreamKeysSeeded || !legacyUpstreamKey) return;
  try {
    if (db.prepare('SELECT COUNT(*) AS c FROM upstream_keys').get().c === 0) {
      const type = /^pst-/.test(legacyUpstreamKey.trim()) ? 'novelai' : 'openai';
      addUpstreamKeys({ keys: legacyUpstreamKey, type, base_url: upstreamBase, name: '默认' });
    }
    saveSettings({ upstream_keys_seeded: '1' });
  } catch (err) {
    // 环境变量写错不该让服务起不来；不标记已导入，改好后下次启动再导
    console.warn(`导入环境变量 UPSTREAM_KEY 失败：${err.message}；请改正后重启，或在后台“上游秘钥”页手动添加`);
  }
}

function upstreamType(value) {
  const type = value === undefined || value === '' ? 'openai' : String(value);
  if (!UPSTREAM_TYPES.includes(type)) throw new HttpError(400, '上游类型只能是 openai（OpenAI 兼容）或 novelai（NovelAI 官方）');
  return type;
}

/**
 * 接口地址统一成基础地址，去掉末尾的斜杠。OpenAI 兼容的填到 /v1，顺手去掉误填的 /images/generations、/chat/completions；
 * NovelAI 官方的留空就是 https://image.novelai.net，误填的 /ai/generate-image 去掉。
 */
function apiBase(value, type = 'openai') {
  let url = String(value ?? '').trim().replace(/\/+$/, '');
  if (type === 'novelai') url = url.replace(/\/ai\/generate-image(?:-stream)?$/, '') || NOVELAI_BASE;
  else url = url.replace(/\/(images\/generations|chat\/completions)$/, '');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // 下面统一报错
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    throw new HttpError(400, '接口地址必须是 http(s) 开头的网址，填到 /v1 为止，比如 https://example.com/v1');
  }
  return url;
}

function modelList(value) {
  const list = [...new Set(String(value ?? '').split(/[\s,，]+/).map((m) => m.trim()).filter(Boolean))];
  if (list.some((m) => m.length > 100)) throw new HttpError(400, '模型名称太长');
  return list.join(',');
}

function shortText(value, label) {
  const text = String(value ?? '').trim();
  if (text.length > 50) throw new HttpError(400, `${label}不超过 50 个字`);
  return text;
}
