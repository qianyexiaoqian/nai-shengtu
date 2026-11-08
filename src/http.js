import { config } from './config.js';
import { getSettings } from './settings.js';

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-correlation-id',
};

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export class HttpError extends Error {
  /** internal：只写进调用日志给管理员看的原始原因（可能含上游信息），不返回给调用方 */
  constructor(status, message, { type = 'invalid_request_error', code = null, param = null, internal } = {}) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
    this.internal = internal;
  }
}

/** OpenAI 标准错误体 */
export function errorBody(err) {
  return {
    error: {
      message: err.message,
      type: err.type ?? 'server_error',
      param: err.param ?? null,
      code: err.code ?? null,
    },
  };
}

export function sendJson(res, status, body) {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  if (!(err instanceof HttpError)) {
    err = new HttpError(500, `中继内部错误：${err.message}`, { type: 'server_error' });
  }
  sendJson(res, err.status, errorBody(err));
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  return parseJsonObject((await readBody(req)).toString('utf8'));
}

export function parseJsonObject(text) {
  let body;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return body;
}

export function bearerToken(req) {
  const match = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '');
  if (!match) {
    throw new HttpError(401, '缺少 Authorization: Bearer sk-... 请求头', {
      type: 'authentication_error',
      code: 'missing_api_key',
    });
  }
  return match[1];
}

const firstValue = (value) => String(value ?? '').split(',')[0].trim();

/** 中继对外的根地址（不带 /v1），优先用后台设置的对外地址，否则按调用方访问用的地址推断 */
export function requestBaseUrl(req) {
  return getSettings().publicBaseUrl || inferredBaseUrl(req);
}

/**
 * 调用方用 http://服务器IP:端口 访问，就得到这个 IP 和端口；经反代用域名访问，就得到域名
 * （反代需要传 Host 或 X-Forwarded-Host、X-Forwarded-Proto）。
 */
export function inferredBaseUrl(req) {
  const proto = firstValue(req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
  const host = firstValue(req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

export function clientIp(req) {
  return firstValue(req.headers['x-forwarded-for']) || req.socket.remoteAddress || '';
}
