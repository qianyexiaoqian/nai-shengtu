import { linkAiCall, optimizePrompt, wantsAi } from './aiPrompt.js';
import { HttpError } from './http.js';
import { saveImage } from './imageStore.js';
import { assertQuota, keyAllowsAi, reserveQuota } from './keys.js';
import { resolveModel } from './models.js';
import { sizeForImage, toUpstreamPayload } from './params.js';
import { assistPrompt } from './promptAssist.js';
import { loadReferenceImage } from './refImage.js';
import { generateImages, plannedImages, prepareReference, servableError } from './upstream.js';
import { accountOf } from './upstreamKeys.js';
import { recordCall } from './usage.js';

/** 0～0.99 之间的比例，保留两位小数；没给或不是数字用默认值 */
function ratio(value, fallback, min) {
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(0.99, Math.max(min, n)) * 100) / 100;
}

const noTagsError = (unmatched) =>
  new HttpError(400, `提示词里的中文没能识别成标签（${unmatched.join('、')}），换个说法或直接写英文标签`, {
    param: 'prompt',
  });

/**
 * chat 和 images 两个接口共用的出图流程，分两步：
 * prepare 同步做完模型解析、中文转标签 / 英文纠错、参数合成和额度检查（出错时还没开始流式输出，能按正常状态码返回）；
 * execute 需要的话先调 AI 优化提示词，再调上游、记日志估算扣点、登记图片 UUID。
 * reference 是图生图的参考图 { input, param }：input 是调用方给的原样（data URI、base64、链接或文件内容），
 * param 是出错时指给调用方的字段；没有就是文生图。参考图在 execute 里读，额度和上游检查过了再下载、解析。
 */
export function prepareGeneration(ctx, endpoint, body, prompt, params, reference = null) {
  const model = resolveModel(body.model);
  // 提示词里的 --ai / --noai 优先，其次请求体的 ai_optimize；后台给这把密钥关了 AI 优化的，都不走
  const override = params.ai ?? (typeof body.ai_optimize === 'boolean' ? body.ai_optimize : undefined);
  const useAi = keyAllowsAi(ctx.key) && wantsAi(prompt, override, model.id);
  const assist = assistPrompt(prompt);
  if (!assist.prompt && !useAi) throw noTagsError(assist.unmatched);
  const payload = toUpstreamPayload(body, assist.prompt, params, model.upstream);
  if (payload.negative_prompt) {
    payload.negative_prompt = assistPrompt(payload.negative_prompt).prompt;
    if (!payload.negative_prompt) delete payload.negative_prompt;
  }
  if (reference) {
    // 图生图：强度默认 0.7、加噪默认 0（官方网页端的默认值）；参考图本身在 execute 里读进 image
    payload.img2img = {
      image: null,
      strength: ratio(params.strength ?? body.strength, 0.7, 0.01),
      noise: ratio(params.noise ?? body.noise, 0, 0),
    };
  }
  // 额度按实际会出的张数算：官方秘钥一次只出 1 张的话，要 4 张也只占 1 张
  assertQuota(ctx.key, plannedImages(payload));
  return { ctx, endpoint, model, payload, prompt, assist, useAi, ai: null, reference };
}

/**
 * AI 优化提示词：把本地词典识别出的标签一起发过去做参考，AI 写回来的标签再过一遍中文转换和英文纠错，
 * NAI4 以后的模型再接上 AI 写的短句（位置、互动、主体大小、光照这些标签说不清的）。
 * AI 失败（没配好、超时、报错）就用词典转换的结果照常出图，原因记在后台的 AI 调用记录里。
 */
async function applyAi(job) {
  try {
    const hints = job.assist.converted || job.assist.fixes.length ? job.assist.prompt : '';
    const result = await optimizePrompt(job.prompt, {
      hints, source: job.endpoint, key: job.ctx.key, targetModel: job.model.upstream,
    });
    const checked = assistPrompt(result.prompt);
    if (checked.prompt) {
      job.payload.prompt = result.sentences ? `${checked.prompt}, ${result.sentences}` : checked.prompt;
      job.ai = { callId: result.callId, cost: result.cost };
      return;
    }
  } catch {
    // 已经记在 ai_calls 里了，这里回退到词典转换
  }
  if (!job.payload.prompt) throw noTagsError(job.assist.unmatched);
}

export async function executeGeneration(job) {
  const { ctx, endpoint, model, payload, prompt } = job;
  let startedAt = Date.now();
  const call = {
    key: ctx.key,
    endpoint,
    model,
    prompt,
    size: payload.size ?? '1024x1024', // 上游默认尺寸
    n: payload.n ?? 1,
    ip: ctx.ip,
    img2img: payload.img2img?.strength ?? null,
  };
  const logError = (err) => {
    const { logId } = recordCall({
      ...call,
      finalPrompt: payload.prompt,
      ...appliedOf(err.applied, false),
      ...upstreamOf(err.upstreamKey),
      status: 'error',
      error: err.internal ?? err.message,
      durationMs: Date.now() - startedAt,
      queueMs: err.queueMs,
    });
    linkAiCall(job.ai?.callId, logId);
    return err;
  };

  // 额度按库里最新的已用张数加上正在出图、排队中的占住，出完记了账再放开（不然排队的请求都能过额度检查）
  const release = reserveQuota(ctx.key, plannedImages(payload));
  try {
    // 先看现在有没有上游接得了（比如免费额度用完、参数太大），免得白花 AI 优化的钱，也免得聊天流开始了才报错
    const unservable = servableError(payload);
    if (unservable) throw logError(unservable);
    if (job.reference) {
      try {
        await attachReference(job);
      } catch (err) {
        throw logError(err);
      }
      call.size = payload.size;
    }
    if (job.useAi) {
      await applyAi(job);
      startedAt = Date.now(); // 耗时只算排队和出图，AI 优化的时间记在 AI 调用记录里
    }

    let result;
    try {
      result = await generateImages(payload, {
        signal: ctx.signal,
        info: {
          caller: ctx.key.name, endpoint, model: model.id, prompt: String(payload.prompt).slice(0, 200),
          img2img: payload.img2img?.strength ?? null,
        },
      });
    } catch (err) {
      throw logError(err);
    }

    const { body, upstreamKey, applied } = result;
    const items = body.data.filter((item) => item?.url || item?.b64_json);
    const { logId } = recordCall({
      ...call,
      finalPrompt: payload.prompt,
      ...appliedOf(applied, true),
      ...upstreamOf(upstreamKey),
      status: 'success',
      images: items.length,
      durationMs: Date.now() - startedAt,
      queueMs: result.queueMs,
    });
    linkAiCall(job.ai?.callId, logId);
    return {
      model,
      created: body.created ?? Math.floor(Date.now() / 1000),
      images: items.map((item) => saveImage(item, logId)),
      adjusted: applied?.changes ?? [],
      seed: applied?.seed,
      img2img: payload.img2img
        ? { width: payload.img2img.image.width, height: payload.img2img.image.height, strength: payload.img2img.strength, size: applied?.size }
        : null,
    };
  } finally {
    release();
  }
}

/**
 * 图生图：读参考图（下载或解码 base64，只看文件头拿宽高），没写尺寸的按参考图的比例出约 1024×1024，
 * 再在图片线程里按出图尺寸缩放好。解不开的图在这里报 400：不白花 AI 优化的钱，也不占着上游秘钥等。
 */
async function attachReference(job) {
  const { ctx, payload, reference } = job;
  const image = await loadReferenceImage(reference.input, reference.param, ctx.signal);
  payload.img2img.image = image;
  payload.size ??= sizeForImage(image.width, image.height);
  await prepareReference(payload, ctx.signal);
}

const upstreamOf = (row) => (row ? { upstreamKeyId: row.id, account: accountOf(row) } : {});
// 按上游秘钥的出图上限压过的话，日志和扣点估算按实际发出去的尺寸、张数算；官方秘钥出成了才记估算的 Anlas
const appliedOf = (applied, success) => (applied
  ? {
    size: applied.size,
    n: applied.n,
    adjusted: applied.changes.join('，') || null,
    anlas: success && Number.isFinite(applied.anlas) ? applied.anlas : null,
  }
  : {});
