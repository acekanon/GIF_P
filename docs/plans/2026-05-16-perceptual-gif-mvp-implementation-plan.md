# Perceptual GIF Compressor MVP Implementation Plan

> **For Codex:** Implement this plan task-by-task. Keep commits small if this becomes a git repository. Start with a boring baseline pipeline, then replace pieces with perceptual algorithms.

**Goal:** Build a Windows-first portable MVP that accepts an MP4, exposes useful compression controls, and exports an optimized GIF through a Tauri UI and Rust processing core.

**Architecture:** The app is split into a Tauri desktop shell, a Rust core library, and a thin command/event bridge. MVP uses FFmpeg as the decoder/encoder baseline first, then introduces internal frame scheduling, perceptual palette planning, and size-constrained optimization behind stable interfaces.

**Tech Stack:** Tauri, Rust, React or Svelte, system FFmpeg/FFprobe, image/rayon/color-space crates, GIF encoder crate or FFmpeg fallback, portable Windows executable packaging.

---

## Milestone 0: Repository Bootstrap

### Task 0.1: Create Project Skeleton

**Files:**

- Create: `package.json`
- Create: `src/App.tsx` or `src/App.svelte`
- Create: `src/main.tsx` or equivalent
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/commands.rs`
- Create: `src-tauri/src/core/mod.rs`

**Steps:**

1. Initialize a Tauri app with the chosen frontend framework.
2. Confirm the frontend launches in dev mode.
3. Confirm Rust commands can be invoked from the UI.
4. Add a placeholder `analyze_video` command returning mocked metadata.
5. Render mocked metadata in the UI.

**Verify:**

- Run: `npm run tauri dev`
- Expected: app window opens and shows a usable first screen.

**Acceptance:**

- The app launches on Windows.
- UI can call one Rust command and display its response.

### Task 0.2: Add Core Domain Types

**Files:**

- Create: `src-tauri/src/core/types.rs`
- Modify: `src-tauri/src/core/mod.rs`

**Types:**

```rust
pub struct VideoMetadata {
    pub path: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub estimated_frame_count: u32,
}

pub struct FrameSignal {
    pub index: u32,
    pub timestamp_ms: u64,
    pub motion_score: f32,
    pub scene_change_score: f32,
    pub edge_score: f32,
    pub compression_cost: f32,
}

pub struct GifCandidate {
    pub path: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub quality_score: f32,
}

pub enum CompressionMode {
    Auto,
    Emoji,
    Clip,
    Pixel,
}
```

**Verify:**

- Run: `cargo test`
- Expected: build succeeds.

**Acceptance:**

- Core modules use shared types instead of ad hoc JSON strings.

---

## Milestone 1: Baseline Video to GIF Pipeline

### Task 1.1: Add FFmpeg Discovery

**Files:**

- Create: `src-tauri/src/core/ffmpeg.rs`
- Modify: `src-tauri/src/core/mod.rs`

**Behavior:**

- Locate `ffmpeg` and `ffprobe` on PATH.
- Return install/configuration guidance if either command is missing.
- Return a clear error if unavailable.

**Tests:**

- Unit test path resolution with mocked candidate paths.
- Manual test with system FFmpeg.

**Verify:**

- Run: `cargo test ffmpeg`
- Expected: tests pass.

**Acceptance:**

- The app can explain missing FFmpeg cleanly instead of failing silently.

### Task 1.2: Probe MP4 Metadata

**Files:**

- Modify: `src-tauri/src/core/ffmpeg.rs`
- Create: `src-tauri/src/core/probe.rs`
- Modify: `src-tauri/src/commands.rs`

**Behavior:**

- Use `ffprobe` or `ffmpeg -i` output to read duration, dimensions, and fps.
- Return `VideoMetadata`.
- Reject unsupported or very long input with actionable errors.

**Verify:**

- Run the UI against a small MP4.
- Expected: duration, resolution, and fps appear in the app.

**Acceptance:**

- Dragging an MP4 shows real metadata.

### Task 1.3: Baseline GIF Export

**Files:**

- Create: `src-tauri/src/core/export.rs`
- Modify: `src-tauri/src/commands.rs`

**Behavior:**

- Export a GIF using FFmpeg baseline filters.
- Use conservative defaults:
  - Width: 480 px max.
  - FPS: 12.
  - Palette generation + palette use.
  - Loop enabled.

**Example FFmpeg Baseline:**

```text
fps=12,scale=480:-1:flags=lanczos,palettegen
fps=12,scale=480:-1:flags=lanczos[x];[x][palette]paletteuse=dither=bayer
```

**Verify:**

- Export a GIF from a 5-15 second MP4.
- Open the GIF and confirm it loops.

**Acceptance:**

- The app can produce a valid GIF before custom algorithms are added.

---

## Milestone 2: Usable MVP Interface

### Task 2.1: Build First-Screen Tool UI

**Files:**

- Modify: `src/App.tsx` or `src/App.svelte`
- Create: `src/styles.css`
- Create: `src/components/DropZone.*`
- Create: `src/components/PreviewScreen.*`
- Create: `src/components/ModeSelector.*`
- Create: `src/components/ExportPanel.*`

**Behavior:**

- Drag/drop MP4.
- Display metadata.
- Select mode: Auto or Emoji for MVP.
- Export GIF.
- Show progress states.

**Design Direction:**

- P5/game-device interface.
- Dense tool layout, not landing page.
- Strong preview screen.
- Icon buttons where appropriate.
- No explanatory marketing blocks inside the app.

**Verify:**

- Run app at desktop and narrow window sizes.
- Confirm no text overlaps.
- Confirm controls remain clickable.

**Acceptance:**

- A user can complete the full baseline workflow from the first screen.

### Task 2.2: Add Job Progress Events

**Files:**

- Modify: `src-tauri/src/core/export.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/App.tsx` or `src/App.svelte`

**Behavior:**

- Stream progress phases:
  - Probing.
  - Analyzing.
  - Scheduling.
  - Encoding.
  - Finalizing.
- MVP may estimate percentages by phase.

**Verify:**

- Export a medium clip.
- Expected: UI remains responsive and progress text changes.

**Acceptance:**

- Long-running work never looks frozen.

---

## Milestone 3: Perceptual Frame Scheduler

### Task 3.1: Extract Analysis Frames

**Files:**

- Create: `src-tauri/src/core/analyzer.rs`
- Modify: `src-tauri/src/core/ffmpeg.rs`

**Behavior:**

- Decode downscaled analysis frames.
- Use a fixed analysis width such as 160 or 240 px.
- Keep timestamps.
- Avoid loading full video into memory at full resolution.

**Verify:**

- Run analysis on a 15 second clip.
- Expected: analysis finishes quickly and memory use stays reasonable.

**Acceptance:**

- Analyzer can iterate sampled frames independent of final export.

### Task 3.2: Compute Frame Signals

**Files:**

- Modify: `src-tauri/src/core/analyzer.rs`
- Test: `src-tauri/src/core/analyzer_tests.rs`

**Signals:**

- Motion score from frame difference.
- Scene change score from histogram difference.
- Edge score from luminance gradient approximation.
- Compression cost from entropy/noise estimate.

**Verify:**

- Run: `cargo test analyzer`
- Expected: synthetic frame tests pass.

**Acceptance:**

- A static clip receives low motion scores.
- A hard scene cut receives high scene change score.
- Text-like sharp edges increase edge score.

### Task 3.3: Schedule Frames With Variable Delays

**Files:**

- Create: `src-tauri/src/core/scheduler.rs`
- Test: `src-tauri/src/core/scheduler_tests.rs`

**Behavior:**

- Score frames using weighted signals.
- Preserve scene boundaries.
- Preserve temporal spacing.
- Merge low-value repeated frames into longer delays.
- Produce a `FrameTimeline`.

**Verify:**

- Run: `cargo test scheduler`
- Expected: tests pass.

**Acceptance:**

- The scheduler keeps fewer frames than uniform sampling while preserving obvious cuts and motion peaks.

---

## Milestone 4: Perceptual Color Pipeline

### Task 4.1: Add OKLab/Lab Color Conversion

**Files:**

- Create: `src-tauri/src/core/color.rs`
- Test: `src-tauri/src/core/color_tests.rs`

**Behavior:**

- Convert sRGB to linear RGB.
- Convert linear RGB to OKLab.
- Compute perceptual distance.

**Verify:**

- Run: `cargo test color`
- Expected: conversion tests pass within tolerance.

**Acceptance:**

- Quantizer code can compare colors in perceptual space.

### Task 4.2: Build Weighted Palette Quantizer

**Files:**

- Create: `src-tauri/src/core/quantizer.rs`
- Test: `src-tauri/src/core/quantizer_tests.rs`

**Behavior:**

- Sample pixels from selected frames.
- Weight samples by frame importance.
- Cluster in OKLab/Lab.
- Produce palette of N colors.

**Verify:**

- Run: `cargo test quantizer`
- Expected: deterministic palette tests pass with seeded initialization.

**Acceptance:**

- Palette favors important frames and visible colors instead of pure frequency.

### Task 4.3: Add Dither Modes

**Files:**

- Create: `src-tauri/src/core/dither.rs`
- Test: `src-tauri/src/core/dither_tests.rs`

**Modes:**

- Clean.
- Film.
- Pixel.

**Behavior:**

- Clean minimizes noise.
- Film uses subtle ordered/blue-noise-like pattern.
- Pixel uses stronger stylized pattern.

**Verify:**

- Generate visual fixtures.
- Compare output manually and with basic snapshot dimensions.

**Acceptance:**

- Dither mode changes are visible and controlled.

---

## Milestone 5: Size-Constrained Optimizer

### Task 5.1: Define Optimization Profiles

**Files:**

- Create: `src-tauri/src/core/profiles.rs`
- Test: `src-tauri/src/core/profiles_tests.rs`

**Profiles:**

- Auto.
- Emoji.
- Clip.
- Pixel.

**Profile Fields:**

- target_size_bytes.
- max_width.
- frame_budget_bias.
- palette_budget.
- dither_mode.
- quality_weights.

**Acceptance:**

- UI modes map to explicit optimizer constraints.

### Task 5.2: Implement Candidate Search

**Files:**

- Create: `src-tauri/src/core/optimizer.rs`
- Test: `src-tauri/src/core/optimizer_tests.rs`

**Behavior:**

- Generate candidate settings.
- Encode estimates or temporary GIFs.
- Keep best candidate under target size.
- If none fit, shrink width/frame count/palette size progressively.

**Verify:**

- Run optimizer on fixture clips.
- Expected: final candidate respects target size when feasible.

**Acceptance:**

- Auto mode can pursue size targets without exposing raw parameters.

### Task 5.3: Candidate Preview

**Files:**

- Modify: `src-tauri/src/core/optimizer.rs`
- Modify: `src/App.tsx` or `src/App.svelte`
- Create: `src/components/CandidateStrip.*`

**Behavior:**

- Generate smaller, balanced, and sharper candidates.
- Show GIF previews and metrics.
- Let user choose one to export.

**Acceptance:**

- User can make a visual choice instead of tuning settings.

---

## Milestone 6: Windows Packaging

### Task 6.1: Add FFmpeg Prerequisite Check

**Files:**

- Modify: `src-tauri/src/core/ffmpeg.rs`
- Modify: `src/App.tsx` or `src/App.svelte`
- Create: `docs/plans/ffmpeg-prerequisite.md`

**Behavior:**

- Detect missing `ffmpeg` or `ffprobe`.
- Show a clear setup message before export.
- Document the expected PATH setup.
- Do not bundle FFmpeg in the portable release.

**Acceptance:**

- Portable app exports GIF when system FFmpeg is present.
- Missing FFmpeg produces a useful error instead of a crash or silent failure.

### Task 6.2: Build Portable Release

**Files:**

- Modify: `src-tauri/tauri.conf.json`
- Create: `docs/plans/portable-release-checklist.md`

**Behavior:**

- Configure app name, icon, bundle identifier, and portable release behavior.
- Generate the release executable.
- Document how to zip the executable with README and presets.

**Verify:**

- Run: `npm run tauri build`
- Expected: `src-tauri/target/release/giflab.exe` is produced.

**Acceptance:**

- A Windows machine with FFmpeg on PATH can run the app without installation.

---

## Milestone 7: Quality Bar

### Task 7.1: Build Test Corpus

**Files:**

- Create: `testdata/README.md`

**Clip Categories:**

- Face/selfie.
- Text/subtitles.
- Game footage.
- Screen recording.
- Fast motion.
- Low-light noisy footage.
- Anime/cartoon.

**Acceptance:**

- Each category has at least one small local fixture or documented manual test sample.

### Task 7.2: Add Regression Report

**Files:**

- Create: `src-tauri/src/core/report.rs`
- Create: `docs/plans/mvp-quality-report-template.md`

**Metrics:**

- Input duration.
- Output size.
- Width/height.
- Frames kept.
- Average delay.
- Palette size.
- Encode time.

**Acceptance:**

- Each test export can produce a short report for comparison.

## MVP Done Definition

The MVP is done when:

- A Windows user can run the app without installation.
- The app opens directly into the GIF tool.
- Dragging a short MP4 shows metadata.
- Auto mode exports a valid looping GIF.
- Emoji mode creates a smaller chat-friendly GIF.
- The app shows progress during processing.
- Output size and frame count are visible.
- At least five test clips have been manually compared against baseline FFmpeg output.

## Suggested Build Order

1. Bootstrap Tauri and Rust command bridge.
2. Implement FFmpeg metadata probe.
3. Implement baseline FFmpeg GIF export.
4. Build the first usable UI.
5. Add progress events.
6. Add frame analysis.
7. Add scheduler.
8. Add OKLab/Lab quantizer.
9. Add dither modes.
10. Add optimizer.
11. Add candidate preview.
12. Package portable Windows release.
