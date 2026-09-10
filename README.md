# GIFP 6.0.1

作者：acekanon
版本：`6.0.1`
软件性质：免费软件（freeware）

**6.0.1 源码预览已更新。** 本次 GitHub 更新包含 6.0 剪辑工作台、压缩改进和
6.0.1 时段联动修复；当前未提供可公开分发的 6.x Windows 安装包。
查看 [更新记录](CHANGELOG.md) 和 [本次交付范围](docs/release/6.0.1.md)。

GIFP 是 Windows 动画编辑与格式交付工具。它可以导入视频、GIF、Animated
WebP、APNG 等素材，完成裁剪、时间编辑、删帧、调速、滤镜与文字处理，并按
聊天、网页、Live Photo 或视频场景生成成品。

## 功能

- 6.0 剪辑工作台：在同一工程中编排视频、GIF 和图片，支持主轨分割、拖边修剪、排序、
  复制、变速、倒放、往返、定格和裁剪；文字与贴纸拥有独立时间区间、图层顺序和基础关键帧。
- 单帧编辑：按输出时间轴逐帧定位，将当前帧独立后单独调整；可删除、复制、延长停留、
  添加仅此帧文字／贴纸，并在桌面版渲染当前帧的真实合成结果。
- 时段联动：新工程默认让未锁定字幕／贴纸跟随删帧、复制和定格；修剪与变速按片段末端
  的长度变化调整后续时段。动态贴纸保留源画面与动画状态，锁定层保持原位；可关闭联动。
- 工程保存：保存／打开 `.gifp` 工程、多级撤销重做、本机自动恢复、素材重连与旧版编辑记录迁移。
  原生预览／导出使用不可变工程快照，过期结果不会覆盖新的编辑。
- 智能无损优化：新的结构搜索已接入工作台与原有生成链，可选启用；验证画面、透明度、
  时序和循环一致后才采用更小文件，超预算或无收益时回退。新时域和 LZW 增强仍保持研究状态。
- 压缩开关：原快速工具提供合并重复帧、调色表整理、可选 Gifsicle 后处理，以及
  有损索引压缩和温和模式；各项明确区分用途与画质取舍，默认关闭。
- Animal-Island-UI：保留纸感、柔和配色和角色动效，格式直接以卡片展示，
  画面处理按用途选择；系统减少动态效果设置可限制装饰动画。
- 快速生成：锁定尺寸、帧率和格式后显示 QQ、微信、飞书及网页等交付提示；
  每条规则带版本、证据状态和回退格式，未实机验证的建议不会标成平台硬上限。
- 精细编辑：提供真实输出帧分页编辑、Shift 连选、逐帧删除、撤销恢复和“每 N 帧保留 1 帧”的手动抽帧；
  删帧可选择收紧时间线或保持总时长，并继续支持非破坏式裁剪、调速、滤镜、调色板、透明度和循环。
- GIF：提供 FFmpeg 快速编码、感知 GIF，以及用户直接指定最大 MB 的硬上限搜索；
  成品不得超过该体积，无法满足时明确报告不可达。
- ROI 诊断：依据 Alpha、时序差分、主体显著性和镜头变化选择无模型基线，并明确
  标注是否值得进行 SAM 增量 A/B；当前包不包含或执行 SAM 模型。
- 现代动图：输出 Animated WebP、Animated AVIF 或 APNG，并在应用内播放预览；
  WebP 的 0 档保证可见颜色与 Alpha 无损并提供四档编码优化，AVIF 当前仅接受
  不透明素材，并建议为未知环境同时提供 WebP 回退。
- 视频与实况：输出 MP4、WebM 与 Live Photo 组合文件。
- GIF 表情包：提供底部黑框、经典上下字、白边海报等常用模板，文字可直接拖拽定位。
- 多格式交付：对同一裁剪、尺寸、帧率和时长，实测比较 GIF、Animated WebP、APNG、
  Animated AVIF、MP4 与 WebM 的体积、质量、耗时和兼容性；Live Photo 保持独立配对交付。
- 结果检查：查看实际尺寸、帧率、颜色、编码器、体积和耗时，并进行前后对比；
  GIF 报告额外展示 255/256 色候选的质量、速度、体积和最终取舍。
- 输出信心：以真实体积、质量实测、目标命中、透明状态与编码警告给出交付结论；
  “更清晰 / 更小 / 更流畅”会保留当前编辑并直接进入同一编码链重新生成。
- 长素材控制：媒体探测不再扫描整片计数帧，时间线按负载自适应采样并限制并发；
  运行中可终止活动编码进程树并清理临时输出，已接受取消的任务不会发布最终文件，
  晚到结果也不会覆盖当前任务或触发后续质量评估。
- 精确交付验收：素材加载使用快速元数据探测；Animated WebP 以常量内存直接读取
  RIFF 帧数与毫秒时序，内部 NUT 和最终成品使用精确计帧，确保时间线与输出报告一致。
- 并行取消隔离：Fast、目标体积与质量检测使用独立任务；停止时并行通知全部活动任务，
  区分已终止、正在提交和停止请求失败，不同 FFmpeg 进程树不会互相误杀。
- 失败恢复中心：关键交付失败会解释原因、给出处理建议，并可按失败时参数重试；
  失败任务只重新派发失败项。可分享诊断仅输出白名单字段，不读取原始错误；
  路径、文件名等原始技术详情只能由用户明确展开并在本地查看。
- 素材恢复：恢复上一次任务时保留素材身份与编辑设置；文件移动或丢失后可原位重连，
  合并列表同步更新路径，媒体读取和时间线关键帧可分别重试且不会被旧路径的晚到结果覆盖。
- 平台交付证据：具体交付目标随任务保存；只有客户端版本、测试日期、成品哈希和完整
  发送链路证据均有效时才显示“实机验证”，规则推断与过期证据会明确降级。
- 发行可信度：正式 `public` 渠道必须通过 Authenticode 白名单签名；随包
  `VERIFY-GIFP.ps1` 可复核完整文件集合、程序哈希、签名状态和发行身份。
  严格证据 CLI 已纳入常规验证，发行可信摘要只复制白名单字段。

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

GIFP 由 acekanon 提供，是免费软件；具体权利与限制见 `LICENSE.txt`。

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
