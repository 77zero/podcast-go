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

const tasks = new TaskManager();
const transcriber = new Transcriber();
let mainWindow = null;

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
  migrateLegacyData();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 任务进度广播给渲染进程
tasks.on('update', (t) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('task:update', t);
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

  const controller = new AbortController();
  const result = await importer.importFiles(files, dest, {
    signal: controller.signal,
    onProgress: (percent, info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('import:progress', { percent, ...info });
      }
    },
  });
  return { dest, count: result.length };
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
});
ipcMain.handle('transcribe:start', async (_e, opts) => {
  const input = String((opts && opts.input) || '').trim();
  if (!input) throw new Error('缺少音频文件路径');
  const s = settings.get();
  const output = (opts && opts.output) || input.replace(/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i, '.transcript.json');
  return transcriber.start({
    input,
    output,
    model: (opts && opts.model) || s.transcribeModel || 'small',
    device: (opts && opts.device) || s.transcribeDevice || 'auto',
    language: (opts && opts.language) || s.transcribeLanguage || 'auto',
  });
});
ipcMain.handle('transcribe:cancel', () => transcriber.cancel());
ipcMain.handle('transcribe:status', () => transcriber.status());
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
