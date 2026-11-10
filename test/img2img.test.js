import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, afterEach, test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

process.env.DATA_DIR = ':memory:';
const { anlasCost } = await import('../src/anlas.js');
const { handleChat } = await import('../src/chat.js');
const { clientIp, closeSignal, readJson, requestBaseUrl, sendError } = await import('../src/http.js');
const { ImageError, decodeImage, encodePng, imageInfo, resizeCover } = await import('../src/imageCodec.js');
const { coverPng } = await import('../src/imageJobs.js');
const { publicImageUrl, saveImage } = await import('../src/imageStore.js');
const { handleImageEdits, handleImages } = await import('../src/images.js');
const { authenticate, createKey } = await import('../src/keys.js');
const { addModels, seedModels } = await import('../src/models.js');
const { handleNaiGenerate } = await import('../src/naiApi.js');
const { blockedAddress, loadReferenceImage } = await import('../src/refImage.js');
const { listLogs } = await import('../src/usage.js');
const { addUpstreamKeys, listUpstreamKeys, saveAccount, updateUpstreamKey } = await import('../src/upstreamKeys.js');
const { writeZip } = await import('../src/zip.js');

// Pillow（libjpeg-turbo）存的小 JPEG，和 Pillow 解出来的 RGBA 的 sha256（EXIF 方向已转正）
const JPEGS = JSON.parse(readFileSync(new URL('./fixtures/jpeg.json', import.meta.url), 'utf8'));
const OUT_PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('out')]);
const OPUS = { level: 3, tier: 'Opus', active: true, anlas: 5000, usage_negative: false, usage_percent: 40 };

/** width×height 的测试图：左半红、右半蓝 */
function testPng(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * width + x) * 4);
  }
  return encodePng({ width, height, data });
}
const dataUri = (png) => `data:image/png;base64,${png.toString('base64')}`;
const pixel = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/** 文件头没问题、压缩数据坏了的 PNG（只看文件头看不出来） */
function corruptPng() {
  const png = testPng(16, 16);
  for (let i = 43; i < 60; i++) png[i] ^= 0x5a; // IDAT 的数据从第 41 字节开始，前两字节是 zlib 头
  return png;
}

/** 1×1 灰度 PNG，IDAT 用给的压缩数据 */
function pngWithIdat(idat) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  return Buffer.concat([testPng(1, 1).subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 只有表头、没有图像数据的渐进式 JPEG（width×height，一个分量），scans 是每段扫描头 SOS 的内容 */
function hollowJpeg(width, height, scans) {
  const seg = (marker, bytes) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, Buffer.from(bytes)]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xdb, [0, ...new Array(64).fill(1)]),
    seg(0xc2, [8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]),
    seg(0xc4, [0x10, 1, ...new Array(15).fill(0), 0x01]),
    seg(0xc4, [0x00, 1, ...new Array(15).fill(0), 0x00]),
    ...scans.map((sos) => seg(0xda, sos)),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// ---------- 解码、缩放 ----------

test('JPEG 解码和 libjpeg（Pillow）逐字节一致：4:2:0、渐进式 4:2:2、重启标记、灰度、EXIF 方向', () => {
  for (const [name, f] of Object.entries(JPEGS)) {
    const img = decodeImage(Buffer.from(f.jpeg, 'base64'));
    assert.deepEqual([img.width, img.height], [f.width, f.height], name);
    assert.equal(createHash('sha256').update(img.data).digest('hex'), f.sha256, name);
  }
});

test('PNG 编码再解码无损；等比居中裁切缩放：宽图裁成方图只留中间；WebP、GIF、超大图报 ImageError', () => {
  const wide = { width: 200, height: 100, data: new Uint8Array(200 * 100 * 4) };
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 200; x++) wide.data.set(x < 50 ? [255, 0, 0, 255] : x >= 150 ? [0, 0, 255, 255] : [0, 255, 0, 255], (y * 200 + x) * 4);
  }
  const square = resizeCover(wide, 64, 64);
  assert.deepEqual([square.width, square.height], [64, 64]);
  assert.deepEqual(pixel(square, 32, 32), [0, 255, 0, 255]);
  for (const [x, y] of [[0, 0], [63, 63]]) {
    const [r, g, b] = pixel(square, x, y);
    assert.ok(g > 200 && r < 40 && b < 40, `(${x},${y}) 应该是中间的绿色`);
  }
  const back = decodeImage(encodePng(square));
  assert.ok(Buffer.from(back.data).equals(Buffer.from(square.data)));

  assert.throws(() => decodeImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), { name: 'ImageError', message: /WebP/ });
  assert.throws(() => decodeImage(Buffer.from('GIF89a\x01\0\x01\0')), { name: 'ImageError', message: /GIF/ });
  assert.throws(() => decodeImage(Buffer.from('hello')), ImageError);
  // 头里写 6000×5000（3000 万像素），不用真解就拒绝
  const huge = testPng(1, 1);
  huge.writeUInt32BE(6000, 16);
  huge.writeUInt32BE(5000, 20);
  assert.throws(() => decodeImage(huge), { message: /太大/ });
});

test('恶意图片很快报错、不撑爆内存：PNG 解压炸弹、不合规的扫描参数、扫描段太多；没有数据的扫描一下就跳过', () => {
  // 1×1 的 PNG，IDAT 解压出来是 8 MB 的 0：解到该有的大小就停
  let started = performance.now();
  assert.throws(() => decodeImage(pngWithIdat(deflateSync(Buffer.alloc(8 * 1024 * 1024)))), { name: 'ImageError', message: /数据损坏/ });
  assert.ok(performance.now() - started < 1000);

  assert.throws(() => decodeImage(hollowJpeg(3000, 2000, [[1, 1, 0x00, 1, 255, 0x00]])), { message: /数据损坏/ }); // Se = 255
  assert.throws(() => decodeImage(hollowJpeg(3000, 2000, [[1, 1, 0x00, 0, 63, 0x00]])), { message: /数据损坏/ }); // DC 扫描带 AC
  assert.throws(() => decodeImage(hollowJpeg(3000, 2000, new Array(100).fill([1, 1, 0x00, 1, 63, 0x00]))), { message: /扫描段太多/ });
  started = performance.now();
  const hollow = decodeImage(hollowJpeg(3000, 2000, [[1, 1, 0x00, 0, 0, 0x00], ...new Array(18).fill([1, 1, 0x00, 1, 63, 0x10])]));
  assert.deepEqual([hollow.width, hollow.height], [3000, 2000]);
  assert.ok(performance.now() - started < 2000, `${performance.now() - started} ms`);
});

test('文件头：宽高（JPEG 按 EXIF 方向转正）和像素上限，不解像素；图片线程缩放成目标尺寸的 PNG，数据坏了那时才报', async () => {
  assert.deepEqual(imageInfo(testPng(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(imageInfo(Buffer.from(JPEGS.orient6.jpeg, 'base64')), { width: 21, height: 37 });
  assert.deepEqual(imageInfo(Buffer.from(JPEGS.progressive422.jpeg, 'base64')), { width: 37, height: 21 });
  assert.deepEqual(imageInfo(corruptPng()), { width: 16, height: 16 });
  assert.throws(() => imageInfo(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), { message: /WebP/ });
  assert.throws(() => imageInfo(Buffer.from('ffd8ffe000104a464946', 'hex')), { message: /JPEG 不完整/ });

  // 300×200 盖满 64×128：取中间 100×200 那一条，左边一半红、右边一半蓝
  const out = decodeImage(await coverPng(testPng(300, 200), 64, 128));
  assert.deepEqual([out.width, out.height], [64, 128]);
  assert.deepEqual(pixel(out, 5, 64), [255, 0, 0, 255]);
  assert.deepEqual(pixel(out, 58, 64), [0, 0, 255, 255]);
  await assert.rejects(coverPng(corruptPng(), 64, 64), ImageError);
});

test('图片线程排队：排满了报忙；请求断开了，还在排队的直接去掉', async () => {
  const png = testPng(8, 8);
  const controller = new AbortController();
  // 一下子来 40 张：线程（1～3 个）各接一张，排队 32 张，剩下的报忙；第 20 张排着队时请求断开
  const results = Array.from({ length: 40 }, (_, i) =>
    coverPng(png, 8, 8, i === 20 ? controller.signal : undefined).then(() => 'ok', (err) => err.code));
  controller.abort();
  const codes = await Promise.all(results);
  assert.deepEqual([codes[0], codes[20], codes[39]], ['ok', 'aborted', 'image_busy']);
  assert.equal(codes.filter((c) => c === 'ok' || c === 'image_busy').length, 39);
  assert.equal(await coverPng(png, 8, 8, controller.signal).catch((err) => err.code), 'aborted');
});

test('参考图：Buffer、裸 base64、data URI 都能读；格式不对、太大、内网链接报 400', async () => {
  const png = testPng(30, 20);
  for (const input of [png, png.toString('base64'), dataUri(png), `  ${dataUri(png)}\n`]) {
    const ref = await loadReferenceImage(input);
    assert.deepEqual([ref.width, ref.height], [30, 20]);
    assert.ok(Buffer.isBuffer(ref.bytes));
  }
  // 中继自己出的图的链接直接从库里取，不去下载（这里的域名根本连不上）
  const stored = saveImage({ b64_json: testPng(48, 32).toString('base64') }, 1);
  const own = await loadReferenceImage(publicImageUrl(stored, 'https://relay.invalid'));
  assert.deepEqual([own.width, own.height], [48, 32]);

  const bad = { status: 400, code: 'invalid_image' };
  await assert.rejects(loadReferenceImage('not an image!'), bad);
  await assert.rejects(loadReferenceImage({ url: 'x' }), bad);
  await assert.rejects(loadReferenceImage('data:image/png,abc'), { ...bad, message: /base64/ });
  await assert.rejects(loadReferenceImage(Buffer.from('GIF89a\x01\0\x01\0')), { ...bad, message: /GIF/ });
  await assert.rejects(loadReferenceImage(Buffer.alloc(16 * 1024 * 1024)), { ...bad, message: /太大/ });
  await assert.rejects(loadReferenceImage('ftp://example.com/a.png'), bad);
  for (const url of ['http://127.0.0.1:1/a.png', 'http://localhost:1/a.png', 'http://169.254.169.254/latest/meta-data', 'http://[::1]:1/a.png', 'http://2130706433/a.png']) {
    await assert.rejects(loadReferenceImage(url, 'messages'), { ...bad, param: 'messages', message: /内网或本机/ }, url);
  }
});

test('内网地址判断：本机、私网、链路本地、CGNAT、保留段、IPv6 本地和映射地址都拦', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '192.0.0.8', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::127.0.0.1', 'fd00::1', 'fe80::1', 'fec0::1', 'ff02::1', '100::1', 'not-an-ip',
    // NAT64、6to4 里内嵌的内网 IPv4（解析结果和网址里都是十六进制写法），本地 NAT64、Teredo 整段
    '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b:1::1', '2002:7f00:1::', '2002:a9fe:a9fe::1',
    '2001:0:4136:e378::1']) {
    assert.equal(blockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.128.0.1', '1.1.1.1', '2001:4860:4860::8888', '64:ff9b::8.8.8.8',
    '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8']) {
    assert.equal(blockedAddress(ip), false, ip);
  }
});

test('Anlas：图生图按重绘强度打折、每张至少 2；不在 Opus 免费范围里', () => {
  const shape = { width: 832, height: 1216, steps: 28, n: 1 };
  assert.equal(anlasCost('nai-diffusion-4-5-full', shape, OPUS).total, 0);
  const full = anlasCost('nai-diffusion-4-5-full', { ...shape, img2img: true, strength: 0.99 }, OPUS);
  const seven = anlasCost('nai-diffusion-4-5-full', { ...shape, img2img: true, strength: 0.7 }, OPUS);
  assert.deepEqual([seven.total, seven.free], [14, false]);
  assert.ok(full.total > seven.total);
  assert.match(seven.why, /图生图不在 Opus 的免费范围内/);
  assert.equal(anlasCost('nai-diffusion-4-5-full', { ...shape, img2img: true, strength: 0.01 }, OPUS).total, 2);
});

// ---------- 接口 ----------

seedModels();
addModels([{ id: 'nai-diffusion-4-5-full' }]);
addUpstreamKeys({ keys: 'pst-img2img0001', type: 'novelai', name: '官方', free_only: false });
addUpstreamKeys({ keys: 'pst-img2img0002', type: 'novelai', name: '只出免费' });
addUpstreamKeys({ keys: 'sk-compat000001', base_url: 'https://api.example-upstream.com/v1', name: '兼容' });
for (const k of listUpstreamKeys()) if (k.type === 'novelai') saveAccount(k.id, OPUS);
const relayKey = createKey({ name: '图生图' }).key;

/** 只留下这几把上游秘钥启用 */
function only(...names) {
  for (const k of listUpstreamKeys()) updateUpstreamKey(k.id, { enabled: names.includes(k.name) });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 假上游：官方的回 ZIP，OpenAI 兼容的回 b64_json；记下请求体，multipart 的另记下各部分名字和 image 部分 */
function fakeUpstream() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    const call = { url: String(url), token: init.headers?.Authorization, multipart: init.body instanceof FormData };
    if (call.multipart) {
      call.body = JSON.parse(await init.body.get('request').text());
      call.parts = [...init.body.keys()];
      const image = init.body.get('image');
      if (image) call.image = Buffer.from(await image.arrayBuffer());
    } else {
      call.body = JSON.parse(init.body);
    }
    calls.push(call);
    return /generate-image/.test(url)
      ? new Response(writeZip([{ name: 'image_0.png', data: OUT_PNG }]), { headers: { 'Content-Type': 'application/zip' } })
      : Response.json({ created: 1, data: [{ b64_json: OUT_PNG.toString('base64') }] });
  };
  return calls;
}

// 和 server.js 一样的路由，只挂这几个接口
const withKeyAndBody = (handler) => async (req, res) => {
  const ctx = { key: authenticate(req), baseUrl: requestBaseUrl(req), ip: clientIp(req), signal: closeSignal(res) };
  await handler(res, await readJson(req), ctx);
};
const routes = {
  '/v1/chat/completions': withKeyAndBody(handleChat),
  '/v1/images/generations': withKeyAndBody(handleImages),
  '/v1/images/edits': handleImageEdits,
  '/ai/generate-image': handleNaiGenerate,
};
const server = http.createServer(async (req, res) => {
  try {
    await routes[req.url](req, res);
  } catch (err) {
    if (res.headersSent) res.end();
    else sendError(res, err);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const BASE = `http://127.0.0.1:${server.address().port}`;

const post = (path, body, headers = {}) =>
  realFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${relayKey}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });

const NAI_BODY = {
  input: '1girl, smile, very aesthetic, masterpiece, no text',
  model: 'nai-diffusion-4-5-full',
  action: 'img2img',
  parameters: { params_version: 3, width: 832, height: 1216, scale: 6, steps: 23, seed: 777, n_samples: 1, sampler: 'k_euler_ancestral' },
};

test('NovelAI 格式 JSON 图生图（V4.5）：参考图缩放到出图尺寸放进 parameters.image，strength / noise / 种子照官方', async () => {
  only('官方');
  const calls = fakeUpstream();
  const res = await post('/ai/generate-image', {
    ...NAI_BODY,
    parameters: { ...NAI_BODY.parameters, image: testPng(400, 600).toString('base64'), strength: 0.5, noise: 0.1, extra_noise_seed: 1, color_correct: false },
  }, { Accept: 'application/json' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).images[0].seed, 777);

  const { action, parameters: p } = calls[0].body;
  assert.equal(calls[0].multipart, false);
  assert.equal(action, 'img2img');
  assert.deepEqual([p.width, p.height, p.steps, p.strength, p.noise, p.extra_noise_seed, p.color_correct], [832, 1216, 23, 0.5, 0.1, 777, false]);
  assert.equal(p.image_cache_secret_key, undefined);
  const sent = decodeImage(Buffer.from(p.image, 'base64'));
  assert.deepEqual([sent.width, sent.height], [832, 1216]);
  assert.equal(listLogs().items[0].img2img, 0.5);
});

test('网页端 V5 的 multipart：图片单独一部分、parameters.image 写名字；转给官方时同样这么放，带缓存键', async () => {
  only('官方');
  const calls = fakeUpstream();
  const form = new FormData();
  form.append('image', new Blob([testPng(512, 768)], { type: 'image/png' }), 'blob');
  const request = {
    ...NAI_BODY,
    model: 'nai-diffusion-5-full',
    parameters: { ...NAI_BODY.parameters, params_version: 4, image: 'image', image_cache_secret_key: 'from-client', strength: 0.6 },
  };
  form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }), 'blob');
  const res = await post('/ai/generate-image', form);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');

  const [call] = calls;
  assert.equal(call.multipart, true);
  assert.deepEqual(call.parts, ['image', 'request']);
  assert.equal(call.body.action, 'img2img');
  assert.equal(call.body.parameters.image, 'image');
  assert.match(call.body.parameters.image_cache_secret_key, /^[0-9a-f]{64}$/);
  assert.equal(call.body.parameters.strength, 0.6);
  assert.equal(call.body.parameters.color_correct, true);
  const sent = decodeImage(call.image);
  assert.deepEqual([sent.width, sent.height], [832, 1216]);
});

test('NovelAI 格式报 400：multipart 里没有引用的部分、局部重绘、Vibe、文生图带图、没带参考图、参考图坏了', async () => {
  only('官方');
  const calls = fakeUpstream();
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({ ...NAI_BODY, parameters: { ...NAI_BODY.parameters, image: 'image' } })]), 'blob');
  const missing = await post('/ai/generate-image', form);
  assert.deepEqual([missing.status, (await missing.json()).message], [400, 'multipart 请求里没有名为 image 的图片部分']);

  const image = testPng(64, 64).toString('base64');
  const cases = [
    [{ ...NAI_BODY, action: 'infill', parameters: { ...NAI_BODY.parameters, image, mask: image } }, /局部重绘（infill）/],
    [{ ...NAI_BODY, parameters: { ...NAI_BODY.parameters, image, reference_image_multiple_cached: [{ data: 'ref' }] } }, /Vibe/],
    [{ ...NAI_BODY, action: 'generate', parameters: { ...NAI_BODY.parameters, image } }, /action 要写 img2img/],
    [{ ...NAI_BODY, parameters: { ...NAI_BODY.parameters } }, /要带参考图/],
    [{ ...NAI_BODY, parameters: { ...NAI_BODY.parameters, image: Buffer.from('not a png at all').toString('base64') } }, /不是 PNG 或 JPEG/],
  ];
  for (const [body, message] of cases) {
    const res = await post('/ai/generate-image', body);
    const json = await res.json();
    assert.equal(res.status, 400, json.message);
    assert.match(json.message, message);
  }
  assert.equal(calls.length, 0);
});

test('OpenAI 格式：聊天里的 image_url、images/generations 的 image、images/edits（multipart 和 JSON）都按图生图出', async () => {
  only('官方');
  const calls = fakeUpstream();

  const chat = await post('/v1/chat/completions', {
    model: 'nai-diffusion-4-5-full',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'old' }, { type: 'image_url', image_url: { url: dataUri(testPng(90, 90)) } }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: '1girl --strength 0.4' }, { type: 'image_url', image_url: { url: dataUri(testPng(300, 450)) } }] },
    ],
  });
  const content = (await chat.json()).choices[0].message.content;
  assert.match(content, /!\[image\]\(/);
  assert.match(content, /图生图：参考图 300x450 → 832x1216，重绘强度 0\.4/);
  assert.deepEqual([calls[0].body.action, calls[0].body.parameters.strength], ['img2img', 0.4]);

  const gen = await post('/v1/images/generations', {
    model: 'nai-diffusion-4-5-full', prompt: 'cat', image: dataUri(testPng(200, 200)), strength: 0.3, response_format: 'b64_json',
  });
  assert.equal((await gen.json()).data[0].b64_json, OUT_PNG.toString('base64'));
  const p = calls[1].body.parameters;
  assert.deepEqual([calls[1].body.action, p.width, p.height, p.strength, p.noise], ['img2img', 1024, 1024, 0.3, 0]);

  const form = new FormData();
  form.append('model', 'nai-diffusion-4-5-full');
  form.append('prompt', 'dog');
  form.append('strength', '0.55');
  form.append('image[]', new Blob([testPng(120, 80)], { type: 'image/png' }), 'ref.png');
  const edit = await post('/v1/images/edits', form);
  assert.equal(edit.status, 200);
  assert.deepEqual([calls[2].body.action, calls[2].body.parameters.strength, calls[2].body.parameters.width], ['img2img', 0.55, 1216]);

  const json = await post('/v1/images/edits', { model: 'nai-diffusion-4-5-full', prompt: 'dog', images: [{ image_url: dataUri(testPng(80, 120)) }] });
  assert.equal(json.status, 200);
  assert.deepEqual([calls[3].body.parameters.strength, calls[3].body.parameters.width, calls[3].body.parameters.height], [0.7, 832, 1216]);

  const masked = new FormData();
  masked.append('prompt', 'dog');
  masked.append('image', new Blob([testPng(64, 64)]), 'a.png');
  masked.append('mask', new Blob([testPng(64, 64)]), 'm.png');
  const mask = await post('/v1/images/edits', masked);
  assert.deepEqual([mask.status, (await mask.json()).error.code], [400, 'unsupported_mask']);
  const none = await post('/v1/images/edits', { prompt: 'dog' });
  assert.deepEqual([none.status, (await none.json()).error.param], [400, 'image']);
  assert.equal(calls.length, 4);
});

test('额度用完先报额度，不碰参考图；参考图数据坏了报 400，记一条失败日志、不算在哪把上游秘钥上、不发请求', async () => {
  only('官方');
  const calls = fakeUpstream();
  const limited = createKey({ name: '一张额度', quota_images: 1 }).key;
  const asLimited = (body) => post('/v1/images/generations', body, { Authorization: `Bearer ${limited}` });
  assert.equal((await asLimited({ model: 'nai-diffusion-4-5-full', prompt: 'cat' })).status, 200);
  const quota = await asLimited({ model: 'nai-diffusion-4-5-full', prompt: 'cat', image: dataUri(corruptPng()) });
  assert.deepEqual([quota.status, (await quota.json()).error.code], [429, 'insufficient_quota']);

  const bad = await post('/v1/images/generations', { model: 'nai-diffusion-4-5-full', prompt: 'cat', image: dataUri(corruptPng()) });
  assert.deepEqual([bad.status, (await bad.json()).error.code], [400, 'invalid_image']);
  const [row] = listLogs().items;
  assert.deepEqual([row.status, row.img2img, row.upstream_key_name], ['error', 0.7, null]);
  assert.match(row.error, /PNG/);
  assert.equal(calls.length, 1);
});

test('只有 OpenAI 兼容的上游 → 400 img2img_unsupported；官方秘钥只出免费图 → 400 img2img_not_free；都不发请求', async () => {
  const calls = fakeUpstream();
  const body = { model: 'nai-diffusion-4-5-full', prompt: 'cat', image: dataUri(testPng(64, 64)) };
  only('兼容');
  const compat = await post('/v1/images/generations', body);
  assert.deepEqual([compat.status, (await compat.json()).error.code], [400, 'img2img_unsupported']);
  only('只出免费');
  const free = await post('/v1/images/generations', body);
  assert.deepEqual([free.status, (await free.json()).error.code], [400, 'img2img_not_free']);
  // 账号状态查不到时也是这个原因（不是“免费额度用完”）
  const freeId = listUpstreamKeys().find((k) => k.name === '只出免费').id;
  saveAccount(freeId, null, '查询失败', Date.now() + 1000);
  const unknown = await post('/v1/images/generations', body);
  assert.deepEqual([unknown.status, (await unknown.json()).error.code], [400, 'img2img_not_free']);
  saveAccount(freeId, OPUS, null, Date.now() + 2000);
  // 付费的官方秘钥嫌单张太贵（调小就能出）、另一把只出免费图：报太贵，不说不能图生图
  const paid = listUpstreamKeys().find((k) => k.name === '官方');
  updateUpstreamKey(paid.id, { max_pixels: 0, max_steps: 0 });
  only('官方', '只出免费');
  const big = await post('/v1/images/generations', { ...body, model: 'nai-diffusion-5-full', size: '2048x2048', steps: 50, strength: 0.99 });
  assert.deepEqual([big.status, (await big.json()).error.code], [400, 'too_expensive']);
  updateUpstreamKey(paid.id, { max_pixels: 1048576, max_steps: 28 });
  // 两种都有时图生图走官方，文生图照常
  only('官方', '兼容');
  assert.equal((await post('/v1/images/generations', body)).status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generate-image/);
});

test('轮到的秘钥出图上限不一样（尺寸和预先缩放的不同）：先放回秘钥、按它的尺寸重新缩放，再排上去发', async () => {
  // 头一把（id 小）只能出 512×512 以内，优先级高的那把能出 1024×1024：预先按头一把缩放，轮到的却是优先级高的
  const small = listUpstreamKeys().find((k) => k.name === '官方');
  updateUpstreamKey(small.id, { max_pixels: 262144 });
  addUpstreamKeys({ keys: 'pst-img2img0003', type: 'novelai', name: '官方优先', free_only: false, priority: 5 });
  saveAccount(listUpstreamKeys().find((k) => k.name === '官方优先').id, OPUS);
  only('官方', '官方优先');
  const calls = fakeUpstream();
  const res = await post('/v1/images/generations', { model: 'nai-diffusion-4-5-full', prompt: 'cat', size: '832x1216', image: dataUri(testPng(400, 600)) });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'Bearer pst-img2img0003');
  const p = calls[0].body.parameters;
  const sent = decodeImage(Buffer.from(p.image, 'base64'));
  assert.deepEqual([p.width, p.height, sent.width, sent.height], [832, 1216, 832, 1216]);
  updateUpstreamKey(small.id, { max_pixels: 1048576 });
});
