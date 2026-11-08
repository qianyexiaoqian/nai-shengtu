import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aspectToSize, parsePromptText, toUpstreamPayload } from '../src/params.js';

test('行内参数被拆出，提示词保持干净', () => {
  const { prompt, params } = parsePromptText('1girl, smile --ar 16:9 --steps 28 --scale 5.5 --seed 42 --no lowres, blurry');
  assert.equal(prompt, '1girl, smile');
  assert.deepEqual(params, {
    aspect_ratio: '16:9',
    steps: 28,
    scale: 5.5,
    seed: 42,
    negative_prompt: 'lowres, blurry',
  });
});

test('--no 写在中间时只取到下一个参数为止', () => {
  const { prompt, params } = parsePromptText('cat --no bad hands, text --size 832x1216');
  assert.equal(prompt, 'cat');
  assert.equal(params.negative_prompt, 'bad hands, text');
  assert.equal(params.size, '832x1216');
});

test('不认识或不合法的参数原样保留', () => {
  const { prompt, params } = parsePromptText('cat --foo bar --steps many');
  assert.equal(prompt, 'cat --foo bar --steps many');
  assert.deepEqual(params, {});
});

test('Negative prompt 行之后都算负面提示词', () => {
  const { prompt, params } = parsePromptText('1girl, portrait\nNegative prompt: lowres,\nblurry');
  assert.equal(prompt, '1girl, portrait');
  assert.equal(params.negative_prompt, 'lowres,\nblurry');

  assert.equal(parsePromptText('猫\n负面：模糊').params.negative_prompt, '模糊');
});

test('宽高比换算', () => {
  assert.equal(aspectToSize('2:3'), '832x1216');
  assert.equal(aspectToSize('16：9'), '1344x768');
  assert.equal(aspectToSize('1:2'), '704x1408');
  assert.equal(aspectToSize('auto'), undefined);
  assert.equal(aspectToSize('0:1'), undefined);
});

test('上游请求体：行内参数优先于请求体，size=auto 被丢弃', () => {
  const body = {
    model: 'gpt-image-1',
    size: 'auto',
    n: 9,
    negative: 'from body',
    quality: 'hd',
    response_format: 'b64_json',
  };
  const inline = { aspect_ratio: '3:2', negative_prompt: 'inline' };
  assert.deepEqual(toUpstreamPayload(body, 'cat', inline, 'nai-diffusion-5-full'), {
    model: 'nai-diffusion-5-full',
    prompt: 'cat',
    n: 4,
    negative_prompt: 'inline',
    size: '1216x832',
  });
});

test('上游请求体：显式 size 优先于 aspect_ratio / image_config', () => {
  const size = (body) => toUpstreamPayload(body, 'x', {}, 'm').size;
  assert.equal(size({ size: '1024x1024', aspect_ratio: '9:16' }), '1024x1024');
  assert.equal(size({ image_config: { aspect_ratio: '9:16' } }), '768x1344');
  assert.equal(size({}), undefined);
});
