const Parser = require('rss-parser');

// 很多播客 CDN 会拦截非浏览器 UA（返回 406/403）。
// 这里用浏览器级请求头 + 合理超时，避免被误判为机器人。
const parser = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  customFields: {
    feed: [
      ['itunes:image', 'itunesImage'],
      ['itunes:author', 'itunesAuthor'],
    ],
    item: [
      ['itunes:duration', 'itunesDuration'],
      ['itunes:image', 'itunesImage'],
      ['itunes:episode', 'itunesEpisode'],
      ['itunes:season', 'itunesSeason'],
    ],
  },
});

function toSeconds(duration) {
  if (duration == null) return null;
  if (typeof duration === 'number') return Math.round(duration);
  const s = String(duration).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = m[1] ? parseInt(m[1], 10) : 0;
    return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  }
  return null;
}

function fmtDuration(seconds) {
  if (seconds == null) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function pickImage(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value && value.$ && value.$.href) return value.$.href;
  return null;
}

async function fetchFeed(url) {
  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch (err) {
    let host = '';
    try { host = new URL(url).host; } catch (_) { /* ignore */ }
    const msg = err && err.message ? err.message : String(err);
    const hint = /^Status code \d+$/.test(msg)
      ? `（该订阅源返回 ${msg.replace('Status code ', '')}，可能拦截了请求；可换一个订阅源或稍后再试）`
      : '';
    throw new Error(`读取订阅失败${host ? `（${host}）` : ''}：${msg}${hint}`);
  }
  const items = (feed.items || [])
    .map((it, i) => {
      const duration = toSeconds(it.itunesDuration);
      return {
        id: it.guid || it.link || it.title || String(i),
        title: (it.title || '(无标题)').trim(),
        date: it.isoDate || it.pubDate || null,
        duration,
        durationLabel: fmtDuration(duration),
        audioUrl: it.enclosure && it.enclosure.url ? it.enclosure.url : null,
        length: it.enclosure && it.enclosure.length ? Number(it.enclosure.length) : null,
        image: pickImage(it.itunesImage),
        episode: it.itunesEpisode || null,
        season: it.itunesSeason || null,
      };
    })
    .filter((it) => it.audioUrl);

  return {
    title: feed.title || url,
    description: feed.description || '',
    link: feed.link || '',
    image: pickImage(feed.itunesImage) || (feed.image ? feed.image.url : null) || null,
    author: feed.itunesAuthor || '',
    items,
  };
}

module.exports = { fetchFeed, fmtDuration };
