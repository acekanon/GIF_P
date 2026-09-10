#!/usr/bin/env python3
"""Build the GIFP v2 mascot scene animation pack.

The packager removes the authored blue/magenta mattes, normalizes every pose
onto a 360 x 360 transparent canvas with a shared bottom-centre anchor, builds
horizontal PNG strips and looping GIF previews, and writes machine-readable
manifest and QA reports.

The preferred working/loading sources are the smaller v2 scene images.  The
older 3 x 2 working sheet remains a deterministic fallback so the pipeline can
still be reproduced while replacement art is being prepared.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import statistics
from collections import deque
from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RAW_DIR = REPO_ROOT / "tmp" / "gifp-main-v2-scenes" / "raw"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "public" / "characters" / "gifp-main" / "v2"
DEFAULT_REPORT = REPO_ROOT / ".qa" / "gifp-main-v2-asset-report.json"

FRAME_WIDTH = 360
FRAME_HEIGHT = 360
ANCHOR_X = 180
ANCHOR_Y = 348
ALPHA_THRESHOLD = 8
SEAM_LIMIT = 1.15

MOTION_ORDER = ("idle", "loading", "working", "complete", "error")
SYNTHETIC_SEQUENCE = (0, 1, 2, 3, 2, 1, 0, 1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--seam-limit", type=float, default=SEAM_LIMIT)
    return parser.parse_args()


def repo_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def smoothstep(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, 0.0, 1.0)
    return clipped * clipped * (3.0 - 2.0 * clipped)


def border_key(rgb: np.ndarray, border: int = 10) -> np.ndarray:
    samples = np.concatenate(
        (
            rgb[:border].reshape(-1, 3),
            rgb[-border:].reshape(-1, 3),
            rgb[:, :border].reshape(-1, 3),
            rgb[:, -border:].reshape(-1, 3),
        )
    )
    return np.median(samples.astype(np.float32), axis=0)


def border_connected(candidate: np.ndarray) -> np.ndarray:
    """Return the 4-connected candidate region reachable from the canvas edge."""

    height, width = candidate.shape
    connected = np.zeros_like(candidate, dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if candidate[y, x] and not connected[y, x]:
            connected[y, x] = True
            queue.append((y, x))

    for x in range(width):
        seed(0, x)
        seed(height - 1, x)
    for y in range(1, height - 1):
        seed(y, 0)
        seed(y, width - 1)

    while queue:
        y, x = queue.popleft()
        if y and candidate[y - 1, x] and not connected[y - 1, x]:
            connected[y - 1, x] = True
            queue.append((y - 1, x))
        if y + 1 < height and candidate[y + 1, x] and not connected[y + 1, x]:
            connected[y + 1, x] = True
            queue.append((y + 1, x))
        if x and candidate[y, x - 1] and not connected[y, x - 1]:
            connected[y, x - 1] = True
            queue.append((y, x - 1))
        if x + 1 < width and candidate[y, x + 1] and not connected[y, x + 1]:
            connected[y, x + 1] = True
            queue.append((y, x + 1))

    return connected


def decontaminate(rgb: np.ndarray, alpha: np.ndarray, key: np.ndarray) -> np.ndarray:
    """Remove matte colour from semi-transparent edge pixels."""

    opacity = alpha[..., None].astype(np.float32) / 255.0
    safe_opacity = np.maximum(opacity, 0.035)
    foreground = (rgb.astype(np.float32) - (1.0 - opacity) * key) / safe_opacity
    foreground = np.clip(foreground, 0, 255)
    foreground[opacity[..., 0] <= 0.01] = 0
    return np.dstack((foreground.astype(np.uint8), alpha.astype(np.uint8)))


def remove_blue_background(image: Image.Image) -> tuple[Image.Image, dict[str, object]]:
    """Key the connected blue canvas without erasing enclosed navy clothing."""

    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    key = border_key(rgb)
    distance = np.linalg.norm(rgb.astype(np.float32) - key, axis=2)

    # Only colour-similar pixels connected to the outer edge are background.
    # This protects similarly coloured skirt/blazer details enclosed by outlines.
    connected = border_connected(distance <= 112.0)
    alpha_float = np.ones(distance.shape, dtype=np.float32)
    feather = smoothstep((distance - 24.0) / (102.0 - 24.0))
    alpha_float[connected] = feather[connected]

    # Preserve the authored dark foot shadow.  It is deliberately darker than
    # the blue key, but its antialiased rim can otherwise be partly selected.
    height, width = distance.shape
    yy, xx = np.mgrid[:height, :width]
    shadow_key = np.array([53.0, 83.0, 103.0], dtype=np.float32)
    shadow_distance = np.linalg.norm(rgb.astype(np.float32) - shadow_key, axis=2)
    shadow = (
        (yy >= round(height * 0.84))
        & (xx >= round(width * 0.08))
        & (xx < round(width * 0.92))
        & (shadow_distance <= 48.0)
    )
    alpha_float[shadow] = np.maximum(alpha_float[shadow], 0.88)

    alpha = np.round(alpha_float * 255).astype(np.uint8)
    rgba = decontaminate(rgb, alpha, key)
    output = Image.fromarray(rgba, "RGBA")
    report = {
        "keyRgb": [round(float(value), 2) for value in key],
        "transparentPixels": int((alpha <= ALPHA_THRESHOLD).sum()),
        "semiTransparentPixels": int(((alpha > ALPHA_THRESHOLD) & (alpha < 247)).sum()),
        "shadowPixelsProtected": int(shadow.sum()),
    }
    return output, report


def remove_magenta_background(image: Image.Image) -> tuple[Image.Image, dict[str, object]]:
    """Convert the generated magenta matte to clean RGBA transparency."""

    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    key = border_key(rgb)
    rgb_float = rgb.astype(np.float32)

    # For a magenta matte, min(red, blue) - green is approximately the amount
    # of matte mixed into an antialiased pixel.  Solving opacity from this
    # channel excess is substantially cleaner than a radial RGB-distance key:
    # it removes the pink fringe while leaving navy, mint, skin and blonde
    # colours opaque.
    key_excess = max(1.0, float(min(key[0], key[2]) - key[1]))
    magenta_excess = np.minimum(rgb_float[..., 0], rgb_float[..., 2]) - rgb_float[..., 1]
    matte_fraction = np.clip((magenta_excess - 1.5) / (key_excess - 1.5), 0.0, 1.0)
    alpha_float = 1.0 - matte_fraction
    # Generated mattes contain faint texture/noise even far from the subject.
    # Drop sub-10% coverage so it cannot become a one-pixel coloured baseline
    # after content-bounds normalization.
    alpha_float[alpha_float < 0.10] = 0.0
    alpha_float[alpha_float > 0.985] = 1.0
    alpha = np.round(alpha_float * 255).astype(np.uint8)
    rgba = decontaminate(rgb, alpha, key)
    output = Image.fromarray(rgba, "RGBA")

    visible = alpha > ALPHA_THRESHOLD
    rgba_int = rgba.astype(np.int16)
    residual_magenta = (
        visible
        & (rgba_int[..., 0] > 190)
        & (rgba_int[..., 2] > 180)
        & (rgba_int[..., 1] + 55 < np.minimum(rgba_int[..., 0], rgba_int[..., 2]))
    )
    report = {
        "keyRgb": [round(float(value), 2) for value in key],
        "transparentPixels": int((alpha <= ALPHA_THRESHOLD).sum()),
        "semiTransparentPixels": int(((alpha > ALPHA_THRESHOLD) & (alpha < 247)).sum()),
        "visibleMagentaLikePixels": int(residual_magenta.sum()),
    }
    return output, report


def content_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    alpha = image.getchannel("A").point(lambda value: 255 if value > ALPHA_THRESHOLD else 0)
    box = alpha.getbbox()
    if box is None:
        raise ValueError("source image has no visible content")
    return box


def clean_rgba(image: Image.Image, minimum_component_area: int = 12) -> Image.Image:
    """Zero invisible RGB and remove tiny disconnected matte-noise islands."""

    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    rgba[rgba[..., 3] <= ALPHA_THRESHOLD] = 0
    mask = rgba[..., 3] > ALPHA_THRESHOLD
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)

    for start_y, start_x in zip(*np.where(mask & ~visited)):
        if visited[start_y, start_x]:
            continue
        queue: deque[tuple[int, int]] = deque([(int(start_y), int(start_x))])
        visited[start_y, start_x] = True
        component: list[tuple[int, int]] = []
        while queue:
            y, x = queue.popleft()
            component.append((y, x))
            for delta_y in (-1, 0, 1):
                for delta_x in (-1, 0, 1):
                    if not (delta_x or delta_y):
                        continue
                    next_y = y + delta_y
                    next_x = x + delta_x
                    if (
                        0 <= next_y < height
                        and 0 <= next_x < width
                        and mask[next_y, next_x]
                        and not visited[next_y, next_x]
                    ):
                        visited[next_y, next_x] = True
                        queue.append((next_y, next_x))
        if len(component) < minimum_component_area:
            ys, xs = zip(*component)
            rgba[np.asarray(ys), np.asarray(xs)] = 0

    return Image.fromarray(rgba, "RGBA")


def normalize_frames(
    sources: Sequence[Image.Image],
    *,
    padding_x: int = 12,
    padding_top: int = 12,
) -> tuple[list[Image.Image], float, list[list[int]]]:
    """Normalize a motion with one shared scale and bottom-centre anchor."""

    boxes = [content_bbox(image) for image in sources]
    max_width = max(right - left for left, _top, right, _bottom in boxes)
    max_height = max(bottom - top for _left, top, _right, bottom in boxes)
    scale = min(
        (FRAME_WIDTH - 2 * padding_x) / max_width,
        (ANCHOR_Y - padding_top) / max_height,
    )

    frames: list[Image.Image] = []
    output_boxes: list[list[int]] = []
    for source, box in zip(sources, boxes, strict=True):
        cropped = source.crop(box)
        width = max(1, round(cropped.width * scale))
        height = max(1, round(cropped.height * scale))
        sprite = cropped.resize((width, height), Image.Resampling.LANCZOS)
        frame = Image.new("RGBA", (FRAME_WIDTH, FRAME_HEIGHT), (0, 0, 0, 0))
        x = round(ANCHOR_X - width / 2)
        y = ANCHOR_Y - height
        frame.alpha_composite(sprite, (x, y))
        frame = clean_rgba(frame)
        frames.append(frame)
        output_boxes.append(list(content_bbox(frame)))

    return frames, scale, output_boxes


def affine_about_anchor(
    image: Image.Image,
    *,
    dx: float,
    dy: float,
    angle_degrees: float,
    scale: float,
) -> Image.Image:
    """Apply a small transform using the shared anchor as the pivot."""

    theta = math.radians(angle_degrees)
    cosine = math.cos(theta)
    sine = math.sin(theta)
    inv_scale = 1.0 / scale

    # PIL's affine coefficients map output coordinates back to source.
    a = cosine * inv_scale
    b = sine * inv_scale
    d = -sine * inv_scale
    e = cosine * inv_scale
    c = ANCHOR_X - a * (ANCHOR_X + dx) - b * (ANCHOR_Y + dy)
    f = ANCHOR_Y - d * (ANCHOR_X + dx) - e * (ANCHOR_Y + dy)
    transformed = image.transform(
        (FRAME_WIDTH, FRAME_HEIGHT),
        Image.Transform.AFFINE,
        (a, b, c, d, e, f),
        resample=Image.Resampling.BICUBIC,
    )
    return clean_rgba(transformed)


def make_synthetic_loop(base: Image.Image, profile: str) -> tuple[list[Image.Image], list[dict[str, float]]]:
    profiles: dict[str, tuple[tuple[float, float, float, float], ...]] = {
        "loading": (
            (0.0, 0.0, 0.0, 1.000),
            (1.0, -3.0, -0.60, 1.004),
            (2.0, -7.0, -1.20, 1.008),
            (3.0, -11.0, -0.50, 1.012),
        ),
        "working": (
            (0.0, 0.0, 0.0, 1.000),
            (2.0, -4.0, -0.70, 1.004),
            (4.0, -8.0, -1.40, 1.008),
            (6.0, -12.0, -0.50, 1.012),
        ),
        "complete": (
            (0.0, 0.0, 0.0, 1.000),
            (0.0, -5.0, 0.70, 1.008),
            (0.0, -11.0, 1.40, 1.016),
            (0.0, -18.0, 0.20, 1.024),
        ),
        "error": (
            (0.0, 0.0, 0.0, 1.000),
            (-1.6, -2.0, -0.90, 1.000),
            (-3.2, -4.5, -1.80, 0.996),
            (-4.6, -7.0, -2.70, 0.992),
        ),
    }
    states = profiles[profile]
    frames: list[Image.Image] = []
    transforms: list[dict[str, float]] = []
    for state_index in SYNTHETIC_SEQUENCE:
        dx, dy, angle, scale = states[state_index]
        frames.append(
            affine_about_anchor(
                base,
                dx=dx,
                dy=dy,
                angle_degrees=angle,
                scale=scale,
            )
        )
        transforms.append(
            {
                "state": state_index,
                "dx": dx,
                "dy": dy,
                "angle": angle,
                "scale": scale,
            }
        )
    return frames, transforms


def premultiplied(frame: Image.Image) -> np.ndarray:
    rgba = np.asarray(frame, dtype=np.float32)
    alpha = rgba[..., 3:4] / 255.0
    return np.concatenate((rgba[..., :3] * alpha, rgba[..., 3:4]), axis=2)


def frame_difference(first: Image.Image, second: Image.Image) -> float:
    return float(np.abs(premultiplied(first) - premultiplied(second)).mean() / 255.0 * 100.0)


def loop_metrics(frames: Sequence[Image.Image], seam_limit: float) -> dict[str, object]:
    if len(frames) < 2:
        raise ValueError("a loop needs at least two frames")
    internal = [frame_difference(frames[index], frames[index + 1]) for index in range(len(frames) - 1)]
    seam = frame_difference(frames[-1], frames[0])
    median = statistics.median(internal)
    ratio = seam / median if median > 1e-9 else (0.0 if seam <= 1e-9 else math.inf)
    return {
        "internalDifferences": [round(value, 6) for value in internal],
        "internalMedian": round(median, 6),
        "seamDifference": round(seam, 6),
        "seamToMedian": round(ratio, 6),
        "limit": seam_limit,
        "passes": bool(ratio <= seam_limit + 1e-9),
    }


def choose_working_sheet_sequence(frames: Sequence[Image.Image], seam_limit: float) -> list[int]:
    """Choose an eight-frame cycle containing all six generated poses."""

    count = len(frames)
    if count != 6:
        raise ValueError("working sheet must contain six poses")
    distances = np.zeros((count, count), dtype=np.float64)
    for first in range(count):
        for second in range(first + 1, count):
            distances[first, second] = distances[second, first] = frame_difference(
                frames[first], frames[second]
            )

    best: tuple[tuple[float, float, int, float], tuple[int, ...]] | None = None
    all_poses = set(range(count))
    # Fix frame zero at the start to remove rotational duplicates.  Seven more
    # slots with no adjacent repeats gives only 5^7 candidates.
    for tail in itertools.product(range(count), repeat=7):
        sequence = (0, *tail)
        if set(sequence) != all_poses:
            continue
        if any(sequence[index] == sequence[(index + 1) % 8] for index in range(8)):
            continue
        transitions = [
            float(distances[sequence[index], sequence[(index + 1) % 8]])
            for index in range(8)
        ]
        internal_median = statistics.median(transitions[:-1])
        seam_ratio = transitions[-1] / internal_median if internal_median else math.inf
        if seam_ratio > seam_limit:
            continue
        backtracks = sum(
            sequence[index - 1] == sequence[(index + 1) % 8]
            for index in range(8)
        )
        score = (max(transitions), sum(transitions), backtracks, transitions[-1])
        if best is None or score < best[0]:
            best = (score, sequence)

    if best is None:
        raise RuntimeError("could not find a working-sheet order that passes the seam gate")
    return list(best[1])


def make_strip(frames: Sequence[Image.Image]) -> Image.Image:
    strip = Image.new("RGBA", (FRAME_WIDTH * len(frames), FRAME_HEIGHT), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        if frame.size != (FRAME_WIDTH, FRAME_HEIGHT) or frame.mode != "RGBA":
            raise ValueError("all strip frames must be 360 x 360 RGBA")
        strip.alpha_composite(frame, (index * FRAME_WIDTH, 0))
    return strip


def save_gif(frames: Sequence[Image.Image], path: Path, duration_ms: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        path,
        save_all=True,
        append_images=list(frames[1:]),
        duration=duration_ms,
        loop=0,
        disposal=2,
        optimize=False,
    )


def verify_preview(path: Path, expected_frames: int) -> dict[str, object]:
    with Image.open(path) as preview:
        durations: list[int] = []
        disposal: list[int] = []
        corner_alpha: list[list[int]] = []
        for index in range(preview.n_frames):
            preview.seek(index)
            durations.append(int(preview.info.get("duration", 0)))
            disposal.append(int(getattr(preview, "disposal_method", 0) or 0))
            rgba = preview.convert("RGBA")
            corner_alpha.append(
                [
                    rgba.getpixel((0, 0))[3],
                    rgba.getpixel((FRAME_WIDTH - 1, 0))[3],
                    rgba.getpixel((0, FRAME_HEIGHT - 1))[3],
                    rgba.getpixel((FRAME_WIDTH - 1, FRAME_HEIGHT - 1))[3],
                ]
            )
        return {
            "size": list(preview.size),
            "frames": preview.n_frames,
            "expectedFrames": expected_frames,
            "loop": preview.info.get("loop"),
            "durationsMs": durations,
            "disposalMethods": sorted(set(disposal)),
            "cornerAlphaValues": corner_alpha,
            "passes": bool(
                preview.size == (FRAME_WIDTH, FRAME_HEIGHT)
                and preview.n_frames == expected_frames
                and preview.info.get("loop") == 0
                and all(value == 0 for corners in corner_alpha for value in corners)
            ),
        }


def frame_geometry(frames: Sequence[Image.Image]) -> dict[str, object]:
    boxes = [list(content_bbox(frame)) for frame in frames]
    coverages = []
    corners = []
    for frame in frames:
        alpha = np.asarray(frame.getchannel("A"))
        coverages.append(float((alpha > ALPHA_THRESHOLD).mean()))
        corners.append(
            [
                int(alpha[0, 0]),
                int(alpha[0, -1]),
                int(alpha[-1, 0]),
                int(alpha[-1, -1]),
            ]
        )
    return {
        "contentBoxes": boxes,
        "coverage": [round(value, 6) for value in coverages],
        "cornerAlphaValues": corners,
        "bottomCenters": [
            [round((box[0] + box[2]) / 2.0, 2), box[3]] for box in boxes
        ],
        "passes": bool(all(value == 0 for frame_corners in corners for value in frame_corners)),
    }


def load_idle(raw_dir: Path) -> tuple[list[Image.Image], dict[str, object]]:
    source = raw_dir / "idle-original.gif"
    if not source.is_file():
        raise FileNotFoundError(source)
    keyed_frames: list[Image.Image] = []
    key_reports: list[dict[str, object]] = []
    with Image.open(source) as animation:
        source_frame_count = animation.n_frames
        indices = np.rint(np.linspace(0, source_frame_count - 1, 12)).astype(int).tolist()
        if len(set(indices)) != 12:
            raise RuntimeError("idle uniform sampling produced duplicate indices")
        source_duration = int(animation.info.get("duration", 70))
        for index in indices:
            animation.seek(index)
            keyed, key_report = remove_blue_background(animation.convert("RGB"))
            keyed_frames.append(keyed)
            key_reports.append(key_report)
    frames, scale, _boxes = normalize_frames(keyed_frames, padding_x=16, padding_top=10)
    return frames, {
        "source": repo_path(source),
        "sourceSha256": sha256(source),
        "sourceFrameCount": source_frame_count,
        "sourceDurationMs": source_duration,
        "selectedFrames": indices,
        "normalizationScale": round(scale, 6),
        "keying": key_reports,
    }


def load_single_scene(
    raw_dir: Path,
    motion: str,
    preferred_names: Sequence[str],
) -> tuple[list[Image.Image], dict[str, object]]:
    source = next((raw_dir / name for name in preferred_names if (raw_dir / name).is_file()), None)
    if source is None:
        raise FileNotFoundError(
            f"missing {motion} source; tried: {', '.join(str(raw_dir / name) for name in preferred_names)}"
        )
    keyed, key_report = remove_magenta_background(Image.open(source).convert("RGB"))
    normalized, scale, _boxes = normalize_frames([keyed], padding_x=18, padding_top=24)
    frames, transforms = make_synthetic_loop(normalized[0], motion)
    return frames, {
        "source": repo_path(source),
        "sourceSha256": sha256(source),
        "normalizationScale": round(scale, 6),
        "keying": key_report,
        "syntheticSequence": list(SYNTHETIC_SEQUENCE),
        "transforms": transforms,
    }


def load_working_sheet(raw_dir: Path, seam_limit: float) -> tuple[list[Image.Image], dict[str, object]]:
    source = raw_dir / "working-sheet-chroma.png"
    if not source.is_file():
        raise FileNotFoundError(source)
    keyed, key_report = remove_magenta_background(Image.open(source).convert("RGB"))
    cell_width = keyed.width // 3
    cell_height = keyed.height // 2
    cells = [
        keyed.crop(
            (
                column * cell_width,
                row * cell_height,
                (column + 1) * cell_width,
                (row + 1) * cell_height,
            )
        )
        for row in range(2)
        for column in range(3)
    ]
    poses, scale, _boxes = normalize_frames(cells, padding_x=18, padding_top=18)
    sequence = choose_working_sheet_sequence(poses, seam_limit)
    frames = [poses[index].copy() for index in sequence]
    return frames, {
        "source": repo_path(source),
        "sourceSha256": sha256(source),
        "fallback": True,
        "grid": {"columns": 3, "rows": 2},
        "normalizationScale": round(scale, 6),
        "keying": key_report,
        "sourcePoseOrder": sequence,
    }


def clip_manifest(
    motion: str,
    frame_count: int,
    fps: int,
) -> dict[str, object]:
    playback = "once-hold" if motion == "complete" else "loop"
    reduced_frame = 3 if motion == "complete" else 0
    return {
        "strip": f"strips/{motion}.png",
        "preview": f"previews/{motion}-v2-preview.gif",
        "frameCount": frame_count,
        "fps": fps,
        "playback": playback,
        "reducedFrame": reduced_frame,
    }


def write_manifest(path: Path, clips: dict[str, dict[str, object]], sources: dict[str, object]) -> None:
    manifest = {
        "schemaVersion": 2,
        "characterId": "gifp-main",
        "variantId": "school-film-scenes-v2",
        "frame": {"width": FRAME_WIDTH, "height": FRAME_HEIGHT},
        "anchor": {"x": ANCHOR_X, "y": ANCHOR_Y, "type": "bottom-center"},
        "background": "transparent",
        "poster": "poster.png",
        "clips": clips,
        "phaseMap": {
            "welcome": "idle",
            "ready": "idle",
            "recording": "loading",
            "working": "working",
            "complete": "complete",
            "error": "error",
        },
        "provenance": sources,
    }
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    raw_dir = args.raw_dir.resolve()
    output_dir = args.output_dir.resolve()
    report_path = args.report.resolve()
    strips_dir = output_dir / "strips"
    previews_dir = output_dir / "previews"
    strips_dir.mkdir(parents=True, exist_ok=True)
    previews_dir.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    idle_frames, idle_source = load_idle(raw_dir)
    frames_by_motion: dict[str, list[Image.Image]] = {"idle": idle_frames}
    poster = frames_by_motion["idle"][0].copy()
    poster_source = {
        "source": idle_source["source"],
        "sourceSha256": idle_source["sourceSha256"],
        "sourceFrameIndex": idle_source["selectedFrames"][0],
        "derivedFrom": "idle frame 0 after blue-key removal and normalization",
        "runtimeIdlePixelMatch": True,
    }
    source_reports: dict[str, object] = {
        "poster": poster_source,
        "idle": idle_source,
    }
    poster_path = output_dir / "poster.png"
    poster.save(poster_path, optimize=True)
    frames_by_motion["loading"], source_reports["loading"] = load_single_scene(
        raw_dir,
        "loading",
        ("loading-scene-v2-chroma.png", "loading-scene-chroma.png"),
    )

    preferred_working = raw_dir / "working-scene-v2-chroma.png"
    if preferred_working.is_file():
        frames_by_motion["working"], source_reports["working"] = load_single_scene(
            raw_dir,
            "working",
            ("working-scene-v2-chroma.png",),
        )
    else:
        frames_by_motion["working"], source_reports["working"] = load_working_sheet(
            raw_dir,
            args.seam_limit,
        )

    frames_by_motion["complete"], source_reports["complete"] = load_single_scene(
        raw_dir,
        "complete",
        ("complete-scene-chroma.png",),
    )
    frames_by_motion["error"], source_reports["error"] = load_single_scene(
        raw_dir,
        "error",
        ("error-scene-chroma.png",),
    )

    fps_by_motion = {"idle": 6, "loading": 10, "working": 10, "complete": 10, "error": 8}
    duration_by_motion = {motion: round(1000 / fps / 10) * 10 for motion, fps in fps_by_motion.items()}

    clip_entries: dict[str, dict[str, object]] = {}
    qa_clips: dict[str, dict[str, object]] = {}
    failures: list[str] = []

    for motion in MOTION_ORDER:
        frames = frames_by_motion[motion]
        strip_path = strips_dir / f"{motion}.png"
        preview_path = previews_dir / f"{motion}-v2-preview.gif"
        make_strip(frames).save(strip_path, optimize=True)
        save_gif(frames, preview_path, duration_by_motion[motion])

        seam = loop_metrics(frames, args.seam_limit)
        geometry = frame_geometry(frames)
        preview = verify_preview(preview_path, len(frames))
        strip = Image.open(strip_path)
        strip_passes = bool(
            strip.mode == "RGBA"
            and strip.size == (FRAME_WIDTH * len(frames), FRAME_HEIGHT)
        )
        if not seam["passes"]:
            failures.append(f"{motion}: seam ratio {seam['seamToMedian']} exceeds {args.seam_limit}")
        if not geometry["passes"]:
            failures.append(f"{motion}: non-transparent frame corner")
        if not preview["passes"]:
            failures.append(f"{motion}: GIF preview validation failed")
        if not strip_passes:
            failures.append(f"{motion}: horizontal RGBA strip validation failed")

        clip_entries[motion] = clip_manifest(motion, len(frames), fps_by_motion[motion])
        qa_clips[motion] = {
            "source": source_reports[motion],
            "frameCount": len(frames),
            "frame": {"width": FRAME_WIDTH, "height": FRAME_HEIGHT, "mode": "RGBA"},
            "anchor": {"x": ANCHOR_X, "y": ANCHOR_Y, "type": "bottom-center"},
            "strip": {
                "path": repo_path(strip_path),
                "size": list(strip.size),
                "mode": strip.mode,
                "sha256": sha256(strip_path),
                "oneRow": strip.size[1] == FRAME_HEIGHT,
                "passes": strip_passes,
            },
            "preview": {"path": repo_path(preview_path), "sha256": sha256(preview_path), **preview},
            "geometry": geometry,
            "loop": seam,
        }

    write_manifest(output_dir / "manifest.json", clip_entries, source_reports)
    poster_geometry = frame_geometry([poster])
    poster_matches_idle = bool(
        np.array_equal(
            np.asarray(Image.open(poster_path).convert("RGBA")),
            np.asarray(Image.open(strips_dir / "idle.png").convert("RGBA").crop((0, 0, FRAME_WIDTH, FRAME_HEIGHT))),
        )
    )
    if not poster_matches_idle:
        failures.append("poster: pixels do not match idle frame 0")
    report = {
        "schemaVersion": 1,
        "assetRoot": repo_path(output_dir),
        "frame": {"width": FRAME_WIDTH, "height": FRAME_HEIGHT, "mode": "RGBA"},
        "anchor": {"x": ANCHOR_X, "y": ANCHOR_Y, "type": "bottom-center"},
        "seamLimit": args.seam_limit,
        "poster": {
            "path": repo_path(poster_path),
            "sha256": sha256(poster_path),
            "source": poster_source,
            "geometry": poster_geometry,
            "pixelMatchesIdleFrame0": poster_matches_idle,
        },
        "clips": qa_clips,
        "failures": failures,
        "passes": not failures,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if failures:
        raise SystemExit("\n".join(failures))
    print(json.dumps({"output": repo_path(output_dir), "report": repo_path(report_path), "passes": True}))


if __name__ == "__main__":
    main()
