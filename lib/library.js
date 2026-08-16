const fs = require('fs');
const path = require('path');

/**
 * 递归列出媒体库目录下所有 MP3 文件。
 * @param {string} dir
 */
async function listMp3(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && /\.mp3$/i.test(e.name)) {
        let stat;
        try {
          stat = await fs.promises.stat(full);
        } catch (_) {
          continue;
        }
        out.push({
          path: full,
          name: e.name,
          rel: path.relative(dir, full),
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
    }
  }
  await walk(dir);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

module.exports = { listMp3 };
