import { executeGeneration, prepareGeneration } from './generate.js';
import { CORS_HEADERS, HttpError, clientIp, closeSignal, parseJsonObject, readBody, requestBaseUrl, sendJson } from './http.js';
import { imageBase64 } from './imageStore.js';
import { authenticate } from './keys.js';
import { parsePromptText } from './params.js';
import { writeZip } from './zip.js';

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
// 文生图和图生图之外带图片的功能（局部重绘、Vibe、角色参考、ControlNet）中继不转；网页端 multipart 里的列表叫 *_cached
const IMAGE_FIELDS = ['mask', 'reference_image', 'controlnet_condition'];
const IMAGE_LIST_FIELDS = [
  'reference_image_multiple', 'director_reference_images', 'reference_image_multiple_cached', 'director_reference_images_cached',
];
const MAX_SEED = 4294967295 - 7;

/**
 * NovelAI 官方格式的出口，只会调 NovelAI 的客户端（能改接口地址的）可以直接接中继。
 * POST /ai/generate-image：请求体同官方 { input, model, action, parameters }，也认网页端 V5 用的 multipart（JSON 在 request 部分，图片各占一部分）。
 * action 支持 generate（文生图）和 img2img（图生图：parameters.image 是 base64，multipart 里写图片那部分的名字）。
 * 默认返回 ZIP（image_0.png …）；请求头 Accept 只写 application/json 时，按官方文档返回 { images: [{ image, index, seed }] }。
 * 鉴权一样是 Authorization: Bearer <中继调用密钥>，错误按官方格式 { statusCode, message }。
 * 和另外两个接口走同一套流程：模型映射、中文转标签、AI 优化、额度、记账、多上游轮询都照常。
 */
export async function handleNaiGenerate(req, res) {
  await withNaiErrors(res, async () => {
    const key = authenticate(req);
    const { body, parts } = await readNaiBody(req);
    const job = prepareNai({ key, baseUrl: requestBaseUrl(req), ip: clientIp(req), signal: closeSignal(res) }, body, parts);
    const { images, seed: sent } = await executeGeneration(job);
    const files = await Promise.all(images.map(imageBase64));
    if (acceptsOnlyJson(req.headers.accept)) {
      // 实际发给上游的种子（官方上游种子不合法时会换成随机的）
      const seed = Number.isInteger(sent) ? sent : job.payload.seed;
      return sendJson(res, 200, { images: files.map((f, i) => ({ image: f.b64, index: i, seed: seed + i })) });
    }
    const zip = writeZip(files.map((f, i) => ({ name: `image_${i}.${MIME_EXT[f.mime] ?? 'png'}`, data: Buffer.from(f.b64, 'base64') })));
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/zip', 'Content-Length': zip.length });
    res.end(zip);
  });
}

/**
 * GET /user/subscription：NovelAI 客户端连接时查订阅和 Anlas。按 Opus 回，
 * Anlas 填这把调用密钥剩下的额度（张数），不限额度的填 999999。
 */
export async function handleNaiSubscription(req, res) {
  await withNaiErrors(res, async () => {
    const key = authenticate(req);
    const left = key.quota_images > 0 ? Math.max(0, key.quota_images - key.used_images) : 999999;
    sendJson(res, 200, {
      tier: 3,
      active: true,
      expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400,
      isGracePeriod: false,
      accountType: 0,
      perks: {
        maxPriorityActions: 1000,
        startPriority: 10,
        moduleTrainingSteps: 0,
        unlimitedMaxPriority: true,
        contextTokens: 8192,
        imageGeneration: true,
        unlimitedImageGeneration: true,
      },
      trainingStepsLeft: { fixedTrainingStepsLeft: left, purchasedTrainingSteps: 0 },
    });
  });
}

/**
 * 官方请求 → 中继的出图任务。客户端已经按网页端拼好了质量词和负面预设，参数放进 payload.nai 原样带给官方上游；
 * 接的是 OpenAI 兼容上游时只转提示词、负面、尺寸、张数、步数这些通用参数（这种上游不能图生图）。
 * 图生图的参考图由中继按实际出图尺寸重新缩放（客户端一般已经缩好了），strength / noise 没写照官方默认 0.7 / 0。
 * parts 是 multipart 请求里 request 以外的部分（名字 → 内容）。
 */
export function prepareNai(ctx, body, parts = null) {
  const params = body.parameters && typeof body.parameters === 'object' ? body.parameters : {};
  const action = body.action ?? 'generate';
  if (action !== 'generate' && action !== 'img2img') {
    const what = action === 'infill' ? '局部重绘（infill）' : `action: ${action}`;
    throw new HttpError(400, `暂不支持${what}，只能文生图（generate）和图生图（img2img）`, { param: 'action' });
  }
  const withImages = [
    ...IMAGE_FIELDS.filter((f) => params[f]),
    ...IMAGE_LIST_FIELDS.filter((f) => Array.isArray(params[f]) && params[f].length),
  ];
  if (withImages.length) {
    throw new HttpError(400, `暂不支持局部重绘、Vibe 和角色参考（${withImages.join('、')}），只能文生图和图生图`);
  }
  if (action === 'generate' && params.image) {
    throw new HttpError(400, '带了参考图（parameters.image）的请求 action 要写 img2img', { param: 'action' });
  }

  const input = typeof body.input === 'string' ? body.input : String(params.v4_prompt?.caption?.base_caption ?? params.prompt ?? '');
  const { prompt, params: inline } = parsePromptText(input);
  if (!prompt) throw new HttpError(400, 'input 不能为空', { param: 'input' });
  const reference = action === 'img2img' ? { input: referenceOf(params.image, parts), param: 'image' } : null;
  // 种子先定下来，返回 JSON 时要告诉客户端
  const seed = Number.isInteger(params.seed) && params.seed >= 0 && params.seed <= MAX_SEED
    ? params.seed
    : Math.floor(Math.random() * MAX_SEED);
  const job = prepareGeneration(ctx, 'novelai', {
    model: body.model,
    negative_prompt: params.negative_prompt ?? params.v4_negative_prompt?.caption?.base_caption ?? params.uc,
    n: params.n_samples,
    steps: params.steps,
    scale: params.scale,
    sampler: params.sampler,
    seed,
    noise_schedule: params.noise_schedule,
    strength: params.strength,
    noise: params.noise,
    size: params.width && params.height ? `${params.width}x${params.height}` : undefined,
  }, prompt, inline, reference);
  // 参考图中继自己缩放后放进请求，客户端给的原样不带
  const { image: _image, image_cache_secret_key: _cacheKey, ...rest } = params;
  job.payload.nai = { enhanced: true, parameters: rest };
  return job;
}

/** 图生图的参考图：JSON 请求里 parameters.image 是 base64；multipart（网页端 V5）里是图片那一部分的名字 */
function referenceOf(image, parts) {
  if (typeof image !== 'string' || !image) {
    throw new HttpError(400, '图生图要带参考图（parameters.image）', { param: 'image' });
  }
  const part = parts?.get(image);
  if (part) return part;
  if (parts && /^[\w-]{1,64}$/.test(image)) {
    throw new HttpError(400, `multipart 请求里没有名为 ${image} 的图片部分`, { param: 'image' });
  }
  return image;
}

/** 请求体：JSON，或网页端的 multipart（JSON 在 request 部分，图片各占一部分、按名字引用）。返回 { body, parts } */
async function readNaiBody(req) {
  const raw = await readBody(req);
  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data/i.test(type)) return { body: parseJsonObject(raw.toString('utf8')), parts: null };
  let form;
  try {
    form = await new Response(raw, { headers: { 'Content-Type': type } }).formData();
  } catch {
    throw new HttpError(400, 'multipart 请求体格式不对');
  }
  const part = form.get('request');
  if (part == null) throw new HttpError(400, 'multipart 请求里没有 request 部分');
  const parts = new Map();
  for (const [name, value] of form) {
    if (name === 'request' || parts.has(name)) continue;
    parts.set(name, typeof value === 'string' ? value : Buffer.from(await value.arrayBuffer()));
  }
  return { body: parseJsonObject(typeof part === 'string' ? part : await part.text()), parts };
}

/** 只写了 application/json 才回 JSON；没写、写 * / * 或别的（比如 axios 默认那串）都回 ZIP，和官方老客户端一致 */
function acceptsOnlyJson(accept) {
  const types = String(accept ?? '').split(',').map((t) => t.split(';')[0].trim().toLowerCase()).filter(Boolean);
  return types.length > 0 && types.every((t) => t === 'application/json');
}

async function withNaiErrors(res, fn) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof HttpError)) {
      console.error(err);
      err = new HttpError(500, `中继内部错误：${err.message}`, { type: 'server_error' });
    }
    if (res.headersSent) return res.end();
    // 调用密钥额度用完，对应官方的 402（Anlas 不足）
    const status = err.code === 'insufficient_quota' ? 402 : err.status;
    sendJson(res, status, { statusCode: status, message: err.message });
  }
}
