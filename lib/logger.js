'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 极简文件日志：写入 userData/logs/podcast-go.log（每天一个文件，最多保留近 N 天）。
 * 进程内单例，供主进程记录任务/转写/导入的关键阶段与错误，方便定位「卡在 99%」类问题。
 */
class Logger {
  constructor() {
    this.dir = null;
    this.keepDays = 7;
    this._today = null;
    this._stream = null;
  }

  /** 初始化日志目录（app ready 后调用）。不会抛错。 */
  init(dir) {
    try {
      this.dir = String(dir || '');
      fs.mkdirSync(this.dir, { recursive: true });
      this._prune();
    } catch (err) {
      console.warn('[logger] 日志目录初始化失败：' + err.message);
    }
  }

  _file() {
    if (!this.dir) return null;
    const today = new Date().toISOString().slice(0, 10);
    return path.join(this.dir, `podcast-go-${today}.log`);
  }

  _write(line) {
    if (!this.dir) { console.log(line); return; }
    try {
      const file = this._file();
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch (err) {
      console.warn('[logger] 写入失败：' + err.message);
    }
  }

  /** 删除超过保留天数的旧日志文件。 */
  _prune() {
    try {
      const cutoff = Date.now() - this.keepDays * 24 * 3600 * 1000;
      const prefix = 'podcast-go-';
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.startsWith(prefix) || !f.endsWith('.log')) continue;
        const p = path.join(this.dir, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    } catch (_) { /* ignore */ }
  }

  _fmt(level, scope, msg) {
    const ts = new Date().toISOString();
    const s = String(scope || '-');
    return `${ts} [${level}] [${s}] ${String(msg)}`;
  }

  info(scope, msg) { this._write(this._fmt('INFO', scope, msg)); }
  warn(scope, msg) { this._write(this._fmt('WARN', scope, msg)); }
  error(scope, msg) { this._write(this._fmt('ERROR', scope, msg)); }
}

// 进程内单例
const logger = new Logger();
module.exports = logger;