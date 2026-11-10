import { crc32, deflateSync, inflateSync } from 'node:zlib';

// 图生图的参考图：零依赖地解码、裁切缩放、再编码成 PNG。只做用得到的：
// 解 PNG（各种色彩类型、位深、隔行）和 JPEG（基线、渐进式，带 EXIF 方向），等比居中裁切后缩放到出图尺寸，编 PNG。
// 图片在内存里都是 RGBA（每像素 4 字节）的 { width, height, data }。
export const MAX_PIXELS = 24_000_000; // 解码后的像素上限：再大内存吃不消（解一张 2400 万像素的图要几百 MB）

export class ImageError extends Error {
  name = 'ImageError';
}

const isPng = (buf) => buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
const isJpeg = (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

export function decodeImage(buf) {
  if (isPng(buf)) return decodePng(buf);
  if (isJpeg(buf)) return decodeJpeg(buf);
  throw formatError(buf);
}

/**
 * 只看文件头：是不是 PNG / JPEG、宽高（JPEG 按 EXIF 方向转正后的）、在不在像素上限内。不解像素，很快，主线程里用；
 * 真正解码（数据损坏在那时才报）在图片线程里缩放时做。
 */
export function imageInfo(buf) {
  if (isPng(buf)) {
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new ImageError('参考图 PNG 不完整');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    checkSize(width, height);
    return { width, height };
  }
  if (!isJpeg(buf)) throw formatError(buf);
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff || buf[offset + 1] === 0xff) {
      offset++; // 不是标记，或者是标记前的填充字节
      continue;
    }
    const marker = buf[offset + 1];
    offset += 2;
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buf.readUInt16BE(offset);
    const segment = buf.subarray(offset + 2, offset + length);
    if (marker === 0xe1 && segment.toString('latin1', 0, 6) === 'Exif\0\0') {
      orientation = exifOrientation(segment.subarray(6));
    } else if (isFrameMarker(marker)) {
      const { width, height } = frameHeader(segment, marker);
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    offset += length;
  }
  throw new ImageError('参考图 JPEG 不完整');
}

function formatError(buf) {
  const kind = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
    ? 'WebP'
    : buf.subarray(0, 3).toString('latin1') === 'GIF' ? 'GIF' : null;
  return new ImageError(kind ? `参考图暂不支持 ${kind}，请换成 PNG 或 JPEG` : '参考图不是 PNG 或 JPEG 图片');
}

function checkSize(width, height) {
  if (!width || !height) throw new ImageError('参考图尺寸不对');
  if (width * height > MAX_PIXELS) {
    throw new ImageError(`参考图太大（${width}x${height}），最多 ${MAX_PIXELS / 10_000} 万像素，请缩小后再传`);
  }
}

// ---------- PNG ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buf) {
  let p = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const chunks = [];
  while (p + 8 <= buf.length) {
    const length = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + length);
    if (type === 'IHDR') {
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
    p += 12 + length;
  }
  if (!header || !chunks.length) throw new ImageError('参考图 PNG 不完整');
  const { width, height, depth, color, interlace } = header;
  const channels = PNG_CHANNELS[color];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (color === 3 && !palette)) throw new ImageError('参考图 PNG 格式不支持');
  checkSize(width, height);
  let raw;
  try {
    // 解压后该有多大是定的（每行一个过滤字节加像素数据）：超出的不解，防止几 MB 的文件解压出几十 GB 把内存撑爆
    raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: pngDataSize(width, height, channels, depth, interlace) + 65536 });
  } catch {
    throw new ImageError('参考图 PNG 数据损坏');
  }

  const out = new Uint8Array(width * height * 4);
  const bpp = Math.max(1, (channels * depth) >> 3);
  const maxValue = (1 << depth) - 1;
  // 16 位的取完整值和透明色比，再取高 8 位；1/2/4 位的灰度放大到 0～255
  const sample = (row, i) => {
    if (depth === 8) return row[i];
    if (depth === 16) return (row[i * 2] << 8) | row[i * 2 + 1];
    const bit = i * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxValue;
  };
  const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / maxValue));
  const transparentGray = color === 0 && transparency?.length >= 2 ? transparency.readUInt16BE(0) : -1;
  const transparentRgb = color === 2 && transparency?.length >= 6
    ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)]
    : null;

  let pos = 0;
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const passWidth = Math.ceil((width - x0) / dx);
    const passHeight = Math.ceil((height - y0) / dy);
    if (passWidth <= 0 || passHeight <= 0) continue;
    const stride = Math.ceil((passWidth * channels * depth) / 8);
    let prev = new Uint8Array(stride);
    let cur = new Uint8Array(stride);
    for (let y = 0; y < passHeight; y++) {
      if (pos + 1 + stride > raw.length) throw new ImageError('参考图 PNG 数据不完整');
      const filter = raw[pos++];
      cur.set(raw.subarray(pos, pos + stride));
      pos += stride;
      unfilter(filter, cur, prev, bpp);
      for (let x = 0; x < passWidth; x++) {
        const o = ((y0 + y * dy) * width + x0 + x * dx) * 4;
        let r;
        let g;
        let b;
        let a = 255;
        if (color === 3) {
          const index = sample(cur, x);
          r = palette[index * 3] ?? 0;
          g = palette[index * 3 + 1] ?? 0;
          b = palette[index * 3 + 2] ?? 0;
          if (transparency && index < transparency.length) a = transparency[index];
        } else if (color === 0 || color === 4) {
          const v = sample(cur, x * channels);
          r = g = b = to8(v);
          if (color === 4) a = to8(sample(cur, x * 2 + 1));
          else if (v === transparentGray) a = 0;
        } else {
          const vr = sample(cur, x * channels);
          const vg = sample(cur, x * channels + 1);
          const vb = sample(cur, x * channels + 2);
          r = to8(vr);
          g = to8(vg);
          b = to8(vb);
          if (color === 6) a = to8(sample(cur, x * 4 + 3));
          else if (transparentRgb && vr === transparentRgb[0] && vg === transparentRgb[1] && vb === transparentRgb[2]) a = 0;
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
      [prev, cur] = [cur, prev];
    }
  }
  return { width, height, data: out };
}

/** 解压后的 PNG 数据有多少字节：每一行（隔行的按 7 遍分别算）一个过滤字节加这一行的像素 */
function pngDataSize(width, height, channels, depth, interlace) {
  let size = 0;
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const passWidth = Math.ceil((width - x0) / dx);
    const passHeight = Math.ceil((height - y0) / dy);
    if (passWidth > 0 && passHeight > 0) size += passHeight * (1 + Math.ceil((passWidth * channels * depth) / 8));
  }
  return size;
}

function unfilter(filter, cur, prev, bpp) {
  const n = cur.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) cur[i] += cur[i - bpp];
      return;
    case 2:
      for (let i = 0; i < n; i++) cur[i] += prev[i];
      return;
    case 3:
      for (let i = 0; i < n; i++) cur[i] += ((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1;
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      return;
    default:
      throw new ImageError('参考图 PNG 数据损坏');
  }
}

/** RGBA → PNG（不隔行，每行用 Sub 过滤） */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 1;
    for (let i = 0; i < stride; i++) raw[dst + 1 + i] = data[row + i] - (i >= 4 ? data[row + i - 4] : 0);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// ---------- JPEG（基线 SOF0/SOF1 和渐进式 SOF2，霍夫曼编码；不支持算术编码、无损、12 位、CMYK） ----------

// 之字形顺序第 k 个系数在 8×8 块里的位置
const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);
// 整数 IDCT 用的 13 位定点常数（libjpeg jidctint.c 的 islow）
const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;
// YCbCr → RGB 查表，同 libjpeg jdcolor.c（16 位定点）
const CR_R = new Int32Array(256);
const CB_B = new Int32Array(256);
const CR_G = new Int32Array(256);
const CB_G = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  const x = i - 128;
  CR_R[i] = (91881 * x + 32768) >> 16;
  CB_B[i] = (116130 * x + 32768) >> 16;
  CR_G[i] = -46802 * x;
  CB_G[i] = -22554 * x + 32768;
}
// 扫描段数上限：正常的渐进式 JPEG 十来段，太多的是故意拖慢解码的。
// 每段扫描都要把它的块走一遍，所以再按“走过的块数”限制：最多相当于把整张图的块走 MAX_PASSES 遍（libjpeg 默认的渐进式约 5 遍）
const MAX_SCANS = 100;
const MAX_PASSES = 20;
// SOF0 / SOF1 基线、SOF2 渐进式之外的帧（无损、分层、算术编码）不支持
const isFrameMarker = (marker) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function decodeJpeg(buf) {
  const quantTables = [];
  const dcTables = [];
  const acTables = [];
  let frame = null;
  let resetInterval = 0;
  let adobeTransform = null;
  let orientation = 1;
  let offset = 2;
  let scans = 0;
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    offset += 2;
    if (marker === 0xff) {
      offset--; // 填充字节
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (offset + 2 > buf.length) break;
    const length = buf.readUInt16BE(offset);
    const segment = buf.subarray(offset + 2, offset + length);
    const next = offset + length;
    if (marker === 0xe1 && segment.toString('latin1', 0, 6) === 'Exif\0\0') {
      orientation = exifOrientation(segment.subarray(6));
    } else if (marker === 0xee && segment.toString('latin1', 0, 5) === 'Adobe' && segment.length >= 12) {
      adobeTransform = segment[11];
    } else if (marker === 0xdb) {
      readQuantTables(segment, quantTables);
    } else if (marker === 0xc4) {
      readHuffmanTables(segment, dcTables, acTables);
    } else if (isFrameMarker(marker)) {
      if (frame) throw new ImageError('参考图 JPEG 数据损坏'); // 一张图只有一个帧头
      frame = readFrame(segment, marker);
    } else if (marker === 0xdd) {
      resetInterval = segment.readUInt16BE(0);
    } else if (marker === 0xda) {
      if (!frame) throw new ImageError('参考图 JPEG 数据损坏');
      if (++scans > MAX_SCANS) throw new ImageError('参考图 JPEG 的扫描段太多，请另存为普通 JPEG 或 PNG');
      const scan = readScanHeader(segment, frame, dcTables, acTables);
      offset = decodeScan(buf, next, frame, scan, resetInterval);
      continue;
    }
    offset = next;
  }
  if (!frame || !scans) throw new ImageError('参考图 JPEG 不完整');
  return applyOrientation(jpegToRgba(frame, quantTables, adobeTransform), orientation);
}

function readQuantTables(segment, tables) {
  let p = 0;
  while (p < segment.length) {
    const precision = segment[p] >> 4;
    const id = segment[p] & 15;
    p++;
    const table = new Int32Array(64);
    for (let k = 0; k < 64; k++) table[ZIGZAG[k]] = precision ? segment.readUInt16BE(p + k * 2) : segment[p + k];
    p += precision ? 128 : 64;
    tables[id] = table;
  }
}

function readHuffmanTables(segment, dcTables, acTables) {
  let p = 0;
  while (p + 17 <= segment.length) {
    const tableClass = segment[p] >> 4;
    const id = segment[p] & 15;
    const counts = segment.subarray(p + 1, p + 17);
    let total = 0;
    for (const c of counts) total += c;
    const symbols = segment.subarray(p + 17, p + 17 + total);
    // 按标准的 mincode / maxcode / valptr 解码（F.2.2.3）
    const maxcode = new Int32Array(17).fill(-1);
    const mincode = new Int32Array(17);
    const valptr = new Int32Array(17);
    let code = 0;
    let k = 0;
    for (let len = 1; len <= 16; len++) {
      valptr[len] = k;
      mincode[len] = code;
      code += counts[len - 1];
      k += counts[len - 1];
      if (counts[len - 1]) maxcode[len] = code - 1;
      code <<= 1;
    }
    (tableClass === 0 ? dcTables : acTables)[id] = { maxcode, mincode, valptr, symbols: Uint8Array.from(symbols) };
    p += 17 + total;
  }
}

/** 帧头（SOF）里的宽高和分量数，检查能不能解 */
function frameHeader(segment, marker) {
  if (marker > 0xc2) throw new ImageError('参考图 JPEG 用了不支持的编码（无损或算术编码），请另存为普通 JPEG 或 PNG');
  if (segment.length < 6) throw new ImageError('参考图 JPEG 数据损坏');
  if (segment[0] !== 8) throw new ImageError('参考图 JPEG 是 12 位的，请另存为普通 JPEG 或 PNG');
  const height = segment.readUInt16BE(1);
  const width = segment.readUInt16BE(3);
  const count = segment[5];
  if (count === 4) throw new ImageError('参考图 JPEG 是 CMYK 的，请另存为 RGB 的 JPEG 或 PNG');
  if (count !== 1 && count !== 3) throw new ImageError('参考图 JPEG 数据损坏');
  checkSize(width, height);
  return { width, height, count };
}

function readFrame(segment, marker) {
  const { width, height, count } = frameHeader(segment, marker);
  if (segment.length < 6 + count * 3) throw new ImageError('参考图 JPEG 数据损坏');
  const components = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 3;
    const h = segment[p + 1] >> 4;
    const v = segment[p + 1] & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) throw new ImageError('参考图 JPEG 数据损坏'); // 采样系数只能是 1～4
    components.push({ id: segment[p], h, v, tq: segment[p + 2] });
  }
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  for (const c of components) {
    c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
    c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
    c.blocksPerLineForMcu = mcusPerLine * c.h;
    c.blocksPerColumnForMcu = mcusPerColumn * c.v;
    c.coefs = new Int16Array(c.blocksPerLineForMcu * c.blocksPerColumnForMcu * 64);
    c.pred = 0;
  }
  const blocks = components.reduce((sum, c) => sum + c.blocksPerLineForMcu * c.blocksPerColumnForMcu, 0);
  return {
    width, height, progressive: marker === 0xc2, components, maxH, maxV, mcusPerLine, mcusPerColumn, budget: MAX_PASSES * blocks,
  };
}

function readScanHeader(segment, frame, dcTables, acTables) {
  const count = segment[0];
  if (count < 1 || count > 4 || segment.length < 4 + count * 2) throw new ImageError('参考图 JPEG 数据损坏');
  const components = [];
  for (let i = 0; i < count; i++) {
    const component = frame.components.find((c) => c.id === segment[1 + i * 2]);
    if (!component || components.includes(component)) throw new ImageError('参考图 JPEG 数据损坏');
    component.dcTable = dcTables[segment[2 + i * 2] >> 4];
    component.acTable = acTables[segment[2 + i * 2] & 15];
    components.push(component);
  }
  const p = 1 + count * 2;
  const scan = { components, start: segment[p], end: segment[p + 1], high: segment[p + 2] >> 4, low: segment[p + 2] & 15 };
  // 渐进式的扫描参数照 libjpeg 检查：DC 扫描 Se 是 0；AC 扫描只有一个分量、Ss ≤ Se ≤ 63；细化扫描 Al = Ah - 1。基线的不看（libjpeg 也只警告）
  if (frame.progressive) {
    const bad = scan.start === 0 ? scan.end !== 0 : scan.start > scan.end || scan.end > 63 || count !== 1;
    if (bad || (scan.high && scan.low !== scan.high - 1) || scan.low > 13) throw new ImageError('参考图 JPEG 数据损坏');
  }
  // 交错扫描一个 MCU 最多 10 个块
  if (count > 1 && components.reduce((n, c) => n + c.h * c.v, 0) > 10) throw new ImageError('参考图 JPEG 数据损坏');
  return scan;
}

/** 解一段扫描数据，返回扫描结束的位置（下一个标记） */
function decodeScan(buf, start, frame, scan, resetInterval) {
  const { components, start: spectralStart, end: spectralEnd, high: successivePrev, low: successive } = scan;
  let offset = start;
  let bits = 0;
  let bitCount = 0;
  let atMarker = false;
  let eobrun = 0;
  let acState = 0;
  let acNext = 0;

  // 碰到标记就当后面全是 0（和 libjpeg 一样容错），由下面找 RST 标记
  const readBit = () => {
    if (bitCount === 0) {
      if (atMarker || offset >= buf.length) {
        atMarker = true;
        return 0;
      }
      const byte = buf[offset];
      if (byte === 0xff) {
        if (buf[offset + 1] !== 0x00) {
          atMarker = true;
          return 0;
        }
        offset += 2;
      } else {
        offset++;
      }
      bits = byte;
      bitCount = 8;
    }
    bitCount--;
    return (bits >> bitCount) & 1;
  };
  const receive = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };
  const extend = (n) => {
    if (n === 0) return 0;
    const v = receive(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  };
  const huffman = (table) => {
    if (!table) throw new ImageError('参考图 JPEG 缺少霍夫曼表');
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      if (code <= table.maxcode[len]) return table.symbols[table.valptr[len] + code - table.mincode[len]] ?? 0;
    }
    return 0; // 坏码：当 0 处理
  };

  const baseline = (c, off) => {
    const t = huffman(c.dcTable);
    c.pred += extend(t);
    c.coefs[off] = c.pred;
    for (let k = 1; k < 64;) {
      const rs = huffman(c.acTable);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      c.coefs[off + ZIGZAG[k]] = extend(s);
      k++;
    }
  };
  const dcFirst = (c, off) => {
    const t = huffman(c.dcTable);
    c.pred += extend(t) * (1 << successive);
    c.coefs[off] = c.pred;
  };
  const dcSuccessive = (c, off) => {
    if (readBit()) c.coefs[off] |= 1 << successive;
  };
  const acFirst = (c, off) => {
    if (eobrun > 0) {
      eobrun--;
      return;
    }
    for (let k = spectralStart; k <= spectralEnd;) {
      const rs = huffman(c.acTable);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) {
          eobrun = receive(r) + (1 << r) - 1;
          break;
        }
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      c.coefs[off + ZIGZAG[k]] = extend(s) * (1 << successive);
      k++;
    }
  };
  // 渐进式 AC 细化扫描（G.1.2.3）：已经非零的系数逐位补精度，零系数按游程跳过后放入新值
  const acSuccessive = (c, off) => {
    let k = spectralStart;
    let r = 0;
    while (k <= spectralEnd) {
      const z = off + ZIGZAG[k];
      const sign = c.coefs[z] < 0 ? -1 : 1;
      switch (acState) {
        case 0: {
          const rs = huffman(c.acTable);
          const s = rs & 15;
          r = rs >> 4;
          if (s === 0) {
            if (r < 15) {
              eobrun = receive(r) + (1 << r);
              acState = 4;
            } else {
              r = 16;
              acState = 1;
            }
          } else {
            acNext = extend(s);
            acState = r ? 2 : 3;
          }
          continue;
        }
        case 1:
        case 2:
          if (c.coefs[z]) c.coefs[z] += sign * (readBit() << successive);
          else if (--r === 0) acState = acState === 2 ? 3 : 0;
          break;
        case 3:
          if (c.coefs[z]) c.coefs[z] += sign * (readBit() << successive);
          else {
            c.coefs[z] = acNext << successive;
            acState = 0;
          }
          break;
        case 4:
          if (c.coefs[z]) c.coefs[z] += sign * (readBit() << successive);
          break;
        default:
          break;
      }
      k++;
    }
    if (acState === 4 && --eobrun === 0) acState = 0;
  };

  let decode = baseline;
  if (frame.progressive) {
    if (spectralStart === 0) decode = successivePrev === 0 ? dcFirst : dcSuccessive;
    else decode = successivePrev === 0 ? acFirst : acSuccessive;
  }

  const single = components.length === 1;
  const total = single
    ? components[0].blocksPerLine * components[0].blocksPerColumn
    : frame.mcusPerLine * frame.mcusPerColumn;
  frame.budget -= single ? total : total * components.reduce((n, c) => n + c.h * c.v, 0);
  if (frame.budget < 0) throw new ImageError('参考图 JPEG 的扫描段太多，请另存为普通 JPEG 或 PNG');
  let mcu = 0;
  while (mcu < total) {
    const batch = resetInterval ? Math.min(total - mcu, resetInterval) : total - mcu;
    for (const c of components) c.pred = 0;
    eobrun = 0;
    acState = 0;
    for (let n = 0; n < batch; n++, mcu++) {
      // 这一段的数据提前用完了（截断或损坏）：剩下的块不解、系数留着（和 libjpeg 一样），直接到下一段
      if (atMarker) {
        mcu += batch - n;
        break;
      }
      if (single) {
        const c = components[0];
        const row = Math.floor(mcu / c.blocksPerLine);
        const col = mcu % c.blocksPerLine;
        decode(c, 64 * (row * c.blocksPerLineForMcu + col));
      } else {
        const mcuRow = Math.floor(mcu / frame.mcusPerLine);
        const mcuCol = mcu % frame.mcusPerLine;
        for (const c of components) {
          for (let v = 0; v < c.v; v++) {
            for (let h = 0; h < c.h; h++) {
              decode(c, 64 * ((mcuRow * c.v + v) * c.blocksPerLineForMcu + mcuCol * c.h + h));
            }
          }
        }
      }
    }
    // 一段（或整个扫描）解完：丢掉剩下的位，跳过 RST 标记接着解；碰到别的标记就是扫描结束
    bitCount = 0;
    atMarker = false;
    while (offset + 1 < buf.length && !(buf[offset] === 0xff && buf[offset + 1] !== 0x00 && buf[offset + 1] !== 0xff)) offset++;
    if (mcu < total && buf[offset + 1] >= 0xd0 && buf[offset + 1] <= 0xd7) offset += 2;
    else if (mcu < total) break;
  }
  // 扫描结束：跳到下一个不是 RST 的标记
  while (offset + 1 < buf.length) {
    if (buf[offset] === 0xff && buf[offset + 1] !== 0x00 && buf[offset + 1] !== 0xff && !(buf[offset + 1] >= 0xd0 && buf[offset + 1] <= 0xd7)) break;
    offset++;
  }
  return offset;
}

function jpegToRgba(frame, quantTables, adobeTransform) {
  const { width, height, components, maxH, maxV } = frame;
  const ws = new Int32Array(64);
  const sampled = components.map((c) => {
    const q = quantTables[c.tq];
    if (!q) throw new ImageError('参考图 JPEG 缺少量化表');
    const planeWidth = c.blocksPerLineForMcu * 8;
    const plane = new Uint8ClampedArray(planeWidth * c.blocksPerColumnForMcu * 8);
    for (let row = 0; row < c.blocksPerColumn; row++) {
      for (let col = 0; col < c.blocksPerLine; col++) {
        idct(c.coefs, 64 * (row * c.blocksPerLineForMcu + col), q, ws, plane, row * 8 * planeWidth + col * 8, planeWidth);
      }
    }
    const used = [Math.ceil((width * c.h) / maxH), Math.ceil((height * c.v) / maxV)];
    return upsample(plane, planeWidth, used, c.h / maxH, c.v / maxV, width, height);
  });

  const out = new Uint8ClampedArray(width * height * 4);
  const pixels = width * height;
  // 三个分量默认是 YCbCr；Adobe 标记说不转换、或者分量 id 是 R G B 的按 RGB
  const rgb = components.length === 3
    && (adobeTransform === 0 || components.map((c) => c.id).join() === '82,71,66');
  const [p0, p1, p2] = sampled;
  for (let i = 0, o = 0; i < pixels; i++, o += 4) {
    if (sampled.length === 1) {
      out[o] = out[o + 1] = out[o + 2] = p0[i];
    } else if (rgb) {
      out[o] = p0[i];
      out[o + 1] = p1[i];
      out[o + 2] = p2[i];
    } else {
      const y = p0[i];
      out[o] = y + CR_R[p2[i]];
      out[o + 1] = y + ((CB_G[p1[i]] + CR_G[p2[i]]) >> 16);
      out[o + 2] = y + CB_B[p1[i]];
    }
    out[o + 3] = 255;
  }
  return { width, height, data: new Uint8Array(out.buffer) };
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * 分量平面 → 和整图一样大的 width×height。没缩小采样的直接取；横向、纵向缩小一半的（4:2:0、4:2:2、4:4:0）
 * 照 libjpeg 的 fancy upsampling 做，其他少见的比例按像素中心对齐做双线性插值。
 * used 是平面里有效的宽高（块对齐多出来的不算），sx / sy 是分量相对整图的比例。
 */
function upsample(plane, planeWidth, [usedWidth, usedHeight], sx, sy, width, height) {
  const out = new Uint8Array(width * height);
  if (sx === 1 && sy === 1) {
    for (let y = 0; y < height; y++) out.set(plane.subarray(y * planeWidth, y * planeWidth + width), y * width);
    return out;
  }
  if ((sx === 0.5 || sx === 1) && (sy === 0.5 || sy === 1) && (sx === 1 || usedWidth > 2)) {
    fancyUpsample(plane, planeWidth, usedWidth, usedHeight, sx === 0.5, sy === 0.5, out, width, height);
    return out;
  }
  const pick = (scale, size, used) => {
    const lo = new Int32Array(size);
    const hi = new Int32Array(size);
    const frac = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const pos = Math.min(used - 1, Math.max(0, (i + 0.5) * scale - 0.5));
      lo[i] = Math.floor(pos);
      hi[i] = Math.min(used - 1, lo[i] + 1);
      frac[i] = pos - lo[i];
    }
    return { lo, hi, frac };
  };
  const xs = pick(sx, width, usedWidth);
  const ys = pick(sy, height, usedHeight);
  for (let y = 0; y < height; y++) {
    const r0 = ys.lo[y] * planeWidth;
    const r1 = ys.hi[y] * planeWidth;
    const fy = ys.frac[y];
    for (let x = 0; x < width; x++) {
      const fx = xs.frac[x];
      const top = plane[r0 + xs.lo[x]] * (1 - fx) + plane[r0 + xs.hi[x]] * fx;
      const bottom = plane[r1 + xs.lo[x]] * (1 - fx) + plane[r1 + xs.hi[x]] * fx;
      out[y * width + x] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return out;
}

/**
 * libjpeg jdsample.c 的 h2v1 / h1v2 / h2v2 fancy upsampling：每个方向按“近的 3/4 + 远的 1/4”插值，取整也一样。
 * 纵向放大时偶数行和上一行混、奇数行和下一行混，上下边缘重复边上那一行。
 */
function fancyUpsample(plane, planeWidth, usedWidth, usedHeight, wide, tall, out, width, height) {
  const line = new Int32Array(usedWidth * 2);
  for (let y = 0; y < height; y++) {
    const row = tall ? y >> 1 : y;
    const near = row * planeWidth;
    const far = tall ? Math.min(usedHeight - 1, Math.max(0, y & 1 ? row + 1 : row - 1)) * planeWidth : near;
    const o = y * width;
    if (!wide) {
      const bias = y & 1 ? 2 : 1;
      for (let x = 0; x < width; x++) out[o + x] = (plane[near + x] * 3 + plane[far + x] + bias) >> 2;
      continue;
    }
    let p = 0;
    if (!tall) {
      line[p++] = plane[near];
      line[p++] = (plane[near] * 3 + plane[near + 1] + 2) >> 2;
      for (let i = 1; i < usedWidth - 1; i++) {
        const v = plane[near + i] * 3;
        line[p++] = (v + plane[near + i - 1] + 1) >> 2;
        line[p++] = (v + plane[near + i + 1] + 2) >> 2;
      }
      line[p++] = (plane[near + usedWidth - 1] * 3 + plane[near + usedWidth - 2] + 1) >> 2;
      line[p++] = plane[near + usedWidth - 1];
    } else {
      // 先纵向合成列和（3·近 + 远），再横向
      let cur = plane[near] * 3 + plane[far];
      line[p++] = (cur * 4 + 8) >> 4;
      for (let i = 1; i < usedWidth; i++) {
        const next = plane[near + i] * 3 + plane[far + i];
        line[p++] = (cur * 3 + next + 7) >> 4;
        line[p++] = (next * 3 + cur + 8) >> 4;
        cur = next;
      }
      line[p++] = (cur * 4 + 7) >> 4;
    }
    for (let x = 0; x < width; x++) out[o + x] = line[x];
  }
}

/**
 * 8×8 反 DCT，照 libjpeg jidctint.c 的 islow（LLM 算法、13 位定点，先列后行），结果直接写进分量平面（会截到 0～255）。
 * 列或行除直流外全是 0 的走捷径。第一遍的结果放大了 4 倍（PASS1_BITS），第二遍去掉它和 IDCT 的 8 倍再加 128。
 */
function idct(coefs, off, q, ws, out, outOff, stride) {
  for (let col = 0; col < 8; col++) {
    const i = off + col;
    if (!coefs[i + 8] && !coefs[i + 16] && !coefs[i + 24] && !coefs[i + 32] && !coefs[i + 40] && !coefs[i + 48] && !coefs[i + 56]) {
      const dc = coefs[i] * q[col] * 4;
      for (let k = col; k < 64; k += 8) ws[k] = dc;
      continue;
    }
    // 偶数部分
    let z2 = coefs[i + 16] * q[col + 16];
    let z3 = coefs[i + 48] * q[col + 48];
    let z1 = (z2 + z3) * FIX_0_541196100;
    let tmp2 = z1 - z3 * FIX_1_847759065;
    let tmp3 = z1 + z2 * FIX_0_765366865;
    z2 = coefs[i] * q[col];
    z3 = coefs[i + 32] * q[col + 32];
    let tmp0 = (z2 + z3) * 8192;
    let tmp1 = (z2 - z3) * 8192;
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;
    // 奇数部分
    tmp0 = coefs[i + 56] * q[col + 56];
    tmp1 = coefs[i + 40] * q[col + 40];
    tmp2 = coefs[i + 24] * q[col + 24];
    tmp3 = coefs[i + 8] * q[col + 8];
    const z5 = (tmp0 + tmp1 + tmp2 + tmp3) * FIX_1_175875602;
    z1 = (tmp0 + tmp3) * -FIX_0_899976223;
    z2 = (tmp1 + tmp2) * -FIX_2_562915447;
    z3 = (tmp0 + tmp2) * -FIX_1_961570560 + z5;
    const z4 = (tmp1 + tmp3) * -FIX_0_390180644 + z5;
    tmp0 = tmp0 * FIX_0_298631336 + z1 + z3;
    tmp1 = tmp1 * FIX_2_053119869 + z2 + z4;
    tmp2 = tmp2 * FIX_3_072711026 + z2 + z3;
    tmp3 = tmp3 * FIX_1_501321110 + z1 + z4;
    ws[col] = (tmp10 + tmp3 + 1024) >> 11;
    ws[col + 56] = (tmp10 - tmp3 + 1024) >> 11;
    ws[col + 8] = (tmp11 + tmp2 + 1024) >> 11;
    ws[col + 48] = (tmp11 - tmp2 + 1024) >> 11;
    ws[col + 16] = (tmp12 + tmp1 + 1024) >> 11;
    ws[col + 40] = (tmp12 - tmp1 + 1024) >> 11;
    ws[col + 24] = (tmp13 + tmp0 + 1024) >> 11;
    ws[col + 32] = (tmp13 - tmp0 + 1024) >> 11;
  }
  for (let r = 0; r < 64; r += 8) {
    const o = outOff + (r >> 3) * stride;
    if (!ws[r + 1] && !ws[r + 2] && !ws[r + 3] && !ws[r + 4] && !ws[r + 5] && !ws[r + 6] && !ws[r + 7]) {
      out.fill(((ws[r] + 16) >> 5) + 128, o, o + 8);
      continue;
    }
    let z2 = ws[r + 2];
    let z3 = ws[r + 6];
    let z1 = (z2 + z3) * FIX_0_541196100;
    let tmp2 = z1 - z3 * FIX_1_847759065;
    let tmp3 = z1 + z2 * FIX_0_765366865;
    let tmp0 = (ws[r] + ws[r + 4]) * 8192;
    let tmp1 = (ws[r] - ws[r + 4]) * 8192;
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;
    tmp0 = ws[r + 7];
    tmp1 = ws[r + 5];
    tmp2 = ws[r + 3];
    tmp3 = ws[r + 1];
    const z5 = (tmp0 + tmp1 + tmp2 + tmp3) * FIX_1_175875602;
    z1 = (tmp0 + tmp3) * -FIX_0_899976223;
    z2 = (tmp1 + tmp2) * -FIX_2_562915447;
    z3 = (tmp0 + tmp2) * -FIX_1_961570560 + z5;
    const z4 = (tmp1 + tmp3) * -FIX_0_390180644 + z5;
    tmp0 = tmp0 * FIX_0_298631336 + z1 + z3;
    tmp1 = tmp1 * FIX_2_053119869 + z2 + z4;
    tmp2 = tmp2 * FIX_3_072711026 + z2 + z3;
    tmp3 = tmp3 * FIX_1_501321110 + z1 + z4;
    out[o] = ((tmp10 + tmp3 + 131072) >> 18) + 128;
    out[o + 7] = ((tmp10 - tmp3 + 131072) >> 18) + 128;
    out[o + 1] = ((tmp11 + tmp2 + 131072) >> 18) + 128;
    out[o + 6] = ((tmp11 - tmp2 + 131072) >> 18) + 128;
    out[o + 2] = ((tmp12 + tmp1 + 131072) >> 18) + 128;
    out[o + 5] = ((tmp12 - tmp1 + 131072) >> 18) + 128;
    out[o + 3] = ((tmp13 + tmp0 + 131072) >> 18) + 128;
    out[o + 4] = ((tmp13 - tmp0 + 131072) >> 18) + 128;
  }
}

/** EXIF 里的方向（1～8）；读不出来当 1 */
function exifOrientation(tiff) {
  try {
    const little = tiff.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(entry) === 0x0112) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
  } catch {
    // 读不了就当正常方向
  }
  return 1;
}

/** 按 EXIF 方向转正：手机拍的照片经常是横着存、靠这个标记显示成竖的 */
function applyOrientation(image, orientation) {
  if (orientation === 1) return image;
  const { width: w, height: h, data } = image;
  const swap = orientation >= 5;
  const width = swap ? h : w;
  const height = swap ? w : h;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx;
      let sy;
      switch (orientation) {
        case 2: [sx, sy] = [w - 1 - x, y]; break;
        case 3: [sx, sy] = [w - 1 - x, h - 1 - y]; break;
        case 4: [sx, sy] = [x, h - 1 - y]; break;
        case 5: [sx, sy] = [y, x]; break;
        case 6: [sx, sy] = [y, h - 1 - x]; break;
        case 7: [sx, sy] = [w - 1 - y, h - 1 - x]; break;
        default: [sx, sy] = [w - 1 - y, x]; break; // 8
      }
      const s = (sy * w + sx) * 4;
      const d = (y * width + x) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width, height, data: out };
}

// ---------- 缩放 ----------

/**
 * 等比放大或缩小到能盖住 width×height，再居中裁掉多出来的（比例不一样时不拉伸变形）。
 * 用 bicubic，缩小时按缩小倍数放宽采样范围（抗锯齿）；先乘上透明度再算，免得透明边缘发黑。
 */
export function resizeCover(src, width, height) {
  if (src.width === width && src.height === height) return src;
  const scale = Math.max(width / src.width, height / src.height);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const xs = resampleWeights(src.width, width, (src.width - cropWidth) / 2, cropWidth);
  const ys = resampleWeights(src.height, height, (src.height - cropHeight) / 2, cropHeight);
  const rowStart = Math.min(...ys.map((w) => w.start));
  const rowEnd = Math.max(...ys.map((w) => w.start + w.weights.length));
  const rows = rowEnd - rowStart;
  const tmp = new Float32Array(width * rows * 4);
  const s = src.data;
  for (let y = 0; y < rows; y++) {
    const srcRow = (rowStart + y) * src.width;
    for (let x = 0; x < width; x++) {
      const { start, weights } = xs[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < weights.length; i++) {
        const p = (srcRow + start + i) * 4;
        const alpha = s[p + 3];
        const w = weights[i];
        r += s[p] * alpha * w;
        g += s[p + 1] * alpha * w;
        b += s[p + 2] * alpha * w;
        a += alpha * w;
      }
      const t = (y * width + x) * 4;
      tmp[t] = r;
      tmp[t + 1] = g;
      tmp[t + 2] = b;
      tmp[t + 3] = a;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const { start, weights } = ys[y];
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < weights.length; i++) {
        const t = ((start - rowStart + i) * width + x) * 4;
        const w = weights[i];
        r += tmp[t] * w;
        g += tmp[t + 1] * w;
        b += tmp[t + 2] * w;
        a += tmp[t + 3] * w;
      }
      const o = (y * width + x) * 4;
      if (a > 0.5) {
        out[o] = clamp8(r / a);
        out[o + 1] = clamp8(g / a);
        out[o + 2] = clamp8(b / a);
      }
      out[o + 3] = clamp8(a);
    }
  }
  return { width, height, data: out };
}

function resampleWeights(srcLength, dstLength, offset, span) {
  const scale = span / dstLength; // 每个输出像素对应多少个源像素
  const filterScale = Math.max(1, scale);
  const support = 2 * filterScale;
  const list = [];
  for (let i = 0; i < dstLength; i++) {
    const center = offset + (i + 0.5) * scale;
    const start = Math.max(0, Math.floor(center - support));
    const end = Math.min(srcLength - 1, Math.ceil(center + support));
    const weights = [];
    let sum = 0;
    for (let j = start; j <= end; j++) {
      const w = cubic((j + 0.5 - center) / filterScale);
      weights.push(w);
      sum += w;
    }
    if (sum <= 0) {
      const nearest = Math.min(srcLength - 1, Math.max(0, Math.floor(center)));
      list.push({ start: nearest, weights: Float32Array.of(1) });
    } else {
      list.push({ start, weights: Float32Array.from(weights, (w) => w / sum) });
    }
  }
  return list;
}

function cubic(t) {
  const a = -0.5;
  const x = Math.abs(t);
  if (x < 1) return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
  if (x < 2) return a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a;
  return 0;
}
