import { db } from './db.js';

const env = process.env;

// 后台“设置”页可改的运行时配置。数据库里没有的项用这里的默认值，部分可用环境变量给首次启动的初值。
const DEFAULTS = {
  // 首次启动导入的上游秘钥（可逗号分隔多把）和它的接口地址；之后每把秘钥带自己的接口地址，在后台“上游秘钥”页管理。
  // pst- 开头的 NovelAI 官方令牌不用填地址。旧版只有这一个上游地址，升级时给库里没有接口地址的秘钥补上它
  upstream_base: env.UPSTREAM_BASE || '',
  upstream_key: env.UPSTREAM_KEY || '',
  upstream_keys_seeded: '',
  default_model: 'nai-diffusion-5-full',
  public_base_url: env.PUBLIC_BASE_URL || '',
  chat_image_mode: 'url',
  image_ttl_days: '7',
  // 每点折合多少元，按自己上游的充值价格在后台填；0 = 不折算金额
  point_price: '0',
  hide_words: '',
  // 上游秘钥都满了时的排队：最多等多少秒、最多排多少个（0 = 不限）
  queue_timeout: '300',
  queue_max: '100',
  // 提示词里的中文自动转成 Danbooru 标签；是否允许转出 NSFW 标签；英文标签自动纠错；
  // 转换或纠错后在聊天回复里附上实际提示词
  prompt_assist: '1',
  prompt_assist_nsfw: '0',
  prompt_fix: '1',
  prompt_echo: '1',
  // AI 提示词优化：调任意 OpenAI 兼容接口，把描述改写成 NAI 标签。off 关闭 / auto 含中文或英文句子时 / always 每次
  ai_mode: 'off',
  ai_apply_models: '', // 只对这些模型（对外名称，逗号分隔）做 AI 优化；空 = 所有模型
  ai_base_url: '',
  ai_api_key: '',
  ai_model: '',
  // 价格：元 / 百万 tokens
  ai_price_input: '0',
  ai_price_output: '0',
  ai_price_cache_read: '0',
  ai_price_cache_write: '0',
  ai_system_prompt: '', // 空 = 用内置的
  ai_tools: '0', // 让 AI 用工具调用查内置标签库（更准，但多轮请求，更慢更费 tokens）
  ai_reasoning_effort: '', // 原样传给接口的 reasoning_effort；空 = 不传，用模型默认
  ai_offpeak: '0', // DeepSeek 官方分时计价：价格填高峰价，高峰时段以外按半价算成本
  admin_password_hash: '',
};

let cache;

export function getSettings() {
  if (!cache) {
    const stored = Object.fromEntries(db.prepare('SELECT name, value FROM settings').all().map((r) => [r.name, r.value]));
    const s = { ...DEFAULTS, ...stored };
    cache = {
      upstreamBase: s.upstream_base.replace(/\/+$/, ''),
      legacyUpstreamKey: s.upstream_key,
      upstreamKeysSeeded: s.upstream_keys_seeded === '1',
      // 请求里没写模型、或写的不是已添加的模型（如 dall-e-3、gpt-image-1）时使用
      defaultModel: s.default_model,
      // 中继对外的访问地址，用来拼图片链接；空则按请求的 Host / X-Forwarded-* 推断
      publicBaseUrl: s.public_base_url.replace(/\/+$/, ''),
      // 聊天接口里图片的形式：url = 中继图片链接；b64 = 内嵌 data URI
      chatImageMode: s.chat_image_mode === 'b64' ? 'b64' : 'url',
      imageTtlDays: Number(s.image_ttl_days) || 7,
      // 每点折合多少元，只用于后台显示金额
      pointPrice: Number(s.point_price) || 0,
      // 上游错误信息里额外要隐藏的词；网址、域名、邮箱、IP 总会被隐藏
      hideWords: s.hide_words.split(/[,，\n]/).map((w) => w.trim()).filter(Boolean),
      queueTimeoutMs: (Number(s.queue_timeout) || 300) * 1000,
      queueMax: Number.isInteger(Number(s.queue_max)) ? Math.max(0, Number(s.queue_max)) : 100,
      promptAssist: s.prompt_assist === '1',
      promptAssistNsfw: s.prompt_assist_nsfw === '1',
      promptFix: s.prompt_fix === '1',
      promptEcho: s.prompt_echo === '1',
      aiMode: ['auto', 'always'].includes(s.ai_mode) ? s.ai_mode : 'off',
      aiApplyModels: s.ai_apply_models ? s.ai_apply_models.split(',') : [],
      aiBaseUrl: s.ai_base_url.replace(/\/+$/, ''),
      aiApiKey: s.ai_api_key,
      aiModel: s.ai_model,
      aiPrices: {
        input: Number(s.ai_price_input) || 0,
        output: Number(s.ai_price_output) || 0,
        cacheRead: Number(s.ai_price_cache_read) || 0,
        cacheWrite: Number(s.ai_price_cache_write) || 0,
      },
      aiSystemPrompt: s.ai_system_prompt,
      aiTools: s.ai_tools === '1',
      aiReasoningEffort: s.ai_reasoning_effort,
      aiOffpeak: s.ai_offpeak === '1',
      adminPasswordHash: s.admin_password_hash,
    };
  }
  return cache;
}

export function saveSettings(values) {
  const upsert = db.prepare(
    'INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value',
  );
  for (const [name, value] of Object.entries(values)) {
    if (name in DEFAULTS && value !== undefined) upsert.run(name, String(value));
  }
  cache = undefined;
}
