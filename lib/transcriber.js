'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// transcribe.py 必须位于真实文件系统（外部 python 进程无法读取 asar 内的文件）。
// 打包后该文件通过 asarUnpack 解包到 app.asar.unpacked，这里做路径重映射。
function scriptPath() {
  const p = path.join(__dirname, '..', 'python', 'transcribe.py');
  if (p.includes('app.asar')) {
    const unpacked = p.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return p;
}
const SCRIPT = scriptPath();

/**
 * faster-whisper 转写管理器。
 * 通过子进程调用 python/transcribe.py，解析流式 stdout。
 * 事件：'update' -> { type, ... }（state|progress|done|error|setup）
 */
class Transcriber extends EventEmitter {
  constructor() {
    super();
    this.venvDir = null;     // userData/transcribe-venv
    this.active = null;      // 当前转写请求 { input, output, proc }
    this.setupProc = null;
  }

  setVenvDir(dir) {
    this.venvDir = dir;
  }

  venvPython() {
    if (!this.venvDir) return null;
    const p = path.join(this.venvDir, 'Scripts', 'python.exe');
    return fs.existsSync(p) ? p : null;
  }

  // ctranslate2 的 GPU 依赖 cublas/cudnn 等 DLL，它们装在 site-packages/nvidia/*/bin
  // 必须把这些目录注入子进程 PATH，否则报 cublas64_12.dll not found
  nvidiaPath() {
    if (!this.venvDir) return '';
    const sp = path.join(this.venvDir, 'Lib', 'site-packages', 'nvidia');
    if (!fs.existsSync(sp)) return '';
    const dirs = [];
    for (const d of fs.readdirSync(sp)) {
      const bin = path.join(sp, d, 'bin');
      if (fs.existsSync(bin)) dirs.push(bin);
    }
    return dirs.join(';');
  }

  // 查询某个 python 解释器实际安装的 nvidia 包目录，返回其中的 */bin 列表。
  // 转写可能跑在系统 python / 其它 venv 上（应用自带 venv 未安装时），
  // 只要那个解释器装了 nvidia 运行库，就能把 cublas/cudnn 等 DLL 目录注入 PATH。
  nvidiaDirsFor(py) {
    if (!py) return Promise.resolve([]);
    const [bin, ...args] = py.split(' ');
    return new Promise((resolve) => {
      // nvidia 是命名空间包（无 __init__.py），__file__ 为 None，要用 __path__[0]
      const p = spawn(bin, [...args, '-c', 'import nvidia; print(nvidia.__path__[0])'], { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve([]));
      p.on('close', () => {
        const dir = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
        if (!dir || !fs.existsSync(dir)) return resolve([]);
        const dirs = [];
        for (const d of fs.readdirSync(dir)) {
          const binPath = path.join(dir, d, 'bin');
          if (fs.existsSync(binPath)) dirs.push(binPath);
        }
        resolve(dirs);
      });
    });
  }

  // 生成子进程环境：把 nvidia DLL 目录放到 PATH 最前。
  // 优先用应用自己的 venv（快路径）；否则按实际执行转写的解释器动态查找。
  async envFor(py) {
    let dirs = this.nvidiaPath().split(';').filter(Boolean);
    if (dirs.length === 0) {
      dirs = await this.nvidiaDirsFor(py);
    }
    if (dirs.length === 0) return undefined;
    return { ...process.env, PATH: dirs.join(';') + ';' + (process.env.PATH || '') };
  }

  // 检测可用 python：优先 venv，其次系统 python / py -3。
  // venv 目录存在但未装好（安装中途/失败）时也要验证，避免选了空壳 python。
  async findPython() {
    const venv = this.venvPython();
    if (venv) {
      try {
        await this._checkPython(venv);
        return { py: venv, venv: true };
      } catch (_) { /* venv 未就绪，继续找其它 python */ }
    }
    for (const cand of ['python', 'python3', 'py -3']) {
      try {
        await this._checkPython(cand);
        return { py: cand, venv: false };
      } catch (_) { /* next */ }
    }
    return null;
  }

  async _checkPython(cmd) {
    const env = await this.envFor(cmd);
    return new Promise((resolve, reject) => {
      const [bin, ...args] = cmd.split(' ');
      const p = spawn(bin, [...args, '-c', 'import faster_whisper; print("ok")'], { windowsHide: true, env });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 && /ok/.test(out) ? resolve() : reject(new Error('faster_whisper 不可用'))));
    });
  }

  // 环境诊断（设置页 / 转写页用）
  async doctor() {
    const info = { venvExists: !!this.venvPython(), pythonFound: false, whisperInstalled: false, cuda: 0, vadAvailable: false };
    try {
      const found = await this.findPython();
      info.pythonFound = !!found;
      if (found) {
        const [bin, ...args] = found.py.split(' ');
        // 第一行：CUDA 设备数；第二行：onnxruntime（VAD）是否可用
        const env = await this.envFor(found.py);
        const p = spawn(bin, [...args, '-c', 'import faster_whisper; import ctranslate2; print(ctranslate2.get_cuda_device_count()); import onnxruntime; print("vad-ok")'], { windowsHide: true, env });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        const code = await new Promise((r) => { p.on('close', r); p.on('error', () => r(1)); });
        if (code === 0) {
          info.whisperInstalled = true;
          const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          const n = parseInt((lines[0] || '').match(/\d+/) || ['0'], 10);
          info.cuda = isNaN(n) ? 0 : n;
          info.vadAvailable = lines.slice(1).some((l) => l.includes('vad-ok'));
        }
      }
    } catch (_) { /* ignore */ }
    return info;
  }

  // 首次安装：创建 venv 并 pip install faster-whisper
  async setup() {
    if (!this.venvDir) throw new Error('未配置 venv 目录');
    if (this.setupProc) throw new Error('安装已在后台进行中');
    if (this.venvPython()) {
      this.emit('update', { type: 'setup', state: 'done', message: '已安装，可直接使用' });
      return;
    }
    return new Promise((resolve, reject) => {
      const venvPy = path.join(this.venvDir, 'Scripts', 'python.exe');
      const emit = (state, message) => this.emit('update', { type: 'setup', state, message });
      emit('creating', '正在创建 Python 环境…');
      const create = spawn('py', ['-3', '-m', 'venv', this.venvDir], { windowsHide: true });
      create.on('close', (code) => {
        if (code !== 0) {
          emit('error', '创建 Python 虚拟环境失败');
          reject(new Error('创建 venv 失败'));
          return;
        }
        const inst = spawn(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], { windowsHide: true });
        inst.on('close', () => {
          emit('installing', '正在安装 faster-whisper（约 400MB，需几分钟）…');
          // faster-whisper + onnxruntime（VAD 语音分段必需）+ CUDA 运行时库（GPU 转写必需 cublas/cudnn）
          const args = ['-m', 'pip', 'install', 'faster-whisper', 'onnxruntime', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12'];
          // 国内网络走镜像更快
          if (process.env.TRANSCRIBE_PIP_INDEX) args.push('-i', process.env.TRANSCRIBE_PIP_INDEX);
          const pip = spawn(venvPy, args, { windowsHide: true });
          let buf = '';
          pip.stderr.on('data', (d) => {
            buf = (buf + d.toString()).slice(-2000);
            const m = buf.match(/Downloading\s+(\S+)\s*$/m);
            if (m) emit('installing', '正在下载 ' + m[1]);
          });
          pip.on('close', (c) => {
            this.setupProc = null;
            if (c === 0 && this.venvPython()) {
              emit('done', '安装完成，可以开始转写了');
              resolve();
            } else {
              emit('error', '安装失败，请查看设置页的安装指引');
              reject(new Error('pip install 失败'));
            }
          });
          pip.on('error', (e) => { this.setupProc = null; emit('error', '安装失败：' + e.message); reject(e); });
          this.setupProc = pip;
        });
      });
      create.on('error', (e) => { emit('error', '无法创建环境：' + e.message); reject(e); });
    });
  }

  // 开始转写
  async start({ input, output, model, device, language }) {
    if (this.active) throw new Error('已有转写任务进行中');
    const py = await this.findPython();
    if (!py) throw new Error('未检测到可用的转写引擎，请先在设置中安装');
    const baseEnv = await this.envFor(py.py);
    // 强制子进程 stdout/stderr 用 UTF-8 输出，避免 Windows 默认 GBK 把中文/JSON 行弄乱
    const env = { ...(baseEnv || process.env), PYTHONIOENCODING: 'utf-8' };
    const proc = spawn(py.py.split(' ')[0], [
      ...py.py.split(' ').slice(1),
      SCRIPT,
      '--input', input,
      '--output', output,
      '--model', model,
      '--device', device,
      '--language', language,
    ], { windowsHide: true, env });

    const req = { input, output, proc, state: 'running', percent: 0, segments: [], error: null, stderr: '', cancelled: false, lastOutput: Date.now() };
    this.active = req;
    const emit = (payload) => this.emit('update', { type: 'progress', ...payload });

    logger.info('transcribe', `开始：${input} 模型=${model} 设备=${device} 语言=${language} python=${py.py}`);

    // 看门狗：超过 90 秒没有任何 stdout/stderr 输出，判定进程挂起（卡死），主动终止并报错
    const WATCHDOG_MS = 90 * 1000;
    req.watchdog = setInterval(() => {
      if (this.active !== req) return;
      if (Date.now() - req.lastOutput > WATCHDOG_MS) {
        logger.error('transcribe', `看门狗触发：${req.input} 已 ${Math.round((Date.now() - req.lastOutput) / 1000)}s 无输出，判定挂起，强制终止`);
        this._killProcess(req);
        req.error = req.error || '转写进程无响应（90 秒无输出），已自动终止';
        this.active = null;
        this.emit('update', { type: 'error', input: req.input, message: req.error });
      }
    }, 15 * 1000);

    let buf = '';
    proc.stdout.on('data', (d) => {
      req.lastOutput = Date.now();
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        this._handleLine(req, line, emit);
      }
    });
    proc.stderr.on('data', (d) => {
      req.lastOutput = Date.now();
      req.stderr += d.toString();
    });
    proc.on('error', (e) => {
      clearInterval(req.watchdog);
      if (this.active === req) this.active = null;
      logger.error('transcribe', `启动失败：${req.input} ${e.message}`);
      this.emit('update', { type: 'error', input: req.input, message: '无法启动转写进程：' + e.message });
    });
    proc.on('close', (code) => {
      clearInterval(req.watchdog);
      if (this.active === req) this.active = null;
      logger.info('transcribe', `进程退出：${req.input} code=${code}`);
      if (req.error) {
        // _handleLine 已发过具体错误，这里补 stderr 尾部日志
        logger.error('transcribe', `stderr 尾部：\n${req.stderr.trim().split(/\r?\n/).slice(-10).join('\n')}`);
        return;
      }
      if (code !== 0 && !req.error && !req.cancelled) {
        const tail = (req.stderr || '').trim().split(/\r?\n/).slice(-6).join('\n');
        logger.error('transcribe', `异常退出（${code}）：${req.input}\n${tail}`);
        this.emit('update', { type: 'error', input: req.input, message: '转写进程异常退出（' + code + '）\n' + tail });
      }
    });
    return { ok: true };
  }

  // 终止子进程整棵进程树（Windows 上 kill 只杀 python 启动器，需 taskkill /T）
  _killProcess(req) {
    const pid = req.proc && req.proc.pid;
    try { req.proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
    if (process.platform === 'win32' && pid) {
      try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) { /* ignore */ }
    }
  }

  _handleLine(req, line, emit) {
    const tab = line.indexOf('\t');
    const key = tab >= 0 ? line.slice(0, tab) : line;
    const val = tab >= 0 ? line.slice(tab + 1) : '';

    if (key === 'STATUS') {
      req.state = val;
      logger.info('transcribe', `状态 ${val}（${req.input}）`);
      emit({ state: val, input: req.input });
    } else if (key === 'DURATION') {
      req.duration = parseFloat(val) || null;
      logger.info('transcribe', `音频时长 ${req.duration}s（${req.input}）`);
    } else if (key === 'SEG') {
      const parts = val.split('\t');
      const seg = { start: parseFloat(parts[0]), end: parseFloat(parts[1]), text: parts.slice(2).join('\t') };
      req.segments.push(seg);
      if (req.duration && req.duration > 0) {
        req.percent = Math.min(99, Math.round((seg.end / req.duration) * 100));
      }
      emit({ state: 'decoding', percent: req.percent, input: req.input, lastSeg: seg });
    } else if (key === 'RESULT') {
      let result;
      try { result = JSON.parse(val); } catch (err) {
        // RESULT 行损坏（常见于编码/换行破坏）时不再静默卡在 99%，显式报错便于定位
        logger.error('transcribe', `RESULT 解析失败：${req.input} ${err.message}\n原始行片段：${String(val).slice(0, 300)}`);
        req.error = '转写结果数据损坏，无法解析（请查看日志文件）';
        this.emit('update', { type: 'error', input: req.input, message: req.error });
        return;
      }
      const output = req.output;
      const done = {
        ok: true,
        input: req.input,
        output,
        jsonPath: output,
        mdPath: output.replace(/\.json$/, '.md'),
        model: result ? result.model : null,
        deviceUsed: result ? result.device_used : null,
        language: result ? result.language : null,
        duration: result ? result.duration : req.duration,
        segments: result ? result.segments : req.segments,
      };
      req.error = null;
      logger.info('transcribe', `RESULT 到达：${req.input} 段数=${(done.segments || []).length}`);
      this.emit('update', { type: 'done', ...done });
    } else if (key === 'ERROR') {
      req.error = val;
      logger.error('transcribe', `python 上报错误：${req.input} ${val}`);
      this.emit('update', { type: 'error', input: req.input, message: val });
    }
  }

  cancel() {
    if (!this.active) return false;
    const req = this.active;
    req.cancelled = true;
    clearInterval(req.watchdog);
    const pid = req.proc.pid;
    // 立即释放「活动任务」标记：让新任务马上可以开启，不等子进程真正退出
    this.active = null;
    logger.info('transcribe', `用户取消：${req.input}`);
    try { req.proc.kill(); } catch (_) { /* ignore */ }
    // Windows 上 kill 可能只终止 py 启动器而留下 python 子进程，用 taskkill 整树终止
    if (process.platform === 'win32' && pid) {
      try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) { /* ignore */ }
    }
    this.emit('update', { type: 'cancel', input: req.input });
    return true;
  }

  status() {
    if (this.active) {
      return { active: true, input: this.active.input, state: this.active.state, percent: this.active.percent };
    }
    return { active: false };
  }
}

module.exports = { Transcriber };
