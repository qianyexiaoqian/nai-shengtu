import { executeGeneration, prepareGeneration } from './generate.js';
import { HttpError, sendJson } from './http.js';
import { imageBase64, publicImageUrl } from './imageStore.js';
import { parsePromptText } from './params.js';

/**
 * POST /v1/images/generations —— OpenAI Images 格式。
 * 在上游已有兼容的基础上补齐：空 prompt 拦截（上游不拦，会照样出图扣点）、
 * 真正的 b64_json 返回、dall-e / gpt-image 模型名映射、size=auto，图片地址换成中继的 UUID 链接。
 */
export async function handleImages(res, body, ctx) {
  const { prompt, params } = parsePromptText(typeof body.prompt === 'string' ? body.prompt : '');
  if (!prompt) throw new HttpError(400, 'prompt 不能为空', { param: 'prompt' });

  const job = prepareGeneration(ctx, 'images', body, prompt, params);
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
