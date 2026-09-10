# GIFP 6.0.1

作者：acekanon
版本：`6.0.1`
软件性质：永久免费（freeware）

**6.0.1 源码预览** · [更新记录](CHANGELOG.md) · [发布状态](docs/release/6.0.1.md)

当前仅提供源码，Windows 下载包准备中。

GIFP 是永久免费的 Windows 动图编辑工具。

## 功能

- 多素材剪辑：裁剪、分割、调速、倒放与逐帧编辑。
- 字幕贴纸：排版、关键帧动画，随剪辑同步调整。
- GIF 压缩：画质优化、体积上限与可选压缩策略。
- 多格式导出：GIF、WebP、APNG、AVIF、MP4、WebM、Live Photo。
- 录屏与表情包：区域录制、成组制作、工程保存和自动恢复。

## 格式选择

| 使用场景 | 建议格式 |
| --- | --- |
| QQ、微信、飞书聊天与最大兼容 | GIF |
| 网页轻量动图、完整透明 | Animated WebP |
| 现代网页、体积优先、不透明短动画 | Animated AVIF |
| UI、文字、像素画、透明无损 | APNG |
| 长时长、高帧率、照片运动 | MP4 / WebM |
| 小红书、抖音实况内容 | Live Photo |

平台规则可能调整。快速生成中的平台参数是保守模板，导出前仍应按目标平台的
当前要求检查文件大小、时长和画幅。

## 从源码运行

6.0 当前交付为源码预览，桌面构建仍标注内部体验版。默认进入剪辑工作台，右上角「快速工具」保留原有录屏、
精细编辑、表情组和多格式输出。普通真实预览最多覆盖前 15 秒；「渲染当前帧」可检查
所选时间点的完整合成。工程支持 5 分钟内的时间轴，另受显式像素帧、倒放和叠加预算限制。

开发环境需要 Node.js（满足锁定依赖的 engines 要求）、npm、Rust stable MSVC、
Visual Studio C++ 构建工具、Windows SDK 和 WebView2 Runtime。桌面媒体功能另需
FFmpeg / FFprobe；当前完整媒体路径按 FFmpeg 9.0 验证，Animated WebP 等功能
依赖对应解复用器与编码器，不能保证旧版本支持。

Windows PowerShell：

```powershell
git clone https://github.com/acekanon/GIF_P.git
cd GIF_P
npm ci
# 按本机实际 FFmpeg 目录调整；同目录需要 ffprobe 和配套 DLL。
$env:PATH = 'C:\ffmpeg\bin;' + $env:PATH
npm run tauri:dev
```

`npm run dev` 仅运行浏览器交互演示；真实素材合成、录屏和本地文件操作需要桌面版。

完整开发回归：

```powershell
npm run verify
```

前端测试可用 `npm test -- --maxWorkers=2` 限制并发。部分原生集成用例需要
FFmpeg；标记 ignored 的离线基准还需要独立准备实验素材，不属于默认回归。

生成本地预览包：

```powershell
$env:GIFP_FFMPEG_DIR = 'F:\path\to\reviewed-ffmpeg-build'
$env:GIFP_DISTRIBUTION_CHANNEL = 'internal'
npm run package:exe
```

输出：

```text
release/GIFP-6.0.1/GIFP-6.0.1.exe
release/GIFP-6.0.1-portable.zip
release/GIFP-6.0.1-SHA256SUMS.txt
```

这些路径是本地构建输出，不是本次 GitHub Release 的下载附件。内部便携包需要
完整解压后运行，不能只复制 EXE；公开发行条件见下方说明。

## 许可与 FFmpeg

GIFP 由 acekanon 提供，永久免费；具体权利与限制见 `LICENSE.txt`。

本地内部预览包使用经锁定的 FFmpeg
`9.0-full_build-www.gyan.dev` Windows x64 GPL shared build，采用
`GPL-3.0-or-later`，不得作为公共版本发布。公共预览包必须显式选择
`public-lgpl` 配置；该配置采用独立的可复现 Windows x64 shared 构建链与
`LGPL-2.1-or-later`，并禁用 GPL、nonfree 与 version3 组件。当前 n9.0 公共
运行时尚未完成构建与能力复审，因此公共发布门禁保持关闭。软件包同时包含：

- `THIRD_PARTY_NOTICES.md`：第三方组件说明；
- `THIRD_PARTY_LICENSES/FFmpeg-LICENSE.txt` 或
  `THIRD_PARTY_LICENSES/FFmpeg-RUNTIME-LICENSES.txt`：所选运行时的完整许可文本；
- `FFmpeg-PROVENANCE.json`：二进制、版本、配置与 SHA-256；
- `FFmpeg-SOURCE-INFO.txt`：对应 FFmpeg 源码与构建配方地址；
- `FFmpeg-BUILDINFO.txt`：实际打包版本和构建参数；
- `THIRD_PARTY-MANIFEST.json` 与 `THIRD_PARTY_LICENSES/DEPENDENCIES`：其余依赖
  及许可证文本；
- `DISTRIBUTION.json`：当前包的分发状态和未满足条件。

`DISTRIBUTION.json` 未标记 `redistributable: true` 的预览包只能用于本地测试，
不得公开再分发。源码 URL 不等于完整 Corresponding Source 归档；公共发布还需
把精确对应源码与二进制放在同一下载位置，并通过构建输入、运行时审阅、质量证据、
项目许可及签名策略门禁。
