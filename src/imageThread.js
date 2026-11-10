import { parentPort } from 'node:worker_threads';
import { ImageError, decodeImage, encodePng, resizeCover } from './imageCodec.js';

// 参考图的缩放线程（由 imageJobs.js 启动）：解码后等比居中裁切缩放到指定尺寸，编成 PNG 回去
parentPort.on('message', ({ bytes, width, height }) => {
  try {
    const image = decodeImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    parentPort.postMessage({ png: encodePng(resizeCover(image, width, height)) });
  } catch (err) {
    parentPort.postMessage({ error: err.message, imageError: err instanceof ImageError });
  }
});
