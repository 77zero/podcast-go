const fs = require('fs');
const path = require('path');

/**
 * 把多个 MP3 文件复制到目标设备目录。
 * @param {string[]} files
 * @param {string} targetDir
 * @param {{onProgress?:(percent:number, info:{current:string,done:number,total:number})=>void, signal?:AbortSignal}} opts
 */
async function importFiles(files, targetDir, { onProgress, signal } = {}) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const results = [];
  const total = files.length;

  for (let i = 0; i < total; i++) {
    if (signal && signal.aborted) throw new Error('已取消');
    const src = files[i];
    const name = path.basename(src);
    const dest = path.join(targetDir, name);
    await fs.promises.copyFile(src, dest);
    results.push(dest);
    if (onProgress) {
      onProgress(Math.round(((i + 1) / total) * 100), {
        current: name,
        done: i + 1,
        total,
      });
    }
  }
  return results;
}

module.exports = { importFiles };
