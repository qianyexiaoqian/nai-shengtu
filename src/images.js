import { executeGeneration, prepareGeneration } from './generate.js';
import { HttpError, clientIp, closeSignal, parseJsonObject, readBody, requestBaseUrl, sendJson } from './http.js';
import { imageBase64, publicImageUrl } from './imageStore.js';
import { authenticate } from './keys.js';
import { parsePromptText } from './params.js';

/**
 * POST /v1/images/generations —— OpenAI Images 格式。
 * 在上游已有兼容的基础上补齐：空 prompt 拦截（上游不拦，会照样出图扣点）、
 * 真正的 b64_json 返回、dall-e / gpt-image 模型名映射、size=auto，图片地址换成中继的 UUID 链接。
 * 请求体里带了 image（data URI、base64 或链接）的按图生图出。
 */
export async function handleImages(res, body, ctx) {
  const image = imageField(body);
  await generate(res, body, ctx, image && { input: image, param: 'image' });
}

/**
 * POST /v1/images/edits —— OpenAI 的图片编辑接口，这里当图生图：multipart（image / image[] 是文件）或者 JSON
 * （image 或 images[0].image_url 给 data URI、base64、链接）。带 mask 的是局部重绘，暂不支持。
 * 自己鉴权、读请求体（要认 multipart），错误照样按 OpenAI 格式回。
 */
export async function handleImageEdits(req, res) {
  const ctx = { key: authenticate(req), baseUrl: requestBaseUrl(req), ip: clientIp(req), signal: closeSignal(res) };
  const { body, files } = await readEditBody(req);
  if (files.mask || body.mask) {
    throw new HttpError(400, '暂不支持局部重绘（mask），只能整张图生图', { param: 'mask', code: 'unsupported_mask' });
  }
  const image = files.image ?? imageField(body);
  if (!image) throw new HttpError(400, '没有找到参考图（image）', { param: 'image' });
  await generate(res, body, ctx, { input: image, param: 'image' });
}

async function generate(res, body, ctx, reference) {
  const { prompt, params } = parsePromptText(typeof body.prompt === 'string' ? body.prompt : '');
  if (!prompt) throw new HttpError(400, 'prompt 不能为空', { param: 'prompt' });

  const job = prepareGeneration(ctx, 'images', body, prompt, params, reference);
  const { images, created } = await executeGeneration(job);

  // gpt-image 系列在 OpenAI 那边固定返回 b64_json，客户端不写 response_format 时照着来
  const wantB64 = body.response_format
    ? body.response_format === 'b64_json'
    : /^gpt-image/i.test(String(body.model ?? ''));
  // 提示词被 AI 优化、中文转换或英文纠正过时，用 OpenAI 的 revised_prompt 字段告诉调用方实际用的提示词
  const revised = job.ai || job.assist.changed ? { revised_prompt: job.payload.prompt } : {};
  const data = await Promise.all(
    images.map(async (image) => ({
      ...(wantB64 ? { b64_json: (await imageBase64(image)).b64 } : { url: publicImageUrl(image, ctx.baseUrl) }),
      ...revised,
    })),
  );
  sendJson(res, 200, { created, data });
}

/** JSON 里的参考图：image（字符串或数组）或 OpenAI 的 images: [{ image_url }] */
function imageField(body) {
  const first = Array.isArray(body.image) ? body.image[0] : body.image ?? (Array.isArray(body.images) ? body.images[0] : undefined);
  if (typeof first === 'string') return first || null;
  return first?.image_url?.url ?? first?.image_url ?? first?.url ?? first?.b64_json ?? null;
}

/** edits 的请求体：multipart 的文本字段当 JSON 字段用，image / image[] / mask 文件读成 Buffer */
async function readEditBody(req) {
  const raw = await readBody(req);
  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data/i.test(type)) return { body: parseJsonObject(raw.toString('utf8')), files: {} };
  let form;
  try {
    form = await new Response(raw, { headers: { 'Content-Type': type } }).formData();
  } catch {
    throw new HttpError(400, 'multipart 请求体格式不对');
  }
  const body = {};
  const files = {};
  for (const [name, value] of form) {
    const field = name.replace(/\[\]$/, '');
    if (typeof value === 'string') {
      body[field] ??= value;
    } else if (!files[field] && value.size > 0) {
      files[field] = Buffer.from(await value.arrayBuffer());
    }
  }
  return { body, files };
}
