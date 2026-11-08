import { isIP } from 'node:net';
import { config } from './config.js';
import { HttpError } from './http.js';
import {
  NOVELAI_ACCOUNT_API, NOVELAI_BASE, NOVELAI_MODELS, novelaiAccount, novelaiBody, novelaiImages, novelaiRequest,
} from './novelai.js';
import { acquireKey, createJob, releaseKey } from './queue.js';
import { getSettings } from './settings.js';
import { allBaseUrls, candidateKeys, markKeyFailed, markKeyUsed, upstreamBases } from './upstreamKeys.js';

// 这些状态说明是这把上游秘钥的问题（失效、点数不足、不允许该模型、限流），上游没出图也没扣点，换下一把重试。
// 超时、5xx 不切换：上游可能已经出图扣点，重试会重复扣费。
const FAILOVER_STATUSES = new Set([401, 402, 403, 429]);
// 这个上游没有请求的模型（或者接口地址填错了）：同样没出图，换下一把，但不冷却，它接别的模型照样正常
const isModelMissing = (err) => err.upstreamStatus === 404 || err.code === 'model_not_found';
// 上游秘钥用不了时调用方看到的话；原因只进调用日志
const UNAVAILABLE = '生图失败：服务暂时不可用，请联系管理员';

/**
 * 在支持这个模型的上游秘钥里轮询，按秘钥的类型调它的接口地址（OpenAI 兼容的 /images/generations，
 * 或 NovelAI 官方的 /ai/generate-image），遇到秘钥自身的问题自动换下一把。
 * 统一返回 OpenAI 格式：图片在 data[].url（上游地址，不能直接给调用方，见 imageStore.js）或 data[].b64_json 里。
 * 秘钥按并发上限取，都满了在号池里排队（见 queue.js）；signal 断开时取消排队，info 给后台排队列表显示。
 * 返回 { body, upstreamKey, queueMs }；失败抛出的错误上带 upstreamKey（最后尝试的那把）和 queueMs（排队等了多久）。
 */
export async function generateImages(payload, { signal, info } = {}) {
  const notConfigured = () => new HttpError(503, '服务暂未就绪，请联系管理员', {
    type: 'server_error',
    code: 'not_configured',
    internal: `没有能用的上游秘钥（或者都不支持模型 ${payload.model}），请在后台“上游秘钥”页添加、启用，或者给秘钥加上这个模型`,
  });
  if (!candidateKeys(payload.model).length) throw notConfigured();
  const job = createJob(payload.model, {
    signal,
    info: { upstream_model: payload.model, size: payload.size ?? '1024x1024', n: payload.n ?? 1, ...info },
  });
  let lastError;
  for (;;) {
    let key;
    try {
      key = await acquireKey(job);
    } catch (err) {
      err.upstreamKey = lastError?.upstreamKey;
      err.queueMs = job.queueMs;
      throw err;
    }
    if (!key) break;
    try {
      const body = key.type === 'novelai' ? await requestNovelai(key, payload) : await requestGeneration(key, payload);
      markKeyUsed(key);
      return { body, upstreamKey: key, queueMs: job.queueMs };
    } catch (err) {
      err.upstreamKey = key;
      err.queueMs = job.queueMs;
      const missing = isModelMissing(err);
      if (!missing && !FAILOVER_STATUSES.has(err.upstreamStatus)) throw err;
      markKeyFailed(key, err.upstreamStatus, err.internal ?? err.message, !missing);
      lastError = err;
    } finally {
      releaseKey(job);
    }
  }
  throw lastError ?? notConfigured();
}

/**
 * 优先要链接：图片留在上游，中继不用存文件（有的 NAI 中转站不管写什么都只给链接）。
 * 有的上游不认 response_format（比如 gpt-image 系列只给 b64_json），报这个参数错时去掉再请求一次，参数错误不会出图扣点。
 */
async function requestGeneration(key, { nai: _nai, ...payload }) {
  let res = await postGeneration(key, { ...payload, response_format: 'url' });
  let body = await res.json().catch(() => null);
  if (res.status === 400 && /response_format/i.test(JSON.stringify(body?.error ?? body?.detail ?? ''))) {
    res = await postGeneration(key, payload);
    body = await res.json().catch(() => null);
  }
  if (res.ok && !body?.error && !body?.detail && body?.data?.some((item) => item?.url || item?.b64_json)) {
    return withoutHintImages(body);
  }
  throw upstreamError(res.status, body);
}

/** NovelAI 官方：转成官方请求，图片从 ZIP 里取出来，按 OpenAI 格式的 b64_json 返回 */
async function requestNovelai(key, payload) {
  const { body, headers } = novelaiBody(novelaiRequest(payload));
  let res;
  try {
    res = await fetch(`${key.base_url}/ai/generate-image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.key}`, ...headers },
      body,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    throw networkError(err, '生图');
  }
  if (!res.ok) throw upstreamError(res.status, await res.json().catch(() => null));
  let images;
  try {
    images = await novelaiImages(res);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw networkError(err, '生图');
    images = [];
    console.warn(`NovelAI 返回的图片解析失败：${err.message}`);
  }
  if (!images.length) throw upstreamError(502, { message: `上游返回 HTTP ${res.status}，但没有能解析的图片` });
  return { created: Math.floor(Date.now() / 1000), data: images.map((data) => ({ b64_json: data.toString('base64') })) };
}

// 有的上游点数不足时照样回 200，给一张放在 /img/error/ 下的提示图，比如 balance-insufficient-20260828.png
function hintImageName(item) {
  try {
    const { pathname } = new URL(item.url);
    return /\/error\//i.test(pathname) ? pathname.split('/').pop() : null;
  } catch {
    return null;
  }
}

/**
 * 有的上游账号点数不足、额度耗尽时照样回 HTTP 200，data[].url 却是一张提示图，没有出图也没扣点。
 * 提示图去掉；一张真图都没有就按生图失败处理，和 402 一样换下一把秘钥、这把冷却。
 */
function withoutHintImages(body) {
  const hints = body.data.map((item) => item?.url && hintImageName(item)).filter(Boolean);
  if (!hints.length) return body;
  const data = body.data.filter((item) => (item?.url || item?.b64_json) && !(item.url && hintImageName(item)));
  if (data.length) return { ...body, data };
  const reason = /balance|insufficient/i.test(hints[0]) ? '账号点数不足' : '上游报错';
  const err = new HttpError(503, UNAVAILABLE, {
    type: 'server_error',
    code: 'upstream_unavailable',
    internal: `上游没有出图，返回的是提示图 ${hints[0]}（${reason}）`,
  });
  err.upstreamStatus = 402;
  throw err;
}

async function postGeneration(key, body) {
  try {
    return await fetch(`${key.base_url}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    throw networkError(err, '生图');
  }
}

export async function fetchImageBase64(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    throw networkError(err, '下载生成图片');
  }
  if (!res.ok) {
    throw new HttpError(502, `下载生成图片失败：HTTP ${res.status}`, { type: 'server_error' });
  }
  const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png';
  return { mime, b64: Buffer.from(await res.arrayBuffer()).toString('base64') };
}

/** 用这把秘钥查这个接口地址的 /models，返回模型 ID 列表；NovelAI 官方没有这个接口，直接给官方模型列表 */
export async function fetchModelIds(baseUrl, key, type = 'openai') {
  if (type === 'novelai') return [...NOVELAI_MODELS];
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) throw new Error('模型列表格式不对');
  return body.data.map((m) => m?.id).filter((id) => typeof id === 'string');
}

/** 每个上游接口地址各用一把秘钥查 /models；返回 [{ baseUrl, models }]，查不到的是 { baseUrl, error } */
export function listModels() {
  return Promise.all(upstreamBases().map(async ({ baseUrl, key, type }) => {
    try {
      return { baseUrl, models: await fetchModelIds(baseUrl, key, type) };
    } catch (err) {
      return { baseUrl, error: err.cause?.message || err.message };
    }
  }));
}

/**
 * NovelAI 官方秘钥的套餐和 Anlas 余额（GET api.novelai.net/user/subscription），顺便验证令牌能不能用。
 * 接口地址不是官方的（自建反代之类）查不了，返回 null。
 */
export async function fetchNovelaiAccount(baseUrl, key) {
  if (baseUrl !== NOVELAI_BASE) return null;
  const res = await fetch(`${NOVELAI_ACCOUNT_API}/user/subscription`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}${body?.message ? `：${body.message}` : ''}`);
  return novelaiAccount(body);
}

const TLDS =
  'com|net|org|cn|io|me|cc|co|ai|app|dev|xyz|top|vip|site|online|info|pro|club|tech|link|fun|ink|shop|store|' +
  'cloud|icu|work|live|life|space|website|moe|tv|us|uk|jp|hk|tw|sg|ru|de';
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// 不只认配置的上游域名：上游换 IP、别名接入时，错误信息里照样可能出现它的品牌域名
function buildHideRegex(hosts, hideWords) {
  const domains = new Set(hosts.map((host) => (isIP(host) || !host.includes('.') ? host : host.split('.').slice(-2).join('.'))));
  return new RegExp(
    [
      'https?://[\\x21-\\x7e]+', // 网址
      '[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+', // 邮箱
      `(?:[a-z0-9-]+\\.)+(?:${TLDS})(?![\\w-])(?::\\d+)?(?:/[\\x21-\\x7e]*)?`, // 裸域名，可带端口和路径
      '\\b\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d+)?\\b', // IP
      ...[...domains].map((domain) => `(?:[\\w-]+\\.)*${escapeRe(domain)}`), // 各个上游的域名及其子域名（TLD 不在上表时也能盖住）
      ...hideWords.map(escapeRe),
    ].join('|'),
    'gi',
  );
}

let hideCache = { signature: null, re: null };

/** 上游给的文字转给调用方前先过一遍，去掉能认出上游的信息 */
export function scrub(text) {
  const { upstreamBase, hideWords } = getSettings();
  // 所有上游秘钥的接口地址（含停用的），再加上旧版的单一上游地址
  const hosts = [...new Set([...allBaseUrls(), upstreamBase].map(hostOf).filter(Boolean))].sort();
  const signature = `${hosts.join('\n')}\n\n${hideWords.join('\n')}`;
  if (hideCache.signature !== signature) hideCache = { signature, re: buildHideRegex(hosts, hideWords) };
  return String(text).replace(hideCache.re, '***');
}

const STATUS_TYPES = { 401: 'authentication_error', 403: 'permission_error', 429: 'rate_limit_error' };

// 上游失败时可能给 { error: {...} }，也可能是 FastAPI 风格的 { detail }、NovelAI 官方的 { statusCode, message }，统一成 OpenAI 错误。
// 只取 message / type / code，error.url（提示图）等其它字段一律不转。
// 上游的 401/402/403 是我们自己的上游秘钥失效、点数（Anlas）不足或没开通模型，不能原样当成调用方的错误。
function upstreamError(status, body) {
  const raw = body?.error?.message || formatDetail(body?.detail) || (typeof body?.message === 'string' && body.message)
    || `上游返回 HTTP ${status}，没有图片`;
  let err;
  if ([401, 402, 403].includes(status)) {
    err = new HttpError(503, UNAVAILABLE, {
      type: 'server_error',
      code: 'upstream_unavailable',
      internal: `上游秘钥不可用（HTTP ${status}）：${raw}`,
    });
  } else {
    const httpStatus = status >= 400 ? status : 502;
    const type = /^[a-z_]{1,40}$/i.test(body?.error?.type ?? '')
      ? body.error.type
      : STATUS_TYPES[httpStatus] || (httpStatus < 500 ? 'invalid_request_error' : 'server_error');
    const code = /^[\w-]{1,40}$/.test(String(body?.error?.code ?? '')) ? String(body.error.code) : null;
    err = new HttpError(httpStatus, scrub(raw), { type, code, internal: `HTTP ${status}：${raw}` });
  }
  err.upstreamStatus = status;
  return err;
}

function formatDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d?.msg ? `${(d.loc || []).join('.')}: ${d.msg}` : JSON.stringify(d)))
      .join('; ');
  }
  return JSON.stringify(detail);
}

// 网络错误里会带上游的域名、IP、端口，只进日志，不返回给调用方
function networkError(err, what) {
  const internal = `${what}请求失败：${err.cause?.message || err.message}`;
  console.warn(internal);
  if (err.name === 'TimeoutError') {
    return new HttpError(504, `${what}超时；可能已经生成并扣点，请稍后查看再决定是否重试`, {
      type: 'server_error',
      code: 'timeout',
      internal,
    });
  }
  return new HttpError(502, `${what}失败：服务暂时无法连接，请稍后重试`, {
    type: 'server_error',
    code: 'bad_gateway',
    internal,
  });
}
