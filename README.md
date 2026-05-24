# GIF_P

Author: acekanon

GIF_P is a Windows portable GIF compressor for 2026-era short video workflows. It turns MP4/MOV/MKV/WEBM clips and screen recordings into GIFs with playful UI, visual presets, frame trimming, crop tools, filters, and multiple palette pipelines.

## Features

- Batch drag-and-drop video import.
- Visual preset cards with static previews, click-to-play GIF samples, and compression-ratio estimates.
- Presets for tiny GIFs, perceptual quality, low-noise output, clean subtitles, memes, WeChat, QQ, Bilibili mobile, and vertical clips.
- Encoder options: FFmpeg fast, pngquant-style optimized, smart hybrid, and low-noise clean mode.
- Filters: original, vivid anti-gray, GB green, GBA LCD, CRT scanline, and pixel poster.
- Direct timeline trimming by dragging the start/end handles on the keyframe strip.
- Hover keyframe preview, selected-frame marker, and manual frame deletion.
- Spatial crop, output folder selection, queue progress, and recent exports.
- Screen recording with screenshot-sequence mode plus FFmpeg compatibility/GPU capture modes.
- Animal-island inspired skin with compact controls and portable EXE packaging.

## Encoder Notes

The `pngquant optimized` mode is a high-quality FFmpeg palette pipeline inspired by gifski-style output: full-frame palette analysis, sierra2_4a dithering, mild denoise, sharpening, and anti-gray color correction. GIF_P does not bundle gifski or pngquant binaries.

The `low-noise clean` mode favors smooth, low-grain output by using global palette analysis, no dithering, and light denoise before quantization.

## Requirements

- Windows.
- FFmpeg available on `PATH`.
- Node.js and Rust/Tauri toolchain for development.

## Development

```powershell
npm install
npm run tauri:dev
```

## Build

```powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run package:exe
```

The portable executable is copied to:

```text
release/GIF_P.exe
```
