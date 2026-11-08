import { db } from './db.js';
import { HttpError } from './http.js';
import { LIMIT_FIELDS, NO_LIMITS, OPUS_FREE, limitValue } from './limits.js';
import { NOVELAI_BASE } from './novelai.js';
import { getSettings, saveSettings } from './settings.js';
import { beijingDay } from './usage.js';

// 上游 401/402/403 多半是这把秘钥失效、点数不足或不允许该模型，冷却久一点；429 是限流，很快能恢复
const COOLDOWN_MS = { 429: 60_000, default: 10 * 60_000 };
const cooldowns = new Map(); // 秘钥 id → 冷却到期时间，只在内存里，重启清零
let cursor = 0;

export const UPSTREAM_TYPES = ['openai', 'novelai'];
// 每把秘钥同时最多几个请求，0 = 不限。NovelAI 官方同一个账号同时只能生成一张（并发会被 429 拒绝），默认 1
const DEFAULT_CONCURRENCY = { openai: 0, novelai: 1 };
const MAX_CONCURRENCY = 100;
// 出图上限的默认值（见 limits.js）：官方秘钥默认 Opus 免费档，不花 Anlas；OpenAI 兼容的不限
const DEFAULT_LIMITS = { openai: NO_LIMITS, novelai: OPUS_FREE };
const MAX_PRIORITY = 1000;
// 官方秘钥的账号状态超过这么久没查成功，就当不知道（“只出免费图”的秘钥这时不接请求，免得用量条用完了还在花 Anlas）
const ACCOUNT_STALE_MS = 30 * 60_000;

export const keyHint = (key) => `${key.slice(0, 6)}…${key.slice(-4)}`;

/** 后台看的账号状态：加上现在算不算数（live）、是不是有效的 Opus（opus） */
function accountView(row, now) {
  const account = savedAccount(row);
  return account && { ...account, live: Boolean(liveAccount(row, now)), opus: account.level >= 3 && Boolean(account.active) };
}

/** 每日分档按上游账号计数；没填账号的秘钥自成一个账号 */
export const accountOf = (row) => row.account?.trim() || `#${row.id}`;

const supportedModels = (row) => (row.models ? row.models.split(',') : []);

export const isCooling = (id, now = Date.now()) => (cooldowns.get(id) ?? 0) > now;

/** 官方秘钥最近一次查到的账号状态（见 naiAccounts.js）；没查过是 null */
export function savedAccount(row) {
  try {
    return row.nai_account ? JSON.parse(row.nai_account) : null;
  } catch {
    return null;
  }
}

/**
 * 拿来算这次要不要花 Anlas 的账号状态：查成功过、没过期、而且最近一次查询没有失败才算数
 * （查失败了就不知道用量条现在怎样，宁可不出图）
 */
export function liveAccount(row, now = Date.now()) {
  const account = savedAccount(row);
  if (!account?.checked_at || now - account.checked_at >= ACCOUNT_STALE_MS) return null;
  return account.error_at && account.error_at >= account.checked_at ? null : account;
}

/**
 * 记下查到的账号状态；失败时保留上次查到的，只记错误。startedAt 是这次查询发出去的时间：
 * 比已经存下的那次更早发出的结果（慢的响应后到）不覆盖，免得旧的用量条把新的盖掉。
 */
export function saveAccount(id, account, error = null, startedAt = Date.now()) {
  const row = db.prepare('SELECT nai_account FROM upstream_keys WHERE id = ?').get(id);
  if (!row) return null;
  const saved = savedAccount(row);
  if (saved?.attempt_at > startedAt) return saved;
  const now = Date.now();
  const next = error
    ? { ...saved, error: String(error).slice(0, 200), error_at: now, attempt_at: startedAt }
    : { ...account, checked_at: now, started_at: startedAt, attempt_at: startedAt, error: null, error_at: null };
  db.prepare('UPDATE upstream_keys SET nai_account = ? WHERE id = ?').run(JSON.stringify(next), id);
  return next;
}

/** 能接这个上游模型的已启用秘钥（没限定模型的秘钥什么都接），按 id 排 */
export function candidateKeys(model) {
  return db.prepare('SELECT * FROM upstream_keys WHERE enabled = 1 ORDER BY id').all()
    .filter((k) => !model || !k.models || supportedModels(k).includes(model));
}

/** 轮询起点：每个请求从下一把开始 */
export const nextRotation = () => cursor++;

/** 从 start 开始转一圈 */
export function rotate(keys, start) {
  if (!keys.length) return keys;
  const i = start % keys.length;
  return [...keys.slice(i), ...keys.slice(0, i)];
}

/**
 * 这次请求依次尝试的秘钥：从轮询游标开始转一圈，冷却中的排到最后
 * （其它秘钥都失败时仍会再试，避免全部冷却时直接不可用）。实际取秘钥时还要看并发，见 queue.js。
 */
export function upstreamKeyOrder(model) {
  const start = nextRotation();
  const rotated = byPriority(candidateKeys(model)).flatMap((group) => rotate(group, start));
  const now = Date.now();
  return [...rotated.filter((k) => !isCooling(k.id, now)), ...rotated.filter((k) => isCooling(k.id, now))];
}

/** 按优先级分组，数字大的组在前；组内保持原来的顺序 */
export function byPriority(keys) {
  const groups = new Map();
  for (const key of keys) {
    const rank = key.priority ?? 0;
    groups.set(rank, [...(groups.get(rank) ?? []), key]);
  }
  return [...groups].sort(([a], [b]) => b - a).map(([, group]) => group);
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
      SELECT u.id, u.name, u.key, u.type, u.base_url, u.models, u.account, u.concurrency, u.priority,
             u.max_pixels, u.max_steps, u.max_n, u.free_only, u.nai_account, u.enabled, u.created_at, u.last_used_at,
             u.last_error, u.last_error_at,
             COUNT(l.id) AS calls,
             COALESCE(SUM(l.status = 'success'), 0) AS success,
             COALESCE(SUM(l.images), 0) AS images,
             COALESCE(SUM(l.points), 0) AS points,
             COALESCE(SUM(CASE WHEN l.day = ? THEN l.images END), 0) AS today_images,
             COALESCE(SUM(CASE WHEN l.day = ? THEN l.points END), 0) AS today_points,
             COALESCE(SUM(l.anlas), 0) AS anlas,
             COALESCE(SUM(CASE WHEN l.day = ? THEN l.anlas END), 0) AS today_anlas
      FROM upstream_keys u LEFT JOIN logs l ON l.upstream_key_id = u.id
      GROUP BY u.id ORDER BY u.priority DESC, u.id`)
    .all(today, today, today)
    .map(({ key, nai_account: _account, ...row }) => {
      const coolingUntil = cooldowns.get(row.id) ?? 0;
      return {
        ...row,
        key_hint: keyHint(key),
        cooling_until: coolingUntil > now ? coolingUntil : null,
        nai_account: row.type === 'novelai' ? accountView({ nai_account: _account }, now) : null,
      };
    });
}

/**
 * keys 可以一次贴多把（换行或逗号分隔），都用同一个类型、接口地址和设置；已存在的跳过。
 * 并发、出图上限没填的按类型取默认值，优先级默认 0。
 */
export function addUpstreamKeys(fields = {}) {
  const { keys, type, base_url: baseUrl, name = '', account = '', models = '', concurrency, priority, free_only: freeOnly } = fields;
  const list = String(keys ?? '').split(/[\s,，]+/).filter(Boolean);
  if (!list.length) throw new HttpError(400, '请填写上游秘钥');
  for (const key of list) {
    if (!/^[\x21-\x7e]{8,200}$/.test(key)) throw new HttpError(400, `秘钥格式不对：${keyHint(key)}`);
  }
  const kind = upstreamType(type);
  const base = apiBase(baseUrl, kind);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO upstream_keys
       (name, key, type, base_url, models, account, concurrency, priority, max_pixels, max_steps, max_n, free_only, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const blank = (value) => value === undefined || value === null || value === '';
  const limit = blank(concurrency) ? DEFAULT_CONCURRENCY[kind] : concurrencyValue(concurrency);
  const rank = blank(priority) ? 0 : priorityValue(priority);
  const limits = LIMIT_FIELDS.map((f) => (blank(fields[f]) ? DEFAULT_LIMITS[kind][f] : limitOf(f, fields[f])));
  // 只出免费图只对官方秘钥有意义，官方默认开
  const free = kind === 'novelai' && (blank(freeOnly) ? true : flag(freeOnly)) ? 1 : 0;
  const ids = [];
  list.forEach((key, i) => {
    const label = list.length > 1 && name ? `${shortText(name, '名称')}-${i + 1}` : shortText(name, '名称');
    const { changes, lastInsertRowid } = insert.run(
      label, key, kind, base, modelList(models), shortText(account, '所属账号'), limit, rank, ...limits, free, Date.now(),
    );
    if (changes) ids.push(Number(lastInsertRowid));
  });
  return { added: ids.length, skipped: list.length - ids.length, ids, type: kind };
}

export function updateUpstreamKey(id, input) {
  const row = db.prepare('SELECT type, concurrency FROM upstream_keys WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '上游秘钥不存在');
  const kind = input.type === undefined ? row.type : upstreamType(input.type);
  const patch = { ...input };
  if (kind !== row.type) {
    // 换了类型：没一起改的并发、出图上限、只出免费图按新类型的默认值来，免得官方秘钥带着“不限”
    // （列表的“保存”会把没动过的并发原样带上，和原来一样就当没改）
    if (patch.concurrency === undefined || Number(patch.concurrency) === row.concurrency) {
      patch.concurrency = DEFAULT_CONCURRENCY[kind];
    }
    for (const field of LIMIT_FIELDS) patch[field] ??= DEFAULT_LIMITS[kind][field];
    patch.free_only ??= kind === 'novelai';
  }
  if (kind !== 'novelai' && patch.free_only !== undefined) patch.free_only = false; // 只有官方秘钥有这个
  const sets = [];
  const args = [];
  if (input.type !== undefined) {
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
  if (patch.concurrency !== undefined) {
    sets.push('concurrency = ?');
    args.push(concurrencyValue(patch.concurrency));
  }
  if (patch.priority !== undefined) {
    sets.push('priority = ?');
    args.push(priorityValue(patch.priority));
  }
  for (const field of LIMIT_FIELDS) {
    if (patch[field] === undefined) continue;
    sets.push(`${field} = ?`);
    args.push(limitOf(field, patch[field]));
  }
  if (patch.free_only !== undefined) {
    sets.push('free_only = ?');
    args.push(flag(patch.free_only) ? 1 : 0);
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

export function getUpstreamKey(id) {
  const row = db.prepare('SELECT * FROM upstream_keys WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '上游秘钥不存在');
  return row;
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

const flag = (value) => [true, 1, '1', 'true', 'on'].includes(value);

function priorityValue(value) {
  const n = Number(value === '' ? 0 : value);
  if (!Number.isInteger(n) || Math.abs(n) > MAX_PRIORITY) {
    throw new HttpError(400, `优先级要填 -${MAX_PRIORITY}～${MAX_PRIORITY} 的整数，数字大的先用`);
  }
  return n;
}

function limitOf(field, value) {
  try {
    return limitValue(field, value);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

function concurrencyValue(value) {
  const n = Number(value === '' ? 0 : value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_CONCURRENCY) {
    throw new HttpError(400, `并发要填 0～${MAX_CONCURRENCY} 的整数，0 表示不限`);
  }
  return n;
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
