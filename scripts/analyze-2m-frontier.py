#!/usr/bin/env python3
"""Re-score the 2 MB frontier with the independent, shortest-timeline VMAF adapter."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "release" / "GIFP-5.7.27"
REPORTS = [
    ROOT / "tmp" / "quality-lab" / "2m-study-phase3.json",
    ROOT / "tmp" / "quality-lab" / "2m-study-phase4.json",
    ROOT / "tmp" / "quality-lab" / "2m-study-phase5.json",
]
OUTPUT = ROOT / "tmp" / "quality-lab" / "2m-frontier-objective.json"
WORK = ROOT / "tmp" / "quality-lab" / "2m-frontier-objective"


def load_adapter():
    os.environ["GIFP_BENCH_RUNTIME"] = os.fspath(RUNTIME)
    path = ROOT / "scripts" / "benchmark-gifp-vs-gifski.py"
    spec = importlib.util.spec_from_file_location("gifp_gifski_benchmark", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load objective adapter from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    adapter = load_adapter()
    previous = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() else {"rows": []}
    rows_by_profile = {row["profile"]: row for row in previous.get("rows", [])}
    sources = []
    for report_path in REPORTS:
        report = json.loads(report_path.read_text(encoding="utf-8"))
        reference = Path(report["sources"][0]["path"])
        sources.append(
            {
                "report": os.fspath(report_path),
                "source": os.fspath(reference),
                "source_sha256": report["sources"][0]["sha256"],
            }
        )
        for run in report["runs"]:
            result = run.get("result") or {}
            metrics = run.get("metrics") or {}
            output_path = Path(result["output_path"])
            profile = run["profile_id"]
            if profile in rows_by_profile:
                rows_by_profile[profile].update(
                    {
                        "size_bytes": metrics.get("size_bytes"),
                        "width": result.get("output_width"),
                        "nominal_fps": result.get("output_fps"),
                        "effective_fps": result.get("effective_output_fps"),
                        "stored_frames": metrics.get("frame_count"),
                        "colors": result.get("output_colors"),
                        "encoder": result.get("encoder_used"),
                    }
                )
                continue
            print(f"Scoring {profile}", flush=True)
            objective = adapter.evaluate_vmaf(
                reference,
                output_path,
                15.0,
                320,
                180,
                WORK / profile,
            )
            rows_by_profile[profile] = {
                "profile": profile,
                "size_bytes": metrics.get("size_bytes"),
                "width": result.get("output_width"),
                "nominal_fps": result.get("output_fps"),
                "effective_fps": result.get("effective_output_fps"),
                "stored_frames": metrics.get("frame_count"),
                "colors": result.get("output_colors"),
                "encoder": result.get("encoder_used"),
                **objective,
            }
    rows = sorted(
        rows_by_profile.values(),
        key=lambda row: (-float(row["nominal_fps"]), -int(row["width"]), row["profile"]),
    )
    payload = {
        "schema_version": 1,
        "sources": sources,
        "duration_seconds": 15.0,
        "size_cap_bytes": 2_000_000,
        "metric_adapter": "scripts/benchmark-gifp-vs-gifski.py:evaluate_vmaf",
        "rows": rows,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Results: {OUTPUT}", flush=True)


if __name__ == "__main__":
    main()
