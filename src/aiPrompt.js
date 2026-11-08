// AI 提示词优化：调后台配置的 OpenAI 兼容接口（/chat/completions），把用户的描述改写成 NAI 提示词。
// 内置系统提示词借鉴 DanbooruSearchOnline 的 Anima 提示词规范（config/prompt_formats.yaml）里适用 NAI 的写法规则；
// 可选“让 AI 查标签库”：仿它的 MCP 工具，用 function calling 让 AI 边查中继内置标签库边写（见 aiTools.js）。
// 每次调用（含多轮工具调用）按接口返回的 usage 累加，按后台价格算成本，记进 ai_calls。
import { TOOL_DEFINITIONS, runTool } from './aiTools.js';
import { db } from './db.js';
import { HttpError } from './http.js';
import { getSettings } from './settings.js';
import { hasCjk } from './tags.js';
import { beijingDay } from './usage.js';

const REQUEST_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 75_000; // 工具模式多轮请求加起来
const MAX_TOKENS = 4000; // 思考模式下思考过程也算在里面；不思考时一次只用一两百
const MAX_ROUNDS = 5; // 工具模式最多请求几轮（最后一轮不许再调工具，必须给出结果）
const MAX_TOOL_CALLS = 12;

export const DEFAULT_SYSTEM_PROMPT = `You write prompts for NovelAI Diffusion (NAI), an anime image model trained on Danbooru tags. Turn the user's request (often in Chinese) into one NAI prompt.

## Output
- Line 1: English Danbooru tags in lowercase, spaces instead of underscores, separated by ", ".
- Line 2, only when the target model is NAI 4 or newer and only if it adds what tags cannot express (positions, who does what to whom, how large the subject is, how the subject is lit): 1 to 3 short plain English sentences.
- Nothing else: no explanation, quotes, markdown, headings or negative prompt.

## Tags
- Order: subject count (1girl, 2girls, 1girl, 1boy, no humans) → each character as "name (series)" followed by its series tag → artist:name only if the user asks for an artist → appearance (hair, eyes, body) → clothing and accessories → expression → pose and action → framing and camera (close-up, upper body, cowboy shot, full body, from above) → background and setting → lighting and atmosphere → art style.
- Use only real Danbooru tags. If you are not sure a tag exists, do not invent one: put the idea into line 2 (NAI 4+) or leave it out.
- Keep what the user already wrote as English tags, including weights ({tag}, [tag], 1.2::tag::) and artist:name, unless it conflicts with the final framing.
- Do not add quality tags (masterpiece, best quality, very aesthetic): the service adds them. Do not add NSFW tags unless the request clearly asks for them.
- Size: a simple scene 16-30 tags, a standard one 22-38, complex or multi-character scenes 30-48. Prefer the precise tag over a broad one, drop near-duplicates, at most two detail tags per body part.
- Emphasis only for what the user stresses, at most four tags: 1.1::tag:: to 1.5::tag:: on NAI 4+, {tag} on NAI 3. Emphasis never replaces framing or composition.

## Composition
- Pick one main subject. The character dominates the frame unless the user wants the scenery to dominate.
- Framing must match the tags: close-up keeps only face, hair, headwear and expression; upper body drops skirts, legs, socks and shoes; cowboy shot drops socks, shoes and feet; use full body only when the legs and shoes are really visible.
- Do not add foreground objects, weather, props, extra characters or drama that were not asked for. Requested weather and light should leave a visible effect (wet hair in rain, hair blowing in wind, rim light at sunset).
- Keep the subject clearly lit: a light behind the subject becomes rim lighting, not a silhouette, unless a silhouette is requested. Use dim lighting only when a dark mood is requested.

## Check before answering
- Resolve conflicts: close-up vs full body, from front vs from behind, looking at viewer vs looking away or facing away, solo vs several people, open mouth vs closed mouth, nude vs clothing.
- Gaze follows the action (reading means looking at the book). A portrait without a target may look at the viewer; with several characters, gaze follows their interaction.

## Several characters
- Use the exact count tags (2girls, or 1girl, 1boy); never solo, and never multiple girls when the number is known.
- List the character tags first, then keep each character's own hair, eyes, clothing and props together; never interleave the same kind of attribute across characters (not "blue hair, red hair, short hair, long hair").
- On NAI 4+, line 2 gives each character one sentence with a fixed position in the image ("On the left side of the image is ..., with ..."), then one sentence for the interaction that names who does what to whom. Shared attributes go in a "Both characters ..." sentence.`;

// 打开“让 AI 查标签库”时追加到系统提示词后面
const TOOL_GUIDE = `## Tag database tools
You can look up the Danbooru tag database:
- search_tags with mode "scene": converts the whole request into candidate tags. Call it first with the user's original text.
- search_tags with mode "lookup": checks tags you are unsure about, fixes spelling and deprecated tags, finds the right tag for a concept. Put several terms into one call, separated by commas.
- get_related_tags: tags that often go with the chosen ones, such as a character's signature hair, eyes and outfit.
- get_artist_recommendations: only when the user asks for an art style or artist.
Prefer tags confirmed by the tools; a tag you could not confirm goes into line 2 or is left out. Usually 1 to 3 tool calls are enough, then answer with the final prompt.`;

/** 后台填全了接口、秘钥、模型 */
export const aiConfigured = (s = getSettings()) => Boolean(s.aiBaseUrl && s.aiApiKey && s.aiModel);

/** 填全了并且没关掉 */
export const aiReady = (s = getSettings()) => s.aiMode !== 'off' && aiConfigured(s);

/** 对这个模型（对外名称）做不做 AI 优化：后台没限定模型时都做 */
export const aiAppliesTo = (modelId, s = getSettings()) => !s.aiApplyModels.length || s.aiApplyModels.includes(modelId);

/** NAI3 只认标签（CLIP 文本编码），NAI4 起能理解短句 */
export const isTagsOnlyModel = (upstreamModel) => /(diffusion|furry)-3$/.test(String(upstreamModel ?? ''));

/**
 * 这次要不要走 AI 优化。override：提示词里的 --ai / --noai 或请求体的 ai_optimize（true / false）；
 * modelId：请求的模型（对外名称），后台限定了生效的模型时，别的模型一律不优化，--ai 也不行。
 * auto 模式只在有中文、或有英文句子（某一条超过 4 个词）时优化，纯标签的提示词不花这个钱。
 */
export function wantsAi(prompt, override, modelId) {
  const s = getSettings();
  if (!aiReady(s) || override === false || !aiAppliesTo(modelId, s)) return false;
  if (override === true || s.aiMode === 'always') return true;
  return hasCjk(prompt) || String(prompt).split(/[,，\n]+/).some((item) => item.trim().split(/\s+/).length >= 5);
}

/**
 * 按接口返回的 usage 算成本（元）。兼容几种常见写法：OpenAI 的 prompt_tokens_details.cached_tokens、
 * DeepSeek 的 prompt_cache_hit_tokens、Claude 转 OpenAI 格式时的 cache_read / cache_creation_input_tokens。
 * 输入按 OpenAI 口径（prompt_tokens 含缓存部分），没命中缓存的部分按输入价算。
 */
export function usageCost(usage, prices) {
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  const input = n(usage?.prompt_tokens ?? usage?.input_tokens);
  const output = n(usage?.completion_tokens ?? usage?.output_tokens);
  const cacheRead = n(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? usage?.cache_read_input_tokens,
  );
  const cacheWrite = n(usage?.cache_creation_input_tokens ?? usage?.prompt_tokens_details?.cache_creation_tokens);
  const uncached = Math.max(0, input - cacheRead - cacheWrite);
  const cost = (uncached * prices.input + cacheRead * prices.cacheRead + cacheWrite * prices.cacheWrite
    + output * prices.output) / 1e6;
  return { input, output, cacheRead, cacheWrite, cost };
}

/**
 * 这一刻按什么价格算：开了“闲时半价”（DeepSeek 官方分时计价）且不在高峰时段就减半。
 * 高峰是北京时间工作日 9:00–12:00、14:00–18:00，其它时间（含周末）半价；法定节假日调休不管。
 */
export function priceNow(s, now = Date.now()) {
  if (!s.aiOffpeak) return s.aiPrices;
  const t = new Date(now + 8 * 3_600_000);
  const hour = t.getUTCHours();
  const peak = t.getUTCDay() >= 1 && t.getUTCDay() <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  return peak ? s.aiPrices : Object.fromEntries(Object.entries(s.aiPrices).map(([k, v]) => [k, v / 2]));
}

/**
 * 调 AI 把 text 改写成 NAI 提示词。
 * hints：本地词典已识别出的标签，作为参考一起发过去，减少瞎编；targetModel：目标上游模型（决定能不能写短句）；
 * source / key 用于记账；force 时不管开关（后台“测试”用，先测通再打开）。
 * 返回 { prompt（标签那一行）, sentences（NAI4+ 的短句，可能为空）, raw, usage, cost, callId, durationMs, rounds, toolCalls, note }；
 * 失败抛 HttpError（已记账，前面几轮的用量照算）。
 */
export async function optimizePrompt(text, { hints = '', source, key = null, force = false, targetModel } = {}) {
  const s = getSettings();
  if (!(force ? aiConfigured(s) : aiReady(s))) {
    throw new HttpError(503, 'AI 提示词优化没有开启或没有配置好', { code: 'ai_not_configured' });
  }
  const startedAt = Date.now();
  const tagsOnly = isTagsOnlyModel(targetModel);
  const systemPrompt = s.aiSystemPrompt || DEFAULT_SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: s.aiTools ? `${systemPrompt}\n\n${TOOL_GUIDE}` : systemPrompt },
    { role: 'user', content: userMessage(text, hints, tagsOnly) },
  ];
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  // 让模型思考（none 以外的强度）时不传 temperature，推理模型大多不认
  const thinking = Boolean(s.aiReasoningEffort) && s.aiReasoningEffort !== 'none';
  let useTools = s.aiTools;
  let rounds = 0;
  let toolCalls = 0;
  let note = null;
  let raw = '';
  const record = (fields) => recordAiCall({
    source, key, model: s.aiModel, prompt: text, durationMs: Date.now() - startedAt, usage: total, rounds, toolCalls, note,
    ...fields,
  });

  try {
    for (;;) {
      rounds++;
      const last = rounds >= MAX_ROUNDS || toolCalls >= MAX_TOOL_CALLS;
      const { res, body } = await request(s, {
        model: s.aiModel,
        messages,
        ...(thinking ? {} : { temperature: 0.4 }),
        max_tokens: MAX_TOKENS,
        stream: false,
        ...(s.aiReasoningEffort ? { reasoning_effort: s.aiReasoningEffort } : {}),
        ...(useTools ? { tools: TOOL_DEFINITIONS, tool_choice: last ? 'none' : 'auto' } : {}),
      }, startedAt + TOTAL_TIMEOUT_MS);
      addUsage(total, usageCost(body?.usage, priceNow(s)));

      if (!res.ok) {
        const detail = body?.error?.message || JSON.stringify(body)?.slice(0, 300) || '';
        // 模型或接口不支持工具调用：去掉工具，按普通方式重来一次
        if (useTools && rounds === 1 && /tool|function/i.test(detail)) {
          useTools = false;
          note = '这个模型或接口不支持工具调用，已按普通方式优化';
          messages[0].content = systemPrompt;
          rounds = 0;
          continue;
        }
        throw new Error(`AI 接口返回 HTTP ${res.status}：${detail}`);
      }

      const message = body?.choices?.[0]?.message ?? {};
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (useTools && calls.length && !last) {
        // DeepSeek 这类思考模式下调工具，要把这一轮的思考过程原样带回去，不然接口报错
        messages.push({
          role: 'assistant', content: message.content ?? null, tool_calls: calls,
          ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        });
        // 每个 tool_call 都要有一条对应的结果，超过次数上限的也要回一句
        for (const call of calls) {
          const allowed = toolCalls < MAX_TOOL_CALLS;
          if (allowed) toolCalls++;
          const output = allowed
            ? runTool(call.function?.name, call.function?.arguments)
            : { error: 'tool call limit reached, answer with the final prompt now' };
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
        }
        continue;
      }
      raw = messageText(message.content);
      break;
    }
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'AI 接口超时'
      : err.cause ? `连不上 AI 接口：${err.cause.message}` : err.message;
    record({ status: 'error', error: message, result: raw || null });
    throw new HttpError(502, message, { type: 'server_error', code: 'ai_failed' });
  }

  const { tags, sentences } = parseOutput(raw);
  if (!tags) {
    record({ status: 'error', error: 'AI 没有返回提示词', result: raw });
    throw new HttpError(502, 'AI 没有返回提示词', { type: 'server_error', code: 'ai_failed' });
  }
  const kept = tagsOnly ? '' : sentences;
  const callId = record({ status: 'success', result: kept ? `${tags}\n${kept}` : tags });
  return {
    prompt: tags, sentences: kept, raw, usage: total, cost: total.cost, callId,
    durationMs: Date.now() - startedAt, rounds, toolCalls, note,
  };
}

function userMessage(text, hints, tagsOnly) {
  return [
    `Request: ${text}`,
    `Target model: ${tagsOnly ? 'NAI 3 (tags only, do not write sentences).' : 'NAI 4 or newer (tags, plus optional short sentences on line 2).'}`,
    hints && `Tags a dictionary already recognized (use, fix or drop them as needed): ${hints}`,
  ].filter(Boolean).join('\n\n');
}

async function request(s, payload, deadline) {
  const timeout = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
  if (timeout <= 0) throw Object.assign(new Error('AI 接口超时'), { name: 'TimeoutError' });
  const res = await fetch(`${s.aiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.aiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  return { res, body: await res.json().catch(() => null) };
}

function addUsage(total, usage) {
  for (const k of Object.keys(total)) total[k] += usage[k];
}

/** 生图记完日志后，把这次 AI 调用挂到那条日志上 */
export function linkAiCall(callId, logId) {
  if (callId && logId) db.prepare('UPDATE ai_calls SET log_id = ? WHERE id = ?').run(logId, callId);
}

function recordAiCall({ source, key, model, prompt, durationMs, status, error = null, usage, result = null, rounds, toolCalls, note }) {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(`
      INSERT INTO ai_calls (created_at, day, source, key_id, key_name, model, input_tokens, cache_read_tokens,
                            cache_write_tokens, output_tokens, cost, status, error, duration_ms, prompt, result,
                            rounds, tool_calls, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      now, beijingDay(now), source, key?.id ?? null, key?.name ?? null, model, usage.input, usage.cacheRead,
      usage.cacheWrite, usage.output, usage.cost, status, error, durationMs, String(prompt).slice(0, 2000),
      result && String(result).slice(0, 3000), rounds, toolCalls, note,
    );
  return Number(lastInsertRowid);
}

// 有的接口把内容拆成多段返回
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
  return '';
}

// 解释性的句子（“This prompt …”）不是画面描述
const META_SENTENCE = /\b(prompts?|tags?|notes?|explanation|here is|i have|i added)\b|提示词|标签/i;

/**
 * 把 AI 的回复拆成 { tags, sentences }：tags 是标签那一行；sentences 是后面描述画面的英文短句（NAI4+ 用）。
 * 去掉思考过程、代码块、“Prompt:”之类的开头、引号、列表符号；遇到“Negative prompt”这类行就不要后面的了；
 * 解释性的句子丢掉。
 */
export function parseOutput(text) {
  const lines = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\w-]*/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '')) // 列表符号；“1girl”开头的数字不动
    .filter(Boolean);
  const kept = [];
  for (const line of lines) {
    if (/^(negative|uc|负面|反向)/i.test(line)) break;
    kept.push(line.replace(/^(final\s+)?(positive\s+)?(prompt|tags|提示词|正面提示词)\s*[:：]\s*/i, ''));
  }
  const isSentence = (l) => /[.!?]["']?$/.test(l) && /\b(the|is|are|with|of|in)\b/i.test(l);
  // 第一行逗号多的就是标签串（按约定写在最前面）；全是一行一个标签的列表时拼起来
  const tagLine = kept.findIndex((l) => (l.match(/,/g) || []).length >= 3);
  const tags = clean(tagLine === -1 ? kept.filter((l) => !isSentence(l)).join(', ') : kept[tagLine]).replace(/\.$/, '');
  const sentences = (tagLine === -1 ? [] : kept.slice(tagLine + 1))
    .filter((l) => isSentence(l) && /^[A-Za-z"']/.test(l) && !META_SENTENCE.test(l) && !hasCjk(l))
    .join(' ')
    .slice(0, 600);
  return { tags, sentences };
}

function clean(line) {
  return line
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s*,\s*(?:,\s*)*/g, ', ')
    .replace(/^,\s*|,\s*$/g, '')
    .trim()
    .slice(0, 2000);
}

export function listAiCalls({ page = 1, pageSize = 30 } = {}) {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM ai_calls').get();
  const items = db
    .prepare(`SELECT a.*, COALESCE(k.name, a.key_name) AS key_name FROM ai_calls a
              LEFT JOIN api_keys k ON k.id = a.key_id ORDER BY a.id DESC LIMIT ? OFFSET ?`)
    .all(pageSize, (page - 1) * pageSize);
  return { total, page, pageSize, items };
}
