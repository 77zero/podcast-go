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
4. **改完即提交**：每个功能改动完成且通过本轮的打包/测试验证后，必须立即 `git commit`（
   一次改动一个提交，提交信息用中文、概述改动）；**禁止把未提交改动跨会话/跨多轮累积**。
   交付报告须注明本次涉及的新提交哈希；工作区残留未提交改动视为未完成。提交前先
   `git status` 核对清单，确认无遗漏（新增文件也要 `git add`，勿留未跟踪垃圾文件）。

## 证据与验收

- `automated`：`npm run dist` 打包通过（及既有测试）。
- `live-page`：用户本机运行主流程（搜索→下载→转码→导入）手动验收。
- 交付时报告各层级状态；缺失用户在场用 `partial`，不扩张完成结论。
- **打包约定**：每次修改后直接打包 `win-unpacked`（`npm run pack`，即 electron-builder --dir，
  产物在 `release/win-unpacked/`），用户直接运行其中的 exe 验证；仅在用户要求分发安装包时才跑 `npm run dist`。

## Gotchas

| 情况 | 规则 |
|---|---|
| 转写产物存放 | 按音频管理：每个音频一个同名子目录，产物（json + md）放进该目录；**目录名与文件名做净化**（清全角标点/非法字符，不再带 `.transcript` 前缀）；规则见 `renderer.transcriptPathFor` / `main.js transcriptOutputFor`（两处必须一致，另见 `scripts/migrate-transcript-naming.js`） |

## Agent skills

### Issue tracker

本地 Markdown：`.scratch/<feature>/`。见 `docs/agents/issue-tracker.md`。

### Domain docs

single-context：根目录 `CONTEXT.md` 为唯一领域词汇，`docs/adr/` 记架构决策。见 `docs/agents/domain.md`。