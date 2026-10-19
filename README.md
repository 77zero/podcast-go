# 播客随身听（PodcastGo）

一个 Windows 桌面端小工具：**下载播客音频 → 转码为 MP3 → 一键导入设备随身收听**，内置 AI 逐字稿。

技术栈：Electron + Node.js，转码依赖系统 `ffmpeg`，转写依赖 Python `faster-whisper`（N 卡 GPU 加速）。

## 功能

- **搜索播客**：顶部输入关键词，实时搜索 Apple Podcasts 节目库，点「订阅」一键添加；也支持直接粘贴 RSS / iTunes 订阅地址。
- **热门榜单**：点顶部「🔥 热门」查看 Apple Podcasts 热门播客榜（可切换美区/中国区/日本区/英国区），点榜单条目即可订阅。
- **批量下载**：勾选剧集，一键「下载并转码」，后台自动下载原始音频。
- **转码为 MP3**：用 ffmpeg 统一转成 MP3（默认 128 kbps / 44.1 kHz / 立体声，可改码率），兼容绝大多数 MP3 耳机与播放器。
- **一键导入**：自动扫描 Windows 上的 U 盘 / 可移动磁盘（MP3 播放器），也支持手动选择文件夹；一键把媒体库里的 MP3 复制进设备（可放到子文件夹）。
- **自动导入**：右侧面板可开启「下载完成后自动导入」，每集转码完成即自动复制到所选设备，无需手动操作。
- **AI 逐字稿（独立「转写」页）**：顶部导航切换到「转写」页，可批量选择音频（媒体库 MP3 或任意音频文件），选择模型 / 设备 / 语言后一键转写；带实时进度与转写历史。转写完成自动生成 Markdown 逐字稿（`.md`）：按 15 分钟粗粒度分段、段内为连续正文、不带逐句时间戳——时间轴只用于把长文本分块喂给 AI 做分段总结再汇总，降低幻觉与焦点丢失；页面提供「打开 MD 文件」与「在文件夹显示」一键快速获取。首次使用需安装转写引擎（约 400MB，自动下载 faster-whisper + onnxruntime）。

> **产物目录管理**：每期音频的转写产物（`.json` + `.md`）按音频管理——**每个音频一个同名子目录**，产物放进该目录（如 `人民公园说AI\梁文锋 最顶级的精明 看起来往往像理想主义 DeepSeek梁文锋会议解读\梁文锋….json`）。**文件名与目录会做净化**：原标题里的全角标点（`，。？！｜：；` 等）与非法字符会被清理，不再带 `.transcript` 前缀。`.json` 为权威数据（含完整时间戳），`.md` 为 AI 分段总结稿；删除一期直接删对应目录即可。

## 目录结构

```
podcast-go/
├── main.js              # Electron 主进程（IPC、任务调度）
├── preload.js           # contextBridge 暴露的安全 API
├── lib/
│   ├── rss.js           # RSS 订阅解析
│   ├── feeds.js         # 订阅列表读写
│   ├── download.js      # 音频下载（流式，带进度）
│   ├── convert.js       # ffmpeg 转 MP3（带进度）
│   ├── drives.js        # 枚举 Windows 磁盘 / 可移动磁盘
│   ├── import.js        # 复制文件到设备
│   ├── library.js       # 媒体库 MP3 扫描
│   ├── settings.js      # 设置读写
│   ├── tasks.js         # 下载→转码 任务队列
│   ├── transcriber.js   # 调用 Python 转写引擎
│   ├── markdown.js      # 生成 Markdown 逐字稿
│   └── logger.js        # 运行日志
├── python/
│   └── transcribe.py    # faster-whisper 转写脚本
├── renderer/
│   ├── index.html       # 界面结构
│   ├── styles.css       # 界面样式
│   └── renderer.js      # 界面逻辑
├── scripts/
│   ├── start.js         # 启动器（清理干扰 Electron 的环境变量）
│   ├── make-icon.js     # 由 build/icon.svg 生成图标
│   └── migrate-transcript-naming.js  # 旧版转写产物命名一次性迁移
├── build/               # 应用图标
└── docs/adr/            # 架构决策记录
```

## 下载与使用

普通用户不需要装 Node.js，直接下载安装包即可：

1. 下载：见本仓库的 Releases 页面，选择 `播客随身听-Setup-<版本>-x64.exe`（安装版）或 `播客随身听-Portable-<版本>-x64.exe`（便携版，双击即用）。
2. 安装 [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) 并加入 `PATH`；不在 PATH 时，可在应用内「设置」里指定 ffmpeg 完整路径。
3. 启动应用，按下文「使用流程」操作。需要 AI 逐字稿时，在「转写」页点「安装转写引擎」。

仅支持 Windows x64。

## 从源码运行

前置条件：

- Node.js ≥ 18（已在 v24 验证）
- [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) 已安装并在 `PATH` 中（可用 `ffmpeg -version` 验证）；若不在 PATH，可在应用内「设置」里指定完整路径。

```bash
git clone https://github.com/77zero/podcast-go.git
cd podcast-go
npm install        # 首次安装依赖（会下载 Electron）
npm start          # 启动应用
```

## 打包成 exe

```bash
npm run dist       # 生成 NSIS 安装包 + 便携版 exe，输出到 release/
```

> 应用图标来自 `build/icon.svg`，已生成 `build/icon.ico` + `build/icon.png`。想换图标：改 `build/icon.svg` 后执行 `npm run make:icon` 重新生成，再 `npm run dist` 打包。

> 国内网络打包时，建议先设置镜像再打包（electron-builder 的构建依赖默认从 GitHub 下载）：
>
> ```powershell
> $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
> npm run dist
> ```

## 使用流程

1. 顶部输入关键词搜索播客 → 点「订阅」；或直接粘贴 RSS 地址回车添加。
2. 左侧勾选要下载的剧集 → 「下载并转码」。
3. 中间队列查看下载 / 转码进度，完成后 MP3 会进入媒体库。
4. 右侧选择目标设备（自动列出 U 盘 / 播放器，或手动选文件夹）→ 勾选媒体库中的 MP3 → 「一键导入到设备」。

## 设置项

- **ffmpeg 路径**：默认 `ffmpeg`（从 PATH 查找）。
- **MP3 码率**：默认 128 kbps（64–320）。
- **媒体库目录**：默认 `用户\Music\PodcastMP3`。
- **导入子文件夹名**：默认 `Podcasts`，导入时会在设备上创建该子文件夹；可留空直接放入根目录。
- **下载完成后自动导入**：右侧「一键导入」面板上的开关，开启后每集转码完成即自动复制到当前所选设备。
- **转写模型 / 设备 / 语言**：在「转写」页选择（同步保存到设置）。模型 tiny→large-v3，设备自动 / NVIDIA GPU / CPU，语言自动 / 中文 / 英文。
- **转写引擎安装**：在「转写」页点「安装转写引擎」自动创建 Python 环境（含 faster-whisper、onnxruntime、CUDA 库）；点「检测环境」查看状态。未安装 onnxruntime 时会自动降级为不带语音分段的直接转写；GPU 运行库（cublas/cudnn）缺失或损坏时会自动降级为 CPU 转写，功能始终可用。

## 说明

- 下载的原始音频先放在媒体库下的 `.downloads` 临时目录，转码完成后自动删除。
- 导入目标是可移动磁盘时，请确认设备有足够空间；工具会按文件名直接复制，同名文件会覆盖。