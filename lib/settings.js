const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function defaults() {
  return {
    libraryDir: path.join(app.getPath('music'), 'PodcastMP3'),
    ffmpegPath: 'ffmpeg',
    bitrate: 128,
    sampleRate: 44100,
    channels: 2,
    importSubfolder: 'Podcasts',
    autoImportAfterConvert: false,
    // 转写（faster-whisper）
    transcribeModel: 'small',
    transcribeDevice: 'auto',     // auto | cuda | cpu
    transcribeLanguage: 'auto',   // auto | zh | en | ...
  };
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function get() {
  let raw = defaults();
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    raw = { ...raw, ...parsed };
  } catch (_) {
    /* 使用默认值 */
  }
  if (!raw.libraryDir || !String(raw.libraryDir).trim()) raw.libraryDir = defaults().libraryDir;
  if (!raw.ffmpegPath || !String(raw.ffmpegPath).trim()) raw.ffmpegPath = 'ffmpeg';
  if (!raw.importSubfolder) raw.importSubfolder = 'Podcasts';
  return raw;
}

function set(patch) {
  const next = { ...get(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { get, set };
