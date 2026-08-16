'use strict';

const fs = require('fs');
const path = require('path');

function filePath(userData) {
  return path.join(userData, 'feeds.json');
}

// 从磁盘加载订阅列表
function load(userData) {
  try {
    const raw = fs.readFileSync(filePath(userData), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch (_) { /* 首次运行 / 文件损坏 -> 空 */ }
  return [];
}

// 保存订阅列表到磁盘（含剧集快照，离线也能看）
function save(userData, feeds) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(filePath(userData), JSON.stringify(feeds, null, 1), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { load, save };
