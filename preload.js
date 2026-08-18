const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // RSS
  fetchFeed: (url) => ipcRenderer.invoke('rss:fetch', url),
  searchPodcasts: (term) => ipcRenderer.invoke('search:podcasts', term),
  topCharts: (country) => ipcRenderer.invoke('charts:top', country),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 媒体库
  getLibraryDir: () => ipcRenderer.invoke('library:dir'),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  openLibrary: () => ipcRenderer.invoke('library:open'),

  // 任务
  addTask: (opts) => ipcRenderer.invoke('task:add', opts),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  listTasks: () => ipcRenderer.invoke('task:list'),
  clearFinished: () => ipcRenderer.invoke('task:clearFinished'),

  // 磁盘 / 目录 / 导入
  listDrives: () => ipcRenderer.invoke('drives:list'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  selectAudio: () => ipcRenderer.invoke('dialog:selectAudio'),
  importFiles: (opts) => ipcRenderer.invoke('import:start', opts),

  // 订阅持久化
  loadFeeds: () => ipcRenderer.invoke('feeds:load'),
  saveFeeds: (list) => ipcRenderer.invoke('feeds:save', list),

  // 转写
  startTranscribe: (opts) => ipcRenderer.invoke('transcribe:start', opts),
  cancelTranscribe: () => ipcRenderer.invoke('transcribe:cancel'),
  transcribeStatus: () => ipcRenderer.invoke('transcribe:status'),
  transcribeStatuses: (inputs) => ipcRenderer.invoke('transcribe:statuses', inputs),
  transcribeDoctor: () => ipcRenderer.invoke('transcribe:doctor'),
  transcribeSetup: () => ipcRenderer.invoke('transcribe:setup'),
  readTranscript: (jsonPath) => ipcRenderer.invoke('transcribe:read', jsonPath),
  openTranscriptMd: (jsonPath) => ipcRenderer.invoke('transcribe:openMd', jsonPath),
  revealTranscriptMd: (jsonPath) => ipcRenderer.invoke('transcribe:revealMd', jsonPath),

  // 事件
  onTaskUpdate: (cb) => ipcRenderer.on('task:update', (_e, data) => cb(data)),
  onImportProgress: (cb) => ipcRenderer.on('import:progress', (_e, data) => cb(data)),
  onTranscribeUpdate: (cb) => ipcRenderer.on('transcribe:update', (_e, data) => cb(data)),
});
