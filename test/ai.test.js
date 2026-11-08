import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { afterEach, test } from 'node:test';

process.env.DATA_DIR = ':memory:';
const { db } = await import('../src/db.js');
const { saveSettings } = await import('../src/settings.js');
const { DEFAULT_SYSTEM_PROMPT, optimizePrompt, parseOutput, priceNow, usageCost, wantsAi } = await import('../src/aiPrompt.js');
const { runTool } = await import('../src/aiTools.js');
const { executeGeneration, prepareGeneration } = await import('../src/generate.js');
const { createKey, updateKey } = await import('../src/keys.js');
const { handlePromptApi } = await import('../src/promptTools.js');
const { seedModels, addModels } = await import('../src/models.js');
const { parsePromptText } = await import('../src/params.js');
const { addUpstreamKeys } = await import('../src/upstreamKeys.js');
const { aiSummary, getStats } = await import('../src/usage.js');

const PRICES = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 }; // 元 / 百万 tokens
const AI_CONFIG = {
  ai_mode: 'auto', ai_base_url: 'https://ai.example.com/v1', ai_api_key: 'sk-ai-test-key', ai_model: 'test-model',
  ai_price_input: 2, ai_price_output: 8, ai_price_cache_read: 0.5, ai_price_cache_write: 2.5,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  saveSettings({ ai_tools: '0', ai_reasoning_effort: '' });
});

/**
 * 假 AI 接口 + 假上游。ai(body, round) 返回 { status?, message?, usage? }：默认回一段标签；
 * 上游记下收到的请求体。
 */
function fakeServices(ai = () => ({})) {
  const seen = { ai: [], upstream: [] };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).startsWith('https://ai.example.com')) {
      seen.ai.push({ url: String(url), auth: init.headers.Authorization, body: structuredClone(body) });
      const r = ai(body, seen.ai.length);
      const status = r.status ?? 200;
      const payload = status === 200
        ? { choices: [{ message: r.message ?? { role: 'assistant', content: '1girl, smile' } }], usage: r.usage ?? { prompt_tokens: 800, completion_tokens: 60 } }
        : { error: { message: r.error ?? 'rate limited' } };
      return Response.json(payload, { status });
    }
    seen.upstream.push(body);
    return Response.json({ created: 1, data: [{ url: 'https://up.example.com/img/a.png' }] });
  };
  return seen;
}

const reply = (content, usage) => () => ({ message: { role: 'assistant', content }, usage });
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

seedModels();
addModels([{ id: 'nai-diffusion-3' }]);
addUpstreamKeys({ keys: 'sk-upstream-key-1', base_url: 'https://up.example.com/v1' });

test('成本：OpenAI / DeepSeek / Claude 几种 usage 写法', () => {
  assert.equal(usageCost({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }, PRICES).cost,
    (600 * 2 + 400 * 0.5 + 200 * 8) / 1e6);
  assert.equal(usageCost({ prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 900 }, PRICES).cacheRead, 900);
  const claude = usageCost({ prompt_tokens: 3000, completion_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 500 }, PRICES);
  assert.deepEqual(claude, { input: 3000, output: 100, cacheRead: 500, cacheWrite: 2000, cost: (500 * 2 + 500 * 0.5 + 2000 * 2.5 + 100 * 8) / 1e6 });
  assert.equal(usageCost(undefined, PRICES).cost, 0);
});

test('拆 AI 的回复：标签行 + 画面短句；去掉思考、代码块、开头标签、负面提示词和解释', () => {
  assert.deepEqual(parseOutput('<think>想一想</think>\n```\nPrompt: 1girl, smile, rain, city\n```'), { tags: '1girl, smile, rain, city', sentences: '' });
  assert.deepEqual(
    parseOutput('2girls, character a, character b, holding hands, park\nOn the left side of the image is Character A, with short black hair. Character A holds Character B\'s hand.'),
    { tags: '2girls, character a, character b, holding hands, park', sentences: 'On the left side of the image is Character A, with short black hair. Character A holds Character B\'s hand.' },
  );
  assert.deepEqual(parseOutput('"1girl, solo, smile, outdoors"\n\nThis prompt describes a girl in the park.'), { tags: '1girl, solo, smile, outdoors', sentences: '' });
  assert.equal(parseOutput('1girl, smile, rain, night\nNegative prompt: lowres, bad hands').tags, '1girl, smile, rain, night');
  assert.equal(parseOutput('- 1girl\n- smile\n- rain').tags, '1girl, smile, rain');
  assert.equal(parseOutput('1girl, cup of tea, sitting in a cafe, window.').tags, '1girl, cup of tea, sitting in a cafe, window');
});

test('内置系统提示词带上了借鉴 DanbooruSearch 规范的规则', () => {
  for (const rule of ['upper body drops skirts', 'looking at viewer vs looking away', 'never interleave', 'On the left side of the image', 'at most four tags']) {
    assert.ok(DEFAULT_SYSTEM_PROMPT.includes(rule), rule);
  }
});

test('什么时候调 AI：开关、自动模式的判断、--ai / --noai', () => {
  assert.equal(wantsAi('原神的可莉'), false); // 还没配置
  saveSettings(AI_CONFIG);
  assert.equal(wantsAi('原神的可莉'), true);
  assert.equal(wantsAi('a girl standing in the rain at night'), true);
  assert.equal(wantsAi('1girl, smile, rain'), false);
  assert.equal(wantsAi('1girl, smile', true), true);
  assert.equal(wantsAi('原神的可莉', false), false);
  saveSettings({ ai_mode: 'always' });
  assert.equal(wantsAi('1girl, smile'), true);
  saveSettings({ ai_mode: 'off' });
  assert.equal(wantsAi('原神的可莉', true), false);
  saveSettings({ ai_mode: 'auto' });

  const { prompt, params } = parsePromptText('原神的可莉 --noai --ar 2:3');
  assert.equal(prompt, '原神的可莉');
  assert.deepEqual(params, { ai: false, aspect_ratio: '2:3' });
});

test('工具：整段转标签、核对标签和拼写、关联推荐、推荐画师', () => {
  const scene = runTool('search_tags', JSON.stringify({ query: '原神的可莉，开心地笑', mode: 'scene' }));
  assert.deepEqual(scene.tags.map((t) => t.tag), ['genshin impact', 'klee (genshin impact)', 'happy', 'smile']);
  const lookup = runTool('search_tags', { query: 'selafuku, twintails, 猫耳', mode: 'lookup' });
  assert.deepEqual(lookup.results.map((r) => [r.term, r.tag, r.status]), [
    ['selafuku', 'serafuku', 'corrected (typo)'], ['twintails', 'twintails', 'exists'], ['猫耳', undefined, undefined],
  ]);
  assert.equal(lookup.results[2].candidates[0].tag, 'cat ears');
  const related = runTool('get_related_tags', { tags: ['klee (genshin impact)'], limit: 10 });
  assert.equal(related.results.length, 10);
  assert.match(runTool('get_artist_recommendations', { tags: ['1girl', 'flat color'] }).results[0].tag, /^artist:/);
  assert.match(runTool('nope', {}).error, /unknown tool/);
  assert.match(runTool('search_tags', '{bad json').error, /not valid JSON/);
});

test('调用 AI：带上系统提示词、目标模型和词典参考，按 usage 记成本', async () => {
  const seen = fakeServices(reply('1girl, klee (genshin impact), smile', { prompt_tokens: 1000, completion_tokens: 50 }));
  const before = aiSummary().calls;
  const r = await optimizePrompt('原神的可莉', { hints: 'genshin impact, klee (genshin impact)', source: 'test', targetModel: 'nai-diffusion-4-5-full' });
  assert.equal(r.prompt, '1girl, klee (genshin impact), smile');
  assert.equal(r.cost, (1000 * 2 + 50 * 8) / 1e6);
  const sent = seen.ai[0];
  assert.equal(sent.url, 'https://ai.example.com/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer sk-ai-test-key');
  assert.equal(sent.body.model, 'test-model');
  assert.equal(sent.body.tools, undefined); // 没开查标签库
  assert.match(sent.body.messages[1].content, /原神的可莉[\s\S]*NAI 4 or newer[\s\S]*klee \(genshin impact\)/);
  const row = db.prepare('SELECT * FROM ai_calls WHERE id = ?').get(r.callId);
  assert.deepEqual([row.status, row.cost, row.rounds, row.tool_calls], ['success', r.cost, 1, 0]);
  assert.equal(aiSummary().calls, before + 1);
});

test('查标签库模式：AI 调工具、拿到结果再写，多轮用量累加计费', async () => {
  saveSettings({ ai_tools: '1' });
  const seen = fakeServices((body, round) => (round === 1
    ? {
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          toolCall('call_1', 'search_tags', { query: '原神的可莉在雨中', mode: 'scene' }),
          toolCall('call_2', 'search_tags', { query: 'selafuku', mode: 'lookup' }),
        ],
      },
      usage: { prompt_tokens: 1500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } },
    }
    : { message: { role: 'assistant', content: '1girl, klee (genshin impact), genshin impact, rain' }, usage: { prompt_tokens: 2500, completion_tokens: 30 } }));

  const r = await optimizePrompt('原神的可莉在雨中', { source: 'test' });
  assert.equal(r.prompt, '1girl, klee (genshin impact), genshin impact, rain');
  assert.deepEqual([r.rounds, r.toolCalls], [2, 2]);
  // 第一轮带工具定义，系统提示词加了工具说明
  assert.deepEqual(seen.ai[0].body.tools.map((t) => t.function.name), ['search_tags', 'get_related_tags', 'get_artist_recommendations']);
  assert.match(seen.ai[0].body.messages[0].content, /Tag database tools/);
  // 第二轮把工具结果按 tool_call_id 发回去
  const toolMessages = seen.ai[1].body.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['call_1', 'call_2']);
  assert.match(toolMessages[0].content, /klee \(genshin impact\)/);
  assert.match(toolMessages[1].content, /serafuku/);
  // 两轮用量加起来算钱
  assert.equal(r.usage.input, 4000);
  assert.equal(r.cost, ((500 + 2500) * 2 + 1000 * 0.5 + 70 * 8) / 1e6);
  const row = db.prepare('SELECT rounds, tool_calls, cost FROM ai_calls WHERE id = ?').get(r.callId);
  assert.deepEqual([row.rounds, row.tool_calls, row.cost], [2, 2, r.cost]);
});

test('模型不支持工具调用：自动去掉工具重来，并注明', async () => {
  saveSettings({ ai_tools: '1' });
  const seen = fakeServices((body) => (body.tools
    ? { status: 400, error: 'tools are not supported by this model' }
    : { message: { role: 'assistant', content: '1girl, smile, rain' } }));
  const r = await optimizePrompt('下雨天的女孩', { source: 'test' });
  assert.equal(r.prompt, '1girl, smile, rain');
  assert.match(r.note, /不支持工具调用/);
  assert.equal(seen.ai.length, 2);
  assert.doesNotMatch(seen.ai[1].body.messages[0].content, /Tag database tools/);
});

test('一直调工具不出结果：到上限的那一轮不许再调工具', async () => {
  saveSettings({ ai_tools: '1' });
  const seen = fakeServices((body) => (body.tool_choice === 'none'
    ? { message: { role: 'assistant', content: '1girl, smile' } }
    : { message: { role: 'assistant', content: null, tool_calls: [toolCall(`c${Math.random()}`, 'search_tags', { query: 'smile', mode: 'lookup' })] } }));
  const r = await optimizePrompt('微笑', { source: 'test' });
  assert.equal(r.prompt, '1girl, smile');
  assert.equal(r.rounds, 5);
  assert.equal(seen.ai.at(-1).body.tool_choice, 'none');
});

test('思考强度：原样传 reasoning_effort，要思考时不传 temperature，调工具时把思考过程带回去', async () => {
  saveSettings({ ai_tools: '1', ai_reasoning_effort: 'high' });
  const seen = fakeServices((body, round) => (round === 1
    ? { message: { role: 'assistant', content: null, reasoning_content: '先查一下标签', tool_calls: [toolCall('call_1', 'search_tags', { query: 'smile', mode: 'lookup' })] } }
    : { message: { role: 'assistant', content: '1girl, smile' } }));
  await optimizePrompt('微笑的女孩', { source: 'test' });
  assert.equal(seen.ai[0].body.reasoning_effort, 'high');
  assert.equal('temperature' in seen.ai[0].body, false);
  assert.equal(seen.ai[1].body.messages.find((m) => m.role === 'assistant').reasoning_content, '先查一下标签');

  saveSettings({ ai_tools: '0', ai_reasoning_effort: 'none' }); // DeepSeek 关掉思考
  const off = fakeServices(reply('1girl, smile'));
  await optimizePrompt('微笑的女孩', { source: 'test' });
  assert.deepEqual([off.ai[0].body.reasoning_effort, off.ai[0].body.temperature], ['none', 0.4]);

  saveSettings({ ai_reasoning_effort: '' });
  const unset = fakeServices(reply('1girl, smile'));
  await optimizePrompt('微笑的女孩', { source: 'test' });
  assert.equal('reasoning_effort' in unset.ai[0].body, false);
});

test('闲时半价：开了开关、又不在北京时间工作日高峰时才减半', () => {
  const s = { aiOffpeak: true, aiPrices: PRICES };
  const at = (time) => Date.parse(time);
  const half = { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 1.25 };
  assert.equal(priceNow(s, at('2026-11-02T10:30:00+08:00')), PRICES); // 周一上午
  assert.equal(priceNow(s, at('2026-11-02T15:00:00+08:00')), PRICES); // 周一下午
  assert.deepEqual(priceNow(s, at('2026-11-02T12:30:00+08:00')), half); // 午休
  assert.deepEqual(priceNow(s, at('2026-11-02T18:00:00+08:00')), half); // 下班
  assert.deepEqual(priceNow(s, at('2026-11-01T10:30:00+08:00')), half); // 周日
  assert.equal(priceNow({ ...s, aiOffpeak: false }, at('2026-11-01T10:30:00+08:00')), PRICES);
});

test('AI 接口报错：记一条失败记录，抛出错误', async () => {
  fakeServices(() => ({ status: 429 }));
  await assert.rejects(optimizePrompt('原神的可莉', { source: 'test' }), { status: 502, code: 'ai_failed' });
  const row = db.prepare('SELECT * FROM ai_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status, 'error');
  assert.match(row.error, /429/);
});

test('生图走 AI 优化：标签再纠错，NAI4+ 接上短句，AI 调用挂到生图日志上，成本进统计', async () => {
  const key = createKey({ name: 'AI 测试' });
  const seen = fakeServices(reply(
    'Prompt: 1girl, selafuku, twintail, rain\nThe girl stands in the center of the image with rain falling around her.',
    { prompt_tokens: 500, completion_tokens: 40 },
  ));
  const ctx = { key, baseUrl: 'http://relay', ip: '' };
  const { prompt, params } = parsePromptText('一个穿水手服的双马尾少女在雨中');
  const job = prepareGeneration(ctx, 'chat', { model: 'nai-diffusion-5-full' }, prompt, params);
  assert.equal(job.useAi, true);
  await executeGeneration(job);

  assert.equal(seen.upstream[0].prompt,
    '1girl, serafuku, twintails, rain, The girl stands in the center of the image with rain falling around her.');
  const log = db.prepare('SELECT id, final_prompt FROM logs ORDER BY id DESC LIMIT 1').get();
  assert.equal(log.final_prompt, seen.upstream[0].prompt);
  assert.equal(db.prepare('SELECT log_id FROM ai_calls WHERE id = ?').get(job.ai.callId).log_id, log.id);
  const stats = getStats();
  assert.ok(stats.ai.today.cost >= job.ai.cost);
  assert.ok(stats.byKey.find((k) => k.key_id === key.id).ai_cost > 0);
});

test('NAI3 只要标签：告诉 AI 不写句子，写了也不用', async () => {
  const key = createKey({ name: 'NAI3' });
  const seen = fakeServices(reply('1girl, smile, rain, night\nThe girl smiles in the rain.'));
  const { prompt, params } = parsePromptText('雨夜里微笑的女孩');
  const job = prepareGeneration({ key, baseUrl: 'http://relay', ip: '' }, 'images', { model: 'nai-diffusion-3' }, prompt, params);
  await executeGeneration(job);
  assert.match(seen.ai[0].body.messages[1].content, /NAI 3 \(tags only/);
  assert.equal(seen.upstream[0].prompt, '1girl, smile, rain, night');
});

test('AI 失败就退回词典转换，照常出图', async () => {
  const key = createKey({ name: 'AI 失败测试' });
  const seen = fakeServices(() => ({ status: 500 }));
  const { prompt, params } = parsePromptText('原神的可莉');
  const job = prepareGeneration({ key, baseUrl: 'http://relay', ip: '' }, 'images', {}, prompt, params);
  await executeGeneration(job);
  assert.equal(job.ai, null);
  assert.equal(seen.upstream[0].prompt, 'genshin impact, klee (genshin impact)');
});

test('--noai 跳过，纯标签自动模式下不调 AI', async () => {
  const key = createKey({ name: '不走 AI' });
  const seen = fakeServices();
  for (const text of ['原神的可莉 --noai', '1girl, smile, rain']) {
    const { prompt, params } = parsePromptText(text);
    await executeGeneration(prepareGeneration({ key, baseUrl: 'http://relay', ip: '' }, 'chat', {}, prompt, params));
  }
  assert.equal(seen.ai.length, 0);
  assert.equal(seen.upstream.length, 2);
});

test('生效模型：限定后只对勾选的模型优化，别的模型写了 --ai 也不走', async () => {
  saveSettings({ ai_apply_models: 'nai-diffusion-5-full' });
  try {
    assert.equal(wantsAi('原神的可莉', undefined, 'nai-diffusion-5-full'), true);
    assert.equal(wantsAi('原神的可莉', undefined, 'nai-diffusion-3'), false);
    assert.equal(wantsAi('原神的可莉', true, 'nai-diffusion-3'), false);

    const key = createKey({ name: '生效模型' });
    const seen = fakeServices();
    const { prompt, params } = parsePromptText('原神的可莉 --ai');
    const job = prepareGeneration({ key, baseUrl: 'http://relay', ip: '' }, 'images', { model: 'nai-diffusion-3' }, prompt, params);
    assert.equal(job.useAi, false);
    await executeGeneration(job);
    assert.equal(seen.ai.length, 0);
    assert.equal(seen.upstream[0].prompt, 'genshin impact, klee (genshin impact)'); // 照常走词典转换
  } finally {
    saveSettings({ ai_apply_models: '' });
  }
  assert.equal(wantsAi('原神的可莉', undefined, 'nai-diffusion-3'), true); // 不限定 = 所有模型
});

test('调用密钥关了 AI 优化：出图不调 AI（--ai 也不行），提词器的 AI 按钮 403；打开后照常', async () => {
  const key = createKey({ name: '不要 AI', ai_optimize: false });
  assert.equal(key.ai_optimize, 0);
  const seen = fakeServices();
  const { prompt, params } = parsePromptText('原神的可莉 --ai');
  const job = prepareGeneration({ key, baseUrl: 'http://relay', ip: '' }, 'images', {}, prompt, params);
  assert.equal(job.useAi, false);
  await executeGeneration(job);
  assert.equal(seen.ai.length, 0);
  assert.equal(seen.upstream[0].prompt, 'genshin impact, klee (genshin impact)'); // 照常走词典转换

  const askAi = (sk) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ text: '原神的可莉' }))]);
    Object.assign(req, { method: 'POST', headers: { authorization: `Bearer ${sk}` }, socket: { remoteAddress: '127.0.0.1' } });
    let sent;
    const res = { writeHead: () => res, setHeader() {}, end: (data) => { sent = data; } };
    return handlePromptApi(req, res, '/ai', new URLSearchParams()).then(() => sent);
  };
  await assert.rejects(askAi(key.key), { status: 403, code: 'ai_not_enabled_for_key' });

  const enabled = updateKey(key.id, { ai_optimize: true });
  assert.equal(enabled.ai_optimize, 1);
  const again = prepareGeneration({ key: enabled, baseUrl: 'http://relay', ip: '' }, 'images', {}, prompt, params);
  assert.equal(again.useAi, true);
  assert.ok(await askAi(key.key));
  assert.equal(seen.ai.length, 1);
  assert.equal(createKey({ name: '默认' }).ai_optimize, 1); // 不传就是开
});
