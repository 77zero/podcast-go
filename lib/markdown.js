'use strict';

// 与 python/transcribe.py 的 build_markdown 保持一致的粗粒度 Markdown 生成器（JS 版）。
// 用途：老产物（只有 json 没有 md）打开 MD 时，从 json（权威数据，含全部分段）即时生成。
// 分段粒度、分组规则、编号规则、连接符规则必须与 python 版一致，避免新旧产物格式漂移。

const BLOCK_SEC = 15 * 60; // 15 分钟一段

function fmtClock(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 从转写结果 json 对象生成 Markdown 逐字稿。
 * @param {string} baseName 用于标题（原音频名去扩展名，或产物目录名）
 * @param {{model?:string, device_used?:string, language?:string, duration?:number, segments:Array<{start:number,end:number,text:string}>}} result
 */
function buildMarkdown(baseName, result) {
  const segments = (result && Array.isArray(result.segments) ? result.segments : []).filter(
    (s) => s && typeof s.start === 'number' && typeof s.end === 'number'
  );
  const lines = [`# ${baseName} 逐字稿`, ''];
  lines.push(`> 模型: ${result.model || '?'} · 设备: ${result.device_used || '?'} · 语言: ${result.language || '?'} · 时长: ${Number(result.duration) || 0} 秒 · 分段: ${segments.length}`);
  lines.push('');

  // 按固定时长分组（段内保持顺序）
  const blocks = [];
  for (const s of segments) {
    const bi = Math.floor(s.start / BLOCK_SEC);
    while (bi >= blocks.length) blocks.push([]);
    blocks[bi].push(s);
  }

  const lang = String(result.language || '').split('-')[0].toLowerCase();
  const joiner = ['zh', 'ja', 'ko'].includes(lang) ? '' : ' ';
  let idx = 1; // 连续编号，跳过没有内容的空时段，避免编号跳空
  for (const blk of blocks) {
    if (!blk.length) continue;
    lines.push(`## 第 ${idx} 段 – ${fmtClock(blk[0].start)} – ${fmtClock(blk[blk.length - 1].end)}`);
    idx += 1;
    lines.push('');
    lines.push(joiner + blk.map((s) => s.text || '').filter(Boolean).join(joiner));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { buildMarkdown, fmtClock, BLOCK_SEC };