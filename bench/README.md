# GIFP Quality Lab

这是一条独立于桌面 UI 的离线质量链路。它不实现第二套编码逻辑，而是直接调用 GIFP 产品中的真实 Fast GIF / Best GIF / Target Size 转换入口，用可复现证据约束后续感知内核迭代。

## 语料覆盖

`corpus-manifest.json` 当前固定 28 个确定性 FFV1 fixture，七类各四个：

- 人物与肤色代理
- UI、字幕与透明素材
- 平面动画与线稿
- 游戏画面
- 低照度与噪声
- 高运动素材
- 静态背景与小区域变化

清单还强制覆盖透明、渐变、像素画、无缝循环和硬切等风险标签。fixture 由固定 lavfi 参数生成，源素材、请求和输出均记录 SHA-256。

生成或刷新 fixture：

```powershell
npm run quality:fixtures
```

若安全软件拦截独立 Rust CLI，可使用同一库代码的 fixture 入口：

```powershell
npm run quality:fixtures:harness
```

执行 Fast / Best / 两组动态同体积 FFmpeg / 两档已知可行硬上限 / 实验 writer 共 224 次真实编码、客观测量和正确性门禁：

```powershell
npm run quality:lab
```

如果 Windows 安全软件只拦截刚生成的独立 Rust CLI，可使用同一库代码的测试执行入口；它运行相同的 224 次编码、指标和报告逻辑，不降低门禁：

```powershell
npm run quality:lab:harness
```

调试单类回归时，可让 harness 只编码指定 fixture，仍复用完整三路线与指标链：

```powershell
$env:GIFP_QUALITY_FIXTURES = "ui-scroll-ticker,lowlight-perlin-cloud"
$env:GIFP_QUALITY_OUTPUT = "tmp/quality-lab/focused.json"
npm run quality:lab:harness
```

## 输出

默认输出位于 `tmp/quality-lab/`：

- `latest.json`：schema v9 完整运行记录、主机/构建档位、请求、质量指标、正确性门禁、目标体积回投校准、已知可行 `hard_cap` 验收、Best 对同体积 FFmpeg 的第一梯队客观门、编码耗时、可归因的进程树内存基线、稳定路线性能预算结果，以及经过 SHA-256 清单验证的不可变 `artifact_bundle` 引用。
- `latest.csv`：每个 fixture/profile 一行，便于透视表、统计和回归比较。
- `latest-blind.html`：默认 Best 与同体积 FFmpeg 的 A/B 成对盲测页。
- `latest-blind-regional-experimental-vs-ffmpeg-regional-size-match.html`：实验区域/分段候选与其独立同体积 FFmpeg 参考的盲测页；只有清单声明了对应 `symmetric_match` 时才生成。
- `runs/<run-id>/`：真实 GIF、逐次分析文件与原始 VMAF JSON。
- `gifp-blind-assets-<run-id>/` 与带候选/参考后缀的目录：各盲测包相互隔离的候选副本。

`bench/generated/` 与 `tmp/quality-lab/` 都是可再生工件，不提交到 Git。

## 指标与判读

全参考指标先按时间戳重采样到 30 FPS，再以 bicubic 统一缩放到 320 px 展示画布。目标体积搜索产生的低分辨率输出会被放回同一展示尺寸评分，避免把参考素材一同缩小而隐藏清晰度损失，也满足 MS-SSIM/CAMBI 的多尺度计算下限。质量链使用 VMAF NEG，并同时提取 PSNR、SSIM、MS-SSIM、CIEDE2000 和 CAMBI；另在 96 px 统一采样上计算 GIFP 自有的 OKLab、静态闪烁、边缘、Alpha 和循环缝指标。

目标体积路线同时记录回投候选的模型预测字节、真实字节和 `actual / predicted` 比率。报告按总体和七类内容汇总初次回投命中率、超限后的单次括号修正成功率、平均/P95 预测比率，并给出仅供校准评审的空间安全系数建议；合成语料结果不会自动改写产品默认值。

schema v8 在每次 `convert_animation_inner` 编码期间以 50 ms 间隔递归采样 Quality Lab 根进程及其 FFmpeg/FFprobe 后代，记录基线、峰值、增量峰值 RSS、最大进程数，以及峰值时每个进程的 PID、父 PID、名称、启动时间与 RSS；再按总体、profile 和内容类别用 nearest-rank 聚合 P50/P95/最大耗时与内存。逐进程快照使异常峰值可区分根进程、FFmpeg 与 FFprobe，而不再只有不可归因的总数。报告的 `overall` 仍包含实验路线以便诊断，但正式 `performance_budget` 只评估清单中 `allow_experimental=false` 的稳定路线，并明确记录纳入/排除的 profile 与运行数。这里的“进程树 RSS”是各进程驻留集之和，可能重复计算共享页，因此是可复跑的保守预算指标，不冒充系统唯一物理占用。质量指标计算阶段不计入产品编码性能。提交点报告的 `artifact_bundle` 指向已经封存的 JSON、CSV、盲测页和资产；bundle 内部的 `report.json` 为避免自引用哈希环而省略该可选字段。

schema v9 新增 `best_quality_acceptance`。它只接受固定的 `quality-corpus-v1` 清单 SHA-256、干净提交上 28/28 个、七类完整、体积对称差不超过 5% 的 `best-current` / `ffmpeg-size-match` 配对；参考必须是经过验证的 CFR FFmpeg `symmetric_match` 路线。v1 的 5%/28 对/7 类/100% 覆盖/60% VMAF 胜率阈值同时固化在运行时、JSON Schema 与验证器中，不能由报告自行放宽。VMAF NEG mean 必须形成总体材料级领先；CAMBI、OKLab、边缘、静态时稳、透明和循环缝的总体普通退化不得超过 25%，平均改善不得为负，各类别普通退化也不得超过 25%，且任何一个总体护栏都必须有真实适用样本。任何严重回退或任一类别失败都会令门禁失败。报告保留每对结果、win/tie/loss、严重回退以及 min/P05/median/P95/max，不使用加权总分掩盖短板。该客观门仍不能替代授权真实素材与 protocol v2 多人盲测。

每次准备使用或分发报告前，先验证顶层 v9 契约、嵌套质量门、bundle 清单、规范路径、逐文件大小与 SHA-256：

```powershell
npm run quality:verify -- --report tmp/quality-lab/latest.json
```

上面的完整性模式允许封存“结构合法但尚未达标”的诊断报告。只有发布候选才使用强制门；它要求提交点与不可变 bundle 内的质量结论完全一致，并且 `applicable`、干净提交 provenance 与全部验收项均通过：

```powershell
npm run quality:verify:first-tier -- --report tmp/quality-lab/latest.json
```

正式性能基线必须来自干净提交的 release 构建；debug 报告只用于验证采样链：

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --bin gifp_quality_lab -- run --manifest bench/corpus-manifest.json --output tmp/quality-lab/release-performance.json
```

`target-hard-cap-known-feasible` 以同参数 `fast-baseline` 的真实字节为近上限见证；`target-hard-cap-compressed` 则以真实 `240px / 10 FPS / 64 色` Fast GIF 为压缩见证，同时允许目标优化器从 `320px / 12 FPS / 96 色` 质量上限开始搜索。两者都把目标设为见证字节的 102.5%，因此见证输出天然位于目标的 95%～100% 且不超限。schema v9 保留 v5 的产品目标统计：总体至少 90% 位于 95%～100%，且不得超限。该统计与盲测用的 ±5% `symmetric_match` 完全分离。

- 越高越好：VMAF NEG、SSIM、MS-SSIM、libvmaf `ciede` 的 CIEDE2000 派生质量分、边缘保真。这里的 `ciede2000_*` 字段不是原始 ΔE；轻微失真高于强失真。
- 越低越好：CAMBI、GIFP 自有 OKLab 误差、静态闪烁、Alpha 误差、循环缝增量。
- `psnr_y_mean_db` 允许为 `null`：完全一致的平坦帧会产生无限 PSNR，JSON 不应伪造有限值。
- libvmaf 对部分平坦帧或透明帧可能无法定义 MS-SSIM/CIEDE2000；此时对应值允许为 `null`，并由 `*_valid_ratio` 明示有效帧覆盖率。报告只聚合有限帧，不填充假分数。

正确性门禁目前要求：

- 输出时长误差不超过 20 ms。
- 30 FPS 时间轴比较帧数完整，且输出至少包含一帧。
- 标记为透明的 fixture 必须保留 Alpha，普通二值透明覆盖误差不超过 0.02；明确标记为 `semi-transparent` 的素材允许 0.04，以吸收缩放与 GIF 二值 Alpha 的边缘量化，但不会放过大面积透明丢失。
- 标记为无缝循环的 fixture，输出相对源素材的循环缝增量不超过 0.02 OKLab。

门禁失败会写成 `gate_failed`，不会被伪装成成功编码。

## 盲测规则

A/B 身份由 `run-id + fixture-id` 的 SHA-256 确定性打乱。默认盲测候选为 `best-current` 与逐素材追踪其真实输出体积的 `ffmpeg-size-match`；实验包则独立比较 `regional-experimental` 与 `ffmpeg-regional-size-match`。每个候选只使用清单中明确指向它的 `symmetric_match` 参考，不会把硬上限路线或另一个候选的输出混作对手。名义参数相同的 `fast-baseline` 保留作速度和退化诊断，但不冒充同体积对手。产品目标体积保持 `hard_cap`（不允许超限），而两条盲测参考按真实字节选择对称差最小的 FFmpeg CFR 基线，并允许在 ±5% 内略高或略低。只有两侧均通过正确性门禁、体积的对称差异不超过 5%，且报告来自可验证的干净 Git 提交时，配对才有资格成为“正式票”。投票前揭示身份，或揭示后修改选择，会自动把该票降为探索票。

页面不会在常规盲态顶部显示后端名称，且全部可比较配对投完前禁止导出，以免评审者从文件名或 JSON 提前获知身份。重置选择不会清除已经发生的身份揭示；同一电脑换人时必须显式开始新评审会话。正式分发不要直接发送 Quality Lab 原始 HTML，而应从干净 packager 提交生成匿名、候选隔离且可复验的 ZIP：

```powershell
npm run quality:blind:package -- --report tmp/quality-lab/latest.json --reviewers 3
```

输出目录包含两个匿名 `packet-XX` ZIP、逐文件 `SHA256SUMS.txt`、协调者专用候选映射、平衡评审顺序和 ZIP SHA-256。ZIP 使用项目内置的确定性 stored writer；同一报告与 packager 提交重复运行必须得到相同字节，并在生成后重新解析中央目录、CRC 和每个文件内容。评审 ZIP 内不含候选/参考映射，协调者文件不能发给评审者。

页面支持评审代号、类别筛选、仅看正式配对、仅看未投票、同步重播、透明底色切换、身份/指标揭示和投票导出。不同候选包使用独立资产目录和本地存储键；导出文件名只含 run 与匿名评审 ID，不会提前暴露候选关系，也不会串图、串票或互相覆盖。protocol v2 票据内部仍记录候选关系、匿名评审 ID、提交 SHA、manifest SHA、首次/末次投票时间、改票次数和盲态有效性；同一审计中的评审 ID 重复导入会被拒绝，避免重复计票。

收集多个导出 JSON 后执行离线审计（`--votes` 可重复）：

```powershell
npm run quality:blind:aggregate -- --report tmp/quality-lab/latest.json `
  --votes C:\votes\reviewer-01.json `
  --votes C:\votes\reviewer-02.json `
  --output tmp/quality-lab/blind-audit.json
```

默认汇总清单中第一组 `symmetric_match`。实验区域候选必须显式选择自己的参考和候选，单独输出审计文件：

```powershell
npm run quality:blind:aggregate -- --report tmp/quality-lab/latest.json `
  --reference-profile ffmpeg-regional-size-match `
  --candidate-profile regional-experimental `
  --votes C:\votes\regional-reviewer-01.json `
  --votes C:\votes\regional-reviewer-02.json `
  --output tmp/quality-lab/regional-blind-audit.json
```

汇总器会重新计算 A/B 分配、体积差、正确性和盲态资格，不信任票据里自报的身份；输出总体、类别、fixture 的候选胜/负/平、决胜票胜率、含平票偏好分和 95% Wilson 区间。最终 `quality_gate_passed` 还要求至少 3 位不同评审、100% 正式配对覆盖、60% 总体目标、45% 类别下限，且每类至少出现一张决胜票；稀疏票据不会被误报为已通过。

评审包、协调者分发、投票导出与审计结果的稳定字段契约分别见 `blind-review-packet.schema.json`、`blind-review-distribution.schema.json`、`blind-vote.schema.json` 和 `blind-audit.schema.json`。

## 协议与边界

清单由 `corpus-manifest.schema.json` 固定为 schema v1，报告由 `quality-report.schema.json` 固定为 schema v9。历史 v5/v6/v7/v8 报告继续按各自归档契约读取，不应直接用 v9 schema 重验或改写版本号。

这套 28 个合成 fixture 是第一阶段的可复现下限，不等于真实世界质量结论。进入感知编码参数冻结前，还需要补充授权真实素材、形成足量同体积正式配对，并收集多人盲测票。
