import { novelaiFamily } from './novelai.js';

// NovelAI 官方文生图要花多少 Anlas，照官网网页端的计价函数（2026-11 的版本）：
// 每张 = max(ceil(基础价 × SMEA 倍数 × V5 的 1.5), 2)，基础价 = ceil(a·像素 + b·像素·步数)；
// NAI5 medium 不看步数，按 23 步算再除以 1.75、不取整。
// Opus 订阅在 ≤1024×1024、≤28 步时，一次请求里的第一张免费，其余照收；
// NAI5 的免费要扣 Opus 用量条，用量条为负（usage.isNegative）时 NAI5 每张都收 Anlas。
// 图生图每张再乘重绘强度。官方文档说 Opus 的免费出图不含“用别的图当底图”（网页端的计价函数没把它排除，没实测），
// 这里按要收费算，“只出免费图”的秘钥不接图生图。Vibe、角色参考中继不转，不在这里。
const A = 2951823174884865e-21;
const B = 5753298233447344e-22;
const FREE_PIXELS = 1024 * 1024;
const FREE_STEPS = 28;
const MAX_PER_IMAGE = 140; // 网页端单张超过这个价就不让发

/**
 * shape 是实际要发的 { width, height, steps, n, sm, sm_dyn }，account 是这把官方秘钥最近查到的账号状态（见 naiAccounts.js），
 * 没有时按非 Opus 算。返回 { perImage, total, free, refused, why, accountReason, requestReasons, barOnly }：
 * why 是要花 Anlas 的原因（给日志和后台看）；accountReason 是账号这边的原因（不是 Opus、用量条用完、状态未知），
 * requestReasons 是请求这边的（尺寸、步数、张数超出免费范围）；barOnly 表示只是因为 NAI5 用量条用完了才收费。
 */
export function anlasCost(model, shape, account, now = Date.now()) {
  const { width, height, steps, n = 1, sm = false, sm_dyn: dyn = false, img2img = false, strength = 1 } = shape;
  const pixels = width * height;
  const v5 = novelaiFamily(model) === 'v5';
  let price = /-medium/.test(model) ? (A * pixels + B * pixels * 23) / 1.75 : Math.ceil(A * pixels + B * pixels * steps);
  price *= sm && dyn ? 1.4 : sm ? 1.2 : 1;
  if (v5) price *= 1.5;
  const perImage = Math.max(Math.ceil(price * (img2img ? strength : 1)), 2);

  const active = account?.active && !(account.expires_at && account.expires_at <= now);
  let accountReason = null;
  if (!account) accountReason = '账号状态未知';
  else if (!(account.level >= 3 && active)) accountReason = `账号不是有效的 Opus 订阅（${account.tier}${active ? '' : '，未订阅或已过期'}）`;
  else if (v5 && account.usage_negative) accountReason = 'NAI5 的免费额度（Opus 用量条）用完了';
  const requestReasons = [];
  if (pixels > FREE_PIXELS) requestReasons.push(`尺寸 ${width}x${height} 超过 1024×1024`);
  if (steps > FREE_STEPS) requestReasons.push(`步数 ${steps} 超过 28`);
  if (img2img) requestReasons.push('图生图不在 Opus 的免费范围内');
  const firstFree = !accountReason && !requestReasons.length;
  if (n > 1) requestReasons.push(firstFree ? `一次 ${n} 张，第 2 张起收费` : `一次 ${n} 张`);
  const total = perImage * (n - (firstFree ? 1 : 0));
  const why = total ? [accountReason, ...requestReasons].filter(Boolean).join('，') : '';
  return {
    perImage,
    total,
    free: total === 0,
    refused: perImage > MAX_PER_IMAGE,
    why,
    accountReason: total ? accountReason : null,
    requestReasons: total ? requestReasons : [],
    barOnly: Boolean(total) && accountReason === 'NAI5 的免费额度（Opus 用量条）用完了' && !requestReasons.length,
  };
}
