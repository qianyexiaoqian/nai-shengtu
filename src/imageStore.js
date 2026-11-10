import { randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { db } from './db.js';
import { CORS_HEADERS, HttpError } from './http.js';
import { getSettings } from './settings.js';
import { fetchImageBase64 } from './upstream.js';

// 对外一律给 <中继地址>/v1/img/<uuid>.png，看不出上游：
// 上游给链接的只把链接存在库里，访问时由中继代拉；上游直接给 b64_json 的存成数据目录下的文件。
// 链接有效期按后台设置（默认 7 天），过期的记录和文件定时清掉。
const IMAGE_DIR = config.dataDir === ':memory:' ? join(tmpdir(), 'nai-relay-images') : join(config.dataDir, 'images');
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** 登记上游返回的一张图片（data[] 里的一项），返回 { id, ext, url } 或 { id, ext, mime, b64 } */
export function saveImage(item, logId) {
  const id = randomUUID();
  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO images (id, upstream_url, file, mime, log_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const expiresAt = now + getSettings().imageTtlDays * 86_400_000;
  // 有的上游把 data URI 放在 url 字段里，按 base64 处理
  if (item.url && !/^data:/i.test(item.url)) {
    insert.run(id, item.url, null, null, logId, now, expiresAt);
    return { id, url: item.url, ext: urlExt(item.url) };
  }
  const data = Buffer.from(String(item.b64_json ?? item.url).replace(/^data:[^,]*,/i, ''), 'base64');
  const mime = sniffMime(data);
  const file = `${id}.${MIME_EXT[mime]}`;
  mkdirSync(IMAGE_DIR, { recursive: true });
  writeFileSync(join(IMAGE_DIR, file), data);
  insert.run(id, '', file, mime, logId, now, expiresAt);
  return { id, ext: MIME_EXT[mime], mime, b64: data.toString('base64') };
}

export const publicImageUrl = ({ id, ext }, baseUrl) => `${baseUrl}/v1/img/${id}.${ext}`;

/** 要 base64 的地方（聊天内嵌图片、images 接口的 b64_json）：上游给的是链接就下载下来 */
export const imageBase64 = (image) => (image.b64 ? { mime: image.mime, b64: image.b64 } : fetchImageBase64(image.url));

/** 中继存的图（/v1/img/<uuid>）的原始字节，拿来做图生图的参考图：本地文件直接读，上游链接去拉；没有或过期返回 null */
export async function storedImageBytes(id) {
  const row = db.prepare('SELECT upstream_url, file, expires_at FROM images WHERE id = ?').get(String(id).toLowerCase());
  if (!row || row.expires_at < Date.now()) return null;
  if (row.file) return readFileSync(join(IMAGE_DIR, row.file));
  const { b64 } = await fetchImageBase64(row.upstream_url);
  return Buffer.from(b64, 'base64');
}

export function purgeExpiredImages() {
  const now = Date.now();
  for (const { file } of db.prepare('SELECT file FROM images WHERE expires_at < ? AND file IS NOT NULL').all(now)) {
    rmSync(join(IMAGE_DIR, file), { force: true });
  }
  return db.prepare('DELETE FROM images WHERE expires_at < ?').run(now).changes;
}

/** GET /v1/img/<uuid> —— 存在本地的直接发文件；链接的代拉上游图片，只回自己的响应头，不透传上游的 Server、ETag 等 */
export async function handleImageProxy(res, id) {
  const row = db.prepare('SELECT upstream_url, file, mime, expires_at FROM images WHERE id = ?').get(id.toLowerCase());
  if (!row || row.expires_at < Date.now()) {
    throw new HttpError(404, '图片不存在或已过期', { code: 'not_found' });
  }
  const cacheControl = `public, max-age=${Math.max(0, Math.floor((row.expires_at - Date.now()) / 1000))}`;
  if (row.file) return sendFile(res, row, cacheControl);

  let upstream;
  try {
    // PNG 再压缩没意义，要原始数据才能带上 Content-Length
    upstream = await fetch(row.upstream_url, {
      headers: { 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.warn(`图片拉取失败：${err.cause?.message || err.message}`);
    throw new HttpError(502, '图片获取失败，请稍后重试', { type: 'server_error' });
  }
  if (!upstream.ok || !upstream.body) {
    throw new HttpError(upstream.status === 404 ? 404 : 502, '图片不存在或已过期', { type: 'server_error' });
  }

  const headers = {
    ...CORS_HEADERS,
    'Content-Type': upstream.headers.get('content-type') || 'image/png',
    'Cache-Control': cacheControl,
  };
  const length = upstream.headers.get('content-length');
  if (length && !upstream.headers.get('content-encoding')) headers['Content-Length'] = length;
  res.writeHead(200, headers);
  await pipeline(Readable.fromWeb(upstream.body), res).catch(() => res.destroy());
}

async function sendFile(res, row, cacheControl) {
  const path = join(IMAGE_DIR, row.file);
  let size;
  try {
    size = statSync(path).size;
  } catch {
    throw new HttpError(404, '图片不存在或已过期', { code: 'not_found' });
  }
  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': row.mime, 'Content-Length': size, 'Cache-Control': cacheControl });
  await pipeline(createReadStream(path), res).catch(() => res.destroy());
}

function urlExt(url) {
  try {
    return /\.(png|jpe?g|webp|gif)$/i.exec(new URL(url).pathname)?.[1].toLowerCase() ?? 'png';
  } catch {
    return 'png';
  }
}

/** 按文件头认图片格式，认不出当 PNG */
function sniffMime(data) {
  if (data.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (data.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return 'image/png';
}
