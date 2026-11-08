// 生图前整理提示词：
//  - 中文转成 Danbooru 标签（后台“中文转标签”开关）；
//  - 英文标签纠错（后台“英文自动修正”开关）：别名 / 已废弃的旧标签换成现行标签，单复数、连字符写法统一，
//    明显拼错的按拼写相近纠正。英文句子、artist: 这类带前缀的写法、NAI 质量词、画师名、认不出的词原样保留。
// 条目外层的 {} [] 和 1.2::…:: 权重会套回处理后的标签上。
import { getSettings } from './settings.js';
import { convertText, correctPromptItem, hasCjk } from './tags.js';

const ITEM_SPLIT = /[,，\n\r]+/;
const BRACES = /^([{[]+)(.*?)([}\]]+)$/s;
const NUMERIC_WEIGHT = /^(-?\d+(?:\.\d+)?)::(.*?)::$/s;

/**
 * 返回 { prompt, changed, converted, fixes: [{ from, to }], unmatched }。
 * converted：有中文被转换；fixes：英文被纠正的条目（只是下划线换空格这种写法统一的不算）；
 * unmatched：没能识别的中文片段，转换后丢弃（NAI 看不懂中文）。什么都没动时原样返回，不重新排版。
 */
export function assistPrompt(text) {
  const original = String(text ?? '');
  const { promptAssist, promptAssistNsfw, promptFix } = getSettings();
  const result = { prompt: original, changed: false, converted: false, fixes: [], unmatched: [] };
  if (!(promptAssist && hasCjk(original)) && !promptFix) return result;

  const items = [];
  let touched = false;
  for (const raw of original.split(ITEM_SPLIT)) {
    const item = raw.trim();
    if (!item) continue;
    const { inner, wrap } = unwrap(item);
    if (hasCjk(inner)) {
      if (!promptAssist) {
        items.push(item);
        continue;
      }
      const converted = convertText(inner, { nsfw: promptAssistNsfw, fix: promptFix });
      items.push(...converted.tags.map((t) => wrap(t.text)));
      result.unmatched.push(...converted.unmatched);
      result.fixes.push(...converted.fixes);
      result.converted = touched = true;
      continue;
    }
    const fixed = promptFix && correctPromptItem(inner);
    if (fixed) {
      items.push(wrap(fixed.text));
      if (fixed.kind !== 'format') result.fixes.push({ from: inner, to: fixed.text });
      touched = true;
    } else {
      items.push(item);
    }
  }
  if (!touched) return result;

  result.prompt = [...new Set(items)].join(', ');
  result.changed = result.prompt !== original.trim();
  return result;
}

/** 拆出条目外层的权重写法，返回里面的文字和套回去的函数 */
function unwrap(item) {
  const braces = BRACES.exec(item);
  if (braces) return { inner: braces[2], wrap: (t) => `${braces[1]}${t}${braces[3]}` };
  const numeric = NUMERIC_WEIGHT.exec(item);
  if (numeric) return { inner: numeric[2], wrap: (t) => `${numeric[1]}::${t}::` };
  return { inner: item, wrap: (t) => t };
}
