import { readZip } from './zip.js';

// NovelAI 官方接口：上游类型选“NovelAI 官方”的秘钥（官网 Account Settings 里生成的 pst- 持久令牌）走这里。
// 出图 POST <地址>/ai/generate-image，请求体 { input, model, action, parameters }，返回 ZIP；
// 账号信息在另一个域名 api.novelai.net。字段和默认值照官方网页端，见 https://image.novelai.net/docs/index.html
export const NOVELAI_BASE = 'https://image.novelai.net';
export const NOVELAI_ACCOUNT_API = 'https://api.novelai.net';

// 生图接口没有 /models，“拉取模型”时列这些
export const NOVELAI_MODELS = [
  'nai-diffusion-5-full',
  'nai-diffusion-5-full-medium',
  'nai-diffusion-5-curated',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-3',
  'nai-diffusion-furry-3',
];

// 质量词和负面预设：官方服务端不加，网页端在发请求前拼进提示词。OpenAI 格式进来的请求由中继照着拼；
// 负面预设的顺序就是 ucPreset 的编号，V5 改用名字（ucPresetId）。
const V45_HEAVY =
  'nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, ' +
  'chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const FURRY_FOCUS =
  'nsfw, {worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, ' +
  '{{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, ' +
  '[flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic';
const HUMAN_FOCUS_V45 = `${V45_HEAVY}, @_@, mismatched pupils, glowing eyes, bad anatomy`;
const V3_HEAVY =
  'nsfw, lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, ' +
  'displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]';

const FAMILIES = {
  v5: {
    quality: 'very aesthetic, masterpiece, no text',
    uc: {
      heavy: V45_HEAVY,
      light: 'nsfw, lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::',
      furry: FURRY_FOCUS,
      human: HUMAN_FOCUS_V45,
      none: '',
    },
  },
  v45: {
    quality: 'location, very aesthetic, masterpiece, no text',
    uc: {
      heavy: V45_HEAVY,
      light: 'nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
      furry: FURRY_FOCUS,
      human: HUMAN_FOCUS_V45,
      none: '',
    },
  },
  v45curated: {
    quality: 'location, masterpiece, no text, -0.8::feet::, rating:general',
    uc: {
      heavy: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
      light: 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page',
      human: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page',
      none: '',
    },
  },
  v4: {
    quality: 'no text, best quality, very aesthetic, absurdres',
    legacyUc: true,
    uc: {
      heavy: 'nsfw, blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page',
      light: 'nsfw, blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page',
      none: '',
    },
  },
  v4curated: {
    quality: 'rating:general, amazing quality, very aesthetic, absurdres',
    legacyUc: true,
    uc: {
      heavy: 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts',
      light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature',
      none: '',
    },
  },
  v3: {
    quality: 'best quality, amazing quality, very aesthetic, absurdres',
    uc: {
      heavy: V3_HEAVY,
      light: 'nsfw, lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing',
      human: `${V3_HEAVY}, bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes`,
      none: 'lowres',
    },
  },
  furry3: {
    quality: '{best quality}, {amazing quality}',
    uc: {
      heavy: 'nsfw, {{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, {what}, {where is your god now}, {distorted text}, repeated text, {floating head}, {1994}, {widescreen}, absolutely everyone, sequence, {compression artifacts}, hard translated, {cropped}, {commissioner name}, unknown text, high contrast',
      light: 'nsfw, {worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts, unknown text',
      none: 'lowres',
    },
  },
};

/** 模型属于哪一代；没见过的 nai-diffusion-6 之类按最新一代处理 */
export function novelaiFamily(model) {
  const id = String(model);
  if (/^nai-diffusion-4-5-curated/.test(id)) return 'v45curated';
  if (/^nai-diffusion-4-5/.test(id)) return 'v45';
  if (/^nai-diffusion-4-curated/.test(id)) return 'v4curated';
  if (/^nai-diffusion-4/.test(id)) return 'v4';
  if (/^nai-diffusion-furry-3/.test(id)) return 'furry3';
  if (/^nai-diffusion-3|^nai-diffusion-xl/.test(id)) return 'v3';
  return 'v5';
}

const isV4Plus = (family) => !['v3', 'furry3'].includes(family);
// 这些采样器不吃 noise_schedule；V4 以后不支持 native
const NO_SCHEDULE = new Set(['ddim', 'ddim_v3', 'plms', 'k_lms', 'k_dpm_fast']);
const MAX_SEED = 4294967295 - 7;

const toNumber = (value) => (value === '' || value == null || !Number.isFinite(Number(value)) ? undefined : Number(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const tags = (text) => String(text ?? '').split(',').map((t) => t.trim()).filter(Boolean);

/** “832x1216” → [832, 1216]，取到 64 的倍数；没给就 1024x1024 */
export function novelaiSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size ?? ''));
  const round = (v) => clamp(Math.round(Number(v) / 64) * 64, 64, 4096);
  return match ? [round(match[1]), round(match[2])] : [1024, 1024];
}

/** ucPreset 可以是编号（官方 params_version 3）或名字（heavy / light / human / furry / none） */
function ucPresetName(family, value) {
  const names = Object.keys(FAMILIES[family].uc);
  if (typeof value === 'string' && names.includes(value)) return value;
  const index = toNumber(value);
  return Number.isInteger(index) && names[index] ? names[index] : names[0];
}

/** 提示词里写了 nsfw 时，负面预设里的 nsfw 去掉（网页端同样处理） */
function presetNegative(family, name, prompt) {
  const preset = FAMILIES[family].uc[name];
  return /(^|[\s,{[(:])nsfw([\s,}\])]|$)/i.test(prompt) ? tags(preset).filter((t) => t !== 'nsfw').join(', ') : preset;
}

/**
 * 中继内部的出图参数 → NovelAI 官方请求 { input, model, action, parameters }。
 * payload 是 OpenAI Images 风格的（prompt / negative_prompt / size / n / steps / scale / sampler / seed / noise_schedule），
 * payload.nai 是只有官方接口用得到的：
 * - { qualityToggle, ucPreset, cfg_rescale, sm, sm_dyn }：OpenAI 格式请求里带的，中继照网页端拼质量词和负面预设；
 * - { enhanced: true, parameters }：NovelAI 格式进来的请求，客户端已经拼好，参数原样带上，只覆盖提示词、模型、尺寸这些。
 */
export function novelaiRequest(payload) {
  const model = payload.model;
  const family = novelaiFamily(model);
  const nai = payload.nai ?? {};
  const raw = nai.parameters ?? {};
  const medium = /-medium/.test(model);
  const [width, height] = novelaiSize(payload.size);
  const sampler = medium ? 'k_euler_ancestral' : String(payload.sampler ?? raw.sampler ?? 'k_euler_ancestral');
  const qualityToggle = Boolean(nai.qualityToggle ?? raw.qualityToggle ?? true);
  const uc = ucPresetName(family, medium ? 'heavy' : raw.ucPresetId ?? nai.ucPreset ?? raw.ucPreset);
  const seed = toNumber(payload.seed);

  let input = payload.prompt;
  let negative = payload.negative_prompt ?? '';
  if (!nai.enhanced) {
    const quality = FAMILIES[family].quality;
    if (qualityToggle && !input.includes(quality)) input = `${input}, ${quality}`;
    const preset = presetNegative(family, uc, input);
    if (preset && !negative.includes(preset)) negative = negative ? `${preset}, ${negative}` : preset;
  }

  const parameters = {
    ...pickRaw(raw),
    params_version: family === 'v5' ? 4 : 3,
    width,
    height,
    scale: toNumber(payload.scale) ?? toNumber(raw.scale) ?? 5,
    sampler,
    steps: medium ? 14 : clamp(Math.trunc(toNumber(payload.steps) ?? toNumber(raw.steps) ?? 28), 1, 50),
    n_samples: clamp(Math.trunc(toNumber(payload.n) ?? 1), 1, 4),
    seed: Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED ? seed : Math.floor(Math.random() * MAX_SEED),
    ucPreset: Object.keys(FAMILIES[family].uc).indexOf(uc),
    qualityToggle,
    negative_prompt: negative,
    cfg_rescale: toNumber(nai.cfg_rescale) ?? toNumber(raw.cfg_rescale) ?? 0,
    dynamic_thresholding: Boolean(raw.dynamic_thresholding),
    legacy: false,
    legacy_v3_extend: false,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
  };
  const schedule = payload.noise_schedule ?? raw.noise_schedule ?? 'karras';
  if (NO_SCHEDULE.has(sampler)) delete parameters.noise_schedule;
  else parameters.noise_schedule = isV4Plus(family) && schedule === 'native' ? 'karras' : schedule;

  if (isV4Plus(family)) {
    // 多角色时客户端会带 char_captions，原样保留，只换掉主提示词
    parameters.v4_prompt = {
      use_coords: false,
      use_order: true,
      ...raw.v4_prompt,
      caption: { char_captions: [], ...raw.v4_prompt?.caption, base_caption: input },
    };
    parameters.v4_negative_prompt = {
      legacy_uc: Boolean(FAMILIES[family].legacyUc),
      ...raw.v4_negative_prompt,
      caption: { char_captions: [], ...raw.v4_negative_prompt?.caption, base_caption: negative },
    };
    parameters.characterPrompts ??= [];
    parameters.use_coords = Boolean(parameters.v4_prompt.use_coords);
    delete parameters.sm;
    delete parameters.sm_dyn;
  } else {
    parameters.sm = Boolean(nai.sm ?? raw.sm);
    parameters.sm_dyn = parameters.sm && Boolean(nai.sm_dyn ?? raw.sm_dyn);
  }
  if (family === 'v5') {
    // 网页端 V5 用名字指定预设，并且总带上 skip_cfg_above_sigma: null
    parameters.ucPresetId = uc;
    parameters.qualityPresetId = qualityToggle ? 'standard' : 'none';
    parameters.skip_cfg_above_sigma = null;
  }
  return { input, model, action: 'generate', parameters };
}

// NovelAI 格式进来的请求里，这些参数原样带给上游；图片类字段（图生图、Vibe、角色参考）在入口就拦掉了
const RAW_FIELDS = [
  'characterPrompts', 'use_coords', 'legacy_uc', 'controlnet_strength', 'add_original_image', 'skip_cfg_above_sigma',
  'image_format', 'straight_alpha', 'tag_hint_qt', 'tag_hint_uc_preset', 'tag_hint_transparent_background',
  'qualityPresetId', 'ucPresetId',
];

function pickRaw(raw) {
  const out = {};
  for (const field of RAW_FIELDS) if (raw[field] !== undefined) out[field] = raw[field];
  return out;
}

/**
 * 请求体：V5（params_version 4）照网页端用 multipart，JSON 放在名为 request 的部分；之前的模型直接发 JSON。
 * 返回 fetch 用的 { body, headers }
 */
export function novelaiBody(request) {
  const json = JSON.stringify(request);
  if (request.parameters.params_version < 4) return { body: json, headers: { 'Content-Type': 'application/json' } };
  const form = new FormData();
  form.append('request', new Blob([json], { type: 'application/json' }), 'blob');
  return { body: form, headers: {} };
}

/** 响应里的图片：ZIP（常见）、直接一张图，或按官方文档 Accept: application/json 时的 { images: [{ image }] } */
export async function novelaiImages(res) {
  const data = Buffer.from(await res.arrayBuffer());
  if (/json/i.test(res.headers.get('content-type') ?? '')) {
    const body = JSON.parse(data.toString('utf8'));
    return (body.images ?? []).map((item) => Buffer.from(item.image ?? '', 'base64')).filter((b) => b.length);
  }
  if (isImage(data)) return [data];
  return readZip(data).filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name)).map((f) => f.data);
}

function isImage(data) {
  const hex = data.subarray(0, 4).toString('hex');
  return hex === '89504e47' || hex.startsWith('ffd8ff') || (hex === '52494646' && data.subarray(8, 12).toString('latin1') === 'WEBP');
}

const TIERS = ['Paper（免费）', 'Tablet', 'Scroll', 'Opus'];

/** /user/subscription 的响应 → 后台显示用的套餐和 Anlas 余额 */
export function novelaiAccount(body) {
  const steps = body?.trainingStepsLeft ?? {};
  return {
    tier: TIERS[body?.tier] ?? `tier ${body?.tier}`,
    active: Boolean(body?.active),
    anlas: (Number(steps.fixedTrainingStepsLeft) || 0) + (Number(steps.purchasedTrainingSteps) || 0),
    expires_at: body?.expiresAt ? body.expiresAt * 1000 : null,
  };
}
