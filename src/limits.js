// 每把上游秘钥的出图上限：最大面积（宽×高）、最多步数、单次最多几张，0 = 不限。
// 超出的按上限压下来照常出图，不报错：尺寸等比缩小并取 64 的倍数，步数、张数取上限。
// 防止有人用官方秘钥出大图、加步数、一次出多张，把账号的 Anlas 花掉。
export const LIMIT_FIELDS = ['max_pixels', 'max_steps', 'max_n'];

/** NovelAI Opus 订阅不花 Anlas 的范围：不超过 1024×1024 像素、28 步以内、一次一张 */
export const OPUS_FREE = { max_pixels: 1024 * 1024, max_steps: 28, max_n: 1 };
export const NO_LIMITS = { max_pixels: 0, max_steps: 0, max_n: 0 };

const RANGES = {
  max_pixels: { min: 256 * 256, max: 4096 * 4096, label: '最大面积' },
  max_steps: { min: 1, max: 50, label: '最多步数' },
  max_n: { min: 1, max: 4, label: '单次最多张数' },
};

/** 面积超过 maxPixels 时等比缩小，宽高都取 64 的倍数（往下取，保证不超） */
export function fitArea(width, height, maxPixels) {
  if (!(maxPixels > 0) || width * height <= maxPixels) return [width, height];
  const scale = Math.sqrt(maxPixels / (width * height));
  const floor64 = (v) => Math.max(64, Math.floor((v * scale) / 64) * 64);
  return [floor64(width), floor64(height)];
}

/**
 * 按秘钥的上限调整这次实际要发的参数。shape 是 { width, height, steps, n }，steps 没传时是 undefined（不动它）。
 * 返回调整后的 shape 和改了哪些（给日志、聊天回复看）。
 */
export function applyLimits(shape, limits = {}) {
  const out = { ...shape };
  const changes = [];
  const [width, height] = fitArea(out.width, out.height, limits.max_pixels);
  if (width !== out.width || height !== out.height) {
    changes.push(`尺寸 ${out.width}x${out.height} → ${width}x${height}`);
    Object.assign(out, { width, height });
  }
  if (limits.max_steps > 0 && out.steps > limits.max_steps) {
    changes.push(`步数 ${out.steps} → ${limits.max_steps}`);
    out.steps = limits.max_steps;
  }
  if (limits.max_n > 0 && out.n > limits.max_n) {
    changes.push(`张数 ${out.n} → ${limits.max_n}`);
    out.n = limits.max_n;
  }
  return { shape: out, changes };
}

/** 后台填的上限：空或 0 = 不限；面积也可以写成“1024x1024” */
export function limitValue(field, value) {
  const range = RANGES[field];
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === '0') return 0;
  const size = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(text);
  const n = field === 'max_pixels' && size ? Number(size[1]) * Number(size[2]) : Number(text);
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    const hint = field === 'max_pixels' ? '，或者写成 1024x1024' : '';
    throw new Error(`${range.label}要填 ${range.min}～${range.max} 的整数${hint}，0 表示不限`);
  }
  return n;
}
