# Perceptual GIF Core API Sketch

This sketch defines the Rust core boundaries before implementation. It is intentionally small and should evolve only when the MVP needs it.

## Module Map

```text
core/
  mod.rs
  types.rs
  ffmpeg.rs
  probe.rs
  analyzer.rs
  scheduler.rs
  color.rs
  quantizer.rs
  dither.rs
  profiles.rs
  optimizer.rs
  export.rs
  report.rs
```

## Public Command Layer

Tauri commands should stay thin:

```rust
pub async fn probe_video(path: String) -> Result<VideoMetadata, AppError>;

pub async fn create_gif_job(
    input_path: String,
    output_dir: String,
    request: CompressionRequest,
) -> Result<JobId, AppError>;

pub async fn cancel_job(job_id: JobId) -> Result<(), AppError>;
```

The command layer should not contain algorithm decisions. It validates input, starts jobs, and streams events.

## Core Types

```rust
pub type JobId = String;

#[derive(Clone, Debug)]
pub struct CompressionRequest {
    pub mode: CompressionMode,
    pub target_size_bytes: Option<u64>,
    pub max_width: Option<u32>,
    pub candidate_count: u8,
    pub loop_output: bool,
}

#[derive(Clone, Debug)]
pub enum CompressionMode {
    Auto,
    Emoji,
    Clip,
    Pixel,
}

#[derive(Clone, Debug)]
pub struct VideoMetadata {
    pub path: String,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub estimated_frame_count: u32,
}

#[derive(Clone, Debug)]
pub struct AnalysisFrame {
    pub index: u32,
    pub timestamp_ms: u64,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct FrameSignal {
    pub index: u32,
    pub timestamp_ms: u64,
    pub motion_score: f32,
    pub scene_change_score: f32,
    pub edge_score: f32,
    pub compression_cost: f32,
}

#[derive(Clone, Debug)]
pub struct ScheduledFrame {
    pub source_index: u32,
    pub timestamp_ms: u64,
    pub delay_ms: u16,
    pub importance: f32,
}

#[derive(Clone, Debug)]
pub struct FrameTimeline {
    pub frames: Vec<ScheduledFrame>,
    pub source_duration_ms: u64,
}

#[derive(Clone, Debug)]
pub struct Palette {
    pub colors_rgba: Vec<[u8; 4]>,
}

#[derive(Clone, Debug)]
pub struct CandidateSettings {
    pub width: u32,
    pub palette_size: u16,
    pub dither_mode: DitherMode,
    pub lossy_level: u8,
}

#[derive(Clone, Debug)]
pub struct GifCandidate {
    pub path: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub quality_score: f32,
    pub settings: CandidateSettings,
}
```

## Pipeline Interface

```rust
pub fn probe_video(path: &str) -> Result<VideoMetadata, AppError>;

pub fn extract_analysis_frames(
    input_path: &str,
    metadata: &VideoMetadata,
    analysis_width: u32,
) -> Result<Vec<AnalysisFrame>, AppError>;

pub fn analyze_frames(frames: &[AnalysisFrame]) -> Vec<FrameSignal>;

pub fn schedule_frames(
    metadata: &VideoMetadata,
    signals: &[FrameSignal],
    profile: &CompressionProfile,
) -> FrameTimeline;

pub fn build_palette(
    frames: &[AnalysisFrame],
    timeline: &FrameTimeline,
    profile: &CompressionProfile,
    palette_size: u16,
) -> Result<Palette, AppError>;

pub fn optimize_candidates(
    input_path: &str,
    metadata: &VideoMetadata,
    signals: &[FrameSignal],
    request: &CompressionRequest,
) -> Result<Vec<GifCandidate>, AppError>;
```

## Analyzer Contract

Analyzer output must be normalized to `0.0..=1.0`.

Signal meanings:

- `motion_score`: how much the frame differs from previous nearby frames.
- `scene_change_score`: how likely this frame starts a new scene.
- `edge_score`: how much fine structure/text/UI is present.
- `compression_cost`: how expensive the frame is likely to encode.

The analyzer should avoid making final keep/drop decisions.

## Scheduler Contract

Scheduler consumes normalized signals and produces a timeline.

Rules:

- Preserve the first frame.
- Preserve strong scene boundaries.
- Avoid delays below GIF/browser-safe thresholds.
- Merge low-importance spans into longer delays.
- Respect profile-specific motion budgets.

Scheduler should not know about color palettes or GIF bitstream encoding.

## Palette Contract

The palette builder consumes sampled frames and a timeline.

Rules:

- Selected frames matter more than discarded frames.
- High-importance frames matter more than low-importance frames.
- OKLab/OKLCH distance is preferred internally.
- Output palette is RGBA because GIF encoders ultimately need indexed colors.

MVP can use one global palette. V1 may introduce segment palettes.

## Optimizer Contract

Optimizer is allowed to call scheduler, palette, dither, and encoder repeatedly.

It owns search strategy:

```text
target miss too large -> reduce width
target miss medium -> reduce frame count or palette size
motion score poor -> restore frames before increasing colors
color score poor -> increase palette before adding frames
text clarity poor -> reduce dither and preserve edge-heavy frames
```

The optimizer should return one or more concrete candidates, never vague parameter suggestions.

## Progress Events

```rust
pub enum JobPhase {
    Probing,
    Analyzing,
    Scheduling,
    Quantizing,
    Encoding,
    Finalizing,
    Complete,
    Failed,
}

pub struct JobProgress {
    pub job_id: JobId,
    pub phase: JobPhase,
    pub percent: f32,
    pub message: String,
}
```

Progress messages should be short and product-like:

- Reading video.
- Finding motion.
- Building palette.
- Testing candidates.
- Writing GIF.

## Error Model

```rust
pub enum AppError {
    InvalidInput(String),
    UnsupportedVideo(String),
    MissingDependency(String),
    DecodeFailed(String),
    EncodeFailed(String),
    Cancelled,
    Internal(String),
}
```

Errors shown to users should be rewritten into plain language by the UI. Raw FFmpeg output belongs in logs, not primary UI.

## First Implementation Shortcut

For the first working prototype, use this reduced pipeline:

```text
probe_video
  -> baseline_ffmpeg_export
  -> GifCandidate
```

Then expand to:

```text
probe_video
  -> extract_analysis_frames
  -> analyze_frames
  -> schedule_frames
  -> baseline_ffmpeg_export_with_selected_fps_or_filters
```

Only after that should the custom palette and dither pipeline replace the FFmpeg palette path.

