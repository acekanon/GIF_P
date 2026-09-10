from __future__ import annotations

from pathlib import Path

import nbformat as nbf
from nbclient import NotebookClient


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "strategy" / "2026-08-31-gifp-2m-product-study.ipynb"


def code(source: str):
    return nbf.v4.new_code_cell(source.strip())


def markdown(source: str):
    return nbf.v4.new_markdown_cell(source.strip())


notebook = nbf.v4.new_notebook()
notebook["metadata"] = {
    "kernelspec": {
        "display_name": "Python 3",
        "language": "python",
        "name": "python3",
    },
    "language_info": {"name": "python", "version": "3.13"},
}
notebook["cells"] = [
    markdown(
        """
# GIFP 2MB 画质前沿与产品机会研究

目标：在**十进制 2,000,000 字节硬上限**下，区分“最高客观画质”和“最高存储帧数”，审计当前目标体积偏好，并把本地实测与官方竞品/API 资料转成产品优先级。

数据边界：单份用户授权的 14.984 秒、1280×720、360 源帧混合运动素材；GIFP 5.7.27 dirty 工作树；FFmpeg 9.0。结果适合开发决策，不等同于公开排名。
"""
    ),
    code(
        r"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path.cwd().resolve()
FRONTIER_PATH = ROOT / "tmp" / "quality-lab" / "2m-frontier-objective.json"
PHASE1_PATH = ROOT / "tmp" / "quality-lab" / "runs" / "3c117b7630f9-1788149059892-13372-2" / "report-bundle" / "report.json"
PHASE5_PATH = ROOT / "tmp" / "quality-lab" / "2m-study-phase5.json"
ARENA_PATH = ROOT / "docs" / "benchmarks" / "2026-08-08-gifp-5.7.25-arena10.md"

frontier = json.loads(FRONTIER_PATH.read_text(encoding="utf-8"))
phase1 = json.loads(PHASE1_PATH.read_text(encoding="utf-8"))
phase5 = json.loads(PHASE5_PATH.read_text(encoding="utf-8"))

assert frontier["size_cap_bytes"] == 2_000_000
assert FRONTIER_PATH.exists() and PHASE1_PATH.exists() and PHASE5_PATH.exists() and ARENA_PATH.exists()
print("Loaded:", FRONTIER_PATH.relative_to(ROOT), PHASE1_PATH.relative_to(ROOT), PHASE5_PATH.relative_to(ROOT), sep="\n- ")
"""
    ),
    code(
        r"""
def print_table(rows, columns):
    formatted = []
    for row in rows:
        formatted.append({
            key: (f"{row[key]:.4f}" if isinstance(row.get(key), float) else str(row.get(key, "")))
            for key in columns
        })
    widths = {key: max(len(key), *(len(row[key]) for row in formatted)) for key in columns}
    print(" | ".join(key.ljust(widths[key]) for key in columns))
    print("-+-".join("-" * widths[key] for key in columns))
    for row in formatted:
        print(" | ".join(row[key].ljust(widths[key]) for key in columns))

profile_order = ["cap-5", "cap-8", "cap-10", "cap-12", "cap-15", "cap-20", "cap-24", "cap-30-fast", "fps60-118-fast"]
all_rows = {row["profile"]: row for row in frontier["rows"]}
main_rows = [dict(all_rows[profile]) for profile in profile_order]
for row in main_rows:
    row["cap_fill_pct"] = row["size_bytes"] / frontier["size_cap_bytes"] * 100
    row["vmaf"] = row["vmaf_neg_mean"]
    assert row["size_bytes"] <= frontier["size_cap_bytes"], row["profile"]
    assert row["colors"] == 256, row["profile"]

print_table(main_rows, ["profile", "width", "effective_fps", "stored_frames", "size_bytes", "cap_fill_pct", "vmaf", "vmaf_neg_p05"])
"""
    ),
    markdown(
        """
## 2MB 冠军不是一个答案，而是两个

“最高画质”应由统一参考帧率下的客观质量决定；“最高帧数”只描述 GIF 容器里存了多少帧。两者在源视频帧率较低时会分叉。
"""
    ),
    code(
        r"""
source_inspection = phase5["sources"][0]["inspection"]
source_frames = source_inspection["frame_count"]
source_duration = source_inspection["duration"]
source_information_fps = source_frames / source_duration

best_quality = max(main_rows, key=lambda row: row["vmaf_neg_mean"])
max_frames = max(main_rows, key=lambda row: row["stored_frames"])

comparison = {
    "best_quality_profile": best_quality["profile"],
    "best_quality_vmaf": best_quality["vmaf_neg_mean"],
    "best_quality_width": best_quality["width"],
    "best_quality_fps": best_quality["effective_fps"],
    "best_quality_frames": best_quality["stored_frames"],
    "max_frames_profile": max_frames["profile"],
    "max_frames_vmaf": max_frames["vmaf_neg_mean"],
    "max_frames_width": max_frames["width"],
    "max_frames_fps": max_frames["effective_fps"],
    "max_frames_frames": max_frames["stored_frames"],
    "extra_stored_frames": max_frames["stored_frames"] - best_quality["stored_frames"],
    "size_delta_bytes": max_frames["size_bytes"] - best_quality["size_bytes"],
    "vmaf_delta": max_frames["vmaf_neg_mean"] - best_quality["vmaf_neg_mean"],
    "p05_delta": max_frames["vmaf_neg_p05"] - best_quality["vmaf_neg_p05"],
    "ssim_delta": max_frames["ssim_mean"] - best_quality["ssim_mean"],
    "source_information_fps": source_information_fps,
    "max_frames_to_source_ratio": max_frames["stored_frames"] / source_frames,
}
print(json.dumps(comparison, ensure_ascii=False, indent=2))

assert best_quality["profile"] == "cap-30-fast"
assert max_frames["profile"] == "fps60-118-fast"
assert comparison["vmaf_delta"] < 0
assert max_frames["stored_frames"] > source_frames * 2
"""
    ),
    markdown(
        """
结论：本素材在 2MB 下，`120px / 30 FPS / 450 帧`是已测客观画质冠军；`118px / 60 FPS / 899 帧`是已测帧数冠军。后者多存 449 帧，却低约 1.06 VMAF；源文件只有 360 个源帧，因此 60 FPS 主要是在增加显示采样，不是在增加等量的新信息。
"""
    ),
    markdown(
        """
## 当前“清晰优先”偏好需要质量闸门

下面直接读取同一次目标体积实验的三个偏好结果。客观指标位于每个 run 的 `metrics.objective`，而不是顶层 metrics。
"""
    ),
    code(
        r"""
preference_rows = []
for run in phase1["runs"]:
    if not run["profile_id"].startswith("target-"):
        continue
    objective = run["metrics"]["objective"]
    result = run["result"]
    preference_rows.append({
        "preference": run["profile_id"].removeprefix("target-"),
        "size_bytes": run["metrics"]["size_bytes"],
        "cap_fill_pct": run["metrics"]["size_bytes"] / result["target_size_bytes"] * 100,
        "width": result["output_width"],
        "effective_fps": result["effective_output_fps"],
        "stored_frames": run["metrics"]["frame_count"],
        "vmaf": objective["vmaf_neg_mean"],
        "vmaf_p05": objective["vmaf_neg_p05"],
        "ssim": objective["ssim_mean"],
        "attempts": result["attempts"],
        "route": result["target_optimizer_report"]["selected_route_id"],
    })

print_table(preference_rows, ["preference", "size_bytes", "cap_fill_pct", "width", "effective_fps", "stored_frames", "vmaf", "vmaf_p05", "ssim", "attempts", "route"])

prefs = {row["preference"]: row for row in preference_rows}
clarity_delta = {
    "width_px": prefs["clarity"]["width"] - prefs["balanced"]["width"],
    "effective_fps": prefs["clarity"]["effective_fps"] - prefs["balanced"]["effective_fps"],
    "cap_fill_pp": prefs["clarity"]["cap_fill_pct"] - prefs["balanced"]["cap_fill_pct"],
    "vmaf": prefs["clarity"]["vmaf"] - prefs["balanced"]["vmaf"],
    "vmaf_p05": prefs["clarity"]["vmaf_p05"] - prefs["balanced"]["vmaf_p05"],
    "ssim": prefs["clarity"]["ssim"] - prefs["balanced"]["ssim"],
}
print("\nClarity minus balanced:")
print(json.dumps(clarity_delta, ensure_ascii=False, indent=2))
assert clarity_delta["width_px"] == 4
assert clarity_delta["vmaf"] < 0 and clarity_delta["vmaf_p05"] < 0
assert prefs["clarity"]["cap_fill_pct"] < 91
"""
    ),
    markdown(
        """
解释：清晰偏好只换来 4px 宽度和约 0.0065 SSIM，却少用近 6.6 个百分点容量、有效帧率降到 17.7，并损失约 0.86 平均 VMAF / 14.35 P05 VMAF。偏好选择不能只按路线标签，应在最终实编码候选之间做质量闸门。
"""
    ),
    code(
        r"""
def dominates(left, right):
    objectives = ("width", "effective_fps", "vmaf_neg_mean")
    at_least = all(left[key] >= right[key] for key in objectives)
    strictly = any(left[key] > right[key] for key in objectives)
    return at_least and strictly

for row in main_rows:
    row["pareto"] = not any(dominates(other, row) for other in main_rows if other is not row)

pareto_rows = [row for row in main_rows if row["pareto"]]
dominated_rows = [row for row in main_rows if not row["pareto"]]
print("Pareto candidates (maximize width, effective FPS, VMAF under the cap):")
print_table(pareto_rows, ["profile", "width", "effective_fps", "vmaf_neg_mean", "size_bytes"])
print("\nDominated candidates:")
print_table(dominated_rows, ["profile", "width", "effective_fps", "vmaf_neg_mean", "size_bytes"])
assert "cap-24" in {row["profile"] for row in dominated_rows}
"""
    ),
    markdown(
        """
## 竞品证据转成产品差距

官方资料显示：gifski 1.35.0 的强项是跨帧调色板、时域抖动、运动/有损质量和固定颜色；但它明确要求为目标体积反复试参数，体积估计并不精确。Ezgif 已有目标体积压缩、批量优化、丢帧/去重和透明区域优化。ScreenToGif 的护城河是录屏到时间线编辑的一体化。GIFP 仍有“本地、严格硬帽、编辑与多格式交付”的组合优势，但仅有硬帽已不足以差异化。
"""
    ),
    code(
        r"""
competitors = [
    {"product": "GIFP 5.7.27", "exact_target": "是", "quality_core": "FFmpeg 调色板 + 感知路线编排", "workflow": "桌面编辑、多格式、交付校验", "main_gap": "非完整 Pareto；速度与评分器可靠性"},
    {"product": "gifski 1.35.0", "exact_target": "否（需试参）", "quality_core": "跨帧调色板、时域抖动、固定颜色", "workflow": "CLI/C 库", "main_gap": "无严格目标体积编排与完整编辑器"},
    {"product": "Ezgif", "exact_target": "是", "quality_core": "gifsicle/LZW、减色、去重、透明优化", "workflow": "Web 工具、批量优化", "main_gap": "在线工作流；不是本地桌面质量实验台"},
    {"product": "ScreenToGif 2.43.2", "exact_target": "官方资料未确认", "quality_core": "多编码器导出", "workflow": "录屏、逐帧时间线、标注/转场", "main_gap": "目标体积与客观质量前沿不是核心卖点"},
    {"product": "FFmpeg 9", "exact_target": "无产品级编排", "quality_core": "palettegen/paletteuse 多种统计与抖动", "workflow": "底层 CLI/库", "main_gap": "需要上层搜索、预览、解释与硬帽校验"},
]
print_table(competitors, ["product", "exact_target", "quality_core", "workflow", "main_gap"])
"""
    ),
    markdown(
        """
## 推荐功能优先级

排序依据为产品影响 × 证据置信度 ÷ 实施成本；分数只用于相对排序，不是假装精确的商业收益估算。
"""
    ),
    code(
        r"""
features = [
    {"feature": "偏好质量闸门 + 容量再投资", "horizon": "P0", "impact": 5, "confidence": 0.95, "effort": 2, "evidence": "清晰偏好少用容量且 VMAF/P05 更差"},
    {"feature": "有效运动 FPS / 信息帧率", "horizon": "P0", "impact": 4, "confidence": 0.95, "effort": 2, "evidence": "60 FPS 存 899 帧，源仅 360 帧，画质反降"},
    {"feature": "时间戳容错的 Quality Lab", "horizon": "P0", "impact": 4, "confidence": 0.95, "effort": 2, "evidence": "15 秒尾帧 449/450 不一致会使内置评分失败"},
    {"feature": "实编码 2MB Pareto 导演", "horizon": "P0", "impact": 5, "confidence": 0.95, "effort": 3, "evidence": "30 FPS 画质冠军与 60 FPS 帧数冠军分离"},
    {"feature": "解码/调色板缓存 + 早停", "horizon": "P0", "impact": 5, "confidence": 0.80, "effort": 4, "evidence": "本地 Arena 同体积小胜但 gifski 中位约快 11.7×"},
    {"feature": "固定品牌色 + 循环接缝预算", "horizon": "P1", "impact": 4, "confidence": 0.80, "effort": 3, "evidence": "gifski 暴露固定色；GIF 场景对循环闪烁敏感"},
    {"feature": "批量硬帽与可分享配方", "horizon": "P1", "impact": 3, "confidence": 0.80, "effort": 3, "evidence": "Ezgif 已提供批量优化，GIFP 可用本地复现差异化"},
    {"feature": "可选 AI Director（DeepSeek 等）", "horizon": "P1", "impact": 3, "confidence": 0.75, "effort": 3, "evidence": "工具调用适合把自然语言意图映射为本地确定性函数"},
]
for row in features:
    row["priority_score"] = round(row["impact"] * row["confidence"] / row["effort"], 3)
features = sorted(features, key=lambda row: (-row["priority_score"], row["feature"]))
for rank, row in enumerate(features, start=1):
    row["rank"] = rank
print_table(features, ["rank", "horizon", "feature", "impact", "confidence", "effort", "priority_score", "evidence"])
"""
    ),
    markdown(
        """
## DeepSeek API：做导演层，不做编码器

推荐做成供应商可替换的 OpenAI-compatible `AI Director`：默认只把本地探测得到的结构化元数据交给模型；模型通过严格 JSON 工具调用选择意图并调用 `analyze_source`、`generate_pareto_candidates`、`preview_candidate`、`encode_verified_target`。所有参数、文件路径、2MB 硬帽和最终质量验证仍由本地策略层控制。

适合的 AI 功能：自然语言导出配方（例如“2MB 内保人物动作、循环别闪”）、候选解释、失败诊断、批量命名/文案；可选视觉模型只读取抽样联系表，用于主体/文字 ROI 与字幕避让。不要把 LLM 放进每次二分体积搜索，它不能代替字节校验、VMAF 或确定性编码，并会增加延迟和不可复现性。
"""
    ),
    markdown(
        """
## 限制与下一步验证

- 这是单份真实混合运动素材，不能推出所有内容都应选 30 FPS；应扩到低照度、动态海报、UI 录屏、像素画、渐变、人像和透明素材。
- VMAF/SSIM 是代理指标；产品应同时保留循环接缝、文字/边缘、颜色稳定性、时域抖动与人工盲测。
- 60 FPS 的“信息重复”按源帧数上限推断，并非逐帧哈希去重；正式 UI 应计算差分/运动加权的有效信息帧率。
- gifski 本地 Arena 使用 1.34.0，官方当前仓库为 1.35.0；下轮复赛必须更新对手并冻结干净提交。
"""
    ),
    code(
        r"""
summary = {
    "cap_bytes": frontier["size_cap_bytes"],
    "source": {"duration_seconds": source_duration, "frames": source_frames, "information_fps": source_information_fps},
    "best_quality": best_quality,
    "max_frames": max_frames,
    "comparison": comparison,
    "clarity_minus_balanced": clarity_delta,
    "pareto_profiles": [row["profile"] for row in pareto_rows],
    "dominated_profiles": [row["profile"] for row in dominated_rows],
    "feature_priorities": features,
}

assert all(row["size_bytes"] <= 2_000_000 for row in main_rows)
assert len({row["profile"] for row in main_rows}) == len(main_rows)
assert all(row["vmaf_neg_mean"] is not None for row in main_rows)
print("VALIDATION PASSED")
print(json.dumps({
    "best_quality": comparison["best_quality_profile"],
    "max_frames": comparison["max_frames_profile"],
    "quality_delta_vmaf_60_vs_30": round(comparison["vmaf_delta"], 4),
    "clarity_delta_vmaf": round(clarity_delta["vmaf"], 4),
    "p0_features": [row["feature"] for row in features if row["horizon"] == "P0"],
}, ensure_ascii=False, indent=2))
"""
    ),
]

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
client = NotebookClient(notebook, timeout=600, kernel_name="python3", resources={"metadata": {"path": str(ROOT)}})
client.execute()
nbf.write(notebook, OUTPUT)
print(f"Notebook: {OUTPUT}")

