#!/usr/bin/env python3
"""Verify the packaged GIFP mascot motion set and emit a JSON QA report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Pillow is required to verify mascot motion assets.") from exc


ACTIONS = {
    "idle": 8,
    "loading": 8,
    "working": 8,
    "complete": 10,
    "error": 8,
}
FRAME_WIDTH = 320
FRAME_HEIGHT = 480
ALPHA_THRESHOLD = 8


def default_root() -> Path:
    return (
        Path(__file__).resolve().parents[1]
        / "public"
        / "characters"
        / "gifp-main"
        / "v1"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=default_root(),
        help="Mascot v1 root containing poster.png and strips/. Defaults to the repository asset root.",
    )
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="Skip missing expected assets while still failing validation errors in assets that exist.",
    )
    parser.add_argument("--report", type=Path, help="Optional path for the JSON report.")
    return parser.parse_args()


def alpha_corners(alpha: Image.Image) -> list[int]:
    width, height = alpha.size
    return [
        alpha.getpixel((0, 0)),
        alpha.getpixel((width - 1, 0)),
        alpha.getpixel((0, height - 1)),
        alpha.getpixel((width - 1, height - 1)),
    ]


def threshold_bbox(alpha: Image.Image) -> tuple[int, int, int, int] | None:
    mask = alpha.point(lambda value: 255 if value > ALPHA_THRESHOLD else 0)
    return mask.getbbox()


def visible_coverage(alpha: Image.Image) -> float:
    histogram = alpha.histogram()
    visible = sum(histogram[ALPHA_THRESHOLD + 1 :])
    return visible / (alpha.width * alpha.height)


def verify_action(path: Path, action: str, frames: int) -> dict[str, Any]:
    expected_size = [FRAME_WIDTH * frames, FRAME_HEIGHT]
    result: dict[str, Any] = {
        "action": action,
        "path": str(path),
        "status": "failed",
        "expectedFrames": frames,
        "expectedSize": expected_size,
        "frameSize": [FRAME_WIDTH, FRAME_HEIGHT],
        "errors": [],
        "frames": [],
    }

    try:
        with Image.open(path) as source:
            source.load()
            result["mode"] = source.mode
            result["size"] = list(source.size)
            if source.mode != "RGBA":
                result["errors"].append(f"expected RGBA mode, got {source.mode}")
            if list(source.size) != expected_size:
                result["errors"].append(
                    f"expected strip size {expected_size[0]}x{expected_size[1]}, "
                    f"got {source.width}x{source.height}"
                )

            image = source.convert("RGBA")
            result["stripCornerAlpha"] = alpha_corners(image.getchannel("A"))

            coverage_values: list[float] = []
            for index in range(frames):
                left = index * FRAME_WIDTH
                frame = image.crop((left, 0, left + FRAME_WIDTH, FRAME_HEIGHT))
                alpha = frame.getchannel("A")
                bbox = threshold_bbox(alpha)
                coverage = visible_coverage(alpha)
                corners = alpha_corners(alpha)
                frame_errors: list[str] = []

                if bbox is None:
                    frame_errors.append("frame has no visible content")
                    touches_edge = False
                else:
                    bbox_left, bbox_top, bbox_right, bbox_bottom = bbox
                    touches_edge = (
                        bbox_left <= 0
                        or bbox_top <= 0
                        or bbox_right >= FRAME_WIDTH
                        or bbox_bottom >= FRAME_HEIGHT
                    )
                    if touches_edge:
                        frame_errors.append("visible content touches a frame edge")

                if any(corners):
                    frame_errors.append(f"frame corners are not transparent: {corners}")

                coverage_values.append(coverage)
                result["frames"].append(
                    {
                        "index": index + 1,
                        "bbox": list(bbox) if bbox is not None else None,
                        "coverage": round(coverage, 6),
                        "cornerAlpha": corners,
                        "nonEmpty": bbox is not None,
                        "touchesEdge": touches_edge,
                        "ok": not frame_errors,
                        "errors": frame_errors,
                    }
                )
                result["errors"].extend(
                    f"frame {index + 1}: {message}" for message in frame_errors
                )

            result["coverage"] = {
                "values": [round(value, 6) for value in coverage_values],
                "min": round(min(coverage_values), 6),
                "max": round(max(coverage_values), 6),
            }
    except Exception as exc:  # report malformed or unreadable assets without aborting the set
        result["errors"].append(f"could not inspect image: {exc}")

    result["status"] = "ok" if not result["errors"] else "failed"
    return result


def verify_poster(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "path": str(path),
        "status": "failed",
        "errors": [],
    }
    try:
        with Image.open(path) as source:
            source.load()
            result["mode"] = source.mode
            result["size"] = list(source.size)
            if source.mode != "RGBA":
                result["errors"].append(f"expected RGBA mode, got {source.mode}")

            image = source.convert("RGBA")
            alpha = image.getchannel("A")
            total = alpha.width * alpha.height
            histogram = alpha.histogram()
            transparent = histogram[0]
            visible = sum(histogram[ALPHA_THRESHOLD + 1 :])
            bbox = threshold_bbox(alpha)
            result.update(
                {
                    "bbox": list(bbox) if bbox is not None else None,
                    "cornerAlpha": alpha_corners(alpha),
                    "transparentPixels": transparent,
                    "transparentCoverage": round(transparent / total, 6),
                    "visibleCoverage": round(visible / total, 6),
                }
            )
            if transparent == 0:
                result["errors"].append("poster has no transparent background pixels")
            if visible == 0:
                result["errors"].append("poster has no visible character content")
    except Exception as exc:  # report malformed or unreadable assets without aborting the set
        result["errors"].append(f"could not inspect image: {exc}")

    result["status"] = "ok" if not result["errors"] else "failed"
    return result


def missing_result(path: Path, kind: str, allowed: bool) -> dict[str, Any]:
    return {
        "path": str(path),
        "status": "missing-allowed" if allowed else "missing",
        "errors": [] if allowed else [f"missing required {kind}: {path}"],
    }


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    failures: list[str] = []
    missing: list[str] = []
    action_results: dict[str, dict[str, Any]] = {}

    for action, frames in ACTIONS.items():
        path = root / "strips" / f"{action}.png"
        if path.is_file():
            result = verify_action(path, action, frames)
        else:
            result = missing_result(path, f"{action} strip", args.allow_missing)
            result.update(
                {
                    "action": action,
                    "expectedFrames": frames,
                    "expectedSize": [FRAME_WIDTH * frames, FRAME_HEIGHT],
                    "frameSize": [FRAME_WIDTH, FRAME_HEIGHT],
                }
            )
            missing.append(action)
        action_results[action] = result
        failures.extend(f"{action}: {message}" for message in result["errors"])

    poster_path = root / "poster.png"
    if poster_path.is_file():
        poster_result = verify_poster(poster_path)
    else:
        poster_result = missing_result(poster_path, "poster", args.allow_missing)
        missing.append("poster")
    failures.extend(f"poster: {message}" for message in poster_result["errors"])

    report: dict[str, Any] = {
        "root": str(root),
        "allowMissing": args.allow_missing,
        "ok": not failures,
        "expected": {
            "actions": ACTIONS,
            "frameSize": [FRAME_WIDTH, FRAME_HEIGHT],
            "mode": "RGBA",
            "alphaThreshold": ALPHA_THRESHOLD,
        },
        "missing": missing,
        "actions": action_results,
        "poster": poster_result,
        "failures": failures,
    }

    payload = json.dumps(report, ensure_ascii=False, indent=2)
    print(payload)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(payload + "\n", encoding="utf-8")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
