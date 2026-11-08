// 提词器的预设标签组和中文直译表。
// 分组和中英对照借鉴 Auto-NovelAI-Refactor 的内置提示词库（web/js/data/builtinPrompts.js，
// 其本身参考 sd-webui-prompt-all-in-one），质量词 / 负面词借鉴它自带的通配符卡片。

/** 提词器页面上的分组，每项 [英文标签, 中文] */
export const PRESET_GROUPS = [
  {
    name: '画质',
    tags: [
      ['best quality', '最佳质量'], ['masterpiece', '杰作'], ['high quality', '高质量'],
      ['very aesthetic', '高美感'], ['absurdres', '超高分辨率'], ['ultra-detailed', '超精细细节'],
      ['intricate details', '复杂细节'], ['newest', '最新画风'], ['8k', '8K 画质'],
    ],
  },
  {
    name: '人物',
    tags: [
      ['1girl', '一个女孩'], ['1boy', '一个男孩'], ['2girls', '两个女孩'], ['1girl, 1boy', '一男一女'],
      ['multiple girls', '多个女孩'], ['solo', '单人'], ['solo focus', '单人焦点'], ['no humans', '无人物'],
    ],
  },
  {
    name: '镜头',
    tags: [
      ['close-up', '特写'], ['portrait', '肖像'], ['upper body', '上半身'],
      ['cowboy shot', '七分身'], ['full body', '全身'], ['wide shot', '远景'],
      ['from above', '俯视'], ['from below', '仰视'], ['from side', '侧面'],
      ['from behind', '背后'], ['dutch angle', '倾斜镜头'], ['dynamic angle', '动态视角'],
      ['looking at viewer', '看向镜头'], ['looking back', '回头看'],
    ],
  },
  {
    name: '光影',
    tags: [
      ['cinematic lighting', '电影级光效'], ['soft lighting', '柔和光照'], ['dramatic shadow', '戏剧性阴影'],
      ['golden hour', '黄昏暖光'], ['rim lighting', '轮廓光'], ['backlighting', '逆光'],
      ['dappled sunlight', '斑驳阳光'], ['sunlight', '阳光'], ['neon lights', '霓虹灯'],
      ['bioluminescence', '生物荧光'], ['candlelight', '烛光'], ['moonlight', '月光'],
    ],
  },
  {
    name: '场景',
    tags: [
      ['outdoors', '户外'], ['indoors', '室内'], ['day', '白天'], ['night', '夜晚'],
      ['simple background', '简单背景'], ['white background', '白色背景'], ['classroom', '教室'],
      ['bedroom', '卧室'], ['street', '街道'], ['city', '城市'], ['forest', '森林'], ['beach', '海滩'],
      ['onsen', '温泉'], ['on grass', '草地上'],
    ],
  },
  {
    name: '氛围',
    tags: [
      ['cherry blossoms', '樱花'], ['falling petals', '飘落花瓣'], ['starry night', '星空'],
      ['aurora', '极光'], ['sunset', '日落'], ['night sky', '夜空'],
      ['underwater', '水下'], ['rain', '下雨'], ['snowing', '下雪'],
      ['fireworks', '烟花'], ['city lights', '城市灯火'], ['mist', '薄雾'],
    ],
  },
  {
    name: '画风',
    tags: [
      ['watercolor (medium)', '水彩'], ['impressionism', '印象派'], ['sketch', '素描'],
      ['lineart', '线稿'], ['flat color', '平涂上色'], ['semi-realistic', '半写实'],
      ['monochrome', '单色'], ['greyscale', '灰度'], ['pastel colors', '柔和色彩'],
      ['vivid colors', '鲜艳色彩'], ['muted colors', '低饱和色彩'], ['oil painting (medium)', '油画'],
      ['chibi', 'Q版'], ['pixel art', '像素画'],
    ],
  },
  {
    name: '服装',
    tags: [
      ['school uniform', '校服'], ['serafuku', '水手服'], ['maid', '女仆装'], ['kimono', '和服'],
      ['china dress', '旗袍'], ['hanfu', '汉服'], ['lolita fashion', '洛丽塔'], ['gothic lolita', '哥特萝莉装'],
      ['hoodie', '连帽衫'], ['pleated skirt', '百褶裙'], ['thighhighs', '过膝袜'], ['hair ribbon', '发带'],
      ['hair ornament', '发饰'], ['coat', '外套'], ['dress', '连衣裙'],
    ],
  },
  {
    name: '表情动作',
    tags: [
      ['smile', '微笑'], ['open mouth', '张嘴'], ['blush', '脸红'],
      ['crying', '哭泣'], ['surprised', '惊讶'], ['wink', '眨眼'],
      ['laughing', '大笑'], ['pout', '嘟嘴'], ['clenched teeth', '咬紧牙关'],
      ['peace sign', '剪刀手'], ['hands on hips', '叉腰'], ['standing', '站立'], ['sitting', '坐着'],
    ],
  },
];

/** 质量词预设（正面提示词前缀） */
export const QUALITY_PRESETS = [
  { name: '常用质量词', text: 'best quality, amazing quality, very aesthetic' },
  { name: '简单质量词', text: 'best quality' },
  { name: '杰作', text: 'masterpiece, best quality, very aesthetic, absurdres' },
];

/** 负面提示词预设 */
export const NEGATIVE_PRESETS = [
  {
    name: '常用负面',
    text: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, '
      + 'unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
  },
  {
    name: '去除小人',
    text: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, '
      + 'unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, '
      + '[abstract], {{{{{chibi, doll}}}}}',
  },
  {
    name: '手脚修正',
    text: 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, '
      + 'unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, '
      + '[abstract], mutated hands, poorly drawn hands, extra fingers, fused fingers, {{{missing toes}}}, '
      + '{{{extra toes}}}, {{{fused toes}}}, {{{bad foot}}}',
  },
];

// 中文转标签时优先使用的直译：标签库里的同义词覆盖不到、或容易挑错的常用词
const EXTRA_WORDS = {
  女孩: '1girl', 少女: '1girl', 女生: '1girl', 姑娘: '1girl', 美少女: '1girl', 小女孩: '1girl',
  男孩: '1boy', 少年: '1boy', 男生: '1boy', 男人: '1boy', 小男孩: '1boy',
  两个女孩: '2girls', 两名少女: '2girls', 两个少女: '2girls', 三个女孩: '3girls',
  两个男孩: '2boys', 多个女孩: 'multiple girls', 一群女孩: 'multiple girls',
  女仆: 'maid', 女仆装: 'maid', 猫娘: 'cat girl', 狐娘: 'fox girl', 兽耳: 'animal ears',
  JK: 'school uniform', JK制服: 'school uniform', 动画风格: 'anime coloring', 动漫风格: 'anime coloring',
  看向镜头: 'looking at viewer', 看着镜头: 'looking at viewer', 看着观众: 'looking at viewer',
  晚上: 'night', 夜里: 'night', 夜景: 'night, city lights', 雨中: 'rain', 下着雨: 'rain', 雨天: 'rain',
  流泪: 'tears', 流着泪: 'tears', 哭: 'crying', 笑: 'smile', 开心: 'happy', 生气: 'angry',
  白天: 'day', 户外: 'outdoors', 室外: 'outdoors', 室内: 'indoors', 海边: 'beach', 沙滩: 'beach',
  站: 'standing', 站着: 'standing', 站立: 'standing', 坐: 'sitting', 坐着: 'sitting', 躺: 'lying', 躺着: 'lying',
  跑: 'running', 跑步: 'running', 走: 'walking', 走路: 'walking', 吃: 'eating', 喝: 'drinking', 睡觉: 'sleeping',
  蓝天白云: 'blue sky, cloud', 潮湿: 'wet', 湿: 'wet', 湿透: 'wet clothes', 湿身: 'wet clothes',
  战士: 'warrior', 女战士: '1girl, warrior', 骑士: 'knight', 女骑士: '1girl, knight', 魔法少女: 'magical girl',
  女巫: 'witch', 魔女: 'witch', 轻甲: 'armor', 盔甲: 'armor', 铠甲: 'armor',
  红瞳: 'red eyes', 红眼: 'red eyes', 蓝瞳: 'blue eyes', 蓝眼: 'blue eyes', 金瞳: 'yellow eyes',
  绿瞳: 'green eyes', 紫瞳: 'purple eyes', 异色瞳: 'heterochromia',
};

/** 中文 → 标签直译表：预设分组里的中文 + 上面的常用词 */
export const DIRECT_WORDS = new Map([
  ...PRESET_GROUPS.flatMap((g) => g.tags.map(([en, zh]) => [zh, en])),
  ...Object.entries(EXTRA_WORDS),
]);

/**
 * 英文纠错时原样保留的写法：NAI 自己的质量词 / 美学词（不是 Danbooru 标签，但 NAI 认得），
 * 以及预设和负面预设里的词。统一成小写、空格分隔来比较。
 */
export const KEEP_AS_IS = new Set([
  'masterpiece', 'best quality', 'amazing quality', 'great quality', 'good quality', 'normal quality',
  'low quality', 'bad quality', 'worst quality', 'very aesthetic', 'aesthetic', 'displeasing', 'very displeasing',
  'no text', 'newest', 'recent', 'mid', 'early', 'oldest', 'year 2023', 'year 2024', 'year 2025',
  ...[...QUALITY_PRESETS, ...NEGATIVE_PRESETS].flatMap((p) => p.text.split(',')),
  ...PRESET_GROUPS.flatMap((g) => g.tags.map(([en]) => en)),
].map((w) => w.replace(/[{}[\]]/g, '').trim().toLowerCase()).filter(Boolean));
