'use strict';

/* ---------- 状态 ---------- */
const state = {
  settings: null,
  feeds: [],           // { key, url, title, image, items: [] }
  activeFeed: null,    // feed key
  selected: new Set(), // episode id = `${feedKey}::${item.id}`
  tasks: new Map(),    // id -> task
  library: [],         // { path, name, rel, size, mtime }
  libSelected: new Set(),
  drives: [],
  targetDir: null,     // 手动选择的文件夹（覆盖下拉框）
  autoImported: new Set(), // 已自动导入的任务 id
  dropdownKind: null,      // null | 'search' | 'charts'
  chartCountry: 'us',
  chartsCache: {},         // country -> { results, country }
  transcribes: new Map(),  // inputPath -> { state, percent, segments, message }
  page: 'podcast',           // 'podcast' | 'transcribe'
  tsSources: [],             // [{ path, name }] 待转写音频
  tsActive: null,            // 当前查看/正在转写的源路径
  tsHistory: [],             // [{ path, name, jsonPath, doneAt }] 转写历史
};
let currentTranscriptJsonPath = null; // 当前打开的逐字稿 json 路径

let searchTimer = null; // 输入防抖

function isTypingTarget(t) {
  if (!t) return false;
  return t.matches && t.matches('input, textarea, select') || (t.isContentEditable || false);
}

/* ---------- DOM 工具 ---------- */
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'innerHTML') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' KB';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function fmtSpeed(bps) {
  if (!bps || !isFinite(bps) || bps <= 0) return '';
  const mbps = bps / 1024 / 1024;
  if (mbps >= 1) return mbps.toFixed(1) + ' MB/s';
  return Math.max(0, Math.round(bps / 1024)) + ' KB/s';
}

function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '…';
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/* ---------- 波形进度条 ---------- */
function waveSpans(percent) {
  const N = 40;
  let html = '';
  for (let i = 0; i < N; i++) {
    const h = 0.22 + 0.78 * (0.5 + 0.5 * Math.sin(i * 1.7));
    const filled = i / N < (percent || 0) / 100 ? 1 : 0;
    html += `<span style="--h:${h.toFixed(2)}" data-f="${filled}"></span>`;
  }
  return html;
}
function wavebarHtml(percent, cls = '') {
  return `<div class="wavebar ${cls}">${waveSpans(percent)}</div>`;
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

/* ---------- 初始化 ---------- */
async function init() {
  bindEvents();
  try {
    state.settings = await window.api.getSettings();
    applySettingsToUI();
    await refreshDrives();
    await refreshLibrary();
    const tasks = await window.api.listTasks();
    for (const t of tasks) state.tasks.set(t.id, t);
    renderTasks();
    // 恢复已转译/未转译状态与转写历史（基于磁盘产物，跨重启保持）
    await restoreTranscribeStatuses();

    // 加载持久化的订阅（含剧集快照）
    const saved = await window.api.loadFeeds();
    if (Array.isArray(saved) && saved.length) {
      state.feeds = saved;
      if (!state.activeFeed) state.activeFeed = state.feeds[0].key;
      renderFeedSwitcher();
      renderEpisodes();
      // 后台刷新各订阅的剧集列表（失败则保留旧快照）
      for (const f of state.feeds) refreshFeedItems(f);
    }
  } catch (err) {
    toast('初始化失败：' + err.message, true);
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  window.api.onTaskUpdate((t) => {
    const prev = state.tasks.get(t.id);
    const statusChanged = !prev || prev.status !== t.status;
    state.tasks.set(t.id, t);
    renderTasks();
    if (statusChanged) renderEpisodes();
    if (t.status === 'ready') {
      refreshLibrary();
      autoImportIfEnabled(t);
    }
  });

  window.api.onImportProgress((p) => {
    const elp = $('#importProgress');
    elp.classList.add('active');
    $('#importWave').innerHTML = waveSpans(p.percent);
    const status = $('#importStatus');
    if (p.current) {
      status.textContent = `导入中 ${p.done}/${p.total} · ${p.current}`;
    }
  });

  $('#addFeedBtn').addEventListener('click', onSubmit);
  $('#feedUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSubmit();
    else if (e.key === 'Escape') { closeSearchResults(); $('#feedUrl').blur(); }
  });
  $('#feedUrl').addEventListener('focus', () => {
    if (!$('#feedUrl').value.trim() && !state.dropdownKind) showPopularSuggestions();
  });
  $('#feedUrl').addEventListener('input', () => {
    updateSubmitBtn();
    const v = $('#feedUrl').value.trim();
    clearTimeout(searchTimer);
    if (v) {
      searchTimer = setTimeout(() => doSearch(v, true), 300);
    } else {
      closeSearchResults();
      showPopularSuggestions();
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) closeSearchResults();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !isTypingTarget(e.target)) {
      e.preventDefault();
      $('#feedUrl').focus();
    }
  });
  $('#hotBtn').addEventListener('click', onHotClick);
  $('#selectAllBtn').addEventListener('click', toggleSelectAll);
  $('#addToQueueBtn').addEventListener('click', addSelectedToQueue);
  $('#clearDoneBtn').addEventListener('click', clearFinished);

  $('#refreshDrivesBtn').addEventListener('click', () => refreshDrives().then(() => toast('已重新扫描设备')));
  $('#driveSelect').addEventListener('change', (e) => {
    if (e.target.value === '__custom__') {
      pickFolder();
    } else if (e.target.value) {
      state.targetDir = null;
      updateDriveSpace();
    }
  });
  $('#pickFolderBtn').addEventListener('click', pickFolder);
  $('#subfolderChk').addEventListener('change', (e) => {
    $('#subfolderName').textContent = state.settings.importSubfolder;
  });
  $('#autoImportChk').addEventListener('change', (e) => {
    state.settings.autoImportAfterConvert = e.target.checked;
    window.api.setSettings({ autoImportAfterConvert: e.target.checked });
    if (e.target.checked) toast('已开启：下载转码完成后将自动导入到所选设备');
  });
  $('#importBtn').addEventListener('click', doImport);
  $('#openLibBtn').addEventListener('click', () => window.api.openLibrary());

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsCancelBtn').addEventListener('click', closeSettings);
  $('#settingsSaveBtn').addEventListener('click', saveSettings);
  $('#pickLibraryBtn').addEventListener('click', async () => {
    const dir = await window.api.selectFolder();
    if (dir) $('#setLibrary').value = dir;
  });
  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target === $('#settingsModal')) closeSettings();
  });
  // 页面导航（播客 / 转写）
  document.querySelectorAll('.page-nav-btn').forEach((b) => {
    b.addEventListener('click', () => switchPage(b.dataset.page));
  });

  // 转写页：源文件 / 媒体库
  $('#tsPickAudioBtn').addEventListener('click', async () => {
    const files = await window.api.selectAudio();
    if (files && files.length) {
      for (const f of files) addTsSource(f);
      renderTsSources();
      toast(`已添加 ${files.length} 个音频`);
    }
  });
  $('#tsOpenLibBtn').addEventListener('click', () => window.api.openLibrary());

  // 转写页：环境
  $('#tsDoctorBtn').addEventListener('click', () => runTranscribeDoctor(false));
  $('#tsSetupBtn').addEventListener('click', runTranscribeSetup);

  // 转写页：选项（同步到设置）
  const persistTsOption = (key) => (e) => {
    state.settings[key] = e.target.value;
    window.api.setSettings({ [key]: e.target.value });
  };
  $('#tsModel').addEventListener('change', persistTsOption('transcribeModel'));
  $('#tsDevice').addEventListener('change', persistTsOption('transcribeDevice'));
  $('#tsLang').addEventListener('change', persistTsOption('transcribeLanguage'));

  // 转写页：开始 / 取消
  $('#tsStartBtn').addEventListener('click', () => startTranscribe());
  $('#tsCancelBtn').addEventListener('click', async () => {
    const ok = await window.api.cancelTranscribe();
    if (ok) toast('已取消转写');
  });

  window.api.onTranscribeUpdate((data) => onTranscribeUpdate(data));
}

/* ---------- 订阅：搜索 / 添加播客 ---------- */
function isUrl(text) {
  return /^https?:\/\//i.test(text) || /^feed:/i.test(text);
}

function updateSubmitBtn() {
  $('#addFeedBtn').textContent = isUrl($('#feedUrl').value.trim()) ? '添加播客' : '搜索';
}

async function onSubmit() {
  const text = $('#feedUrl').value.trim();
  if (!text) return toast('请输入播客关键词或 RSS 地址');
  if (isUrl(text)) await subscribeFeed(text);
  else await doSearch(text);
}

async function doSearch(term, silent) {
  const btn = $('#addFeedBtn');
  const oldLabel = btn.textContent;
  if (!silent) {
    btn.disabled = true;
    btn.textContent = '搜索中…';
  }
  try {
    const { results } = await window.api.searchPodcasts(term);
    if (silent && $('#feedUrl').value.trim() !== term) return;
    renderSearchResults(results, term);
  } catch (err) {
    closeSearchResults();
    if (!silent) toast('搜索失败：' + err.message, true);
  } finally {
    if (!silent) {
      btn.disabled = false;
      btn.textContent = oldLabel;
      updateSubmitBtn();
    }
  }
}

function searchResultItem(r, rank) {
  const item = el('div', { class: 'search-item' },
    rank ? el('span', { class: 'search-rank' + (rank <= 3 ? ' top' : ''), text: String(rank) }) : null,
    r.artwork ? el('img', { class: 'search-art', src: r.artwork, alt: '' }) : null,
    el('div', { class: 'search-main' },
      el('div', { class: 'search-name', text: r.name }),
      el('div', { class: 'search-meta',
        text: [r.author, r.genre, r.trackCount ? `${r.trackCount} 集` : ''].filter(Boolean).join(' · ') }),
    ),
    el('button', { class: 'btn btn-primary btn-sm', text: '订阅',
      onclick: (e) => { e.stopPropagation(); subscribeFeed(r.feedUrl); } }),
  );
  item.addEventListener('click', () => subscribeFeed(r.feedUrl));
  return item;
}

function renderSearchResults(results, term) {
  state.dropdownKind = 'search';
  const box = $('#searchResults');
  box.innerHTML = '';
  box.append(el('div', { class: 'search-head' },
    el('span', { class: 'search-head-title', text: `“${term}” 的结果` }),
    el('span', { class: 'search-hint', innerHTML: '回车订阅 · <kbd>Esc</kbd> 关闭' }),
  ));
  if (!results.length) {
    box.append(el('div', { class: 'search-empty',
      text: `没有找到「${term}」相关的播客。可换个关键词，或直接粘贴 RSS 地址。` }));
    box.classList.remove('hidden');
    return;
  }
  for (const r of results) box.append(searchResultItem(r));
  box.classList.remove('hidden');
}

/* ---------- 热门榜单 ---------- */
const COUNTRIES = [
  { code: 'us', label: '美区' },
  { code: 'cn', label: '中国区' },
  { code: 'jp', label: '日本区' },
  { code: 'gb', label: '英国区' },
];

function onHotClick() {
  if (state.dropdownKind === 'charts') {
    closeSearchResults();
    return;
  }
  loadTopCharts(state.chartCountry);
}

// Fey 风格：聚焦空输入框时展示「热门推荐」（命令面板的 Popular 区）
async function showPopularSuggestions() {
  if (state.dropdownKind === 'charts' || state.dropdownKind === 'search') return;
  const cached = state.chartsCache && state.chartsCache.us;
  if (cached) { renderCharts(cached.results, cached.country, true); return; }
  try {
    const data = await window.api.topCharts('us');
    if (state.dropdownKind) return; // 用户已经输入/切换
    if (!state.chartsCache) state.chartsCache = {};
    state.chartsCache.us = data;
    renderCharts(data.results, data.country, true);
  } catch (_) { /* 静默失败，不打扰 */ }
}

async function loadTopCharts(country) {
  state.chartCountry = country || 'us';
  const cached = state.chartsCache && state.chartsCache[state.chartCountry];
  if (cached) { renderCharts(cached.results, cached.country); return; }
  const btn = $('#hotBtn');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '加载中…';
  try {
    const data = await window.api.topCharts(state.chartCountry);
    if (!state.chartsCache) state.chartsCache = {};
    state.chartsCache[state.chartCountry] = data;
    renderCharts(data.results, data.country);
  } catch (err) {
    closeSearchResults();
    toast('加载热门榜单失败：' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function renderCharts(results, country, asSuggestion) {
  state.dropdownKind = 'charts';
  const box = $('#searchResults');
  box.innerHTML = '';

  const sel = el('select', { class: 'chart-select' },
    COUNTRIES.map((c) => el('option', { value: c.code, text: c.label, selected: c.code === country ? '' : false })),
  );
  sel.addEventListener('change', (e) => loadTopCharts(e.target.value));

  box.append(el('div', { class: 'search-head' },
    el('span', { class: 'search-head-title', text: asSuggestion ? '🔥 热门推荐' : '🔥 热门播客' }),
    sel,
    el('span', { class: 'search-hint', innerHTML: '输入关键词搜索 · <kbd>Esc</kbd> 关闭' }),
  ));

  if (!results.length) {
    box.append(el('div', { class: 'search-empty', text: '该区域暂无热门榜单数据。' }));
  } else {
    results.forEach((r, i) => box.append(searchResultItem(r, i + 1)));
  }
  box.classList.remove('hidden');
}

function closeSearchResults() {
  state.dropdownKind = null;
  const box = $('#searchResults');
  box.classList.add('hidden');
  box.innerHTML = '';
}

async function subscribeFeed(url) {
  const btn = $('#addFeedBtn');
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = '订阅中…';
  try {
    const feed = await window.api.fetchFeed(url);
    const key = 'f' + Date.now();
    state.feeds.push({ key, url, title: feed.title, image: feed.image, items: feed.items });
    state.activeFeed = key;
    $('#feedUrl').value = '';
    closeSearchResults();
    window.api.saveFeeds(state.feeds); // 持久化订阅
    renderFeedSwitcher();
    renderEpisodes();
    toast(`已添加「${feed.title}」，共 ${feed.items.length} 集`);
  } catch (err) {
    toast('无法读取该订阅：' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
    updateSubmitBtn();
  }
}

function activeFeed() {
  return state.feeds.find((f) => f.key === state.activeFeed) || null;
}

function renderFeedSwitcher() {
  const box = $('#feedSwitcher');
  box.innerHTML = '';
  if (state.feeds.length === 0) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';
  for (const f of state.feeds) {
    const chip = el('span', { class: 'feed-chip' + (f.key === state.activeFeed ? ' active' : '') },
      el('span', { text: f.title }),
      el('span', { class: 'count', text: String(f.items.length) }),
      el('span', { class: 'x', text: '×', onclick: (e) => { e.stopPropagation(); removeFeed(f.key); } }),
    );
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) return;
      state.activeFeed = f.key;
      renderFeedSwitcher();
      renderEpisodes();
    });
    box.append(chip);
  }
}

function removeFeed(key) {
  state.feeds = state.feeds.filter((f) => f.key !== key);
  for (const id of state.selected) {
    if (id.startsWith(key + '::')) state.selected.delete(id);
  }
  if (state.activeFeed === key) state.activeFeed = state.feeds.length ? state.feeds[0].key : null;
  window.api.saveFeeds(state.feeds); // 持久化订阅
  renderFeedSwitcher();
  renderEpisodes();
}

// 后台刷新某个订阅的剧集列表（失败保留旧快照）
async function refreshFeedItems(feed) {
  try {
    const f = await window.api.fetchFeed(feed.url);
    feed.title = f.title || feed.title;
    feed.image = f.image || feed.image;
    feed.items = f.items || feed.items;
    if (state.activeFeed === feed.key) {
      renderFeedSwitcher();
      renderEpisodes();
    }
    window.api.saveFeeds(state.feeds);
  } catch (_) { /* 保留旧数据，不打扰 */ }
}

/* ---------- 订阅：剧集列表 ---------- */
const STATUS_MAP = {
  queued: ['排队中', 's-queued'],
  download: ['下载中', 's-download'],
  convert: ['转码中', 's-convert'],
  ready: ['已完成', 's-ready'],
  error: ['失败', 's-error'],
  cancelled: ['已取消', 's-cancelled'],
};

// 找到与某集对应的最新任务（按 播客名+标题 匹配）
function episodeTask(feed, item) {
  let found = null;
  for (const t of state.tasks.values()) {
    if (t.feed === feed.title && t.title === item.title) {
      if (!found || t.addedAt > found.addedAt) found = t;
    }
  }
  return found;
}

function episodeQuickBtn(feed, item, task) {
  if (!task) {
    return el('button', { class: 'item-quick', text: '下载', onclick: (e) => { e.stopPropagation(); queueEpisode(feed, item); } });
  }
  if (task.status === 'ready') {
    return el('button', { class: 'item-quick done', text: '✓ 已下载', disabled: true });
  }
  if (task.status === 'error' || task.status === 'cancelled') {
    return el('button', { class: 'item-quick retry', text: '重试', onclick: (e) => { e.stopPropagation(); retryTask(task); } });
  }
  return el('button', { class: 'item-quick', text: '排队中', disabled: true });
}

function renderEpisodes() {
  const box = $('#episodes');
  box.innerHTML = '';
  const feed = activeFeed();

  if (!feed) {
    $('#feedTitle').textContent = '选择一个播客';
    box.append(emptyHint('粘贴 RSS 订阅地址后，剧集会在这里列出。\n支持绝大多数播客 / iTunes 订阅源。'));
    return;
  }
  $('#feedTitle').textContent = feed.title;

  if (feed.items.length === 0) {
    box.append(emptyHint('这个订阅里没有找到可下载的音频。'));
    return;
  }

  for (const item of feed.items) {
    const id = `${feed.key}::${item.id}`;
    const checked = state.selected.has(id);
    const cover = item.image || feed.image;
    const task = episodeTask(feed, item);
    const st = task ? STATUS_MAP[task.stage] : null;
    const row = el('div', { class: 'item' + (checked ? ' checked' : ''), dataset: { id } },
      el('input', { type: 'checkbox', checked: checked ? '' : false }),
      cover ? el('img', { class: 'item-cover', src: cover, alt: '' }) : null,
      el('div', { class: 'item-main' },
        el('div', { class: 'item-title-row' },
          el('div', { class: 'item-title', text: item.title }),
          st ? el('span', { class: 'ep-badge ' + st.cls, text: st.label }) : null,
        ),
        el('div', { class: 'item-meta' },
          item.durationLabel ? el('span', { text: item.durationLabel }) : null,
          item.date ? el('span', { text: fmtDate(item.date) }) : null,
          item.length ? el('span', { text: fmtSize(item.length) }) : null,
        ),
      ),
      episodeQuickBtn(feed, item, task),
    );

    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      toggleEpisode(id, row);
    });
    row.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      row.classList.toggle('checked', e.target.checked);
      updateSelectAllBtn();
    });

    box.append(row);
  }
  updateSelectAllBtn();
}

function toggleEpisode(id, row) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  const checked = state.selected.has(id);
  row.classList.toggle('checked', checked);
  const cb = row.querySelector('input');
  if (cb) cb.checked = checked;
  updateSelectAllBtn();
}

function toggleSelectAll() {
  const feed = activeFeed();
  if (!feed) return;
  const ids = feed.items.map((it) => `${feed.key}::${it.id}`);
  const allChecked = ids.every((id) => state.selected.has(id));
  if (allChecked) {
    ids.forEach((id) => state.selected.delete(id));
  } else {
    ids.forEach((id) => state.selected.add(id));
  }
  renderEpisodes();
}

function updateSelectAllBtn() {
  const feed = activeFeed();
  const btn = $('#selectAllBtn');
  if (!feed || feed.items.length === 0) {
    btn.textContent = '全选';
    return;
  }
  const ids = feed.items.map((it) => `${feed.key}::${it.id}`);
  const allChecked = ids.every((id) => state.selected.has(id));
  btn.textContent = allChecked ? '取消全选' : '全选';
}

function queueEpisode(feed, item) {
  addTask(feed, item);
}

function addSelectedToQueue() {
  const feed = activeFeed();
  if (!feed) return toast('请先添加并选择一个播客');
  const chosen = feed.items.filter((it) => state.selected.has(`${feed.key}::${it.id}`));
  if (chosen.length === 0) return toast('请先勾选要下载的剧集');
  for (const item of chosen) addTask(feed, item);
  toast(`已加入队列：${chosen.length} 集`);
}

async function addTask(feed, item) {
  try {
    await window.api.addTask({ title: item.title, feed: feed.title, audioUrl: item.audioUrl });
  } catch (err) {
    toast('加入队列失败：' + err.message, true);
  }
}

/* ---------- 任务队列 ---------- */
function renderTasks() {
  const box = $('#tasks');
  box.innerHTML = '';
  renderTaskSummary();
  if (state.tasks.size === 0) {
    box.append(emptyHint('队列为空。\n在左侧勾选剧集，点「下载并转码」。'));
    return;
  }
  const tasks = [...state.tasks.values()].sort((a, b) => a.addedAt - b.addedAt);
  for (const t of tasks) {
    const stageCls = 'stage-' + t.stage;
    const pct = t.percent || 0;
    const badgeText = {
      queued: '排队', download: '下载', convert: '转码', ready: '完成',
      error: '失败', cancelled: '取消',
    }[t.stage] || t.stage;

    const running = t.status === 'running' || t.status === 'pending';
    const metaText = taskMetaLine(t);

    const head = el('div', { class: 'task-head' },
      el('div', { class: 'task-title', text: t.title }),
    );
    if (running) {
      head.append(el('button', { class: 'cancel-btn', text: '取消', onclick: () => cancelTask(t.id) }));
    } else if (t.status === 'error' || t.status === 'cancelled') {
      head.append(el('button', { class: 'retry-btn', text: '重试', onclick: () => retryTask(t) }));
    } else if (t.status === 'ready' && t.outputPath) {
      const tr = state.transcribes.get(t.outputPath);
      const trLabel = !tr ? '转写' : (tr.state === 'done' ? '查看' : '转写中…');
      const trCls = tr && tr.state === 'done' ? 'transcribe-btn done' : 'transcribe-btn';
      head.append(el('button', {
        class: trCls,
        text: trLabel,
        disabled: tr && (tr.state === 'running' || tr.state === 'loading') ? true : false,
        onclick: () => onTranscribeClick(t.outputPath),
      }));
    }

    const card = el('div', { class: 'task' },
      head,
      el('div', { class: 'task-feed', text: t.feed }),
      el('div', { class: 'task-stage' },
        el('span', { class: 'stage-badge ' + stageCls, text: badgeText }),
        el('span', { text: t.message }),
        el('span', { class: 'mono', style: 'margin-left:auto' }, pct > 0 && t.status !== 'ready' ? `${pct}%` : ''),
      ),
      metaText ? el('div', { class: 'task-meta', text: metaText }) : null,
      running ? el('div', { class: 'task-progress', innerHTML: wavebarHtml(pct) }) : null,
      t.error ? el('div', { class: 'task-err', text: t.error }) : null,
    );
    box.append(card);
  }
}

function taskMetaLine(t) {
  const m = t.meta;
  if (!m) return '';
  if (t.status === 'ready') return m.size ? `输出 ${fmtSize(m.size)}` : '';
  if (t.stage === 'download') {
    const parts = [];
    if (m.received && m.total) parts.push(`${fmtSize(m.received)} / ${fmtSize(m.total)}`);
    if (m.speed) parts.push(fmtSpeed(m.speed));
    if (m.eta != null) parts.push('剩 ' + fmtEta(m.eta));
    return parts.join(' · ');
  }
  if (t.stage === 'convert') {
    const parts = [];
    if (m.size) parts.push('源 ' + fmtSize(m.size));
    if (m.speed) parts.push(fmtSpeed(m.speed));
    if (m.eta != null) parts.push('剩 ' + fmtEta(m.eta));
    return parts.join(' · ');
  }
  return '';
}

function renderTaskSummary() {
  const tasks = [...state.tasks.values()];
  const box = $('#taskSummary');
  if (!tasks.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'pending').length;
  const done = tasks.filter((t) => t.status === 'ready').length;
  const failed = tasks.filter((t) => t.status === 'error').length;
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
  const dot = el('span', { class: 'ts-dot' + (failed ? ' has-fail' : '') });
  const parts = [`${tasks.length} 个任务`];
  if (running) parts.push(`进行中 ${running}`);
  if (done) parts.push(`完成 ${done}`);
  if (failed) parts.push(`失败 ${failed}`);
  if (cancelled) parts.push(`取消 ${cancelled}`);
  box.append(dot, el('span', { text: parts.join(' · ') }));
  if (failed) {
    box.append(el('button', { class: 'retry-all-btn', text: '重试失败', onclick: () => retryFailed() }));
  }
}

async function retryTask(t) {
  try {
    await window.api.addTask({ title: t.title, feed: t.feed, audioUrl: t.audioUrl });
    toast('已重新加入队列');
  } catch (err) {
    toast('重试失败：' + err.message, true);
  }
}

async function retryFailed() {
  const bad = [...state.tasks.values()].filter((t) => t.status === 'error' || t.status === 'cancelled');
  if (!bad.length) return;
  for (const t of bad) {
    try { await window.api.addTask({ title: t.title, feed: t.feed, audioUrl: t.audioUrl }); } catch (_) { /* ignore */ }
  }
  toast(`已重新加入队列：${bad.length} 个任务`);
}

async function cancelTask(id) {
  await window.api.cancelTask(id);
}

async function clearFinished() {
  await window.api.clearFinished();
  const tasks = await window.api.listTasks();
  state.tasks = new Map(tasks.map((t) => [t.id, t]));
  renderTasks();
}

/* ---------- 磁盘 ---------- */
async function refreshDrives() {
  try {
    state.drives = await window.api.listDrives();
  } catch (err) {
    state.drives = [];
    toast(err.message, true);
  }
  renderDrives();
}

function renderDrives() {
  const sel = $('#driveSelect');
  sel.innerHTML = '';
  const removable = state.drives.filter((d) => d.removable);
  const fixed = state.drives.filter((d) => !d.removable);

  const optGroup = (label, list) => {
    if (list.length === 0) return;
    const g = el('optgroup', { label });
    for (const d of list) {
      const labelText = `${d.device} ${d.label}（${fmtSize(d.size)}）`;
      g.append(el('option', { value: d.device, text: labelText }));
    }
    sel.append(g);
  };

  optGroup('可移动磁盘（U 盘 / MP3 播放器）', removable);
  optGroup('本地磁盘', fixed);

  const custom = el('option', { value: '__custom__', text: '自定义文件夹…' });
  sel.append(custom);

  // 默认选中第一个可移动磁盘
  const firstRemovable = removable[0];
  if (firstRemovable) sel.value = firstRemovable.device;
  else sel.value = '__custom__';

  if (state.targetDir) {
    const opt = el('option', { value: state.targetDir, text: state.targetDir, selected: '' });
    sel.append(opt);
    sel.value = state.targetDir;
  }

  updateDriveSpace();
}

function updateDriveSpace() {
  const box = $('#driveSpace');
  const v = $('#driveSelect').value;
  const d = v && v !== '__custom__' ? state.drives.find((x) => x.device === v) : null;
  if (!d || !d.size) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const used = Math.max(0, d.size - d.free);
  const pct = Math.round((used / d.size) * 100);
  $('#driveSpaceFill').style.width = Math.min(100, pct) + '%';
  $('#driveSpaceLabel').textContent =
    `已用 ${fmtSize(used)} / ${fmtSize(d.size)} · 剩余 ${d.free === 0 ? '0 B' : fmtSize(d.free)}`;
}

async function pickFolder() {
  const dir = await window.api.selectFolder();
  if (!dir) return;
  state.targetDir = dir;
  renderDrives();
  toast('导入目标：' + dir);
}

function currentTarget() {
  const sel = $('#driveSelect');
  const v = sel.value;
  if (v === '__custom__') return state.targetDir;
  return v;
}

/* ---------- 媒体库 ---------- */
async function refreshLibrary() {
  state.library = await window.api.listLibrary();
  renderLibrary();
  if (state.page === 'transcribe') renderTsLibrary();
}

function renderLibrary() {
  const box = $('#library');
  box.innerHTML = '';
  if (state.library.length === 0) {
    box.append(emptyHint('媒体库还没有 MP3。\n下载并转码完成后会自动出现在这里。'));
    return;
  }
  for (const f of state.library) {
    const checked = state.libSelected.has(f.path);
    const tr = state.transcribes.get(f.path);
    const trLabel = !tr ? '转写' : (tr.state === 'done' ? '查看' : '转写中…');
    const trCls = tr && tr.state === 'done' ? 'lib-transcribe done' : 'lib-transcribe';
    const row = el('div', { class: 'lib-item' + (checked ? ' checked' : ''), dataset: { path: f.path } },
      el('input', { type: 'checkbox', checked: checked ? '' : false }),
      el('div', { class: 'lib-name', text: f.name, title: f.rel }),
      el('span', { class: 'lib-size', text: fmtSize(f.size) }),
      el('button', {
        class: trCls,
        text: trLabel,
        disabled: tr && (tr.state === 'running' || tr.state === 'loading') ? true : false,
        onclick: (e) => { e.stopPropagation(); onTranscribeClick(f.path); },
      }),
    );
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      if (state.libSelected.has(f.path)) state.libSelected.delete(f.path);
      else state.libSelected.add(f.path);
      row.classList.toggle('checked', state.libSelected.has(f.path));
      row.querySelector('input').checked = state.libSelected.has(f.path);
    });
    row.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) state.libSelected.add(f.path);
      else state.libSelected.delete(f.path);
      row.classList.toggle('checked', e.target.checked);
    });
    box.append(row);
  }
}

/* ---------- 导入 ---------- */
async function autoImportIfEnabled(task) {
  if (!state.settings || !state.settings.autoImportAfterConvert) return;
  if (!task.outputPath || state.autoImported.has(task.id)) return;
  state.autoImported.add(task.id);

  const target = currentTarget();
  if (!target) {
    toast('自动导入已跳过：未选择目标设备', true);
    return;
  }
  const subfolder = $('#subfolderChk').checked ? state.settings.importSubfolder : '';
  $('#importProgress').classList.add('active');
  try {
    await window.api.importFiles({ files: [task.outputPath], targetDir: target, subfolder });
    toast(`已自动导入：${task.title}`);
  } catch (err) {
    toast('自动导入失败：' + err.message, true);
  } finally {
    $('#importStatus').textContent = '';
    setTimeout(() => $('#importProgress').classList.remove('active'), 800);
  }
}

async function doImport() {
  const target = currentTarget();
  if (!target) return toast('请选择目标设备或文件夹', true);

  let files = state.library.filter((f) => state.libSelected.has(f.path)).map((f) => f.path);
  if (files.length === 0) {
    files = state.library.map((f) => f.path);
  }
  if (files.length === 0) return toast('媒体库里没有可导入的 MP3', true);

  const subfolder = $('#subfolderChk').checked ? state.settings.importSubfolder : '';

  $('#importBtn').disabled = true;
  $('#importProgress').classList.add('active');
  $('#importWave').innerHTML = wavebarHtml(0, 'amber');
  $('#importStatus').textContent = '准备导入…';

  try {
    const res = await window.api.importFiles({ files, targetDir: target, subfolder });
    $('#importWave').innerHTML = wavebarHtml(100, 'amber');
    $('#importStatus').textContent = '';
    toast(`已导入 ${res.count} 个 MP3 到 ${res.dest}`);
  } catch (err) {
    $('#importStatus').textContent = '';
    toast('导入失败：' + err.message, true);
  } finally {
    $('#importBtn').disabled = false;
    setTimeout(() => $('#importProgress').classList.remove('active'), 1200);
  }
}

/* ---------- 转写（faster-whisper） ---------- */
const BLOCK_SEC = 15 * 60; // 15 分钟一段

// 转写产物命名净化：与 main.js 的 cleanTranscriptName 保持一致。
// 规则：保留中/日/韩文字、ASCII 字母数字、空格、点（.）、下划线、连字符，
// 其余符号与标点（全角 ，。？！｜：；等、半角非法字符）一律清理；半角非法字符替换为下划线，其余替换为空格。
function cleanTranscriptName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_') // 半角非法字符 -> 下划线
    .replace(/[^A-Za-z0-9._\-\s\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ') // 其余标点/符号 -> 空格
    .replace(/\s+/g, ' ') // 压缩连续空白（含全角空格）
    .trim()
    .slice(0, 120) || 'untitled';
}

// 转写产物按音频管理：每个音频一个同名子目录，产物（json + md）放进该目录。
// 注意：此推导规则必须与 main.js 的 transcriptOutputFor 保持一致。
function transcriptPathFor(mp3Path) {
  const p = String(mp3Path);
  const dir = p.replace(/[\\/][^\\/]*$/, '');
  const raw = p.split(/[\\/]/).pop().replace(/\.(mp3|wav|m4a|m4b|aac|ogg|flac|opus|mp4)$/i, '');
  const base = cleanTranscriptName(raw);
  return dir + '\\' + base + '\\' + base + '.json';
}

// 从任务 / 媒体库发起转写：切到转写页并开始
async function onTranscribeClick(input) {
  switchPage('transcribe');
  addTsSource(input);
  state.tsActive = input;
  renderTsSources();
  renderTsHistory();

  const existing = state.transcribes.get(input);
  if (existing && existing.state === 'done') {
    await showTranscript(input, existing.jsonPath);
    return;
  }
  if (existing && (existing.state === 'running' || existing.state === 'loading')) return;

  // 磁盘上可能已有逐字稿（比如之前转写过的任务）
  const jsonPath = transcriptPathFor(input);
  try {
    await window.api.readTranscript(jsonPath);
    const rec = { state: 'done', jsonPath, segments: null, message: '' };
    state.transcribes.set(input, rec);
    pushTsHistory(input, jsonPath);
    renderTsSources();
    renderTsHistory();
    await showTranscript(input, jsonPath);
    return;
  } catch (_) { /* 没有现成的，继续新转写 */ }

  await startTranscribe(input);
}

// 切换到指定页面（播客 / 转写）
function switchPage(page) {
  state.page = page;
  $('#pagePodcast').classList.toggle('hidden', page !== 'podcast');
  $('#pageTranscribe').classList.toggle('hidden', page !== 'transcribe');
  const feedAdd = $('#feedAdd');
  if (feedAdd) feedAdd.classList.toggle('hidden', page !== 'podcast');
  document.querySelectorAll('.page-nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === page);
  });
  if (page === 'transcribe') {
    renderTsSources();
    renderTsLibrary();
    renderTsHistory();
    runTranscribeDoctor(true);
  } else {
    closeSearchResults();
  }
}

function onTranscribeUpdate(data) {
  const { type } = data;
  if (type === 'progress') {
    const input = data.input;
    const rec = state.transcribes.get(input) || { segments: [], message: '' };
    rec.state = data.state || 'running';
    rec.message = statusText(data.state);
    if (data.percent != null) rec.percent = data.percent;
    if (data.lastSeg) rec.segments = (rec.segments || []).concat([data.lastSeg]);
    state.transcribes.set(input, rec);
    renderLibrary();
    renderTasks();
    renderTsSources();
    if (state.tsActive === input) updateTranscriptProgressUI(input);
  } else if (type === 'done') {
    const input = data.input;
    const rec = state.transcribes.get(input) || {};
    rec.state = 'done';
    rec.percent = 100;
    rec.jsonPath = data.jsonPath;
    rec.message = '';
    state.transcribes.set(input, rec);
    pushTsHistory(input, data.jsonPath);
    renderLibrary();
    renderTasks();
    renderTsSources();
    renderTsHistory();
    resolveTranscribeWait(input);
    if (state.tsActive === input) showTranscript(input, data.jsonPath);
  } else if (type === 'error') {
    const input = data.input;
    const rec = state.transcribes.get(input);
    if (rec) rec.message = data.message;
    if (rec) { rec.state = 'error'; }
    else state.transcribes.set(input, { state: 'error', message: data.message });
    renderLibrary();
    renderTasks();
    renderTsSources();
    resolveTranscribeWait(input);
    if (state.tsActive === input) showTranscriptError(data.message);
  } else if (type === 'cancel') {
    const input = data.input;
    const rec = state.transcribes.get(input) || {};
    rec.state = 'cancelled';
    rec.message = '已取消转写';
    rec.percent = 0;
    state.transcribes.set(input, rec);
    renderLibrary();
    renderTasks();
    renderTsSources();
    resolveTranscribeWait(input);
    if (state.tsActive === input) showTranscriptCancelled(input);
  } else if (type === 'setup') {
    updateSetupUI(data);
  }
}

function statusText(stage) {
  const map = {
    loading_model: '正在加载模型…',
    retry_mirror: '官方源下载失败，切换镜像重试…',
    decoding: '正在转写…',
    vad_fallback: '语音分段（VAD）不可用，已切换为直接转写…',
    cpu_fallback: 'GPU 运行库不可用，已降级为 CPU 转写…',
  };
  return map[stage] || (stage === 'decoding' ? '正在转写…' : '处理中…');
}

/* ---- 转写页：待转写音频 ---- */
function addTsSource(path) {
  if (!path) return;
  if (!state.tsSources.some((s) => s.path === path)) {
    state.tsSources.push({ path, name: String(path).split(/[\\/]/).pop() || path });
  }
}

function removeTsSource(path) {
  state.tsSources = state.tsSources.filter((s) => s.path !== path);
  if (state.tsActive === path) state.tsActive = null;
}

function renderTsSources() {
  const box = $('#tsSources');
  box.innerHTML = '';
  if (state.tsSources.length === 0) {
    box.append(emptyHint('还没有待转写的音频。\n点「选择音频…」挑文件，或从媒体库添加。'));
    return;
  }
  for (const s of state.tsSources) {
    const tr = state.transcribes.get(s.path);
    const st = tr ? tr.state : null;
    const label = st === 'done' ? '✓ 完成' : (st === 'error' ? '失败' : (st === 'running' || st === 'loading' ? '转写中' : '待转写'));
    const cls = st === 'done' ? 'done' : (st === 'error' ? 'error' : (st === 'running' || st === 'loading' ? 'running' : ''));
    const row = el('div', { class: 'ts-source-item' + (state.tsActive === s.path ? ' active' : ''), dataset: { path: s.path } },
      el('div', { class: 'ts-source-name', text: s.name, title: s.path }),
      el('span', { class: 'ts-source-state ' + cls, text: label }),
      el('button', { class: 'ts-source-x', text: '×', title: '移除',
        onclick: (e) => { e.stopPropagation(); removeTsSource(s.path); renderTsSources(); } }),
    );
    row.addEventListener('click', () => {
      state.tsActive = s.path;
      renderTsSources();
      const rec = state.transcribes.get(s.path);
      if (rec && rec.state === 'done' && rec.jsonPath) showTranscript(s.path, rec.jsonPath);
      else if (rec && rec.state === 'error') showTranscriptError(rec.message || '转写失败');
      else showTranscriptProgress(s.path);
    });
    box.append(row);
  }
}

function renderTsLibrary() {
  const box = $('#tsLibrary');
  box.innerHTML = '';
  if (state.library.length === 0) {
    box.append(emptyHint('媒体库还没有 MP3。'));
    return;
  }
  for (const f of state.library) {
    const already = state.tsSources.some((s) => s.path === f.path);
    const row = el('div', { class: 'lib-item', dataset: { path: f.path } },
      el('div', { class: 'lib-name', text: f.name, title: f.rel }),
      el('span', { class: 'lib-size', text: fmtSize(f.size) }),
      el('button', {
        class: 'ts-lib-add',
        text: already ? '已添加' : '添加',
        disabled: already ? true : false,
        onclick: (e) => { e.stopPropagation(); addTsSource(f.path); renderTsLibrary(); renderTsSources(); },
      }),
    );
    box.append(row);
  }
}

function pushTsHistory(input, jsonPath, doneAt) {
  if (!state.tsHistory.some((h) => h.path === input)) {
    state.tsHistory.push({ path: input, name: String(input).split(/[\\/]/).pop() || input, jsonPath, doneAt: doneAt || Date.now() });
  }
}

// 恢复已转译状态（「已转译/未转译」跨重启持久化）。
// 转写状态此前只在内存里（state.transcribes / tsHistory），重启即丢：
// 启动时按磁盘上的转写产物批量扫描媒体库与任务输出，JSON 存在即为已转译，
// 让媒体库/任务列表的按钮与转写历史在重启后保持正确。
async function restoreTranscribeStatuses() {
  const inputs = new Set();
  for (const f of state.library) inputs.add(f.path);
  for (const t of state.tasks.values()) {
    if (t.outputPath) inputs.add(t.outputPath);
  }
  if (inputs.size === 0) return;
  let map = {};
  try {
    map = await window.api.transcribeStatuses([...inputs]);
  } catch (_) {
    return; // 扫描失败不阻塞启动，按钮按未转译显示即可
  }
  const restored = [];
  for (const [input, info] of Object.entries(map)) {
    if (!info) continue;
    const rec = state.transcribes.get(input);
    if (rec && (rec.state === 'running' || rec.state === 'loading')) continue; // 不覆盖进行中
    state.transcribes.set(input, { state: 'done', jsonPath: info.jsonPath, percent: 100, segments: null, message: '' });
    restored.push({ input, jsonPath: info.jsonPath, doneAt: info.doneAt });
  }
  if (restored.length === 0) return;
  restored.sort((a, b) => a.doneAt - b.doneAt); // 历史按完成时间先后排列
  for (const r of restored) pushTsHistory(r.input, r.jsonPath, r.doneAt);
  renderLibrary();
  renderTasks();
  renderTsHistory();
}

function renderTsHistory() {
  const box = $('#tsHistory');
  box.innerHTML = '';
  if (state.tsHistory.length === 0) {
    box.append(emptyHint('还没有完成的转写。'));
    return;
  }
  for (const h of state.tsHistory) {
    const row = el('div', { class: 'ts-history-item' + (state.tsActive === h.path ? ' active' : ''), dataset: { path: h.path } },
      el('div', { class: 'ts-history-main' },
        el('div', { class: 'ts-history-name', text: h.name, title: h.path }),
        el('div', { class: 'ts-history-meta', text: new Date(h.doneAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
      ),
    );
    row.addEventListener('click', () => {
      state.tsActive = h.path;
      renderTsSources();
      renderTsHistory();
      showTranscript(h.path, h.jsonPath);
    });
    box.append(row);
  }
}

/* ---- 转写页：进度与逐字稿 ---- */
function showTranscriptProgress(input) {
  $('#tsProgressPanel').classList.remove('hidden');
  $('#tsCancelBtn').classList.remove('hidden');
  $('#tsStartBtn').disabled = true;
  $('#tsWorkTitle').textContent = String(input).split(/[\\/]/).pop() || '转写中…';
  $('#tsTranscript').innerHTML = '';
  const rec = state.transcribes.get(input);
  $('#tsWave').innerHTML = waveSpans(rec && rec.percent || 0);
  $('#tsStatus').textContent = (rec && rec.message || '准备中…') + (rec && rec.percent ? ` ${rec.percent}%` : '');
}

function updateTranscriptProgressUI(input) {
  const rec = state.transcribes.get(input);
  if (!rec) return;
  $('#tsWave').innerHTML = waveSpans(rec.percent || 0);
  $('#tsStatus').textContent = (rec.message || '') + (rec.percent ? ` ${rec.percent}%` : '');
}

function showTranscriptError(msg) {
  $('#tsProgressPanel').classList.add('hidden');
  $('#tsCancelBtn').classList.add('hidden');
  $('#tsStartBtn').disabled = false;
  $('#tsTranscript').innerHTML = '';
  $('#tsTranscript').append(el('div', { class: 'ts-error', text: msg || '转写失败' }));
}

function showTranscriptCancelled(input) {
  $('#tsProgressPanel').classList.add('hidden');
  $('#tsCancelBtn').classList.add('hidden');
  $('#tsStartBtn').disabled = false;
  $('#tsWorkTitle').textContent = String(input).split(/[\\/]/).pop() || '已取消';
  $('#tsTranscript').innerHTML = '';
  $('#tsTranscript').append(el('div', { class: 'ts-cancelled', text: '已取消转写' }));
}

async function showTranscript(input, jsonPath) {
  let data;
  try {
    data = await window.api.readTranscript(jsonPath);
  } catch (err) {
    toast('读取逐字稿失败：' + err.message, true);
    // 读取失败也要恢复界面，避免进度面板卡住、按钮禁用
    $('#tsProgressPanel').classList.add('hidden');
    $('#tsCancelBtn').classList.add('hidden');
    $('#tsStartBtn').disabled = false;
    return;
  }
  currentTranscriptJsonPath = jsonPath;
  const segments = (data && data.segments) || [];
  const name = String(input).split(/[\\/]/).pop() || input;
  $('#tsWorkTitle').textContent = name;
  $('#tsProgressPanel').classList.add('hidden');
  $('#tsCancelBtn').classList.add('hidden');
  $('#tsStartBtn').disabled = false;

  const box = $('#tsTranscript');
  box.innerHTML = '';
  const meta = el('div', { class: 'ts-view-head' },
    el('div', { class: 'ts-view-meta mono',
      text: `模型 ${data.model || '?'} · 设备 ${data.device_used || '?'} · 语言 ${data.language || '?'} · ${segments.length} 段` }),
    el('div', { class: 'ts-view-actions' },
      el('button', { class: 'btn btn-primary btn-sm', text: '打开 MD 文件',
        onclick: () => openMdFile(jsonPath) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '在文件夹显示',
        onclick: () => revealMdFile(jsonPath) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '复制全文',
        onclick: () => copyTranscriptText() }),
    ),
  );
  box.append(meta);

  if (!segments.length) {
    box.append(el('div', { class: 'ts-empty', text: '没有可用的逐字稿内容。' }));
    return;
  }

  // 按 15 分钟粗粒度分段（时间轴只用于分段定位，段内为连续正文，不带逐句时间戳）
  const blocks = [];
  for (const s of segments) {
    const bi = Math.floor(s.start / BLOCK_SEC);
    if (!blocks[bi]) blocks[bi] = { start: s.start, end: s.end, lines: [] };
    const b = blocks[bi];
    b.lines.push(s);
    b.end = s.end; // 块内按序追加，结束时间随最后一句更新
  }

  const scroll = el('div', { class: 'ts-scroll' });
  let blockNo = 1; // 连续编号，与 .md 文件一致
  blocks.forEach((b) => {
    if (!b) return;
    const chars = b.lines.reduce((n, s) => n + s.text.length, 0);
    const text = b.lines.map((s) => s.text).join(' ');
    const block = el('div', { class: 'ts-block' },
      el('div', { class: 'ts-block-head' },
        el('span', { class: 'ts-block-time', text: `第 ${blockNo} 段 · ${fmtClock(b.start)} – ${fmtClock(b.end)}` }),
        el('span', { class: 'ts-block-stats mono', text: `${b.lines.length} 句 · ${chars} 字` }),
        el('button', { class: 'ts-copy-block', text: '复制本段',
          onclick: () => copyBlock(b) }),
      ),
      el('div', { class: 'ts-lines' },
        el('div', { class: 'ts-block-text', text }),
      ),
    );
    blockNo += 1;
    scroll.append(block);
  });
  box.append(scroll);
}

function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function blockText(b) {
  // 段内连续正文（与 .md 文件一致，不带逐句时间戳）
  return b.lines.map((s) => s.text).join(' ');
}

function copyBlock(b) {
  const text = blockText(b);
  navigator.clipboard.writeText(text).then(
    () => toast('已复制本段逐字稿'),
    () => toast('复制失败', true),
  );
}

async function copyTranscriptText() {
  // 从当前打开的逐字稿里取全文（与 .md 一致的连续正文）
  const jsonPath = currentTranscriptJsonPath;
  if (!jsonPath) return;
  try {
    const data = await window.api.readTranscript(jsonPath);
    const text = (data.segments || []).map((s) => s.text).join(' ');
    navigator.clipboard.writeText(text).then(
      () => toast('已复制全文'),
      () => toast('复制失败', true),
    );
  } catch (_) { toast('读取失败', true); }
}

/* ---- 快速获取转写产物（Markdown 文件） ---- */
function mdPathFor(jsonPath) {
  return String(jsonPath).replace(/\.json$/, '.md');
}

async function openMdFile(jsonPath) {
  try {
    const p = await window.api.openTranscriptMd(jsonPath);
    toast('已打开：' + p);
  } catch (err) {
    toast('打开失败：' + err.message, true);
  }
}

async function revealMdFile(jsonPath) {
  try {
    await window.api.revealTranscriptMd(jsonPath);
  } catch (err) {
    toast('定位失败：' + err.message, true);
  }
}

/* ---- 转写任务控制 ---- */
// 等待某个输入的转写任务结束（done / error）
const tsWaiters = new Map(); // input -> resolve
function waitTranscribeResult(input) {
  return new Promise((resolve) => {
    const tr = state.transcribes.get(input);
    if (tr && (tr.state === 'done' || tr.state === 'error' || tr.state === 'cancelled')) return resolve(tr.state);
    tsWaiters.set(input, resolve);
  });
}
function resolveTranscribeWait(input) {
  const resolve = tsWaiters.get(input);
  if (resolve) { tsWaiters.delete(input); resolve(state.transcribes.get(input).state); }
}

async function startTranscribe(onlyInput) {
  const list = onlyInput
    ? [onlyInput].filter((p) => state.tsSources.some((s) => s.path === p))
    : state.tsSources.map((s) => s.path);

  const pending = list.filter((input) => {
    const tr = state.transcribes.get(input);
    return !tr || (tr.state !== 'done' && tr.state !== 'running' && tr.state !== 'loading');
  });
  if (pending.length === 0) return toast('没有待转写的文件', true);

  // 逐个转写（后端同时只支持一个任务）。
  // 每次都把 tsActive 指向当前项，否则批量转写第二项起进度 UI 不会跟随更新（冻结在上一项）。
  for (const input of pending) {
    state.tsActive = input;
    renderTsSources();
    renderTsHistory();
    const jsonPath = transcriptPathFor(input);
    state.transcribes.set(input, { state: 'loading', percent: 0, segments: [], message: '准备中…' });
    showTranscriptProgress(input);
    renderTsSources();
    try {
      await window.api.startTranscribe({
        input,
        output: jsonPath,
        model: state.settings.transcribeModel || 'small',
        device: state.settings.transcribeDevice || 'auto',
        language: state.settings.transcribeLanguage || 'auto',
      });
      const result = await waitTranscribeResult(input);
      if (result !== 'done') break; // 出错则停止后续
    } catch (err) {
      const msg = String(err && err.message || err);
      const rec = state.transcribes.get(input) || {};
      rec.state = 'error';
      rec.message = msg;
      state.transcribes.set(input, rec);
      renderTsSources();
      // 未安装引擎 -> 引导安装
      if (/引擎|faster_whisper|venv|转写引擎/.test(msg)) {
        toast('需要先安装转写引擎，点「安装转写引擎」', true);
        showTranscriptError('未安装转写引擎。请点击上方「安装转写引擎」完成安装后重试。');
      } else {
        showTranscriptError(msg);
      }
      break;
    }
  }
}


/* ---- 转写环境（转写页） ---- */
async function runTranscribeDoctor(silent) {
  const btn = $('#tsDoctorBtn');
  if (!btn) return;
  if (!silent) {
    btn.disabled = true;
    btn.textContent = '检测中…';
  }
  try {
    const d = await window.api.transcribeDoctor();
    const parts = [];
    if (d.venvExists) parts.push('✓ 已安装转写引擎');
    else if (d.whisperInstalled) parts.push('✓ faster-whisper 可用');
    else if (d.pythonFound) parts.push('✓ Python 可用（未装引擎）');
    else parts.push('✗ 未检测到 Python');
    if (d.cuda > 0) parts.push(`GPU ${d.cuda} 张`);
    else if (d.whisperInstalled) parts.push('CPU 模式');
    parts.push(d.vadAvailable ? '语音分段 VAD ✓' : (d.whisperInstalled ? '语音分段 VAD ✗（将跳过分段）' : ''));
    $('#tsEngineStatus').textContent = parts.filter(Boolean).join(' · ') || '未检测到可用环境';
  } catch (err) {
    $('#tsEngineStatus').textContent = '检测失败：' + err.message;
  } finally {
    if (!silent) {
      btn.disabled = false;
      btn.textContent = '检测环境';
    }
  }
}

async function runTranscribeSetup() {
  const btn = $('#tsSetupBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '安装中…';
  try {
    await window.api.transcribeSetup();
    $('#tsEngineStatus').textContent = '安装完成！现在可以点「开始转写」了。';
  } catch (err) {
    $('#tsEngineStatus').textContent = '安装失败：' + err.message + '（可在终端手动安装，见说明）';
  } finally {
    btn.disabled = false;
    btn.textContent = '安装转写引擎';
  }
}

function updateSetupUI(data) {
  const elp = $('#tsEngineStatus');
  if (elp) elp.textContent = data.message || '安装中…';
}

/* ---------- 设置 ---------- */
function applySettingsToUI() {
  const s = state.settings;
  $('#subfolderName').textContent = s.importSubfolder;
  const chk = $('#autoImportChk');
  if (chk) chk.checked = !!s.autoImportAfterConvert;
  // 转写页选项
  const m = $('#tsModel');
  if (m) m.value = s.transcribeModel || 'small';
  const d = $('#tsDevice');
  if (d) d.value = s.transcribeDevice || 'auto';
  const l = $('#tsLang');
  if (l) l.value = s.transcribeLanguage || 'auto';
}

function openSettings() {
  const s = state.settings;
  $('#setFfmpeg').value = s.ffmpegPath;
  $('#setBitrate').value = s.bitrate;
  $('#setLibrary').value = s.libraryDir;
  $('#setSubfolder').value = s.importSubfolder;
  $('#settingsModal').classList.remove('hidden');
}

function closeSettings() {
  $('#settingsModal').classList.add('hidden');
}

async function saveSettings() {
  const patch = {
    ffmpegPath: $('#setFfmpeg').value.trim() || 'ffmpeg',
    bitrate: Math.min(320, Math.max(64, Number($('#setBitrate').value) || 128)),
    libraryDir: $('#setLibrary').value.trim() || state.settings.libraryDir,
    importSubfolder: $('#setSubfolder').value.trim() || 'Podcasts',
  };
  state.settings = await window.api.setSettings(patch);
  applySettingsToUI();
  closeSettings();
  refreshLibrary();
  toast('设置已保存');
}

function emptyHint(text) {
  return el('div', { class: 'empty', text });
}

init();