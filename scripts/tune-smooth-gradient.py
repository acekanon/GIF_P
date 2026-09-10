#!/usr/bin/env python3
"""Screen FFmpeg GIF palette/dither routes on the pinned smooth-gradient fixture.

This is deliberately a focused tuning harness rather than a release benchmark.
It reuses the exact objective-metric adapter from benchmark-gifp-vs-gifski.py so
candidate routes can be rejected before they enter the product encoder.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
from pathlib import Path
import subprocess
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "tmp" / "gifski-pk"
TUNING_ROOT = WORK / "gradient-tuning"
FFMPEG = ROOT / "release" / "GIFP-5.7.24" / "ffmpeg.exe"
RESULTS = WORK / "results.json"
BENCHMARK_SCRIPT = ROOT / "scripts" / "benchmark-gifp-vs-gifski.py"

BASE_FILTER = (
    "fps=fps=12:start_time=0,"
    "scale=320:-1:flags=lanczos:force_original_aspect_ratio=decrease,"
    "format=rgba"
)


def load_metric_adapter() -> Any:
    spec = importlib.util.spec_from_file_location("gifp_gifski_pk", BENCHMARK_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import metric adapter from {BENCHMARK_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(command: list[str]) -> None:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", "replace").strip())


def encode_global(
    source: Path,
    output: Path,
    palette: Path,
    *,
    colors: int,
    stats: str,
    dither: str,
    bayer_scale: int | None,
    reserve_transparent: bool = True,
    diff_rectangle: bool = True,
) -> int:
    if not palette.is_file():
        run(
            [
                str(FFMPEG),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(source),
                "-vf",
                f"{BASE_FILTER},palettegen=max_colors={colors}:reserve_transparent={int(reserve_transparent)}:stats_mode={stats}",
                "-frames:v",
                "1",
                "-update",
                "1",
                str(palette),
            ]
        )
    dither_options = f"dither={dither}"
    if dither == "bayer" and bayer_scale is not None:
        dither_options += f":bayer_scale={bayer_scale}"
    started = time.perf_counter()
    diff = ":diff_mode=rectangle" if diff_rectangle else ""
    gif_flags = "+offsetting+transdiff" if reserve_transparent else "+offsetting-transdiff"
    run(
        [
            str(FFMPEG),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-i",
            str(palette),
            "-lavfi",
            f"[0:v]{BASE_FILTER}[x];[x][1:v]paletteuse={dither_options}{diff}:new=0:alpha_threshold=128",
            "-loop",
            "0",
            "-gifflags",
            gif_flags,
            "-global_palette",
            "1",
            str(output),
        ]
    )
    return round((time.perf_counter() - started) * 1000)


def encode_segmented(
    source: Path,
    output: Path,
    *,
    colors: int,
    dither: str,
    bayer_scale: int | None,
    segments: int,
) -> int:
    dither_options = f"dither={dither}"
    if dither == "bayer" and bayer_scale is not None:
        dither_options += f":bayer_scale={bayer_scale}"
    split_outputs = "".join(f"[s{index}]" for index in range(segments))
    graph = f"[0:v]{BASE_FILTER},split={segments}{split_outputs};"
    for index in range(segments):
        start = 3.0 * index / segments
        end = 3.0 * (index + 1) / segments
        trim = f"trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS"
        graph += (
            f"[s{index}]{trim},split[v{index}][pg{index}];"
            f"[pg{index}]palettegen=max_colors={colors}:reserve_transparent=1:stats_mode=full[p{index}];"
            f"[v{index}][p{index}]paletteuse={dither_options}:diff_mode=rectangle:new=0:alpha_threshold=128[o{index}];"
        )
    graph += "".join(f"[o{index}]" for index in range(segments))
    graph += f"concat=n={segments}:v=1:a=0[out]"
    started = time.perf_counter()
    run(
        [
            str(FFMPEG),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-filter_complex",
            graph,
            "-map",
            "[out]",
            "-loop",
            "0",
            "-gifflags",
            "+offsetting+transdiff",
            "-global_palette",
            "0",
            str(output),
        ]
    )
    return round((time.perf_counter() - started) * 1000)


def encode_per_frame(
    source: Path,
    output: Path,
    *,
    colors: int,
    dither: str,
    bayer_scale: int | None,
    reserve_transparent: bool = True,
) -> int:
    dither_options = f"dither={dither}"
    if dither == "bayer" and bayer_scale is not None:
        dither_options += f":bayer_scale={bayer_scale}"
    graph = (
        f"[0:v]{BASE_FILTER},split[v][pg];"
        f"[pg]palettegen=max_colors={colors}:reserve_transparent={int(reserve_transparent)}:stats_mode=single[p];"
        f"[v][p]paletteuse={dither_options}:new=1:alpha_threshold=128[out]"
    )
    gif_flags = "+offsetting+transdiff" if reserve_transparent else "+offsetting-transdiff"
    started = time.perf_counter()
    run(
        [
            str(FFMPEG),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-filter_complex",
            graph,
            "-map",
            "[out]",
            "-loop",
            "0",
            "-gifflags",
            gif_flags,
            "-global_palette",
            "0",
            str(output),
        ]
    )
    return round((time.perf_counter() - started) * 1000)


def candidate_specs(suite: str) -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []
    if suite == "perframe":
        for dither, reserve_transparent in [
            ("heckbert", True),
            ("floyd_steinberg", True),
            ("sierra2", True),
            ("atkinson", True),
            ("floyd_steinberg", False),
            ("sierra2_4a", False),
        ]:
            specs.append(
                {
                    "route": "per_frame",
                    "colors": 96,
                    "stats": "single",
                    "dither": dither,
                    "bayer_scale": None,
                    "reserve_transparent": reserve_transparent,
                }
            )
        return specs
    if suite == "focused":
        for stats, diff_rectangle in [
            ("diff", False),
            ("full", True),
            ("diff", True),
        ]:
            specs.append(
                {
                    "route": "global",
                    "colors": 96,
                    "stats": stats,
                    "dither": "sierra2_4a",
                    "bayer_scale": None,
                    "reserve_transparent": False,
                    "diff_rectangle": diff_rectangle,
                }
            )
        return specs
    if suite == "extended":
        for segments in (2, 3, 4, 6, 9):
            specs.append(
                {
                    "route": "segmented",
                    "colors": 96,
                    "stats": "full",
                    "dither": "sierra2_4a",
                    "bayer_scale": None,
                    "segments": segments,
                }
            )
        for segments in (3, 6):
            specs.append(
                {
                    "route": "segmented",
                    "colors": 96,
                    "stats": "full",
                    "dither": "floyd_steinberg",
                    "bayer_scale": None,
                    "segments": segments,
                }
            )
        specs.extend(
            [
                {
                    "route": "global",
                    "colors": 96,
                    "stats": "full",
                    "dither": "sierra2_4a",
                    "bayer_scale": None,
                    "reserve_transparent": False,
                    "diff_rectangle": False,
                },
                {
                    "route": "global",
                    "colors": 96,
                    "stats": "full",
                    "dither": "sierra2_4a",
                    "bayer_scale": None,
                    "reserve_transparent": True,
                    "diff_rectangle": False,
                },
                {
                    "route": "global",
                    "colors": 96,
                    "stats": "diff",
                    "dither": "sierra2_4a",
                    "bayer_scale": None,
                    "reserve_transparent": True,
                    "diff_rectangle": True,
                },
            ]
        )
        return specs
    for dither, scale in [
        ("none", None),
        ("bayer", 0),
        ("bayer", 1),
        ("bayer", 2),
        ("bayer", 3),
        ("heckbert", None),
        ("floyd_steinberg", None),
        ("sierra2", None),
        ("sierra2_4a", None),
        ("atkinson", None),
    ]:
        specs.append(
            {
                "route": "global",
                "colors": 96,
                "stats": "full",
                "dither": dither,
                "bayer_scale": scale,
            }
        )
    for dither, scale in [
        ("none", None),
        ("bayer", 1),
        ("bayer", 2),
        ("sierra2_4a", None),
    ]:
        specs.append(
            {
                "route": "per_frame",
                "colors": 96,
                "stats": "single",
                "dither": dither,
                "bayer_scale": scale,
            }
        )
    for colors in (128, 160):
        for dither, scale in [("none", None), ("bayer", 1), ("bayer", 2), ("sierra2_4a", None)]:
            specs.append(
                {
                    "route": "global",
                    "colors": colors,
                    "stats": "full",
                    "dither": dither,
                    "bayer_scale": scale,
                }
            )
    return specs


def candidate_id(spec: dict[str, Any]) -> str:
    scale = "" if spec["bayer_scale"] is None else f"-s{spec['bayer_scale']}"
    segments = "" if spec.get("segments") is None else f"-n{spec['segments']}"
    opaque = "-opaque" if spec.get("reserve_transparent") is False else ""
    full_frame = "-fullframe" if spec.get("diff_rectangle") is False else ""
    return f"{spec['route']}-{spec['colors']}-{spec['stats']}-{spec['dither']}{scale}{segments}{opaque}{full_frame}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--suite",
        choices=("base", "extended", "focused", "perframe"),
        default="base",
    )
    args = parser.parse_args()
    payload = json.loads(RESULTS.read_text(encoding="utf-8"))
    baseline = next(row for row in payload["rows"] if row["fixture_id"] == "flat-seamless-wave")
    source = Path(baseline["source_path"])
    metric_adapter = load_metric_adapter()
    run_id = f"{int(time.time() * 1000)}-{args.suite}"
    run_root = TUNING_ROOT / run_id
    output_root = run_root / "outputs"
    palette_root = run_root / "palettes"
    metrics_root = run_root / "metrics"
    output_root.mkdir(parents=True, exist_ok=True)
    palette_root.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, Any]] = []
    specs = candidate_specs(args.suite)
    for index, spec in enumerate(specs, 1):
        identifier = candidate_id(spec)
        print(f"[{index:02d}] {identifier}", flush=True)
        output = output_root / f"{identifier}.gif"
        if spec["route"] == "per_frame":
            encode_ms = encode_per_frame(
                source,
                output,
                colors=spec["colors"],
                dither=spec["dither"],
                bayer_scale=spec["bayer_scale"],
                reserve_transparent=spec.get("reserve_transparent", True),
            )
        elif spec["route"] == "segmented":
            encode_ms = encode_segmented(
                source,
                output,
                colors=spec["colors"],
                dither=spec["dither"],
                bayer_scale=spec["bayer_scale"],
                segments=spec["segments"],
            )
        else:
            reserve = spec.get("reserve_transparent", True)
            palette = palette_root / f"palette-{spec['colors']}-{spec['stats']}-reserve-{int(reserve)}.png"
            encode_ms = encode_global(
                source,
                output,
                palette,
                colors=spec["colors"],
                stats=spec["stats"],
                dither=spec["dither"],
                bayer_scale=spec["bayer_scale"],
                reserve_transparent=reserve,
                diff_rectangle=spec.get("diff_rectangle", True),
            )
        metrics = metric_adapter.evaluate_output(
            source,
            output,
            3.0,
            480,
            270,
            False,
            metrics_root / identifier,
        )
        rows.append(
            {
                "id": identifier,
                **spec,
                "path": str(output),
                "size_bytes": output.stat().st_size,
                "encode_ms": encode_ms,
                "vmaf_neg_mean": metrics["vmaf_neg_mean"],
                "vmaf_neg_p05": metrics["vmaf_neg_p05"],
                "ssim_mean": metrics["ssim_mean"],
                "ms_ssim_mean": metrics["ms_ssim_mean"],
                "ciede2000_mean": metrics["ciede2000_mean"],
                "cambi_mean": metrics["cambi_mean"],
                "mean_oklab_error": metrics["mean_oklab_error"],
                "static_region_temporal_residual": metrics[
                    "static_region_temporal_residual"
                ],
                "loop_seam_excess_oklab": metrics["loop_seam_excess_oklab"],
            }
        )

    rows.sort(key=lambda row: (-row["vmaf_neg_mean"], row["size_bytes"]))
    result = {
        "schema_version": 1,
        "fixture_id": "flat-seamless-wave",
        "baseline": {
            "gifp_size_bytes": baseline["gifp_size_bytes"],
            "gifp_metrics": baseline["gifp_metrics"],
            "gifski_size_bytes": baseline["gifski_size_bytes"],
            "gifski_metrics": baseline["gifski_metrics"],
        },
        "rows": rows,
    }
    json_path = run_root / "results.json"
    csv_path = run_root / "results.csv"
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = list(dict.fromkeys(key for row in rows for key in row))
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps(rows[:8], ensure_ascii=False, indent=2), flush=True)
    print(f"Results: {json_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
