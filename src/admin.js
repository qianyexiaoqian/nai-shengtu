import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { DEFAULT_SYSTEM_PROMPT, aiConfigured, listAiCalls, optimizePrompt } from './aiPrompt.js';
import { HttpError, inferredBaseUrl, readJson, sendJson } from './http.js';
import { createKey, deleteKey, listKeys, updateKey } from './keys.js';
import {
  addModels, deleteModel, listModelRows, pullUpstreamModels, resolveModel, updateModel, upstreamModelOptions,
} from './models.js';
import { queueSnapshot } from './queue.js';
import { convertText } from './tags.js';
import { getSettings, saveSettings } from './settings.js';
import { addUpstreamKeys, deleteUpstreamKey, listUpstreamKeys, updateUpstreamKey } from './upstreamKeys.js';
import { aiSummary, beijingDay, getStats, listLogs } from './usage.js';

const SESSION_MS = 7 * 86_400_000;
const sessions = new Map(); // 登录令牌 → 过期时间；只在内存里，重启后需要重新登录

/** ADMIN_PASSWORD 有值就每次启动重置成它；否则首次启动随机生成一个并打印 */
export function initAdminPassword() {
  if (config.adminPassword) {
    saveSettings({ admin_password_hash: hashPassword(config.adminPassword) });
  } else if (!getSettings().adminPasswordHash) {
    const password = randomBytes(9).toString('base64url');
    saveSettings({ admin_password_hash: hashPassword(password) });
    console.log(`后台初始密码：${password}（登录 /admin 后可在“设置”里修改）`);
  }
}

const ROUTES = [
  ['GET', /^\/stats$/, () => getStats()],
  ['GET', /^\/logs$/, ({ query }) =>
    listLogs({
      page: positiveInt(query.get('page'), 1),
      pageSize: Math.min(100, positiveInt(query.get('page_size'), 20)),
      keyId: positiveInt(query.get('key_id'), 0) || undefined,
      status: ['success', 'error'].includes(query.get('status')) ? query.get('status') : undefined,
    })],
  ['GET', /^\/keys$/, () => listKeys()],
  ['POST', /^\/keys$/, ({ body }) => createKey(body)],
  ['PATCH', /^\/keys\/(\d+)$/, ({ params, body }) => updateKey(Number(params[0]), body)],
  ['DELETE', /^\/keys\/(\d+)$/, ({ params }) => deleteKey(Number(params[0]))],
  ['GET', /^\/queue$/, () => queueSnapshot()],
  ['GET', /^\/upstream-keys$/, () => listUpstreamKeys()],
  ['POST', /^\/upstream-keys$/, ({ body }) => addUpstreamKeys(body)],
  ['POST', /^\/upstream-keys\/models$/, ({ body }) => pullUpstreamModels(body)],
  ['PATCH', /^\/upstream-keys\/(\d+)$/, ({ params, body }) => updateUpstreamKey(Number(params[0]), body)],
  ['DELETE', /^\/upstream-keys\/(\d+)$/, ({ params }) => deleteUpstreamKey(Number(params[0]))],
  ['GET', /^\/models$/, () => ({ models: listModelRows(), default_model: getSettings().defaultModel })],
  ['GET', /^\/models\/upstream$/, () => upstreamModelOptions()],
  ['POST', /^\/models$/, ({ body }) => addModels(body.models)],
  ['PATCH', /^\/models\/(.+)$/, ({ params, body }) => updateModel(params[0], body)],
  ['DELETE', /^\/models\/(.+)$/, ({ params }) => deleteModel(params[0])],
  ['GET', /^\/settings$/, ({ req }) => settingsView(req)],
  ['PUT', /^\/settings$/, ({ req, body }) => updateSettings(req, body)],
  ['GET', /^\/ai$/, ({ query }) => ({
    configured: aiConfigured(),
    today: aiSummary(beijingDay()),
    total: aiSummary(),
    calls: listAiCalls({ page: positiveInt(query.get('page'), 1), pageSize: 20 }),
  })],
  ['POST', /^\/ai\/test$/, async ({ body }) => {
    const text = String(body.text ?? '').trim().slice(0, 2000);
    if (!text) throw new HttpError(400, '先写一句要优化的描述');
    // 和真实生图一样：先过一遍本地词典作参考，目标模型用默认模型
    const local = convertText(text);
    const r = await optimizePrompt(text, {
      source: 'test', force: true, hints: local.tags.map((t) => t.text).join(', '), targetModel: defaultUpstreamModel(),
    });
    return {
      prompt: r.prompt, sentences: r.sentences, raw: r.raw, usage: r.usage, cost: r.cost, duration_ms: r.durationMs,
      rounds: r.rounds, tool_calls: r.toolCalls, note: r.note,
    };
  }],
  ['POST', /^\/logout$/, ({ token }) => {
    sessions.delete(token);
    return { ok: true };
  }],
];

/** /admin/api/* —— subpath 是去掉 /admin/api 之后的部分 */
export async function handleAdminApi(req, res, subpath, query) {
  if (req.method === 'POST' && subpath === '/login') {
    return sendJson(res, 200, await login(await readJson(req)));
  }
  const token = requireSession(req);
  for (const [method, pattern, handler] of ROUTES) {
    const match = req.method === method && pattern.exec(subpath);
    if (!match) continue;
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(req) : {};
    const params = match.slice(1).map(decodeURIComponent);
    return sendJson(res, 200, await handler({ req, body, params, query, token }));
  }
  throw new HttpError(404, '接口不存在', { code: 'not_found' });
}

async function login(body) {
  if (!verifyPassword(body.password, getSettings().adminPasswordHash)) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 拖慢暴力猜密码
    throw new HttpError(401, '密码错误', { type: 'authentication_error' });
  }
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_MS);
  return { token };
}

function requireSession(req) {
  const token = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '')?.[1];
  const expiresAt = token && sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    throw new HttpError(401, '未登录或登录已过期', { type: 'authentication_error' });
  }
  return token;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(String(password), salt, 32).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored ?? '').split(':');
  if (!salt || !hash || typeof password !== 'string') return false;
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
}

function settingsView(req) {
  const s = getSettings();
  return {
    default_model: s.defaultModel,
    public_base_url: s.publicBaseUrl,
    // 对外地址留空时，按管理员当前访问的地址推断出来的样子，给页面提示用
    inferred_base_url: inferredBaseUrl(req),
    listen_port: config.port,
    chat_image_mode: s.chatImageMode,
    image_ttl_days: s.imageTtlDays,
    point_price: s.pointPrice,
    hide_words: s.hideWords.join(','),
    queue_timeout: s.queueTimeoutMs / 1000,
    queue_max: s.queueMax,
    prompt_assist: s.promptAssist,
    prompt_assist_nsfw: s.promptAssistNsfw,
    prompt_fix: s.promptFix,
    prompt_echo: s.promptEcho,
    ai_mode: s.aiMode,
    ai_apply_models: s.aiApplyModels,
    ai_base_url: s.aiBaseUrl,
    // AI 接口秘钥只回提示，留空保存表示不修改
    ai_api_key_hint: s.aiApiKey ? (s.aiApiKey.length > 12 ? `${s.aiApiKey.slice(0, 6)}…${s.aiApiKey.slice(-4)}` : '已设置') : '',
    ai_model: s.aiModel,
    ai_price_input: s.aiPrices.input,
    ai_price_output: s.aiPrices.output,
    ai_price_cache_read: s.aiPrices.cacheRead,
    ai_price_cache_write: s.aiPrices.cacheWrite,
    ai_system_prompt: s.aiSystemPrompt,
    ai_default_system_prompt: DEFAULT_SYSTEM_PROMPT,
    ai_tools: s.aiTools,
    ai_reasoning_effort: s.aiReasoningEffort,
    ai_offpeak: s.aiOffpeak,
    password_from_env: Boolean(config.adminPassword),
  };
}

function updateSettings(req, body) {
  const values = {};
  if (body.default_model !== undefined) {
    const id = String(body.default_model).trim();
    if (!listModelRows().some((m) => m.id === id)) throw new HttpError(400, '默认模型必须是已添加的模型');
    values.default_model = id;
  }
  if (body.public_base_url !== undefined) values.public_base_url = httpUrl(body.public_base_url, '对外地址', true);
  if (body.chat_image_mode !== undefined) {
    if (!['url', 'b64'].includes(body.chat_image_mode)) throw new HttpError(400, '聊天图片形式只能是 url 或 b64');
    values.chat_image_mode = body.chat_image_mode;
  }
  if (body.image_ttl_days !== undefined) {
    const days = Number(body.image_ttl_days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, '图片链接有效期需为 1～365 天');
    values.image_ttl_days = days;
  }
  if (body.point_price !== undefined) {
    const price = Number(body.point_price);
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, '每点价格必须是不小于 0 的数字');
    values.point_price = price;
  }
  if (body.hide_words !== undefined) values.hide_words = String(body.hide_words);
  if (body.queue_timeout !== undefined) {
    const seconds = Number(body.queue_timeout);
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) throw new HttpError(400, '排队最长等待需为 10～3600 秒');
    values.queue_timeout = seconds;
  }
  if (body.queue_max !== undefined) {
    const max = Number(body.queue_max);
    if (!Number.isInteger(max) || max < 0 || max > 10000) throw new HttpError(400, '最多排队数需为 0～10000 的整数，0 表示不限');
    values.queue_max = max;
  }
  for (const flag of ['prompt_assist', 'prompt_assist_nsfw', 'prompt_fix', 'prompt_echo']) {
    if (body[flag] !== undefined) values[flag] = [true, '1', 1, 'on'].includes(body[flag]) ? '1' : '0';
  }
  Object.assign(values, aiSettings(body));
  if (body.new_password) {
    if (String(body.new_password).length < 8) throw new HttpError(400, '新密码至少 8 位');
    values.admin_password_hash = hashPassword(body.new_password);
  }
  saveSettings(values);
  return settingsView(req);
}

function defaultUpstreamModel() {
  try {
    return resolveModel(undefined).upstream;
  } catch {
    return undefined;
  }
}

/** AI 提示词优化的设置项校验；打开时要求接口地址、秘钥、模型都已填 */
function aiSettings(body) {
  const values = {};
  if (body.ai_mode !== undefined) {
    if (!['off', 'auto', 'always'].includes(body.ai_mode)) throw new HttpError(400, 'AI 优化模式只能是 off / auto / always');
    values.ai_mode = body.ai_mode;
  }
  if (body.ai_apply_models !== undefined) {
    // 数组或逗号分隔都行；空 = 所有模型
    const raw = Array.isArray(body.ai_apply_models) ? body.ai_apply_models : String(body.ai_apply_models).split(/[\s,，]+/);
    const ids = [...new Set(raw.map((m) => String(m).trim()).filter(Boolean))];
    const known = new Set(listModelRows().map((m) => m.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new HttpError(400, `没有这些模型：${unknown.join('、')}`);
    values.ai_apply_models = ids.join(',');
  }
  if (body.ai_base_url !== undefined) values.ai_base_url = httpUrl(body.ai_base_url, 'AI 接口地址', true);
  if (typeof body.ai_api_key === 'string' && body.ai_api_key.trim()) values.ai_api_key = body.ai_api_key.trim();
  if (body.ai_model !== undefined) {
    const model = String(body.ai_model).trim();
    if (model.length > 100) throw new HttpError(400, '模型名称太长');
    values.ai_model = model;
  }
  for (const field of ['ai_price_input', 'ai_price_output', 'ai_price_cache_read', 'ai_price_cache_write']) {
    if (body[field] === undefined) continue;
    const price = Number(body[field] === '' ? 0 : body[field]);
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, '价格必须是不小于 0 的数字');
    values[field] = price;
  }
  for (const flag of ['ai_tools', 'ai_offpeak']) {
    if (body[flag] !== undefined) values[flag] = [true, '1', 1, 'on'].includes(body[flag]) ? '1' : '0';
  }
  if (body.ai_reasoning_effort !== undefined) {
    const effort = String(body.ai_reasoning_effort).trim();
    if (effort && !/^[a-z]{1,20}$/.test(effort)) throw new HttpError(400, '思考强度只能是 none、low、high 这样的英文单词');
    values.ai_reasoning_effort = effort;
  }
  if (body.ai_system_prompt !== undefined) {
    const text = String(body.ai_system_prompt).trim();
    if (text.length > 8000) throw new HttpError(400, '系统提示词不超过 8000 字');
    values.ai_system_prompt = text === DEFAULT_SYSTEM_PROMPT.trim() ? '' : text; // 和内置的一样就存空，以后内置的更新能跟上
  }
  const s = getSettings();
  const next = {
    mode: values.ai_mode ?? s.aiMode,
    ready: (values.ai_base_url ?? s.aiBaseUrl) && (values.ai_api_key ?? s.aiApiKey) && (values.ai_model ?? s.aiModel),
  };
  if (next.mode !== 'off' && !next.ready) throw new HttpError(400, '打开 AI 优化前，要先填好接口地址、API Key 和模型名称');
  return values;
}

function httpUrl(value, label, allowEmpty) {
  const url = String(value ?? '').trim().replace(/\/+$/, '');
  if (!url && allowEmpty) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // 交给下面统一报错
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new HttpError(400, `${label}必须是 http(s) 开头的网址`);
  return url;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
