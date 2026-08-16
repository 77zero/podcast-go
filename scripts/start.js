'use strict';

// 启动器：清掉会干扰 Electron 的环境变量后拉起应用。
// 某些开发/CI/代理环境会设置 ELECTRON_RUN_AS_NODE 或 NODE_OPTIONS，
// 前者会让 electron.exe 退化成纯 Node（导致 require('electron') 返回字符串），
// 后者可能带 Electron 不允许的 flag（如 --use-system-ca）。普通机器上二者都不存在，无副作用。

// 注意：Electron 用「变量是否存在」判断是否进入 node 模式，置空无效，必须真正删除。
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.NODE_OPTIONS;

const path = require('path');
const { spawn } = require('child_process');
const electronPath = require('electron'); // npm 包在纯 node 下返回 electron 可执行文件路径

const child = spawn(electronPath, ['.', '--disable-gpu', '--in-process-gpu'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => {
  console.error('无法启动 Electron：', err.message);
  process.exit(1);
});
