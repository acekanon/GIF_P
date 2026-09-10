"""Summarize only the transparent-postprocess rejection branch, not whole exports."""
from pathlib import Path
from statistics import median
import argparse
import hashlib
import json


def summarize(path):
    report = json.loads(path.read_text(encoding="utf-8"))
    if report["status"] != "passed" or report["build_profile"] != "release":
        raise ValueError("A completed release pilot is required")
    rows = report["rows"]
    if len(rows) != 9 or {(r["width"], r["round"]) for r in rows} != {(w, i) for w in [32,48,64] for i in range(3)}:
        raise ValueError("Incomplete paired matrix")
    for row in rows:
        for key in ["baseline_path", "optimized_path"]:
            if hashlib.sha256(Path(row[key]).read_bytes()).hexdigest() != row["sha256"]:
                raise ValueError("Output was modified")
        if min(row["baseline_us"], row["optimized_us"]) <= 0:
            raise ValueError("Invalid timing")
        original, optimized = row["baseline_report"], row["optimized_report"]
        if not original["decoded_pixel_parity_verified"] or optimized["decoded_pixel_parity_verified"] or optimized["decoded_rgba_sha256"] is not None:
            raise ValueError("Verification status is not truthful")
        if optimized["candidate_serialized_bytes"] < optimized["baseline_serialized_bytes"]:
            raise ValueError("A smaller candidate was incorrectly rejected")
        calls = lambda profile: next(s["calls"] for s in profile["stages"] if s["stage"] == "candidate_validation")
        if calls(row["baseline_profile"]) != calls(row["optimized_profile"]) + 1:
            raise ValueError("Expected exactly one avoided decode")
    summary = {"pairs":9, "all_outputs_unchanged":True,
        "median_saved_ms":median((r["baseline_us"]-r["optimized_us"])/1000 for r in rows),
        "median_paired_saving_percent":median((1-r["optimized_us"]/r["baseline_us"])*100 for r in rows),
        "scope":report["scope"]}
    path.with_name("summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    lines=["# 透明候选提前淘汰对照", "", "只测透明后处理中的不改善体积候选：三种已优化的合成透明动图，每种三次配对。不是整次导出或一般 Best 性能。", "",
        "| 宽度 | 原路径 P50/ms | 提前淘汰 P50/ms | 配对节省中位数/ms |", "|---|---:|---:|---:|"]
    for width in [32,48,64]:
        group=[r for r in rows if r['width']==width]
        lines.append(f"| {width} | {median(r['baseline_us'] for r in group)/1000:.1f} | {median(r['optimized_us'] for r in group)/1000:.1f} | {median((r['baseline_us']-r['optimized_us'])/1000 for r in group):.1f} |")
    lines += ["", f"9 组文件保持不变，每组少一次解码；该分支配对节省中位数 {summary['median_saved_ms']:.1f} ms。", "",
        "候选未解码时，其校验标志为 false、解码哈希为空。更小的候选仍须完成原有独立解码与时间线／像素验证才能发布。不能将该分支的降幅外推成整个软件提速。", ""]
    path.with_name("summary.md").write_text("\n".join(lines),encoding="utf-8")
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("report",type=Path)
    summarize(parser.parse_args().report)
