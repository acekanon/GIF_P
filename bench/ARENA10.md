# GIFP Arena 10 v1

Arena 10 是开发期小擂台：用 10 份固定、无损、可重复生成的 FFV1 源素材快速发现编码退化，等正式版冻结后再接入竞品跑榜。它不替代现有 28 素材正式质量门，也不单独支撑“世界第一”宣称。

静态总览见 [`gifp-arena10-v1-contact-sheet.png`](../docs/benchmarks/gifp-arena10-v1-contact-sheet.png)；实际测试始终使用完整动画源，而不是这张预览图。

## 固定素材

| # | Fixture | 场景 | 规格 | 主要风险 |
|---:|---|---|---|---|
| 1 | `skin-gradient-portrait` | 人物肤色 | 480×270 · 15 FPS · 3 秒 | 肤色、平滑渐变、微运动 |
| 2 | `ui-pixel-grid` | UI 与像素锐边 | 480×270 · 15 FPS · 3 秒 | 小字代理、硬边、闪烁控件 |
| 3 | `ui-alpha-panel` | 透明 UI | 480×270 · 15 FPS · 3 秒 | Alpha、半透明、变化矩形 |
| 4 | `flat-seamless-wave` | 平面循环动画 | 480×270 · 15 FPS · 3 秒 | 渐变、抖动、首尾接缝 |
| 5 | `game-zoneplate-effects` | 游戏特效代理 | 480×270 · 15 FPS · 3 秒 | 高频纹理、色带、特效 |
| 6 | `lowlight-perlin-cloud` | 低照度素材 | 480×270 · 15 FPS · 3 秒 | 暗部噪声、纹理丢失 |
| 7 | `motion-rotate-zoneplate` | 高运动素材 | 480×270 · 15 FPS · 3 秒 | 旋转、高频、时域稳定性 |
| 8 | `static-small-change` | 静态背景局部变化 | 480×270 · 15 FPS · 3 秒 | 差分矩形、体积经济性 |
| 9 | `long-timeline-cuts` | 长时间轴 | 640×360 · 15 FPS · 12 秒 | 四段硬切、删段、时长关联 |
| 10 | `poster-local-motion` | 竖屏动态海报 | 540×960 · 12 FPS · 6 秒 | 大面积静态、小范围持续运动 |

## 生成与校验

```powershell
npm run arena:fixtures
```

命令会自动寻找与清单内 FFmpeg/FFprobe SHA-256 匹配的已封存运行时，生成到 `bench/generated/arena10/`，再逐个核对源文件哈希、时长和帧数。它还会确认动态海报相邻帧变化面积中位数保持在 1%～20%，并确认长时间轴恰有三次大范围硬切。生成目录是可再生工件，不提交 Git；真正冻结的是：

- [`arena10-manifest.json`](arena10-manifest.json)：素材生成式、标签、规格和输出哈希。
- [`arena10-toolchain.lock.json`](arena10-toolchain.lock.json)：生成器版本与二进制哈希。

## 开发期使用约束

- 当前迭代只把 Arena 10 当快速回归集，不因为临时输赢改素材或权重。
- 正式版冻结后才接入 gifski、FFmpeg 等对手生成本轮榜单。
- 所有参赛者使用同一批无损源和同一时间范围；不能用某个编码器的压缩结果作为另一个编码器的源。
- 10 份素材得出的结论写作“Arena 10 本轮结果”，不扩大成普遍质量结论。
