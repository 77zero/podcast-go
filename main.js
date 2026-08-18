const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const settings = require('./lib/settings');
const rss = require('./lib/rss');
const drives = require('./lib/drives');
const importer = require('./lib/import');
const library = require('./lib/library');
const feeds = require('./lib/feeds');
const { TaskManager } = require('./lib/tasks');
const { Transcriber } = require('./lib/transcriber');
const logger = require('./lib/logger');
const markdown = require('./lib/markdown');

const tasks = new TaskManager();
const transcriber = new Transcriber();
let mainWindow = null;
const transcribeBucket = new Map(); // input -> 进度 10% 桶，用于落盘限频

const userDataDir = () => app.getPath('userData');
const venvDir = () => path.join(userDataDir(), 'transcribe-venv');

// 工具类应用无需 GPU 加速；禁用可避免在虚拟机/远程桌面/无独显环境崩溃
app.disableHardwareAcceleration();

function ensureLibrary(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 改名后 userData 目录变了（podcast-mp3-tool -> podcast-go / 播客转MP3工具 -> 播客随身听）。
// 启动时若新目录还没有数据、旧目录有，就把订阅/设置迁移过去，避免用户丢失订阅。
const LEGACY_USER_DATA = ['podcast-mp3-tool', '播客转MP3工具'];
function migrateLegacyData() {
  try {
    const newDir = app.getPath('userData');
    if (fs.existsSync(path.join(newDir, 'feeds.json'))) return; // 新数据已存在，不动
    for (const legacy of LEGACY_USER_DATA) {
      const oldDir = path.join(app.getPath('appData'), legacy);
      if (!fs.existsSync(oldDir) || oldDir === newDir) continue;
      let copied = false;
      for (const file of ['feeds.json', 'settings.json']) {
        const src = path.join(oldDir, file);
        if (fs.existsSync(src) && !fs.existsSync(path.join(newDir, file))) {
          fs.mkdirSync(newDir, { recursive: true });
          fs.copyFileSync(src, path.join(newDir, file));
          copied = true;
        }
      }
      if (copied) console.log(`[migrate] 已从 ${oldDir} 迁移订阅数据`);
    }
  } catch (err) {
    console.warn('[migrate] 迁移失败：' + err.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    title: '播客随身听',
    backgroundColor: '#0e1219',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  logger.init(path.join(app.getPath('userData'), 'logs'));
  logger.info('app', '应用启动，版本 ' + app.getVersion());
  migrateLegacyData();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 任务进度广播给渲染进程 + 落盘日志（阶段切换与每 10% 变化才记，避免下载/转码高频刷屏）
const taskLogCache = new Map(); // id -> { stage, bucket }
tasks.on('update', (t) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('task:update', t);
  }
  const prev = taskLogCache.get(t.id) || {};
  const bucket = t.percent == null ? -1 : Math.floor(t.percent / 10);
  const stageChanged = prev.stage !== t.stage;
  const bucketChanged = prev.bucket !== bucket;
  const terminal = t.status === 'ready' || t.status === 'error' || t.status === 'cancelled';
  if (stageChanged || bucketChanged || terminal) {
    logger.info('task', `${t.id} ${t.status}/${t.stage} ${t.percent}% ${t.message || ''}${t.error ? ' ERR:' + t.error : ''}`);
    taskLogCache.set(t.id, { stage: t.stage, bucket });
  }
});

// ---- RSS ----
ipcMain.handle('rss:fetch', async (_e, url) => {
  const feed = await rss.fetchFeed(String(url || '').trim());
  return feed;
});

// ---- 播客搜索（Apple Podcasts / iTunes 搜索接口）----
ipcMain.handle('search:podcasts', async (_e, term) => {
  const q = String(term || '').trim();
  if (!q) return { results: [] };
  const url =
    'https://itunes.apple.com/search?term=' + encodeURIComponent(q) +
    '&media=podcast&entity=podcast&limit=15';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('搜索服务返回 HTTP ' + res.status);
    const data = await res.json();
    const results = (data.results || [])
      .filter((r) => r.feedUrl)
      .map((r) => ({
        id: r.collectionId,
        name: r.collectionName || '',
        author: r.artistName || '',
        genre: r.primaryGenreName || '',
        trackCount: r.trackCount || 0,
        feedUrl: r.feedUrl,
        artwork: r.artworkUrl600 || r.artworkUrl100 || null,
      }));
    return { results };
  } catch (err) {
    if (controller.signal.aborted) throw new Error('搜索超时，请重试或直接粘贴 RSS 地址');
    throw err;
  } finally {
    clearTimeout(timer);
  }
});

// ---- 热门榜单（Apple Podcasts Top Charts）----
ipcMain.handle('charts:top', async (_e, country) => {
  const cc = String(country || 'us').toLowerCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const chartUrl = `https://itunes.apple.com/${cc}/rss/toppodcasts/limit=25/explicit=true/json`;
    const res = await fetch(chartUrl, { signal: controller.signal });
    if (!res.ok) throw new Error('榜单服务返回 HTTP ' + res.status);
    const data = await res.json();
    const entries = (data.feed && data.feed.entry) || [];
    const ids = entries.map((e) => e.id.attributes['im:id']).filter(Boolean);

    // 批量 lookup，一次性补上每档节目的 RSS 地址
    const feedMap = {};
    if (ids.length) {
      const lk = await fetch('https://itunes.apple.com/lookup?id=' + ids.join(','), {
        signal: controller.signal,
      });
      if (lk.ok) {
        const lkData = await lk.json();
        for (const r of (lkData.results || [])) {
          if (r.collectionId != null && r.feedUrl) feedMap[r.collectionId] = r;
        }
      }
    }

    const results = entries
      .map((e) => {
        const cid = e.id.attributes['im:id'];
        const extra = feedMap[cid] || {};
        const img = e['im:image'] && e['im:image'].length
          ? e['im:image'][e['im:image'].length - 1].label : null;
        return {
          id: cid,
          name: (e['im:name'] && e['im:name'].label) || '',
          author: (e['im:artist'] && e['im:artist'].label) || '',
          genre: (e.category && e.category.attributes && e.category.attributes.label) || extra.primaryGenreName || '',
          trackCount: extra.trackCount || 0,
          feedUrl: extra.feedUrl || null,
          artwork: img ? img.replace('170x170bb', '340x340bb') : null,
        };
      })
      .filter((r) => r.feedUrl);
    return { results, country: cc };
  } catch (err) {
    if (controller.signal.aborted) throw new Error('加载榜单超时，请重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
});

// ---- 设置 ----
ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => settings.set(patch || {}));

// ---- 媒体库 ----
ipcMain.handle('library:dir', () => {
  const s = settings.get();
  return ensureLibrary(s.libraryDir);
});
ipcMain.handle('library:list', async () => {
  const s = settings.get();
  ensureLibrary(s.libraryDir);
  return library.listMp3(s.libraryDir);
});
ipcMain.handle('library:open', () => {
  const s = settings.get();
  const dir = ensureLibrary(s.libraryDir);
  shell.openPath(dir);
  return dir;
});

// ---- 任务 ----
ipcMain.handle('task:add', (_e, { title, feed, audioUrl }) => {
  const s = settings.get();
  ensureLibrary(s.libraryDir);
  return tasks.add({ title, feed, audioUrl, libraryDir: s.libraryDir, settings: s });
});
ipcMain.handle('task:cancel', (_e, id) => tasks.cancel(id));
ipcMain.handle('task:list', () => tasks.list());
ipcMain.handle('task:clearFinished', () => tasks.clearFinished());

// ---- 磁盘 ----
ipcMain.handle('drives:list', () => drives.listDrives());

// ---- 目录选择 ----
ipcMain.handle('dialog:selectFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择导入目标文件夹',
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

// ---- 转写：选择音频文件 ----
ipcMain.handle('dialog:selectAudio', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择要转写的音频文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'm4b', 'aac', 'ogg', 'flac', 'opus', 'mp4'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

// ---- 导入 ----
ipcMain.handle('import:start', async (_e, { files, targetDir, subfolder }) => {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可导入的 MP3 文件');
  }
  let dest = String(targetDir || '').trim();
  if (!dest) throw new Error('请先选择目标设备或文件夹');
  if (subfolder) dest = path.join(dest, String(subfolder));
  ensureLibrary(dest);
  logger.info('import', `开始导入 ${files.length} 个文件 → ${dest}`);

  const controller = new AbortController();
  const started = Date.now();
  try {
    const result = await importer.importFiles(files, dest, {
      signal: controller.signal,
      onProgress: (percent, info) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('import:progress', { percent, ...info });
        }
        if (info && info.current) {
          logger.info('import', `进度 ${percent}% ${info.done}/${info.total} ${info.current}`);
        }
      },
    });
    logger.info('import', `导入完成 ${result.length} 个文件，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { dest, count: result.length };
  } catch (err) {
    logger.error('import', `导入失败：${err.message}`);
    throw err;
  }
});

// ---- 订阅持久化 ----
ipcMain.handle('feeds:load', () => feeds.load(userDataDir()));
ipcMain.handle('feeds:save', (_e, list) => feeds.save(userDataDir(), Array.isArray(list) ? list : []));

// ---- 转写（faster-whisper）----
transcriber.setVenvDir(venvDir());
transcriber.on('update', (payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transcribe:update', payload);
  }
  // 落盘：done / error / setup 及状态切换、每 10% 进度变化
  const p = payload;
  if (p.type === 'done') {
    logger.info('transcribe', `完成：${p.input} 设备=${p.deviceUsed} 模型=${p.model} 语言=${p.language} 时长=${p.duration}s 段数=${(p.segments || []).length}`);
  } else if (p.type === 'error') {
    logger.error('transcribe', `错误：${p.input} ${p.message}`);
  } else if (p.type === 'cancel') {
    logger.info('transcribe', `已取消：${p.input}`);
  } else if (p.type === 'progress' && p.state) {
    if (p.state === 'decoding') {
      const bucket = Math.min(9, Math.floor((p.percent || 0) / 10));
      if (bucket !== transcribeBucket.get(p.input)) {
        transcribeBucket.set(p.input, bucket);
        logger.info('transcribe', `进度 ${p.percent}% 输入=${p.input}`);
      }
    } else {
      logger.info('transcribe', `状态 ${p.state} 输入=${p.input}`);
    }
  }
});
// 转写产物命名净化：文件名与目录去标点、非法字符，避免产物名携带原标题的标点。
// 规则：保留中/日/韩文字、ASCII 字母数字、空格、点（.）、下划线、连字符，
// 其余符号与标点（全角 ，。？！｜：；等、半角非法字符）一律清理；半角非法字符替换为下划线，其余替换为空格。
// 注意：此清理规则必须与 renderer.transcriptPathFor 保持一致。
function cleanTranscriptName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_') // 半角非法字符 -> 下划线
    .replace(/[^A-Za-z0-9._\-\s\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ') // 其余标点/符号 -> 空格
    .replace(/\s+/g, ' ') // 压缩连续空白（含全角空格）
    .trim()
    .slice(0, 120) || 'untitled';
}

// 转写产物按音频管理：每个音频一个同名子目录，产物（json + md）放进该目录。
// 目录名与文件名都经 cleanTranscriptName 净化（不再携带原标题的标点，后缀去掉 .transcript）。
function transcriptOutputFor(input, explicit) {
  if (explicit) return String(explicit);
  const p = String(input);
  const dir = p.replace(/[\\/][^\\/]*$/, '');
  const raw = p.split(/[\\/]/).pop().replace(/\.(mp3|wav|m4a|m4b|aac|ogg|flac|opus|mp4)$/i, '');
  const base = cleanTranscriptName(raw);
  return dir + '\\' + base + '\\' + base + '.json';
}
ipcMain.handle('transcribe:start', async (_e, opts) => {
  const input = String((opts && opts.input) || '').trim();
  if (!input) throw new Error('缺少音频文件路径');
  const output = transcriptOutputFor(input, opts && opts.output);
  fs.mkdirSync(path.dirname(output), { recursive: true }); // 确保产物目录存在
  const s = settings.get();
  try {
    return await transcriber.start({
      input,
      output,
      model: (opts && opts.model) || s.transcribeModel || 'small',
      device: (opts && opts.device) || s.transcribeDevice || 'auto',
      language: (opts && opts.language) || s.transcribeLanguage || 'auto',
    });
  } catch (err) {
    logger.error('transcribe', `发起失败：${input} ${err.message}`);
    throw err;
  }
});
ipcMain.handle('transcribe:cancel', () => transcriber.cancel());
ipcMain.handle('transcribe:status', () => transcriber.status());
// 批量查询转写状态（「已转译/未转译」持久化）。
// 权威依据就是磁盘上的转写产物：产物 json 存在即视为已转译，重启后据此恢复界面状态。
// 返回 { [input]: { jsonPath, doneAt } | null }
ipcMain.handle('transcribe:statuses', (_e, inputs) => {
  const list = Array.isArray(inputs) ? inputs : [];
  const out = {};
  for (const raw of list) {
    const input = String(raw || '');
    if (typeof raw !== 'string' || !input.trim()) continue;
    const jsonPath = transcriptOutputFor(input);
    try {
      const st = fs.statSync(jsonPath);
      if (st.isFile() && st.size > 0) {
        out[input] = { jsonPath, doneAt: st.mtimeMs };
        continue;
      }
    } catch (_) { /* 无产物 -> 未转译 */ }
    out[input] = null;
  }
  return out;
});
ipcMain.handle('transcribe:doctor', () => transcriber.doctor());
ipcMain.handle('transcribe:setup', () => transcriber.setup());
ipcMain.handle('transcribe:read', (_e, jsonPath) => {
  try {
    const raw = fs.readFileSync(String(jsonPath), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('无法读取逐字稿：' + err.message);
  }
});

// 快速获取转写产物：打开 / 定位对应的 Markdown 逐字稿文件
// 老版本产物可能只有 json（.txt 时代之前/未生成 .md），md 缺失时从 json 即时生成，
// 避免「未找到 Markdown 文件」；json 是权威数据（含全部分段），生成规则与 python 版一致。
function mdPathFor(jsonPath) {
  return String(jsonPath).replace(/\.json$/, '.md');
}
function ensureMdFile(jsonPath) {
  const mdPath = mdPathFor(jsonPath);
  if (fs.existsSync(mdPath)) return mdPath;
  try {
    const data = JSON.parse(fs.readFileSync(String(jsonPath), 'utf8'));
    const baseName = String(jsonPath).split(/[\\/]/).pop().replace(/\.(json)$/i, '');
    const md = markdown.buildMarkdown(baseName, data);
    fs.writeFileSync(mdPath, md, 'utf8');
    logger.info('transcribe', `已从 json 补生成 md：${mdPath}`);
    return mdPath;
  } catch (err) {
    throw new Error('未找到 Markdown 文件，且无法从 json 生成：' + err.message);
  }
}
ipcMain.handle('transcribe:openMd', (_e, jsonPath) => {
  const mdPath = ensureMdFile(jsonPath);
  shell.openPath(mdPath);
  return mdPath;
});
ipcMain.handle('transcribe:revealMd', (_e, jsonPath) => {
  const mdPath = ensureMdFile(jsonPath);
  shell.showItemInFolder(mdPath);
  return mdPath;
});