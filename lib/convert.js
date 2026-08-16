const { spawn } = require('child_process');

function parseDuration(line) {
  const m = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}

function parseTime(line) {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
}

/**
 * 用 ffmpeg 把音频转码为 MP3。
 * @param {string} input
 * @param {string} output
 * @param {{ffmpegPath?:string, bitrate?:number, sampleRate?:number, channels?:number}} opts
 * @param {{onProgress?: (percent:number, info?:{time:number,duration:number})=>void, signal?: AbortSignal}} ctrl
 */
function convert(input, output, opts = {}, { onProgress, signal } = {}) {
  const {
    ffmpegPath = 'ffmpeg',
    bitrate = 128,
    sampleRate = 44100,
    channels = 2,
  } = opts;

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', input,
      '-vn',
      '-codec:a', 'libmp3lame',
      '-b:a', `${bitrate}k`,
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-write_xing', '1',
      output,
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });

    let duration = 0;
    let stderr = '';
    let killed = false;

    const abort = () => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (!duration) {
        const dur = parseDuration(text);
        if (dur) duration = dur;
      }
      const t = parseTime(text);
      if (duration && t && onProgress) {
        onProgress(Math.min(99, Math.round((t / duration) * 100)), { time: t, duration });
      }
    });

    proc.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', abort);
      reject(new Error(`无法启动 ffmpeg：${err.message}\n请在「设置」中检查 ffmpeg 路径（当前：${ffmpegPath}）。`));
    });

    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', abort);
      if (killed || (signal && signal.aborted)) {
        reject(new Error('任务已取消'));
      } else if (code === 0) {
        if (onProgress) onProgress(100, { time: duration, duration });
        resolve();
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(`ffmpeg 转码失败（退出码 ${code}）\n${tail}`));
      }
    });
  });
}

module.exports = { convert, parseDuration, parseTime };
