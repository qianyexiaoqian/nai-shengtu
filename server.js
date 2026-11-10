import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { handleAdminApi, initAdminPassword } from './src/admin.js';
import { handleChat } from './src/chat.js';
import { config } from './src/config.js';
import { CORS_HEADERS, HttpError, clientIp, closeSignal, readJson, requestBaseUrl, sendError, sendJson } from './src/http.js';
import { handleImageProxy, purgeExpiredImages } from './src/imageStore.js';
import { handleImageEdits, handleImages } from './src/images.js';
import { authenticate } from './src/keys.js';
import { handleModels, seedModels } from './src/models.js';
import { handleNaiGenerate, handleNaiSubscription } from './src/naiApi.js';
import { startAccountRefresh } from './src/naiAccounts.js';
import { handlePromptApi } from './src/promptTools.js';
import { convertText, recommendArtists, relatedTags } from './src/tags.js';
import { candidateKeys, seedUpstreamKeys } from './src/upstreamKeys.js';

const ADMIN_PAGE = new URL('./public/admin.html', import.meta.url);
const PROMPT_PAGE = new URL('./public/prompt.html', import.meta.url);

const withKeyAndBody = (handler) => async (req, res) => {
  const ctx = { key: authenticate(req), baseUrl: requestBaseUrl(req), ip: clientIp(req), signal: closeSignal(res) };
  await handler(res, await readJson(req), ctx);
};

const routes = {
  'GET /models': (req, res) => handleModels(res),
  'POST /chat/completions': withKeyAndBody(handleChat),
  'POST /images/generations': withKeyAndBody(handleImages),
  // 图生图：OpenAI 的图片编辑接口（multipart 或 JSON，自己鉴权）
  'POST /images/edits': handleImageEdits,
  // NovelAI 官方格式，给只会调 NovelAI 的客户端用（自己鉴权，错误也按官方格式回）
  'POST /ai/generate-image': handleNaiGenerate,
  'GET /user/subscription': handleNaiSubscription,
};

const IMAGE_PATH_RE = /^\/img\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.\w+)?$/i;

async function servePage(res, page) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(await readFile(page));
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url, 'http://localhost');
  // /v1/chat/completions 和 /chat/completions 都认，客户端基础地址填不填 /v1 都能用
  const path = url.pathname.replace(/^\/v1(?=\/|$)/, '').replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    if (req.method === 'GET' && path === '/') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && path === '/admin') return await servePage(res, ADMIN_PAGE);
    if (path.startsWith('/admin/api/')) return await handleAdminApi(req, res, path.slice('/admin/api'.length), url.searchParams);
    if (req.method === 'GET' && path === '/prompt') return await servePage(res, PROMPT_PAGE);
    if (path.startsWith('/prompt/api/')) return await handlePromptApi(req, res, path.slice('/prompt/api'.length), url.searchParams);

    const image = req.method === 'GET' && IMAGE_PATH_RE.exec(path);
    if (image) return await handleImageProxy(res, image[1]);

    const route = routes[`${req.method} ${path}`];
    if (!route) throw new HttpError(404, `不支持的接口：${req.method} ${url.pathname}`, { code: 'not_found' });
    await route(req, res);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) res.end();
    else sendError(res, err);
  } finally {
    console.log(`${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} ${Date.now() - startedAt}ms`);
  }
});

initAdminPassword();
seedModels();
seedUpstreamKeys();
purgeExpiredImages();
// 官方秘钥的账号状态（Anlas、Opus 用量条）：启动时查一次，之后每 5 分钟查一次
startAccountRefresh();
setInterval(purgeExpiredImages, 3_600_000).unref();

/** 能访问到本服务的地址：监听 0.0.0.0 时列出本机所有 IPv4，否则就是监听的那个地址 */
function reachableHosts() {
  if (!['0.0.0.0', '::'].includes(config.host)) return [config.host];
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i?.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  return ['127.0.0.1', ...lan];
}

server.listen(config.port, config.host, () => {
  console.log(`NAI 中继已启动，监听端口 ${config.port}（API、图片链接、后台、提词器都在这一个端口上）`);
  for (const host of reachableHosts()) {
    console.log(`  API：http://${host}:${config.port}/v1（NovelAI 格式填 http://${host}:${config.port}）    后台：/admin    提词器：/prompt`);
  }
  if (!candidateKeys().length) console.warn('还没有可用的上游秘钥，请登录后台在“上游秘钥”页添加');
  // 标签库约 0.5 秒才加载完，启动后先加载，免得第一个请求卡一下
  setImmediate(() => {
    convertText('预热');
    relatedTags(['1girl']);
    recommendArtists(['1girl']);
  });
});
