#!/usr/bin/env python3
"""Package normalized PNG frames into one anchored mascot animation strip.

The source frames may be any RGBA size. The script finds the shared maximum
content bounds, applies one scale to every frame, anchors each pose at the
bottom centre, and writes a transparent horizontal PNG strip.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, help="Directory containing 01.png, 02.png, …")
    parser.add_argument("--output", required=True, help="Output horizontal strip PNG")
    parser.add_argument("--frames", type=int, required=True, help="Expected number of frames")
    parser.add_argument("--frame-width", type=int, default=320)
    parser.add_argument("--frame-height", type=int, default=480)
    parser.add_argument("--padding-x", type=int, default=12)
    parser.add_argument("--padding-top", type=int, default=8)
    parser.add_argument("--padding-bottom", type=int, default=24)
    parser.add_argument(
        "--y-offsets",
        help=(
            "Optional comma-separated upward offsets in output pixels, one per frame. "
            "Use this to preserve authored hops after bottom-centre normalization."
        ),
    )
    parser.add_argument("--alpha-threshold", type=int, default=8)
    parser.add_argument("--report", help="Optional JSON validation report")
    return parser.parse_args()


def content_bbox(image: Image.Image, threshold: int) -> tuple[int, int, int, int] | None:
    alpha = image.getchannel("A").point(lambda value: 255 if value > threshold else 0)
    return alpha.getbbox()


def main() -> None:
    args = parse_args()
    if args.frames < 1:
        raise SystemExit("--frames must be at least 1")
    if args.frame_width < 1 or args.frame_height < 1:
        raise SystemExit("frame dimensions must be positive")

    y_offsets = [0] * args.frames
    if args.y_offsets:
        try:
            y_offsets = [int(value.strip()) for value in args.y_offsets.split(",")]
        except ValueError as exc:
            raise SystemExit("--y-offsets must contain integers") from exc
        if len(y_offsets) != args.frames:
            raise SystemExit("--y-offsets must contain exactly --frames values")

    input_dir = Path(args.input_dir)
    paths = [input_dir / f"{index:02d}.png" for index in range(1, args.frames + 1)]
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise SystemExit(f"Missing frame files: {', '.join(missing)}")

    images = [Image.open(path).convert("RGBA") for path in paths]
    boxes = [content_bbox(image, args.alpha_threshold) for image in images]
    if any(box is None for box in boxes):
        empty = [paths[index].name for index, box in enumerate(boxes) if box is None]
        raise SystemExit(f"No visible sprite content in: {', '.join(empty)}")

    typed_boxes = [box for box in boxes if box is not None]
    max_width = max(right - left for left, _top, right, _bottom in typed_boxes)
    target_width = args.frame_width - (2 * args.padding_x)
    target_height = args.frame_height - args.padding_top - args.padding_bottom
    if target_width < 1 or target_height < 1:
        raise SystemExit("padding leaves no room for sprite content")
    height_scales: list[float] = []
    for (_left, top, _right, bottom), y_offset in zip(typed_boxes, y_offsets, strict=True):
        available_height = target_height - y_offset
        if available_height < 1:
            raise SystemExit(f"y offset {y_offset} leaves no vertical room for sprite content")
        height_scales.append(available_height / (bottom - top))
    scale = min(target_width / max_width, *height_scales)

    strip = Image.new("RGBA", (args.frame_width * args.frames, args.frame_height), (0, 0, 0, 0))
    output_frames: list[Image.Image] = []
    coverages: list[float] = []

    for image, box, y_offset in zip(images, typed_boxes, y_offsets, strict=True):
        cropped = image.crop(box)
        width = max(1, round(cropped.width * scale))
        height = max(1, round(cropped.height * scale))
        sprite = cropped.resize((width, height), Image.Resampling.LANCZOS)
        frame = Image.new("RGBA", (args.frame_width, args.frame_height), (0, 0, 0, 0))
        x = (args.frame_width - width) // 2
        y = args.frame_height - args.padding_bottom - height - y_offset
        if y < args.padding_top:
            raise SystemExit(
                f"Frame {len(output_frames) + 1} exceeds the top safe area with y offset {y_offset}"
            )
        frame.alpha_composite(sprite, (x, y))
        output_frames.append(frame)
        strip.alpha_composite(frame, ((len(output_frames) - 1) * args.frame_width, 0))
        alpha = frame.getchannel("A")
        visible = sum(
            count
            for value, count in enumerate(alpha.histogram())
            if value > args.alpha_threshold
        )
        coverages.append(visible / (args.frame_width * args.frame_height))

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    strip.save(output, optimize=True)

    report = {
        "output": str(output),
        "frames": args.frames,
        "frame": {"width": args.frame_width, "height": args.frame_height},
        "anchor": {"x": args.frame_width // 2, "y": args.frame_height - args.padding_bottom},
        "scale": round(scale, 6),
        "coverage": [round(value, 6) for value in coverages],
        "yOffsets": y_offsets,
        "alphaCornerValues": [
            output_frames[0].getpixel((0, 0))[3],
            output_frames[0].getpixel((args.frame_width - 1, 0))[3],
            output_frames[0].getpixel((0, args.frame_height - 1))[3],
            output_frames[0].getpixel((args.frame_width - 1, args.frame_height - 1))[3],
        ],
    }
    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
