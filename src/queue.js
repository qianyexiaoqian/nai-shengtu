import { HttpError } from './http.js';
import { getSettings } from './settings.js';
import { candidateKeys, isCooling, nextRotation, rotate } from './upstreamKeys.js';

// 号池调度：每把上游秘钥有并发上限（concurrency，0 = 不限），能接这个模型的秘钥都满了时请求在这里排队，
// 有秘钥空出来就按到达顺序发下一个。只在内存里，重启后排队中的请求随连接一起断开。
const waiting = []; // 排队中的请求，按到达顺序
const running = new Map(); // 请求 id → 正在出图的请求
const active = new Map(); // 秘钥 id → 正在用它出图的请求数
let seq = 0;

const limitOf = (key) => (key.concurrency > 0 ? key.concurrency : Infinity);
const hasRoom = (key) => (active.get(key.id) ?? 0) < limitOf(key);

/** 一次出图请求在调度里的记录。info 给后台排队列表看：调用密钥、接口、模型、尺寸、张数、提示词 */
export function createJob(model, { signal, info = {} } = {}) {
  return {
    id: ++seq, model, signal, info, rotation: nextRotation(), createdAt: Date.now(),
    tried: new Set(), key: null, startedAt: null, queueMs: 0,
  };
}

/**
 * 给请求拿一把秘钥，job.tried 里的（这次失败过的）跳过。有空位立刻给；能接这个模型的秘钥都满了就排队，
 * 轮到了再给；一把能试的都没有了给 null。排队超时、排队人数满了、调用方断开时抛错。
 */
export function acquireKey(job) {
  const picked = pick(job, new Map());
  if (picked !== undefined) {
    if (picked) start(job, picked);
    return Promise.resolve(picked);
  }
  const { queueMax, queueTimeoutMs } = getSettings();
  if (queueMax > 0 && waiting.length >= queueMax) {
    return Promise.reject(new HttpError(503, `排队的请求太多（${waiting.length} 个），请稍后再试`, {
      type: 'server_error', code: 'queue_full',
    }));
  }
  if (job.signal?.aborted) return Promise.reject(closedError());
  return new Promise((resolve, reject) => {
    const since = Date.now();
    const done = () => {
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', onAbort);
      job.queueMs += Date.now() - since;
    };
    const leave = (err) => {
      remove(job);
      done();
      reject(err);
    };
    const onAbort = () => leave(closedError());
    const timer = setTimeout(() => leave(new HttpError(503, `排队超过 ${Math.round(queueTimeoutMs / 1000)} 秒还没轮到，请稍后再试`, {
      type: 'server_error', code: 'queue_timeout',
    })), queueTimeoutMs);
    job.signal?.addEventListener('abort', onAbort, { once: true });
    job.wake = (key) => {
      done();
      if (key) start(job, key);
      resolve(key);
    };
    insert(job);
  });
}

/** 这次用完秘钥（成功失败都算），空出来的位置马上给排队的 */
export function releaseKey(job) {
  if (!job.key) return;
  const left = (active.get(job.key.id) ?? 1) - 1;
  if (left > 0) active.set(job.key.id, left);
  else active.delete(job.key.id);
  running.delete(job.id);
  job.key = null;
  dispatch();
}

/** 按到达顺序看排队的请求，能发的就发；排在前面的模型没空位，不挡后面别的模型 */
export function dispatch() {
  const cache = new Map();
  for (const job of [...waiting]) {
    const picked = pick(job, cache);
    if (picked === undefined) continue;
    remove(job);
    job.wake(picked);
  }
}

// 冷却到期、后台调大并发或启用了秘钥时也要接上，不只靠有请求结束
setInterval(dispatch, 1000).unref();

/**
 * 这个请求现在能用哪把：秘钥按这个请求的轮询起点转一圈，有没在冷却的就只用它们（都满了就等），
 * 全在冷却才试冷却中的。返回秘钥；undefined = 都满了要等；null = 没有能试的了。
 */
function pick(job, cache) {
  if (!cache.has(job.model)) cache.set(job.model, candidateKeys(job.model));
  // 先整圈转好再去掉试过的，换秘钥时接着往下一把走
  const keys = rotate(cache.get(job.model), job.rotation).filter((k) => !job.tried.has(k.id));
  if (!keys.length) return null;
  const now = Date.now();
  const healthy = keys.filter((k) => !isCooling(k.id, now));
  return (healthy.length ? healthy : keys).find(hasRoom);
}

function start(job, key) {
  active.set(key.id, (active.get(key.id) ?? 0) + 1);
  job.key = key;
  job.startedAt = Date.now();
  job.tried.add(key.id);
  running.set(job.id, job);
}

// 失败换秘钥后重新排队的请求回到原来的位置，不排到最后
function insert(job) {
  const i = waiting.findIndex((w) => w.id > job.id);
  waiting.splice(i < 0 ? waiting.length : i, 0, job);
}

function remove(job) {
  const i = waiting.indexOf(job);
  if (i >= 0) waiting.splice(i, 1);
}

const closedError = () => new HttpError(499, '调用方已断开，取消排队', { code: 'client_closed' });

/** 后台“排队”页：每把秘钥的并发占用，正在出图的和排队中的请求 */
export function queueSnapshot() {
  const now = Date.now();
  const keyName = (k) => k.name || `#${k.id}`;
  const view = (job) => ({ id: job.id, ...job.info, created_at: job.createdAt });
  return {
    now,
    keys: candidateKeys().map((k) => ({
      id: k.id, name: keyName(k), type: k.type, concurrency: k.concurrency,
      active: active.get(k.id) ?? 0, cooling: isCooling(k.id, now),
    })),
    running: [...running.values()].map((job) => ({
      ...view(job), key_id: job.key.id, key_name: keyName(job.key), key_type: job.key.type,
      started_at: job.startedAt, queue_ms: job.queueMs,
    })),
    waiting: waiting.map((job, i) => ({
      ...view(job),
      position: i + 1,
      retry: job.tried.size > 0, // 已经在别的秘钥上失败过，换秘钥重新排队
      candidates: candidateKeys(job.model).filter((k) => !job.tried.has(k.id)).map((k) => k.id),
    })),
  };
}
