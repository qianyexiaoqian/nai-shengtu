import { isIP } from 'node:net';
import { anlasCost } from './anlas.js';
import { config } from './config.js';
import { db } from './db.js';
import { HttpError } from './http.js';
import { ImageError } from './imageCodec.js';
import { applyLimits } from './limits.js';
import { barUsedSince, markBarUsed, needsFreshBar, noteAccountUsed, refreshAccount } from './naiAccounts.js';
import {
  NOVELAI_MODELS, imageReady, novelaiBody, novelaiImageParts, novelaiImages, novelaiRequest, novelaiShape, prepareImage,
} from './novelai.js';
import { acquireKey, createJob, releaseKey } from './queue.js';
import { getSettings } from './settings.js';
import {
  allBaseUrls, candidateKeys, liveAccount, markKeyFailed, markKeyUsed, savedAccount, upstreamBases,
} from './upstreamKeys.js';

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
 * 秘钥按优先级和并发上限取，都满了在号池里排队（见 queue.js）；signal 断开时取消排队，info 给后台排队列表显示。
 * 取到秘钥后按它的出图上限压尺寸、步数、张数（见 limits.js），换秘钥时按新秘钥的上限重新算；
 * “只出免费图”的官方秘钥只接压完之后不花 Anlas 的请求（见 anlas.js），接不了的不排给它。
 * 返回 { body, upstreamKey, queueMs, applied }，applied 是实际发出去的 { size, n, seed, anlas, changes }；
 * 失败抛出的错误上带 upstreamKey（最后尝试的那把）、queueMs（排队等了多久）和 applied。
 */
export async function generateImages(payload, { signal, info } = {}) {
  const unservable = servableError(payload);
  if (unservable) throw unservable;
  if (payload.img2img) await prepareReference(payload, signal);
  const job = createJob(payload.model, {
    signal,
    accepts: (key) => planFor(key, payload).ok,
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
    if (needsFreshBar(key, payload.model)) {
      // 只出免费图的官方秘钥出 NAI5：手上的用量条是上一张出完之前查的，占着这把秘钥的位子先查一次再决定
      await refreshAccount(key, { after: barUsedSince(key) }).catch(() => {});
      key = db.prepare('SELECT * FROM upstream_keys WHERE id = ? AND enabled = 1').get(key.id) ?? { ...key, enabled: 0 };
    }
    const plan = key.enabled ? planFor(key, payload) : { ok: false };
    if (!plan.ok) {
      // 排队时或刚查完账号状态变了（比如 NAI5 免费额度用完）、秘钥被停用了：这把不发了，放回去重新挑
      releaseKey(job);
      job.tried.delete(key.id);
      continue;
    }
    if (payload.img2img && !imageReady(payload, plan.shape)) {
      // 这把秘钥的出图上限让尺寸和预先缩放的不一样：先把秘钥放回去，缩放好了再重新排，不占着它等
      releaseKey(job);
      job.tried.delete(key.id);
      await referencePng(payload, plan.shape, signal).catch((err) => {
        err.queueMs = job.queueMs;
        throw err;
      });
      continue;
    }
    Object.assign(job.info, { size: plan.applied.size, n: plan.applied.n, anlas: plan.applied.anlas, adjusted: plan.applied.changes });
    try {
      const body = key.type === 'novelai'
        ? await requestNovelai(key, payload, plan.shape)
        : await requestGeneration(key, plan.payload);
      markKeyUsed(key);
      return { body, upstreamKey: key, queueMs: job.queueMs, applied: plan.applied };
    } catch (err) {
      err.upstreamKey = key;
      err.queueMs = job.queueMs;
      err.applied = plan.applied;
      const missing = isModelMissing(err);
      if (!missing && !FAILOVER_STATUSES.has(err.upstreamStatus)) throw err;
      markKeyFailed(key, err.upstreamStatus, err.internal ?? err.message, !missing);
      lastError = err;
    } finally {
      markBarUsed(key, payload.model); // 先记下用过 NAI5 的用量条，再让下一个请求用这把秘钥
      releaseKey(job);
      noteAccountUsed(key); // 官方秘钥出过图（或被拒）后查一下账号给后台看
    }
  }
  throw lastError ?? servableError(payload) ?? notConfiguredError(payload.model);
}

/**
 * 现在有没有上游秘钥能接这个请求，没有就给出该报的错：没有能接这个模型的秘钥 → 未配置；
 * 有，但都是官方秘钥、压完上限还是单张超过 140 Anlas → 参数太大；图生图只有 OpenAI 兼容的秘钥能接 → 不支持、
 * 只有“只出免费图”的官方秘钥 → 400；都是“只出免费图”、只是请求超出免费范围 → 400；
 * 账号那边的原因（用量条用完、不是 Opus、状态未知）→ 免费额度用不了。
 */
export function servableError(payload) {
  const plans = candidateKeys(payload.model).map((key) => ({ key, plan: planFor(key, payload) }));
  if (!plans.length) return notConfiguredError(payload.model);
  if (plans.some(({ plan }) => plan.ok)) return null;
  // 图生图只有 NovelAI 格式的上游（官方或兼容它的中转站）能出；OpenAI 兼容的接口没有图生图
  const capable = plans.filter(({ plan }) => !plan.unsupported);
  if (!capable.length) {
    return new HttpError(400, '当前没有支持图生图的上游，请联系管理员', {
      code: 'img2img_unsupported',
      internal: `图生图要 NovelAI 格式的上游秘钥（类型选 NovelAI 官方），能接模型 ${payload.model} 的都是 OpenAI 兼容的`,
    });
  }
  plans.splice(0, plans.length, ...capable);
  const reasons = plans.map(({ key, plan }) => `${key.name || `#${key.id}`}：${plan.anlas.why}，要 ${plan.anlas.total} Anlas`);
  if (plans.every(({ plan }) => plan.anlas.refused)) {
    return new HttpError(400, '尺寸或步数太大了，请调小一些再试', {
      code: 'too_expensive',
      internal: `单张超过 140 Anlas（官网也不让这么出）：${reasons.join('；')}`,
    });
  }
  if (payload.img2img) {
    // 图生图每张都要花 Anlas：不是“只出免费图”的秘钥接不了，只能是单张太贵（调小能出）；
    // 剩下的就是开着“只出免费图”的秘钥（账号状态怎样都一样）
    if (plans.some(({ key, plan }) => !key.free_only && plan.anlas.refused)) {
      return new HttpError(400, '尺寸或步数太大了，请调小一些再试', {
        code: 'too_expensive',
        internal: `单张超过 140 Anlas（官网也不让这么出）：${reasons.join('；')}`,
      });
    }
    return new HttpError(400, '图生图要花 Anlas，当前的上游只出免费图，暂时不能图生图', {
      code: 'img2img_not_free',
      internal: `能接图生图的官方秘钥都开着“只出免费图”：${reasons.join('；')}`,
    });
  }
  if (plans.every(({ plan }) => plan.anlas.refused || !plan.anlas.accountReason)) {
    return new HttpError(400, '这次请求超出了免费出图的范围（1024×1024 以内、28 步以内、一次 1 张），请调小再试', {
      code: 'outside_free_range',
      internal: `只出免费图的官方秘钥按出图上限压完还要花 Anlas：${reasons.join('；')}`,
    });
  }
  const barOnly = plans.every(({ plan }) => plan.anlas.barOnly);
  return new HttpError(503, barOnly ? 'NAI5 的免费额度暂时用完了，请稍后再试，或者换 NAI4.5 及更早的模型' : '免费出图额度暂时用不了，请稍后再试', {
    type: 'server_error',
    code: 'free_quota_exhausted',
    internal: `只出免费图的官方秘钥这次都要花 Anlas，没有发出去：${reasons.join('；')}`,
  });
}

/**
 * 图生图：按头一把接得了的秘钥的出图尺寸，先在图片线程里把参考图缩放好（解不开的图在这里报 400），
 * 排队、调 AI 优化之前就做完，轮到秘钥时不用占着它等。同一个请求再调用不会重做。
 */
export async function prepareReference(payload, signal) {
  const first = candidateKeys(payload.model).map((key) => planFor(key, payload)).find((plan) => plan.ok);
  if (first) await referencePng(payload, first.shape, signal);
}

// 参考图缩放失败是这张图的问题、不是秘钥的：按 400 报，不换秘钥；图片线程忙不过来 503；调用方断开 499
async function referencePng(payload, shape, signal) {
  try {
    return await prepareImage(payload, shape, signal);
  } catch (err) {
    if (err instanceof ImageError) throw new HttpError(400, err.message, { param: 'image', code: 'invalid_image', internal: err.cause && String(err.cause) });
    if (err.code === 'image_busy') {
      throw new HttpError(503, '参考图处理排队的太多了，请稍后再试', { type: 'server_error', code: 'image_busy' });
    }
    if (err.code === 'aborted') throw new HttpError(499, '调用方已断开，取消处理参考图', { code: 'client_closed' });
    throw err;
  }
}

/**
 * 这个请求最多会出几张：能接它的秘钥里按出图上限压完最多的那个（比如官方秘钥一次只出 1 张，要 4 张也只占 1 张额度）。
 * 都接不了时按要的张数算（后面会报错，不出图）。
 */
export function plannedImages(payload) {
  const counts = candidateKeys(payload.model)
    .map((key) => planFor(key, payload))
    .filter((plan) => plan.ok)
    .map((plan) => plan.applied.n);
  return counts.length ? Math.max(...counts) : (payload.n ?? 1);
}

const notConfiguredError = (model) => new HttpError(503, '服务暂未就绪，请联系管理员', {
  type: 'server_error',
  code: 'not_configured',
  internal: `没有能用的上游秘钥（或者都不支持模型 ${model}），请在后台“上游秘钥”页添加、启用，或者给秘钥加上这个模型`,
});

/**
 * 按这把秘钥的出图上限定下实际发的尺寸、步数、张数，ok 表示这把秘钥接不接这个请求。
 * 官方的按补上默认值后的实际参数压（没写步数也是 28 步；medium 固定 14 步，不压步数），再按账号状态算 Anlas：
 * 单张超过 140 的不接，“只出免费图”的要花 Anlas 就不接。
 * OpenAI 兼容的只压请求里写了的（没写步数就是上游自己的默认，中继不知道是多少），没写尺寸按 1024x1024 算。
 */
function planFor(key, payload) {
  if (key.type === 'novelai') {
    const limits = /-medium/.test(payload.model) ? { ...key, max_steps: 0 } : key;
    const { shape, changes } = applyLimits(novelaiShape(payload), limits);
    // 接不接按算数的账号状态（liveAccount）判断；记账的估算用存着的最近一次状态，从来没查到过就不估
    const anlas = anlasCost(payload.model, shape, liveAccount(key));
    const known = savedAccount(key);
    const estimate = known?.checked_at ? anlasCost(payload.model, shape, known).total : null;
    return {
      payload,
      shape,
      anlas,
      ok: !anlas.refused && (!key.free_only || anlas.free),
      applied: { size: `${shape.width}x${shape.height}`, n: shape.n, seed: shape.seed, anlas: estimate, changes },
    };
  }
  const [width, height] = (/^(\d+)x(\d+)$/.exec(payload.size ?? '') ?? [0, 1024, 1024]).slice(1).map(Number);
  // OpenAI 兼容的上游不能图生图，不接（servableError 给出原因）
  if (payload.img2img) return { payload, ok: false, unsupported: true, applied: { size: `${width}x${height}`, n: payload.n ?? 1, changes: [] } };
  const wanted = { width, height, steps: payload.steps, n: payload.n ?? 1 };
  const { shape, changes } = applyLimits(wanted, key);
  const sent = { ...payload };
  if (shape.width !== width || shape.height !== height) sent.size = `${shape.width}x${shape.height}`;
  if (shape.steps !== wanted.steps) sent.steps = shape.steps;
  if (shape.n !== wanted.n) sent.n = shape.n;
  return { payload: sent, ok: true, applied: { size: sent.size ?? `${width}x${height}`, n: shape.n, seed: payload.seed, changes } };
}

/**
 * 优先要链接：图片留在上游，中继不用存文件（有的 NAI 中转站不管写什么都只给链接）。
 * 有的上游不认 response_format（比如 gpt-image 系列只给 b64_json），报这个参数错时去掉再请求一次，参数错误不会出图扣点。
 */
async function requestGeneration(key, { nai: _nai, img2img: _img2img, ...payload }) {
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

/** NovelAI 官方：按 shape（已按秘钥上限压过）转成官方请求，图片从 ZIP 里取出来，按 OpenAI 格式的 b64_json 返回 */
async function requestNovelai(key, payload, shape) {
  const request = novelaiRequest(payload, shape);
  const { body, headers } = novelaiBody(request, await novelaiImageParts(request, payload, shape));
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
