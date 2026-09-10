mod backend_registry;
pub(crate) mod compression_search;
mod content_probe;
mod contracts;
mod errors;
mod ffmpeg;
mod gif_strategy;
mod indexed_gif;
mod live_photo;
mod palette;
mod palette_sequence;
mod perceptual;
mod region_dither;
mod regional_quantize;
mod target_route;
mod target_size;

pub use backend_registry::discover_backends;
pub(crate) use backend_registry::{
    probe_h264_encoder, probe_h264_media_foundation_hardware, probe_screen_capture_chain,
    FfmpegH264Encoder,
};
pub use content_probe::{probe_content, QuickContentProbe};
pub use contracts::{
    BackendCapability, BackendStatus, OutputFormat, ENCODE_REQUEST_SCHEMA_VERSION,
};
pub use errors::AppError;
pub use ffmpeg::{animation_demux_args, locate_ffmpeg, locate_ffprobe};
pub use gif_strategy::{
    plan_ffmpeg_gif, ContentProfile, FfmpegGifDither, FfmpegGifPlan, GifGenerationMode,
    PaletteStatsMode, StrategyInput,
};
pub use indexed_gif::{
    compact_indexed_palette_tables, optimize_full_frames_to_change_rectangles,
    optimize_transparent_full_frames_by_bytes, write_indexed_gif, IndexedGifDisposal,
    IndexedGifFrame, IndexedGifOptimizationReport, IndexedGifPlan, IndexedGifRepeat,
    IndexedGifWriteReport, GIF_TRANSPARENT_INDEX,
};
pub(crate) use live_photo::{
    finalize_mov_live_photo, stamp_jpeg_asset_identifier, verify_live_photo_pair,
};
#[cfg(test)]
pub use palette::build_oklab_palette_from_contiguous_rgb24;
pub(crate) use palette::oklab_distance_srgb8;
#[allow(unused_imports)] // Options API is consumed by the next command-layer integration.
pub use palette::{
    build_oklab_palette_from_contiguous_rgb24_with_options,
    build_oklab_palette_from_contiguous_rgb24_with_precision,
    build_oklab_palette_from_contiguous_rgb24_with_precision_and_options,
    build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_options,
    build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_precision,
    build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_precision_and_options,
    OklabPaletteArtifact, OklabPaletteSequenceArtifact, PaletteBuildOptions, PaletteError,
    PaletteFrameRange, PaletteHistogramPrecision,
};
pub use palette_sequence::{plan_palette_segments, PaletteSegmentationArtifact};
pub use perceptual::{
    analyze_rgb_frames, schedule_frames, PerceptualFocus, PerceptualSummary, Rgb24Frame,
    SchedulerConfig,
};
pub use region_dither::{
    build_region_dither_plan_from_contiguous_rgb24, RegionDitherArtifact, REGION_DITHER_GRID_SIDE,
};
pub use regional_quantize::{
    error_diffusion_v5_kernel_config_sha256, evaluate_rgb24_candidate,
    evaluate_timing_aware_temporal_residual, phase_locked_pair_kernel_config_sha256,
    quantize_rgb24_with_region,
    quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback,
    quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback,
    quantize_rgb24_with_region_temporal_hysteresis_with_delays, PhaseLockedPairDiagnostics,
    QuantizationMetrics, RegionalQuantizationReport, TemporalHysteresisPolicy,
    TimingAwareTemporalResidual,
};
pub use target_route::{select_target_route, TargetRouteObservation, TargetRouteTimeline};
pub use target_size::{
    correct_reinvestment_overshoot, estimate_reinvestment_size, reinvest_target_savings,
    symmetric_target_deviation_percent, TargetCandidate, TargetConstraint, TargetFit,
    TargetObservation, TargetPreference, TargetSizeSearch, REINVEST_SPATIAL_SAFETY_FACTOR,
};
