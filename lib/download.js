const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

/**
 * 下载远程音频到本地文件。
 * @param {string} url
 * @param {string} destPath
 * @param {{onProgress?: (percent:number|null, info?:{received:number,total:number})=>void, signal?: AbortSignal}} opts
 */
async function download(url, destPath, { onProgress, signal } = {}) {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (onProgress) {
        onProgress(total ? Math.min(99, Math.round((received / total) * 100)) : null, { received, total });
      }
      cb(null, chunk);
    },
  });

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath), {
    signal,
  });

  return { bytes: received };
}

module.exports = { download };
