import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { ImageError } from './imageCodec.js';

// 参考图的解码、缩放放在单独的线程里（imageThread.js）：一张手机照片要半秒到一秒，放主线程会卡住所有请求。
// 开 POOL_SIZE 个线程，每个一次做一张，其余排队；排队的超过 MAX_WAITING 张就报忙，请求断开了还没开始做的直接去掉。
// 单张超过 JOB_TIMEOUT_MS 就结束那个线程（之后换新线程）。
const POOL_SIZE = Math.max(1, Math.min(3, availableParallelism() - 1));
const MAX_WAITING = 32;
const JOB_TIMEOUT_MS = 30_000;
const waiting = [];
const slots = Array.from({ length: POOL_SIZE }, () => ({ thread: null, job: null }));

/**
 * 解码后等比居中裁切缩放到 width×height，编成 PNG 返回 Buffer。
 * 图片的问题（解不开、超时）抛 ImageError，message 可以直接给调用方看；排队满了抛 code 为 image_busy 的错误，
 * signal 断开时抛 code 为 aborted 的错误。
 */
export function coverPng(bytes, width, height, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('请求已断开'), { code: 'aborted' }));
    if (waiting.length >= MAX_WAITING) return reject(Object.assign(new Error('参考图处理排队的太多了'), { code: 'image_busy' }));
    const job = { message: { width, height }, bytes, resolve, reject, signal };
    job.onAbort = () => {
      const i = waiting.indexOf(job);
      if (i < 0) return; // 已经在做了，做完结果没人要也无妨
      waiting.splice(i, 1);
      reject(Object.assign(new Error('请求已断开'), { code: 'aborted' }));
    };
    signal?.addEventListener('abort', job.onAbort, { once: true });
    waiting.push(job);
    pump();
  }).then(({ png }) => Buffer.from(png.buffer, png.byteOffset, png.byteLength));
}

function pump() {
  for (const slot of slots) {
    while (!slot.job && waiting.length) start(slot, waiting.shift());
  }
}

function start(slot, job) {
  job.signal?.removeEventListener('abort', job.onAbort);
  try {
    slot.thread ??= startThread(slot);
  } catch (err) {
    return job.reject(unreadable(err.message));
  }
  slot.job = job;
  slot.thread.ref(); // 有任务时线程拉住进程，空闲时不拉
  job.timer = setTimeout(() => {
    const stuck = slot.thread;
    slot.thread = null;
    finish(slot, new ImageError('参考图太大或太复杂，处理超时了，请换一张小一点的图'));
    stuck.terminate();
  }, JOB_TIMEOUT_MS);
  // 复制一份正好大小的交给线程（Buffer 可能只是一大块内存里的一段，直接传会把整块都复制过去）
  const copy = new Uint8Array(job.bytes);
  job.bytes = null;
  slot.thread.postMessage({ ...job.message, bytes: copy }, [copy.buffer]);
}

function finish(slot, err, result) {
  const { job } = slot;
  slot.job = null;
  clearTimeout(job.timer);
  if (err) job.reject(err);
  else job.resolve(result);
  if (!waiting.length) slot.thread?.unref();
  pump();
}

function startThread(slot) {
  const thread = new Worker(new URL('./imageThread.js', import.meta.url));
  thread.on('message', (reply) => {
    if (slot.thread !== thread || !slot.job) return;
    if (!reply.error) return finish(slot, null, reply);
    finish(slot, reply.imageError ? new ImageError(reply.error) : unreadable(reply.error));
  });
  // 线程崩了（比如内存不够）：这一张算失败，后面的换新线程
  const crashed = (reason) => {
    if (slot.thread !== thread) return;
    slot.thread = null;
    if (slot.job) finish(slot, unreadable(reason));
  };
  thread.on('error', (err) => crashed(err.message));
  thread.on('exit', (code) => crashed(`线程退出（${code}）`));
  return thread;
}

function unreadable(reason) {
  return new ImageError('参考图解不开，请换一张 PNG 或 JPEG', { cause: reason });
}
