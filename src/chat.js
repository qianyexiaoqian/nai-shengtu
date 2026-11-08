import { randomUUID } from 'node:crypto';
import { executeGeneration, prepareGeneration } from './generate.js';
import { CORS_HEADERS, HttpError, errorBody, sendJson } from './http.js';
import { imageBase64, publicImageUrl } from './imageStore.js';
import { parsePromptText } from './params.js';
import { getSettings } from './settings.js';

const KEEPALIVE_MS = 8_000;
const ZERO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/**
 * POST /v1/chat/completions —— 香蕉生图式的聊天生图。
 * 取最后一条 user 消息的文字当提示词，生成后把图片以 Markdown 图片放进 assistant 回复。
 */
export async function handleChat(res, body, ctx) {
  const { prompt, params } = parsePromptText(lastUserText(body.messages));
  if (!prompt) {
    throw new HttpError(400, '最后一条 user 消息里没有找到提示词', { param: 'messages' });
  }
  const job = prepareGeneration(ctx, 'chat', body, prompt, params);
  const meta = {
    id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
    created: Math.floor(Date.now() / 1000),
    model: job.model.id,
  };

  if (body.stream) {
    return streamChat(res, meta, job, Boolean(body.stream_options?.include_usage));
  }
  const content = await generateContent(job);
  sendJson(res, 200, {
    ...meta,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: ZERO_USAGE,
  });
}

async function streamChat(res, meta, job, includeUsage) {
  const chunk = (delta, finishReason = null) => ({
    ...meta,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const write = (data) => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 生图通常几秒就好，先不发响应头，鉴权、参数这类错误还能按正常 HTTP 状态码返回；
  // 超过 KEEPALIVE_MS 还在排队才开始 SSE，并定期发空 delta，防止客户端或反代超时断开。
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    write(chunk({ role: 'assistant', content: '' }));
  };
  const timer = setInterval(() => (started ? write(chunk({ content: '' })) : start()), KEEPALIVE_MS);

  try {
    const content = await generateContent(job);
    start();
    write(chunk({ content }));
    write(chunk({}, 'stop'));
    if (includeUsage) write({ ...meta, object: 'chat.completion.chunk', choices: [], usage: ZERO_USAGE });
  } catch (err) {
    if (!started) throw err; // 还没开始流，交给外层按 JSON 错误返回
    write(errorBody(err instanceof HttpError ? err : new HttpError(500, err.message, { type: 'server_error' })));
  } finally {
    clearInterval(timer);
  }
  res.end('data: [DONE]\n\n');
}

async function generateContent(job) {
  const { images } = await executeGeneration(job);
  const { chatImageMode, promptEcho } = getSettings();
  const sources = await Promise.all(
    images.map(async (image) => {
      if (chatImageMode !== 'b64') return publicImageUrl(image, job.ctx.baseUrl);
      const { mime, b64 } = await imageBase64(image);
      return `data:${mime};base64,${b64}`;
    }),
  );
  let content = sources.map((src) => `![image](${src})`).join('\n\n');
  // AI 优化过、中文被转换、或英文被纠正时，把实际用的提示词告诉用户，方便照着改
  const { converted, fixes, unmatched } = job.assist;
  if (promptEcho && job.ai) {
    content += `\n\n> 提示词（AI 优化）：${job.payload.prompt}`;
  } else if (promptEcho && (converted || fixes.length)) {
    content += `\n\n> 提示词：${job.payload.prompt}`;
    if (fixes.length) content += `\n> 已修正：${fixes.map((f) => `${f.from} → ${f.to}`).join('，')}`;
    if (unmatched.length) content += `\n> 未识别：${unmatched.join('、')}`;
  }
  return content;
}

// 只取最后一条 user 消息里的文字；图片部分忽略（上游 OpenAI 兼容接口不支持图生图）
function lastUserText(messages) {
  if (!Array.isArray(messages)) {
    throw new HttpError(400, 'messages 必须是数组', { param: 'messages' });
  }
  const content = messages.findLast((m) => m?.role === 'user')?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}
