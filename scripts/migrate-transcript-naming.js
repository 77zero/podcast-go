'use strict';

/**
 * 一次性迁移：转写产物命名规范化。
 *
 * 旧命名（.transcript.json / .transcript.md / .transcript.txt，目录名带原标题标点）：
 *   <目录>/<原标题带标点>/<原标题带标点>.transcript.json|.md|.txt
 *   或平铺：<目录>/<原标题带标点>.transcript.json|.md|.txt
 *
 * 新命名（.json / .md，文件名与目录去全角标点、非法字符）：
 *   <目录>/<清理后的标题>/<清理后的标题>.json|.md
 *
 * 规则必须与 main.js cleanTranscriptName / renderer cleanTranscriptName 一致。
 * 幂等：已按新规则命名的文件会被跳过；目标已存在且与源不同会跳过并报告冲突。
 * 用法：node scripts/migrate-transcript-naming.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DRY_RUN = process.argv.includes('--dry-run');

// 与 main.js / renderer.js 保持一致的清理规则
function cleanTranscriptName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_') // 半角非法字符 -> 下划线
    .replace(/[^A-Za-z0-9._\-\s\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ') // 其余标点/符号 -> 空格
    .replace(/\s+/g, ' ') // 压缩连续空白（含全角空格）
    .trim()
    .slice(0, 120) || 'untitled';
}

const AUDIO_EXT = /\.(mp3|wav|m4a|m4b|aac|ogg|flac|opus|mp4)$/i;
const OLD_JSON = /^(.*)\.transcript\.json$/;
const OLD_MD = /^(.*)\.transcript\.md$/;
const OLD_TXT = /^(.*)\.transcript\.txt$/;

function settingsDir() {
  // 与 Electron app.getPath('appData') 一致：%APPDATA%
  return path.join(os.homedir(), 'AppData', 'Roaming');
}

function loadLibraryDir() {
  const candidates = [
    path.join(settingsDir(), 'podcast-go', 'settings.json'),
    path.join(settingsDir(), '播客随身听', 'settings.json'),
    path.join(settingsDir(), 'podcast-mp3-tool', 'settings.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s.libraryDir && fs.existsSync(s.libraryDir)) return s.libraryDir;
    } catch (_) { /* next */ }
  }
  return null;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function collect() {
  const out = [];
  const lib = loadLibraryDir();
  if (!lib) throw new Error('找不到媒体库目录（settings.json 未配置或目录不存在）');
  for (const f of walk(lib)) {
    const base = path.basename(f);
    if (!OLD_JSON.test(base) && !OLD_MD.test(base) && !OLD_TXT.test(base)) continue;
    out.push(f);
  }
  return { lib, files: out };
}

function renameWithConflict(from, to, log, dry) {
  if (from === to) return;
  if (fs.existsSync(to)) {
    log.push(`⚠️ 跳过（目标已存在）：${from} -> ${to}`);
    return;
  }
  log.push(`${dry ? '[dry] ' : ''}改名：${from} -> ${to}`);
  if (!dry) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
}

function main() {
  const { lib, files } = collect();
  const log = [];
  if (files.length === 0) {
    console.log(`媒体库 ${lib}\n没有发现旧命名（.transcript.*）产物。`);
    return;
  }
  console.log(`媒体库：${lib}\n发现 ${files.length} 个旧命名产物\n`);

  // 按文件处理：每个 .transcript.json 是主条目，md/txt 随 json 一并迁移
  const seen = new Set();
  for (const f of files) {
    // 只以 json 为主驱（json 是权威数据）；md/txt 由同样前缀的 json 处理
    const base = path.basename(f);
    if (!OLD_JSON.test(base)) continue;
    const dir = path.dirname(f);
    const oldBase = base.replace(/^(.+)\.transcript\.json$/, '$1');
    const cleanBase = cleanTranscriptName(oldBase);

    // 目录式：dir 的名字就是 oldBase（产物在同名子目录里）
    const dirName = path.basename(dir);
    // 兼容半迁移状态：目录可能已改为 cleanBase 但里面文件仍是旧的 .transcript.*
    const dirIsOld = dirName === oldBase;
    const dirIsNew = dirName === cleanBase;
    let targetDir;
    if (dirIsOld) {
      targetDir = path.join(path.dirname(dir), cleanBase);
      if (dirName !== cleanBase) {
        // 目录本身要改名（带标题标点的旧目录名 -> 清理后）
        log.push(`${DRY_RUN ? '[dry] ' : ''}目录改名：${dir} -> ${targetDir}`);
        if (!DRY_RUN) fs.renameSync(dir, targetDir);
      }
    } else if (dirIsNew) {
      // 目录已是新名（可能上次运行到一半），文件原地改名
      targetDir = dir;
    } else {
      // 平铺：文件直接在目录里（旧结构遗留），挪进新建的同名子目录
      targetDir = path.join(dir, cleanBase);
    }
    let activeDir = dirIsOld && dirName !== cleanBase ? targetDir : dir; // 平铺时文件仍在旧位置

    const moved = {};
    for (const suffix of ['.json', '.md', '.txt']) {
      const oldFile = path.join(activeDir, oldBase + '.transcript' + suffix);
      const newFile = path.join(targetDir, cleanBase + suffix);
      if (fs.existsSync(oldFile)) {
        if (moved[suffix]) continue; // 防重复
        renameWithConflict(oldFile, newFile, log, DRY_RUN);
        moved[suffix] = true;
        seen.add(oldFile);
      }
    }
  }

  // 未被 json 驱动的 md/txt（理论上不会出现，兜底）
  const orphanLog = [];
  for (const f of files) {
    if (!seen.has(f)) {
      const dir = path.dirname(f);
      const base = path.basename(f);
      const m = base.match(/^(.+)\.transcript\.(md|txt)$/);
      if (!m) continue;
      const oldBase = m[1];
      const cleanBase = cleanTranscriptName(oldBase);
      renameWithConflict(f, path.join(dir, cleanBase, cleanBase + '.' + m[2]), orphanLog, DRY_RUN);
    }
  }

  console.log(log.length ? log.join('\n') : '（无改动）');
  if (orphanLog.length) console.log('\n孤儿文件：\n' + orphanLog.join('\n'));
  console.log(DRY_RUN ? '\n[dry-run] 未实际改动。' : '\n迁移完成。');
  if (!DRY_RUN) console.log('提示：请重启应用让界面按新路径扫描产物。');
}

main();