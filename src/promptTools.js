// 提词器页面 /prompt 用的接口（/prompt/api/*）。查标签只用本地标签库，不调上游、不花点数，
// 所以不需要 sk，按 IP 简单限流；AI 优化要花钱，必须带调用密钥，按密钥另外限流。
import { aiAppliesTo, aiReady, optimizePrompt } from './aiPrompt.js';
import { HttpError, clientIp, readJson, sendJson } from './http.js';
import { authenticate, keyAllowsAi } from './keys.js';
import { resolveModel } from './models.js';
import { NEGATIVE_PRESETS, PRESET_GROUPS, QUALITY_PRESETS } from './promptPresets.js';
import { getSettings } from './settings.js';
import { convertText, recommendArtists, relatedTags, searchTags } from './tags.js';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 240;
const MAX_AI_PER_WINDOW = 20;
const windows = new Map(); // IP 或 ai:密钥 id → { start, count }

function rateLimit(subject, max) {
  const now = Date.now();
  const entry = windows.get(subject);
  if (!entry || now - entry.start > WINDOW_MS) {
    if (windows.size > 10_000) windows.clear();
    windows.set(subject, { start: now, count: 1 });
    return;
  }
  if (++entry.count > max) throw new HttpError(429, '操作太频繁，请稍后再试', { type: 'rate_limit_error' });
}

const text = (value, max) => String(value ?? '').slice(0, max);

/** 提词器选的模型（决定 AI 优化开没开、能不能写短句）；不认识就按默认模型 */
function modelOf(name) {
  try {
    return resolveModel(typeof name === 'string' ? name : undefined);
  } catch {
    return undefined;
  }
}
const tagList = (value) => (Array.isArray(value) ? value.slice(0, 60).map((t) => text(t, 200)) : []);
const limitOf = (value, fallback, max) => Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));

/** /prompt/api/* —— subpath 是去掉 /prompt/api 之后的部分 */
export async function handlePromptApi(req, res, subpath, query) {
  rateLimit(clientIp(req), MAX_PER_WINDOW);
  const route = `${req.method} ${subpath}`;
  if (route === 'GET /presets') {
    // ai_models：AI 优化只对这些模型开放，空 = 所有模型
    return sendJson(res, 200, {
      groups: PRESET_GROUPS, quality: QUALITY_PRESETS, negative: NEGATIVE_PRESETS,
      ai: aiReady(), ai_models: getSettings().aiApplyModels,
    });
  }
  if (route === 'GET /search') {
    const categories = query.get('cat') ? query.get('cat').split(',').map(Number) : undefined;
    return sendJson(res, 200, {
      results: searchTags(text(query.get('q'), 100), {
        limit: limitOf(query.get('limit'), 40, 100),
        nsfw: query.get('nsfw') === '1',
        categories,
      }),
    });
  }
  if (req.method !== 'POST') throw new HttpError(404, '接口不存在', { code: 'not_found' });

  if (route === 'POST /ai') {
    const key = authenticate(req);
    rateLimit(`ai:${key.id}`, MAX_AI_PER_WINDOW);
    const body = await readJson(req);
    const input = text(body.text, 2000).trim();
    if (!input) throw new HttpError(400, '先写一句描述');
    if (!aiReady()) throw new HttpError(503, '管理员还没有开启 AI 优化', { code: 'ai_not_configured' });
    if (!keyAllowsAi(key)) {
      throw new HttpError(403, '这把密钥没有开启 AI 优化，可以用“转成标签”', { code: 'ai_not_enabled_for_key' });
    }
    const model = modelOf(body.model);
    if (!aiAppliesTo(model?.id)) {
      throw new HttpError(400, `模型 ${model?.id ?? ''} 没有开启 AI 优化，可以换个模型，或者用“转成标签”`, {
        param: 'model', code: 'ai_not_enabled_for_model',
      });
    }
    // 本地词典先转一遍作参考；AI 写回来的再过一遍，拆成标签给页面显示；NAI4+ 的短句单独返回
    const local = convertText(input);
    const hints = local.tags.map((t) => t.text).join(', ');
    let result;
    try {
      result = await optimizePrompt(input, { hints, source: 'prompt', key, targetModel: model?.upstream });
    } catch {
      throw new HttpError(502, 'AI 优化暂时不可用，可以先用“转成标签”', { type: 'server_error', code: 'ai_failed' });
    }
    return sendJson(res, 200, { ...convertText(result.prompt, { nsfw: Boolean(body.nsfw) }), sentences: result.sentences });
  }

  const body = await readJson(req);
  const nsfw = Boolean(body.nsfw);
  if (route === 'POST /convert') return sendJson(res, 200, convertText(text(body.text, 2000), { nsfw }));
  if (route === 'POST /related') {
    return sendJson(res, 200, { results: relatedTags(tagList(body.tags), { limit: limitOf(body.limit, 30, 80), nsfw }) });
  }
  if (route === 'POST /artists') {
    return sendJson(res, 200, { results: recommendArtists(tagList(body.tags), { limit: limitOf(body.limit, 20, 60) }) });
  }
  throw new HttpError(404, '接口不存在', { code: 'not_found' });
}
