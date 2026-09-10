"""External lossless Gifsicle pilot. Originals are never modified or replaced."""
from pathlib import Path
from statistics import median
import argparse
import hashlib
import json
import subprocess
import tempfile
import time
from PIL import Image

MAX_PIXELS = 2_000_000
MAX_DECODE_BYTES = 256 * 1024 * 1024


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def visible_hash(rgba):
    pixels = bytearray(rgba)
    alpha = pixels[3::4]
    if 0 in alpha:
        for index, value in enumerate(alpha):
            if value == 0:
                pixels[index*4:index*4+3] = b"\0\0\0"
    return hashlib.sha256(pixels).hexdigest()


def timed_frames(hashes, delays):
    # Short delays are clamped differently by viewers. Preserve exact frame
    # structure in that case instead of treating merges as equivalent.
    if any(delay < 2 for delay in delays):
        return list(zip(hashes, delays))
    merged = []
    for digest, delay in zip(hashes, delays):
        if merged and merged[-1][0] == digest:
            merged[-1] = (digest, merged[-1][1] + delay)
        else:
            merged.append((digest, delay))
    return merged


def pillow_contract(path):
    with Image.open(path) as source:
        if source.format != "GIF":
            raise ValueError("Expected a GIF input")
        width, height = source.size
        count = source.n_frames
        loop = source.info.get("loop")
        cycles = 1 if loop is None else 2
        if width * height > MAX_PIXELS or width * height * 4 * count * cycles > MAX_DECODE_BYTES:
            raise ValueError("Fixture exceeds the pilot decode budget")
        hashes, delays = [], []
        for index in range(count):
            source.seek(index)
            duration = source.info.get("duration", 0)
            if duration < 0 or duration % 10:
                raise ValueError("Invalid GIF centisecond delay")
            delays.append(duration // 10)
            hashes.append(visible_hash(source.convert("RGBA").tobytes()))
        return {"width": width, "height": height, "frames": count, "loop": loop,
            "delays_cs": delays, "timeline": timed_frames(hashes, delays)}


def ffmpeg_contract(ffmpeg, path, metadata):
    cycles = 1 if metadata["loop"] is None else 2
    count = metadata["frames"] * cycles
    frame_bytes = metadata["width"] * metadata["height"] * 4
    with tempfile.TemporaryFile() as pixels, tempfile.TemporaryFile() as errors:
        result = subprocess.run([str(ffmpeg), "-v", "error", "-ignore_loop", "0", "-i", str(path),
            "-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v", str(count),
            "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], stdout=pixels, stderr=errors, timeout=60)
        if result.returncode:
            errors.seek(0)
            raise ValueError(errors.read(3000).decode("utf-8", errors="replace"))
        # FFmpeg interprets a finite loop count of one as a single play on
        # some releases. Keep that actual observed cycle count in the check.
        if metadata["loop"] == 1 and pixels.tell() == frame_bytes * metadata["frames"]:
            cycles = 1
            count = metadata["frames"]
        if pixels.tell() != frame_bytes * count:
            raise ValueError("FFmpeg frame count disagrees with the GIF container")
        pixels.seek(0)
        hashes = [visible_hash(pixels.read(frame_bytes)) for _ in range(count)]
    return {"cycles": cycles, "timeline": timed_frames(hashes, metadata["delays_cs"] * cycles)}


def same_metadata_and_pillow(source, candidate):
    return all(source[key] == candidate[key] for key in ["width", "height", "loop", "timeline"])


def inspect_pair(ffmpeg, source_path, candidate_path):
    source = pillow_contract(source_path)
    candidate = pillow_contract(candidate_path)
    pillow_equal = same_metadata_and_pillow(source, candidate)
    ffmpeg_equal = False
    if all(source[k] == candidate[k] for k in ["width", "height", "loop"]):
        ffmpeg_equal = ffmpeg_contract(ffmpeg, source_path, source) == ffmpeg_contract(ffmpeg, candidate_path, candidate)
    return {"pillow_equal": pillow_equal, "ffmpeg_equal": ffmpeg_equal,
        "verified_equal": pillow_equal and ffmpeg_equal,
        "source_frames": source["frames"], "candidate_frames": candidate["frames"],
        "loop": source["loop"], "duration_cs": sum(source["delays_cs"])}


def run_pilot(manifest_path, gifsicle, ffmpeg, output):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    # A fresh directory guarantees that none of the source files is overwritten.
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    for index, item in enumerate(manifest["inputs"]):
        source = Path(item["path"]).resolve()
        source_hash = sha(source)
        pillow_contract(source)
        elapsed, candidates, hashes = [], [], []
        tool_errors = []
        for repetition in range(3):
            candidate = output / f"{index:03d}-{repetition}.gif"
            started = time.perf_counter_ns()
            result = subprocess.run([str(gifsicle), "-O3", "--no-ignore-errors", "--output", str(candidate), str(source)],
                capture_output=True, timeout=60)
            elapsed.append((time.perf_counter_ns() - started) / 1e6)
            if result.returncode != 0:
                tool_errors.append(result.stderr.decode("utf-8", errors="replace")[:3000])
                break
            candidates.append(candidate)
            hashes.append(sha(candidate))
        verification = None
        verification_ms = 0
        error = None
        if not tool_errors and len(set(hashes)) == 1:
            started = time.perf_counter_ns()
            try:
                verification = inspect_pair(ffmpeg, source, candidates[0])
            except (ValueError, OSError, subprocess.TimeoutExpired) as failure:
                error = str(failure)
            verification_ms = (time.perf_counter_ns() - started) / 1e6
        else:
            error = "Tool failure or non-deterministic candidate"
        if sha(source) != source_hash:
            raise ValueError("Source changed during the experiment")
        size = source.stat().st_size
        candidate_size = candidates[0].stat().st_size if candidates else None
        eligible = bool(verification and verification["verified_equal"] and candidate_size < size)
        row = {**item, "source_sha256": source_hash, "source_bytes": size,
            "candidate_path": str(candidates[0]) if candidates else None,
            "candidate_sha256": hashes[0] if hashes else None, "candidate_bytes": candidate_size,
            "saving_percent": (1-candidate_size/size)*100 if candidate_size is not None else None,
            "optimizer_ms": elapsed, "optimizer_median_ms": median(elapsed), "verification_ms": verification_ms,
            "verification": verification, "error": error, "tool_errors": tool_errors,
            "eligible": eligible, "selected_path": str(candidates[0]) if eligible else str(source)}
        rows.append(row)
        print(f"{item['id']}: {size} -> {candidate_size}, eligible={eligible}", flush=True)
        (output / "report.json").write_text(json.dumps({"status":"in_progress","rows":rows},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    report = {"status":"completed", "scope":"incremental -O3 on existing verified GIFP artifacts; no original replacements",
        "manifest_sha256":sha(manifest_path),"tool_sha256":sha(gifsicle),"ffmpeg_sha256":sha(ffmpeg),
        "tool_version":subprocess.check_output([str(gifsicle),"--version"],text=True).splitlines()[0], "rows":rows}
    (output / "report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    return report


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--manifest",type=Path,required=True)
    parser.add_argument("--gifsicle",type=Path,required=True)
    parser.add_argument("--ffmpeg",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    run_pilot(args.manifest,args.gifsicle.resolve(),args.ffmpeg.resolve(),args.output.resolve())
