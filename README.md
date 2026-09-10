# GIFP 6.1.0

作者：acekanon · 永久免费 · Windows

GIFP 是永久免费的 Windows 动图编辑工具。

## 功能

- 多素材剪辑、逐帧编辑，字幕贴纸与关键帧联动。
- GIF 压缩与体积控制；新增跨帧稳定、LZW 成本搜索，均为可选的低误差有损策略。
- 区域录屏、成组表情包、工程保存与自动恢复。
- 导出 GIF、WebP、APNG、AVIF、MP4、WebM、Live Photo。

## 当前版本

[6.1.0 更新说明](release-6.1.0.md) · [GitHub Releases](https://github.com/acekanon/GIF_P/releases)

当前发布为源码预览，Windows 便携包暂未提供公开下载。

## 从源码运行

需要 Node.js 24、Rust MSVC、Windows C++ 构建工具、WebView2，以及包含 FFprobe 的 FFmpeg 9.0 运行时。

```powershell
npm ci
# 修改为本机 FFmpeg 目录。
$env:PATH = 'C:\ffmpeg\bin;' + $env:PATH
npm run tauri:dev
```

`npm run dev` 可运行浏览器交互演示；真实素材处理和录屏需要桌面版。

```powershell
npm run build
npm test -- --maxWorkers=1
```
