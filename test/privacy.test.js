import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = ':memory:';
const { db } = await import('../src/db.js');
const { imageBase64, publicImageUrl, purgeExpiredImages, saveImage } = await import('../src/imageStore.js');
const { saveSettings } = await import('../src/settings.js');
const { scrub } = await import('../src/upstream.js');
const { addUpstreamKeys } = await import('../src/upstreamKeys.js');

const UPSTREAM_IMG = 'https://img.upstream-demo.com/img/2026-11-01/04-44-52-070896-b45c6e81.png';

test('图片链接是中继地址 + UUID，看不出上游', () => {
  const image = saveImage({ url: UPSTREAM_IMG }, 1);
  const url = publicImageUrl(image, 'https://relay.example.com');
  assert.match(url, /^https:\/\/relay\.example\.com\/v1\/img\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
  assert.doesNotMatch(url, /upstream-demo|2026-11-01|b45c6e81/);
  assert.equal(db.prepare('SELECT upstream_url FROM images WHERE id = ?').get(image.id).upstream_url, UPSTREAM_IMG);
});

test('过期的图片记录会被清掉', () => {
  const { id } = saveImage({ url: UPSTREAM_IMG }, 1);
  db.prepare('UPDATE images SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.ok(purgeExpiredImages() >= 1);
  assert.equal(db.prepare('SELECT 1 FROM images WHERE id = ?').get(id), undefined);
});

test('上游给 b64_json 的图片存成文件，同样给 UUID 链接，过期连文件一起删', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake image')]);
  const image = saveImage({ b64_json: png.toString('base64') }, 1);
  assert.equal(image.mime, 'image/png');
  assert.match(publicImageUrl(image, 'https://relay.example.com'), /\/v1\/img\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(await imageBase64(image), { mime: 'image/png', b64: png.toString('base64') });

  const { file } = db.prepare('SELECT file FROM images WHERE id = ?').get(image.id);
  const path = join(tmpdir(), 'nai-relay-images', file);
  assert.deepEqual(readFileSync(path), png);
  db.prepare('UPDATE images SET expires_at = ? WHERE id = ?').run(Date.now() - 1, image.id);
  purgeExpiredImages();
  assert.equal(existsSync(path), false);
});

test('url 字段里放 data URI 的按文件存，按文件头认格式', () => {
  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
  const image = saveImage({ url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }, 1);
  assert.equal(image.mime, 'image/jpeg');
  assert.match(publicImageUrl(image, 'https://relay.example.com'), /\.jpg$/);
});

test('后加的上游，域名也隐藏', () => {
  addUpstreamKeys({ keys: 'sk-studio0001', base_url: 'https://api.pixel-forge.studio/v1' });
  assert.equal(scrub('请到 img.pixel-forge.studio 查看'), '请到 *** 查看');
});

test('错误信息里的上游域名、网址、站名被隐藏', () => {
  addUpstreamKeys({ keys: 'sk-demo00001', base_url: 'https://api.upstream-demo.com/v1' });
  saveSettings({ hide_words: '某某站,Demo' });
  assert.equal(scrub('提示图 https://img.upstream-demo.com/img/a.png 请查看'), '提示图 *** 请查看');
  assert.equal(scrub('请到img.upstream-demo.com查看请求日志'), '请到***查看请求日志');
  assert.equal(scrub('API.UPSTREAM-DEMO.COM 维护中'), '*** 维护中');
  assert.equal(scrub('某某站共享额度已耗尽'), '***共享额度已耗尽');
  assert.equal(scrub('API 秘钥不存在、已禁用或已过期'), 'API 秘钥不存在、已禁用或已过期');
});

test('别的域名、邮箱、IP 也隐藏，普通字段名不误伤', () => {
  assert.equal(scrub('详见 docs.other-site.cn/help?id=1，或联系 admin@upstream-demo.com'), '详见 ***，或联系 ***');
  assert.equal(scrub('connect ECONNREFUSED 10.0.0.8:443'), 'connect ECONNREFUSED ***');
  assert.equal(scrub('body.size: 尺寸超出限制'), 'body.size: 尺寸超出限制');
  assert.equal(scrub('不允许使用模型 nai-diffusion-4-5-full'), '不允许使用模型 nai-diffusion-4-5-full');
});
