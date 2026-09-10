#!/usr/bin/env python3
"""Build and execute the durable GIFP vs gifski analysis notebook."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "tmp" / "gifski-pk"
PYDEPS = WORK / "pydeps"
sys.path.insert(0, os.fspath(PYDEPS))

import nbformat
from nbclient import NotebookClient


RAW_RESULTS = WORK / "results.json"
QUALITY_REPORT = WORK / "quality-lab.json"
DOCS = ROOT / "docs" / "benchmarks"
COMPACT_RESULTS = DOCS / "2026-08-07-gifp-vs-gifski-pk-results.json"
NOTEBOOK = DOCS / "2026-08-07-gifp-vs-gifski-pk.ipynb"
REPORT = DOCS / "2026-08-07-gifp-vs-gifski-pk.md"

BEFORE_OPTIMIZATION = {
    "aggregate": {
        "reliable_vmaf_wins": {"GIFP": 2, "tie": 3, "gifski": 1},
        "guard_fallback_count": 6,
        "advanced_rust_final_count": 1,
        "near_size_comparison_count": 4,
        "gifp_total_encode_ms": 30_549,
        "fast_total_encode_ms": 10_390,
    },
    "fixtures": {
        "skin-gradient-portrait": {"bytes": 491_347, "frames": 36, "vmaf_delta": -0.123738},
        "ui-pixel-grid": {"bytes": 23_099, "frames": 36, "vmaf_delta": 0.379214},
        "ui-alpha-panel": {"bytes": 65_763, "frames": 36, "vmaf_delta": 0.002987},
        "flat-seamless-wave": {"bytes": 515_871, "frames": 36, "vmaf_delta": 5.086262},
    },
}

ROUND_ONE = {
    "aggregate": {
        "reliable_vmaf_wins": {"GIFP": 4, "tie": 1, "gifski": 1},
        "guard_fallback_count": 3,
        "optimized_final_count": 5,
        "near_size_comparison_count": 5,
        "gifp_total_encode_ms": 28_726,
        "fast_total_encode_ms": 11_867,
        "best_vs_fast_total_time_ratio": 2.420662340945479,
    },
    "fixtures": {
        "flat-seamless-wave": {
            "bytes": 901_553,
            "frames": 36,
            "vmaf": 62.152276,
            "vmaf_delta": 1.675702,
        },
    },
}


def compact_results() -> dict:
    raw = json.loads(RAW_RESULTS.read_text(encoding="utf-8"))
    quality = json.loads(QUALITY_REPORT.read_text(encoding="utf-8"))
    best = {
        item["fixture_id"]: item
        for item in quality["runs"]
        if item["profile_id"] == "best-current"
    }
    fast = {
        item["fixture_id"]: item
        for item in quality["runs"]
        if item["profile_id"] == "fast-baseline"
    }
    rows = []
    for source in raw["rows"]:
        item = dict(source)
        item.pop("gifski_attempts", None)
        item.pop("source_path", None)
        item.pop("gifp_path", None)
        item.pop("gifski_path", None)
        run = best[item["fixture_id"]]
        encoder = run["result"]["encoder_used"]
        backend_id = run["result"]["backend_id"]
        if encoder == "ffmpeg_best_guard_baseline":
            route = "guard_fallback_to_fast"
        elif encoder == "rust_transparent_disposal_postprocess":
            route = "rust_transparent_coalesced"
        elif encoder == "ffmpeg_best_smooth_gradient_frame_palette":
            route = "ffmpeg_best_smooth_gradient_frame_palette"
        elif encoder == "ffmpeg_best_smooth_gradient_opaque":
            route = "ffmpeg_best_smooth_gradient_opaque"
        elif encoder == "ffmpeg_best_smooth_gradient":
            route = "ffmpeg_best_smooth_gradient"
        elif backend_id.startswith("rust."):
            route = "rust_perceptual"
        elif run["source_sha256"] and encoder == "ffmpeg_fast":
            route = "alpha_safe_ffmpeg"
        else:
            route = "ffmpeg"
        item["gifp_final_route"] = route
        item["gifp_encoder_used"] = encoder
        item["gifp_fallback_reason"] = run["result"].get("fallback_reason")
        item["gifp_fast_encode_ms"] = fast[item["fixture_id"]]["metrics"][
            "encode_wall_elapsed_ms"
        ]
        item["gifski_size_change_vs_gifp_pct"] = (
            item["gifski_size_bytes"] / item["gifp_size_bytes"] - 1.0
        ) * 100.0
        item["speedup_gifp_over_gifski_e2e"] = item["gifp_encode_ms"] / max(
            1, item["gifski_end_to_end_ms"]
        )
        item["near_size"] = item["gifski_size_delta_percent"] <= 5.0
        item["vmaf_reliable"] = min(
            item["gifp_metrics"]["vmaf_neg_mean"],
            item["gifski_metrics"]["vmaf_neg_mean"],
        ) >= 20.0
        if item["near_size"]:
            item["comparison_class"] = (
                "near_size_" + item["quality_winner"].lower()
                if item["vmaf_reliable"]
                else "near_size_metric_floor"
            )
        elif item["gifski_size_bytes"] < item["gifp_size_bytes"]:
            item["comparison_class"] = (
                "gifski_smaller_quality_tie"
                if item["vmaf_delta_gifski_minus_gifp"] >= -0.5
                else "gifski_smaller_quality_tradeoff"
            )
        else:
            item["comparison_class"] = "unmatched_other"
        rows.append(item)

    aggregate = dict(raw["aggregate"])
    aggregate["guard_fallback_count"] = sum(
        row["gifp_final_route"] == "guard_fallback_to_fast" for row in rows
    )
    aggregate["advanced_rust_final_count"] = sum(
        row["gifp_final_route"] in {"rust_perceptual", "rust_transparent_coalesced"}
        for row in rows
    )
    aggregate["smooth_gradient_quality_floor_count"] = sum(
        row["gifp_final_route"].startswith("ffmpeg_best_smooth_gradient") for row in rows
    )
    aggregate["optimized_final_count"] = (
        aggregate["advanced_rust_final_count"]
        + aggregate["smooth_gradient_quality_floor_count"]
    )
    aggregate["alpha_safe_ffmpeg_count"] = sum(
        row["gifp_final_route"] == "alpha_safe_ffmpeg" for row in rows
    )
    aggregate["fast_total_encode_ms"] = sum(row["gifp_fast_encode_ms"] for row in rows)
    aggregate["best_vs_fast_total_time_ratio"] = (
        aggregate["gifp_total_encode_ms"] / aggregate["fast_total_encode_ms"]
    )
    aggregate["best_vs_gifski_e2e_total_time_ratio"] = (
        aggregate["gifp_total_encode_ms"] / aggregate["gifski_total_end_to_end_ms"]
    )
    aggregate["fast_vs_gifski_e2e_total_time_ratio"] = (
        aggregate["fast_total_encode_ms"] / aggregate["gifski_total_end_to_end_ms"]
    )
    aggregate["best_fast_ratio_reduction_vs_round_one_pct"] = (
        1.0
        - aggregate["best_vs_fast_total_time_ratio"]
        / ROUND_ONE["aggregate"]["best_vs_fast_total_time_ratio"]
    ) * 100.0
    aggregate["raw_fast_slowdown_vs_round_one"] = (
        aggregate["fast_total_encode_ms"] / ROUND_ONE["aggregate"]["fast_total_encode_ms"]
    )
    return {
        "schema_version": 3,
        "scope": raw["scope"],
        "before_optimization": BEFORE_OPTIMIZATION,
        "round_one": ROUND_ONE,
        "aggregate": aggregate,
        "rows": rows,
    }


def build_markdown(compact: dict) -> None:
    aggregate = compact["aggregate"]
    before = compact["before_optimization"]["aggregate"]
    round_one = compact["round_one"]["aggregate"]
    round_one_flat = compact["round_one"]["fixtures"]["flat-seamless-wave"]
    rows = {row["fixture_id"]: row for row in compact["rows"]}
    route_names = {
        "rust_perceptual": "Rust perceptual",
        "rust_transparent_coalesced": "透明帧合并",
        "ffmpeg_best_smooth_gradient": "平滑渐变 Best",
        "ffmpeg_best_smooth_gradient_opaque": "平滑渐变 opaque",
        "ffmpeg_best_smooth_gradient_frame_palette": "平滑渐变逐帧色表",
        "guard_fallback_to_fast": "护栏回退",
        "alpha_safe_ffmpeg": "Alpha-safe FFmpeg",
        "ffmpeg": "FFmpeg",
    }
    table_rows = []
    for row in compact["rows"]:
        table_rows.append(
            "| {fixture} | {route} | {gifp_bytes:,} | {frames} | {size:+.1f}% | {vmaf:+.3f} | {winner} |".format(
                fixture=row["fixture_id"],
                route=route_names.get(row["gifp_final_route"], row["gifp_final_route"]),
                gifp_bytes=row["gifp_size_bytes"],
                frames=row["gifp_frame_count"],
                size=row["gifski_size_change_vs_gifp_pct"],
                vmaf=row["vmaf_delta_gifski_minus_gifp"],
                winner=row["quality_winner"],
            )
        )
    portrait = rows["skin-gradient-portrait"]
    alpha = rows["ui-alpha-panel"]
    flat = rows["flat-seamless-wave"]
    report = f"""# GIFP 5.7.24 vs gifski 1.34.0：第二轮优化复测

## 结论

第二轮把上一轮唯一明确负项——平滑渐变——收敛为同体积平局。可靠 VMAF 从初始 **2 胜 / 3 平 / 1 负**，经第一轮 **4 胜 / 1 平 / 1 负**，提升到本轮 **{aggregate['reliable_vmaf_wins']['GIFP']} 胜 / {aggregate['reliable_vmaf_wins']['tie']} 平 / {aggregate['reliable_vmaf_wins']['gifski']} 负**；全部 8 个素材为 {aggregate['vmaf_wins']['GIFP']} 胜 / {aggregate['vmaf_wins']['tie']} 平 / {aggregate['vmaf_wins']['gifski']} 负。

| 指标 | 初始 | 第一轮 | 第二轮 |
|---|---:|---:|---:|
| 可靠 VMAF 胜/平/负 | 2 / 3 / 1 | 4 / 1 / 1 | {aggregate['reliable_vmaf_wins']['GIFP']} / {aggregate['reliable_vmaf_wins']['tie']} / {aggregate['reliable_vmaf_wins']['gifski']} |
| Best 护栏回退 | {before['guard_fallback_count']}/8 | {round_one['guard_fallback_count']}/8 | {aggregate['guard_fallback_count']}/8 |
| 最终优化路线 | 1/8 | {round_one['optimized_final_count']}/8 | {aggregate['optimized_final_count']}/8 |
| ±5% 近体积样本 | {before['near_size_comparison_count']}/8 | {round_one['near_size_comparison_count']}/8 | {aggregate['near_size_comparison_count']}/8 |
| 平滑渐变 GIF 字节 | 515,871 | {round_one_flat['bytes']:,} | {flat['gifp_size_bytes']:,} |
| 平滑渐变 VMAF Δ（gifski−GIFP） | +5.086 | +{round_one_flat['vmaf_delta']:.3f} | +{flat['vmaf_delta_gifski_minus_gifp']:.3f} |
| Best / Fast 同轮耗时比 | {before['gifp_total_encode_ms'] / before['fast_total_encode_ms']:.2f}× | {round_one['best_vs_fast_total_time_ratio']:.2f}× | {aggregate['best_vs_fast_total_time_ratio']:.2f}× |

## 关键改善

- **透明 UI**：65,763 B / 36 帧 → {alpha['gifp_size_bytes']:,} B / {alpha['gifp_frame_count']} 帧，逐时长 RGBA 与 Alpha 合同验证通过；同体积 VMAF 领先 gifski {-alpha['vmaf_delta_gifski_minus_gifp']:.2f}。
- **人物渐变**：491,347 B / 36 帧 → {portrait['gifp_size_bytes']:,} B / {portrait['gifp_frame_count']} 帧；同体积 VMAF 领先 gifski {-portrait['vmaf_delta_gifski_minus_gifp']:.2f}。代价是 CAMBI 从极低基线升高，后续仍应继续优化跨帧调色板稳定性。
- **UI 网格**：23,099 B / 36 帧 → {rows['ui-pixel-grid']['gifp_size_bytes']:,} B / {rows['ui-pixel-grid']['gifp_frame_count']} 帧，质量判为近体积平局。
- **平滑渐变**：小型动画使用 96 色 opaque 逐帧局部色表和 Floyd–Steinberg，大图/长图保留 opaque diff 全局色表。相对第一轮体积下降 {(1.0 - flat['gifp_size_bytes'] / round_one_flat['bytes']) * 100.0:.1f}%，GIFP VMAF {round_one_flat['vmaf']:.2f} → {flat['gifp_metrics']['vmaf_neg_mean']:.2f}，同体积差距 {round_one_flat['vmaf_delta']:.2f} → {flat['vmaf_delta_gifski_minus_gifp']:.2f}，进入平局。
- **渐变质量取舍**：GIFP CAMBI {flat['gifp_metrics']['cambi_mean']:.3f} 优于 gifski {flat['gifski_metrics']['cambi_mean']:.3f}，但 SSIM {flat['gifp_metrics']['ssim_mean']:.3f} 仍低于 gifski {flat['gifski_metrics']['ssim_mean']:.3f}；不是单指标全面领先。
- **低光保护保持**：仍由护栏保留原路线，GIFP CAMBI {rows['lowlight-perlin-cloud']['gifp_metrics']['cambi_mean']:.2f}，gifski 为 {rows['lowlight-perlin-cloud']['gifski_metrics']['cambi_mean']:.2f}。

## 最终逐素材结果

VMAF Δ 定义为 `gifski − GIFP`，负值代表 GIFP 更高；体积变化负值代表 gifski 更小。

| 素材 | GIFP 最终路线 | GIFP 字节 | 帧数 | gifski 体积变化 | VMAF Δ | 判读 |
|---|---|---:|---:|---:|---:|---|
{chr(10).join(table_rows)}

## 实现内容

1. Best 护栏按 Text/UI、平滑渐变、噪声、静态、主体和通用内容使用不同硬门，并继续要求质量或体积 Pareto 收益。
2. 透明 GIF 默认启用 Rust 差分矩形和 disposal 字节搜索；连续相同画面合并持续时间，并用 timed-RGBA 语义验证替代单纯帧数相等。
3. 已通过内部 Pareto 与像素/处置模拟验证的默认 Rust writer 不再重复编码 Fast 基线。
4. QuickContentProbe 新增平滑梯度、空间边缘和 Laplacian 噪声信号；明确命中的全帧渐变跳过完整感知分析。
5. 小型平滑动画启用预算受控的 opaque 逐帧调色板；上限为 480 px、120 帧和 1200 万估算像素帧，超限自动回退全局 opaque diff。
6. 调优工具覆盖全局/分段/逐帧调色板、9 种抖动及透明色保留组合，并复用正式客观指标适配器。

## 剩余差距与限制

- 平滑渐变已在 VMAF 判定上持平，但 SSIM、平均 OKLab 与循环接缝仍略逊；下一步应锁定首尾/相邻局部色表连续性，而不是继续放宽护栏。
- 本轮机器负载不可与第一轮直接比较：Fast 总耗时本身变为第一轮的 {aggregate['raw_fast_slowdown_vs_round_one']:.2f}×。同轮 Best/Fast 比由 {round_one['best_vs_fast_total_time_ratio']:.2f}× 降至 {aggregate['best_vs_fast_total_time_ratio']:.2f}×，可作为路线开销改善的方向信号；绝对毫秒不作回归结论。
- 这是 8 个确定性合成素材的诊断结果，其中 2 个高频素材落入 VMAF 模型地板；仍需 28 素材、授权真实媒体和盲测才能升级正式梯队结论。
"""
    REPORT.write_text(report, encoding="utf-8")


def build_notebook() -> None:
    DOCS.mkdir(parents=True, exist_ok=True)
    compact = compact_results()
    COMPACT_RESULTS.write_text(
        json.dumps(compact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    build_markdown(compact)

    cells = [
        nbformat.v4.new_markdown_cell(
            "# GIFP 5.7.24 vs gifski 1.34.0\n\n"
            "8 个确定性诊断素材，统一为 320 px / 12 FPS；gifski 以最接近 GIFP Best 实际字节数的质量参数参赛。"
        ),
        nbformat.v4.new_code_cell(
            "from pathlib import Path\n"
            "import json\n"
            "import pandas as pd\n\n"
            "ROOT = Path.cwd()\n"
            "DATA = ROOT / 'docs' / 'benchmarks' / '2026-08-07-gifp-vs-gifski-pk-results.json'\n"
            "payload = json.loads(DATA.read_text(encoding='utf-8'))\n"
            "len(payload['rows']), payload['scope']['product_version'], payload['scope']['gifski_version']"
        ),
        nbformat.v4.new_markdown_cell(
            "## 结论摘要\n\n"
            "可靠 VMAF 从初始 2 胜 / 3 平 / 1 负，经第一轮 4 胜 / 1 平 / 1 负，提升为第二轮 4 胜 / 2 平 / 0 负。平滑渐变已从唯一明确负项收敛为同体积平局；VMAF 低于 20 的高频合成素材不用于方向性胜负。"
        ),
        nbformat.v4.new_code_cell(
            "a = payload['aggregate']\n"
            "pd.Series({\n"
            "    '样本数': a['fixture_count'],\n"
            "    '近体积样本': a['near_size_comparison_count'],\n"
            "    '可靠 VMAF 样本': a['reliable_vmaf_comparison_count'],\n"
            "    'Best 护栏回退': a['guard_fallback_count'],\n"
            "    '最终优化路线': a['optimized_final_count'],\n"
            "    '优化前可靠 VMAF 胜平负': str(payload['before_optimization']['aggregate']['reliable_vmaf_wins']),\n"
            "    '第一轮可靠 VMAF 胜平负': str(payload['round_one']['aggregate']['reliable_vmaf_wins']),\n"
            "    '第二轮可靠 VMAF 胜平负': str(a['reliable_vmaf_wins']),\n"
            "    'Best / Fast 总耗时倍数': round(a['best_vs_fast_total_time_ratio'], 2),\n"
            "    'Best/Fast 比值较第一轮下降%': round(a['best_fast_ratio_reduction_vs_round_one_pct'], 1),\n"
            "    '本轮 Fast 原始耗时放大倍数': round(a['raw_fast_slowdown_vs_round_one'], 2),\n"
            "    '测量适配器最大绝对误差': max(a['metric_adapter_max_absolute_delta'].values()),\n"
            "})"
        ),
        nbformat.v4.new_code_cell(
            "records = []\n"
            "for r in payload['rows']:\n"
            "    records.append({\n"
            "        '素材': r['fixture_id'],\n"
            "        '类别': r['category'],\n"
            "        'GIFP 路线': r['gifp_final_route'],\n"
            "        '同体积': r['near_size'],\n"
            "        'gifski 体积变化%': round(r['gifski_size_change_vs_gifp_pct'], 1),\n"
            "        'VMAF Δ': round(r['vmaf_delta_gifski_minus_gifp'], 3),\n"
            "        'SSIM Δ': round(r['ssim_delta_gifski_minus_gifp'], 4),\n"
            "        'OKLab 误差Δ': round(r['oklab_error_delta_gifski_minus_gifp'], 5),\n"
            "        '端到端加速倍数': round(r['speedup_gifp_over_gifski_e2e'], 1),\n"
            "        'GIFP帧': r['gifp_frame_count'],\n"
            "        'gifski帧': r['gifski_frame_count'],\n"
            "        '判读': r['comparison_class'],\n"
            "    })\n"
            "df = pd.DataFrame(records)\n"
            "df"
        ),
        nbformat.v4.new_markdown_cell("## 近体积对照"),
        nbformat.v4.new_code_cell(
            "df[df['同体积']][['素材','VMAF Δ','SSIM Δ','OKLab 误差Δ','GIFP帧','gifski帧','判读']]"
        ),
        nbformat.v4.new_markdown_cell("## gifski 已到质量上限但仍更小"),
        nbformat.v4.new_code_cell(
            "df[~df['同体积']][['素材','gifski 体积变化%','VMAF Δ','SSIM Δ','OKLab 误差Δ','判读']]"
        ),
        nbformat.v4.new_markdown_cell("## Best 路线诊断"),
        nbformat.v4.new_code_cell(
            "df.groupby('GIFP 路线', dropna=False).agg(\n"
            "    样本=('素材','count'),\n"
            "    中位端到端加速=('端到端加速倍数','median'),\n"
            ").sort_values('样本', ascending=False)"
        ),
        nbformat.v4.new_markdown_cell(
            "## 已实现与下一步\n\n"
            "已实现内容感知 Pareto 护栏、透明 timed-RGBA 帧合并、内部已验证 writer 的双编码消除、快速空间渐变探针，以及预算受控的 opaque 逐帧 Floyd 局部色表。下一步集中在首尾/相邻调色板连续性和循环接缝，并扩展到 28 素材和授权真实素材。"
        ),
        nbformat.v4.new_markdown_cell(
            "## 限制\n\n"
            "这是定位短板的 8 素材合成诊断，不是正式一线门禁；速度每素材仅一次且本轮机器负载异常，只使用同轮 Best/Fast 比作方向信号；3 个样本无法严格配到 ±5%；2 个高频样本的 VMAF 落入模型地板区。"
        ),
    ]
    notebook = nbformat.v4.new_notebook(
        cells=cells,
        metadata={
            "kernelspec": {
                "display_name": "GIFP benchmark Python",
                "language": "python",
                "name": "gifp-benchmark",
            },
            "language_info": {"name": "python", "version": "3.12"},
        },
    )

    kernel_root = WORK / "jupyter" / "kernels" / "gifp-benchmark"
    kernel_root.mkdir(parents=True, exist_ok=True)
    python_exe = Path(sys.executable)
    (kernel_root / "kernel.json").write_text(
        json.dumps(
            {
                "argv": [os.fspath(python_exe), "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                "display_name": "GIFP benchmark Python",
                "language": "python",
                "env": {"PYTHONPATH": os.fspath(PYDEPS)},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    previous_jupyter_path = os.environ.get("JUPYTER_PATH")
    os.environ["JUPYTER_PATH"] = os.fspath(WORK / "jupyter")
    os.environ["PYTHONPATH"] = os.fspath(PYDEPS)
    try:
        client = NotebookClient(
            notebook,
            timeout=120,
            kernel_name="gifp-benchmark",
            resources={"metadata": {"path": os.fspath(ROOT)}},
        )
        client.execute()
    finally:
        if previous_jupyter_path is None:
            os.environ.pop("JUPYTER_PATH", None)
        else:
            os.environ["JUPYTER_PATH"] = previous_jupyter_path

    nbformat.validate(notebook)
    for cell in notebook.cells:
        for output in cell.get("outputs", []):
            if output.get("output_type") == "error":
                raise RuntimeError("Notebook contains an error output")
    nbformat.write(notebook, NOTEBOOK)


if __name__ == "__main__":
    build_notebook()
    print(COMPACT_RESULTS)
    print(NOTEBOOK)
    print(REPORT)
