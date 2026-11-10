import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { HttpError } from './http.js';
import { ImageError, imageInfo } from './imageCodec.js';
import { storedImageBytes } from './imageStore.js';

// 图生图的参考图：调用方可以给 data URI、裸 base64、图片链接或者文件。中继自己的 /v1/img/<uuid> 链接直接从库里取；
// 别的链接由中继去下载，连接时检查解析出的 IP，内网、本机、云厂商元数据这些地址一律不连（防 SSRF，也防 DNS 换绑）。
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const RELAY_IMAGE_RE = /\/img\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.\w+)?$/i;

/**
 * 参考图 → { bytes, width, height }：只读文件头确认是 PNG / JPEG、拿宽高（按 EXIF 转正后的），原图字节留着，
 * 之后在图片线程里按出图尺寸缩放（imageJobs.js 的 coverPng，数据损坏那时才报）。
 * param 是报错时指给调用方的字段名；signal 断开时不再下载。
 */
export async function loadReferenceImage(input, param = 'image', signal) {
  let bytes;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    bytes = Buffer.from(input);
  } else if (typeof input === 'string' && input.trim()) {
    const text = input.trim();
    if (/^data:/i.test(text)) bytes = fromDataUri(text, param);
    else if (/^https?:\/\//i.test(text)) bytes = await fromUrl(text, param, signal);
    else bytes = fromBase64(text, param);
  } else {
    throw new HttpError(400, '参考图格式不对：要 data URI、base64 或者图片链接', { param, code: 'invalid_image' });
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new HttpError(400, `参考图太大，最多 ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, { param, code: 'invalid_image' });
  }
  try {
    const { width, height } = imageInfo(bytes);
    return { bytes, width, height };
  } catch (err) {
    if (err instanceof ImageError) throw new HttpError(400, err.message, { param, code: 'invalid_image' });
    throw new HttpError(400, '参考图解不开，请换一张 PNG 或 JPEG', { param, code: 'invalid_image', internal: err.message });
  }
}

function fromDataUri(text, param) {
  const match = /^data:[^,]*?(;base64)?,(.*)$/is.exec(text);
  if (!match?.[1]) throw new HttpError(400, '参考图的 data URI 要用 base64 编码', { param, code: 'invalid_image' });
  return fromBase64(match[2], param);
}

function fromBase64(text, param) {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) {
    throw new HttpError(400, '参考图格式不对：要 data URI、base64 或者图片链接', { param, code: 'invalid_image' });
  }
  if (clean.length > (MAX_IMAGE_BYTES * 4) / 3 + 4) {
    throw new HttpError(400, `参考图太大，最多 ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, { param, code: 'invalid_image' });
  }
  return Buffer.from(clean, 'base64');
}

async function fromUrl(text, param, signal) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, '参考图链接不对', { param, code: 'invalid_image' });
  }
  // 之前出的图再拿来图生图：中继自己的链接，直接从库里取（过期了就当链接打不开）
  const own = RELAY_IMAGE_RE.exec(url.pathname);
  if (own) {
    const stored = await storedImageBytes(own[1]).catch(() => null);
    if (stored) return stored;
  }
  return download(url, param, MAX_REDIRECTS, signal);
}

// 不连的 IPv4 段：本机、内网、CGNAT、链路本地（含云厂商的 169.254.169.254 元数据）、保留段、组播
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
];
const BLOCKED = new BlockList();
for (const [net, prefix] of BLOCKED_V4) {
  BLOCKED.addSubnet(net, prefix, 'ipv4'); // ::ffff: 映射地址 BlockList 自己按 IPv4 规则查
  const hex = net.split('.').map(Number).reduce((a, b) => a * 256 + b, 0).toString(16).padStart(8, '0');
  const v4 = `${hex.slice(0, 4)}:${hex.slice(4)}`;
  BLOCKED.addSubnet(`64:ff9b::${v4}`, 96 + prefix, 'ipv6'); // NAT64 里内嵌的
  BLOCKED.addSubnet(`2002:${v4}::`, 16 + prefix, 'ipv6'); // 6to4 里内嵌的
}
for (const [net, prefix] of [
  ['::', 96], // 未指定、本机、旧的 IPv4 兼容写法
  ['64:ff9b:1::', 48], // 本地用的 NAT64
  ['100::', 64], // 丢弃
  ['2001::', 32], // Teredo（内嵌的 IPv4 看不出来，整段不连）
  ['fc00::', 7], // 唯一本地
  ['fe80::', 10], // 链路本地
  ['fec0::', 10], // 站点本地（已废弃）
  ['ff00::', 8], // 组播
]) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** 这些地址不连：本机、内网、链路本地、组播、保留地址，以及 IPv6 里内嵌了这些 IPv4 的各种写法 */
export function blockedAddress(address) {
  const ip = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  const type = isIP(ip);
  return !type || BLOCKED.check(ip, type === 4 ? 'ipv4' : 'ipv6');
}

const blockedError = (param) => new HttpError(400, '参考图链接不能指向内网或本机地址', { param, code: 'invalid_image' });

/** http(s) 的 lookup：解析出的地址只要有一个是内网就不连。连接时才检查，DNS 换绑也绕不过去 */
function safeLookup(param) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses.length || addresses.some((a) => blockedAddress(a.address))) return callback(blockedError(param));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function download(url, param, redirectsLeft, signal) {
  if (!/^https?:$/.test(url.protocol)) return Promise.reject(new HttpError(400, '参考图链接只能是 http 或 https', { param, code: 'invalid_image' }));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && blockedAddress(host)) return Promise.reject(blockedError(param));
  if (signal?.aborted) return Promise.reject(closedError());
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      reject(err instanceof HttpError
        ? err
        : new HttpError(400, '参考图链接下载失败，请换一个链接或直接传图片', { param, code: 'invalid_image', internal: err.message }));
    };
    // 调用方断开了就不下了
    const onAbort = () => {
      req.destroy();
      fail(closedError());
    };
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      lookup: safeLookup(param),
      headers: { 'User-Agent': 'nai-relay', Accept: 'image/*' },
    }, (res) => {
      // 跳转和出错的响应体不要，连接直接关掉（不然对方慢慢发，连接就一直挂着）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.on('error', () => {});
        req.destroy();
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        if (redirectsLeft <= 0) return fail(new HttpError(400, '参考图链接跳转太多次', { param, code: 'invalid_image' }));
        let next;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          return fail(new Error('bad redirect'));
        }
        return download(next, param, redirectsLeft - 1, signal).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.on('error', () => {});
        req.destroy();
        return fail(new HttpError(400, `参考图链接打不开（HTTP ${res.statusCode}）`, { param, code: 'invalid_image' }));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          req.destroy();
          fail(new HttpError(400, `参考图太大，最多 ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, { param, code: 'invalid_image' }));
        } else {
          chunks.push(chunk);
        }
      });
      res.on('end', () => {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        if (size <= MAX_IMAGE_BYTES) resolve(Buffer.concat(chunks));
      });
      res.on('error', fail);
    });
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), DOWNLOAD_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', fail);
  });
}

const closedError = () => new HttpError(499, '调用方已断开，取消下载参考图', { code: 'client_closed' });
