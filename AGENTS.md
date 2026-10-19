# 开发说明（PodcastGo / 播客随身听）

写给参与开发的人（含 AI 编码助手）。用户使用说明见 `README.md`。

## 项目边界

- Windows 桌面工具：订阅播客 → 下载转码为 MP3 → 导入随身设备，内置 AI 逐字稿。
- 技术栈：Electron + Node.js；转码依赖系统 ffmpeg；转写依赖 Python faster-whisper。
- 保持本地单机工具：不引入数据库、账号、云端同步或远程服务依赖。

## 事实来源

- 实现细节以源码、`package.json` 和实际命令输出为准。
- 架构决策记在 `docs/adr/`。

## 开发与验证

- `npm install` 安装依赖，`npm start` 启动。
- `npm run pack` 生成免安装目录 `release/win-unpacked/`，用于本地验证。
- `npm run dist` 生成 NSIS 安装包和便携版。
- 改动依赖外部能力（ffmpeg、faster-whisper、electron-builder）前，先确认本机可用。
- 一次改动一个提交，提交信息用中文概述改动。

## 注意事项

| 情况 | 规则 |
|---|---|
| 转写产物存放 | 按音频管理：每个音频一个同名子目录，产物（json + md）放进该目录；目录名与文件名做净化（清全角标点和非法字符，不带 `.transcript` 前缀）。规则见 `renderer.transcriptPathFor` 与 `main.js transcriptOutputFor`，两处必须一致；旧命名迁移见 `scripts/migrate-transcript-naming.js`。 |
