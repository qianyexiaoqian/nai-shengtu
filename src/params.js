// 常见宽高比（香蕉生图 / Gemini 那一套）对应的 NAI 分辨率：边长是 64 的倍数，
// 总像素不超过 1024×1024，不会触发大图加价
const ASPECT_SIZES = {
  '1:1': '1024x1024',
  '2:3': '832x1216',
  '3:2': '1216x832',
  '3:4': '896x1152',
  '4:3': '1152x896',
  '4:5': '896x1088',
  '5:4': '1088x896',
  '9:16': '768x1344',
  '16:9': '1344x768',
  '9:21': '640x1536',
  '21:9': '1536x640',
};

// 原样转发给 OpenAI 兼容上游的字段（含一些 NAI 中转站的扩展字段）；prompt / model / size / negative 单独处理
const UPSTREAM_FIELDS = [
  'negative_prompt', 'n', 'steps', 'scale', 'sampler', 'seed',
  'noise_schedule', 'cfg', 'SMEA', 'DYN', 'addition',
];
// 只有 NovelAI 官方上游用的参数，放进 payload.nai（见 novelai.js），不发给 OpenAI 兼容上游
const NAI_FIELDS = ['qualityToggle', 'ucPreset', 'cfg_rescale', 'sm', 'sm_dyn'];

// 提示词里的行内参数，写法类似 Midjourney：1girl, smile --ar 16:9 --steps 28 --no lowres, blurry
// --ai / --noai 不带值：这次强制走 / 不走 AI 提示词优化
const AI_FLAG_RE = /(^|\s)--(ai|noai)(?=\s|$)/gi;
const NEGATIVE_FLAG_RE = /(^|\s)--(?:no|neg|negative)[ \t]+((?:(?![ \t]+--[a-z]).)+)/gi;
const FLAG_RE = /(^|\s)--([a-z]+)[ \t]+(\S+)/gi;
// A1111 习惯：单独一行 “Negative prompt: ...”，之后的内容都算负面提示词
const NEGATIVE_LINE_RE = /^[ \t]*(?:negative prompt|negative|负面提示词|负面|反向提示词|反向)[ \t]*[:：]([\s\S]*)$/im;

const toInt = (v) => (/^-?\d+$/.test(v) ? Number(v) : undefined);
const toFloat = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

const FLAGS = {
  size: ['size', explicitSize],
  ar: ['aspect_ratio', (v) => (aspectToSize(v) ? v : undefined)],
  n: ['n', toInt],
  steps: ['steps', toInt],
  scale: ['scale', toFloat],
  seed: ['seed', toInt],
  sampler: ['sampler', (v) => v],
};

/** 从提示词文本里拆出行内参数，返回干净的提示词和参数 */
export function parsePromptText(text) {
  const params = {};
  let prompt = String(text ?? '');

  prompt = prompt.replace(AI_FLAG_RE, (_, lead, name) => {
    params.ai = name.toLowerCase() === 'ai';
    return lead;
  });
  prompt = prompt.replace(NEGATIVE_FLAG_RE, (_, lead, value) => {
    params.negative_prompt = value.trim();
    return lead;
  });
  prompt = prompt.replace(FLAG_RE, (match, lead, name, value) => {
    const flag = FLAGS[name.toLowerCase()];
    const parsed = flag?.[1](value);
    if (parsed === undefined) return match; // 不认识或不合法的参数原样留在提示词里
    params[flag[0]] = parsed;
    return lead;
  });

  const negativeLine = NEGATIVE_LINE_RE.exec(prompt);
  if (negativeLine) {
    params.negative_prompt ??= negativeLine[1].trim();
    prompt = prompt.slice(0, negativeLine.index);
  }

  return { prompt: prompt.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim(), params };
}

export function aspectToSize(ratio) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(ratio ?? ''));
  if (!match) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return undefined;
  const preset = ASPECT_SIZES[`${w}:${h}`];
  if (preset) return preset;
  // 其它比例：按 1024×1024 的像素总量等比换算，向下取到 64 的倍数
  const area = 1024 * 1024;
  const floor64 = (v) => Math.max(64, Math.floor(v / 64) * 64);
  return `${floor64(Math.sqrt((area * w) / h))}x${floor64(Math.sqrt((area * h) / w))}`;
}

/**
 * 合成上游 /images/generations 的请求体，upstreamModel 是已解析好的上游模型 ID。
 * 优先级：提示词行内参数 > 请求体字段；尺寸取 size，没有（或是 auto）时再看 aspect_ratio。
 */
export function toUpstreamPayload(body, prompt, inline, upstreamModel) {
  const payload = { model: upstreamModel, prompt };
  for (const key of UPSTREAM_FIELDS) {
    if (body[key] != null && body[key] !== '') payload[key] = body[key];
  }
  for (const key of NAI_FIELDS) {
    if (body[key] != null && body[key] !== '') (payload.nai ??= {})[key] = body[key];
  }
  // 上游在 negative 和 negative_prompt 同时存在时取 negative；统一成 negative_prompt，行内 --no 才能覆盖
  if (body.negative != null && body.negative !== '') payload.negative_prompt = body.negative;

  const size =
    inline.size ??
    aspectToSize(inline.aspect_ratio) ??
    explicitSize(body.size) ??
    aspectToSize(body.aspect_ratio ?? body.image_config?.aspect_ratio);
  if (size) payload.size = size;

  const { size: _size, aspect_ratio: _ratio, ai: _ai, ...rest } = inline;
  Object.assign(payload, rest);
  if (payload.n != null) payload.n = Math.min(4, Math.max(1, Math.trunc(Number(payload.n)) || 1));
  return payload;
}

function explicitSize(value) {
  const size = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^\d+x\d+$/.test(size) ? size : undefined;
}
