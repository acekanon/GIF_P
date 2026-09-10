#!/usr/bin/env python3
"""Reproducible, isolated GIFP Best GIF vs gifski size-matched benchmark.

The script deliberately keeps gifski outside the product runtime. It prepares a
temporary Quality Lab manifest pinned to the selected local FFmpeg runtime,
runs GIFP's real Best GIF path, feeds gifski the same 12 FPS / 320 px Lanczos
RGBA timeline, searches for the closest output size, and evaluates both with
GIFP's objective metric definitions.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any, Iterable

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
PRODUCT_VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
WORK = ROOT / "tmp" / "gifski-pk" / f"{PRODUCT_VERSION}-arena10"
RUNTIME = Path(
    os.environ.get(
        "GIFP_BENCH_RUNTIME",
        os.fspath(ROOT / "release" / "GIFP-5.7.24"),
    )
)
FFMPEG = RUNTIME / "ffmpeg.exe"
FFPROBE = RUNTIME / "ffprobe.exe"
QUALITY_LAB = ROOT / "src-tauri" / "target" / "release" / "gifp_quality_lab.exe"
GIFSKI = ROOT / "tmp" / "gifski-pk" / "tool" / "bin" / "gifski.exe"
SOURCE_MANIFEST = ROOT / "bench" / "arena10-manifest.json"
RUNTIME_MANIFEST = ROOT / "bench" / "arena10-toolchain.lock.json"
BENCH_MANIFEST = WORK / "corpus-manifest.json"
QUALITY_REPORT = WORK / "quality-lab.json"
RESULT_JSON = WORK / "results.json"
RESULT_CSV = WORK / "results.csv"
FAST_PROFILE_ID = "fast-baseline"
BEST_PROFILE_ID = "best-current"

DEFAULT_FIXTURES = [
    "skin-gradient-portrait",
    "ui-pixel-grid",
    "ui-alpha-panel",
    "flat-seamless-wave",
    "game-zoneplate-effects",
    "lowlight-perlin-cloud",
    "motion-rotate-zoneplate",
    "static-small-change",
    "long-timeline-cuts",
    "poster-local-motion",
]

ANALYSIS_FPS = 30
ANALYSIS_WIDTH = 96
PRESENTATION_WIDTH = 320
STATIC_OKLAB_THRESHOLD = 0.012
EDGE_THRESHOLD = 0.08


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checked_binary(path: Path, label: str) -> Path:
    if not path.is_file():
        raise FileNotFoundError(f"{label} not found: {path}")
    return path


def run(
    args: Iterable[os.PathLike[str] | str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    command = [os.fspath(value) for value in args]
    result = subprocess.run(
        command,
        cwd=os.fspath(cwd) if cwd else None,
        env=env,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
    )
    if check and result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace") if result.stderr else ""
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(command)}\n{stderr.strip()}"
        )
    return result


def tool_version(path: Path) -> str:
    flag = "-version" if path.stem.lower() in {"ffmpeg", "ffprobe"} else "--version"
    result = run([path, flag], capture=True)
    text = (result.stdout or result.stderr).decode("utf-8", "replace")
    return next((line.strip() for line in text.splitlines() if line.strip()), "unknown")


def prepare_benchmark_manifest() -> dict[str, Any]:
    manifest = json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))
    manifest["$schema"] = os.path.relpath(
        ROOT / "bench" / "corpus-manifest.schema.json", WORK
    ).replace("\\", "/")
    manifest["description"] += (
        f" 本文件由 scripts/benchmark-gifp-vs-gifski.py 为 GIFP {PRODUCT_VERSION} Arena 10 临时生成。"
    )
    manifest["fixture_root"] = "fixtures"
    manifest.pop("performance_budget", None)

    identity = manifest["canonical_fixture_identity"]
    identity["generator_ffmpeg_sha256"] = sha256_file(FFMPEG)
    identity["generator_ffprobe_sha256"] = sha256_file(FFPROBE)
    identity["reviewed_runtime_manifest_sha256"] = sha256_file(RUNTIME_MANIFEST)

    profiles = {profile["id"]: dict(profile) for profile in manifest["profiles"]}
    fast = profiles["arena-fast"]
    best = profiles["arena-best"]
    fast["id"] = FAST_PROFILE_ID
    best["id"] = BEST_PROFILE_ID
    manifest["profiles"] = [fast, best]
    WORK.mkdir(parents=True, exist_ok=True)
    BENCH_MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def quality_report_is_reusable(fixtures: list[str]) -> bool:
    if not QUALITY_REPORT.is_file():
        return False
    try:
        report = json.loads(QUALITY_REPORT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if {source["fixture_id"] for source in report.get("sources", [])} != set(fixtures):
        return False
    if report.get("toolchain", {}).get("ffmpeg_sha256") != sha256_file(FFMPEG):
        return False
    if report.get("toolchain", {}).get("gifp_version") != PRODUCT_VERSION:
        return False
    if report.get("manifest_sha256") != sha256_file(BENCH_MANIFEST):
        return False
    best_runs = {
        item["fixture_id"]: item
        for item in report.get("runs", [])
        if item.get("profile_id") == BEST_PROFILE_ID and item.get("status") == "ok"
    }
    return set(best_runs) == set(fixtures) and all(
        Path(item["result"]["output_path"]).is_file() for item in best_runs.values()
    )


def run_quality_lab(fixtures: list[str], reuse: bool) -> dict[str, Any]:
    prepare_benchmark_manifest()
    if reuse and quality_report_is_reusable(fixtures):
        print(f"Reusing {QUALITY_REPORT}", flush=True)
        return json.loads(QUALITY_REPORT.read_text(encoding="utf-8"))

    print("Running GIFP Quality Lab Best/Fast profiles...", flush=True)
    environment = os.environ.copy()
    environment["PATH"] = os.fspath(RUNTIME) + os.pathsep + environment.get("PATH", "")
    result = run(
        [
            QUALITY_LAB,
            "run",
            "--manifest",
            BENCH_MANIFEST,
            "--output",
            QUALITY_REPORT,
            "--fixtures",
            ",".join(fixtures),
        ],
        cwd=ROOT,
        env=environment,
        check=False,
    )
    if not QUALITY_REPORT.is_file():
        raise RuntimeError(f"Quality Lab exited {result.returncode} without a report")
    report = json.loads(QUALITY_REPORT.read_text(encoding="utf-8"))
    if report.get("failed_runs", 0):
        raise RuntimeError(
            f"Quality Lab produced {report['failed_runs']} failed runs; inspect {QUALITY_REPORT}"
        )
    return report


def scaled_even_height(target_width: int, source_width: int, source_height: int) -> int:
    scaled = round(target_width * source_height / source_width)
    scaled = max(2, scaled)
    return scaled if scaled % 2 == 0 else scaled + 1


def extract_frames(source: Path, destination: Path, fps: int, width: int) -> tuple[list[Path], int]:
    destination.mkdir(parents=True, exist_ok=True)
    pattern = destination / "frame-%05d.png"
    started = time.perf_counter()
    run(
        [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            source,
            "-vf",
            f"fps=fps={fps}:start_time=0,scale={width}:-1:flags=lanczos:force_original_aspect_ratio=decrease,format=rgba",
            pattern,
        ],
        capture=True,
    )
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    frames = sorted(destination.glob("frame-*.png"))
    if not frames:
        raise RuntimeError(f"FFmpeg extracted no frames from {source}")
    return frames, elapsed_ms


def symmetric_size_delta_percent(first: int, second: int) -> float:
    if first == 0 and second == 0:
        return 0.0
    return abs(first - second) / ((first + second) / 2.0) * 100.0


def run_gifski_candidate(
    frames: list[Path], destination: Path, fps: int, quality: int, mode: str = "default"
) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    started = time.perf_counter()
    mode_args = ["--extra"] if mode == "extra" else []
    run(
        [
            GIFSKI,
            "--quiet",
            "--no-sort",
            *mode_args,
            "--repeat",
            "0",
            "--fps",
            str(fps),
            "--quality",
            str(quality),
            "--output",
            destination,
            *frames,
        ],
        capture=True,
    )
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    return {
        "quality": quality,
        "mode": mode,
        "path": os.fspath(destination),
        "size_bytes": destination.stat().st_size,
        "encode_elapsed_ms": elapsed_ms,
    }


def choose_size_matched_gifski(
    frames: list[Path], candidate_dir: Path, fps: int, target_bytes: int
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    attempts: dict[tuple[int, str], dict[str, Any]] = {}

    def evaluate(quality: int, mode: str = "default") -> dict[str, Any]:
        quality = max(1, min(100, quality))
        key = (quality, mode)
        if key not in attempts:
            item = run_gifski_candidate(
                frames,
                candidate_dir / f"q{quality:03d}-{mode}.gif",
                fps,
                quality,
                mode,
            )
            item["size_delta_percent"] = symmetric_size_delta_percent(
                item["size_bytes"], target_bytes
            )
            attempts[key] = item
        return attempts[key]

    low, high = 1, 100
    while low <= high:
        middle = (low + high) // 2
        candidate = evaluate(middle)
        if candidate["size_bytes"] < target_bytes:
            low = middle + 1
        else:
            high = middle - 1

    for quality in {1, 100, 90, *range(max(1, low - 4), min(100, low + 4) + 1)}:
        evaluate(quality)

    closest_default = min(
        attempts.values(),
        key=lambda item: (item["size_delta_percent"], abs(item["size_bytes"] - target_bytes)),
    )
    for quality in {
        100,
        *range(max(1, closest_default["quality"] - 4), min(100, closest_default["quality"] + 4) + 1),
    }:
        evaluate(quality, "extra")

    ordered = sorted(attempts.values(), key=lambda item: (item["quality"], item["mode"]))
    selected = min(
        ordered,
        key=lambda item: (
            item["size_delta_percent"],
            abs(item["size_bytes"] - target_bytes),
            -item["quality"],
            item["mode"] != "extra",
        ),
    )
    return selected, ordered


def probe_media(path: Path) -> dict[str, Any]:
    result = run(
        [
            FFPROBE,
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,pix_fmt,nb_frames,nb_read_frames,duration:format=duration",
            "-of",
            "json",
            path,
        ],
        capture=True,
    )
    payload = json.loads(result.stdout.decode("utf-8"))
    stream = payload["streams"][0]
    duration = payload.get("format", {}).get("duration") or stream.get("duration") or 0
    frames = stream.get("nb_read_frames") or stream.get("nb_frames") or 0
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "duration_seconds": float(duration),
        "frame_count": int(frames),
        "pixel_format": stream.get("pix_fmt"),
    }


def animation_input_args(path: Path) -> list[str]:
    return ["-ignore_loop", "1"] if path.suffix.lower() == ".gif" else []


def percentile(values: list[float], quantile: float) -> float:
    finite = sorted(value for value in values if math.isfinite(value))
    if not finite:
        return 0.0
    index = math.floor((len(finite) - 1) * min(1.0, max(0.0, quantile)) + 0.5)
    return finite[index]


def pooled_metric(log: dict[str, Any], key: str, values: list[float], field: str) -> float | None:
    value = log.get("pooled_metrics", {}).get(key, {}).get(field)
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if not values:
        return None
    return min(values) if field == "min" else sum(values) / len(values)


def evaluate_vmaf(
    reference: Path, distorted: Path, duration: float, width: int, height: int, work_dir: Path
) -> dict[str, Any]:
    work_dir.mkdir(parents=True, exist_ok=True)
    log_path = work_dir / "objective-vmaf.json"
    if log_path.exists():
        log_path.unlink()
    graph = (
        f"[0:v]trim=duration={duration:.6f},fps={ANALYSIS_FPS}:round=near,"
        f"scale={width}:{height}:flags=bicubic,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[dist];"
        f"[1:v]trim=duration={duration:.6f},fps={ANALYSIS_FPS}:round=near,"
        f"scale={width}:{height}:flags=bicubic,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[ref];"
        "[dist][ref]libvmaf=log_fmt=json:log_path=objective-vmaf.json:"
        "model='version=vmaf_v0.6.1neg':"
        "feature='name=psnr|name=float_ssim|name=float_ms_ssim|name=ciede|name=cambi\\:full_ref=true':"
        "n_subsample=1:shortest=1"
    )
    run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            *animation_input_args(distorted),
            "-i",
            distorted,
            *animation_input_args(reference),
            "-i",
            reference,
            "-filter_complex",
            graph,
            "-an",
            "-f",
            "null",
            "NUL",
        ],
        cwd=work_dir,
        capture=True,
    )
    log = json.loads(log_path.read_text(encoding="utf-8"))

    def values(key: str) -> list[float]:
        result: list[float] = []
        for frame in log.get("frames", []):
            value = frame.get("metrics", {}).get(key)
            if isinstance(value, (int, float)) and math.isfinite(value):
                result.append(float(value))
        return result

    vmaf = values("vmaf")
    ssim = values("float_ssim")
    ms_ssim = values("float_ms_ssim")
    ciede = values("ciede2000")
    cambi = values("cambi")
    psnr = values("psnr_y")
    if not vmaf or not ssim or not cambi:
        raise RuntimeError(f"Incomplete libvmaf metrics in {log_path}")
    return {
        "analysis_fps": ANALYSIS_FPS,
        "compared_frames": len(log["frames"]),
        "vmaf_neg_mean": pooled_metric(log, "vmaf", vmaf, "mean"),
        "vmaf_neg_p05": percentile(vmaf, 0.05),
        "vmaf_neg_min": pooled_metric(log, "vmaf", vmaf, "min"),
        "psnr_y_mean_db": pooled_metric(log, "psnr_y", psnr, "mean"),
        "ssim_mean": pooled_metric(log, "float_ssim", ssim, "mean"),
        "ssim_min": pooled_metric(log, "float_ssim", ssim, "min"),
        "ms_ssim_mean": pooled_metric(log, "float_ms_ssim", ms_ssim, "mean"),
        "ms_ssim_min": pooled_metric(log, "float_ms_ssim", ms_ssim, "min"),
        "ciede2000_mean": pooled_metric(log, "ciede2000", ciede, "mean"),
        "ciede2000_p95": percentile(ciede, 0.95),
        "cambi_mean": pooled_metric(log, "cambi", cambi, "mean"),
        "cambi_p95": percentile(cambi, 0.95),
        "raw_vmaf_log_path": os.fspath(log_path),
    }


def decode_rgba(
    input_path: Path, width: int, height: int, duration: float
) -> np.ndarray:
    filter_graph = (
        f"trim=duration={duration:.6f},fps={ANALYSIS_FPS}:round=near,"
        f"scale={width}:{height}:flags=area,setsar=1,format=rgba"
    )
    result = run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            *animation_input_args(input_path),
            "-i",
            input_path,
            "-vf",
            filter_graph,
            "-an",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
        ],
        capture=True,
    )
    frame_bytes = width * height * 4
    if not result.stdout or len(result.stdout) % frame_bytes:
        raise RuntimeError(f"Misaligned RGBA decode for {input_path}")
    return np.frombuffer(result.stdout, dtype=np.uint8).reshape((-1, height, width, 4))


def composite_rgb(frames: np.ndarray) -> np.ndarray:
    background = np.array([246.0, 243.0, 235.0], dtype=np.float64)
    alpha = frames[..., 3:4].astype(np.float64) / 255.0
    mixed = frames[..., :3].astype(np.float64) * alpha + background * (1.0 - alpha)
    return np.clip(np.rint(mixed), 0, 255).astype(np.uint8)


def rgb_to_oklab(rgb: np.ndarray) -> np.ndarray:
    unit = rgb.astype(np.float64) / 255.0
    linear = np.where(unit <= 0.04045, unit / 12.92, ((unit + 0.055) / 1.055) ** 2.4)
    red, green, blue = np.moveaxis(linear, -1, 0)
    l_value = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue
    m_value = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue
    s_value = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue
    l_root, m_root, s_root = np.cbrt(l_value), np.cbrt(m_value), np.cbrt(s_value)
    return np.stack(
        [
            0.2104542553 * l_root + 0.7936177850 * m_root - 0.0040720468 * s_root,
            1.9779984951 * l_root - 2.4285922050 * m_root + 0.4505937099 * s_root,
            0.0259040371 * l_root + 0.7827717662 * m_root - 0.8086757660 * s_root,
        ],
        axis=-1,
    )


def sobel(luma: np.ndarray) -> np.ndarray:
    top_left = luma[:, :-2, :-2]
    top = luma[:, :-2, 1:-1]
    top_right = luma[:, :-2, 2:]
    left = luma[:, 1:-1, :-2]
    right = luma[:, 1:-1, 2:]
    bottom_left = luma[:, 2:, :-2]
    bottom = luma[:, 2:, 1:-1]
    bottom_right = luma[:, 2:, 2:]
    gx = -top_left + top_right - 2.0 * left + 2.0 * right - bottom_left + bottom_right
    gy = -top_left - 2.0 * top - top_right + bottom_left + 2.0 * bottom + bottom_right
    return np.hypot(gx, gy) / 4.0


def evaluate_raw_metrics(reference_frames: np.ndarray, distorted_frames: np.ndarray) -> dict[str, float]:
    if reference_frames.shape != distorted_frames.shape:
        raise RuntimeError(
            f"Raw metric timeline mismatch: {reference_frames.shape} vs {distorted_frames.shape}"
        )
    reference_rgb = composite_rgb(reference_frames)
    distorted_rgb = composite_rgb(distorted_frames)
    reference_lab = rgb_to_oklab(reference_rgb)
    distorted_lab = rgb_to_oklab(distorted_rgb)
    spatial = np.linalg.norm(reference_lab - distorted_lab, axis=-1)

    if len(reference_frames) > 1:
        reference_delta = np.linalg.norm(np.diff(reference_lab, axis=0), axis=-1)
        distorted_delta = np.linalg.norm(np.diff(distorted_lab, axis=0), axis=-1)
        static_mask = reference_delta <= STATIC_OKLAB_THRESHOLD
        static_error = spatial[1:][static_mask]
        static_temporal = np.abs(distorted_delta - reference_delta)[static_mask]
        static_ratio = float(static_mask.mean())
    else:
        static_error = np.array([], dtype=np.float64)
        static_temporal = np.array([], dtype=np.float64)
        static_ratio = 1.0

    reference_luma = (
        0.2126 * reference_rgb[..., 0]
        + 0.7152 * reference_rgb[..., 1]
        + 0.0722 * reference_rgb[..., 2]
    ) / 255.0
    distorted_luma = (
        0.2126 * distorted_rgb[..., 0]
        + 0.7152 * distorted_rgb[..., 1]
        + 0.0722 * distorted_rgb[..., 2]
    ) / 255.0
    reference_edge = sobel(reference_luma)
    distorted_edge = sobel(distorted_luma)
    edge_mask = reference_edge >= EDGE_THRESHOLD
    edge_error = np.minimum(
        np.abs(distorted_edge - reference_edge) / np.maximum(reference_edge, EDGE_THRESHOLD),
        1.0,
    )[edge_mask]

    reference_seam = np.linalg.norm(reference_lab[-1] - reference_lab[0], axis=-1).mean()
    distorted_seam = np.linalg.norm(distorted_lab[-1] - distorted_lab[0], axis=-1).mean()
    mean_or_zero = lambda values: float(values.mean()) if values.size else 0.0
    edge_error_mean = mean_or_zero(edge_error)
    return {
        "mean_oklab_error": float(spatial.mean()),
        "static_region_oklab_error": mean_or_zero(static_error),
        "static_region_temporal_residual": mean_or_zero(static_temporal),
        "static_pixel_ratio": static_ratio,
        "edge_error": edge_error_mean,
        "edge_preservation": 1.0 - edge_error_mean,
        "edge_pixel_ratio": float(edge_mask.mean()) if edge_mask.size else 0.0,
        "reference_loop_seam_oklab": float(reference_seam),
        "output_loop_seam_oklab": float(distorted_seam),
        "loop_seam_excess_oklab": float(max(0.0, distorted_seam - reference_seam)),
    }


def evaluate_alpha_metrics(
    reference: Path, distorted: Path, width: int, height: int, duration: float
) -> dict[str, float]:
    reference_frames = decode_rgba(reference, width, height, duration)
    distorted_frames = decode_rgba(distorted, width, height, duration)
    if reference_frames.shape != distorted_frames.shape:
        raise RuntimeError(
            f"Alpha timeline mismatch: {reference_frames.shape} vs {distorted_frames.shape}"
        )
    first = reference_frames[..., 3].astype(np.int16)
    second = distorted_frames[..., 3].astype(np.int16)
    return {
        "alpha_mean_absolute_error": float(np.abs(first - second).mean() / 255.0),
        "alpha_coverage_error": float(((first >= 128) != (second >= 128)).mean()),
    }


def evaluate_output(
    reference: Path,
    distorted: Path,
    duration: float,
    source_width: int,
    source_height: int,
    source_has_alpha: bool,
    work_dir: Path,
) -> dict[str, Any]:
    presentation_height = scaled_even_height(PRESENTATION_WIDTH, source_width, source_height)
    sample_height = scaled_even_height(ANALYSIS_WIDTH, source_width, source_height)
    metrics = evaluate_vmaf(
        reference,
        distorted,
        duration,
        PRESENTATION_WIDTH,
        presentation_height,
        work_dir,
    )
    reference_frames = decode_rgba(reference, ANALYSIS_WIDTH, sample_height, duration)
    distorted_frames = decode_rgba(distorted, ANALYSIS_WIDTH, sample_height, duration)
    metrics.update(evaluate_raw_metrics(reference_frames, distorted_frames))
    if source_has_alpha:
        metrics.update(
            evaluate_alpha_metrics(
                reference,
                distorted,
                PRESENTATION_WIDTH,
                presentation_height,
                duration,
            )
        )
    else:
        metrics.update({"alpha_mean_absolute_error": 0.0, "alpha_coverage_error": 0.0})
    metrics.update(
        {
            "presentation_width": PRESENTATION_WIDTH,
            "presentation_height": presentation_height,
            "sample_width": ANALYSIS_WIDTH,
            "sample_height": sample_height,
        }
    )
    return metrics


def quality_winner(vmaf_delta: float) -> str:
    if vmaf_delta >= 0.5:
        return "gifski"
    if vmaf_delta <= -0.5:
        return "GIFP"
    return "tie"


def benchmark(report: dict[str, Any], fixtures: list[str]) -> dict[str, Any]:
    source_by_id = {item["fixture_id"]: item for item in report["sources"]}
    best_by_id = {
        item["fixture_id"]: item
        for item in report["runs"]
        if item["profile_id"] == BEST_PROFILE_ID and item["status"] == "ok"
    }
    run_root = WORK / "comparison" / report["run_id"]
    rows: list[dict[str, Any]] = []

    for index, fixture_id in enumerate(fixtures, 1):
        print(f"[{index}/{len(fixtures)}] Size-matching {fixture_id}", flush=True)
        source = source_by_id[fixture_id]
        gifp_run = best_by_id[fixture_id]
        source_path = Path(source["path"])
        gifp_path = Path(gifp_run["result"]["output_path"])
        duration = float(source["inspection"]["duration"])
        frames, extraction_ms = extract_frames(
            source_path, run_root / "frames" / fixture_id, fps=12, width=320
        )
        selected, attempts = choose_size_matched_gifski(
            frames,
            run_root / "gifski-candidates" / fixture_id,
            fps=12,
            target_bytes=int(gifp_run["metrics"]["size_bytes"]),
        )
        gifski_path = Path(selected["path"])
        gifski_probe = probe_media(gifski_path)
        gifski_metrics = evaluate_output(
            source_path,
            gifski_path,
            duration,
            int(source["inspection"]["width"]),
            int(source["inspection"]["height"]),
            bool(source["inspection"]["has_alpha"]),
            run_root / "metrics" / fixture_id / "gifski",
        )
        quality_lab_metrics = gifp_run["metrics"]["objective"]
        adapter_metrics = evaluate_output(
            source_path,
            gifp_path,
            duration,
            int(source["inspection"]["width"]),
            int(source["inspection"]["height"]),
            bool(source["inspection"]["has_alpha"]),
            run_root / "metrics" / fixture_id / "gifp-adapter-check",
        )
        adapter_fields = [
            "vmaf_neg_mean",
            "vmaf_neg_p05",
            "ssim_mean",
            "ms_ssim_mean",
            "ciede2000_mean",
            "cambi_mean",
            "mean_oklab_error",
            "static_region_temporal_residual",
            "edge_preservation",
            "alpha_coverage_error",
            "loop_seam_excess_oklab",
        ]
        adapter_deltas = {
            field: float(adapter_metrics[field] - quality_lab_metrics[field])
            for field in adapter_fields
            if adapter_metrics.get(field) is not None
            and quality_lab_metrics.get(field) is not None
        }
        # Use one independent adapter for both contestants. The embedded Quality Lab
        # currently caps portrait metric canvases to a square; keeping its values only
        # as audit evidence prevents that implementation detail from biasing the PK.
        gifp_metrics = adapter_metrics
        vmaf_delta = gifski_metrics["vmaf_neg_mean"] - gifp_metrics["vmaf_neg_mean"]
        row = {
            "fixture_id": fixture_id,
            "category": source["category"],
            "tags": source["tags"],
            "source_path": os.fspath(source_path),
            "source_sha256": source["sha256"],
            "duration_seconds": duration,
            "source_frame_count": int(source["inspection"]["frame_count"]),
            "gifp_path": os.fspath(gifp_path),
            "gifp_size_bytes": int(gifp_run["metrics"]["size_bytes"]),
            "gifp_encode_ms": int(gifp_run["metrics"]["encode_wall_elapsed_ms"]),
            "gifp_frame_count": int(gifp_run["metrics"]["frame_count"]),
            "gifp_metrics": gifp_metrics,
            "gifski_path": os.fspath(gifski_path),
            "gifski_quality": int(selected["quality"]),
            "gifski_mode": selected["mode"],
            "gifski_size_bytes": int(selected["size_bytes"]),
            "gifski_size_delta_percent": float(selected["size_delta_percent"]),
            "gifski_encode_ms": int(selected["encode_elapsed_ms"]),
            "gifski_extract_ms": extraction_ms,
            "gifski_end_to_end_ms": extraction_ms + int(selected["encode_elapsed_ms"]),
            "gifski_frame_count": gifski_probe["frame_count"],
            "gifski_duration_seconds": gifski_probe["duration_seconds"],
            "gifski_metrics": gifski_metrics,
            "gifp_quality_lab_metrics": quality_lab_metrics,
            "metric_adapter_deltas": adapter_deltas,
            "vmaf_delta_gifski_minus_gifp": float(vmaf_delta),
            "ssim_delta_gifski_minus_gifp": float(
                gifski_metrics["ssim_mean"] - gifp_metrics["ssim_mean"]
            ),
            "oklab_error_delta_gifski_minus_gifp": float(
                gifski_metrics["mean_oklab_error"] - gifp_metrics["mean_oklab_error"]
            ),
            "static_temporal_delta_gifski_minus_gifp": float(
                gifski_metrics["static_region_temporal_residual"]
                - gifp_metrics["static_region_temporal_residual"]
            ),
            "edge_preservation_delta_gifski_minus_gifp": float(
                gifski_metrics["edge_preservation"] - gifp_metrics["edge_preservation"]
            ),
            "alpha_coverage_delta_gifski_minus_gifp": float(
                gifski_metrics["alpha_coverage_error"] - gifp_metrics["alpha_coverage_error"]
            ),
            "quality_winner": quality_winner(vmaf_delta),
            "gifski_attempts": attempts,
        }
        rows.append(row)

    vmaf_deltas = [row["vmaf_delta_gifski_minus_gifp"] for row in rows]
    reliable_vmaf_rows = [
        row
        for row in rows
        if min(row["gifp_metrics"]["vmaf_neg_mean"], row["gifski_metrics"]["vmaf_neg_mean"])
        >= 20.0
    ]
    near_size_rows = [row for row in rows if row["gifski_size_delta_percent"] <= 5.0]
    eligible_rows = [
        row
        for row in reliable_vmaf_rows
        if row["gifski_size_delta_percent"] <= 5.0
    ]
    winners = {name: sum(row["quality_winner"] == name for row in rows) for name in ["GIFP", "tie", "gifski"]}
    aggregate = {
        "fixture_count": len(rows),
        "vmaf_wins": winners,
        "mean_vmaf_delta_gifski_minus_gifp": float(np.mean(vmaf_deltas)),
        "median_vmaf_delta_gifski_minus_gifp": float(np.median(vmaf_deltas)),
        "reliable_vmaf_comparison_count": len(reliable_vmaf_rows),
        "reliable_vmaf_wins": {
            name: sum(row["quality_winner"] == name for row in reliable_vmaf_rows)
            for name in ["GIFP", "tie", "gifski"]
        },
        "eligible_comparison_count": len(eligible_rows),
        "eligible_vmaf_wins": {
            name: sum(row["quality_winner"] == name for row in eligible_rows)
            for name in ["GIFP", "tie", "gifski"]
        },
        "near_size_comparison_count": len(near_size_rows),
        "mean_absolute_size_delta_percent": float(
            np.mean([row["gifski_size_delta_percent"] for row in rows])
        ),
        "within_5_percent_size_count": sum(
            row["gifski_size_delta_percent"] <= 5.0 for row in rows
        ),
        "gifp_total_encode_ms": sum(row["gifp_encode_ms"] for row in rows),
        "gifski_total_core_encode_ms": sum(row["gifski_encode_ms"] for row in rows),
        "gifski_total_end_to_end_ms": sum(row["gifski_end_to_end_ms"] for row in rows),
        "median_end_to_end_speed_ratio_gifski_over_gifp": float(
            np.median(
                [
                    row["gifski_end_to_end_ms"] / max(1, row["gifp_encode_ms"])
                    for row in rows
                ]
            )
        ),
        "metric_adapter_max_absolute_delta": {
            field: max(abs(row["metric_adapter_deltas"].get(field, 0.0)) for row in rows)
            for field in rows[0]["metric_adapter_deltas"]
        },
    }
    return {
        "schema_version": 1,
        "generated_at_unix_ms": int(time.time() * 1000),
        "scope": {
            "product_version": PRODUCT_VERSION,
            "gifp_profile": BEST_PROFILE_ID,
            "gifski_version": tool_version(GIFSKI),
            "ffmpeg_version": tool_version(FFMPEG),
            "ffmpeg_sha256": sha256_file(FFMPEG),
            "ffprobe_sha256": sha256_file(FFPROBE),
            "width": 320,
            "fps": 12,
            "size_match": "closest tested gifski -Q by symmetric byte delta",
            "vmaf_model": "vmaf_v0.6.1neg",
            "fixture_ids": fixtures,
            "quality_lab_run_id": report["run_id"],
            "quality_lab_git_commit": report.get("git_commit"),
            "quality_lab_git_dirty": report.get("git_dirty"),
            "arena_corpus_id": report["manifest"]["corpus_id"],
            "arena_manifest_sha256": report["manifest_sha256"],
            "limitations": [
                "Ten deterministic Arena 10 fixtures are a development leaderboard, not the formal 28-fixture gate or a licensed real-media corpus.",
                "gifski receives a predecoded 12 FPS / 320 px Lanczos RGBA PNG timeline; end-to-end timing adds that extraction once.",
                "gifski quality search is offline tuning cost and is excluded from single-encode speed.",
                "The Arena 10 source manifest, generator toolchain, and every lossless source are content-addressed.",
                "The current Quality Lab run comes from a dirty working tree and is an engineering result, not clean-release evidence.",
            ],
        },
        "aggregate": aggregate,
        "rows": rows,
    }


def write_outputs(payload: dict[str, Any]) -> None:
    RESULT_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    fieldnames = [
        "fixture_id",
        "category",
        "quality_winner",
        "gifp_size_bytes",
        "gifski_size_bytes",
        "gifski_size_delta_percent",
        "gifp_encode_ms",
        "gifski_encode_ms",
        "gifski_extract_ms",
        "gifski_end_to_end_ms",
        "gifp_frame_count",
        "gifski_frame_count",
        "gifski_quality",
        "gifski_mode",
        "vmaf_delta_gifski_minus_gifp",
        "ssim_delta_gifski_minus_gifp",
        "oklab_error_delta_gifski_minus_gifp",
        "static_temporal_delta_gifski_minus_gifp",
        "edge_preservation_delta_gifski_minus_gifp",
        "alpha_coverage_delta_gifski_minus_gifp",
    ]
    with RESULT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(payload["rows"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", default=",".join(DEFAULT_FIXTURES))
    parser.add_argument("--reuse-quality-lab", action="store_true")
    args = parser.parse_args()
    fixtures = [value.strip() for value in args.fixtures.split(",") if value.strip()]
    if not fixtures:
        parser.error("--fixtures must contain at least one id")

    for path, label in [
        (FFMPEG, "FFmpeg"),
        (FFPROBE, "FFprobe"),
        (QUALITY_LAB, "GIFP Quality Lab"),
        (GIFSKI, "gifski"),
        (SOURCE_MANIFEST, "source corpus manifest"),
        (RUNTIME_MANIFEST, "reviewed runtime manifest"),
    ]:
        checked_binary(path, label)

    report = run_quality_lab(fixtures, args.reuse_quality_lab)
    payload = benchmark(report, fixtures)
    write_outputs(payload)
    print(json.dumps(payload["aggregate"], ensure_ascii=False, indent=2), flush=True)
    print(f"Results: {RESULT_JSON}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
