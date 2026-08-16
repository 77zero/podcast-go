const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { download } = require('./download');
const { convert } = require('./convert');

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

function extFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-zA-Z0-9]{1,5})$/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

class TaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.seq = 0;
  }

  list() {
    return [...this.tasks.values()].map((t) => this._public(t));
  }

  get(id) {
    const t = this.tasks.get(id);
    return t ? this._public(t) : null;
  }

  _public(t) {
    return {
      id: t.id,
      title: t.title,
      feed: t.feed,
      audioUrl: t.audioUrl || null,
      status: t.status, // pending | running | ready | error | cancelled
      stage: t.stage,   // queued | download | convert | ready | error | cancelled
      percent: t.percent,
      message: t.message,
      outputPath: t.outputPath || null,
      error: t.error || null,
      addedAt: t.addedAt,
      meta: t.meta || null, // { received, total, speed, eta, size }
    };
  }

  add({ title, feed, audioUrl, libraryDir, settings }) {
    const id = 't' + (++this.seq);
    const task = {
      id,
      title,
      feed,
      audioUrl,
      libraryDir,
      settings,
      status: 'pending',
      stage: 'queued',
      percent: 0,
      message: '排队中',
      outputPath: null,
      error: null,
      addedAt: Date.now(),
      controller: new AbortController(),
    };
    this.tasks.set(id, task);
    this.emit('update', this._public(task));
    this._run(task).catch(() => {});
    return this._public(task);
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.status === 'pending' || t.status === 'running') {
      t.controller.abort();
      this._set(t, { status: 'cancelled', stage: 'cancelled', message: '已取消', percent: 0 });
    }
    return true;
  }

  clearFinished() {
    let removed = 0;
    for (const [id, t] of this.tasks) {
      if (t.status === 'ready' || t.status === 'error' || t.status === 'cancelled') {
        this.tasks.delete(id);
        removed++;
      }
    }
    return removed;
  }

  _set(t, patch) {
    Object.assign(t, patch);
    this.emit('update', this._public(t));
  }

  async _run(t) {
    try {
      t.status = 'running';
      const settings = t.settings;
      const downloadDir = path.join(t.libraryDir, '.downloads');
      const feedDir = path.join(t.libraryDir, sanitize(t.feed));
      const ext = extFromUrl(t.audioUrl) || 'mp3';
      const inputPath = path.join(downloadDir, `${t.id}.${ext}`);
      const outputPath = path.join(feedDir, `${sanitize(t.title)}.mp3`);

      const dStart = Date.now();
      this._set(t, { stage: 'download', message: '下载中', percent: 0, meta: null });
      await download(t.audioUrl, inputPath, {
        signal: t.controller.signal,
        onProgress: (p, info) => {
          if (p == null) return;
          const elapsed = (Date.now() - dStart) / 1000;
          let speed = null;
          let eta = null;
          if (info && info.total && info.received > 0 && elapsed > 0) {
            speed = info.received / elapsed;
            eta = (info.total - info.received) / speed;
          }
          this._set(t, {
            stage: 'download', message: '下载中', percent: p,
            meta: info ? { received: info.received, total: info.total, speed, eta } : null,
          });
        },
      });

      const inputStat = await fs.promises.stat(inputPath);
      const inputSize = inputStat.size;
      const cStart = Date.now();
      this._set(t, { stage: 'convert', message: '转码为 MP3', percent: 0, meta: { size: inputSize, speed: null, eta: null } });
      await fs.promises.mkdir(feedDir, { recursive: true });
      await convert(inputPath, outputPath, settings, {
        signal: t.controller.signal,
        onProgress: (p, info) => {
          const elapsed = (Date.now() - cStart) / 1000;
          let speed = null;
          let eta = null;
          if (info && info.duration && info.time != null) {
            eta = Math.max(0, info.duration - info.time);
            if (elapsed > 0 && info.time > 0) {
              speed = (inputSize * (info.time / info.duration)) / elapsed;
            }
          }
          this._set(t, { stage: 'convert', message: '转码为 MP3', percent: p, meta: { size: inputSize, speed, eta } });
        },
      });

      const outStat = await fs.promises.stat(outputPath);
      fs.promises.unlink(inputPath).catch(() => {});
      this._set(t, {
        status: 'ready',
        stage: 'ready',
        message: '已完成',
        percent: 100,
        outputPath,
        meta: { size: outStat.size },
      });
    } catch (err) {
      if (t.controller.signal.aborted) {
        this._set(t, { status: 'cancelled', stage: 'cancelled', message: '已取消', percent: 0 });
      } else {
        this._set(t, {
          status: 'error',
          stage: 'error',
          message: '失败',
          percent: 0,
          error: err && err.message ? err.message : String(err),
        });
      }
    }
  }
}

module.exports = { TaskManager, sanitize };
