// 内置标签引擎：中文 / 英文查标签、整段中文转标签、关联推荐、推荐画师。
// 思路和数据借鉴 DanbooruSearchOnline（中文同义词、显式分隔、停用词、NPMI 关联与画师推荐）
// 和 Auto-NovelAI-Refactor（中文译名、别名补全、预设词表）。DanbooruSearch 用向量模型做语义匹配，
// 这里换成词典最大匹配，不依赖 Python / 显卡，数据由 scripts/build_tag_data.py 生成。
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { DIRECT_WORDS, KEEP_AS_IS } from './promptPresets.js';

const DATA_DIR = new URL('../assets/tags/', import.meta.url);

export const CATEGORY_NAMES = { 0: '通用', 1: '画师', 3: '作品', 4: '角色', 5: '元数据' };

const CJK = /[㐀-鿿]/;
// 显式分隔符：用户用逗号、顿号、分号、换行隔开的就是独立概念（同 DanbooruSearch）
const SEPARATORS = /[,，、;；。\n\r]+/;
// 不超过这个长度的中文片段先整体匹配，更长的当句子分词（同 DanbooruSearch 的 7 字阈值）
const ATOMIC_MAX = 7;
// 词典里最长的词（含“Fate/Grand Order”这种中英混写的作品名）
const MAX_WORD = 16;
const LATIN = /[A-Za-z0-9]/;
const LATIN_RUN = /[A-Za-z0-9 _\-'.:/&!?+]/;
// 一个中文词挂在这么多标签上、又不是任何标签的核心词，就当作“发型”“表情”这类泛称，不转换
const GENERIC_DF = 40;

// 取自 DanbooruSearch 的中文停用词，另加了一些量词和虚词
const STOP_WORDS = new Set(`
的 地 得 了 着 过 是 为 被 给 把 让 由 在 从 自 向 往 对 于 和 与 及 或 且 而 但 并 即 又 也
啊 吗 吧 呢 噢 哦 哈 呀 哇 我 你 他 她 它 我们 你们 他们 这 那 此 其 谁 啥 某 每
这个 那个 这些 那些 这里 那里 个 位 只 条 张 幅 件 套 双 对 副 种 类 群 些 点 份 部 名
很 太 更 最 挺 特 好 真 一 一个 一位 一名 一只 一种 一下 一点 一些 有 无 非 没 不
正在 已经 正 刚 开始 继续 一直 不断 穿着 戴着 穿 戴 带有 具有 拥有 拿着 手持
看起来 看上去 显得 仿佛 似乎 十分 非常 特别 比较 图片 画面 图像 位于 处于 许多 大量 各种 所有 其他 其它
画 一张 帮我 请 生成 绘制 想要 要 背景是 背景为 背景 身穿 身着 穿上 戴上 手拿 风格 样子
好看 漂亮 美丽 优美 精致 唯美
`.split(/\s+/).filter(Boolean));
// 方位字单独剩下时不算“没识别”（“雨中”“路灯下”）
const LOCATIVES = new Set('中里上下内外前后旁边处时间'.split(''));
// 虚词：短语去掉它们再整体查一次，“流着泪” → “流泪”
const PARTICLES = /[的地得着了过]/g;

const COLORS = {
  白: ['white'], 黑: ['black'], 红: ['red'], 蓝: ['blue'], 绿: ['green'], 黄: ['yellow'], 粉: ['pink'],
  紫: ['purple'], 橙: ['orange'], 棕: ['brown'], 褐: ['brown'], 灰: ['grey'], 金: ['blonde', 'gold'],
  银: ['silver', 'white', 'grey'], 青: ['aqua'], 浅蓝: ['light_blue'], 深蓝: ['dark_blue'], 水蓝: ['light_blue'],
};
const HAIR_WORDS = new Set(['发', '头发', '秀发']);
const EYE_WORDS = new Set(['眼', '眼睛', '瞳', '瞳孔', '眼眸']);
// 人数 / 主体类标签排在最前面，NAI 的习惯写法
const SUBJECT_TAGS = /^(\d\+?(girl|boy)s?|multiple_(girls|boys)|solo|no_humans)$/;
// 未开 NSFW 时，和 NSFW 标签一样隐藏
const SENSITIVE = /(^|_)(loli|shota|lolicon|shotacon|toddlercon)(_|$)/;
// 日常称呼，很多游戏拿它当主角 / 玩家的角色名（蔚蓝档案“先生”、明日方舟“博士”），
// 只有同一段里出现了对应作品才落到角色上
const COMMON_ROLES = new Set(`
先生 老师 学生 同学 前辈 后辈 学姐 学长 学妹 学弟 姐姐 妹妹 哥哥 弟弟 妈妈 爸爸 母亲 父亲 女儿 儿子
女王 公主 王子 国王 王女 魔王 勇者 主人 少爷 小姐 大小姐 店长 社长 会长 部长 队长 团长 舰长 提督 指挥官 博士
旅行者 训练家 制作人 管理员 医生 护士 主角 男主 女主 玩家 新娘 姬 巫女 修女 天使 恶魔 神 魔女 侦探 偶像
`.split(/\s+/).filter(Boolean));

let store;
let relatedStore;
let artistStore;

const readGz = (name) => JSON.parse(gunzipSync(readFileSync(new URL(name, DATA_DIR))).toString('utf8'));
// 标签名的统一写法：小写、去掉 SD 习惯的 \( \) 转义、空格换下划线
const normName = (text) => String(text).trim().toLowerCase().replace(/\\(?=[()])/g, '').replace(/\s+/g, '_');

function load() {
  if (store) return store;
  const { tags: rows } = readGz('tags.json.gz');
  const tags = [];
  const byName = new Map();
  const byAlias = new Map(); // 只收 Danbooru 官方别名和 Auto-NovelAI 的别名，中文同义词里的英文词太杂不收
  // 中文词 → 各来源命中的标签（列表按作品数降序）：core 核心词 / zh 译名 / syn 其它同义词 / base 去掉括号注释的核心词
  const words = new Map();

  const addWord = (word, kind, tag) => {
    let entry = words.get(word);
    if (!entry) words.set(word, (entry = { core: [], zh: [], syn: [], base: [] }));
    if (!entry[kind].includes(tag)) entry[kind].push(tag);
  };

  rows.forEach(([name, cat, posts, nsfw, cn, zh, aliases, wiki], i) => {
    const tag = {
      i, name, cat, posts, nsfw: nsfw === 1 || SENSITIVE.test(name),
      cn: cn ? cn.split('|') : [], zh, aliases: aliases ? aliases.split('|') : [], wiki,
    };
    tags.push(tag);
    byName.set(name.toLowerCase(), tag);
    for (const alias of tag.aliases) if (!byAlias.has(alias.toLowerCase())) byAlias.set(alias.toLowerCase(), tag);
  });

  // 角色名的括号里是作品名（klee_(genshin_impact)）才算靠谱；括号里是画师名的原创角色，
  // 中文核心词常常就是“女战士”这种普通词，降为普通同义词，免得普通词落到冷门角色上
  const solidCharacter = (tag) => {
    const qualifier = /_\(([^()]+)\)$/.exec(tag.name)?.[1];
    return !qualifier || byName.get(qualifier)?.cat === 3;
  };
  for (const tag of tags) {
    const weak = tag.cat === 4 && !solidCharacter(tag);
    tag.cn.forEach((word, pos) => CJK.test(word) && addWord(word, pos === 0 && !weak ? 'core' : 'syn', tag));
    if (tag.zh && CJK.test(tag.zh)) addWord(tag.zh, weak ? 'syn' : 'zh', tag);
    // “可莉（原神）”也能用“可莉”匹配；“玛修·基列莱特”也能用“玛修”匹配
    const core = tag.cn[0];
    const base = core?.replace(/\s*[（(][^）)]*[）)]\s*$/, '');
    if (!base || weak) continue;
    if (base !== core && CJK.test(base)) addWord(base, 'base', tag);
    const given = tag.cat === 4 && base.split(/[·・]/)[0];
    if (given && given !== base && given.length >= 2 && CJK.test(given)) addWord(given, 'base', tag);
  }

  store = { tags, byName, byAlias, words };
  return store;
}

const visible = (tag, nsfw) => nsfw || !tag.nsfw;

/**
 * 名称 / 别名 / 写法变体 → { tag, kind }。kind：exact 就是这个标签 / alias 别名或 Danbooru 已废弃的旧名 /
 * variant 连字符、单复数写法不同（cat-ears → cat_ears，twintail → twintails）
 */
function lookup(text) {
  const { byName, byAlias } = load();
  const key = normName(text).replace(/^artist:/, '');
  if (!key) return null;
  if (byName.has(key)) return { tag: byName.get(key), kind: 'exact' };
  if (byAlias.has(key)) return { tag: byAlias.get(key), kind: 'alias' };
  // 单数补成复数只对不是常用词的单个词做：pastel 本身就是常用词（pastel_colors），补成 pastels 就成了“色粉笔”
  const pluralize = key.includes('_') || !isKnownWord(key);
  for (const base of new Set([key, key.replace(/-/g, '_')])) {
    const variants = [
      base, base.replace(/ies$/, 'y'), base.replace(/es$/, ''), base.replace(/s$/, ''),
      ...(pluralize ? [`${base}s`, `${base}es`, base.replace(/y$/, 'ies')] : []),
    ];
    for (const variant of variants) {
      if (variant === key) continue;
      const tag = byName.get(variant) ?? byAlias.get(variant);
      if (tag) return { tag, kind: 'variant' };
    }
  }
  return null;
}

/** 按名称 / 别名 / 常见变体找标签 */
export const findTag = (text) => lookup(text)?.tag ?? null;

/** 名称 / 别名 / 变体都找不到时，再按拼写相近纠正（selafuku → serafuku） */
export function correctTag(text) {
  const found = lookup(text);
  if (found) return found;
  const tag = fixTypo(normName(text));
  return tag ? { tag, kind: 'typo' } : null;
}

// 拼错纠正只在作品数够多的标签里找（不含画师），越冷门越容易改错
const TYPO_MIN_POSTS = 500;
let typoIndex;
let vocabulary;

/**
 * 是不是标签名里出现过的英文单词（含单复数）。stars、spring、sharp 都是正常单词，只是本身不是标签，
 * 不能因为和 stairs、string、shark 差一个字母就改掉。
 */
function isKnownWord(word) {
  if (!vocabulary) {
    vocabulary = new Set();
    for (const tag of load().tags) {
      for (const w of tag.name.split(/[_()\-.:!?'/]+/)) if (w.length >= 3) vocabulary.add(w);
    }
  }
  return word.length < 3 || vocabulary.has(word) || vocabulary.has(word.replace(/e?s$/, '')) || vocabulary.has(`${word}s`);
}

/**
 * 编辑距离：同首字母、作品数够多的标签里找最接近的。条目里每个词都是认识的单词时不纠（那是正常英文，
 * 只是不是标签）；5 个字符以下不纠（太短容易改错）；10 个字符以下最多差 1 处、更长的差 2 处
 * （角色和作品名只允许差 1 处）；有两个差不多热门的候选就不改，免得改错。
 */
function fixTypo(key) {
  if (key.length < 5 || key.split('_').every(isKnownWord)) return null;
  if (!typoIndex) {
    typoIndex = new Map();
    for (const tag of load().tags) {
      if (tag.cat === 1 || tag.posts < TYPO_MIN_POSTS) continue;
      const bucket = typoIndex.get(tag.name[0]);
      bucket ? bucket.push(tag) : typoIndex.set(tag.name[0], [tag]);
    }
  }
  const max = key.length >= 10 ? 2 : 1;
  let best = null;
  let bestDist = max;
  let rival = null;
  for (const tag of typoIndex.get(key[0]) ?? []) { // 已按作品数降序
    const d = editDistance(key, tag.name, bestDist);
    if (d > bestDist || (tag.cat !== 0 && tag.cat !== 5 && d > 1)) continue;
    if (!best || d < bestDist) {
      best = tag;
      bestDist = d;
      rival = null;
    } else {
      rival ??= tag;
    }
  }
  return best && (!rival || rival.posts * 3 < best.posts) ? best : null;
}

/** 编辑距离，相邻两个字母对调算一步；超过 max 提前返回 max + 1 */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// 英文自然语言（NAI4 以后支持）的开头；这样开头的条目当句子，不纠正
const SENTENCE_START = /^(a|an|the|this|that|these|those|my|your|his|her|their|its|one|two|three|some)\s/i;

/** 像一个标签（而不是英文句子、artist: 这类带前缀的写法、NAI 质量词）才去纠正 */
function correctable(item) {
  return /[a-z]/i.test(item)
    && !/[:|{}[\]<>]/.test(item)
    && !/[.!?。]$/.test(item)
    && !SENTENCE_START.test(item)
    && !KEEP_AS_IS.has(item.toLowerCase().replace(/_/g, ' '))
    && item.split(/[\s_]+/).filter(Boolean).length <= 6;
}

/** 英文条目 → 标签：fix 时连拼错一起纠（只纠不超过 4 个词的短条目）；画师名一律不动 */
function resolveEnglish(item, fix) {
  if (!correctable(item)) return null;
  const words = item.split(/[\s_]+/).filter(Boolean).length;
  const hit = fix && words <= 4 ? correctTag(item) : lookup(item);
  return hit && hit.tag.cat !== 1 ? hit : null;
}

/**
 * 提示词里的一条英文 → 纠正后的写法；不用改、不该改（句子、带前缀、质量词、画师、认不出）时返回 null。
 * kind：format 只是写法统一（下划线换空格、大小写、去掉 \( 转义）/ alias / variant / typo
 */
export function correctPromptItem(text) {
  const item = text.trim();
  const hit = resolveEnglish(item, true);
  if (!hit) return null;
  const fixed = naiTagText(hit.tag);
  if (fixed === item) return null;
  return { text: fixed, kind: hit.kind === 'exact' ? 'format' : hit.kind };
}

/** NAI 写法：下划线换空格（颜文字除外），画师加 artist: 前缀 */
export function naiTagText(tag) {
  const text = /[a-z]/i.test(tag.name) ? tag.name.replace(/_/g, ' ') : tag.name;
  return tag.cat === 1 ? `artist:${text}` : text;
}

/**
 * 单个中文词 → 标签。顺序：预设直译 > 核心词 > 译名 > 普通同义词 > 去括号的核心词 > 结合上下文的角色。
 * 同一层里通用类优先（“赛博朋克”取 cyberpunk 而不是同名作品）；context 是本段已识别出的作品名，
 * 用来把“助手”这类只在角色同义词里出现的词，落到这个作品的角色上（“命运石之门的助手” → makise_kurisu）。
 */
function pickWord(word, nsfw, context) {
  const direct = DIRECT_WORDS.get(word);
  if (direct) return direct.split(',').map((t) => findTag(t) ?? { name: t.trim(), cat: 0, posts: 0, raw: true });
  const entry = load().words.get(word);
  if (!entry) return null;
  // 单字太容易撞上同名角色（“潮” → 舰娘“潮”），只认通用类；日常称呼要有作品上下文才认作角色
  const inContext = (t) => Boolean(context?.size) && t.cn.some((w) => context.has(w));
  const ok = (t) => visible(t, nsfw)
    && (word.length > 1 || t.cat === 0 || t.cat === 5)
    && (t.cat !== 4 || !COMMON_ROLES.has(word) || inContext(t));
  const general = (t) => ok(t) && (t.cat === 0 || t.cat === 5);
  const prefer = (list) => list.find(general) ?? list.find(ok);
  const hit = prefer(entry.core.filter((t) => t.cat !== 3 || ownsWord(entry, t))) ?? prefer(entry.zh) ?? workName(entry, ok)
    ?? (isGeneric(word) ? null : entry.syn.find(general) ?? entry.base.find(ok))
    ?? entry.syn.find((t) => ok(t) && t.cat === 4 && inContext(t));
  return hit ? [hit] : null;
}

/**
 * 作品名：不少作品的中文核心词是繁体或日文（蔚藍檔案），简体名只在同义词里，
 * 而且这个作品的几百个角色都带着它，看起来像泛称。只有 1~3 个作品标签带这个词时，认作作品名
 * （“游戏”“动画”这种挂在大量作品上的不算）。
 */
function workName(entry, ok) {
  const works = entry.syn.filter((t) => t.cat === 3);
  if (!works.length || works.length > 3) return undefined;
  return works.find((w) => ok(w) && ownsWord(entry, w, true));
}

/**
 * 这个词是不是真归这个作品：“原神”“蔚蓝档案”挂在几百个标签上，但大多是这个作品自己的角色
 * （xx_(genshin_impact)）；“动画”“动画风格”也挂在不少标签上，却是各种风格、作品都带的词，
 * 被某个作品当成了核心词或同义词（数据噪声），这时不认。核心词在词不泛的时候直接认。
 */
function ownsWord(entry, work, strict = false) {
  if (!strict && entry.syn.length < GENERIC_DF) return true;
  const own = entry.syn.filter((t) => t === work || t.name.endsWith(`_(${work.name})`)).length;
  return own / entry.syn.length >= 0.3;
}

/** 有几个作品标签带着这个词 */
function workCount(word) {
  const entry = load().words.get(word);
  if (!entry) return 0;
  return new Set([...entry.core, ...entry.zh, ...entry.syn, ...entry.base].filter((t) => t.cat === 3)).size;
}

/** 挂在大量标签上、又不是任何标签的核心词或译名，如“发型”“表情” */
function isGeneric(word) {
  const entry = load().words.get(word);
  return Boolean(entry && !entry.core.length && !entry.zh.length && entry.syn.length >= GENERIC_DF);
}

const isWord = (word) => DIRECT_WORDS.has(word) || load().words.has(word) || STOP_WORDS.has(word) || colorOf(word);

function colorOf(word) {
  const key = word.replace(/色$/, '');
  return COLORS[key] ? key : null;
}

/** 正向、逆向最大匹配都做一遍，取词少、单字少的那个（逆向优先） */
function segment(text, maxWord = MAX_WORD) {
  const run = (backward) => {
    const out = [];
    let i = backward ? text.length : 0;
    while (backward ? i > 0 : i < text.length) {
      let len = Math.min(maxWord, backward ? i : text.length - i);
      for (; len > 1; len--) {
        const word = backward ? text.slice(i - len, i) : text.slice(i, i + len);
        if (isWord(word)) break;
      }
      // 不是词典词的英文 / 数字连成一段，当一个英文标签处理
      if (len === 1 && LATIN.test(backward ? text[i - 1] : text[i])) {
        let j = i;
        if (backward) {
          while (j > 0 && LATIN_RUN.test(text[j - 1])) j--;
          len = i - j;
        } else {
          while (j < text.length && LATIN_RUN.test(text[j])) j++;
          len = j - i;
        }
      }
      if (backward) {
        out.unshift(text.slice(i - len, i));
        i -= len;
      } else {
        out.push(text.slice(i, i + len));
        i += len;
      }
    }
    return out;
  };
  const singles = (words) => words.filter((w) => w.length === 1 && !isWord(w)).length;
  const fwd = run(false);
  const bwd = run(true);
  if (fwd.length !== bwd.length) return fwd.length < bwd.length ? fwd : bwd;
  return singles(fwd) < singles(bwd) ? fwd : bwd;
}

/** 颜色 + 名词：“白色” + 水手服 → white_serafuku；“金色” + 长发 → blonde_hair + long_hair */
function combineColor(color, nextWord, nextTags) {
  const names = COLORS[color];
  const tryTag = (suffix) => names.map((c) => load().byName.get(`${c}_${suffix}`)).find(Boolean);
  if (HAIR_WORDS.has(nextWord)) return [tryTag('hair')].filter(Boolean);
  if (EYE_WORDS.has(nextWord)) return [tryTag('eyes')].filter(Boolean);
  if (!nextTags?.length || nextTags[0].raw) return null;
  const [first, ...rest] = nextTags;
  const combined = tryTag(first.name);
  if (combined) return [combined, ...rest];
  if (/(^|_)hair$/.test(first.name)) return [tryTag('hair'), first, ...rest].filter(Boolean);
  return null;
}

/**
 * 一段中文（可夹英文）→ 标签。短片段先整体当一个概念匹配，匹配不上再分词。
 * opts：{ nsfw, context（本段识别出的作品名）, fix（夹着的英文是否连拼错一起纠） }
 */
function convertCjk(text, opts, out) {
  if (text.length <= ATOMIC_MAX || (LATIN.test(text) && text.length <= MAX_WORD)) {
    for (const candidate of new Set([text, text.replace(PARTICLES, '')])) {
      const tags = candidate && pickWord(candidate, opts.nsfw, opts.context);
      if (tags) {
        out.push({ word: text, tags });
        return;
      }
    }
  }
  convertWords(segment(text), opts, out);
}

function convertWords(words, opts, out) {
  const { nsfw, context } = opts;
  let pending = '';
  const flush = () => {
    const leftover = [...pending].filter((c) => !LOCATIVES.has(c)).join('');
    if (leftover) out.push({ word: pending, tags: [] });
    pending = '';
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (STOP_WORDS.has(word)) {
      flush();
      continue;
    }
    if (!CJK.test(word)) {
      flush();
      if (LATIN.test(word) && !isWord(word)) out.push(englishTag(word.trim(), opts.fix));
      else if (isWord(word)) out.push({ word, tags: pickWord(word, nsfw, context) ?? [] });
      continue;
    }
    const color = colorOf(word);
    if (color) {
      flush();
      const next = words[i + 1];
      const combined = next && combineColor(color, next, pickWord(next, nsfw, context));
      if (combined?.length) {
        out.push({ word: word + next, tags: combined });
        i++;
      }
      continue;
    }
    const tags = pickWord(word, nsfw, context);
    if (tags) {
      flush();
      out.push({ word, tags });
    } else if (word.length === 1) {
      pending += word; // 单字没落到通用标签上，和相邻的单字拼起来算没识别
    } else if (word.length > 1 && !isGeneric(word)) {
      // 词典里有这个词但落不到合适的标签（如“双马尾少女”只是某个角色的别称），拆小再试；
      // 拆开也一个都认不出，就整个算作没识别
      const parts = [];
      convertWords(segment(word, word.length - 1), opts, parts);
      if (parts.some((p) => p.tags.length)) {
        flush();
        out.push(...parts);
      } else {
        pending += word;
      }
    } else {
      flush(); // 泛称（“发型”“表情”）不转换，也不算没识别
    }
  }
  flush();
}

/**
 * 整段文字 → 标签。中文按词典转换；英文片段按标签名规范化（fix 时连拼错一起纠），认不出的原样保留。
 * 返回 { tags: [{ name, text, cat, posts, cn, word }], unmatched: [中文片段], fixes: [{ from, to }] }
 */
export function convertText(text, { nsfw = false, fix = true } = {}) {
  const pieces = String(text ?? '')
    .replace(/([㐀-鿿])\s+(?=[㐀-鿿])/g, '$1,') // 中文词之间的空格也是分隔（同 DanbooruSearch）
    .split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
  const run = (context) => {
    const found = [];
    for (const piece of pieces) {
      if (CJK.test(piece)) convertCjk(piece, { nsfw, context, fix }, found);
      else if (LATIN.test(piece)) found.push(englishTag(piece, fix));
    }
    return found;
  };
  let found = run();
  // 识别出作品名的话，带上作品的各种中文名再转一遍，让只在角色别称里出现的词能落到这个作品的角色上
  const works = new Set(
    found.flatMap((f) => f.tags).filter((t) => t.cat === 3)
      .flatMap((t) => [...t.cn, t.zh]).filter((w) => w && CJK.test(w) && workCount(w) <= 3 && !COMMON_ROLES.has(w)),
  );
  if (works.size) found = run(works);

  const seen = new Set();
  const tags = [];
  const unmatched = [];
  const fixes = [];
  for (const { word, tags: list, fix: fixKind } of found) {
    if (!list.length) {
      unmatched.push(word);
      continue;
    }
    if (fixKind) fixes.push({ from: word, to: naiTagText(list[0]) });
    for (const tag of list) {
      const text = tag.raw ? tag.name : naiTagText(tag);
      if (seen.has(text)) continue;
      seen.add(text);
      tags.push({ name: tag.name, text, cat: tag.cat, posts: tag.posts, cn: tag.raw ? '' : tag.cn?.[0] || tag.zh || '', word });
    }
  }
  tags.sort((a, b) => SUBJECT_TAGS.test(b.name) - SUBJECT_TAGS.test(a.name));
  return { tags, unmatched, fixes };
}

/** 夹在中文里的英文：能确认是哪个标签就换成现行写法，认不出原样保留；fix 记下纠正的种类 */
function englishTag(text, fix) {
  const hit = resolveEnglish(text, fix);
  return {
    word: text,
    tags: [hit?.tag ?? { name: text, cat: 0, posts: 0, raw: true }],
    fix: hit && hit.kind !== 'exact' ? hit.kind : null,
  };
}

export const hasCjk = (text) => CJK.test(String(text ?? ''));

/**
 * 查词（提词器搜索框）：英文按名称 / 别名前缀和包含匹配，中文按同义词、译名、释义匹配，按作品数排序。
 * 分层同 Auto-NovelAI 的补全：精确 > 前缀 > 包含 > 释义。
 */
export function searchTags(query, { limit = 30, nsfw = false, categories } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const { tags } = load();
  const allow = (t) => visible(t, nsfw) && (!categories || categories.includes(t.cat));
  const layers = [[], [], [], []];
  const add = (layer, tag, match) => layers[layer].length < limit && layers[layer].push({ tag, match });

  if (hasCjk(q)) {
    for (const tag of tags) {
      if (!allow(tag)) continue;
      const names = tag.zh ? [...tag.cn, tag.zh] : tag.cn;
      if (names.includes(q)) add(names[0] === q ? 0 : 1, tag, 'cn');
      else if (names.some((n) => n.includes(q))) add(2, tag, 'cn');
      else if (tag.wiki.includes(q)) add(3, tag, 'wiki');
    }
  } else {
    const key = normName(q);
    for (const tag of tags) {
      if (!allow(tag)) continue;
      if (tag.name === key) add(0, tag, 'name');
      else if (tag.name.startsWith(key)) add(1, tag, 'name');
      else if (tag.aliases.some((a) => a.startsWith(key))) add(1, tag, 'alias');
      else if (tag.name.includes(key)) add(2, tag, 'name');
    }
  }
  return layers.flat().slice(0, limit).map(({ tag, match }) => ({ ...describe(tag), match }));
}

/** 已选标签 → 经常一起出现的标签（同 DanbooruSearch：各自的 NPMI 相加） */
export function relatedTags(names, { limit = 30, nsfw = false } = {}) {
  const { tags } = load();
  relatedStore ??= readGz('related.json.gz').related;
  const seeds = resolveSeeds(names);
  const exclude = new Set(seeds.map((t) => t.i));
  const scores = new Map();
  for (const seed of seeds) {
    const list = relatedStore[seed.i] ?? [];
    for (let k = 0; k < list.length; k += 2) {
      const j = list[k];
      if (exclude.has(j)) continue;
      const entry = scores.get(j) ?? { score: 0, sources: [] };
      entry.score += list[k + 1] / 1000;
      entry.sources.push(seed.name);
      scores.set(j, entry);
    }
  }
  return [...scores]
    .filter(([j]) => visible(tags[j], nsfw))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([j, { score, sources }]) => ({ ...describe(tags[j]), score: Math.round(score * 1000) / 1000, sources }));
}

/** 已选标签 → 擅长画这些的画师（同 DanbooruSearch：NPMI 相加，命中多个标签的有加成） */
export function recommendArtists(names, { limit = 20 } = {}) {
  artistStore ??= readGz('artists.json.gz');
  const { artists, tag_artists: tagArtists } = artistStore;
  const scores = new Map();
  for (const seed of resolveSeeds(names)) {
    const list = tagArtists[seed.i] ?? [];
    for (let k = 0; k < list.length; k += 2) {
      const entry = scores.get(list[k]) ?? { score: 0, sources: [] };
      entry.score += list[k + 1] / 1000;
      entry.sources.push(seed.name);
      scores.set(list[k], entry);
    }
  }
  const ranked = [...scores]
    .map(([a, { score, sources }]) => [a, score * (1 + 0.3 * (sources.length - 1)), sources])
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit);
  const top = ranked[0]?.[1] || 1;
  return ranked.map(([a, score, sources]) => {
    const [name, posts] = artists[a];
    const tag = findTag(name);
    return {
      name,
      text: `artist:${/[a-z]/i.test(name) ? name.replace(/_/g, ' ') : name}`,
      zh: tag?.zh || '',
      posts,
      score: Math.round((score / top) * 100),
      sources,
    };
  });
}

function resolveSeeds(names) {
  const seen = new Set();
  return (Array.isArray(names) ? names : [])
    .map((n) => findTag(String(n)))
    .filter((t) => t && !seen.has(t.i) && seen.add(t.i));
}

function describe(tag) {
  return {
    name: tag.name,
    text: naiTagText(tag),
    cat: tag.cat,
    category: CATEGORY_NAMES[tag.cat] ?? '其它',
    posts: tag.posts,
    nsfw: tag.nsfw,
    cn: [...new Set([...tag.cn, tag.zh].filter(Boolean))].slice(0, 4),
    wiki: tag.wiki,
  };
}
