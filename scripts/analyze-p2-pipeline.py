"""Validate and summarize the native P2 paired pilot; no third-party packages."""
from collections import defaultdict
from pathlib import Path
from statistics import median
import argparse
import hashlib
import json


def summarize(report_path: Path):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("status") != "passed" or report.get("build_profile") != "release":
        raise ValueError("A completed release pilot is required for performance reporting")
    manifest_path = Path(__file__).resolve().parents[1] / "bench/p2-sticker-manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != report["manifest_sha256"]:
        raise ValueError("The corpus manifest changed after measurement")
    fixtures = {item["id"]: item for item in json.loads(manifest_bytes)["fixtures"]}
    expected_groups = {(fixture, mode) for fixture in fixtures for mode in ("fast_gif", "best_gif", "target_size")}
    groups = defaultdict(list)
    identities = set()
    for row in report["rows"]:
        identity = (row["fixture"], row["mode"], row["round"])
        if (row["fixture"], row["mode"]) not in expected_groups:
            raise ValueError(f"Unexpected fixture or mode: {identity}")
        if identity in identities:
            raise ValueError(f"Duplicate paired run: {identity}")
        identities.add(identity)
        if not row["bytes_identical"] or min(row["baseline_wall_us"], row["optimized_wall_us"]) <= 0:
            raise ValueError(f"Incomplete comparison: {identity}")
        for variant in ("baseline", "optimized"):
            result = row[variant]
            data = Path(result["output_path"]).read_bytes()
            if hashlib.sha256(data).hexdigest() != row["output_sha256"] or len(data) != result["size_bytes"]:
                raise ValueError(f"Output bytes no longer match: {identity}, {variant}")
            profile = result["pipeline_profile"]
            accounted = sum(stage["elapsed_us"] for stage in profile["stages"])
            if not 0 <= profile["elapsed_us"] - accounted <= len(profile["stages"]):
                raise ValueError(f"Stage attribution overlaps or is incomplete: {identity}")
            cache = profile["palette_cache"]
            if cache["retained_bytes"] > cache["limit_bytes"]:
                raise ValueError(f"Palette cache exceeded its budget: {identity}")
            if row["mode"] == "target_size" and len(data) > result["target_size_bytes"]:
                raise ValueError(f"Hard cap exceeded: {identity}")
        if (row["baseline"]["output_width"], row["baseline"]["output_fps"]) != (
            row["optimized"]["output_width"], row["optimized"]["output_fps"]
        ):
            raise ValueError(f"Output dimensions or FPS changed: {identity}")
        groups[(row["fixture"], row["mode"])].append(row)
        fixture = fixtures[row["fixture"]]
        if (row["optimized"]["output_width"], row["optimized"]["output_fps"]) != (fixture["width"], fixture["fps"]):
            raise ValueError(f"Requested dimensions or FPS were not preserved: {identity}")
    if set(groups) != expected_groups:
        raise ValueError("The four-fixture, three-mode matrix is incomplete")
    summary = []
    for (fixture, mode), rows in sorted(groups.items()):
        if sorted(row["round"] for row in rows) != [0, 1, 2]:
            raise ValueError(f"Expected three paired repetitions: {fixture}, {mode}")
        if len({row["source_sha256"] for row in rows}) != 1:
            raise ValueError(f"Source changed between repetitions: {fixture}, {mode}")
        summary.append({
            "fixture": fixture, "mode": mode, "pairs": len(rows),
            "baseline_median_ms": median(row["baseline_wall_us"] for row in rows) / 1000,
            "optimized_median_ms": median(row["optimized_wall_us"] for row in rows) / 1000,
            "median_paired_saving_percent": median(
                (1 - row["optimized_wall_us"] / row["baseline_wall_us"]) * 100 for row in rows
            ),
            "cache_hits": sum(row["optimized"]["pipeline_profile"]["palette_cache"]["hits"] for row in rows),
            "maximum_palette_payload_bytes": max(
                row["optimized"]["pipeline_profile"]["palette_cache"]["retained_bytes"] for row in rows
            ),
        })
    by_mode = {}
    for mode in ("fast_gif", "best_gif", "target_size"):
        rows = [row for row in report["rows"] if row["mode"] == mode]
        stages = defaultdict(int)
        for row in rows:
            for stage in row["baseline"]["pipeline_profile"]["stages"]:
                stages[stage["stage"]] += stage["elapsed_us"]
        total = sum(stages.values())
        by_mode[mode] = {
            "pairs": len(rows),
            "median_paired_saving_percent": median(
                (1 - row["optimized_wall_us"] / row["baseline_wall_us"]) * 100 for row in rows
            ),
            "baseline_stage_share_percent": {name: value / total * 100 for name, value in stages.items()},
        }
    output = {
        "source": str(report_path.resolve()), "corpus_id": report["corpus_id"],
        "paired_runs": len(report["rows"]), "all_outputs_identical": True,
        "groups": summary, "by_mode": by_mode,
        "scope": "Four synthetic fixtures, three pairs per mode; no claim about general workloads or ranking.",
    }
    report_path.with_name("benchmark-summary.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    lines = [
        "# P2 调色板复用原生对照", "",
        "Release 构建，四份自生成素材，每种模式三次配对，交替先后顺序。计时不含素材生成、质量评分和对照验证；包含编码与原有成品校验。",
        "所有配对成品文件逐字节一致，保留原时间线、尺寸、FPS 与透明语义。", "",
        "| 素材 | 模式 | 关闭复用 P50/ms | 开启复用 P50/ms | 配对耗时降幅中位数 | 命中次数 |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for row in summary:
        lines.append(
            f"| {row['fixture']} | {row['mode']} | {row['baseline_median_ms']:.1f} | "
            f"{row['optimized_median_ms']:.1f} | {row['median_paired_saving_percent']:+.1f}% | {row['cache_hits']} |"
        )
    lines += ["", "Fast／Best 两侧都不启用复用，作为顺序与测量波动的控制组；只在 GIF 体积上限模式启用缓存。", "",
              "降幅按每一对 `1 - 开启耗时 / 关闭耗时` 后取中位数，负值代表这次测得更慢；它不一定等于两列 P50 的比值。", "",
              "## 关闭复用时的阶段占比", "", "| 阶段 | Fast | Best | 体积上限 |", "|---|---:|---:|---:|"]
    for name in by_mode["fast_gif"]["baseline_stage_share_percent"]:
        shares = " | ".join(f"{by_mode[mode]['baseline_stage_share_percent'][name]:.1f}%" for mode in by_mode)
        lines.append(f"| {name} | {shares} |")
    lines += ["", "阶段采用互斥墙钟时间，嵌套阶段不重复累计。FFmpeg 调色板生成仍包含其输入解码与变换，映射／编码阶段也可能包含 FFmpeg 内部解码；这些是可观测调用边界，不是 FFmpeg 内部 CPU 细分。",
              "", "这些样本用于回归和定位瓶颈，不能外推为所有素材提速，也不是新一轮竞品排名。缓存记录仅统计 PNG 载荷，不代表进程峰值内存。", ""]
    report_path.with_name("benchmark-summary.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"paired_runs": output["paired_runs"], "by_mode": by_mode}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    summarize(parser.parse_args().report)
