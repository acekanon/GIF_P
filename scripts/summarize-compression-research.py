"""Produce a source-backed Markdown readout from a completed experiment run."""
from pathlib import Path
import argparse
import hashlib
import json


LABELS = {
    "palette-switch": "局部调色板切换（机制样例）",
    "dither-static": "静态抖动（机制样例）",
    "index-noise": "索引噪声（机制样例）",
    "alpha-sprite": "透明移动物体（回归样例）",
    "text-motion": "文字与运动（回归样例）",
    "local-ui": "480p 局部界面",
    "smooth-gradient": "480p 缓慢渐变",
    "moving-pattern": "480p 运动图案",
    "noisy-motion": "480p 强噪声运动",
}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    args = parser.parse_args()
    work = args.run.resolve()
    results = read(work / "results.json")
    manifest = read(work / "manifest.json")
    if len(results) != len(manifest) or any("error" in r for r in results):
        raise ValueError("run is incomplete or contains execution errors")
    reports = {r["id"]: read(work / r["id"] / "candidates/report.json") for r in results}
    attempts = sum(len(r["candidates"]) for r in reports.values())
    decoded = sum(c.get("decoder_consensus", False) for r in results for c in r["checks"])
    lines = ["# 三方向压缩实验：首轮结果", "",
             f"完成 {len(results)} 个合成样本、{attempts} 个尝试（含 writer 对照）；{decoded} 个实际文件通过 FFmpeg/Pillow 展示与循环一致性检查。候选仍须分别通过像素、源参考和体积门槛才会被选中。",
             "", "本轮是离线实验验证，产品默认编码未切换。机制/回归样例为 160×96、1 秒；既有边界样本为 854×480、5 秒、60 个原始源采样。没有真实素材留出集或多人盲测，不作普遍压缩倍数或全局最优承诺。", "",
             "## 每个样本的最终选择", "",
             "writer 对照使用同一输入做原样重编码。比较新算法时必须扣除这部分变化；下表总体节省是相对输入 GIF。", "",
             "| 样本 | 输入字节 | writer 对照字节 | 选中字节 | 总体节省 | 选中方案 | 显示像素与输入 |",
             "|---|---:|---:|---:|---:|---|---|"]
    for result in results:
        native = {c["id"]: c for c in reports[result["id"]]["candidates"]}
        winner = native.get(result["selected_id"])
        path = work / result["id"] / "selected.gif"
        expected = winner["sha256"] if winner else result["input_sha256"]
        if sha(path) != expected or path.stat().st_size != result["selected_bytes"]:
            raise ValueError(f"selected artifact changed: {path}")
        visible = "完全一致" if not winner or winner["pixels"]["max_channel_error"] == 0 else f"受控变化 ≤{winner['pixels']['max_channel_error']}/255"
        lines.append(f"| {LABELS.get(result['id'], result['id'])} | {result['baseline_bytes']:,} | {native['writer-baseline']['bytes']:,} | {result['selected_bytes']:,} | {result['saved_percent']:.2f}% | `{result['selected_id']}` | {visible} |")
    lines += ["", "## 可归因的算法收益", "",
              "下表只列相对对应对照至少节省 1% 且 64 字节、并通过内部与外部验收的算法候选。相同算法参数变体只保留最小项；重复等价候选不重复算作突破。", "",
              "| 样本 | 方向 | 对照 | 对照字节 | 候选字节 | 增量节省 |", "|---|---|---|---:|---:|---:|"]
    incremental = []
    for result in results:
        candidates = {c["id"]: c for c in reports[result["id"]]["candidates"]}
        checks = {c["id"]: c for c in result["checks"]}
        for direction in ("structure", "temporal", "lzw"):
            eligible = []
            for candidate in candidates.values():
                comparator = candidates.get(candidate["comparison"])
                if candidate["direction"] != direction or not checks[candidate["id"]]["accepted"] or not comparator or comparator["bytes"] is None:
                    continue
                savings = comparator["bytes"] - candidate["bytes"]
                if savings >= max(64, comparator["bytes"] / 100):
                    eligible.append((candidate, comparator))
            if not eligible:
                continue
            candidate, comparator = min(eligible, key=lambda pair: pair[0]["bytes"])
            fraction = 100 * (1 - candidate["bytes"] / comparator["bytes"])
            lines.append(f"| {LABELS.get(result['id'], result['id'])} | {direction} | `{comparator['id']}` | {comparator['bytes']:,} | {candidate['bytes']:,} | {fraction:.2f}% |")
            incremental.append({"fixture": result["id"], "direction": direction, "candidate": candidate["id"],
                                "comparison": comparator["id"], "savings_percent": fraction})
    if not any(row["direction"] == "lzw" for row in incremental):
        lines += ["", "LZW 路线在本轮未取得通过完整验收的独立增量。writer 重编码的收益不计作新索引算法突破。"]
    lines += ["", "## 渐变候选", ""]
    if "smooth-gradient" in reports:
        report = reports["smooth-gradient"]
        candidate = next(c for c in report["candidates"] if c["id"] == "lzw-error4")
        lines += [f"LZW 误差 4 候选：输入 {report['baseline_bytes']:,} 字节，候选 {candidate['bytes']:,} 字节（约 {candidate['bytes']/1048576:.2f} MiB）。内部验收通过：{candidate['internal_gate_passed']}；原因：{', '.join(candidate['reasons']) or '无'}。最终选择见上表。", ""]
        if (work / "gradient-rejected-comparison.png").exists():
            lines += ["![左侧原 GIF，右侧被淘汰的 LZW 候选](gradient-rejected-comparison.png)", ""]
    lines += ["## 验证与复现", ""]
    validation = work / "validation/summary.json"
    if validation.exists():
        evidence = read(validation)
        lines += [f"- 完整 Release Rust 回归：{evidence['rust_passed']} 通过、{evidence['rust_failed']} 失败、{evidence['rust_ignored']} 忽略。",
                  f"- Release all-targets 严格 Clippy 通过：{evidence['clippy_passed']}；新增 Rust 文件格式检查通过：{evidence['rustfmt_passed']}。",
                  f"- 确定性复跑通过：{evidence['determinism_passed']}，比较 {evidence['determinism_candidates']} 个候选的字节哈希、质量与验收结果。",
                  "- 证据：[验证摘要](validation/summary.json)、[Rust 日志](validation/rust-tests-runtime.log)、[Clippy 日志](validation/clippy.log)。"]
    lines += ["- 最终样例在运行前完成双解码器一致性确认，验收阈值未降低。",
              "- 每轮保存工具哈希、研究 EXE、副本源码、输入/参考 SHA-256、候选、拒绝理由、实际选中文件及同一时刻对比。参考 RGB 保留，可在新的输出目录复跑单个任务。", "",
              "[完整结果](results.json) · [输入清单](manifest.json) · [工具哈希](toolchain.json) · [实验方法](../../../docs/strategy/2026-09-09-compression-research-v1.md)", "",
              "## 后续实验的具体问题", "",
              "1. 在不放宽源参考和色带验收的条件下，让 LZW 搜索减少可见色带，而不是继续增加允许误差。",
              "2. 把合成画面的边缘保护回传到 LZW 索引搜索；当前局部索引保护仍可能被后续透明复用放大为展示边缘变化，外部验收会拒绝。",
              "3. 研究局部调色表和透明空洞的开销；保留多种 disposal 状态对透明物体有效，束宽 1 在该样例会走入死路，而束宽 3 能保留可行路径。",
              "4. 加入真实授权素材、原尺寸文字/色带检查和未参与调优的留出测试，再决定产品集成。", ""]
    (work / "report.md").write_text("\n".join(lines), encoding="utf-8")
    (work / "incremental-results.json").write_text(json.dumps(incremental, ensure_ascii=False, indent=2), encoding="utf-8")
    (work / "summary-provenance.json").write_text(json.dumps({"builder_sha256": sha(Path(__file__)), "results_sha256": sha(work / "results.json"), "report_sha256": sha(work / "report.md")}, indent=2), encoding="utf-8")
    print(work / "report.md")


if __name__ == "__main__":
    main()
