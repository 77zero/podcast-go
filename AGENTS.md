# PodcastGo（播客随身听）

所有回复、文档注释与提交信息使用中文。

## 项目定位

Windows 桌面工具：订阅播客 → 下载转码为 MP3 → 一键导入随身设备收听，内置 AI 逐字稿。
技术栈：Electron + Node.js；转码依赖系统 ffmpeg；转写依赖 Python faster-whisper。

## 事实来源

- 产品设计参考与界面规格：`docs/`（`docs/ui-reference/` 为界面唯一参考）。
- 领域与实现事实：源码、`package.json` 与实际命令输出为准，不在本文件复制。
- 任务与进度：见 ## Agent skills → Issue tracker。

## 变更门禁

1. 项目处于 INCUBATING 验证期；首个里程碑是 `git init` + 可复现基线。
2. 改动依赖外部能力（ffmpeg、faster-whisper、electron-builder 打包）前先确认本机可用。
3. 不引入数据库、账号、云端同步或远程依赖；保持本地单机工具边界。

## 证据与验收

- `automated`：`npm run dist` 打包通过（及既有测试）。
- `live-page`：用户本机运行主流程（搜索→下载→转码→导入）手动验收。
- 交付时报告各层级状态；缺失用户在场用 `partial`，不扩张完成结论。

## Gotchas

| 情况 | 规则 |
|---|---|
| （待补充——首个工作包验证后回填） | |

## Agent skills

### Issue tracker

本地 Markdown：`.scratch/<feature>/`。见 `docs/agents/issue-tracker.md`。

### Domain docs

single-context：根目录 `CONTEXT.md` 为唯一领域词汇，`docs/adr/` 记架构决策。见 `docs/agents/domain.md`。
