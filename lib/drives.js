const { execFile } = require('child_process');

const DRIVE_TYPE = {
  0: '未知',
  1: '无根目录',
  2: '可移动磁盘',
  3: '本地磁盘',
  4: '网络驱动器',
  5: '光盘',
  6: 'RAM 磁盘',
};

/**
 * 枚举 Windows 逻辑磁盘，识别可移动磁盘（U 盘 / MP3 播放器）。
 * @returns {Promise<Array<{device:string,label:string,type:number,typeLabel:string,removable:boolean,size:number,free:number}>>}
 */
function listDrives() {
  return new Promise((resolve, reject) => {
    const script =
      'Get-CimInstance Win32_LogicalDisk | ' +
      'Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ' +
      'ConvertTo-Json -Compress';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error('无法枚举磁盘：' + err.message));
        let parsed;
        try {
          parsed = JSON.parse((stdout || '').trim());
        } catch (_) {
          return resolve([]);
        }
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const drives = arr
          .map((d) => ({
            device: d.DeviceID,
            label: d.VolumeName || '',
            type: d.DriveType,
            typeLabel: DRIVE_TYPE[d.DriveType] || '未知',
            removable: d.DriveType === 2,
            size: Number(d.Size) || 0,
            free: Number(d.FreeSpace) || 0,
          }))
          .filter((d) => d.device);
        drives.sort((a, b) => (a.removable === b.removable ? 0 : a.removable ? -1 : 1));
        resolve(drives);
      }
    );
  });
}

function formatSize(bytes) {
  if (!bytes) return '—';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return Math.round(bytes / 1024 / 1024) + ' MB';
}

module.exports = { listDrives, formatSize };
