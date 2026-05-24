# Perceptual GIF Compressor Product Spec

## Working Name

GifLab, FrameForge GIF, or GIF Compiler.

The product is not a faster legacy converter. It is a perceptual GIF compiler: it analyzes a short MP4, chooses the most valuable frames, builds perceptual palettes, and searches for the best visual result under a target file size.

## Product Promise

2026 GIF compression should feel like this:

- Drag in a short MP4.
- Pick a simple intent.
- Watch the software generate a few smart candidates.
- Export a compact GIF that still reads clearly.

The product should hide technical complexity by default. Users should not need to understand FPS, palette size, dithering, LZW, or disposal methods to get a good result.

## Target Users

- Creators making GIFs from 5-15 second video clips.
- People making stickers, memes, short loops, and chat reactions.
- Designers and indie makers who want a better local Windows tool with no installation step.
- Power users who currently use FFmpeg, gifski, or online compressors but dislike parameter tuning.

## Core Workflow

1. User drags an MP4 into the app.
2. App analyzes video length, resolution, motion, scene changes, text, and estimated complexity.
3. User chooses a mode:
   - Auto: best default balance.
   - Emoji: small, readable, chat-friendly.
   - Clip: motion-first short video loop.
   - Pixel: stylized retro/game-like output.
4. App generates one to three candidate GIFs.
5. User compares size, motion, and clarity.
6. User exports the selected GIF.

## First Screen

The app should open directly into the usable tool, not a marketing page.

Visual direction: a compact P5/game-device interface.

- Left: input cartridge/drop zone.
- Center: preview screen with video/GIF comparison.
- Right: mode selector and three high-level controls.
- Bottom: compression progress bar styled like a game status meter.

The UI should feel playful but remain operational. This is a tool, not a landing page.

## Primary Controls

Default controls:

- Mode: Auto, Emoji, Clip, Pixel.
- Target size: Auto, 2 MB, 5 MB, 8 MB, custom.
- Quality bias: Smaller, Balanced, Sharper.

Advanced controls:

- Width.
- Max duration.
- Loop on/off.
- Motion priority.
- Color priority.
- Text clarity.
- Dither style: Clean, Film, Pixel.
- Candidate count: 1 or 3.

## Candidate Preview

The app should support "Compression Battle Preview":

- Candidate A: smaller.
- Candidate B: balanced.
- Candidate C: sharper.

Each candidate shows:

- Estimated or actual GIF size.
- Frame count.
- Output dimensions.
- Perceptual quality score.
- Loop preview.

This avoids forcing users to reason from technical parameters.

## Output Scorecard

After export, show:

- Original MP4 size.
- GIF size.
- Compression ratio.
- Frames kept.
- Palette strategy.
- Motion score.
- Color score.
- Text clarity score.

These scores make the algorithm visible without making the user configure it.

## MVP Scope

MVP must include:

- Windows desktop app.
- MP4 input.
- Trim to a short range if the video is longer than expected.
- Auto and Emoji modes.
- GIF export.
- Preview before export.
- Simple progress state.
- Portable Windows executable or zip.

MVP algorithm:

- FFmpeg-based decode.
- Heuristic frame scoring.
- OKLab or Lab color quantization.
- Adaptive dithering presets.
- Basic GIF rectangle diff optimization.
- File-size search loop.

## V1 Scope

V1 should add:

- Three-candidate preview.
- Clip and Pixel modes.
- Better temporal palette planning.
- Blue-noise or perceptual dithering.
- Text/edge preservation weighting.
- Preset saving.
- Better progress visualization.

## V2 Scope

V2 should add:

- ONNX neural frame sampler.
- Subject, face, and saliency weighting.
- Optional GPU acceleration on Windows.
- Batch processing.
- Export WebP and MP4 fallback formats.
- Model update mechanism.

## Non-Goals

- Full video editor.
- Cloud upload pipeline.
- Timeline-heavy professional NLE workflow.
- Supporting every legacy video format in the first version.
- Exposing raw FFmpeg-style flags as the main interface.

## Success Criteria

- A normal Windows user can run the portable tool and export a GIF without reading documentation.
- For common 15 second clips, Auto mode produces a better size/quality tradeoff than naive FFmpeg defaults.
- Emoji mode produces chat-friendly GIFs with clear faces/text and predictable file size.
- The app has a memorable interface that feels native to the product idea.
