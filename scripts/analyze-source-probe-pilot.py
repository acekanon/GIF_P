"""Validate the source-probe pilot and report paired timings without extrapolation."""
from pathlib import Path
from statistics import median
import argparse
import hashlib
import json


def summarize(path):
    root = Path(__file__).resolve().parents[1]
    report = json.loads(path.read_text(encoding="utf-8"))
    assert report["status"] == "passed" and report["build_profile"] == "release"
    assert report["task_id_registered"] is True
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    manifest_path = root / "bench/p2-sticker-manifest.json"
    assert sha(manifest_path) == report["manifest_sha256"]
    fixtures = {item["id"]: item for item in json.loads(manifest_path.read_text(encoding="utf-8"))["fixtures"]}
    expected = {(name, index) for name in fixtures for index in range(3)}
    rows = report["rows"]
    assert len(rows) == len(expected)
    assert {(row["fixture"], row["round"]) for row in rows} == expected
    for row in rows:
        fixture = fixtures[row["fixture"]]
        assert min(row["baseline_us"], row["optimized_us"]) > 0
        for variant in ("baseline", "optimized"):
            result = row[variant]
            file = Path(result["output_path"])
            assert sha(file) == row["output_sha256"]
            assert file.stat().st_size == result["size_bytes"]
            assert sha(Path(result["input_path"])) == row["source_sha256"]
            assert result["output_width"] == fixture["width"] and result["output_fps"] == fixture["fps"]
        cache = row["optimized"]["pipeline_profile"]["source_probe_cache"]
        assert cache["hits"] > 0 and cache["retained_bytes"] <= cache["limit_bytes"] <= 65536
    groups = []
    for fixture in fixtures:
        subset = [row for row in rows if row["fixture"] == fixture]
        groups.append({"fixture": fixture,
            "baseline_median_ms": median(row["baseline_us"] for row in subset) / 1000,
            "optimized_median_ms": median(row["optimized_us"] for row in subset) / 1000,
            "median_paired_saving_percent": median((1-row["optimized_us"]/row["baseline_us"])*100 for row in subset),
            "cache_hits": sum(row["optimized"]["pipeline_profile"]["source_probe_cache"]["hits"] for row in subset)})
    summary = {"paired_runs": len(rows), "all_files_identical": True, "groups": groups,
        "median_paired_saving_percent": median((1-row["optimized_us"]/row["baseline_us"])*100 for row in rows),
        "scope": "Four synthetic Best fixtures, registered native task IDs; no general speed or ranking claim."}
    path.with_name("summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    lines = ["# 重复源探测复用对照", "", "四份合成素材、Best 模式、每份三次配对，交替先后次序；注册原生任务 ID，保留取消轮询与原子发布。两侧使用同一联合元数据查询，只有复用开关不同。", "",
             "| 素材 | 关闭复用 P50/ms | 开启复用 P50/ms | 配对降幅中位数 | 命中次数 |", "|---|---:|---:|---:|---:|"]
    for group in groups:
        lines.append(f"| {group['fixture']} | {group['baseline_median_ms']:.1f} | {group['optimized_median_ms']:.1f} | {group['median_paired_saving_percent']:+.1f}% | {group['cache_hits']} |")
    lines += ["", f"12 组配对耗时降幅中位数：{summary['median_paired_saving_percent']:.2f}%。所有成品文件逐字节一致。", "",
              "按每对 `1 - 开启耗时 / 关闭耗时` 取中位数，负值表示该配对更慢；两列 P50 的比值不一定等于配对中位数。仅代表本批小样本，未测 UI 延迟、异步评分或峰值 RSS，不与上一批的无任务 ID 计时混算。", ""]
    path.with_name("summary.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    summarize(parser.parse_args().report)
