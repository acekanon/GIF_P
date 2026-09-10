"""Run all three GIF experiments and independently verify every candidate.

Requires NumPy and Pillow. A fresh run directory preserves all earlier results.
No product defaults, user inputs, or acceptance thresholds are rewritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import numpy as np
from PIL import GifImagePlugin, Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
FFMPEG = ROOT / "release/GIFP-5.7.27/ffmpeg.exe"
LAB = ROOT / "src-tauri/target/release/gifp_compression_research.exe"
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def run(args, timeout=600):
    result = subprocess.run([str(x) for x in args], capture_output=True, timeout=timeout, creationflags=FLAGS)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-5000:])
    return result.stdout


def inspect(path):
    with Image.open(path) as image:
        delays = []
        for n in range(image.n_frames):
            image.seek(n)
            delays.append(image.info.get("duration", 0))
        return {"width": image.width, "height": image.height, "delays_ms": delays,
                "loop": image.info.get("loop"), "duration_ms": sum(delays)}


def decode(path, destination, metadata):
    cycles = 2 if metadata["loop"] == 0 else 1
    frames = len(metadata["delays_ms"]) * cycles
    run([FFMPEG, "-y", "-v", "error", "-threads", "2", "-ignore_loop", "0", "-i", path,
         "-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v", frames,
         "-pix_fmt", "rgba", "-f", "rawvideo", destination])
    expected = frames * metadata["width"] * metadata["height"] * 4
    if destination.stat().st_size != expected:
        raise ValueError("FFmpeg decoded frame count differs from GIF timeline")
    return np.memmap(destination, dtype=np.uint8, mode="r", shape=(frames, metadata["height"], metadata["width"], 4))


def same_visible(a, b):
    return np.array_equal(a[..., 3], b[..., 3]) and np.array_equal(a[..., :3][a[..., 3] > 0], b[..., :3][a[..., 3] > 0])


def decoder_consensus(path, frames, metadata):
    with Image.open(path) as image:
        for n in range(image.n_frames):
            image.seek(n)
            if not same_visible(np.asarray(image.convert("RGBA")), frames[n]):
                return False
    count = len(metadata["delays_ms"])
    return len(frames) == count or all(same_visible(frames[n], frames[n + count]) for n in range(count))


def strong_edges(frame):
    rgb = frame[..., :3].astype(np.int16)
    mask = np.zeros(frame.shape[:2], dtype=bool)
    dx = np.max(np.abs(rgb[:, 1:] - rgb[:, :-1]), axis=-1) > 24
    dy = np.max(np.abs(rgb[1:] - rgb[:-1]), axis=-1) > 24
    dx |= frame[:, 1:, 3] != frame[:, :-1, 3]
    dy |= frame[1:, :, 3] != frame[:-1, :, 3]
    mask[:, 1:] |= dx
    mask[:, :-1] |= dx
    mask[1:] |= dy
    mask[:-1] |= dy
    return mask & (frame[..., 3] > 0)


def pixel_checks(original, candidate, count):
    maximum = 0
    worst_rmse = 0.0
    alpha = True
    edges = True
    for n in range(count):
        a, b = original[n], candidate[n]
        alpha &= np.array_equal(a[..., 3], b[..., 3])
        visible = a[..., 3] > 0
        delta = a[..., :3].astype(np.int16) - b[..., :3].astype(np.int16)
        if visible.any():
            maximum = max(maximum, int(np.abs(delta[visible]).max()))
            worst_rmse = max(worst_rmse, float(np.sqrt(np.mean(delta[visible].astype(np.float64) ** 2))))
        edges &= not np.any(delta[strong_edges(a)])
    return {"alpha_exact": bool(alpha), "strong_edges_exact": bool(edges), "max_channel_error": maximum,
            "worst_frame_rmse": worst_rmse}


def source_mse(source, decoded, metadata, fps):
    ends = np.cumsum(metadata["delays_ms"]) / 1000.0
    values = []
    # Score every original source sample, including samples inside a merged GIF hold.
    for n in range(len(source)):
        index = int(np.searchsorted(ends, (n + 0.5) / fps, side="right"))
        index = min(index, len(ends) - 1)
        error = source[n].astype(np.float64) - decoded[index, ..., :3].astype(np.float64)
        values.append(float(np.mean(error ** 2)))
    return {"mean": float(np.mean(values)), "worst_frame": max(values), "samples": len(values)}


def targeted_fixtures(work):
    """Deterministic mechanism / regression checks, not real-world claims."""
    folder = work / "fixtures"
    folder.mkdir()
    fixtures = []
    specs = [("palette-switch", "discovery"), ("dither-static", "discovery"),
             ("index-noise", "discovery"), ("alpha-sprite", "regression"), ("text-motion", "regression")]
    palette = np.repeat(np.arange(256, dtype=np.uint8)[:, None], 3, axis=1)
    # Keep the initial image in indexed color mode. Pillow's grayscale fast
    # path does not consistently apply later non-identity local palettes.
    palette[0] = [0, 1, 0]
    for ident, split in specs:
        width, height, count = 160, 96, 12
        frames, references = [], []
        rng = np.random.default_rng(271828 if split == "discovery" else 314159)
        for n in range(count):
            table = palette.copy()
            indices = np.full((height, width), 100, dtype=np.uint8)
            reference = np.full((height, width, 3), 100, dtype=np.uint8)
            if ident == "palette-switch":
                if n % 2:
                    table[[100, 101]] = table[[101, 100]]
                    indices.fill(101)
                    table[180] = [180, 150 + n, 180]
                indices[30:44, 8 + n * 9:22 + n * 9] = 180
                reference = table[indices]
            elif ident == "dither-static":
                indices = rng.choice(np.array([99, 101], dtype=np.uint8), size=(height, width))
            elif ident == "index-noise":
                indices = rng.integers(100, 103, (height, width), dtype=np.uint8)
                reference = table[indices]
            elif ident == "alpha-sprite":
                indices.fill(255)
                indices[30:48, 7 + n * 9:25 + n * 9] = 150
                reference = table[indices]
            else:
                image = Image.fromarray(indices)
                draw = ImageDraw.Draw(image)
                draw.text((8 + n * 3, 20), "GIFP 2026 / A1B2", fill=230)
                draw.rectangle((20, 60, 20 + n * 8, 74), fill=40)
                indices = np.asarray(image)
                reference = table[indices]
            frame = Image.fromarray(indices).convert("P")
            # Construct indexed images without a second quantization pass.
            frame.putdata(indices.ravel())
            frame.putpalette(table.ravel().tolist())
            frames.append(frame)
            references.append(reference)
        path = folder / f"{ident}.gif"
        options = {"save_all": True, "append_images": frames[1:], "duration": [80, 90, 80] * 4,
                   "loop": 0, "optimize": False, "disposal": 2 if ident == "alpha-sprite" else 1, "include_color_table": True}
        if ident == "alpha-sprite":
            options["transparency"] = 255
        # Emit complete frames explicitly. Pillow's animation saver can combine
        # delta cropping and local palette changes into a decoder-dependent
        # baseline; the experiment must start from an unambiguous display.
        header, _ = GifImagePlugin.getheader(frames[0], info={"loop": 0, "optimize": False})
        with path.open("wb") as stream:
            stream.write(b"".join(header))
            for n, frame in enumerate(frames):
                params = {"duration": options["duration"][n], "disposal": options["disposal"], "include_color_table": True}
                if "transparency" in options:
                    params["transparency"] = options["transparency"]
                stream.write(b"".join(GifImagePlugin.getdata(frame, **params)))
            stream.write(b";")
        ref = folder / f"{ident}.rgb"
        np.stack(references).tofile(ref)
        fixtures.append({"id": ident, "split": split, "input": str(path), "raw_source": str(ref), "fps": 12,
                         "source_frames": count, "transparent": ident == "alpha-sprite"})
    return fixtures


def previous_fixtures(names):
    rows = json.loads((ROOT / "audits/2026-09-09-gif-boundary/results.json").read_text(encoding="utf-8"))
    return [{"id": row["source"], "split": "validation", "input": row["path"],
             "source": str(ROOT / f"audits/2026-09-09-gif-boundary/sources/{row['source']}.mkv"), "fps": 12}
            for row in rows if row["method"] == "gifp-best-current" and row["source"] in names]


def study(item, work, executable):
    case = work / item["id"]
    case.mkdir()
    original = Path(item["input"])
    metadata = inspect(original)
    baseline_raw = case / "baseline.rgba"
    baseline = decode(original, baseline_raw, metadata)
    if not decoder_consensus(original, baseline, metadata):
        raise ValueError("baseline FFmpeg/Pillow decoder disagreement")
    count = len(metadata["delays_ms"])
    source = None
    reference = None
    if not item.get("transparent"):
        source_raw = case / "source.rgb"
        if "raw_source" in item:
            shutil.copyfile(item["raw_source"], source_raw)
        else:
            run([FFMPEG, "-y", "-v", "error", "-threads", "2", "-i", item["source"], "-vf", f"fps={item['fps']}",
                 "-pix_fmt", "rgb24", "-f", "rawvideo", source_raw])
        frame_bytes = metadata["height"] * metadata["width"] * 3
        if source_raw.stat().st_size % frame_bytes:
            raise ValueError("source dimensions differ from the fixed GIF canvas")
        source = np.memmap(source_raw, dtype=np.uint8, mode="r",
                           shape=(source_raw.stat().st_size // frame_bytes, metadata["height"], metadata["width"], 3))
        if abs(len(source) / item["fps"] * 1000 - metadata["duration_ms"]) > 20:
            raise ValueError("source/GIF duration mismatch")
        reference = case / "reference.rgb"
        starts = np.r_[0, np.cumsum(metadata["delays_ms"])[:-1]]
        with reference.open("wb") as stream:
            for start, delay in zip(starts, metadata["delays_ms"]):
                index = min(len(source) - 1, int((start + delay / 2) * item["fps"] / 1000))
                stream.write(source[index].tobytes())
    job = {"input": str(original), "reference_rgb": str(reference) if reference else None,
           "output_dir": str(case / "candidates"), "max_probes_per_candidate": 3000}
    save(case / "job.json", job)
    started = time.perf_counter()
    log = run([executable, "--job", case / "job.json"], timeout=900)
    (case / "run.log").write_bytes(log)
    print(log.decode("utf-8", "replace"), flush=True)
    report = json.loads((case / "candidates/report.json").read_text(encoding="utf-8"))
    baseline_mse = source_mse(source, baseline, metadata, item["fps"]) if source is not None else None
    checks = []
    selected = original
    selected_bytes = original.stat().st_size
    selected_id = "input"
    for candidate in report["candidates"]:
        check = {"id": candidate["id"], "direction": candidate["direction"], "accepted": False,
                 "reasons": list(candidate["reasons"]), "internal_gate_passed": candidate["internal_gate_passed"],
                 "bytes": candidate["bytes"], "saved_percent": candidate["saved_percent_vs_input"]}
        if not candidate["file"]:
            checks.append(check)
            continue
        path = case / "candidates" / candidate["file"]
        if sha(path) != candidate["sha256"] or inspect(path) != metadata:
            check["reasons"].append("artifact identity or timeline mismatch")
            checks.append(check)
            continue
        raw = case / "candidate.rgba"
        decoded = decode(path, raw, metadata)
        check["decoder_consensus"] = decoder_consensus(path, decoded, metadata)
        pixels = pixel_checks(baseline, decoded, count)
        check["pixel_checks"] = pixels
        if not check["decoder_consensus"]:
            check["reasons"].append("FFmpeg/Pillow or second-cycle mismatch")
        if not pixels["alpha_exact"] or not pixels["strong_edges_exact"]:
            check["reasons"].append("independent alpha/edge mismatch")
        limit = 0 if candidate["direction"] in ("structure", "serialization") else 4
        if pixels["max_channel_error"] > limit or pixels["worst_frame_rmse"] > 3:
            check["reasons"].append("independent pixel envelope exceeded")
        if source is not None:
            mse = source_mse(source, decoded, metadata, item["fps"])
            check["source_mse"] = mse
            if mse["mean"] > baseline_mse["mean"] * 1.03 + 0.03:
                check["reasons"].append("full-resolution source MSE regression")
            if mse["worst_frame"] > baseline_mse["worst_frame"] * 1.03 + 0.03:
                check["reasons"].append("worst-frame source MSE regression")
        check["accepted"] = candidate["internal_gate_passed"] and not check["reasons"]
        if check["accepted"] and candidate["bytes"] < selected_bytes:
            selected, selected_bytes, selected_id = path, candidate["bytes"], candidate["id"]
        del decoded
        raw.unlink()
        checks.append(check)
    shutil.copyfile(selected, case / "selected.gif")
    # Paired original-size stills are inspection aids, not substitutes for playback.
    chosen = decode(selected, case / "selected.rgba", metadata)
    n = count // 2
    canvas = Image.new("RGB", (metadata["width"] * 2, metadata["height"]), "#e8e8e8")
    for column, pixels in enumerate((np.array(baseline[n]), np.array(chosen[n]))):
        layer = Image.fromarray(pixels)
        canvas.paste(layer, (column * metadata["width"], 0), layer)
    canvas.save(case / "comparison.png")
    del chosen
    (case / "selected.rgba").unlink()
    del baseline
    baseline_raw.unlink()
    if source is not None:
        del source
        source_raw.unlink()
    result = {"id": item["id"], "split": item["split"], "input": str(original), "input_sha256": sha(original),
              "baseline_bytes": original.stat().st_size, "selected_id": selected_id, "selected_bytes": selected_bytes,
              "saved_percent": (1 - selected_bytes / original.stat().st_size) * 100,
              "baseline_source_mse": baseline_mse, "seconds": round(time.perf_counter() - started, 3), "checks": checks}
    source_path = item.get("source", item.get("raw_source"))
    if source_path:
        result["source_sha256"] = sha(source_path)
    save(case / "verification.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sources", nargs="*", default=["local-ui", "smooth-gradient", "moving-pattern", "noisy-motion"])
    parser.add_argument("--skip-targeted", action="store_true")
    args = parser.parse_args()
    work = args.output.resolve()
    work.mkdir(parents=True, exist_ok=False)
    code_files = [ROOT / "src-tauri/src/compression_research.rs", ROOT / "src-tauri/src/core/compression_search.rs",
                  ROOT / "src-tauri/src/core/indexed_gif.rs", ROOT / "src-tauri/src/core/regional_quantize.rs",
                  ROOT / "src-tauri/Cargo.lock", Path(__file__)]
    save(work / "toolchain.json", {str(path): sha(path) for path in [LAB, FFMPEG, *code_files]})
    snapshot = work / "source-snapshot"
    snapshot.mkdir()
    for path in code_files:
        shutil.copyfile(path, snapshot / path.name)
    executable = work / "gifp_compression_research.exe"
    shutil.copyfile(LAB, executable)
    save(work / "python-runtime.json", {"executable": sys.executable, "python": sys.version,
                                       "numpy": np.__version__, "pillow": Image.__version__})
    items = ([] if args.skip_targeted else targeted_fixtures(work)) + previous_fixtures(args.sources)
    save(work / "manifest.json", items)
    results = []
    for item in items:
        print("Testing", item["id"], flush=True)
        try:
            results.append(study(item, work, executable))
        except Exception as error:
            results.append({"id": item["id"], "error": str(error)})
            print("FAILED", item["id"], str(error), flush=True)
        save(work / "results.json", results)
    for result in results:
        print(result["id"], result.get("selected_id", "failed"), result.get("saved_percent"), flush=True)
    if any("error" in result for result in results):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
