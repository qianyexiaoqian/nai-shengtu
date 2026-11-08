import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATA_DIR = ':memory:';
const { convertText, correctPromptItem, findTag, recommendArtists, relatedTags, searchTags } = await import('../src/tags.js');
const { assistPrompt } = await import('../src/promptAssist.js');
const { saveSettings } = await import('../src/settings.js');

const texts = (text, opts) => convertText(text, opts).tags.map((t) => t.text);

test('整句中文转标签：分词、停用词、颜色组合、人数标签排最前', () => {
  assert.deepEqual(texts('一个穿着白色水手服的双马尾少女在雨中奔跑，流着泪'), [
    '1girl', 'white serafuku', 'twintails', 'rain', 'running', 'tears',
  ]);
  assert.deepEqual(texts('猫娘女仆，金色长发，蓝色眼睛，看向镜头，上半身'), [
    'cat girl', 'maid', 'blonde hair', 'long hair', 'blue eyes', 'looking at viewer', 'upper body',
  ]);
});

test('角色和作品：去括号匹配角色名，作品名作为上下文找角色别称', () => {
  assert.deepEqual(texts('原神的可莉'), ['genshin impact', 'klee (genshin impact)']);
  assert.deepEqual(texts('命运石之门的助手'), ['steins;gate', 'makise kurisu']);
  // “先生”是日常称呼，没提蔚蓝档案就不认作它的角色
  assert.ok(!texts('偶像先生').some((t) => t.includes('blue archive')));
  assert.ok(texts('蔚蓝档案的先生').includes('sensei (blue archive)'));
});

test('普通词不落到冷门角色上，泛称不转换，单字不撞角色名', () => {
  assert.ok(!texts('精灵女战士').some((t) => t.includes('morino')));
  assert.ok(!texts('雨后潮湿的街道').some((t) => t.includes('kancolle')));
  assert.deepEqual(convertText('好看的发型').unmatched, []);
});

test('英文原样保留，只把能确认的别名换成现行标签；认不出的中文报告出来', () => {
  assert.deepEqual(texts('masterpiece, 1girl, 白发红瞳'), ['1girl', 'masterpiece', 'white hair', 'red eyes']);
  assert.equal(findTag('long hair').name, 'long_hair');
  assert.equal(findTag('Cat-Ears').name, 'cat_ears');
  assert.deepEqual(convertText('一只咕噜咕噜').unmatched, ['咕噜咕噜']);
});

test('不开 NSFW 时不转出、不搜出 NSFW 和敏感标签', () => {
  const sensitive = /(^|_)loli(_|$)/;
  assert.ok(searchTags('猫耳', { limit: 50 }).every((r) => !r.nsfw && !sensitive.test(r.name)));
  assert.ok(searchTags('猫耳', { limit: 100, nsfw: true }).some((r) => sensitive.test(r.name)));
});

test('查词：中文按同义词、英文按前缀', () => {
  assert.equal(searchTags('水手服')[0].name, 'serafuku');
  assert.equal(searchTags('twin')[0].name, 'twintails');
  assert.deepEqual(searchTags('水手服', { categories: [4] }).map((r) => r.cat).filter((c) => c !== 4), []);
});

test('关联推荐和推荐画师', () => {
  const related = relatedTags(['serafuku', 'rain']).map((r) => r.name);
  assert.ok(related.includes('school_uniform') && related.includes('holding_umbrella'));
  assert.ok(!related.includes('serafuku'));
  const artists = recommendArtists(['1girl', 'flat_color']);
  assert.equal(artists[0].score, 100);
  assert.match(artists[0].text, /^artist:/);
});

test('生图前的中文转换：英文和权重写法原样保留，权重套回转出的标签', () => {
  assert.deepEqual(assistPrompt('1girl, {{白色水手服}}, 1.3::下雨::, smile'), {
    prompt: '1girl, {{white serafuku}}, 1.3::rain::, smile', changed: true, converted: true, fixes: [], unmatched: [],
  });
  assert.deepEqual(assistPrompt('1girl, smile'), {
    prompt: '1girl, smile', changed: false, converted: false, fixes: [], unmatched: [],
  });
  saveSettings({ prompt_assist: '0' });
  assert.equal(assistPrompt('白色水手服').prompt, '白色水手服');
  saveSettings({ prompt_assist: '1' });
});

test('英文纠错：别名 / 废弃标签、单复数和连字符、明显拼错', () => {
  const fix = (text) => correctPromptItem(text);
  assert.deepEqual(fix('valentines'), { text: 'valentine', kind: 'alias' });
  assert.deepEqual(fix('ff7'), { text: 'final fantasy vii', kind: 'alias' });
  assert.deepEqual(fix('twintail'), { text: 'twintails', kind: 'alias' });
  assert.deepEqual(fix('cat-ears'), { text: 'cat ears', kind: 'variant' });
  assert.deepEqual(fix('multiple girl'), { text: 'multiple girls', kind: 'variant' });
  assert.deepEqual(fix('selafuku'), { text: 'serafuku', kind: 'typo' });
  assert.deepEqual(fix('school unifor'), { text: 'school uniform', kind: 'typo' });
  assert.deepEqual(fix('twintials'), { text: 'twintails', kind: 'typo' }); // 相邻字母对调
  assert.deepEqual(fix('hatsune mikku'), { text: 'hatsune miku', kind: 'typo' });
  assert.deepEqual(fix('Long_Hair'), { text: 'long hair', kind: 'format' });
  assert.deepEqual(fix('klee \\(genshin impact\\)'), { text: 'klee (genshin impact)', kind: 'format' });
});

test('英文纠错不碰：正常单词、句子、质量词、带前缀的写法、画师名、认不出的词', () => {
  for (const text of [
    'stars', 'spring', 'sharp', 'pastel', // 正常单词，只是本身不是标签，不能改成 stairs / string / shark / pastels
    'a girl standing in the rain', 'masterpiece', 'best quality', 'very aesthetic', 'no text',
    'artist:wlop', 'wlop', 'rating:general', 'zzqxq', 'long hair', '1girl',
  ]) {
    assert.equal(correctPromptItem(text), null, text);
  }
});

test('生图前的英文纠错：权重套回去、记下改了什么；没改的不重新排版；可以关掉', () => {
  assert.deepEqual(assistPrompt('1girl, selafuku, {{twintail}}, 1.2::cat-ears::, a girl standing in the rain'), {
    prompt: '1girl, serafuku, {{twintails}}, 1.2::cat ears::, a girl standing in the rain',
    changed: true,
    converted: false,
    fixes: [
      { from: 'selafuku', to: 'serafuku' }, { from: 'twintail', to: 'twintails' }, { from: 'cat-ears', to: 'cat ears' },
    ],
    unmatched: [],
  });
  // 只是下划线换空格，提示词会规范，但不算“修正”
  assert.deepEqual(assistPrompt('long_hair, smile').fixes, []);
  assert.equal(assistPrompt('long_hair, smile').prompt, 'long hair, smile');
  // 什么都不用改时原样返回，连逗号后的空格都不动
  assert.equal(assistPrompt('1girl,smile').prompt, '1girl,smile');
  // 中英混写时夹着的英文也纠
  assert.deepEqual(assistPrompt('穿着selafuku的少女').fixes, [{ from: 'selafuku', to: 'serafuku' }]);

  saveSettings({ prompt_fix: '0' });
  assert.equal(assistPrompt('1girl, selafuku').prompt, '1girl, selafuku');
  saveSettings({ prompt_fix: '1' });
});
