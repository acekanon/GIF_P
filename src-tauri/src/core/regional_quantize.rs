//! Deterministic region-aware RGB24 to indexed-palette quantization.
//!
//! The quantizer consumes the already-audited OKLab palette and 16x16 region
//! artifact. A fixed spatial Bayer phase avoids injecting frame-to-frame phase
//! noise; low-strength flat/text cells stay close to nearest-color mapping,
//! while texture cells may mix the two nearest palette colors.

use super::{
    palette::{srgb8_to_oklab, Oklab, OklabPaletteArtifact},
    region_dither::RegionDitherArtifact,
};
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

const HISTOGRAM_SIDE: usize = 32;
const HISTOGRAM_LEN: usize = HISTOGRAM_SIDE * HISTOGRAM_SIDE * HISTOGRAM_SIDE;
const PALETTE_BUCKET_CANDIDATES: usize = 16;
const MAX_METRIC_SAMPLES: usize = 1_000_000;
const MAX_BANDING_SAMPLE_FRAMES: usize = 12;
const BANDING_PRESENTATION_WIDTH: usize = 320;
const BANDING_PRESENTATION_HEIGHT: usize = 180;
const BANDING_SCALE_WEIGHTS: [f64; 5] = [16.0, 8.0, 4.0, 2.0, 1.0];
// CAMBI's default BT.1886 visibility thresholds for 1..=4 code-value
// differences after converting limited-range 8-bit luma to 10-bit. A small
// step is visible farther into the highlights as its contrast increases.
const BANDING_TVI_MAX_LUMA_BY_DIFF: [u16; 4] = [178, 305, 432, 559];
const BAYER_8X8: [u8; 64] = [
    0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40,
    24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17, 45, 29, 10,
    58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
];
const TEMPORAL_MICRO_CHANGE_MAX_DELTA: u8 = 4;
const TEMPORAL_HYSTERESIS_MAX_HOLD_FRAMES: u8 = 8;
const TEMPORAL_HYSTERESIS_MAX_HOLD_DURATION_CS: u16 = 50;
#[allow(dead_code)]
const TEMPORAL_COMPAT_FRAME_DELAY_CS: u16 = 1;
const ERROR_DIFFUSION_FLAT_STRENGTH: f64 = 0.82;
const ERROR_DIFFUSION_SKIN_MIN_STRENGTH: f64 = 0.48;
const ERROR_DIFFUSION_SKIN_STRENGTH_RANGE: f64 = 0.24;
const ERROR_DIFFUSION_MIN_CELL_CHANNEL_RANGE: u8 = 3;
const ERROR_DIFFUSION_FLAT_MAX_MEAN_NEIGHBOR_DELTA: f64 = 10.0;
const ERROR_DIFFUSION_SKIN_MAX_MEAN_NEIGHBOR_DELTA: f64 = 18.0;
const ERROR_DIFFUSION_FLAT_MAX_EDGE_FRACTION: f64 = 0.025;
const ERROR_DIFFUSION_SKIN_MAX_EDGE_FRACTION: f64 = 0.10;
const ERROR_DIFFUSION_EDGE_DELTA: u8 = 24;
const ERROR_DIFFUSION_COHERENCE_FLAT_MAX_BOUNDARY_DELTA: f64 = 4.0;
const ERROR_DIFFUSION_COHERENCE_SKIN_MAX_BOUNDARY_DELTA: f64 = 8.0;
const ERROR_DIFFUSION_EDGE_HALO_RADIUS_PX: usize = 1;
const ERROR_DIFFUSION_SCENE_CUT_MEAN_DELTA: u64 = 12;
const ERROR_DIFFUSION_SCENE_CUT_PIXEL_DELTA: u8 = 24;
const ERROR_DIFFUSION_SCENE_CUT_CHANGED_PIXEL_DENOMINATOR: u64 = 4;
const ERROR_DIFFUSION_EDGE_CONDUCTANCE_STOP_OKLAB: f64 = 0.030;
const ERROR_DIFFUSION_EDGE_CONDUCTANCE_POWER: u8 = 2;
const ERROR_DIFFUSION_TEMPORAL_REGULARIZER_FRACTION: f64 = 0.5;
const ERROR_DIFFUSION_EDGE_GUARDED_ATTENUATION: f64 = 0.5;
const ERROR_DIFFUSION_FS_NUMERATORS: [u8; 4] = [7, 3, 5, 1];
const ERROR_DIFFUSION_FS_DENOMINATOR: u8 = 16;
const ERROR_DIFFUSION_FLAT_RESIDUAL_L_LIMIT: f64 = 0.060;
const ERROR_DIFFUSION_FLAT_RESIDUAL_CHROMA_LIMIT: f64 = 0.042;
const ERROR_DIFFUSION_SKIN_RESIDUAL_L_LIMIT: f64 = 0.040;
const ERROR_DIFFUSION_SKIN_RESIDUAL_CHROMA_LIMIT: f64 = 0.030;
// A held color must remain close to the current baseline choice. Text edges
// use the tightest allowance; flat fills can tolerate slightly more temporal
// stability, while texture deliberately remains under the spatial quantizer.
const TEMPORAL_HYSTERESIS_EXTRA_OKLAB_ERROR_BY_CLASS: [f64; 4] = [0.012, 0.006, 0.008, 0.0];
// The phase-locked pair kernel deliberately has a smaller temporal envelope
// than the older experimental kernels. Even if a caller supplies a more
// permissive policy, this route never exceeds CONSERVATIVE_V1 (2 frames / 16
// centiseconds).
const PHASE_LOCKED_PAIR_MAX_HOLD_FRAMES: u8 = 2;
const PHASE_LOCKED_PAIR_MAX_HOLD_DURATION_CS: u16 = 16;
const PHASE_LOCKED_PAIR_FLAT_MAX_SEGMENT_ERROR: f64 = 0.035;
const PHASE_LOCKED_PAIR_SKIN_MAX_SEGMENT_ERROR: f64 = 0.020;
const PHASE_LOCKED_PAIR_FLAT_MAX_ENDPOINT_ERROR: f64 = 0.220;
const PHASE_LOCKED_PAIR_SKIN_MAX_ENDPOINT_ERROR: f64 = 0.120;
const PHASE_LOCKED_PAIR_SKIN_MIN_HUE_CHROMA: f64 = 0.020;
const PHASE_LOCKED_PAIR_SKIN_MAX_HUE_DELTA_RADIANS: f64 = 0.523_598_775_598_298_8;
const PHASE_LOCKED_PAIR_SKIN_MAX_CHROMA_DELTA: f64 = 0.060;
const PHASE_LOCKED_PAIR_FLAT_TEMPORAL_EXTRA_ERROR: f64 = 0.010;
const PHASE_LOCKED_PAIR_SKIN_TEMPORAL_EXTRA_ERROR: f64 = 0.006;
// Stored-frame metrics are intentionally only a catastrophic-regression
// guard. Presentation-time decode/scale/loop gates belong to the command
// layer, where the actual GIF timing and disposal semantics are available.
const PHASE_LOCKED_PAIR_EARLY_REJECT_MEAN_ERROR_DELTA: f64 = 0.080;
const PHASE_LOCKED_PAIR_EARLY_REJECT_P95_ERROR_DELTA: f64 = 0.120;
const PHASE_LOCKED_PAIR_EARLY_REJECT_LOW_FREQUENCY_DELTA: f64 = 0.020;
const PHASE_LOCKED_PAIR_EARLY_REJECT_BANDING_DELTA: f64 = 0.050;
const PHASE_LOCKED_PAIR_EARLY_REJECT_EDGE_ERROR_DELTA: f64 = 0.050;
const PHASE_LOCKED_PAIR_EARLY_REJECT_TEMPORAL_DELTA: f64 = 0.030;

/// Bounded policy for the opt-in temporal-hysteresis quantizer.
///
/// `max_hold_frames` counts consecutive frames on which the previous index
/// overrides the current spatial choice. `max_hold_duration_cs` independently
/// limits the cumulative display duration of that hold streak. The v5 hybrid
/// kernel may grant exactly one over-budget VFR frame for a qualifying static
/// micro-change; that exception is counted explicitly in its diagnostics.
/// Both configured limits remain bounded so a caller cannot freeze genuine
/// motion through an unbounded policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TemporalHysteresisPolicy {
    pub max_hold_frames: u8,
    pub max_hold_duration_cs: u16,
}

impl TemporalHysteresisPolicy {
    pub const CONSERVATIVE_V1: Self = Self {
        max_hold_frames: 2,
        max_hold_duration_cs: 16,
    };

    fn bounded_max_hold_frames(self) -> u8 {
        self.max_hold_frames
            .min(TEMPORAL_HYSTERESIS_MAX_HOLD_FRAMES)
    }

    fn bounded_max_hold_duration_cs(self) -> u16 {
        self.max_hold_duration_cs
            .min(TEMPORAL_HYSTERESIS_MAX_HOLD_DURATION_CS)
    }
}

impl Default for TemporalHysteresisPolicy {
    fn default() -> Self {
        Self::CONSERVATIVE_V1
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QuantizationMetrics {
    pub sampled_pixel_count: u64,
    pub sampled_static_pixel_count: u64,
    pub mean_oklab_error: f64,
    pub p95_oklab_error: f64,
    pub edge_weighted_mean_oklab_error: f64,
    pub multiscale_low_frequency_oklab_error: f64,
    pub multiscale_banding_score: f64,
    pub edge_gradient_error: f64,
    pub static_temporal_residual: f64,
    pub multiscale_static_temporal_residual: f64,
}

/// Temporal-fidelity metrics weighted by each current frame's display time.
///
/// When `loops` is true in
/// [`evaluate_timing_aware_temporal_residual`], the last-to-first transition is
/// included in the weighted aggregate and is also reported separately. This
/// makes an infinite-loop seam independently gateable.
#[derive(Clone, Debug, PartialEq)]
pub struct TimingAwareTemporalResidual {
    pub sampled_static_transition_count: u64,
    pub weighted_static_sample_duration_cs: u64,
    pub weighted_static_temporal_residual: f64,
    pub sampled_multiscale_static_transition_count: u64,
    pub weighted_multiscale_static_sample_duration_cs: u64,
    pub weighted_multiscale_static_temporal_residual: f64,
    pub loop_seam_sampled_static_pixel_count: u64,
    pub loop_seam_static_temporal_residual: Option<f64>,
    pub loop_seam_sampled_multiscale_count: u64,
    pub loop_seam_multiscale_static_temporal_residual: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegionalQuantizationReport {
    pub frame_count: u32,
    pub pixel_count: u64,
    pub secondary_choice_count: u64,
    pub secondary_choice_by_class: [u64; 4],
    /// Number of pixels for which the opt-in temporal strategy retained the
    /// previous frame's palette index instead of the current spatial choice.
    pub temporal_hold_count: u64,
    pub temporal_hold_by_class: [u64; 4],
    /// Effective bounded policy values used for this artifact. They are zero
    /// for the spatial-only quantizer.
    pub temporal_policy_max_hold_frames: u8,
    pub temporal_policy_max_hold_duration_cs: u16,
    /// Sum of displayed centiseconds across held pixels and the longest
    /// consecutive held duration observed for any one pixel.
    pub temporal_hold_duration_cs: u64,
    pub temporal_max_observed_hold_duration_cs: u16,
    /// Stable identity of the spatial mapper that produced the pre-temporal
    /// index stream. Experimental kernels attach their own diagnostics.
    pub spatial_kernel_id: String,
    pub error_diffusion: Option<ErrorDiffusionDiagnostics>,
    pub phase_locked_pair: Option<PhaseLockedPairDiagnostics>,
    pub metrics: QuantizationMetrics,
    pub indices_sha256: String,
    pub reconstructed_rgb24_sha256: String,
    pub artifact_sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ErrorDiffusionDiagnostics {
    pub kernel_config_sha256: String,
    pub fallback_route_id: String,
    pub fallback_indices_sha256: String,
    pub gradient_eligibility_mask_sha256: String,
    pub edge_protection_mask_sha256: String,
    pub direct_gradient_eligible_cell_count: u64,
    pub coherence_rescued_cell_count: u64,
    pub coherence_rescued_pixel_count: u64,
    pub pre_protection_gradient_pixel_count: u64,
    pub gradient_eligible_pixel_count: u64,
    pub protected_edge_seed_pixel_count: u64,
    pub protected_edge_halo_pixel_count: u64,
    pub protected_edge_fallback_pixel_count: u64,
    pub protected_edge_index_change_count: u64,
    pub diffused_pixel_count: u64,
    pub diffused_pixel_by_class: [u64; 4],
    pub residual_clamp_count: u64,
    /// Retained for report compatibility. The v5 full-frame kernel never
    /// resets residual state at an artificial region-cell boundary.
    pub cell_reset_count: u64,
    pub frame_error_buffer_reset_count: u64,
    pub edge_guarded_pixel_count: u64,
    pub residual_link_candidate_count: u64,
    pub full_conductance_residual_link_count: u64,
    pub attenuated_residual_link_count: u64,
    pub blocked_residual_link_count: u64,
    pub cross_cell_candidate_link_count: u64,
    pub cross_cell_propagated_link_count: u64,
    pub cross_cell_rejected_class_count: u64,
    pub cross_cell_rejected_eligibility_count: u64,
    pub cross_cell_rejected_protection_count: u64,
    pub cross_cell_blocked_hard_edge_count: u64,
    pub protected_target_link_count: u64,
    pub fallback_preserved_pixel_count: u64,
    pub eligible_index_change_count: u64,
    pub ineligible_index_change_count: u64,
    pub eligible_index_change_rate: f64,
    pub temporal_regularized_hold_count: u64,
    pub temporal_prev_candidate_count: u64,
    pub temporal_prev_rejected_by_color_count: u64,
    pub temporal_prev_rejected_by_budget_count: u64,
    pub temporal_prev_rejected_by_regularizer_count: u64,
    pub temporal_vfr_single_frame_extension_count: u64,
    pub loop_seeded_pixel_count: u64,
    pub static_index_flip_count: u64,
    pub vfr_weighted_static_index_flip_rate: f64,
}

/// Auditable evidence for the conservative phase-locked two-color kernel.
///
/// The output always begins as the caller-provided FFmpeg index stream. Only
/// `eligible_pixel_count` pixels are allowed to consult a bracketing pair; all
/// other pixels must remain byte-identical to the fallback. Separate mask and
/// pair hashes let the command layer distinguish a changed algorithm decision
/// from a changed FFmpeg baseline.
#[derive(Clone, Debug, PartialEq)]
pub struct PhaseLockedPairDiagnostics {
    pub kernel_config_sha256: String,
    pub fallback_route_id: String,
    pub fallback_indices_sha256: String,
    pub pair_lookup_sha256: String,
    pub eligibility_mask_sha256: String,
    pub edge_protection_mask_sha256: String,
    pub opaque_fallback_pixel_count: u64,
    pub transparent_fallback_pixel_count: u64,
    pub smooth_region_pixel_count: u64,
    pub protected_edge_pixel_count: u64,
    pub non_micro_change_fallback_pixel_count: u64,
    pub scene_cut_fallback_pixel_count: u64,
    pub no_bracketing_pair_fallback_pixel_count: u64,
    pub eligible_pixel_count: u64,
    pub paired_pixel_count: u64,
    pub pair_candidate_count: u64,
    pub changed_pixel_count: u64,
    pub changed_pixel_by_class: [u64; 4],
    pub fallback_preserved_pixel_count: u64,
    pub protected_edge_index_change_count: u64,
    pub ineligible_index_change_count: u64,
    pub skin_pair_hue_rejection_count: u64,
    pub skin_pair_chroma_rejection_count: u64,
    pub temporal_candidate_count: u64,
    pub temporal_hold_count: u64,
    pub temporal_hold_by_class: [u64; 4],
    pub temporal_hold_duration_cs: u64,
    pub temporal_max_observed_hold_duration_cs: u16,
    pub temporal_rejected_by_pair_count: u64,
    pub temporal_rejected_by_color_count: u64,
    pub temporal_rejected_by_budget_count: u64,
    pub cut_reset_pixel_count: u64,
    pub loop_seeded_pixel_count: u64,
    pub fallback_static_index_flip_count: u64,
    pub static_index_flip_count: u64,
    pub fallback_vfr_weighted_static_index_flip_rate: f64,
    pub vfr_weighted_static_index_flip_rate: f64,
    pub fallback_loop_seam_static_index_flip_count: u64,
    pub loop_seam_static_index_flip_count: u64,
    pub stored_frame_early_reject_count: u64,
    pub pre_reject_changed_pixel_count: u64,
    pub pre_reject_temporal_hold_count: u64,
    pub fallback_mean_oklab_error: f64,
    pub candidate_mean_oklab_error: f64,
    pub fallback_multiscale_banding_score: f64,
    pub candidate_multiscale_banding_score: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegionalQuantizationArtifact {
    /// Contiguous row-major indexed frames.
    pub indices: Vec<u8>,
    /// Contiguous RGB24 reconstruction produced by `indices` and the palette.
    pub reconstructed_rgb24: Vec<u8>,
    pub report: RegionalQuantizationReport,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RegionalQuantizationError {
    ZeroDimensions,
    EmptyTimeline,
    DimensionOverflow,
    InvalidRgb24Size {
        expected_multiple: usize,
        actual: usize,
    },
    InvalidCandidateSize {
        expected: usize,
        actual: usize,
    },
    InvalidFallbackSize {
        expected: usize,
        actual: usize,
    },
    InvalidFallbackIndex {
        pixel_index: usize,
        index: u8,
        palette_entries: usize,
    },
    InvalidFrameDelayCount {
        expected: usize,
        actual: usize,
    },
    InvalidPalette,
    InvalidRegionMap {
        expected: usize,
        classes: usize,
        strengths: usize,
    },
    InvalidRegionClass {
        index: usize,
        value: u8,
    },
}

impl fmt::Display for RegionalQuantizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroDimensions => formatter.write_str("regional quantization dimensions must be non-zero"),
            Self::EmptyTimeline => formatter.write_str("regional quantization requires at least one RGB24 frame"),
            Self::DimensionOverflow => formatter.write_str("regional quantization dimensions overflow usize"),
            Self::InvalidRgb24Size {
                expected_multiple,
                actual,
            } => write!(
                formatter,
                "regional quantization received {actual} RGB24 bytes; expected a non-zero multiple of {expected_multiple}"
            ),
            Self::InvalidCandidateSize { expected, actual } => write!(
                formatter,
                "quantization metric candidate has {actual} RGB24 bytes; expected {expected}"
            ),
            Self::InvalidFallbackSize { expected, actual } => write!(
                formatter,
                "error-diffusion fallback has {actual} indices; expected {expected}"
            ),
            Self::InvalidFallbackIndex {
                pixel_index,
                index,
                palette_entries,
            } => write!(
                formatter,
                "error-diffusion fallback pixel {pixel_index} uses palette index {index}; palette has {palette_entries} opaque entries"
            ),
            Self::InvalidFrameDelayCount { expected, actual } => write!(
                formatter,
                "temporal quantization received {actual} frame delays; expected {expected}"
            ),
            Self::InvalidPalette => formatter.write_str(
                "regional quantization requires a canonical palette with at least one opaque entry",
            ),
            Self::InvalidRegionMap {
                expected,
                classes,
                strengths,
            } => write!(
                formatter,
                "regional quantization grid expects {expected} cells; class map has {classes} and strength map has {strengths}"
            ),
            Self::InvalidRegionClass { index, value } => write!(
                formatter,
                "regional quantization cell {index} has invalid class {value}"
            ),
        }
    }
}

impl Error for RegionalQuantizationError {}

#[derive(Clone, Copy, Debug)]
struct PaletteChoice {
    nearest: u8,
    secondary: u8,
    secondary_probability: f64,
}

#[derive(Clone, Copy, Debug)]
struct PaletteLookupBucket {
    indices: [u8; PALETTE_BUCKET_CANDIDATES],
    len: u8,
}

#[derive(Clone, Copy, Debug)]
struct RegionCellBounds {
    x_start: usize,
    x_end: usize,
    y_start: usize,
    y_end: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ErrorDiffusionV5LinkDiagnostics {
    candidate_count: u64,
    full_conductance_count: u64,
    attenuated_count: u64,
    blocked_count: u64,
    cross_cell_candidate_count: u64,
    cross_cell_propagated_count: u64,
    cross_cell_rejected_class_count: u64,
    cross_cell_rejected_eligibility_count: u64,
    cross_cell_rejected_protection_count: u64,
    cross_cell_blocked_hard_edge_count: u64,
    protected_target_count: u64,
}

impl RegionCellBounds {
    fn width(self) -> usize {
        self.x_end.saturating_sub(self.x_start)
    }

    fn pixel_count(self) -> usize {
        self.width()
            .saturating_mul(self.y_end.saturating_sub(self.y_start))
    }

    fn is_empty(self) -> bool {
        self.x_start >= self.x_end || self.y_start >= self.y_end
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct GradientCellStats {
    minimum: [u8; 3],
    maximum: [u8; 3],
    transition_sum: u64,
    transition_count: u64,
    edge_count: u64,
}

impl GradientCellStats {
    fn channel_range(self) -> u8 {
        (0..3)
            .map(|channel| self.maximum[channel].saturating_sub(self.minimum[channel]))
            .max()
            .unwrap_or(0)
    }

    fn include(&mut self, other: Self) {
        for channel in 0..3 {
            self.minimum[channel] = self.minimum[channel].min(other.minimum[channel]);
            self.maximum[channel] = self.maximum[channel].max(other.maximum[channel]);
        }
        self.transition_sum = self.transition_sum.saturating_add(other.transition_sum);
        self.transition_count = self.transition_count.saturating_add(other.transition_count);
        self.edge_count = self.edge_count.saturating_add(other.edge_count);
    }
}

#[derive(Clone, Debug, PartialEq)]
struct ErrorDiffusionEligibilityPlan {
    strengths: Vec<f64>,
    direct: Vec<bool>,
    coherence_rescued: Vec<bool>,
}

#[derive(Clone, Debug, PartialEq)]
struct EdgeProtectionPlan {
    seeds: Vec<bool>,
    protected: Vec<bool>,
}

#[derive(Clone, Copy, Debug)]
struct PhaseLockedPairChoice {
    alternate: u8,
    /// Number of the 64 fixed Bayer ranks that select `alternate`.
    alternate_rank_cutoff: u8,
    segment_error_squared: f64,
    segment_span_squared: f64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct PhaseLockedPairSearchDiagnostics {
    candidate_count: u64,
    skin_hue_rejection_count: u64,
    skin_chroma_rejection_count: u64,
}

pub fn quantize_rgb24_with_region(
    pixels: &[u8],
    width: u16,
    height: u16,
    palette: &OklabPaletteArtifact,
    regions: &RegionDitherArtifact,
) -> Result<RegionalQuantizationArtifact, RegionalQuantizationError> {
    let layout = validate_layout(pixels, width, height)?;
    let palette_rgb = opaque_palette_rgb(palette)?;
    validate_regions(regions)?;
    let palette_labs = palette_rgb
        .iter()
        .copied()
        .map(srgb8_to_oklab)
        .collect::<Vec<_>>();
    let lookup = build_choice_lookup(&palette_labs);
    let mut indices = Vec::with_capacity(layout.total_pixels);
    let mut reconstructed = Vec::with_capacity(pixels.len());
    let mut secondary_choice_count = 0_u64;
    let mut secondary_choice_by_class = [0_u64; 4];

    for frame in pixels.chunks_exact(layout.frame_bytes) {
        for (pixel_index, rgb) in frame.chunks_exact(3).enumerate() {
            let x = pixel_index % layout.width;
            let y = pixel_index / layout.width;
            let cell_x =
                region_cell_coordinate_for_pixel(x, layout.width, usize::from(regions.grid_width));
            let cell_y = region_cell_coordinate_for_pixel(
                y,
                layout.height,
                usize::from(regions.grid_height),
            );
            let cell = cell_y * usize::from(regions.grid_width) + cell_x;
            let class = usize::from(regions.class_map[cell]);
            let strength = f64::from(regions.strength_map[cell]) / 255.0;
            let source_rgb = [rgb[0], rgb[1], rgb[2]];
            let choice = palette_choice(
                source_rgb,
                lookup[histogram_index(rgb[0], rgb[1], rgb[2])],
                &palette_labs,
            );
            let threshold = (f64::from(BAYER_8X8[(y & 7) * 8 + (x & 7)]) + 0.5) / 64.0;
            let use_secondary = choice.secondary != choice.nearest
                && threshold < choice.secondary_probability * strength;
            let index = if use_secondary {
                secondary_choice_count = secondary_choice_count.saturating_add(1);
                secondary_choice_by_class[class] =
                    secondary_choice_by_class[class].saturating_add(1);
                choice.secondary
            } else {
                choice.nearest
            };
            indices.push(index);
            reconstructed.extend_from_slice(&palette_rgb[usize::from(index)]);
        }
    }

    let metrics = evaluate_rgb24_candidate(pixels, &reconstructed, width, height)?;
    let indices_sha256 = format!("{:x}", Sha256::digest(&indices));
    let reconstructed_rgb24_sha256 = format!("{:x}", Sha256::digest(&reconstructed));
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.v3\0");
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(layout.frame_count.to_le_bytes());
    hasher.update(palette.sha256.as_bytes());
    hasher.update(regions.sha256.as_bytes());
    hasher.update(indices_sha256.as_bytes());
    hasher.update(reconstructed_rgb24_sha256.as_bytes());
    hasher.update(metrics.mean_oklab_error.to_bits().to_le_bytes());
    hasher.update(metrics.p95_oklab_error.to_bits().to_le_bytes());
    hasher.update(
        metrics
            .edge_weighted_mean_oklab_error
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(
        metrics
            .multiscale_low_frequency_oklab_error
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(metrics.multiscale_banding_score.to_bits().to_le_bytes());
    hasher.update(metrics.edge_gradient_error.to_bits().to_le_bytes());
    hasher.update(metrics.static_temporal_residual.to_bits().to_le_bytes());
    hasher.update(
        metrics
            .multiscale_static_temporal_residual
            .to_bits()
            .to_le_bytes(),
    );
    let artifact_sha256 = format!("{:x}", hasher.finalize());
    Ok(RegionalQuantizationArtifact {
        indices,
        reconstructed_rgb24: reconstructed,
        report: RegionalQuantizationReport {
            frame_count: layout.frame_count,
            pixel_count: u64::try_from(layout.total_pixels)
                .map_err(|_| RegionalQuantizationError::DimensionOverflow)?,
            secondary_choice_count,
            secondary_choice_by_class,
            temporal_hold_count: 0,
            temporal_hold_by_class: [0; 4],
            temporal_policy_max_hold_frames: 0,
            temporal_policy_max_hold_duration_cs: 0,
            temporal_hold_duration_cs: 0,
            temporal_max_observed_hold_duration_cs: 0,
            spatial_kernel_id: "ordered_bayer_8x8_v3".to_string(),
            error_diffusion: None,
            phase_locked_pair: None,
            metrics,
            indices_sha256,
            reconstructed_rgb24_sha256,
            artifact_sha256,
        },
    })
}

/// Compatibility entry point for callers without an explicit VFR timeline.
///
/// Each frame is conservatively treated as one centisecond. New encoding
/// paths should call [`quantize_rgb24_with_region_temporal_hysteresis_with_delays`]
/// with the actual frame delays so both temporal bounds are meaningful.
#[allow(dead_code)]
pub fn quantize_rgb24_with_region_temporal_hysteresis(
    pixels: &[u8],
    width: u16,
    height: u16,
    palette: &OklabPaletteArtifact,
    regions: &RegionDitherArtifact,
    policy: TemporalHysteresisPolicy,
) -> Result<RegionalQuantizationArtifact, RegionalQuantizationError> {
    let layout = validate_layout(pixels, width, height)?;
    let frame_delays_cs = vec![
        TEMPORAL_COMPAT_FRAME_DELAY_CS;
        usize::try_from(layout.frame_count)
            .map_err(|_| RegionalQuantizationError::DimensionOverflow)?
    ];
    quantize_rgb24_with_region_temporal_hysteresis_with_delays(
        pixels,
        width,
        height,
        palette,
        regions,
        &frame_delays_cs,
        policy,
    )
}

/// Quantizes RGB24 frames with a conservative, explicitly opt-in temporal
/// hysteresis pass layered over the existing region-aware spatial quantizer.
///
/// Only flat, text-edge, and skin/subject cells may retain an index, and only
/// while the source changes by at most four code values per channel. The
/// previous color must still be one of the two closest palette candidates and
/// remain within a class-specific OKLab error allowance. A hold is released as
/// soon as either its frame-count or cumulative display-duration budget is
/// exhausted. Texture cells and obvious motion always use the current-frame
/// spatial choice immediately.
pub fn quantize_rgb24_with_region_temporal_hysteresis_with_delays(
    pixels: &[u8],
    width: u16,
    height: u16,
    palette: &OklabPaletteArtifact,
    regions: &RegionDitherArtifact,
    frame_delays_cs: &[u16],
    policy: TemporalHysteresisPolicy,
) -> Result<RegionalQuantizationArtifact, RegionalQuantizationError> {
    let layout = validate_layout(pixels, width, height)?;
    let frame_count = usize::try_from(layout.frame_count)
        .map_err(|_| RegionalQuantizationError::DimensionOverflow)?;
    let normalized_frame_delays_cs = normalize_frame_delays(frame_delays_cs, frame_count)?;
    let palette_rgb = opaque_palette_rgb(palette)?;
    validate_regions(regions)?;
    let palette_labs = palette_rgb
        .iter()
        .copied()
        .map(srgb8_to_oklab)
        .collect::<Vec<_>>();
    let lookup = build_choice_lookup(&palette_labs);
    let max_hold_frames = policy.bounded_max_hold_frames();
    let max_hold_duration_cs = policy.bounded_max_hold_duration_cs();
    let mut indices = Vec::with_capacity(layout.total_pixels);
    let mut reconstructed = Vec::with_capacity(pixels.len());
    let mut secondary_choice_count = 0_u64;
    let mut secondary_choice_by_class = [0_u64; 4];
    let mut temporal_hold_count = 0_u64;
    let mut temporal_hold_by_class = [0_u64; 4];
    let mut temporal_hold_duration_cs = 0_u64;
    let mut temporal_max_observed_hold_duration_cs = 0_u16;
    let mut previous_indices = vec![0_u8; layout.pixels_per_frame];
    let mut hold_ages = vec![0_u8; layout.pixels_per_frame];
    let mut hold_durations_cs = vec![0_u16; layout.pixels_per_frame];

    for (frame_index, frame) in pixels.chunks_exact(layout.frame_bytes).enumerate() {
        let frame_delay_cs = normalized_frame_delays_cs[frame_index];
        let previous_frame = frame_index.checked_sub(1).map(|previous_index| {
            let start = previous_index * layout.frame_bytes;
            &pixels[start..start + layout.frame_bytes]
        });
        for (pixel_index, rgb) in frame.chunks_exact(3).enumerate() {
            let x = pixel_index % layout.width;
            let y = pixel_index / layout.width;
            let cell_x =
                region_cell_coordinate_for_pixel(x, layout.width, usize::from(regions.grid_width));
            let cell_y = region_cell_coordinate_for_pixel(
                y,
                layout.height,
                usize::from(regions.grid_height),
            );
            let cell = cell_y * usize::from(regions.grid_width) + cell_x;
            let class = usize::from(regions.class_map[cell]);
            let strength = f64::from(regions.strength_map[cell]) / 255.0;
            let source_rgb = [rgb[0], rgb[1], rgb[2]];
            let choice = palette_choice(
                source_rgb,
                lookup[histogram_index(rgb[0], rgb[1], rgb[2])],
                &palette_labs,
            );
            let threshold = (f64::from(BAYER_8X8[(y & 7) * 8 + (x & 7)]) + 0.5) / 64.0;
            let use_secondary = choice.secondary != choice.nearest
                && threshold < choice.secondary_probability * strength;
            let spatial_index = if use_secondary {
                choice.secondary
            } else {
                choice.nearest
            };
            let mut index = spatial_index;

            if let Some(previous_frame) = previous_frame {
                let previous_byte = pixel_index * 3;
                let previous_source = rgb_at(previous_frame, previous_byte);
                let previous_index = previous_indices[pixel_index];
                let previous_is_current_candidate =
                    previous_index == choice.nearest || previous_index == choice.secondary;
                let micro_change = max_channel_delta(source_rgb, previous_source)
                    <= TEMPORAL_MICRO_CHANGE_MAX_DELTA;
                let eligible_class = class < 3;
                let below_frame_limit = hold_ages[pixel_index] < max_hold_frames;
                let next_hold_duration_cs =
                    hold_durations_cs[pixel_index].saturating_add(frame_delay_cs);
                let below_duration_limit = next_hold_duration_cs <= max_hold_duration_cs;

                if max_hold_frames > 0
                    && max_hold_duration_cs > 0
                    && eligible_class
                    && micro_change
                    && below_frame_limit
                    && below_duration_limit
                    && previous_index != spatial_index
                    && previous_is_current_candidate
                {
                    let source_lab = srgb8_to_oklab(source_rgb);
                    let previous_source_lab = srgb8_to_oklab(previous_source);
                    let spatial_error = source_lab
                        .distance_squared(palette_labs[usize::from(spatial_index)])
                        .sqrt();
                    let previous_error = source_lab
                        .distance_squared(palette_labs[usize::from(previous_index)])
                        .sqrt();
                    let source_delta = source_lab.distance_squared(previous_source_lab).sqrt();
                    let spatial_delta = palette_labs[usize::from(spatial_index)]
                        .distance_squared(palette_labs[usize::from(previous_index)])
                        .sqrt();
                    let held_temporal_residual = source_delta;
                    let spatial_temporal_residual = (spatial_delta - source_delta).abs();
                    if previous_error
                        <= spatial_error + TEMPORAL_HYSTERESIS_EXTRA_OKLAB_ERROR_BY_CLASS[class]
                        && held_temporal_residual + f64::EPSILON < spatial_temporal_residual
                    {
                        index = previous_index;
                        hold_ages[pixel_index] = hold_ages[pixel_index].saturating_add(1);
                        hold_durations_cs[pixel_index] = next_hold_duration_cs;
                        temporal_hold_count = temporal_hold_count.saturating_add(1);
                        temporal_hold_by_class[class] =
                            temporal_hold_by_class[class].saturating_add(1);
                        temporal_hold_duration_cs =
                            temporal_hold_duration_cs.saturating_add(u64::from(frame_delay_cs));
                        temporal_max_observed_hold_duration_cs =
                            temporal_max_observed_hold_duration_cs.max(next_hold_duration_cs);
                    } else {
                        hold_ages[pixel_index] = 0;
                        hold_durations_cs[pixel_index] = 0;
                    }
                } else {
                    hold_ages[pixel_index] = 0;
                    hold_durations_cs[pixel_index] = 0;
                }
            } else {
                hold_ages[pixel_index] = 0;
                hold_durations_cs[pixel_index] = 0;
            }

            if index == choice.secondary && choice.secondary != choice.nearest {
                secondary_choice_count = secondary_choice_count.saturating_add(1);
                secondary_choice_by_class[class] =
                    secondary_choice_by_class[class].saturating_add(1);
            }
            previous_indices[pixel_index] = index;
            indices.push(index);
            reconstructed.extend_from_slice(&palette_rgb[usize::from(index)]);
        }
    }

    let metrics = evaluate_rgb24_candidate(pixels, &reconstructed, width, height)?;
    let indices_sha256 = format!("{:x}", Sha256::digest(&indices));
    let reconstructed_rgb24_sha256 = format!("{:x}", Sha256::digest(&reconstructed));
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.temporal-hysteresis.v3\0");
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(layout.frame_count.to_le_bytes());
    hasher.update([max_hold_frames]);
    hasher.update(max_hold_duration_cs.to_le_bytes());
    for delay in &normalized_frame_delays_cs {
        hasher.update(delay.to_le_bytes());
    }
    hasher.update(palette.sha256.as_bytes());
    hasher.update(regions.sha256.as_bytes());
    hasher.update(indices_sha256.as_bytes());
    hasher.update(reconstructed_rgb24_sha256.as_bytes());
    hasher.update(temporal_hold_count.to_le_bytes());
    for count in temporal_hold_by_class {
        hasher.update(count.to_le_bytes());
    }
    hasher.update(temporal_hold_duration_cs.to_le_bytes());
    hasher.update(temporal_max_observed_hold_duration_cs.to_le_bytes());
    hasher.update(metrics.mean_oklab_error.to_bits().to_le_bytes());
    hasher.update(metrics.p95_oklab_error.to_bits().to_le_bytes());
    hasher.update(
        metrics
            .edge_weighted_mean_oklab_error
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(
        metrics
            .multiscale_low_frequency_oklab_error
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(metrics.multiscale_banding_score.to_bits().to_le_bytes());
    hasher.update(metrics.edge_gradient_error.to_bits().to_le_bytes());
    hasher.update(metrics.static_temporal_residual.to_bits().to_le_bytes());
    hasher.update(
        metrics
            .multiscale_static_temporal_residual
            .to_bits()
            .to_le_bytes(),
    );
    let artifact_sha256 = format!("{:x}", hasher.finalize());
    Ok(RegionalQuantizationArtifact {
        indices,
        reconstructed_rgb24: reconstructed,
        report: RegionalQuantizationReport {
            frame_count: layout.frame_count,
            pixel_count: u64::try_from(layout.total_pixels)
                .map_err(|_| RegionalQuantizationError::DimensionOverflow)?,
            secondary_choice_count,
            secondary_choice_by_class,
            temporal_hold_count,
            temporal_hold_by_class,
            temporal_policy_max_hold_frames: max_hold_frames,
            temporal_policy_max_hold_duration_cs: max_hold_duration_cs,
            temporal_hold_duration_cs,
            temporal_max_observed_hold_duration_cs,
            spatial_kernel_id: "ordered_bayer_8x8_v3".to_string(),
            error_diffusion: None,
            phase_locked_pair: None,
            metrics,
            indices_sha256,
            reconstructed_rgb24_sha256,
            artifact_sha256,
        },
    })
}

/// Experimental GIFP-owned spatial kernel for smooth gradients and skin.
///
/// Eligible region cells use deterministic serpentine Floyd-Steinberg error
/// diffusion in OKLab. Error state is reset at every region-cell and frame
/// boundary; directional OKLab conductance additionally blocks residuals at
/// hard edges inside an eligible cell. Flat cells without a measured gradient
/// and text cells use nearest-color mapping; texture retains the stable
/// ordered-Bayer mapper. A bounded VFR-aware regularizer may retain a previous
/// flat/skin index only while its color error and hold budgets remain valid.
#[cfg(test)]
pub fn quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
    pixels: &[u8],
    width: u16,
    height: u16,
    palette: &OklabPaletteArtifact,
    regions: &RegionDitherArtifact,
    frame_delays_cs: &[u16],
    policy: TemporalHysteresisPolicy,
) -> Result<RegionalQuantizationArtifact, RegionalQuantizationError> {
    let layout = validate_layout(pixels, width, height)?;
    let frame_count = usize::try_from(layout.frame_count)
        .map_err(|_| RegionalQuantizationError::DimensionOverflow)?;
    let normalized_frame_delays_cs = normalize_frame_delays(frame_delays_cs, frame_count)?;
    let palette_rgb = opaque_palette_rgb(palette)?;
    validate_regions(regions)?;
    let palette_labs = palette_rgb
        .iter()
        .copied()
        .map(srgb8_to_oklab)
        .collect::<Vec<_>>();
    let lookup = build_choice_lookup(&palette_labs);
    let diffusion_strengths = plan_error_diffusion_strengths(pixels, &layout, regions);
    let kernel_config_sha256 = error_diffusion_kernel_config_sha256();
    let max_hold_frames = policy.bounded_max_hold_frames();
    let max_hold_duration_cs = policy.bounded_max_hold_duration_cs();
    let mut indices = vec![0_u8; layout.total_pixels];
    let mut reconstructed = vec![0_u8; pixels.len()];
    let mut secondary_choice_count = 0_u64;
    let mut secondary_choice_by_class = [0_u64; 4];
    let mut temporal_hold_count = 0_u64;
    let mut temporal_hold_by_class = [0_u64; 4];
    let mut temporal_hold_duration_cs = 0_u64;
    let mut temporal_max_observed_hold_duration_cs = 0_u16;
    let mut gradient_eligible_pixel_count = 0_u64;
    let mut diffused_pixel_count = 0_u64;
    let mut diffused_pixel_by_class = [0_u64; 4];
    let mut residual_clamp_count = 0_u64;
    let mut cell_reset_count = 0_u64;
    let mut edge_guarded_pixel_count = 0_u64;
    let mut attenuated_residual_link_count = 0_u64;
    let mut blocked_residual_link_count = 0_u64;
    let mut temporal_regularized_hold_count = 0_u64;
    let mut temporal_prev_candidate_count = 0_u64;
    let mut temporal_prev_rejected_by_color_count = 0_u64;
    let mut temporal_prev_rejected_by_budget_count = 0_u64;
    let mut temporal_prev_rejected_by_regularizer_count = 0_u64;
    let mut previous_indices = vec![0_u8; layout.pixels_per_frame];
    let mut hold_ages = vec![0_u8; layout.pixels_per_frame];
    let mut hold_durations_cs = vec![0_u16; layout.pixels_per_frame];
    let grid_width = usize::from(regions.grid_width);
    let grid_height = usize::from(regions.grid_height);
    let cell_count = grid_width * grid_height;
    let mut previous_diffusion_enabled = vec![false; cell_count];

    for (frame_index, frame_delay_cs) in normalized_frame_delays_cs
        .iter()
        .copied()
        .enumerate()
        .take(frame_count)
    {
        let frame_byte_offset = frame_index * layout.frame_bytes;
        let frame_pixel_offset = frame_index * layout.pixels_per_frame;
        let frame = &pixels[frame_byte_offset..frame_byte_offset + layout.frame_bytes];
        let frame_labs = frame
            .chunks_exact(3)
            .map(|rgb| srgb8_to_oklab([rgb[0], rgb[1], rgb[2]]))
            .collect::<Vec<_>>();
        let previous_frame = frame_index.checked_sub(1).map(|previous_index| {
            let start = previous_index * layout.frame_bytes;
            &pixels[start..start + layout.frame_bytes]
        });

        for cell_y in 0..grid_height {
            for cell_x in 0..grid_width {
                let cell = cell_y * grid_width + cell_x;
                let bounds = region_cell_bounds(&layout, regions, cell_x, cell_y);
                if bounds.is_empty() {
                    continue;
                }
                let class = usize::from(regions.class_map[cell]);
                let diffusion_strength = diffusion_strengths[frame_index * cell_count + cell];
                let diffusion_enabled = diffusion_strength > 0.0;
                let eligibility_changed =
                    frame_index > 0 && previous_diffusion_enabled[cell] != diffusion_enabled;
                let scene_cut = previous_frame
                    .map(|previous| cell_has_scene_cut(frame, previous, &layout, bounds))
                    .unwrap_or(false);
                let suppress_temporal_hold = eligibility_changed || scene_cut;
                if suppress_temporal_hold {
                    clear_cell_temporal_hold_state(
                        bounds,
                        &layout,
                        &mut hold_ages,
                        &mut hold_durations_cs,
                    );
                }
                previous_diffusion_enabled[cell] = diffusion_enabled;
                let cell_width = bounds.width();
                let mut error_buffers = diffusion_enabled.then(|| {
                    (
                        vec![Oklab::default(); cell_width + 2],
                        vec![Oklab::default(); cell_width + 2],
                    )
                });
                if diffusion_enabled {
                    cell_reset_count = cell_reset_count.saturating_add(1);
                    gradient_eligible_pixel_count = gradient_eligible_pixel_count
                        .saturating_add(u64::try_from(bounds.pixel_count()).unwrap_or(u64::MAX));
                }

                for (local_y, y) in (bounds.y_start..bounds.y_end).enumerate() {
                    let right_to_left = local_y % 2 == 1;
                    for step in 0..cell_width {
                        let x = if right_to_left {
                            bounds.x_end - 1 - step
                        } else {
                            bounds.x_start + step
                        };
                        let local_x = x - bounds.x_start;
                        let error_index = local_x + 1;
                        let pixel_index = y * layout.width + x;
                        let source_byte = pixel_index * 3;
                        let source_rgb = rgb_at(frame, source_byte);
                        let source_lab = frame_labs[pixel_index];
                        let bucket =
                            lookup[histogram_index(source_rgb[0], source_rgb[1], source_rgb[2])];
                        let choice = palette_choice(source_rgb, bucket, &palette_labs);
                        let mut spatial_index = choice.nearest;
                        let mut adjusted_source_lab = source_lab;
                        let mut carried_clamped = false;
                        let edge_attenuation = if class == 0 || class == 2 {
                            error_diffusion_pixel_edge_attenuation(
                                &frame_labs,
                                &layout,
                                bounds,
                                x,
                                y,
                            )
                        } else {
                            1.0
                        };
                        if diffusion_enabled
                            && edge_attenuation < ERROR_DIFFUSION_EDGE_GUARDED_ATTENUATION
                        {
                            edge_guarded_pixel_count = edge_guarded_pixel_count.saturating_add(1);
                        }

                        if let Some((current_errors, _)) = error_buffers.as_ref() {
                            let carried =
                                clamp_error_diffusion_residual(current_errors[error_index], class);
                            // Every incoming link was already weighted by its own
                            // directional conductance. Applying a second pixel-wide
                            // minimum here would erase valid same-surface residuals
                            // merely because another side of this pixel touches an edge.
                            adjusted_source_lab = add_oklab(source_lab, carried.0);
                            carried_clamped = carried.1;
                            spatial_index =
                                nearest_palette_index_for_lab(adjusted_source_lab, &palette_labs);
                        } else if class == 3 {
                            let strength = f64::from(regions.strength_map[cell]) / 255.0;
                            let threshold =
                                (f64::from(BAYER_8X8[(y & 7) * 8 + (x & 7)]) + 0.5) / 64.0;
                            if choice.secondary != choice.nearest
                                && threshold < choice.secondary_probability * strength
                            {
                                spatial_index = choice.secondary;
                            }
                        }

                        let mut index = spatial_index;
                        if !suppress_temporal_hold {
                            if let Some(previous_frame) = previous_frame {
                                let previous_source = rgb_at(previous_frame, source_byte);
                                let previous_index = previous_indices[pixel_index];
                                let micro_change_delta =
                                    max_channel_delta(source_rgb, previous_source);
                                let micro_change =
                                    micro_change_delta <= TEMPORAL_MICRO_CHANGE_MAX_DELTA;
                                let eligible_class = class == 0 || class == 2;
                                let below_frame_limit = hold_ages[pixel_index] < max_hold_frames;
                                let next_hold_duration_cs =
                                    hold_durations_cs[pixel_index].saturating_add(frame_delay_cs);
                                let below_duration_limit =
                                    next_hold_duration_cs <= max_hold_duration_cs;

                                if max_hold_frames > 0
                                    && max_hold_duration_cs > 0
                                    && eligible_class
                                    && micro_change
                                    && previous_index != spatial_index
                                    && usize::from(previous_index) < palette_labs.len()
                                {
                                    temporal_prev_candidate_count =
                                        temporal_prev_candidate_count.saturating_add(1);
                                    if !below_frame_limit || !below_duration_limit {
                                        temporal_prev_rejected_by_budget_count =
                                            temporal_prev_rejected_by_budget_count
                                                .saturating_add(1);
                                        hold_ages[pixel_index] = 0;
                                        hold_durations_cs[pixel_index] = 0;
                                    } else {
                                        let spatial_error = source_lab
                                            .distance_squared(
                                                palette_labs[usize::from(spatial_index)],
                                            )
                                            .sqrt();
                                        let previous_error = source_lab
                                            .distance_squared(
                                                palette_labs[usize::from(previous_index)],
                                            )
                                            .sqrt();
                                        let extra_error =
                                            TEMPORAL_HYSTERESIS_EXTRA_OKLAB_ERROR_BY_CLASS[class];
                                        if previous_error > spatial_error + extra_error {
                                            temporal_prev_rejected_by_color_count =
                                                temporal_prev_rejected_by_color_count
                                                    .saturating_add(1);
                                            hold_ages[pixel_index] = 0;
                                            hold_durations_cs[pixel_index] = 0;
                                        } else {
                                            let micro_factor = (1.0
                                                - f64::from(micro_change_delta)
                                                    / f64::from(TEMPORAL_MICRO_CHANGE_MAX_DELTA))
                                            .clamp(0.0, 1.0);
                                            let regularizer_radius =
                                                ERROR_DIFFUSION_TEMPORAL_REGULARIZER_FRACTION
                                                    * extra_error
                                                    * micro_factor
                                                    * edge_attenuation;
                                            let regularizer =
                                                regularizer_radius * regularizer_radius;
                                            let spatial_adjusted_error = adjusted_source_lab
                                                .distance_squared(
                                                    palette_labs[usize::from(spatial_index)],
                                                );
                                            let previous_adjusted_error = adjusted_source_lab
                                                .distance_squared(
                                                    palette_labs[usize::from(previous_index)],
                                                );
                                            if previous_adjusted_error
                                                <= spatial_adjusted_error + regularizer
                                            {
                                                index = previous_index;
                                                hold_ages[pixel_index] =
                                                    hold_ages[pixel_index].saturating_add(1);
                                                hold_durations_cs[pixel_index] =
                                                    next_hold_duration_cs;
                                                temporal_hold_count =
                                                    temporal_hold_count.saturating_add(1);
                                                temporal_hold_by_class[class] =
                                                    temporal_hold_by_class[class].saturating_add(1);
                                                temporal_hold_duration_cs =
                                                    temporal_hold_duration_cs
                                                        .saturating_add(u64::from(frame_delay_cs));
                                                temporal_max_observed_hold_duration_cs =
                                                    temporal_max_observed_hold_duration_cs
                                                        .max(next_hold_duration_cs);
                                                temporal_regularized_hold_count =
                                                    temporal_regularized_hold_count
                                                        .saturating_add(1);
                                            } else {
                                                temporal_prev_rejected_by_regularizer_count =
                                                    temporal_prev_rejected_by_regularizer_count
                                                        .saturating_add(1);
                                                hold_ages[pixel_index] = 0;
                                                hold_durations_cs[pixel_index] = 0;
                                            }
                                        }
                                    }
                                } else {
                                    hold_ages[pixel_index] = 0;
                                    hold_durations_cs[pixel_index] = 0;
                                }
                            } else {
                                hold_ages[pixel_index] = 0;
                                hold_durations_cs[pixel_index] = 0;
                            }
                        } else {
                            hold_ages[pixel_index] = 0;
                            hold_durations_cs[pixel_index] = 0;
                        }

                        if let Some((current_errors, next_errors)) = error_buffers.as_mut() {
                            let (residual, residual_clamped) = emitted_error_diffusion_residual(
                                adjusted_source_lab,
                                index,
                                &palette_labs,
                                diffusion_strength,
                                class,
                            );
                            if carried_clamped || residual_clamped {
                                residual_clamp_count = residual_clamp_count.saturating_add(1);
                            }
                            if index == spatial_index && spatial_index != choice.nearest {
                                diffused_pixel_count = diffused_pixel_count.saturating_add(1);
                                diffused_pixel_by_class[class] =
                                    diffused_pixel_by_class[class].saturating_add(1);
                            }
                            let conductance_to = |neighbor_x: usize, neighbor_y: usize| {
                                error_diffusion_edge_conductance(
                                    source_lab,
                                    frame_labs[neighbor_y * layout.width + neighbor_x],
                                )
                            };
                            if right_to_left {
                                if x > bounds.x_start {
                                    add_edge_aware_error_diffusion_link(
                                        &mut current_errors[error_index - 1],
                                        residual,
                                        ERROR_DIFFUSION_FS_NUMERATORS[0],
                                        conductance_to(x - 1, y),
                                        &mut attenuated_residual_link_count,
                                        &mut blocked_residual_link_count,
                                    );
                                }
                                if y + 1 < bounds.y_end {
                                    if x + 1 < bounds.x_end {
                                        add_edge_aware_error_diffusion_link(
                                            &mut next_errors[error_index + 1],
                                            residual,
                                            ERROR_DIFFUSION_FS_NUMERATORS[1],
                                            conductance_to(x + 1, y + 1),
                                            &mut attenuated_residual_link_count,
                                            &mut blocked_residual_link_count,
                                        );
                                    }
                                    add_edge_aware_error_diffusion_link(
                                        &mut next_errors[error_index],
                                        residual,
                                        ERROR_DIFFUSION_FS_NUMERATORS[2],
                                        conductance_to(x, y + 1),
                                        &mut attenuated_residual_link_count,
                                        &mut blocked_residual_link_count,
                                    );
                                    if x > bounds.x_start {
                                        add_edge_aware_error_diffusion_link(
                                            &mut next_errors[error_index - 1],
                                            residual,
                                            ERROR_DIFFUSION_FS_NUMERATORS[3],
                                            conductance_to(x - 1, y + 1),
                                            &mut attenuated_residual_link_count,
                                            &mut blocked_residual_link_count,
                                        );
                                    }
                                }
                            } else {
                                if x + 1 < bounds.x_end {
                                    add_edge_aware_error_diffusion_link(
                                        &mut current_errors[error_index + 1],
                                        residual,
                                        ERROR_DIFFUSION_FS_NUMERATORS[0],
                                        conductance_to(x + 1, y),
                                        &mut attenuated_residual_link_count,
                                        &mut blocked_residual_link_count,
                                    );
                                }
                                if y + 1 < bounds.y_end {
                                    if x > bounds.x_start {
                                        add_edge_aware_error_diffusion_link(
                                            &mut next_errors[error_index - 1],
                                            residual,
                                            ERROR_DIFFUSION_FS_NUMERATORS[1],
                                            conductance_to(x - 1, y + 1),
                                            &mut attenuated_residual_link_count,
                                            &mut blocked_residual_link_count,
                                        );
                                    }
                                    add_edge_aware_error_diffusion_link(
                                        &mut next_errors[error_index],
                                        residual,
                                        ERROR_DIFFUSION_FS_NUMERATORS[2],
                                        conductance_to(x, y + 1),
                                        &mut attenuated_residual_link_count,
                                        &mut blocked_residual_link_count,
                                    );
                                    if x + 1 < bounds.x_end {
                                        add_edge_aware_error_diffusion_link(
                                            &mut next_errors[error_index + 1],
                                            residual,
                                            ERROR_DIFFUSION_FS_NUMERATORS[3],
                                            conductance_to(x + 1, y + 1),
                                            &mut attenuated_residual_link_count,
                                            &mut blocked_residual_link_count,
                                        );
                                    }
                                }
                            }
                        }

                        if index == choice.secondary && choice.secondary != choice.nearest {
                            secondary_choice_count = secondary_choice_count.saturating_add(1);
                            secondary_choice_by_class[class] =
                                secondary_choice_by_class[class].saturating_add(1);
                        }
                        previous_indices[pixel_index] = index;
                        let output_pixel = frame_pixel_offset + pixel_index;
                        indices[output_pixel] = index;
                        let output_byte = output_pixel * 3;
                        reconstructed[output_byte..output_byte + 3]
                            .copy_from_slice(&palette_rgb[usize::from(index)]);
                    }

                    if let Some((current_errors, next_errors)) = error_buffers.as_mut() {
                        std::mem::swap(current_errors, next_errors);
                        next_errors.fill(Oklab::default());
                    }
                }
            }
        }
    }

    let (static_index_flip_count, vfr_weighted_static_index_flip_rate) =
        measure_static_index_flips(pixels, &indices, &layout, &normalized_frame_delays_cs);
    let metrics = evaluate_rgb24_candidate(pixels, &reconstructed, width, height)?;
    let indices_sha256 = format!("{:x}", Sha256::digest(&indices));
    let reconstructed_rgb24_sha256 = format!("{:x}", Sha256::digest(&reconstructed));
    let diagnostics = ErrorDiffusionDiagnostics {
        kernel_config_sha256: kernel_config_sha256.clone(),
        fallback_route_id: "legacy_internal_mapper".to_string(),
        fallback_indices_sha256: String::new(),
        gradient_eligibility_mask_sha256: String::new(),
        edge_protection_mask_sha256: String::new(),
        direct_gradient_eligible_cell_count: 0,
        coherence_rescued_cell_count: 0,
        coherence_rescued_pixel_count: 0,
        pre_protection_gradient_pixel_count: 0,
        gradient_eligible_pixel_count,
        protected_edge_seed_pixel_count: 0,
        protected_edge_halo_pixel_count: 0,
        protected_edge_fallback_pixel_count: 0,
        protected_edge_index_change_count: 0,
        diffused_pixel_count,
        diffused_pixel_by_class,
        residual_clamp_count,
        cell_reset_count,
        frame_error_buffer_reset_count: 0,
        edge_guarded_pixel_count,
        residual_link_candidate_count: 0,
        full_conductance_residual_link_count: 0,
        attenuated_residual_link_count,
        blocked_residual_link_count,
        cross_cell_candidate_link_count: 0,
        cross_cell_propagated_link_count: 0,
        cross_cell_rejected_class_count: 0,
        cross_cell_rejected_eligibility_count: 0,
        cross_cell_rejected_protection_count: 0,
        cross_cell_blocked_hard_edge_count: 0,
        protected_target_link_count: 0,
        fallback_preserved_pixel_count: 0,
        eligible_index_change_count: 0,
        ineligible_index_change_count: 0,
        eligible_index_change_rate: 0.0,
        temporal_regularized_hold_count,
        temporal_prev_candidate_count,
        temporal_prev_rejected_by_color_count,
        temporal_prev_rejected_by_budget_count,
        temporal_prev_rejected_by_regularizer_count,
        temporal_vfr_single_frame_extension_count: 0,
        loop_seeded_pixel_count: 0,
        static_index_flip_count,
        vfr_weighted_static_index_flip_rate,
    };
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.error-diffusion-temporal.v3\0");
    hasher.update(kernel_config_sha256.as_bytes());
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(layout.frame_count.to_le_bytes());
    hasher.update([max_hold_frames]);
    hasher.update(max_hold_duration_cs.to_le_bytes());
    for delay in &normalized_frame_delays_cs {
        hasher.update(delay.to_le_bytes());
    }
    hasher.update(palette.sha256.as_bytes());
    hasher.update(regions.sha256.as_bytes());
    hasher.update(indices_sha256.as_bytes());
    hasher.update(reconstructed_rgb24_sha256.as_bytes());
    hasher.update(secondary_choice_count.to_le_bytes());
    for count in secondary_choice_by_class {
        hasher.update(count.to_le_bytes());
    }
    hasher.update(temporal_hold_count.to_le_bytes());
    for count in temporal_hold_by_class {
        hasher.update(count.to_le_bytes());
    }
    hasher.update(temporal_hold_duration_cs.to_le_bytes());
    hasher.update(temporal_max_observed_hold_duration_cs.to_le_bytes());
    hasher.update(diagnostics.gradient_eligible_pixel_count.to_le_bytes());
    hasher.update(diagnostics.diffused_pixel_count.to_le_bytes());
    for count in diagnostics.diffused_pixel_by_class {
        hasher.update(count.to_le_bytes());
    }
    hasher.update(diagnostics.residual_clamp_count.to_le_bytes());
    hasher.update(diagnostics.cell_reset_count.to_le_bytes());
    hasher.update(diagnostics.edge_guarded_pixel_count.to_le_bytes());
    hasher.update(diagnostics.attenuated_residual_link_count.to_le_bytes());
    hasher.update(diagnostics.blocked_residual_link_count.to_le_bytes());
    hasher.update(diagnostics.temporal_regularized_hold_count.to_le_bytes());
    hasher.update(diagnostics.temporal_prev_candidate_count.to_le_bytes());
    hasher.update(
        diagnostics
            .temporal_prev_rejected_by_color_count
            .to_le_bytes(),
    );
    hasher.update(
        diagnostics
            .temporal_prev_rejected_by_budget_count
            .to_le_bytes(),
    );
    hasher.update(
        diagnostics
            .temporal_prev_rejected_by_regularizer_count
            .to_le_bytes(),
    );
    hasher.update(diagnostics.static_index_flip_count.to_le_bytes());
    hasher.update(
        diagnostics
            .vfr_weighted_static_index_flip_rate
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(metrics.mean_oklab_error.to_bits().to_le_bytes());
    hasher.update(metrics.p95_oklab_error.to_bits().to_le_bytes());
    hasher.update(
        metrics
            .edge_weighted_mean_oklab_error
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(
        metrics
            .multiscale_low_frequency_oklab_error
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(metrics.multiscale_banding_score.to_bits().to_le_bytes());
    hasher.update(metrics.edge_gradient_error.to_bits().to_le_bytes());
    hasher.update(metrics.static_temporal_residual.to_bits().to_le_bytes());
    hasher.update(
        metrics
            .multiscale_static_temporal_residual
            .to_bits()
            .to_le_bytes(),
    );
    let artifact_sha256 = format!("{:x}", hasher.finalize());

    Ok(RegionalQuantizationArtifact {
        indices,
        reconstructed_rgb24: reconstructed,
        report: RegionalQuantizationReport {
            frame_count: layout.frame_count,
            pixel_count: u64::try_from(layout.total_pixels)
                .map_err(|_| RegionalQuantizationError::DimensionOverflow)?,
            secondary_choice_count,
            secondary_choice_by_class,
            temporal_hold_count,
            temporal_hold_by_class,
            temporal_policy_max_hold_frames: max_hold_frames,
            temporal_policy_max_hold_duration_cs: max_hold_duration_cs,
            temporal_hold_duration_cs,
            temporal_max_observed_hold_duration_cs,
            spatial_kernel_id: "oklab_cell_edge_aware_serpentine_fs_temporal_v3".to_string(),
            error_diffusion: Some(diagnostics),
            phase_locked_pair: None,
            metrics,
            indices_sha256,
            reconstructed_rgb24_sha256,
            artifact_sha256,
        },
    })
}

/// GIFP v5 coherent, edge-protected hybrid diffusion kernel.
///
/// The current winning mapper is the immutable fallback for the whole frame.
/// Only smooth flat/skin regions may replace fallback indices. Residual state
/// is continuous across compatible region cells, while ineligible cells,
/// semantic boundaries, and measured hard edges remain strict barriers.
#[allow(clippy::too_many_arguments)]
pub fn quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
    pixels: &[u8],
    width: u16,
    height: u16,
    palette: &OklabPaletteArtifact,
    regions: &RegionDitherArtifact,
    frame_delays_cs: &[u16],
    policy: TemporalHysteresisPolicy,
    looping: bool,
    fallback_indices: &[u8],
    fallback_route_id: &str,
) -> Result<RegionalQuantizationArtifact, RegionalQuantizationError> {
    let layout = validate_layout(pixels, width, height)?;
    let frame_count = usize::try_from(layout.frame_count)
        .map_err(|_| RegionalQuantizationError::DimensionOverflow)?;
    let normalized_frame_delays_cs = normalize_frame_delays(frame_delays_cs, frame_count)?;
    let palette_rgb = opaque_palette_rgb(palette)?;
    validate_regions(regions)?;
    if fallback_indices.len() != layout.total_pixels {
        return Err(RegionalQuantizationError::InvalidFallbackSize {
            expected: layout.total_pixels,
            actual: fallback_indices.len(),
        });
    }
    for (pixel_index, index) in fallback_indices.iter().copied().enumerate() {
        if usize::from(index) >= palette_rgb.len() {
            return Err(RegionalQuantizationError::InvalidFallbackIndex {
                pixel_index,
                index,
                palette_entries: palette_rgb.len(),
            });
        }
    }

    let palette_labs = palette_rgb
        .iter()
        .copied()
        .map(srgb8_to_oklab)
        .collect::<Vec<_>>();
    let lookup = build_choice_lookup(&palette_labs);
    let eligibility_plan = plan_error_diffusion_v5_eligibility(pixels, &layout, regions);
    let kernel_config_sha256 = error_diffusion_v5_kernel_config_sha256();
    let fallback_indices_sha256 = format!("{:x}", Sha256::digest(fallback_indices));
    let max_hold_frames = policy.bounded_max_hold_frames();
    let max_hold_duration_cs = policy.bounded_max_hold_duration_cs();
    let mut indices = fallback_indices.to_vec();
    let mut reconstructed = vec![0_u8; pixels.len()];
    let mut secondary_choice_count = 0_u64;
    let mut secondary_choice_by_class = [0_u64; 4];
    let mut temporal_hold_count = 0_u64;
    let mut temporal_hold_by_class = [0_u64; 4];
    let mut temporal_hold_duration_cs = 0_u64;
    let mut temporal_max_observed_hold_duration_cs = 0_u16;
    let mut direct_gradient_eligible_cell_count = 0_u64;
    let mut coherence_rescued_cell_count = 0_u64;
    let mut coherence_rescued_pixel_count = 0_u64;
    let mut pre_protection_gradient_pixel_count = 0_u64;
    let mut gradient_eligible_pixel_count = 0_u64;
    let mut protected_edge_seed_pixel_count = 0_u64;
    let mut protected_edge_halo_pixel_count = 0_u64;
    let mut protected_edge_fallback_pixel_count = 0_u64;
    let mut protected_edge_index_change_count = 0_u64;
    let mut diffused_pixel_count = 0_u64;
    let mut diffused_pixel_by_class = [0_u64; 4];
    let mut residual_clamp_count = 0_u64;
    let cell_reset_count = 0_u64;
    let mut frame_error_buffer_reset_count = 0_u64;
    let mut edge_guarded_pixel_count = 0_u64;
    let mut link_diagnostics = ErrorDiffusionV5LinkDiagnostics::default();
    let mut fallback_preserved_pixel_count = 0_u64;
    let mut eligible_index_change_count = 0_u64;
    let mut ineligible_index_change_count = 0_u64;
    let mut temporal_regularized_hold_count = 0_u64;
    let mut temporal_prev_candidate_count = 0_u64;
    let mut temporal_prev_rejected_by_color_count = 0_u64;
    let mut temporal_prev_rejected_by_budget_count = 0_u64;
    let mut temporal_prev_rejected_by_regularizer_count = 0_u64;
    let mut temporal_vfr_single_frame_extension_count = 0_u64;
    let mut loop_seeded_pixel_count = 0_u64;
    let mut gradient_eligibility_mask_hasher = Sha256::new();
    gradient_eligibility_mask_hasher.update(b"gifp.error-diffusion-v5.eligibility-mask\0");
    let mut edge_protection_mask_hasher = Sha256::new();
    edge_protection_mask_hasher.update(b"gifp.error-diffusion-v5.edge-protection-mask\0");
    let mut previous_indices = if looping && frame_count > 1 {
        let start = (frame_count - 1) * layout.pixels_per_frame;
        fallback_indices[start..start + layout.pixels_per_frame].to_vec()
    } else {
        vec![0_u8; layout.pixels_per_frame]
    };
    let mut hold_ages = vec![0_u8; layout.pixels_per_frame];
    let mut hold_durations_cs = vec![0_u16; layout.pixels_per_frame];
    let grid_width = usize::from(regions.grid_width);
    let grid_height = usize::from(regions.grid_height);
    let cell_count = grid_width * grid_height;
    let mut previous_diffusion_enabled = if looping && frame_count > 1 {
        let start = (frame_count - 1) * cell_count;
        eligibility_plan.strengths[start..start + cell_count]
            .iter()
            .map(|strength| *strength > 0.0)
            .collect()
    } else {
        vec![false; cell_count]
    };
    let mut previous_pixel_enabled = vec![false; layout.pixels_per_frame];
    if looping && frame_count > 1 {
        let last_frame_index = frame_count - 1;
        let frame_start = last_frame_index * layout.frame_bytes;
        let last_frame = &pixels[frame_start..frame_start + layout.frame_bytes];
        let cell_start = last_frame_index * cell_count;
        let last_cell_enabled = eligibility_plan.strengths[cell_start..cell_start + cell_count]
            .iter()
            .map(|strength| *strength > 0.0)
            .collect::<Vec<_>>();
        let protection = build_error_diffusion_edge_protection_plan(
            last_frame,
            &layout,
            regions,
            &last_cell_enabled,
        );
        for y in 0..layout.height {
            for x in 0..layout.width {
                let pixel_index = y * layout.width + x;
                let cell_x = region_cell_coordinate_for_pixel(x, layout.width, grid_width);
                let cell_y = region_cell_coordinate_for_pixel(y, layout.height, grid_height);
                previous_pixel_enabled[pixel_index] = last_cell_enabled
                    [cell_y * grid_width + cell_x]
                    && !protection.protected[pixel_index];
            }
        }
        loop_seeded_pixel_count = previous_pixel_enabled
            .iter()
            .filter(|enabled| **enabled)
            .count() as u64;
    }

    for (frame_index, frame_delay_cs) in normalized_frame_delays_cs
        .iter()
        .copied()
        .enumerate()
        .take(frame_count)
    {
        let frame_byte_offset = frame_index * layout.frame_bytes;
        let frame_pixel_offset = frame_index * layout.pixels_per_frame;
        let frame = &pixels[frame_byte_offset..frame_byte_offset + layout.frame_bytes];
        let frame_labs = frame
            .chunks_exact(3)
            .map(|rgb| srgb8_to_oklab([rgb[0], rgb[1], rgb[2]]))
            .collect::<Vec<_>>();
        let previous_frame_index = if frame_index > 0 {
            Some(frame_index - 1)
        } else if looping && frame_count > 1 {
            Some(frame_count - 1)
        } else {
            None
        };
        let previous_frame = previous_frame_index.map(|previous_index| {
            let start = previous_index * layout.frame_bytes;
            &pixels[start..start + layout.frame_bytes]
        });
        let mut cell_enabled = vec![false; cell_count];
        let mut cell_suppress_temporal = vec![false; cell_count];

        for cell_y in 0..grid_height {
            for cell_x in 0..grid_width {
                let cell = cell_y * grid_width + cell_x;
                let bounds = region_cell_bounds(&layout, regions, cell_x, cell_y);
                if bounds.is_empty() {
                    continue;
                }
                let timeline_cell = frame_index * cell_count + cell;
                let enabled = eligibility_plan.strengths[timeline_cell] > 0.0;
                let eligibility_changed = (frame_index > 0 || (looping && frame_count > 1))
                    && previous_diffusion_enabled[cell] != enabled;
                let scene_cut = previous_frame
                    .map(|previous| cell_has_scene_cut(frame, previous, &layout, bounds))
                    .unwrap_or(false);
                let suppress_temporal = eligibility_changed || scene_cut;
                if suppress_temporal {
                    clear_cell_temporal_hold_state(
                        bounds,
                        &layout,
                        &mut hold_ages,
                        &mut hold_durations_cs,
                    );
                }
                previous_diffusion_enabled[cell] = enabled;
                cell_enabled[cell] = enabled;
                cell_suppress_temporal[cell] = suppress_temporal;
                if enabled {
                    let cell_pixels = u64::try_from(bounds.pixel_count()).unwrap_or(u64::MAX);
                    pre_protection_gradient_pixel_count =
                        pre_protection_gradient_pixel_count.saturating_add(cell_pixels);
                    if eligibility_plan.direct[timeline_cell] {
                        direct_gradient_eligible_cell_count =
                            direct_gradient_eligible_cell_count.saturating_add(1);
                    }
                    if eligibility_plan.coherence_rescued[timeline_cell] {
                        coherence_rescued_cell_count =
                            coherence_rescued_cell_count.saturating_add(1);
                        coherence_rescued_pixel_count =
                            coherence_rescued_pixel_count.saturating_add(cell_pixels);
                    }
                }
            }
        }

        let edge_protection =
            build_error_diffusion_edge_protection_plan(frame, &layout, regions, &cell_enabled);
        let mut pixel_enabled = vec![false; layout.pixels_per_frame];
        let mut eligibility_mask_bytes = Vec::with_capacity(layout.pixels_per_frame);
        let mut edge_protection_mask_bytes = Vec::with_capacity(layout.pixels_per_frame);
        for y in 0..layout.height {
            for x in 0..layout.width {
                let pixel_index = y * layout.width + x;
                let cell_x = region_cell_coordinate_for_pixel(x, layout.width, grid_width);
                let cell_y = region_cell_coordinate_for_pixel(y, layout.height, grid_height);
                let pre_protection_enabled = cell_enabled[cell_y * grid_width + cell_x];
                let protected = pre_protection_enabled && edge_protection.protected[pixel_index];
                pixel_enabled[pixel_index] = pre_protection_enabled && !protected;
                eligibility_mask_bytes.push(u8::from(pixel_enabled[pixel_index]));
                edge_protection_mask_bytes.push(u8::from(protected));
                if pixel_enabled[pixel_index] {
                    gradient_eligible_pixel_count = gradient_eligible_pixel_count.saturating_add(1);
                } else if protected {
                    protected_edge_halo_pixel_count =
                        protected_edge_halo_pixel_count.saturating_add(1);
                }
                if pre_protection_enabled && edge_protection.seeds[pixel_index] {
                    protected_edge_seed_pixel_count =
                        protected_edge_seed_pixel_count.saturating_add(1);
                }
            }
        }
        gradient_eligibility_mask_hasher.update(&eligibility_mask_bytes);
        edge_protection_mask_hasher.update(&edge_protection_mask_bytes);

        let mut current_errors = vec![Oklab::default(); layout.width + 2];
        let mut next_errors = vec![Oklab::default(); layout.width + 2];
        frame_error_buffer_reset_count = frame_error_buffer_reset_count.saturating_add(1);
        for y in 0..layout.height {
            let right_to_left = y % 2 == 1;
            for step in 0..layout.width {
                let x = if right_to_left {
                    layout.width - 1 - step
                } else {
                    step
                };
                let error_index = x + 1;
                let pixel_index = y * layout.width + x;
                let output_pixel = frame_pixel_offset + pixel_index;
                let source_byte = pixel_index * 3;
                let source_rgb = rgb_at(frame, source_byte);
                let source_lab = frame_labs[pixel_index];
                let cell_x = region_cell_coordinate_for_pixel(x, layout.width, grid_width);
                let cell_y = region_cell_coordinate_for_pixel(y, layout.height, grid_height);
                let cell = cell_y * grid_width + cell_x;
                let class = usize::from(regions.class_map[cell]);
                let diffusion_strength =
                    eligibility_plan.strengths[frame_index * cell_count + cell];
                let diffusion_enabled = pixel_enabled[pixel_index];
                let pixel_eligibility_changed = (frame_index > 0 || (looping && frame_count > 1))
                    && previous_pixel_enabled[pixel_index] != diffusion_enabled;
                let suppress_temporal_hold =
                    cell_suppress_temporal[cell] || pixel_eligibility_changed;
                if pixel_eligibility_changed {
                    hold_ages[pixel_index] = 0;
                    hold_durations_cs[pixel_index] = 0;
                }
                let fallback_index = fallback_indices[output_pixel];
                let bucket = lookup[histogram_index(source_rgb[0], source_rgb[1], source_rgb[2])];
                let choice = palette_choice(source_rgb, bucket, &palette_labs);
                let mut spatial_index = fallback_index;
                let mut adjusted_source_lab = source_lab;
                let mut carried_clamped = false;
                let edge_attenuation = if diffusion_enabled {
                    error_diffusion_pixel_edge_attenuation_full_frame(&frame_labs, &layout, x, y)
                } else {
                    1.0
                };
                if diffusion_enabled && edge_attenuation < ERROR_DIFFUSION_EDGE_GUARDED_ATTENUATION
                {
                    edge_guarded_pixel_count = edge_guarded_pixel_count.saturating_add(1);
                }
                if diffusion_enabled {
                    let carried =
                        clamp_error_diffusion_residual(current_errors[error_index], class);
                    adjusted_source_lab = add_oklab(source_lab, carried.0);
                    carried_clamped = carried.1;
                    spatial_index =
                        nearest_palette_index_for_lab(adjusted_source_lab, &palette_labs);
                }

                let mut index = spatial_index;
                if diffusion_enabled {
                    if !suppress_temporal_hold {
                        if let Some(previous_frame) = previous_frame {
                            let previous_source = rgb_at(previous_frame, source_byte);
                            let previous_index = previous_indices[pixel_index];
                            let micro_change_delta = max_channel_delta(source_rgb, previous_source);
                            let micro_change =
                                micro_change_delta <= TEMPORAL_MICRO_CHANGE_MAX_DELTA;
                            let below_frame_limit = hold_ages[pixel_index] < max_hold_frames;
                            let next_hold_duration_cs =
                                hold_durations_cs[pixel_index].saturating_add(frame_delay_cs);
                            let vfr_single_frame_extension = hold_ages[pixel_index] == 0
                                && hold_durations_cs[pixel_index] == 0
                                && frame_delay_cs > max_hold_duration_cs
                                && next_hold_duration_cs <= frame_delay_cs;
                            let below_duration_limit = next_hold_duration_cs
                                <= max_hold_duration_cs
                                || vfr_single_frame_extension;
                            if max_hold_frames > 0
                                && max_hold_duration_cs > 0
                                && micro_change
                                && previous_index != spatial_index
                                && usize::from(previous_index) < palette_labs.len()
                            {
                                temporal_prev_candidate_count =
                                    temporal_prev_candidate_count.saturating_add(1);
                                if !below_frame_limit || !below_duration_limit {
                                    temporal_prev_rejected_by_budget_count =
                                        temporal_prev_rejected_by_budget_count.saturating_add(1);
                                    hold_ages[pixel_index] = 0;
                                    hold_durations_cs[pixel_index] = 0;
                                } else {
                                    let spatial_error = source_lab
                                        .distance_squared(palette_labs[usize::from(spatial_index)])
                                        .sqrt();
                                    let previous_error = source_lab
                                        .distance_squared(palette_labs[usize::from(previous_index)])
                                        .sqrt();
                                    let extra_error =
                                        TEMPORAL_HYSTERESIS_EXTRA_OKLAB_ERROR_BY_CLASS[class];
                                    if previous_error > spatial_error + extra_error {
                                        temporal_prev_rejected_by_color_count =
                                            temporal_prev_rejected_by_color_count.saturating_add(1);
                                        hold_ages[pixel_index] = 0;
                                        hold_durations_cs[pixel_index] = 0;
                                    } else {
                                        let micro_factor = (1.0
                                            - f64::from(micro_change_delta)
                                                / f64::from(TEMPORAL_MICRO_CHANGE_MAX_DELTA))
                                        .clamp(0.0, 1.0);
                                        let regularizer_radius =
                                            ERROR_DIFFUSION_TEMPORAL_REGULARIZER_FRACTION
                                                * extra_error
                                                * micro_factor
                                                * edge_attenuation;
                                        let regularizer = regularizer_radius * regularizer_radius;
                                        let spatial_adjusted_error = source_lab.distance_squared(
                                            palette_labs[usize::from(spatial_index)],
                                        );
                                        let previous_adjusted_error = source_lab.distance_squared(
                                            palette_labs[usize::from(previous_index)],
                                        );
                                        if previous_adjusted_error
                                            <= spatial_adjusted_error + regularizer
                                        {
                                            index = previous_index;
                                            hold_ages[pixel_index] =
                                                hold_ages[pixel_index].saturating_add(1);
                                            hold_durations_cs[pixel_index] = next_hold_duration_cs;
                                            temporal_hold_count =
                                                temporal_hold_count.saturating_add(1);
                                            temporal_hold_by_class[class] =
                                                temporal_hold_by_class[class].saturating_add(1);
                                            temporal_hold_duration_cs = temporal_hold_duration_cs
                                                .saturating_add(u64::from(frame_delay_cs));
                                            temporal_max_observed_hold_duration_cs =
                                                temporal_max_observed_hold_duration_cs
                                                    .max(next_hold_duration_cs);
                                            temporal_regularized_hold_count =
                                                temporal_regularized_hold_count.saturating_add(1);
                                            if vfr_single_frame_extension {
                                                temporal_vfr_single_frame_extension_count =
                                                    temporal_vfr_single_frame_extension_count
                                                        .saturating_add(1);
                                            }
                                        } else {
                                            temporal_prev_rejected_by_regularizer_count =
                                                temporal_prev_rejected_by_regularizer_count
                                                    .saturating_add(1);
                                            hold_ages[pixel_index] = 0;
                                            hold_durations_cs[pixel_index] = 0;
                                        }
                                    }
                                }
                            } else {
                                hold_ages[pixel_index] = 0;
                                hold_durations_cs[pixel_index] = 0;
                            }
                        } else {
                            hold_ages[pixel_index] = 0;
                            hold_durations_cs[pixel_index] = 0;
                        }
                    } else {
                        hold_ages[pixel_index] = 0;
                        hold_durations_cs[pixel_index] = 0;
                    }
                } else {
                    index = fallback_index;
                    hold_ages[pixel_index] = 0;
                    hold_durations_cs[pixel_index] = 0;
                }

                if diffusion_enabled {
                    let (residual, residual_clamped) = emitted_error_diffusion_residual(
                        adjusted_source_lab,
                        index,
                        &palette_labs,
                        diffusion_strength,
                        class,
                    );
                    if carried_clamped || residual_clamped {
                        residual_clamp_count = residual_clamp_count.saturating_add(1);
                    }
                    let conductance_to = |neighbor_x: usize, neighbor_y: usize| {
                        error_diffusion_edge_conductance(
                            source_lab,
                            frame_labs[neighbor_y * layout.width + neighbor_x],
                        )
                    };
                    let mut propagate = |neighbor_x: usize,
                                         neighbor_y: usize,
                                         target: &mut Oklab,
                                         numerator: u8| {
                        let neighbor_cell_x =
                            region_cell_coordinate_for_pixel(neighbor_x, layout.width, grid_width);
                        let neighbor_cell_y = region_cell_coordinate_for_pixel(
                            neighbor_y,
                            layout.height,
                            grid_height,
                        );
                        let neighbor_cell = neighbor_cell_y * grid_width + neighbor_cell_x;
                        let neighbor_pixel = neighbor_y * layout.width + neighbor_x;
                        add_error_diffusion_v5_link(
                            target,
                            residual,
                            numerator,
                            conductance_to(neighbor_x, neighbor_y),
                            cell,
                            neighbor_cell,
                            class,
                            usize::from(regions.class_map[neighbor_cell]),
                            cell_enabled[neighbor_cell],
                            pixel_enabled[neighbor_pixel],
                            edge_protection.protected[neighbor_pixel],
                            &mut link_diagnostics,
                        );
                    };
                    if right_to_left {
                        if x > 0 {
                            propagate(x - 1, y, &mut current_errors[error_index - 1], 7);
                        }
                        if y + 1 < layout.height {
                            if x + 1 < layout.width {
                                propagate(x + 1, y + 1, &mut next_errors[error_index + 1], 3);
                            }
                            propagate(x, y + 1, &mut next_errors[error_index], 5);
                            if x > 0 {
                                propagate(x - 1, y + 1, &mut next_errors[error_index - 1], 1);
                            }
                        }
                    } else {
                        if x + 1 < layout.width {
                            propagate(x + 1, y, &mut current_errors[error_index + 1], 7);
                        }
                        if y + 1 < layout.height {
                            if x > 0 {
                                propagate(x - 1, y + 1, &mut next_errors[error_index - 1], 3);
                            }
                            propagate(x, y + 1, &mut next_errors[error_index], 5);
                            if x + 1 < layout.width {
                                propagate(x + 1, y + 1, &mut next_errors[error_index + 1], 1);
                            }
                        }
                    }
                }

                if index == fallback_index {
                    fallback_preserved_pixel_count =
                        fallback_preserved_pixel_count.saturating_add(1);
                } else if diffusion_enabled {
                    eligible_index_change_count = eligible_index_change_count.saturating_add(1);
                    diffused_pixel_count = diffused_pixel_count.saturating_add(1);
                    diffused_pixel_by_class[class] =
                        diffused_pixel_by_class[class].saturating_add(1);
                } else {
                    ineligible_index_change_count = ineligible_index_change_count.saturating_add(1);
                }
                if edge_protection.protected[pixel_index] {
                    if index == fallback_index {
                        protected_edge_fallback_pixel_count =
                            protected_edge_fallback_pixel_count.saturating_add(1);
                    } else {
                        protected_edge_index_change_count =
                            protected_edge_index_change_count.saturating_add(1);
                    }
                }
                if index == choice.secondary && choice.secondary != choice.nearest {
                    secondary_choice_count = secondary_choice_count.saturating_add(1);
                    secondary_choice_by_class[class] =
                        secondary_choice_by_class[class].saturating_add(1);
                }
                previous_indices[pixel_index] = index;
                previous_pixel_enabled[pixel_index] = diffusion_enabled;
                indices[output_pixel] = index;
                let output_byte = output_pixel * 3;
                reconstructed[output_byte..output_byte + 3]
                    .copy_from_slice(&palette_rgb[usize::from(index)]);
            }
            std::mem::swap(&mut current_errors, &mut next_errors);
            next_errors.fill(Oklab::default());
        }
    }

    debug_assert_eq!(ineligible_index_change_count, 0);
    debug_assert_eq!(protected_edge_index_change_count, 0);
    debug_assert_eq!(
        pre_protection_gradient_pixel_count,
        gradient_eligible_pixel_count.saturating_add(protected_edge_halo_pixel_count)
    );
    debug_assert_eq!(
        protected_edge_fallback_pixel_count,
        protected_edge_halo_pixel_count
    );
    debug_assert_eq!(
        link_diagnostics.candidate_count,
        link_diagnostics
            .full_conductance_count
            .saturating_add(link_diagnostics.attenuated_count)
            .saturating_add(link_diagnostics.blocked_count)
    );
    debug_assert_eq!(
        link_diagnostics.cross_cell_candidate_count,
        link_diagnostics
            .cross_cell_propagated_count
            .saturating_add(link_diagnostics.cross_cell_rejected_class_count)
            .saturating_add(link_diagnostics.cross_cell_rejected_eligibility_count)
            .saturating_add(link_diagnostics.cross_cell_rejected_protection_count)
            .saturating_add(link_diagnostics.cross_cell_blocked_hard_edge_count)
    );
    debug_assert!(
        protected_edge_seed_pixel_count <= protected_edge_halo_pixel_count,
        "hard-edge seeds must be a subset of the protected halo"
    );
    debug_assert!(link_diagnostics.protected_target_count <= link_diagnostics.blocked_count);
    let eligible_index_change_rate = if gradient_eligible_pixel_count == 0 {
        0.0
    } else {
        eligible_index_change_count as f64 / gradient_eligible_pixel_count as f64
    };
    let (static_index_flip_count, vfr_weighted_static_index_flip_rate) =
        measure_static_index_flips(pixels, &indices, &layout, &normalized_frame_delays_cs);
    let metrics = evaluate_rgb24_candidate(pixels, &reconstructed, width, height)?;
    let indices_sha256 = format!("{:x}", Sha256::digest(&indices));
    let reconstructed_rgb24_sha256 = format!("{:x}", Sha256::digest(&reconstructed));
    let gradient_eligibility_mask_sha256 =
        format!("{:x}", gradient_eligibility_mask_hasher.finalize());
    let edge_protection_mask_sha256 = format!("{:x}", edge_protection_mask_hasher.finalize());
    let diagnostics = ErrorDiffusionDiagnostics {
        kernel_config_sha256: kernel_config_sha256.clone(),
        fallback_route_id: fallback_route_id.to_string(),
        fallback_indices_sha256: fallback_indices_sha256.clone(),
        gradient_eligibility_mask_sha256,
        edge_protection_mask_sha256,
        direct_gradient_eligible_cell_count,
        coherence_rescued_cell_count,
        coherence_rescued_pixel_count,
        pre_protection_gradient_pixel_count,
        gradient_eligible_pixel_count,
        protected_edge_seed_pixel_count,
        protected_edge_halo_pixel_count,
        protected_edge_fallback_pixel_count,
        protected_edge_index_change_count,
        diffused_pixel_count,
        diffused_pixel_by_class,
        residual_clamp_count,
        cell_reset_count,
        frame_error_buffer_reset_count,
        edge_guarded_pixel_count,
        residual_link_candidate_count: link_diagnostics.candidate_count,
        full_conductance_residual_link_count: link_diagnostics.full_conductance_count,
        attenuated_residual_link_count: link_diagnostics.attenuated_count,
        blocked_residual_link_count: link_diagnostics.blocked_count,
        cross_cell_candidate_link_count: link_diagnostics.cross_cell_candidate_count,
        cross_cell_propagated_link_count: link_diagnostics.cross_cell_propagated_count,
        cross_cell_rejected_class_count: link_diagnostics.cross_cell_rejected_class_count,
        cross_cell_rejected_eligibility_count: link_diagnostics
            .cross_cell_rejected_eligibility_count,
        cross_cell_rejected_protection_count: link_diagnostics.cross_cell_rejected_protection_count,
        cross_cell_blocked_hard_edge_count: link_diagnostics.cross_cell_blocked_hard_edge_count,
        protected_target_link_count: link_diagnostics.protected_target_count,
        fallback_preserved_pixel_count,
        eligible_index_change_count,
        ineligible_index_change_count,
        eligible_index_change_rate,
        temporal_regularized_hold_count,
        temporal_prev_candidate_count,
        temporal_prev_rejected_by_color_count,
        temporal_prev_rejected_by_budget_count,
        temporal_prev_rejected_by_regularizer_count,
        temporal_vfr_single_frame_extension_count,
        loop_seeded_pixel_count,
        static_index_flip_count,
        vfr_weighted_static_index_flip_rate,
    };
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.coherent-edge-protected-diffusion.v5\0");
    update_error_diffusion_v5_artifact_hash(
        &mut hasher,
        &diagnostics,
        width,
        height,
        layout.frame_count,
        max_hold_frames,
        max_hold_duration_cs,
        looping,
        &normalized_frame_delays_cs,
        &palette.sha256,
        &regions.sha256,
        &indices_sha256,
        &reconstructed_rgb24_sha256,
        secondary_choice_count,
        secondary_choice_by_class,
        temporal_hold_count,
        temporal_hold_by_class,
        temporal_hold_duration_cs,
        temporal_max_observed_hold_duration_cs,
        &metrics,
    );
    let artifact_sha256 = format!("{:x}", hasher.finalize());

    Ok(RegionalQuantizationArtifact {
        indices,
        reconstructed_rgb24: reconstructed,
        report: RegionalQuantizationReport {
            frame_count: layout.frame_count,
            pixel_count: u64::try_from(layout.total_pixels)
                .map_err(|_| RegionalQuantizationError::DimensionOverflow)?,
            secondary_choice_count,
            secondary_choice_by_class,
            temporal_hold_count,
            temporal_hold_by_class,
            temporal_policy_max_hold_frames: max_hold_frames,
            temporal_policy_max_hold_duration_cs: max_hold_duration_cs,
            temporal_hold_duration_cs,
            temporal_max_observed_hold_duration_cs,
            spatial_kernel_id: "oklab_hybrid_coherent_edge_protected_serpentine_fs_temporal_v5"
                .to_string(),
            error_diffusion: Some(diagnostics),
            phase_locked_pair: None,
            metrics,
            indices_sha256,
            reconstructed_rgb24_sha256,
            artifact_sha256,
        },
    })
}

/// Conservative phase-locked two-color temporal kernel.
///
/// `fallback_indices` is the immutable safety baseline produced by FFmpeg. A
/// pixel may differ from it only when all of the following are true:
///
/// * its fallback slot is opaque in the one global palette;
/// * its region is a measured smooth flat/skin cell;
/// * it is outside the hard-edge protection halo and a scene cut;
/// * the source changed by at most [`TEMPORAL_MICRO_CHANGE_MAX_DELTA`], or it
///   is the first frame of a non-looping timeline with no predecessor; and
/// * the fallback color and one nearby palette color geometrically bracket the
///   source in OKLab (with stricter skin hue/chroma guards).
///
/// The 8x8 spatial rank never changes between frames. Temporal retention is
/// attempted only when a real timeline predecessor exists and is additionally
/// capped at CONSERVATIVE_V1 even if `policy` is more permissive.
#[allow(clippy::too_many_arguments)]
pub fn quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
    pixels: &[u8],
    width: u16,
    height: u16,
    palette: &OklabPaletteArtifact,
    regions: &RegionDitherArtifact,
    frame_delays_cs: &[u16],
    policy: TemporalHysteresisPolicy,
    looping: bool,
    fallback_indices: &[u8],
    fallback_route_id: &str,
) -> Result<RegionalQuantizationArtifact, RegionalQuantizationError> {
    let layout = validate_layout(pixels, width, height)?;
    let frame_count = usize::try_from(layout.frame_count)
        .map_err(|_| RegionalQuantizationError::DimensionOverflow)?;
    let normalized_frame_delays_cs = normalize_frame_delays(frame_delays_cs, frame_count)?;
    let emitted_palette_rgb = opaque_palette_rgb(palette)?;
    validate_regions(regions)?;
    if fallback_indices.len() != layout.total_pixels {
        return Err(RegionalQuantizationError::InvalidFallbackSize {
            expected: layout.total_pixels,
            actual: fallback_indices.len(),
        });
    }
    if palette.rgba.len() != 256 * 4
        || palette.rgba[..emitted_palette_rgb.len() * 4]
            .chunks_exact(4)
            .any(|rgba| rgba[3] != u8::MAX)
    {
        return Err(RegionalQuantizationError::InvalidPalette);
    }

    let palette_rgb = palette
        .rgba
        .chunks_exact(4)
        .map(|rgba| [rgba[0], rgba[1], rgba[2]])
        .collect::<Vec<_>>();
    let palette_alpha = palette
        .rgba
        .chunks_exact(4)
        .map(|rgba| rgba[3])
        .collect::<Vec<_>>();
    let emitted_palette_labs = emitted_palette_rgb
        .iter()
        .copied()
        .map(srgb8_to_oklab)
        .collect::<Vec<_>>();
    let palette_labs = palette_rgb
        .iter()
        .copied()
        .map(srgb8_to_oklab)
        .collect::<Vec<_>>();
    let lookup = build_choice_lookup(&emitted_palette_labs);
    let eligibility_plan = plan_error_diffusion_v5_eligibility(pixels, &layout, regions);
    let max_hold_frames = policy
        .bounded_max_hold_frames()
        .min(PHASE_LOCKED_PAIR_MAX_HOLD_FRAMES);
    let max_hold_duration_cs = policy
        .bounded_max_hold_duration_cs()
        .min(PHASE_LOCKED_PAIR_MAX_HOLD_DURATION_CS);

    let fallback_indices_sha256 = format!("{:x}", Sha256::digest(fallback_indices));
    let kernel_config_sha256 = phase_locked_pair_kernel_config_sha256();
    let mut fallback_reconstructed = Vec::with_capacity(pixels.len());
    for index in fallback_indices.iter().copied() {
        fallback_reconstructed.extend_from_slice(&palette_rgb[usize::from(index)]);
    }
    let mut indices = fallback_indices.to_vec();
    let mut reconstructed = fallback_reconstructed.clone();
    let mut change_eligible_mask = vec![false; layout.total_pixels];
    let mut protected_mask = vec![false; layout.total_pixels];
    let mut hold_ages = vec![0_u8; layout.pixels_per_frame];
    let mut hold_durations_cs = vec![0_u16; layout.pixels_per_frame];
    let mut previous_indices = if looping && frame_count > 1 {
        let start = (frame_count - 1) * layout.pixels_per_frame;
        fallback_indices[start..start + layout.pixels_per_frame].to_vec()
    } else {
        vec![0_u8; layout.pixels_per_frame]
    };

    let grid_width = usize::from(regions.grid_width);
    let grid_height = usize::from(regions.grid_height);
    let cell_count = grid_width
        .checked_mul(grid_height)
        .ok_or(RegionalQuantizationError::DimensionOverflow)?;
    let mut pair_lookup_hasher = Sha256::new();
    pair_lookup_hasher.update(b"gifp.phase-locked-pair.lookup.v1\0");
    let mut eligibility_mask_hasher = Sha256::new();
    eligibility_mask_hasher.update(b"gifp.phase-locked-pair.eligibility-mask.v1\0");
    let mut edge_protection_mask_hasher = Sha256::new();
    edge_protection_mask_hasher.update(b"gifp.phase-locked-pair.edge-mask.v1\0");

    let mut opaque_fallback_pixel_count = 0_u64;
    let mut transparent_fallback_pixel_count = 0_u64;
    let mut smooth_region_pixel_count = 0_u64;
    let mut protected_edge_pixel_count = 0_u64;
    let mut non_micro_change_fallback_pixel_count = 0_u64;
    let mut scene_cut_fallback_pixel_count = 0_u64;
    let mut no_bracketing_pair_fallback_pixel_count = 0_u64;
    let mut eligible_pixel_count = 0_u64;
    let mut paired_pixel_count = 0_u64;
    let mut pair_candidate_count = 0_u64;
    let mut skin_pair_hue_rejection_count = 0_u64;
    let mut skin_pair_chroma_rejection_count = 0_u64;
    let mut temporal_candidate_count = 0_u64;
    let mut attempted_temporal_hold_count = 0_u64;
    let mut attempted_temporal_hold_by_class = [0_u64; 4];
    let mut attempted_temporal_hold_duration_cs = 0_u64;
    let mut attempted_temporal_max_observed_hold_duration_cs = 0_u16;
    let mut temporal_rejected_by_pair_count = 0_u64;
    let mut temporal_rejected_by_color_count = 0_u64;
    let mut temporal_rejected_by_budget_count = 0_u64;
    let mut cut_reset_pixel_count = 0_u64;
    let mut loop_seeded_pixel_count = 0_u64;

    for (frame_index, frame_delay_cs) in normalized_frame_delays_cs
        .iter()
        .copied()
        .enumerate()
        .take(frame_count)
    {
        let frame_byte_offset = frame_index * layout.frame_bytes;
        let frame_pixel_offset = frame_index * layout.pixels_per_frame;
        let frame = &pixels[frame_byte_offset..frame_byte_offset + layout.frame_bytes];
        let previous_frame_index = if frame_index > 0 {
            Some(frame_index - 1)
        } else if looping && frame_count > 1 {
            Some(frame_count - 1)
        } else {
            None
        };
        let previous_frame = previous_frame_index.map(|previous_index| {
            let start = previous_index * layout.frame_bytes;
            &pixels[start..start + layout.frame_bytes]
        });
        let mut cell_enabled = vec![false; cell_count];
        let mut cell_scene_cut = vec![false; cell_count];
        for cell_y in 0..grid_height {
            for cell_x in 0..grid_width {
                let cell = cell_y * grid_width + cell_x;
                let timeline_cell = frame_index * cell_count + cell;
                cell_enabled[cell] = eligibility_plan.strengths[timeline_cell] > 0.0;
                let bounds = region_cell_bounds(&layout, regions, cell_x, cell_y);
                let scene_cut = previous_frame
                    .map(|previous| cell_has_scene_cut(frame, previous, &layout, bounds))
                    .unwrap_or(false);
                cell_scene_cut[cell] = scene_cut;
                if scene_cut {
                    clear_cell_temporal_hold_state(
                        bounds,
                        &layout,
                        &mut hold_ages,
                        &mut hold_durations_cs,
                    );
                    let reset_pixels = u64::try_from(bounds.pixel_count()).unwrap_or(u64::MAX);
                    cut_reset_pixel_count = cut_reset_pixel_count.saturating_add(reset_pixels);
                }
            }
        }
        let edge_protection =
            build_error_diffusion_edge_protection_plan(frame, &layout, regions, &cell_enabled);

        for y in 0..layout.height {
            for x in 0..layout.width {
                let pixel_index = y * layout.width + x;
                let output_pixel = frame_pixel_offset + pixel_index;
                let byte = pixel_index * 3;
                let source_rgb = rgb_at(frame, byte);
                let source_lab = srgb8_to_oklab(source_rgb);
                let fallback_index = fallback_indices[output_pixel];
                let cell_x = region_cell_coordinate_for_pixel(x, layout.width, grid_width);
                let cell_y = region_cell_coordinate_for_pixel(y, layout.height, grid_height);
                let cell = cell_y * grid_width + cell_x;
                let class = usize::from(regions.class_map[cell]);
                let smooth_region = cell_enabled[cell];
                let scene_cut = cell_scene_cut[cell];
                let protected = smooth_region && edge_protection.protected[pixel_index];
                let opaque = palette_alpha[usize::from(fallback_index)] == u8::MAX;
                let has_temporal_predecessor = previous_frame.is_some();
                let micro_change_or_unseeded = previous_frame
                    .map(|previous| {
                        max_channel_delta(source_rgb, rgb_at(previous, byte))
                            <= TEMPORAL_MICRO_CHANGE_MAX_DELTA
                    })
                    // A one-shot first frame still receives the deterministic
                    // spatial pair. It must not, however, read or retain any
                    // synthetic previous index.
                    .unwrap_or(true);

                let mut eligibility_bits = 0_u8;
                if opaque {
                    eligibility_bits |= 1 << 0;
                    opaque_fallback_pixel_count = opaque_fallback_pixel_count.saturating_add(1);
                } else {
                    transparent_fallback_pixel_count =
                        transparent_fallback_pixel_count.saturating_add(1);
                }
                if smooth_region {
                    eligibility_bits |= 1 << 1;
                    smooth_region_pixel_count = smooth_region_pixel_count.saturating_add(1);
                }
                if !protected {
                    eligibility_bits |= 1 << 2;
                } else {
                    protected_edge_pixel_count = protected_edge_pixel_count.saturating_add(1);
                }
                if micro_change_or_unseeded {
                    eligibility_bits |= 1 << 3;
                }
                if !scene_cut {
                    eligibility_bits |= 1 << 4;
                } else {
                    scene_cut_fallback_pixel_count =
                        scene_cut_fallback_pixel_count.saturating_add(1);
                }
                edge_protection_mask_hasher.update([u8::from(protected)]);
                protected_mask[output_pixel] = protected;

                let base_eligible =
                    opaque && smooth_region && !protected && !scene_cut && micro_change_or_unseeded;
                let mut pair = None;
                if base_eligible {
                    eligibility_bits |= 1 << 5;
                    eligible_pixel_count = eligible_pixel_count.saturating_add(1);
                    change_eligible_mask[output_pixel] = true;
                    let bucket =
                        lookup[histogram_index(source_rgb[0], source_rgb[1], source_rgb[2])];
                    let (choice, search) = phase_locked_pair_choice(
                        source_lab,
                        fallback_index,
                        palette_labs[usize::from(fallback_index)],
                        bucket,
                        &emitted_palette_labs,
                        class,
                    );
                    pair_candidate_count =
                        pair_candidate_count.saturating_add(search.candidate_count);
                    skin_pair_hue_rejection_count = skin_pair_hue_rejection_count
                        .saturating_add(search.skin_hue_rejection_count);
                    skin_pair_chroma_rejection_count = skin_pair_chroma_rejection_count
                        .saturating_add(search.skin_chroma_rejection_count);
                    pair = choice;
                    if pair.is_some() {
                        eligibility_bits |= 1 << 6;
                        paired_pixel_count = paired_pixel_count.saturating_add(1);
                        if frame_index == 0 && looping && previous_frame.is_some() {
                            loop_seeded_pixel_count = loop_seeded_pixel_count.saturating_add(1);
                        }
                    } else {
                        no_bracketing_pair_fallback_pixel_count =
                            no_bracketing_pair_fallback_pixel_count.saturating_add(1);
                    }
                } else if opaque
                    && smooth_region
                    && !protected
                    && !scene_cut
                    && !micro_change_or_unseeded
                {
                    non_micro_change_fallback_pixel_count =
                        non_micro_change_fallback_pixel_count.saturating_add(1);
                }
                eligibility_mask_hasher.update([eligibility_bits]);

                let mut index = fallback_index;
                if let Some(choice) = pair {
                    pair_lookup_hasher.update([
                        fallback_index,
                        choice.alternate,
                        choice.alternate_rank_cutoff,
                    ]);
                    let spatial_rank = BAYER_8X8[(y & 7) * 8 + (x & 7)];
                    let spatial_index = if spatial_rank < choice.alternate_rank_cutoff {
                        choice.alternate
                    } else {
                        fallback_index
                    };
                    index = spatial_index;

                    if has_temporal_predecessor {
                        let previous_index = previous_indices[pixel_index];
                        if previous_index != spatial_index {
                            temporal_candidate_count = temporal_candidate_count.saturating_add(1);
                            let previous_belongs_to_pair = previous_index == fallback_index
                                || previous_index == choice.alternate;
                            let next_hold_duration_cs =
                                hold_durations_cs[pixel_index].saturating_add(frame_delay_cs);
                            let within_budget = max_hold_frames > 0
                                && max_hold_duration_cs > 0
                                && hold_ages[pixel_index] < max_hold_frames
                                && next_hold_duration_cs <= max_hold_duration_cs;
                            if !previous_belongs_to_pair {
                                temporal_rejected_by_pair_count =
                                    temporal_rejected_by_pair_count.saturating_add(1);
                                hold_ages[pixel_index] = 0;
                                hold_durations_cs[pixel_index] = 0;
                            } else if !within_budget {
                                temporal_rejected_by_budget_count =
                                    temporal_rejected_by_budget_count.saturating_add(1);
                                hold_ages[pixel_index] = 0;
                                hold_durations_cs[pixel_index] = 0;
                            } else {
                                let spatial_error = source_lab
                                    .distance_squared(palette_labs[usize::from(spatial_index)])
                                    .sqrt();
                                let previous_error = source_lab
                                    .distance_squared(palette_labs[usize::from(previous_index)])
                                    .sqrt();
                                let extra_error = if class == 2 {
                                    PHASE_LOCKED_PAIR_SKIN_TEMPORAL_EXTRA_ERROR
                                } else {
                                    PHASE_LOCKED_PAIR_FLAT_TEMPORAL_EXTRA_ERROR
                                };
                                if previous_error <= spatial_error + extra_error {
                                    index = previous_index;
                                    hold_ages[pixel_index] =
                                        hold_ages[pixel_index].saturating_add(1);
                                    hold_durations_cs[pixel_index] = next_hold_duration_cs;
                                    attempted_temporal_hold_count =
                                        attempted_temporal_hold_count.saturating_add(1);
                                    attempted_temporal_hold_by_class[class] =
                                        attempted_temporal_hold_by_class[class].saturating_add(1);
                                    attempted_temporal_hold_duration_cs =
                                        attempted_temporal_hold_duration_cs
                                            .saturating_add(u64::from(frame_delay_cs));
                                    attempted_temporal_max_observed_hold_duration_cs =
                                        attempted_temporal_max_observed_hold_duration_cs
                                            .max(next_hold_duration_cs);
                                } else {
                                    temporal_rejected_by_color_count =
                                        temporal_rejected_by_color_count.saturating_add(1);
                                    hold_ages[pixel_index] = 0;
                                    hold_durations_cs[pixel_index] = 0;
                                }
                            }
                        } else {
                            hold_ages[pixel_index] = 0;
                            hold_durations_cs[pixel_index] = 0;
                        }
                    } else {
                        // Non-loop frame zero has no temporal predecessor. Its
                        // output is the spatial phase choice above, never a
                        // hold from the initialized previous-index buffer.
                        hold_ages[pixel_index] = 0;
                        hold_durations_cs[pixel_index] = 0;
                    }
                } else {
                    pair_lookup_hasher.update([fallback_index, u8::MAX, 0]);
                    hold_ages[pixel_index] = 0;
                    hold_durations_cs[pixel_index] = 0;
                }

                indices[output_pixel] = index;
                let output_byte = output_pixel * 3;
                reconstructed[output_byte..output_byte + 3]
                    .copy_from_slice(&palette_rgb[usize::from(index)]);
                previous_indices[pixel_index] = index;
            }
        }
    }

    let pre_reject_changed_pixel_count = indices
        .iter()
        .zip(fallback_indices)
        .filter(|(candidate, fallback)| candidate != fallback)
        .count() as u64;
    let pre_reject_temporal_hold_count = attempted_temporal_hold_count;
    let fallback_metrics =
        evaluate_rgb24_candidate(pixels, &fallback_reconstructed, width, height)?;
    let attempted_metrics = evaluate_rgb24_candidate(pixels, &reconstructed, width, height)?;
    let stored_frame_early_rejected = pre_reject_changed_pixel_count > 0
        && phase_locked_pair_stored_metrics_reject(&fallback_metrics, &attempted_metrics);
    if stored_frame_early_rejected {
        indices.copy_from_slice(fallback_indices);
        reconstructed.copy_from_slice(&fallback_reconstructed);
        attempted_temporal_hold_count = 0;
        attempted_temporal_hold_by_class = [0; 4];
        attempted_temporal_hold_duration_cs = 0;
        attempted_temporal_max_observed_hold_duration_cs = 0;
    }
    let metrics = if stored_frame_early_rejected {
        fallback_metrics.clone()
    } else {
        attempted_metrics.clone()
    };

    let mut changed_pixel_count = 0_u64;
    let mut changed_pixel_by_class = [0_u64; 4];
    let mut protected_edge_index_change_count = 0_u64;
    let mut ineligible_index_change_count = 0_u64;
    for (output_pixel, (candidate, fallback)) in indices.iter().zip(fallback_indices).enumerate() {
        if candidate == fallback {
            continue;
        }
        changed_pixel_count = changed_pixel_count.saturating_add(1);
        let pixel_index = output_pixel % layout.pixels_per_frame;
        let x = pixel_index % layout.width;
        let y = pixel_index / layout.width;
        let cell_x = region_cell_coordinate_for_pixel(x, layout.width, grid_width);
        let cell_y = region_cell_coordinate_for_pixel(y, layout.height, grid_height);
        let class = usize::from(regions.class_map[cell_y * grid_width + cell_x]);
        changed_pixel_by_class[class] = changed_pixel_by_class[class].saturating_add(1);
        protected_edge_index_change_count = protected_edge_index_change_count
            .saturating_add(u64::from(protected_mask[output_pixel]));
        ineligible_index_change_count = ineligible_index_change_count
            .saturating_add(u64::from(!change_eligible_mask[output_pixel]));
    }
    let total_pixel_count = u64::try_from(layout.total_pixels)
        .map_err(|_| RegionalQuantizationError::DimensionOverflow)?;
    let fallback_preserved_pixel_count = total_pixel_count.saturating_sub(changed_pixel_count);
    debug_assert_eq!(protected_edge_index_change_count, 0);
    debug_assert_eq!(ineligible_index_change_count, 0);
    debug_assert!(paired_pixel_count <= eligible_pixel_count);
    debug_assert!(changed_pixel_count <= paired_pixel_count);
    debug_assert_eq!(
        fallback_preserved_pixel_count.saturating_add(changed_pixel_count),
        total_pixel_count
    );

    let (fallback_static_index_flip_count, fallback_vfr_weighted_static_index_flip_rate) =
        measure_static_index_flips(
            pixels,
            fallback_indices,
            &layout,
            &normalized_frame_delays_cs,
        );
    let (static_index_flip_count, vfr_weighted_static_index_flip_rate) =
        measure_static_index_flips(pixels, &indices, &layout, &normalized_frame_delays_cs);
    let fallback_loop_seam_static_index_flip_count =
        measure_loop_seam_static_index_flips(pixels, fallback_indices, &layout, looping);
    let loop_seam_static_index_flip_count =
        measure_loop_seam_static_index_flips(pixels, &indices, &layout, looping);
    let indices_sha256 = format!("{:x}", Sha256::digest(&indices));
    let reconstructed_rgb24_sha256 = format!("{:x}", Sha256::digest(&reconstructed));
    let diagnostics = PhaseLockedPairDiagnostics {
        kernel_config_sha256,
        fallback_route_id: fallback_route_id.to_string(),
        fallback_indices_sha256,
        pair_lookup_sha256: format!("{:x}", pair_lookup_hasher.finalize()),
        eligibility_mask_sha256: format!("{:x}", eligibility_mask_hasher.finalize()),
        edge_protection_mask_sha256: format!("{:x}", edge_protection_mask_hasher.finalize()),
        opaque_fallback_pixel_count,
        transparent_fallback_pixel_count,
        smooth_region_pixel_count,
        protected_edge_pixel_count,
        non_micro_change_fallback_pixel_count,
        scene_cut_fallback_pixel_count,
        no_bracketing_pair_fallback_pixel_count,
        eligible_pixel_count,
        paired_pixel_count,
        pair_candidate_count,
        changed_pixel_count,
        changed_pixel_by_class,
        fallback_preserved_pixel_count,
        protected_edge_index_change_count,
        ineligible_index_change_count,
        skin_pair_hue_rejection_count,
        skin_pair_chroma_rejection_count,
        temporal_candidate_count,
        temporal_hold_count: attempted_temporal_hold_count,
        temporal_hold_by_class: attempted_temporal_hold_by_class,
        temporal_hold_duration_cs: attempted_temporal_hold_duration_cs,
        temporal_max_observed_hold_duration_cs: attempted_temporal_max_observed_hold_duration_cs,
        temporal_rejected_by_pair_count,
        temporal_rejected_by_color_count,
        temporal_rejected_by_budget_count,
        cut_reset_pixel_count,
        loop_seeded_pixel_count,
        fallback_static_index_flip_count,
        static_index_flip_count,
        fallback_vfr_weighted_static_index_flip_rate,
        vfr_weighted_static_index_flip_rate,
        fallback_loop_seam_static_index_flip_count,
        loop_seam_static_index_flip_count,
        stored_frame_early_reject_count: u64::from(stored_frame_early_rejected),
        pre_reject_changed_pixel_count,
        pre_reject_temporal_hold_count,
        fallback_mean_oklab_error: fallback_metrics.mean_oklab_error,
        candidate_mean_oklab_error: attempted_metrics.mean_oklab_error,
        fallback_multiscale_banding_score: fallback_metrics.multiscale_banding_score,
        candidate_multiscale_banding_score: attempted_metrics.multiscale_banding_score,
    };

    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.phase-locked-pair-temporal.v1\0");
    update_phase_locked_pair_artifact_hash(
        &mut hasher,
        &diagnostics,
        width,
        height,
        layout.frame_count,
        max_hold_frames,
        max_hold_duration_cs,
        looping,
        &normalized_frame_delays_cs,
        &palette.sha256,
        &regions.sha256,
        &indices_sha256,
        &reconstructed_rgb24_sha256,
        &metrics,
    );
    let artifact_sha256 = format!("{:x}", hasher.finalize());

    Ok(RegionalQuantizationArtifact {
        indices,
        reconstructed_rgb24: reconstructed,
        report: RegionalQuantizationReport {
            frame_count: layout.frame_count,
            pixel_count: total_pixel_count,
            secondary_choice_count: 0,
            secondary_choice_by_class: [0; 4],
            temporal_hold_count: diagnostics.temporal_hold_count,
            temporal_hold_by_class: diagnostics.temporal_hold_by_class,
            temporal_policy_max_hold_frames: max_hold_frames,
            temporal_policy_max_hold_duration_cs: max_hold_duration_cs,
            temporal_hold_duration_cs: diagnostics.temporal_hold_duration_cs,
            temporal_max_observed_hold_duration_cs: diagnostics
                .temporal_max_observed_hold_duration_cs,
            spatial_kernel_id: "oklab_phase_locked_bracketing_pair_temporal_v1".to_string(),
            error_diffusion: None,
            phase_locked_pair: Some(diagnostics),
            metrics,
            indices_sha256,
            reconstructed_rgb24_sha256,
            artifact_sha256,
        },
    })
}

pub fn evaluate_rgb24_candidate(
    reference: &[u8],
    candidate: &[u8],
    width: u16,
    height: u16,
) -> Result<QuantizationMetrics, RegionalQuantizationError> {
    let layout = validate_layout(reference, width, height)?;
    if candidate.len() != reference.len() {
        return Err(RegionalQuantizationError::InvalidCandidateSize {
            expected: reference.len(),
            actual: candidate.len(),
        });
    }
    let sample_count = layout.total_pixels.min(MAX_METRIC_SAMPLES);
    let mut errors = Vec::with_capacity(sample_count);
    let mut error_sum = 0.0_f64;
    let mut edge_weighted_error_sum = 0.0_f64;
    let mut edge_weight_sum = 0.0_f64;
    let mut multiscale_low_frequency_sum = 0.0_f64;
    let mut multiscale_sample_count = 0_u64;
    let mut edge_gradient_error_sum = 0.0_f64;
    let mut static_temporal_sum = 0.0_f64;
    let mut static_count = 0_u64;
    let mut multiscale_static_temporal_sum = 0.0_f64;
    let mut multiscale_static_count = 0_u64;
    let multiscale_banding_score = multiscale_banding_score(candidate, &layout);

    for sample_index in 0..sample_count {
        let flat_index = sample_index * layout.total_pixels / sample_count;
        let byte = flat_index * 3;
        let source_rgb = [reference[byte], reference[byte + 1], reference[byte + 2]];
        let candidate_rgb = [candidate[byte], candidate[byte + 1], candidate[byte + 2]];
        let source_lab = srgb8_to_oklab(source_rgb);
        let candidate_lab = srgb8_to_oklab(candidate_rgb);
        let error = source_lab.distance_squared(candidate_lab).sqrt();
        errors.push(error);
        error_sum += error;

        let in_frame = flat_index % layout.pixels_per_frame;
        let frame_index = flat_index / layout.pixels_per_frame;
        let x = in_frame % layout.width;
        let y = in_frame / layout.width;
        let edge = local_luma_gradient(reference, &layout, byte, x, y);
        let candidate_edge = local_luma_gradient(candidate, &layout, byte, x, y);
        let edge_weight = 1.0 + 4.0 * f64::from(edge) / 255.0;
        edge_weighted_error_sum += error * edge_weight;
        edge_weight_sum += edge_weight;
        edge_gradient_error_sum += f64::from(edge.abs_diff(candidate_edge)) / 255.0;

        for scale in [2_usize, 4] {
            let source_low = box_average_rgb(reference, &layout, frame_index, x, y, scale);
            let candidate_low = box_average_rgb(candidate, &layout, frame_index, x, y, scale);
            let source_low_lab = srgb8_to_oklab(source_low);
            let candidate_low_lab = srgb8_to_oklab(candidate_low);
            multiscale_low_frequency_sum +=
                source_low_lab.distance_squared(candidate_low_lab).sqrt();
            multiscale_sample_count = multiscale_sample_count.saturating_add(1);

            if frame_index > 0 {
                let previous_source_low =
                    box_average_rgb(reference, &layout, frame_index - 1, x, y, scale);
                if max_channel_delta(source_low, previous_source_low) <= 4 {
                    let previous_candidate_low =
                        box_average_rgb(candidate, &layout, frame_index - 1, x, y, scale);
                    let source_delta = source_low_lab
                        .distance_squared(srgb8_to_oklab(previous_source_low))
                        .sqrt();
                    let candidate_delta = candidate_low_lab
                        .distance_squared(srgb8_to_oklab(previous_candidate_low))
                        .sqrt();
                    multiscale_static_temporal_sum += (candidate_delta - source_delta).abs();
                    multiscale_static_count = multiscale_static_count.saturating_add(1);
                }
            }
        }

        if flat_index >= layout.pixels_per_frame {
            let previous_byte = byte - layout.frame_bytes;
            let previous_source = rgb_at(reference, previous_byte);
            if max_channel_delta(source_rgb, previous_source) <= 4 {
                let previous_candidate = rgb_at(candidate, previous_byte);
                let source_delta = source_lab
                    .distance_squared(srgb8_to_oklab(previous_source))
                    .sqrt();
                let candidate_delta = candidate_lab
                    .distance_squared(srgb8_to_oklab(previous_candidate))
                    .sqrt();
                static_temporal_sum += (candidate_delta - source_delta).abs();
                static_count = static_count.saturating_add(1);
            }
        }
    }
    errors.sort_by(f64::total_cmp);
    let sampled =
        u64::try_from(errors.len()).map_err(|_| RegionalQuantizationError::DimensionOverflow)?;
    let p95_index = errors
        .len()
        .saturating_mul(95)
        .div_ceil(100)
        .saturating_sub(1);
    Ok(QuantizationMetrics {
        sampled_pixel_count: sampled,
        sampled_static_pixel_count: static_count,
        mean_oklab_error: error_sum / sampled.max(1) as f64,
        p95_oklab_error: errors.get(p95_index).copied().unwrap_or(0.0),
        edge_weighted_mean_oklab_error: edge_weighted_error_sum / edge_weight_sum.max(f64::EPSILON),
        multiscale_low_frequency_oklab_error: multiscale_low_frequency_sum
            / multiscale_sample_count.max(1) as f64,
        multiscale_banding_score,
        edge_gradient_error: edge_gradient_error_sum / sampled.max(1) as f64,
        static_temporal_residual: if static_count == 0 {
            0.0
        } else {
            static_temporal_sum / static_count as f64
        },
        multiscale_static_temporal_residual: if multiscale_static_count == 0 {
            0.0
        } else {
            multiscale_static_temporal_sum / multiscale_static_count as f64
        },
    })
}

/// Evaluates temporal fidelity using the actual VFR display timeline.
///
/// Each transition is weighted by the display duration of its current frame.
/// If `loops` is true, the last-to-first transition uses the first frame's
/// delay, participates in the aggregate, and is returned as a separate seam
/// metric so callers can reject loop-only flicker.
pub fn evaluate_timing_aware_temporal_residual(
    reference: &[u8],
    candidate: &[u8],
    width: u16,
    height: u16,
    frame_delays_cs: &[u16],
    loops: bool,
) -> Result<TimingAwareTemporalResidual, RegionalQuantizationError> {
    let layout = validate_layout(reference, width, height)?;
    if candidate.len() != reference.len() {
        return Err(RegionalQuantizationError::InvalidCandidateSize {
            expected: reference.len(),
            actual: candidate.len(),
        });
    }
    let frame_count = usize::try_from(layout.frame_count)
        .map_err(|_| RegionalQuantizationError::DimensionOverflow)?;
    let normalized_delays = normalize_frame_delays(frame_delays_cs, frame_count)?;
    let transition_count = frame_count.saturating_sub(1) + usize::from(loops);
    let samples_per_transition = layout
        .pixels_per_frame
        .min((MAX_METRIC_SAMPLES / transition_count.max(1)).max(1));
    let mut aggregate = TimingTransitionMeasurement::default();

    for (current_frame, current_delay_cs) in normalized_delays.iter().copied().enumerate().skip(1) {
        aggregate.add(measure_timing_transition(
            reference,
            candidate,
            &layout,
            current_frame - 1,
            current_frame,
            current_delay_cs,
            samples_per_transition,
        ));
    }

    let loop_seam = loops.then(|| {
        measure_timing_transition(
            reference,
            candidate,
            &layout,
            frame_count - 1,
            0,
            normalized_delays[0],
            samples_per_transition,
        )
    });
    if let Some(seam) = loop_seam {
        aggregate.add(seam);
    }

    Ok(TimingAwareTemporalResidual {
        sampled_static_transition_count: aggregate.static_count,
        weighted_static_sample_duration_cs: aggregate.static_duration_cs,
        weighted_static_temporal_residual: aggregate.static_mean(),
        sampled_multiscale_static_transition_count: aggregate.multiscale_count,
        weighted_multiscale_static_sample_duration_cs: aggregate.multiscale_duration_cs,
        weighted_multiscale_static_temporal_residual: aggregate.multiscale_mean(),
        loop_seam_sampled_static_pixel_count: loop_seam.map(|seam| seam.static_count).unwrap_or(0),
        loop_seam_static_temporal_residual: loop_seam.map(|seam| seam.static_mean()),
        loop_seam_sampled_multiscale_count: loop_seam
            .map(|seam| seam.multiscale_count)
            .unwrap_or(0),
        loop_seam_multiscale_static_temporal_residual: loop_seam.map(|seam| seam.multiscale_mean()),
    })
}

#[derive(Clone, Copy, Debug, Default)]
struct TimingTransitionMeasurement {
    static_count: u64,
    static_duration_cs: u64,
    static_weighted_sum: f64,
    multiscale_count: u64,
    multiscale_duration_cs: u64,
    multiscale_weighted_sum: f64,
}

impl TimingTransitionMeasurement {
    fn add(&mut self, other: Self) {
        self.static_count = self.static_count.saturating_add(other.static_count);
        self.static_duration_cs = self
            .static_duration_cs
            .saturating_add(other.static_duration_cs);
        self.static_weighted_sum += other.static_weighted_sum;
        self.multiscale_count = self.multiscale_count.saturating_add(other.multiscale_count);
        self.multiscale_duration_cs = self
            .multiscale_duration_cs
            .saturating_add(other.multiscale_duration_cs);
        self.multiscale_weighted_sum += other.multiscale_weighted_sum;
    }

    fn static_mean(self) -> f64 {
        self.static_weighted_sum / self.static_duration_cs.max(1) as f64
    }

    fn multiscale_mean(self) -> f64 {
        self.multiscale_weighted_sum / self.multiscale_duration_cs.max(1) as f64
    }
}

fn measure_timing_transition(
    reference: &[u8],
    candidate: &[u8],
    layout: &FrameLayout,
    previous_frame: usize,
    current_frame: usize,
    current_delay_cs: u16,
    sample_count: usize,
) -> TimingTransitionMeasurement {
    let mut measurement = TimingTransitionMeasurement::default();
    let weight = f64::from(current_delay_cs);
    let previous_offset = previous_frame * layout.frame_bytes;
    let current_offset = current_frame * layout.frame_bytes;

    for sample_index in 0..sample_count {
        let pixel_index = sample_index * layout.pixels_per_frame / sample_count;
        let pixel_byte = pixel_index * 3;
        let previous_source = rgb_at(reference, previous_offset + pixel_byte);
        let current_source = rgb_at(reference, current_offset + pixel_byte);
        if max_channel_delta(current_source, previous_source) <= 4 {
            let previous_candidate = rgb_at(candidate, previous_offset + pixel_byte);
            let current_candidate = rgb_at(candidate, current_offset + pixel_byte);
            let source_delta = srgb8_to_oklab(current_source)
                .distance_squared(srgb8_to_oklab(previous_source))
                .sqrt();
            let candidate_delta = srgb8_to_oklab(current_candidate)
                .distance_squared(srgb8_to_oklab(previous_candidate))
                .sqrt();
            measurement.static_weighted_sum += (candidate_delta - source_delta).abs() * weight;
            measurement.static_count = measurement.static_count.saturating_add(1);
            measurement.static_duration_cs = measurement
                .static_duration_cs
                .saturating_add(u64::from(current_delay_cs));
        }

        let x = pixel_index % layout.width;
        let y = pixel_index / layout.width;
        for scale in [2_usize, 4] {
            let previous_source = box_average_rgb(reference, layout, previous_frame, x, y, scale);
            let current_source = box_average_rgb(reference, layout, current_frame, x, y, scale);
            if max_channel_delta(current_source, previous_source) <= 4 {
                let previous_candidate =
                    box_average_rgb(candidate, layout, previous_frame, x, y, scale);
                let current_candidate =
                    box_average_rgb(candidate, layout, current_frame, x, y, scale);
                let source_delta = srgb8_to_oklab(current_source)
                    .distance_squared(srgb8_to_oklab(previous_source))
                    .sqrt();
                let candidate_delta = srgb8_to_oklab(current_candidate)
                    .distance_squared(srgb8_to_oklab(previous_candidate))
                    .sqrt();
                measurement.multiscale_weighted_sum +=
                    (candidate_delta - source_delta).abs() * weight;
                measurement.multiscale_count = measurement.multiscale_count.saturating_add(1);
                measurement.multiscale_duration_cs = measurement
                    .multiscale_duration_cs
                    .saturating_add(u64::from(current_delay_cs));
            }
        }
    }

    measurement
}

#[derive(Clone, Copy)]
struct FrameLayout {
    width: usize,
    height: usize,
    pixels_per_frame: usize,
    frame_bytes: usize,
    frame_count: u32,
    total_pixels: usize,
}

fn validate_layout(
    pixels: &[u8],
    width: u16,
    height: u16,
) -> Result<FrameLayout, RegionalQuantizationError> {
    if width == 0 || height == 0 {
        return Err(RegionalQuantizationError::ZeroDimensions);
    }
    let width = usize::from(width);
    let height = usize::from(height);
    let pixels_per_frame = width
        .checked_mul(height)
        .ok_or(RegionalQuantizationError::DimensionOverflow)?;
    let frame_bytes = pixels_per_frame
        .checked_mul(3)
        .ok_or(RegionalQuantizationError::DimensionOverflow)?;
    if pixels.is_empty() {
        return Err(RegionalQuantizationError::EmptyTimeline);
    }
    if !pixels.len().is_multiple_of(frame_bytes) {
        return Err(RegionalQuantizationError::InvalidRgb24Size {
            expected_multiple: frame_bytes,
            actual: pixels.len(),
        });
    }
    let frame_count = u32::try_from(pixels.len() / frame_bytes)
        .map_err(|_| RegionalQuantizationError::DimensionOverflow)?;
    Ok(FrameLayout {
        width,
        height,
        pixels_per_frame,
        frame_bytes,
        frame_count,
        total_pixels: pixels.len() / 3,
    })
}

fn normalize_frame_delays(
    frame_delays_cs: &[u16],
    frame_count: usize,
) -> Result<Vec<u16>, RegionalQuantizationError> {
    if frame_delays_cs.len() != frame_count {
        return Err(RegionalQuantizationError::InvalidFrameDelayCount {
            expected: frame_count,
            actual: frame_delays_cs.len(),
        });
    }
    // GIF renderers commonly clamp a zero delay to a small positive duration.
    // Counting it as one centisecond is the safer bound for temporal holds and
    // timing-weighted quality gates.
    Ok(frame_delays_cs
        .iter()
        .map(|delay| (*delay).max(1))
        .collect())
}

fn local_luma_gradient(pixels: &[u8], layout: &FrameLayout, byte: usize, x: usize, y: usize) -> u8 {
    let center = luma(rgb_at(pixels, byte));
    let mut gradient = 0_u8;
    if x + 1 < layout.width {
        gradient = gradient.max(center.abs_diff(luma(rgb_at(pixels, byte + 3))));
    }
    if y + 1 < layout.height {
        gradient = gradient.max(center.abs_diff(luma(rgb_at(pixels, byte + layout.width * 3))));
    }
    gradient
}

fn box_average_rgb(
    pixels: &[u8],
    layout: &FrameLayout,
    frame_index: usize,
    x: usize,
    y: usize,
    scale: usize,
) -> [u8; 3] {
    let left = x / scale * scale;
    let top = y / scale * scale;
    let right = (left + scale).min(layout.width);
    let bottom = (top + scale).min(layout.height);
    let frame_offset = frame_index * layout.frame_bytes;
    let mut sums = [0_u32; 3];
    let mut count = 0_u32;
    for sample_y in top..bottom {
        for sample_x in left..right {
            let byte = frame_offset + (sample_y * layout.width + sample_x) * 3;
            sums[0] += u32::from(pixels[byte]);
            sums[1] += u32::from(pixels[byte + 1]);
            sums[2] += u32::from(pixels[byte + 2]);
            count += 1;
        }
    }
    [
        ((sums[0] + count / 2) / count) as u8,
        ((sums[1] + count / 2) / count) as u8,
        ((sums[2] + count / 2) / count) as u8,
    ]
}

/// Lightweight, deterministic banding-risk proxy for candidate selection.
///
/// This intentionally is not CAMBI. It mirrors the parts that proved useful
/// in GIFP's offline CAMBI correlation set: limited-range luma, 2x2
/// anti-dither averaging, a flat-region mask, 3x3 mode filtering, local
/// adjacent-level co-occurrence, BT.1886 visibility thresholds, five spatial
/// scales and top-60% pooling. The presentation and frame caps keep it
/// suitable for an in-process gate.
fn multiscale_banding_score(candidate: &[u8], layout: &FrameLayout) -> f64 {
    let frame_count = usize::try_from(layout.frame_count).unwrap_or(usize::MAX);
    let sampled_frames = frame_count.clamp(1, MAX_BANDING_SAMPLE_FRAMES);
    let (presentation_width, presentation_height) = banding_presentation_size(layout);
    let mut total = 0.0_f64;
    for sample_index in 0..sampled_frames {
        let frame_index = sample_index * frame_count / sampled_frames;
        let frame_start = frame_index * layout.frame_bytes;
        let frame = &candidate[frame_start..frame_start + layout.frame_bytes];
        let luma = presentation_luma(
            frame,
            layout.width,
            layout.height,
            presentation_width,
            presentation_height,
        );
        total += banding_frame_score(&luma, presentation_width, presentation_height);
    }
    total / sampled_frames as f64
}

fn banding_presentation_size(layout: &FrameLayout) -> (usize, usize) {
    if layout.width <= BANDING_PRESENTATION_WIDTH && layout.height <= BANDING_PRESENTATION_HEIGHT {
        return (layout.width, layout.height);
    }
    let scale = (BANDING_PRESENTATION_WIDTH as f64 / layout.width as f64)
        .min(BANDING_PRESENTATION_HEIGHT as f64 / layout.height as f64)
        .min(1.0);
    (
        (layout.width as f64 * scale).round().max(1.0) as usize,
        (layout.height as f64 * scale).round().max(1.0) as usize,
    )
}

fn presentation_luma(
    frame: &[u8],
    source_width: usize,
    source_height: usize,
    output_width: usize,
    output_height: usize,
) -> Vec<u8> {
    if source_width == output_width && source_height == output_height {
        return frame
            .chunks_exact(3)
            .map(|rgb| limited_range_luma([rgb[0], rgb[1], rgb[2]]))
            .collect();
    }
    let mut output = Vec::with_capacity(output_width * output_height);
    for y in 0..output_height {
        let source_y = ((y as f64 + 0.5) * source_height as f64 / output_height as f64 - 0.5)
            .clamp(0.0, (source_height - 1) as f64);
        let y0 = source_y.floor() as usize;
        let y1 = (y0 + 1).min(source_height - 1);
        let y_weight = source_y - y0 as f64;
        for x in 0..output_width {
            let source_x = ((x as f64 + 0.5) * source_width as f64 / output_width as f64 - 0.5)
                .clamp(0.0, (source_width - 1) as f64);
            let x0 = source_x.floor() as usize;
            let x1 = (x0 + 1).min(source_width - 1);
            let x_weight = source_x - x0 as f64;
            let sample = |sample_x: usize, sample_y: usize| {
                let byte = (sample_y * source_width + sample_x) * 3;
                f64::from(limited_range_luma([
                    frame[byte],
                    frame[byte + 1],
                    frame[byte + 2],
                ]))
            };
            let top = sample(x0, y0) * (1.0 - x_weight) + sample(x1, y0) * x_weight;
            let bottom = sample(x0, y1) * (1.0 - x_weight) + sample(x1, y1) * x_weight;
            output.push((top * (1.0 - y_weight) + bottom * y_weight).round() as u8);
        }
    }
    output
}

fn limited_range_luma(rgb: [u8; 3]) -> u8 {
    let value =
        66_u32 * u32::from(rgb[0]) + 129_u32 * u32::from(rgb[1]) + 25_u32 * u32::from(rgb[2]) + 128;
    (((value >> 8) + 16).min(235)) as u8
}

fn anti_dither_luma(luma: &[u8], width: usize, height: usize) -> Vec<u16> {
    let mut output = vec![0_u16; width * height];
    for y in 0..height {
        let next_y = (y + 1).min(height - 1);
        for x in 0..width {
            let next_x = (x + 1).min(width - 1);
            output[y * width + x] = u16::from(luma[y * width + x])
                + u16::from(luma[y * width + next_x])
                + u16::from(luma[next_y * width + x])
                + u16::from(luma[next_y * width + next_x]);
        }
    }
    output
}

fn banding_spatial_mask(image: &[u16], width: usize, height: usize) -> Vec<u8> {
    let mut integral = vec![0_u32; (width + 1) * (height + 1)];
    let stride = width + 1;
    for y in 0..height {
        let mut row_sum = 0_u32;
        for x in 0..width {
            let index = y * width + x;
            let horizontal_equal = x + 1 == width || image[index] == image[index + 1];
            let vertical_equal = y + 1 == height || image[index] == image[index + width];
            row_sum += u32::from(horizontal_equal && vertical_equal);
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row_sum;
        }
    }
    let shifted_area = ((width >> 6) * (height >> 6)).max(1);
    let ceil_log2 = usize::BITS - (shifted_area - 1).leading_zeros();
    let mask_index = ((49_i64 + 3 * (i64::from(ceil_log2) - 11) - 1) / 2).max(1) as u32;
    let mut mask = vec![0_u8; width * height];
    for y in 0..height {
        let top = y.saturating_sub(3);
        let bottom = (y + 4).min(height);
        for x in 0..width {
            let left = x.saturating_sub(3);
            let right = (x + 4).min(width);
            let count = i64::from(integral[bottom * stride + right])
                + i64::from(integral[top * stride + left])
                - i64::from(integral[top * stride + right])
                - i64::from(integral[bottom * stride + left]);
            mask[y * width + x] = u8::from(count > i64::from(mask_index));
        }
    }
    mask
}

fn mode3(first: u16, second: u16, third: u16) -> u16 {
    if first == second || first == third {
        first
    } else if second == third {
        second
    } else {
        first.min(second).min(third)
    }
}

fn mode_filter_3x3(image: &[u16], width: usize, height: usize) -> Vec<u16> {
    let mut horizontal = vec![0_u16; width * height];
    let mut output = vec![0_u16; width * height];
    for y in 0..height {
        for x in 0..width {
            horizontal[y * width + x] = mode3(
                image[y * width + x.saturating_sub(1)],
                image[y * width + x],
                image[y * width + (x + 1).min(width - 1)],
            );
        }
    }
    for y in 0..height {
        for x in 0..width {
            output[y * width + x] = mode3(
                horizontal[y.saturating_sub(1) * width + x],
                horizontal[y * width + x],
                horizontal[(y + 1).min(height - 1) * width + x],
            );
        }
    }
    output
}

fn banding_scale_score(image: &[u16], mask: &[u8], width: usize, height: usize) -> (f64, Vec<u16>) {
    let filtered = mode_filter_3x3(image, width, height);
    let mut values = vec![0.0_f64; width * height];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if mask[index] == 0 {
                continue;
            }
            let center = filtered[index];
            let mut same = 0_u32;
            let mut adjacent_lower = [0_u32; 4];
            let mut adjacent_upper = [0_u32; 4];
            for sample_y in y.saturating_sub(2)..=(y + 2).min(height - 1) {
                for sample_x in x.saturating_sub(2)..=(x + 2).min(width - 1) {
                    let sample_index = sample_y * width + sample_x;
                    if mask[sample_index] == 0 {
                        continue;
                    }
                    let difference = filtered[sample_index].abs_diff(center);
                    if difference == 0 {
                        same += 1;
                    } else if difference <= 4 {
                        let target = if filtered[sample_index] < center {
                            &mut adjacent_lower
                        } else {
                            &mut adjacent_upper
                        };
                        target[usize::from(difference - 1)] += 1;
                    }
                }
            }
            values[index] = adjacent_lower
                .into_iter()
                .zip(adjacent_upper)
                .enumerate()
                .filter_map(|(difference, (lower, upper))| {
                    let count = lower.max(upper);
                    (count > 0 && center <= BANDING_TVI_MAX_LUMA_BY_DIFF[difference])
                        .then_some((difference, count))
                })
                .map(|(difference, count)| {
                    (difference + 1) as f64 * f64::from(same) * f64::from(count)
                        / f64::from(same + count)
                })
                .fold(0.0_f64, f64::max);
        }
    }
    values.sort_by(|left, right| right.total_cmp(left));
    let pooled_count = (values.len() * 3 / 5).max(1);
    (
        values[..pooled_count].iter().sum::<f64>() / pooled_count as f64 / 25.0,
        filtered,
    )
}

fn decimate_u16(input: &[u16], width: usize, height: usize) -> (Vec<u16>, usize, usize) {
    let next_width = width.div_ceil(2);
    let next_height = height.div_ceil(2);
    let mut output = vec![0_u16; next_width * next_height];
    for y in 0..next_height {
        for x in 0..next_width {
            output[y * next_width + x] =
                input[(y * 2).min(height - 1) * width + (x * 2).min(width - 1)];
        }
    }
    (output, next_width, next_height)
}

fn decimate_u8(input: &[u8], width: usize, height: usize) -> Vec<u8> {
    let next_width = width.div_ceil(2);
    let next_height = height.div_ceil(2);
    let mut output = vec![0_u8; next_width * next_height];
    for y in 0..next_height {
        for x in 0..next_width {
            output[y * next_width + x] =
                input[(y * 2).min(height - 1) * width + (x * 2).min(width - 1)];
        }
    }
    output
}

fn banding_frame_score(luma: &[u8], width: usize, height: usize) -> f64 {
    let mut image = anti_dither_luma(luma, width, height);
    let mut mask = banding_spatial_mask(&image, width, height);
    let mut scaled_width = width;
    let mut scaled_height = height;
    let mut weighted_score = 0.0_f64;
    for (scale, weight) in BANDING_SCALE_WEIGHTS.into_iter().enumerate() {
        let (scale_score, filtered) =
            banding_scale_score(&image, &mask, scaled_width, scaled_height);
        weighted_score += weight * scale_score;
        // CAMBI carries the mode-filtered image into the next scale before
        // decimation. Keeping the unfiltered image here hides coherent
        // contours that only emerge after repeated downsampling.
        image = filtered;
        if scale + 1 < BANDING_SCALE_WEIGHTS.len() {
            let old_width = scaled_width;
            let old_height = scaled_height;
            let decimated = decimate_u16(&image, old_width, old_height);
            image = decimated.0;
            scaled_width = decimated.1;
            scaled_height = decimated.2;
            mask = decimate_u8(&mask, old_width, old_height);
        }
    }
    weighted_score / BANDING_SCALE_WEIGHTS.into_iter().sum::<f64>()
}

fn opaque_palette_rgb(
    palette: &OklabPaletteArtifact,
) -> Result<Vec<[u8; 3]>, RegionalQuantizationError> {
    if palette.rgba.len() != 256 * 4 {
        return Err(RegionalQuantizationError::InvalidPalette);
    }
    let opaque_count = usize::from(palette.emitted_colors.saturating_sub(1)).min(255);
    if opaque_count == 0 {
        return Err(RegionalQuantizationError::InvalidPalette);
    }
    Ok(palette.rgba[..opaque_count * 4]
        .chunks_exact(4)
        .map(|rgba| [rgba[0], rgba[1], rgba[2]])
        .collect())
}

fn validate_regions(regions: &RegionDitherArtifact) -> Result<(), RegionalQuantizationError> {
    if regions.grid_width == 0 || regions.grid_height == 0 {
        return Err(RegionalQuantizationError::InvalidRegionMap {
            expected: 0,
            classes: regions.class_map.len(),
            strengths: regions.strength_map.len(),
        });
    }
    let expected = usize::from(regions.grid_width)
        .checked_mul(usize::from(regions.grid_height))
        .ok_or(RegionalQuantizationError::DimensionOverflow)?;
    if regions.class_map.len() != expected || regions.strength_map.len() != expected {
        return Err(RegionalQuantizationError::InvalidRegionMap {
            expected,
            classes: regions.class_map.len(),
            strengths: regions.strength_map.len(),
        });
    }
    if let Some((index, value)) = regions
        .class_map
        .iter()
        .copied()
        .enumerate()
        .find(|(_, value)| *value > 3)
    {
        return Err(RegionalQuantizationError::InvalidRegionClass { index, value });
    }
    Ok(())
}

fn region_cell_bounds(
    layout: &FrameLayout,
    regions: &RegionDitherArtifact,
    cell_x: usize,
    cell_y: usize,
) -> RegionCellBounds {
    let grid_width = usize::from(regions.grid_width);
    let grid_height = usize::from(regions.grid_height);
    RegionCellBounds {
        x_start: cell_x * layout.width / grid_width,
        x_end: (cell_x + 1) * layout.width / grid_width,
        y_start: cell_y * layout.height / grid_height,
        y_end: (cell_y + 1) * layout.height / grid_height,
    }
}

fn region_cell_coordinate_for_pixel(position: usize, extent: usize, grid_extent: usize) -> usize {
    // `region_cell_bounds` floors both endpoints. The usual
    // `position * grid / extent` lookup is not its inverse when the extent is
    // not divisible by the grid (for example x=26 at width=420/grid=16).
    ((position + 1) * grid_extent - 1) / extent
}

#[cfg(test)]
fn plan_error_diffusion_strengths(
    pixels: &[u8],
    layout: &FrameLayout,
    regions: &RegionDitherArtifact,
) -> Vec<f64> {
    let grid_width = usize::from(regions.grid_width);
    let grid_height = usize::from(regions.grid_height);
    let frame_count = usize::try_from(layout.frame_count).unwrap_or(usize::MAX);
    let cell_count = grid_width * grid_height;
    let mut strengths = vec![0.0_f64; frame_count.saturating_mul(cell_count)];
    for (frame_index, frame) in pixels.chunks_exact(layout.frame_bytes).enumerate() {
        for cell_y in 0..grid_height {
            for cell_x in 0..grid_width {
                let cell = cell_y * grid_width + cell_x;
                let class = usize::from(regions.class_map[cell]);
                if class != 0 && class != 2 {
                    continue;
                }
                let bounds = region_cell_bounds(layout, regions, cell_x, cell_y);
                if bounds.is_empty() || !cell_is_smooth_gradient(frame, layout, bounds, class) {
                    continue;
                }
                strengths[frame_index * cell_count + cell] = if class == 0 {
                    ERROR_DIFFUSION_FLAT_STRENGTH
                } else {
                    ERROR_DIFFUSION_SKIN_MIN_STRENGTH
                        + f64::from(regions.strength_map[cell]) / 255.0
                            * ERROR_DIFFUSION_SKIN_STRENGTH_RANGE
                };
            }
        }
    }
    strengths
}

fn measure_gradient_cell_stats(
    frame: &[u8],
    layout: &FrameLayout,
    bounds: RegionCellBounds,
) -> Option<GradientCellStats> {
    if bounds.is_empty() {
        return None;
    }
    let mut stats = GradientCellStats {
        minimum: [u8::MAX; 3],
        maximum: [u8::MIN; 3],
        ..GradientCellStats::default()
    };
    for y in bounds.y_start..bounds.y_end {
        for x in bounds.x_start..bounds.x_end {
            let byte = (y * layout.width + x) * 3;
            let rgb = rgb_at(frame, byte);
            for (channel, value) in rgb.iter().copied().enumerate() {
                stats.minimum[channel] = stats.minimum[channel].min(value);
                stats.maximum[channel] = stats.maximum[channel].max(value);
            }
            if x + 1 < bounds.x_end {
                let delta = max_channel_delta(rgb, rgb_at(frame, byte + 3));
                stats.transition_sum = stats.transition_sum.saturating_add(u64::from(delta));
                stats.transition_count = stats.transition_count.saturating_add(1);
                stats.edge_count = stats
                    .edge_count
                    .saturating_add(u64::from(delta > ERROR_DIFFUSION_EDGE_DELTA));
            }
            if y + 1 < bounds.y_end {
                let delta =
                    max_channel_delta(rgb, rgb_at(frame, byte + layout.width.saturating_mul(3)));
                stats.transition_sum = stats.transition_sum.saturating_add(u64::from(delta));
                stats.transition_count = stats.transition_count.saturating_add(1);
                stats.edge_count = stats
                    .edge_count
                    .saturating_add(u64::from(delta > ERROR_DIFFUSION_EDGE_DELTA));
            }
        }
    }
    Some(stats)
}

fn gradient_cell_is_smooth(stats: GradientCellStats, class: usize) -> bool {
    if stats.transition_count == 0 {
        return false;
    }
    let mean_neighbor_delta = stats.transition_sum as f64 / stats.transition_count as f64;
    let edge_fraction = stats.edge_count as f64 / stats.transition_count as f64;
    let (max_mean_neighbor_delta, max_edge_fraction) = if class == 2 {
        (
            ERROR_DIFFUSION_SKIN_MAX_MEAN_NEIGHBOR_DELTA,
            ERROR_DIFFUSION_SKIN_MAX_EDGE_FRACTION,
        )
    } else {
        (
            ERROR_DIFFUSION_FLAT_MAX_MEAN_NEIGHBOR_DELTA,
            ERROR_DIFFUSION_FLAT_MAX_EDGE_FRACTION,
        )
    };
    mean_neighbor_delta <= max_mean_neighbor_delta && edge_fraction <= max_edge_fraction
}

#[allow(clippy::too_many_arguments)]
fn cells_share_coherent_gradient_boundary(
    frame: &[u8],
    layout: &FrameLayout,
    regions: &RegionDitherArtifact,
    cell_x: usize,
    cell_y: usize,
    neighbor_x: usize,
    neighbor_y: usize,
    class: usize,
) -> bool {
    let bounds = region_cell_bounds(layout, regions, cell_x, cell_y);
    let neighbor_bounds = region_cell_bounds(layout, regions, neighbor_x, neighbor_y);
    let mut delta_sum = 0_u64;
    let mut sample_count = 0_u64;
    let mut sample = |x: usize, y: usize, neighbor_x: usize, neighbor_y: usize| {
        let left = rgb_at(frame, (y * layout.width + x) * 3);
        let right = rgb_at(frame, (neighbor_y * layout.width + neighbor_x) * 3);
        let delta = max_channel_delta(left, right);
        delta_sum = delta_sum.saturating_add(u64::from(delta));
        sample_count = sample_count.saturating_add(1);
        delta <= ERROR_DIFFUSION_EDGE_DELTA
    };
    let no_hard_edge = if cell_x + 1 == neighbor_x && cell_y == neighbor_y {
        let x = bounds.x_end.saturating_sub(1);
        (bounds.y_start.max(neighbor_bounds.y_start)..bounds.y_end.min(neighbor_bounds.y_end))
            .all(|y| sample(x, y, neighbor_bounds.x_start, y))
    } else if neighbor_x + 1 == cell_x && cell_y == neighbor_y {
        let neighbor_edge_x = neighbor_bounds.x_end.saturating_sub(1);
        (bounds.y_start.max(neighbor_bounds.y_start)..bounds.y_end.min(neighbor_bounds.y_end))
            .all(|y| sample(bounds.x_start, y, neighbor_edge_x, y))
    } else if cell_y + 1 == neighbor_y && cell_x == neighbor_x {
        let y = bounds.y_end.saturating_sub(1);
        (bounds.x_start.max(neighbor_bounds.x_start)..bounds.x_end.min(neighbor_bounds.x_end))
            .all(|x| sample(x, y, x, neighbor_bounds.y_start))
    } else if neighbor_y + 1 == cell_y && cell_x == neighbor_x {
        let neighbor_edge_y = neighbor_bounds.y_end.saturating_sub(1);
        (bounds.x_start.max(neighbor_bounds.x_start)..bounds.x_end.min(neighbor_bounds.x_end))
            .all(|x| sample(x, bounds.y_start, x, neighbor_edge_y))
    } else {
        false
    };
    if !no_hard_edge || sample_count == 0 {
        return false;
    }
    let max_mean = if class == 2 {
        ERROR_DIFFUSION_COHERENCE_SKIN_MAX_BOUNDARY_DELTA
    } else {
        ERROR_DIFFUSION_COHERENCE_FLAT_MAX_BOUNDARY_DELTA
    };
    delta_sum as f64 / sample_count as f64 <= max_mean
}

fn plan_error_diffusion_v5_eligibility(
    pixels: &[u8],
    layout: &FrameLayout,
    regions: &RegionDitherArtifact,
) -> ErrorDiffusionEligibilityPlan {
    let grid_width = usize::from(regions.grid_width);
    let grid_height = usize::from(regions.grid_height);
    let frame_count = usize::try_from(layout.frame_count).unwrap_or(usize::MAX);
    let cell_count = grid_width * grid_height;
    let timeline_cells = frame_count.saturating_mul(cell_count);
    let mut plan = ErrorDiffusionEligibilityPlan {
        strengths: vec![0.0; timeline_cells],
        direct: vec![false; timeline_cells],
        coherence_rescued: vec![false; timeline_cells],
    };
    for (frame_index, frame) in pixels.chunks_exact(layout.frame_bytes).enumerate() {
        let mut stats = vec![None; cell_count];
        let mut smooth = vec![false; cell_count];
        for cell_y in 0..grid_height {
            for cell_x in 0..grid_width {
                let cell = cell_y * grid_width + cell_x;
                let class = usize::from(regions.class_map[cell]);
                if class != 0 && class != 2 {
                    continue;
                }
                let measured = measure_gradient_cell_stats(
                    frame,
                    layout,
                    region_cell_bounds(layout, regions, cell_x, cell_y),
                );
                if let Some(measured) = measured {
                    smooth[cell] = gradient_cell_is_smooth(measured, class);
                    plan.direct[frame_index * cell_count + cell] = smooth[cell]
                        && measured.channel_range() >= ERROR_DIFFUSION_MIN_CELL_CHANNEL_RANGE;
                    stats[cell] = Some(measured);
                }
            }
        }
        for cell_y in 0..grid_height {
            for cell_x in 0..grid_width {
                let cell = cell_y * grid_width + cell_x;
                let timeline_cell = frame_index * cell_count + cell;
                let class = usize::from(regions.class_map[cell]);
                if (class != 0 && class != 2) || !smooth[cell] {
                    continue;
                }
                let mut enabled = plan.direct[timeline_cell];
                if !enabled {
                    let mut combined = stats[cell].unwrap_or_default();
                    let neighbors = [
                        cell_x.checked_sub(1).map(|x| (x, cell_y)),
                        (cell_x + 1 < grid_width).then_some((cell_x + 1, cell_y)),
                        cell_y.checked_sub(1).map(|y| (cell_x, y)),
                        (cell_y + 1 < grid_height).then_some((cell_x, cell_y + 1)),
                    ];
                    for (neighbor_x, neighbor_y) in neighbors.into_iter().flatten() {
                        let neighbor = neighbor_y * grid_width + neighbor_x;
                        let neighbor_timeline_cell = frame_index * cell_count + neighbor;
                        if usize::from(regions.class_map[neighbor]) != class
                            || !smooth[neighbor]
                            || plan.direct[neighbor_timeline_cell]
                        {
                            continue;
                        }
                        if cells_share_coherent_gradient_boundary(
                            frame, layout, regions, cell_x, cell_y, neighbor_x, neighbor_y, class,
                        ) {
                            combined.include(stats[neighbor].unwrap_or_default());
                        }
                    }
                    enabled = combined.channel_range() >= ERROR_DIFFUSION_MIN_CELL_CHANNEL_RANGE;
                    plan.coherence_rescued[timeline_cell] = enabled;
                }
                if enabled {
                    plan.strengths[timeline_cell] = if class == 0 {
                        ERROR_DIFFUSION_FLAT_STRENGTH
                    } else {
                        ERROR_DIFFUSION_SKIN_MIN_STRENGTH
                            + f64::from(regions.strength_map[cell]) / 255.0
                                * ERROR_DIFFUSION_SKIN_STRENGTH_RANGE
                    };
                }
            }
        }
    }
    plan
}

fn build_error_diffusion_edge_protection_plan(
    frame: &[u8],
    layout: &FrameLayout,
    regions: &RegionDitherArtifact,
    cell_enabled: &[bool],
) -> EdgeProtectionPlan {
    let grid_width = usize::from(regions.grid_width);
    let grid_height = usize::from(regions.grid_height);
    let mut seeds = vec![false; layout.pixels_per_frame];
    let eligible = |x: usize, y: usize| {
        let cell_x = region_cell_coordinate_for_pixel(x, layout.width, grid_width);
        let cell_y = region_cell_coordinate_for_pixel(y, layout.height, grid_height);
        cell_enabled[cell_y * grid_width + cell_x]
    };
    for y in 0..layout.height {
        for x in 0..layout.width {
            if !eligible(x, y) {
                continue;
            }
            let source = rgb_at(frame, (y * layout.width + x) * 3);
            let hard_edge = (x > 0
                && max_channel_delta(source, rgb_at(frame, (y * layout.width + x - 1) * 3))
                    > ERROR_DIFFUSION_EDGE_DELTA)
                || (x + 1 < layout.width
                    && max_channel_delta(source, rgb_at(frame, (y * layout.width + x + 1) * 3))
                        > ERROR_DIFFUSION_EDGE_DELTA)
                || (y > 0
                    && max_channel_delta(source, rgb_at(frame, ((y - 1) * layout.width + x) * 3))
                        > ERROR_DIFFUSION_EDGE_DELTA)
                || (y + 1 < layout.height
                    && max_channel_delta(source, rgb_at(frame, ((y + 1) * layout.width + x) * 3))
                        > ERROR_DIFFUSION_EDGE_DELTA);
            seeds[y * layout.width + x] = hard_edge;
        }
    }
    let mut protected = seeds.clone();
    for y in 0..layout.height {
        for x in 0..layout.width {
            if !seeds[y * layout.width + x] {
                continue;
            }
            let y_start = y.saturating_sub(ERROR_DIFFUSION_EDGE_HALO_RADIUS_PX);
            let y_end = (y + ERROR_DIFFUSION_EDGE_HALO_RADIUS_PX + 1).min(layout.height);
            let x_start = x.saturating_sub(ERROR_DIFFUSION_EDGE_HALO_RADIUS_PX);
            let x_end = (x + ERROR_DIFFUSION_EDGE_HALO_RADIUS_PX + 1).min(layout.width);
            for neighbor_y in y_start..y_end {
                for neighbor_x in x_start..x_end {
                    if eligible(neighbor_x, neighbor_y) {
                        protected[neighbor_y * layout.width + neighbor_x] = true;
                    }
                }
            }
        }
    }
    EdgeProtectionPlan { seeds, protected }
}

fn cell_has_scene_cut(
    frame: &[u8],
    previous_frame: &[u8],
    layout: &FrameLayout,
    bounds: RegionCellBounds,
) -> bool {
    let mut delta_sum = 0_u64;
    let mut changed_pixels = 0_u64;
    let pixel_count = u64::try_from(bounds.pixel_count()).unwrap_or(u64::MAX);
    if pixel_count == 0 {
        return false;
    }
    for y in bounds.y_start..bounds.y_end {
        for x in bounds.x_start..bounds.x_end {
            let byte = (y * layout.width + x) * 3;
            let delta = max_channel_delta(rgb_at(frame, byte), rgb_at(previous_frame, byte));
            delta_sum = delta_sum.saturating_add(u64::from(delta));
            changed_pixels = changed_pixels
                .saturating_add(u64::from(delta > ERROR_DIFFUSION_SCENE_CUT_PIXEL_DELTA));
        }
    }
    delta_sum >= pixel_count.saturating_mul(ERROR_DIFFUSION_SCENE_CUT_MEAN_DELTA)
        || changed_pixels.saturating_mul(ERROR_DIFFUSION_SCENE_CUT_CHANGED_PIXEL_DENOMINATOR)
            >= pixel_count
}

fn clear_cell_temporal_hold_state(
    bounds: RegionCellBounds,
    layout: &FrameLayout,
    hold_ages: &mut [u8],
    hold_durations_cs: &mut [u16],
) {
    for y in bounds.y_start..bounds.y_end {
        let start = y * layout.width + bounds.x_start;
        let end = y * layout.width + bounds.x_end;
        hold_ages[start..end].fill(0);
        hold_durations_cs[start..end].fill(0);
    }
}

#[cfg(test)]
fn cell_is_smooth_gradient(
    frame: &[u8],
    layout: &FrameLayout,
    bounds: RegionCellBounds,
    class: usize,
) -> bool {
    let mut minimum = [u8::MAX; 3];
    let mut maximum = [u8::MIN; 3];
    let mut transition_sum = 0_u64;
    let mut transition_count = 0_u64;
    let mut edge_count = 0_u64;

    for y in bounds.y_start..bounds.y_end {
        for x in bounds.x_start..bounds.x_end {
            let byte = (y * layout.width + x) * 3;
            let rgb = rgb_at(frame, byte);
            for channel in 0..3 {
                minimum[channel] = minimum[channel].min(rgb[channel]);
                maximum[channel] = maximum[channel].max(rgb[channel]);
            }
            if x + 1 < bounds.x_end {
                let delta = max_channel_delta(rgb, rgb_at(frame, byte + 3));
                transition_sum = transition_sum.saturating_add(u64::from(delta));
                transition_count = transition_count.saturating_add(1);
                edge_count =
                    edge_count.saturating_add(u64::from(delta > ERROR_DIFFUSION_EDGE_DELTA));
            }
            if y + 1 < bounds.y_end {
                let delta =
                    max_channel_delta(rgb, rgb_at(frame, byte + layout.width.saturating_mul(3)));
                transition_sum = transition_sum.saturating_add(u64::from(delta));
                transition_count = transition_count.saturating_add(1);
                edge_count =
                    edge_count.saturating_add(u64::from(delta > ERROR_DIFFUSION_EDGE_DELTA));
            }
        }
    }

    let channel_range = (0..3)
        .map(|channel| maximum[channel].saturating_sub(minimum[channel]))
        .max()
        .unwrap_or(0);
    if channel_range < ERROR_DIFFUSION_MIN_CELL_CHANNEL_RANGE || transition_count == 0 {
        return false;
    }
    let mean_neighbor_delta = transition_sum as f64 / transition_count as f64;
    let edge_fraction = edge_count as f64 / transition_count as f64;
    let (max_mean_neighbor_delta, max_edge_fraction) = if class == 2 {
        (
            ERROR_DIFFUSION_SKIN_MAX_MEAN_NEIGHBOR_DELTA,
            ERROR_DIFFUSION_SKIN_MAX_EDGE_FRACTION,
        )
    } else {
        (
            ERROR_DIFFUSION_FLAT_MAX_MEAN_NEIGHBOR_DELTA,
            ERROR_DIFFUSION_FLAT_MAX_EDGE_FRACTION,
        )
    };
    mean_neighbor_delta <= max_mean_neighbor_delta && edge_fraction <= max_edge_fraction
}

fn nearest_palette_index_for_lab(source: Oklab, palette: &[Oklab]) -> u8 {
    palette
        .iter()
        .copied()
        .enumerate()
        .map(|(index, candidate)| {
            (
                u8::try_from(index).unwrap_or(u8::MAX),
                source.distance_squared(candidate),
            )
        })
        .reduce(|best, candidate| {
            if palette_rank_before(candidate, best) {
                candidate
            } else {
                best
            }
        })
        .map(|best| best.0)
        .unwrap_or(0)
}

#[cfg(test)]
fn palette_bucket_contains(bucket: PaletteLookupBucket, index: u8) -> bool {
    bucket.indices[..usize::from(bucket.len)].contains(&index)
}

fn phase_locked_pair_choice(
    source: Oklab,
    fallback_index: u8,
    fallback: Oklab,
    bucket: PaletteLookupBucket,
    emitted_palette: &[Oklab],
    class: usize,
) -> (
    Option<PhaseLockedPairChoice>,
    PhaseLockedPairSearchDiagnostics,
) {
    let mut best = None;
    let mut diagnostics = PhaseLockedPairSearchDiagnostics::default();
    for alternate in bucket.indices[..usize::from(bucket.len)].iter().copied() {
        if alternate == fallback_index {
            continue;
        }
        let alternate_lab = emitted_palette[usize::from(alternate)];
        let dl = alternate_lab.l - fallback.l;
        let da = alternate_lab.a - fallback.a;
        let db = alternate_lab.b - fallback.b;
        let span_squared = dl.mul_add(dl, da.mul_add(da, db * db));
        if span_squared <= f64::EPSILON {
            continue;
        }
        diagnostics.candidate_count = diagnostics.candidate_count.saturating_add(1);

        if class == 2 {
            let (hue_rejected, chroma_rejected) =
                phase_locked_skin_pair_rejection(source, fallback, alternate_lab);
            if hue_rejected {
                diagnostics.skin_hue_rejection_count =
                    diagnostics.skin_hue_rejection_count.saturating_add(1);
            }
            if chroma_rejected {
                diagnostics.skin_chroma_rejection_count =
                    diagnostics.skin_chroma_rejection_count.saturating_add(1);
            }
            if hue_rejected || chroma_rejected {
                continue;
            }
        }

        let source_l = source.l - fallback.l;
        let source_a = source.a - fallback.a;
        let source_b = source.b - fallback.b;
        let projection = (source_l * dl + source_a * da + source_b * db) / span_squared;
        if !(0.0..1.0).contains(&projection) || projection == 0.0 {
            continue;
        }
        let rank_cutoff = (projection * 64.0).round().clamp(0.0, 64.0) as u8;
        if rank_cutoff == 0 || rank_cutoff >= 64 {
            continue;
        }
        let projected = Oklab {
            l: fallback.l + dl * projection,
            a: fallback.a + da * projection,
            b: fallback.b + db * projection,
        };
        if class == 2 {
            let (hue_rejected, chroma_rejected) =
                phase_locked_skin_pair_rejection(source, projected, projected);
            if hue_rejected {
                diagnostics.skin_hue_rejection_count =
                    diagnostics.skin_hue_rejection_count.saturating_add(1);
            }
            if chroma_rejected {
                diagnostics.skin_chroma_rejection_count =
                    diagnostics.skin_chroma_rejection_count.saturating_add(1);
            }
            if hue_rejected || chroma_rejected {
                continue;
            }
        }
        let segment_error_squared = source.distance_squared(projected);
        let max_segment_error = if class == 2 {
            PHASE_LOCKED_PAIR_SKIN_MAX_SEGMENT_ERROR
        } else {
            PHASE_LOCKED_PAIR_FLAT_MAX_SEGMENT_ERROR
        };
        let max_endpoint_error = if class == 2 {
            PHASE_LOCKED_PAIR_SKIN_MAX_ENDPOINT_ERROR
        } else {
            PHASE_LOCKED_PAIR_FLAT_MAX_ENDPOINT_ERROR
        };
        if segment_error_squared.sqrt() > max_segment_error
            || source.distance_squared(fallback).sqrt() > max_endpoint_error
            || source.distance_squared(alternate_lab).sqrt() > max_endpoint_error
        {
            continue;
        }

        let candidate = PhaseLockedPairChoice {
            alternate,
            alternate_rank_cutoff: rank_cutoff,
            segment_error_squared,
            segment_span_squared: span_squared,
        };
        let replace = best
            .map(|current: PhaseLockedPairChoice| {
                candidate
                    .segment_error_squared
                    .total_cmp(&current.segment_error_squared)
                    .then_with(|| {
                        candidate
                            .segment_span_squared
                            .total_cmp(&current.segment_span_squared)
                    })
                    .then_with(|| candidate.alternate.cmp(&current.alternate))
                    .is_lt()
            })
            .unwrap_or(true);
        if replace {
            best = Some(candidate);
        }
    }
    (best, diagnostics)
}

fn phase_locked_skin_pair_rejection(source: Oklab, first: Oklab, second: Oklab) -> (bool, bool) {
    let source_chroma = phase_locked_chroma(source);
    let mut hue_rejected = false;
    let mut chroma_rejected = false;
    for endpoint in [first, second] {
        let endpoint_chroma = phase_locked_chroma(endpoint);
        chroma_rejected |=
            (endpoint_chroma - source_chroma).abs() > PHASE_LOCKED_PAIR_SKIN_MAX_CHROMA_DELTA;
        if source_chroma >= PHASE_LOCKED_PAIR_SKIN_MIN_HUE_CHROMA {
            hue_rejected |= endpoint_chroma < PHASE_LOCKED_PAIR_SKIN_MIN_HUE_CHROMA
                || phase_locked_hue_delta(source, endpoint)
                    > PHASE_LOCKED_PAIR_SKIN_MAX_HUE_DELTA_RADIANS;
        }
    }
    (hue_rejected, chroma_rejected)
}

fn phase_locked_chroma(color: Oklab) -> f64 {
    color.a.mul_add(color.a, color.b * color.b).sqrt()
}

fn phase_locked_hue_delta(first: Oklab, second: Oklab) -> f64 {
    let first_hue = first.b.atan2(first.a);
    let second_hue = second.b.atan2(second.a);
    let delta = (first_hue - second_hue).abs();
    delta.min(std::f64::consts::TAU - delta)
}

/// Stable identity of every constant that can affect the phase-locked pair
/// decision. Callers may persist this alongside device/presentation evidence.
pub fn phase_locked_pair_kernel_config_sha256() -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.phase-locked-pair-kernel-config.v2\0");
    hasher.update(
        u64::try_from(HISTOGRAM_SIDE)
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    hasher.update(
        u64::try_from(PALETTE_BUCKET_CANDIDATES)
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    hasher.update(BAYER_8X8);
    hasher.update([TEMPORAL_MICRO_CHANGE_MAX_DELTA]);
    // The public policy is bounded by these global caps before the stricter
    // phase-kernel envelope is applied. Bind both layers so lowering either
    // cap cannot silently preserve the same kernel identity.
    hasher.update([TEMPORAL_HYSTERESIS_MAX_HOLD_FRAMES]);
    hasher.update(TEMPORAL_HYSTERESIS_MAX_HOLD_DURATION_CS.to_le_bytes());
    hasher.update([PHASE_LOCKED_PAIR_MAX_HOLD_FRAMES]);
    hasher.update(PHASE_LOCKED_PAIR_MAX_HOLD_DURATION_CS.to_le_bytes());
    hasher.update([ERROR_DIFFUSION_MIN_CELL_CHANNEL_RANGE]);
    hasher.update([ERROR_DIFFUSION_EDGE_DELTA]);
    hasher.update(
        u64::try_from(ERROR_DIFFUSION_EDGE_HALO_RADIUS_PX)
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    hasher.update(ERROR_DIFFUSION_SCENE_CUT_MEAN_DELTA.to_le_bytes());
    hasher.update([ERROR_DIFFUSION_SCENE_CUT_PIXEL_DELTA]);
    hasher.update(ERROR_DIFFUSION_SCENE_CUT_CHANGED_PIXEL_DENOMINATOR.to_le_bytes());
    // Stored-frame early rejection calls the shared metric evaluator. Its
    // named sampling/presentation constants are part of the phase decision,
    // not merely report decoration.
    for value in [
        MAX_METRIC_SAMPLES,
        MAX_BANDING_SAMPLE_FRAMES,
        BANDING_PRESENTATION_WIDTH,
        BANDING_PRESENTATION_HEIGHT,
    ] {
        hasher.update(u64::try_from(value).unwrap_or(u64::MAX).to_le_bytes());
    }
    for value in BANDING_SCALE_WEIGHTS {
        hasher.update(value.to_bits().to_le_bytes());
    }
    for value in BANDING_TVI_MAX_LUMA_BY_DIFF {
        hasher.update(value.to_le_bytes());
    }
    for value in [
        ERROR_DIFFUSION_FLAT_STRENGTH,
        ERROR_DIFFUSION_SKIN_MIN_STRENGTH,
        ERROR_DIFFUSION_SKIN_STRENGTH_RANGE,
        ERROR_DIFFUSION_FLAT_MAX_MEAN_NEIGHBOR_DELTA,
        ERROR_DIFFUSION_SKIN_MAX_MEAN_NEIGHBOR_DELTA,
        ERROR_DIFFUSION_FLAT_MAX_EDGE_FRACTION,
        ERROR_DIFFUSION_SKIN_MAX_EDGE_FRACTION,
        ERROR_DIFFUSION_COHERENCE_FLAT_MAX_BOUNDARY_DELTA,
        ERROR_DIFFUSION_COHERENCE_SKIN_MAX_BOUNDARY_DELTA,
        PHASE_LOCKED_PAIR_FLAT_MAX_SEGMENT_ERROR,
        PHASE_LOCKED_PAIR_SKIN_MAX_SEGMENT_ERROR,
        PHASE_LOCKED_PAIR_FLAT_MAX_ENDPOINT_ERROR,
        PHASE_LOCKED_PAIR_SKIN_MAX_ENDPOINT_ERROR,
        PHASE_LOCKED_PAIR_SKIN_MIN_HUE_CHROMA,
        PHASE_LOCKED_PAIR_SKIN_MAX_HUE_DELTA_RADIANS,
        PHASE_LOCKED_PAIR_SKIN_MAX_CHROMA_DELTA,
        PHASE_LOCKED_PAIR_FLAT_TEMPORAL_EXTRA_ERROR,
        PHASE_LOCKED_PAIR_SKIN_TEMPORAL_EXTRA_ERROR,
        PHASE_LOCKED_PAIR_EARLY_REJECT_MEAN_ERROR_DELTA,
        PHASE_LOCKED_PAIR_EARLY_REJECT_P95_ERROR_DELTA,
        PHASE_LOCKED_PAIR_EARLY_REJECT_LOW_FREQUENCY_DELTA,
        PHASE_LOCKED_PAIR_EARLY_REJECT_BANDING_DELTA,
        PHASE_LOCKED_PAIR_EARLY_REJECT_EDGE_ERROR_DELTA,
        PHASE_LOCKED_PAIR_EARLY_REJECT_TEMPORAL_DELTA,
    ] {
        hasher.update(value.to_bits().to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn phase_locked_pair_stored_metrics_reject(
    fallback: &QuantizationMetrics,
    candidate: &QuantizationMetrics,
) -> bool {
    candidate.mean_oklab_error
        > fallback.mean_oklab_error + PHASE_LOCKED_PAIR_EARLY_REJECT_MEAN_ERROR_DELTA
        || candidate.p95_oklab_error
            > fallback.p95_oklab_error + PHASE_LOCKED_PAIR_EARLY_REJECT_P95_ERROR_DELTA
        || candidate.multiscale_low_frequency_oklab_error
            > fallback.multiscale_low_frequency_oklab_error
                + PHASE_LOCKED_PAIR_EARLY_REJECT_LOW_FREQUENCY_DELTA
        || candidate.multiscale_banding_score
            > fallback.multiscale_banding_score + PHASE_LOCKED_PAIR_EARLY_REJECT_BANDING_DELTA
        || candidate.edge_gradient_error
            > fallback.edge_gradient_error + PHASE_LOCKED_PAIR_EARLY_REJECT_EDGE_ERROR_DELTA
        || candidate.static_temporal_residual
            > fallback.static_temporal_residual + PHASE_LOCKED_PAIR_EARLY_REJECT_TEMPORAL_DELTA
        || candidate.multiscale_static_temporal_residual
            > fallback.multiscale_static_temporal_residual
                + PHASE_LOCKED_PAIR_EARLY_REJECT_TEMPORAL_DELTA
}

pub fn error_diffusion_kernel_config_sha256() -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.error-diffusion-kernel-config.v3\0");
    hasher.update(
        u64::try_from(HISTOGRAM_SIDE)
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    hasher.update(
        u64::try_from(PALETTE_BUCKET_CANDIDATES)
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    hasher.update([TEMPORAL_HYSTERESIS_MAX_HOLD_FRAMES]);
    hasher.update(TEMPORAL_HYSTERESIS_MAX_HOLD_DURATION_CS.to_le_bytes());
    hasher.update([ERROR_DIFFUSION_MIN_CELL_CHANNEL_RANGE]);
    for value in [
        ERROR_DIFFUSION_FLAT_MAX_MEAN_NEIGHBOR_DELTA,
        ERROR_DIFFUSION_SKIN_MAX_MEAN_NEIGHBOR_DELTA,
        ERROR_DIFFUSION_FLAT_MAX_EDGE_FRACTION,
        ERROR_DIFFUSION_SKIN_MAX_EDGE_FRACTION,
    ] {
        hasher.update(value.to_bits().to_le_bytes());
    }
    hasher.update([ERROR_DIFFUSION_EDGE_DELTA]);
    hasher.update(ERROR_DIFFUSION_SCENE_CUT_MEAN_DELTA.to_le_bytes());
    hasher.update([ERROR_DIFFUSION_SCENE_CUT_PIXEL_DELTA]);
    hasher.update(ERROR_DIFFUSION_SCENE_CUT_CHANGED_PIXEL_DENOMINATOR.to_le_bytes());
    hasher.update(
        ERROR_DIFFUSION_EDGE_CONDUCTANCE_STOP_OKLAB
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update([ERROR_DIFFUSION_EDGE_CONDUCTANCE_POWER]);
    hasher.update(
        ERROR_DIFFUSION_TEMPORAL_REGULARIZER_FRACTION
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(
        ERROR_DIFFUSION_EDGE_GUARDED_ATTENUATION
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(ERROR_DIFFUSION_FS_NUMERATORS);
    hasher.update([ERROR_DIFFUSION_FS_DENOMINATOR]);
    hasher.update(BAYER_8X8);
    for value in [
        ERROR_DIFFUSION_FLAT_STRENGTH,
        ERROR_DIFFUSION_SKIN_MIN_STRENGTH,
        ERROR_DIFFUSION_SKIN_STRENGTH_RANGE,
        ERROR_DIFFUSION_FLAT_RESIDUAL_L_LIMIT,
        ERROR_DIFFUSION_FLAT_RESIDUAL_CHROMA_LIMIT,
        ERROR_DIFFUSION_SKIN_RESIDUAL_L_LIMIT,
        ERROR_DIFFUSION_SKIN_RESIDUAL_CHROMA_LIMIT,
    ] {
        hasher.update(value.to_bits().to_le_bytes());
    }
    hasher.update([TEMPORAL_MICRO_CHANGE_MAX_DELTA]);
    for value in TEMPORAL_HYSTERESIS_EXTRA_OKLAB_ERROR_BY_CLASS {
        hasher.update(value.to_bits().to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub fn error_diffusion_v4_kernel_config_sha256() -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.hybrid-error-diffusion-kernel-config.v4\0");
    hasher.update(b"fallback-exact-outside-eligible\0");
    hasher.update(b"full-frame-global-serpentine\0");
    hasher.update(b"compatible-cross-cell-links\0");
    hasher.update(error_diffusion_kernel_config_sha256().as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn error_diffusion_v5_kernel_config_sha256() -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.regional-quantization.hybrid-error-diffusion-kernel-config.v5\0");
    hasher.update(b"coherent-subcell-gradient-rescue-cardinal-v1\0");
    hasher.update(b"pixel-hard-edge-seed-four-neighbor-v1\0");
    hasher.update(b"edge-protection-halo-eight-neighbor-v1\0");
    hasher.update(b"protected-exact-fallback-and-residual-barrier\0");
    hasher.update(b"temporal-regularizer-source-domain\0");
    hasher.update(b"vfr-single-frame-over-budget-extension\0");
    hasher.update(b"loop-first-frame-fallback-seed\0");
    hasher.update(error_diffusion_v4_kernel_config_sha256().as_bytes());
    for value in [
        ERROR_DIFFUSION_COHERENCE_FLAT_MAX_BOUNDARY_DELTA,
        ERROR_DIFFUSION_COHERENCE_SKIN_MAX_BOUNDARY_DELTA,
    ] {
        hasher.update(value.to_bits().to_le_bytes());
    }
    hasher.update(
        u64::try_from(ERROR_DIFFUSION_EDGE_HALO_RADIUS_PX)
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

fn error_diffusion_edge_conductance(left: Oklab, right: Oklab) -> f64 {
    let normalized = (left.distance_squared(right).sqrt()
        / ERROR_DIFFUSION_EDGE_CONDUCTANCE_STOP_OKLAB)
        .clamp(0.0, 1.0);
    let base = 1.0 - normalized;
    (0..ERROR_DIFFUSION_EDGE_CONDUCTANCE_POWER).fold(1.0, |value, _| value * base)
}

#[cfg(test)]
fn error_diffusion_pixel_edge_attenuation(
    frame_labs: &[Oklab],
    layout: &FrameLayout,
    bounds: RegionCellBounds,
    x: usize,
    y: usize,
) -> f64 {
    let source = frame_labs[y * layout.width + x];
    let mut attenuation = 1.0_f64;
    if x > bounds.x_start {
        attenuation = attenuation.min(error_diffusion_edge_conductance(
            source,
            frame_labs[y * layout.width + x - 1],
        ));
    }
    if x + 1 < bounds.x_end {
        attenuation = attenuation.min(error_diffusion_edge_conductance(
            source,
            frame_labs[y * layout.width + x + 1],
        ));
    }
    if y > bounds.y_start {
        attenuation = attenuation.min(error_diffusion_edge_conductance(
            source,
            frame_labs[(y - 1) * layout.width + x],
        ));
    }
    if y + 1 < bounds.y_end {
        attenuation = attenuation.min(error_diffusion_edge_conductance(
            source,
            frame_labs[(y + 1) * layout.width + x],
        ));
    }
    attenuation
}

fn error_diffusion_pixel_edge_attenuation_full_frame(
    frame_labs: &[Oklab],
    layout: &FrameLayout,
    x: usize,
    y: usize,
) -> f64 {
    let source = frame_labs[y * layout.width + x];
    let mut attenuation = 1.0_f64;
    if x > 0 {
        attenuation = attenuation.min(error_diffusion_edge_conductance(
            source,
            frame_labs[y * layout.width + x - 1],
        ));
    }
    if x + 1 < layout.width {
        attenuation = attenuation.min(error_diffusion_edge_conductance(
            source,
            frame_labs[y * layout.width + x + 1],
        ));
    }
    if y > 0 {
        attenuation = attenuation.min(error_diffusion_edge_conductance(
            source,
            frame_labs[(y - 1) * layout.width + x],
        ));
    }
    if y + 1 < layout.height {
        attenuation = attenuation.min(error_diffusion_edge_conductance(
            source,
            frame_labs[(y + 1) * layout.width + x],
        ));
    }
    attenuation
}

#[allow(clippy::too_many_arguments)]
fn add_error_diffusion_v5_link(
    target: &mut Oklab,
    residual: Oklab,
    numerator: u8,
    conductance: f64,
    source_cell: usize,
    target_cell: usize,
    source_class: usize,
    target_class: usize,
    target_cell_enabled: bool,
    target_pixel_enabled: bool,
    target_protected: bool,
    diagnostics: &mut ErrorDiffusionV5LinkDiagnostics,
) {
    diagnostics.candidate_count = diagnostics.candidate_count.saturating_add(1);
    let crosses_cell = source_cell != target_cell;
    if crosses_cell {
        diagnostics.cross_cell_candidate_count =
            diagnostics.cross_cell_candidate_count.saturating_add(1);
    }
    if !target_cell_enabled {
        diagnostics.blocked_count = diagnostics.blocked_count.saturating_add(1);
        if crosses_cell {
            diagnostics.cross_cell_rejected_eligibility_count = diagnostics
                .cross_cell_rejected_eligibility_count
                .saturating_add(1);
        }
        return;
    }
    if !target_pixel_enabled || target_protected {
        diagnostics.blocked_count = diagnostics.blocked_count.saturating_add(1);
        diagnostics.protected_target_count = diagnostics.protected_target_count.saturating_add(1);
        if crosses_cell {
            diagnostics.cross_cell_rejected_protection_count = diagnostics
                .cross_cell_rejected_protection_count
                .saturating_add(1);
        }
        return;
    }
    if source_class != target_class {
        diagnostics.blocked_count = diagnostics.blocked_count.saturating_add(1);
        if crosses_cell {
            diagnostics.cross_cell_rejected_class_count = diagnostics
                .cross_cell_rejected_class_count
                .saturating_add(1);
        }
        return;
    }
    if conductance == 0.0 {
        diagnostics.blocked_count = diagnostics.blocked_count.saturating_add(1);
        if crosses_cell {
            diagnostics.cross_cell_blocked_hard_edge_count = diagnostics
                .cross_cell_blocked_hard_edge_count
                .saturating_add(1);
        }
        return;
    }
    if conductance < 1.0 {
        diagnostics.attenuated_count = diagnostics.attenuated_count.saturating_add(1);
    } else {
        diagnostics.full_conductance_count = diagnostics.full_conductance_count.saturating_add(1);
    }
    if crosses_cell {
        diagnostics.cross_cell_propagated_count =
            diagnostics.cross_cell_propagated_count.saturating_add(1);
    }
    add_scaled_oklab(
        target,
        residual,
        f64::from(numerator) / f64::from(ERROR_DIFFUSION_FS_DENOMINATOR) * conductance,
    );
}

fn update_error_diffusion_v5_hash_string(hasher: &mut Sha256, value: &str) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_le_bytes());
    hasher.update(value.as_bytes());
}

#[allow(clippy::too_many_arguments)]
fn update_error_diffusion_v5_artifact_hash(
    hasher: &mut Sha256,
    diagnostics: &ErrorDiffusionDiagnostics,
    width: u16,
    height: u16,
    frame_count: u32,
    max_hold_frames: u8,
    max_hold_duration_cs: u16,
    looping: bool,
    frame_delays_cs: &[u16],
    palette_sha256: &str,
    region_sha256: &str,
    indices_sha256: &str,
    reconstructed_rgb24_sha256: &str,
    secondary_choice_count: u64,
    secondary_choice_by_class: [u64; 4],
    temporal_hold_count: u64,
    temporal_hold_by_class: [u64; 4],
    temporal_hold_duration_cs: u64,
    temporal_max_observed_hold_duration_cs: u16,
    metrics: &QuantizationMetrics,
) {
    update_error_diffusion_v5_hash_string(hasher, &diagnostics.kernel_config_sha256);
    update_error_diffusion_v5_hash_string(hasher, &diagnostics.fallback_route_id);
    update_error_diffusion_v5_hash_string(hasher, &diagnostics.fallback_indices_sha256);
    update_error_diffusion_v5_hash_string(hasher, &diagnostics.gradient_eligibility_mask_sha256);
    update_error_diffusion_v5_hash_string(hasher, &diagnostics.edge_protection_mask_sha256);
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(frame_count.to_le_bytes());
    hasher.update([max_hold_frames]);
    hasher.update(max_hold_duration_cs.to_le_bytes());
    hasher.update([u8::from(looping)]);
    for delay in frame_delays_cs {
        hasher.update(delay.to_le_bytes());
    }
    for value in [
        palette_sha256,
        region_sha256,
        indices_sha256,
        reconstructed_rgb24_sha256,
    ] {
        update_error_diffusion_v5_hash_string(hasher, value);
    }
    hasher.update(secondary_choice_count.to_le_bytes());
    for count in secondary_choice_by_class {
        hasher.update(count.to_le_bytes());
    }
    hasher.update(temporal_hold_count.to_le_bytes());
    for count in temporal_hold_by_class {
        hasher.update(count.to_le_bytes());
    }
    hasher.update(temporal_hold_duration_cs.to_le_bytes());
    hasher.update(temporal_max_observed_hold_duration_cs.to_le_bytes());
    for count in [
        diagnostics.direct_gradient_eligible_cell_count,
        diagnostics.coherence_rescued_cell_count,
        diagnostics.coherence_rescued_pixel_count,
        diagnostics.pre_protection_gradient_pixel_count,
        diagnostics.gradient_eligible_pixel_count,
        diagnostics.protected_edge_seed_pixel_count,
        diagnostics.protected_edge_halo_pixel_count,
        diagnostics.protected_edge_fallback_pixel_count,
        diagnostics.protected_edge_index_change_count,
        diagnostics.diffused_pixel_count,
        diagnostics.residual_clamp_count,
        diagnostics.cell_reset_count,
        diagnostics.frame_error_buffer_reset_count,
        diagnostics.edge_guarded_pixel_count,
        diagnostics.residual_link_candidate_count,
        diagnostics.full_conductance_residual_link_count,
        diagnostics.attenuated_residual_link_count,
        diagnostics.blocked_residual_link_count,
        diagnostics.cross_cell_candidate_link_count,
        diagnostics.cross_cell_propagated_link_count,
        diagnostics.cross_cell_rejected_class_count,
        diagnostics.cross_cell_rejected_eligibility_count,
        diagnostics.cross_cell_rejected_protection_count,
        diagnostics.cross_cell_blocked_hard_edge_count,
        diagnostics.protected_target_link_count,
        diagnostics.fallback_preserved_pixel_count,
        diagnostics.eligible_index_change_count,
        diagnostics.ineligible_index_change_count,
        diagnostics.temporal_regularized_hold_count,
        diagnostics.temporal_prev_candidate_count,
        diagnostics.temporal_prev_rejected_by_color_count,
        diagnostics.temporal_prev_rejected_by_budget_count,
        diagnostics.temporal_prev_rejected_by_regularizer_count,
        diagnostics.temporal_vfr_single_frame_extension_count,
        diagnostics.loop_seeded_pixel_count,
        diagnostics.static_index_flip_count,
    ] {
        hasher.update(count.to_le_bytes());
    }
    for count in diagnostics.diffused_pixel_by_class {
        hasher.update(count.to_le_bytes());
    }
    hasher.update(
        diagnostics
            .eligible_index_change_rate
            .to_bits()
            .to_le_bytes(),
    );
    hasher.update(
        diagnostics
            .vfr_weighted_static_index_flip_rate
            .to_bits()
            .to_le_bytes(),
    );
    for value in [
        metrics.mean_oklab_error,
        metrics.p95_oklab_error,
        metrics.edge_weighted_mean_oklab_error,
        metrics.multiscale_low_frequency_oklab_error,
        metrics.multiscale_banding_score,
        metrics.edge_gradient_error,
        metrics.static_temporal_residual,
        metrics.multiscale_static_temporal_residual,
    ] {
        hasher.update(value.to_bits().to_le_bytes());
    }
}

#[allow(clippy::too_many_arguments)]
fn update_phase_locked_pair_artifact_hash(
    hasher: &mut Sha256,
    diagnostics: &PhaseLockedPairDiagnostics,
    width: u16,
    height: u16,
    frame_count: u32,
    max_hold_frames: u8,
    max_hold_duration_cs: u16,
    looping: bool,
    frame_delays_cs: &[u16],
    palette_sha256: &str,
    region_sha256: &str,
    indices_sha256: &str,
    reconstructed_rgb24_sha256: &str,
    metrics: &QuantizationMetrics,
) {
    for value in [
        diagnostics.kernel_config_sha256.as_str(),
        diagnostics.fallback_route_id.as_str(),
        diagnostics.fallback_indices_sha256.as_str(),
        diagnostics.pair_lookup_sha256.as_str(),
        diagnostics.eligibility_mask_sha256.as_str(),
        diagnostics.edge_protection_mask_sha256.as_str(),
    ] {
        update_error_diffusion_v5_hash_string(hasher, value);
    }
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(frame_count.to_le_bytes());
    hasher.update([max_hold_frames]);
    hasher.update(max_hold_duration_cs.to_le_bytes());
    hasher.update([u8::from(looping)]);
    hasher.update(
        u64::try_from(frame_delays_cs.len())
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    for delay in frame_delays_cs {
        hasher.update(delay.to_le_bytes());
    }
    for value in [
        palette_sha256,
        region_sha256,
        indices_sha256,
        reconstructed_rgb24_sha256,
    ] {
        update_error_diffusion_v5_hash_string(hasher, value);
    }
    for count in [
        diagnostics.opaque_fallback_pixel_count,
        diagnostics.transparent_fallback_pixel_count,
        diagnostics.smooth_region_pixel_count,
        diagnostics.protected_edge_pixel_count,
        diagnostics.non_micro_change_fallback_pixel_count,
        diagnostics.scene_cut_fallback_pixel_count,
        diagnostics.no_bracketing_pair_fallback_pixel_count,
        diagnostics.eligible_pixel_count,
        diagnostics.paired_pixel_count,
        diagnostics.pair_candidate_count,
        diagnostics.changed_pixel_count,
        diagnostics.fallback_preserved_pixel_count,
        diagnostics.protected_edge_index_change_count,
        diagnostics.ineligible_index_change_count,
        diagnostics.skin_pair_hue_rejection_count,
        diagnostics.skin_pair_chroma_rejection_count,
        diagnostics.temporal_candidate_count,
        diagnostics.temporal_hold_count,
        diagnostics.temporal_hold_duration_cs,
        diagnostics.temporal_rejected_by_pair_count,
        diagnostics.temporal_rejected_by_color_count,
        diagnostics.temporal_rejected_by_budget_count,
        diagnostics.cut_reset_pixel_count,
        diagnostics.loop_seeded_pixel_count,
        diagnostics.fallback_static_index_flip_count,
        diagnostics.static_index_flip_count,
        diagnostics.fallback_loop_seam_static_index_flip_count,
        diagnostics.loop_seam_static_index_flip_count,
        diagnostics.stored_frame_early_reject_count,
        diagnostics.pre_reject_changed_pixel_count,
        diagnostics.pre_reject_temporal_hold_count,
    ] {
        hasher.update(count.to_le_bytes());
    }
    for count in diagnostics.changed_pixel_by_class {
        hasher.update(count.to_le_bytes());
    }
    for count in diagnostics.temporal_hold_by_class {
        hasher.update(count.to_le_bytes());
    }
    hasher.update(
        diagnostics
            .temporal_max_observed_hold_duration_cs
            .to_le_bytes(),
    );
    for value in [
        diagnostics.fallback_vfr_weighted_static_index_flip_rate,
        diagnostics.vfr_weighted_static_index_flip_rate,
        diagnostics.fallback_mean_oklab_error,
        diagnostics.candidate_mean_oklab_error,
        diagnostics.fallback_multiscale_banding_score,
        diagnostics.candidate_multiscale_banding_score,
        metrics.mean_oklab_error,
        metrics.p95_oklab_error,
        metrics.edge_weighted_mean_oklab_error,
        metrics.multiscale_low_frequency_oklab_error,
        metrics.multiscale_banding_score,
        metrics.edge_gradient_error,
        metrics.static_temporal_residual,
        metrics.multiscale_static_temporal_residual,
    ] {
        hasher.update(value.to_bits().to_le_bytes());
    }
    hasher.update(metrics.sampled_pixel_count.to_le_bytes());
    hasher.update(metrics.sampled_static_pixel_count.to_le_bytes());
}

fn measure_loop_seam_static_index_flips(
    pixels: &[u8],
    indices: &[u8],
    layout: &FrameLayout,
    looping: bool,
) -> u64 {
    let frame_count = usize::try_from(layout.frame_count).unwrap_or(0);
    if !looping || frame_count < 2 {
        return 0;
    }
    let last_pixel_offset = (frame_count - 1) * layout.pixels_per_frame;
    let last_byte_offset = (frame_count - 1) * layout.frame_bytes;
    let mut count = 0_u64;
    for pixel_index in 0..layout.pixels_per_frame {
        let first_byte = pixel_index * 3;
        let last_byte = last_byte_offset + first_byte;
        if max_channel_delta(rgb_at(pixels, first_byte), rgb_at(pixels, last_byte))
            <= TEMPORAL_MICRO_CHANGE_MAX_DELTA
            && indices[pixel_index] != indices[last_pixel_offset + pixel_index]
        {
            count = count.saturating_add(1);
        }
    }
    count
}

#[cfg(test)]
fn add_edge_aware_error_diffusion_link(
    target: &mut Oklab,
    residual: Oklab,
    numerator: u8,
    conductance: f64,
    attenuated_link_count: &mut u64,
    blocked_link_count: &mut u64,
) {
    if conductance == 0.0 {
        *blocked_link_count = blocked_link_count.saturating_add(1);
        return;
    }
    if conductance < 1.0 {
        *attenuated_link_count = attenuated_link_count.saturating_add(1);
    }
    add_scaled_oklab(
        target,
        residual,
        f64::from(numerator) / f64::from(ERROR_DIFFUSION_FS_DENOMINATOR) * conductance,
    );
}

fn add_oklab(left: Oklab, right: Oklab) -> Oklab {
    Oklab {
        l: left.l + right.l,
        a: left.a + right.a,
        b: left.b + right.b,
    }
}

fn subtract_oklab(left: Oklab, right: Oklab) -> Oklab {
    Oklab {
        l: left.l - right.l,
        a: left.a - right.a,
        b: left.b - right.b,
    }
}

fn scale_oklab(value: Oklab, scale: f64) -> Oklab {
    Oklab {
        l: value.l * scale,
        a: value.a * scale,
        b: value.b * scale,
    }
}

fn add_scaled_oklab(target: &mut Oklab, value: Oklab, scale: f64) {
    target.l += value.l * scale;
    target.a += value.a * scale;
    target.b += value.b * scale;
}

fn clamp_error_diffusion_residual(value: Oklab, class: usize) -> (Oklab, bool) {
    let (l_limit, chroma_limit) = if class == 2 {
        (
            ERROR_DIFFUSION_SKIN_RESIDUAL_L_LIMIT,
            ERROR_DIFFUSION_SKIN_RESIDUAL_CHROMA_LIMIT,
        )
    } else {
        (
            ERROR_DIFFUSION_FLAT_RESIDUAL_L_LIMIT,
            ERROR_DIFFUSION_FLAT_RESIDUAL_CHROMA_LIMIT,
        )
    };
    let clamped = Oklab {
        l: value.l.clamp(-l_limit, l_limit),
        a: value.a.clamp(-chroma_limit, chroma_limit),
        b: value.b.clamp(-chroma_limit, chroma_limit),
    };
    (clamped, clamped != value)
}

fn emitted_error_diffusion_residual(
    adjusted_source: Oklab,
    emitted_index: u8,
    palette: &[Oklab],
    strength: f64,
    class: usize,
) -> (Oklab, bool) {
    clamp_error_diffusion_residual(
        scale_oklab(
            subtract_oklab(adjusted_source, palette[usize::from(emitted_index)]),
            strength,
        ),
        class,
    )
}

fn measure_static_index_flips(
    pixels: &[u8],
    indices: &[u8],
    layout: &FrameLayout,
    frame_delays_cs: &[u16],
) -> (u64, f64) {
    let frame_count = usize::try_from(layout.frame_count).unwrap_or(0);
    let mut flip_count = 0_u64;
    let mut weighted_flip_duration = 0_u64;
    let mut weighted_static_duration = 0_u64;
    for (frame_index, frame_delay_cs) in frame_delays_cs
        .iter()
        .copied()
        .enumerate()
        .take(frame_count)
        .skip(1)
    {
        let delay = u64::from(frame_delay_cs);
        let frame_pixel_offset = frame_index * layout.pixels_per_frame;
        let previous_pixel_offset = frame_pixel_offset - layout.pixels_per_frame;
        let frame_byte_offset = frame_index * layout.frame_bytes;
        let previous_byte_offset = frame_byte_offset - layout.frame_bytes;
        for pixel_index in 0..layout.pixels_per_frame {
            let byte = frame_byte_offset + pixel_index * 3;
            let previous_byte = previous_byte_offset + pixel_index * 3;
            if max_channel_delta(rgb_at(pixels, byte), rgb_at(pixels, previous_byte))
                > TEMPORAL_MICRO_CHANGE_MAX_DELTA
            {
                continue;
            }
            weighted_static_duration = weighted_static_duration.saturating_add(delay);
            if indices[frame_pixel_offset + pixel_index]
                != indices[previous_pixel_offset + pixel_index]
            {
                flip_count = flip_count.saturating_add(1);
                weighted_flip_duration = weighted_flip_duration.saturating_add(delay);
            }
        }
    }
    let rate = if weighted_static_duration == 0 {
        0.0
    } else {
        weighted_flip_duration as f64 / weighted_static_duration as f64
    };
    (flip_count, rate)
}

fn build_choice_lookup(palette: &[Oklab]) -> Vec<PaletteLookupBucket> {
    (0..HISTOGRAM_LEN)
        .map(|histogram_index| {
            let source = srgb8_to_oklab(histogram_representative(histogram_index));
            let mut ranked = [(u8::MAX, f64::INFINITY); PALETTE_BUCKET_CANDIDATES];
            let mut len = 0_usize;
            for (index, color) in palette.iter().copied().enumerate() {
                let candidate = (index as u8, source.distance_squared(color));
                let insert_at = (0..len)
                    .find(|position| palette_rank_before(candidate, ranked[*position]))
                    .unwrap_or(len);
                if insert_at < PALETTE_BUCKET_CANDIDATES {
                    let next_len = (len + 1).min(PALETTE_BUCKET_CANDIDATES);
                    for position in (insert_at + 1..next_len).rev() {
                        ranked[position] = ranked[position - 1];
                    }
                    ranked[insert_at] = candidate;
                    len = next_len;
                }
            }
            let mut indices = [0_u8; PALETTE_BUCKET_CANDIDATES];
            for (target, (index, _)) in indices.iter_mut().zip(ranked).take(len) {
                *target = index;
            }
            PaletteLookupBucket {
                indices,
                len: len as u8,
            }
        })
        .collect()
}

fn palette_choice(rgb: [u8; 3], bucket: PaletteLookupBucket, palette: &[Oklab]) -> PaletteChoice {
    let source = srgb8_to_oklab(rgb);
    let first_index = bucket.indices[0];
    let first = (
        first_index,
        source.distance_squared(palette[usize::from(first_index)]),
    );
    let mut nearest = first;
    let mut secondary = first;
    for index in bucket.indices[1..usize::from(bucket.len)].iter().copied() {
        let candidate = (index, source.distance_squared(palette[usize::from(index)]));
        if palette_rank_before(candidate, nearest) {
            secondary = nearest;
            nearest = candidate;
        } else if secondary.0 == nearest.0 || palette_rank_before(candidate, secondary) {
            secondary = candidate;
        }
    }
    let nearest_lab = palette[usize::from(nearest.0)];
    let secondary_lab = palette[usize::from(secondary.0)];
    let dl = secondary_lab.l - nearest_lab.l;
    let da = secondary_lab.a - nearest_lab.a;
    let db = secondary_lab.b - nearest_lab.b;
    let denominator = dl.mul_add(dl, da.mul_add(da, db * db));
    let secondary_probability = if denominator <= f64::EPSILON {
        0.0
    } else {
        ((source.l - nearest_lab.l) * dl
            + (source.a - nearest_lab.a) * da
            + (source.b - nearest_lab.b) * db)
            / denominator
    }
    .clamp(0.0, 0.5);
    PaletteChoice {
        nearest: nearest.0,
        secondary: secondary.0,
        secondary_probability,
    }
}

fn palette_rank_before(left: (u8, f64), right: (u8, f64)) -> bool {
    left.1
        .total_cmp(&right.1)
        .then(left.0.cmp(&right.0))
        .is_lt()
}

fn histogram_index(red: u8, green: u8, blue: u8) -> usize {
    (usize::from(red >> 3) * HISTOGRAM_SIDE + usize::from(green >> 3)) * HISTOGRAM_SIDE
        + usize::from(blue >> 3)
}

fn histogram_representative(index: usize) -> [u8; 3] {
    let red = index / (HISTOGRAM_SIDE * HISTOGRAM_SIDE);
    let green = index / HISTOGRAM_SIDE % HISTOGRAM_SIDE;
    let blue = index % HISTOGRAM_SIDE;
    let center = |value: usize| ((value * 8 + 4).min(255)) as u8;
    [center(red), center(green), center(blue)]
}

fn rgb_at(bytes: &[u8], offset: usize) -> [u8; 3] {
    [bytes[offset], bytes[offset + 1], bytes[offset + 2]]
}

fn max_channel_delta(first: [u8; 3], second: [u8; 3]) -> u8 {
    first[0]
        .abs_diff(second[0])
        .max(first[1].abs_diff(second[1]))
        .max(first[2].abs_diff(second[2]))
}

fn luma(rgb: [u8; 3]) -> u8 {
    ((u32::from(rgb[0]) * 54 + u32::from(rgb[1]) * 183 + u32::from(rgb[2]) * 19 + 128) >> 8) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn black_white_palette() -> OklabPaletteArtifact {
        let mut rgba = Vec::with_capacity(256 * 4);
        rgba.extend_from_slice(&[0, 0, 0, 255]);
        for _ in 1..255 {
            rgba.extend_from_slice(&[255, 255, 255, 255]);
        }
        rgba.extend_from_slice(&[0, 0, 0, 0]);
        OklabPaletteArtifact {
            sha256: format!("{:x}", Sha256::digest(&rgba)),
            rgba,
            emitted_colors: 3,
            sampled_frame_count: 1,
            sampled_pixel_count: 1,
            weighted_sample_mass: 1.0,
            weighted_histogram_mean_oklab_error: 0.0,
            weighted_histogram_p95_oklab_error: 0.0,
        }
    }

    fn gray_palette(values: &[u8]) -> OklabPaletteArtifact {
        assert!(!values.is_empty());
        assert!(values.len() < 256);
        let mut rgba = Vec::with_capacity(256 * 4);
        for value in values.iter().copied() {
            rgba.extend_from_slice(&[value, value, value, 255]);
        }
        let final_value = *values.last().unwrap();
        for _ in values.len()..255 {
            rgba.extend_from_slice(&[final_value, final_value, final_value, 255]);
        }
        rgba.extend_from_slice(&[0, 0, 0, 0]);
        OklabPaletteArtifact {
            sha256: format!("{:x}", Sha256::digest(&rgba)),
            rgba,
            emitted_colors: u16::try_from(values.len() + 1).unwrap(),
            sampled_frame_count: 1,
            sampled_pixel_count: 1,
            weighted_sample_mass: 1.0,
            weighted_histogram_mean_oklab_error: 0.0,
            weighted_histogram_p95_oklab_error: 0.0,
        }
    }

    fn rgb_palette(values: &[[u8; 3]]) -> OklabPaletteArtifact {
        assert!(!values.is_empty());
        assert!(values.len() < 256);
        let mut rgba = Vec::with_capacity(256 * 4);
        for value in values.iter().copied() {
            rgba.extend_from_slice(&[value[0], value[1], value[2], 255]);
        }
        let final_value = *values.last().unwrap();
        for _ in values.len()..255 {
            rgba.extend_from_slice(&[final_value[0], final_value[1], final_value[2], 255]);
        }
        rgba.extend_from_slice(&[0, 0, 0, 0]);
        OklabPaletteArtifact {
            sha256: format!("{:x}", Sha256::digest(&rgba)),
            rgba,
            emitted_colors: u16::try_from(values.len() + 1).unwrap(),
            sampled_frame_count: 1,
            sampled_pixel_count: 1,
            weighted_sample_mass: 1.0,
            weighted_histogram_mean_oklab_error: 0.0,
            weighted_histogram_p95_oklab_error: 0.0,
        }
    }

    fn solid_gray_frames(values: &[u8], pixels_per_frame: usize) -> Vec<u8> {
        let mut pixels = Vec::with_capacity(values.len() * pixels_per_frame * 3);
        for value in values.iter().copied() {
            pixels.extend_from_slice(&[value, value, value].repeat(pixels_per_frame));
        }
        pixels
    }

    fn horizontal_gray_gradient_frames(
        width: usize,
        height: usize,
        frame_count: usize,
        start: u8,
        span: u8,
    ) -> Vec<u8> {
        let mut pixels = Vec::with_capacity(width * height * frame_count * 3);
        for _ in 0..frame_count {
            for _y in 0..height {
                for x in 0..width {
                    let value = start.saturating_add(
                        u8::try_from(x.saturating_mul(usize::from(span)) / width.max(1))
                            .unwrap_or(span),
                    );
                    pixels.extend_from_slice(&[value, value, value]);
                }
            }
        }
        pixels
    }

    fn regions(classes: Vec<u8>, strengths: Vec<u8>) -> RegionDitherArtifact {
        RegionDitherArtifact {
            grid_width: 2,
            grid_height: 1,
            class_map: classes,
            strength_map: strengths,
            class_counts: [1, 0, 0, 1],
            sampled_frame_count: 1,
            sampled_pixel_count: 1,
            weighted_sample_mass: 1.0,
            mean_dither_strength: 0.5,
            mean_spatial_std: 0.0,
            mean_edge: 0.0,
            mean_skin_ratio: 0.0,
            mean_temporal_delta: 0.0,
            mean_high_frequency_noise: 0.0,
            class_map_sha256: "classes".to_string(),
            strength_map_sha256: "strengths".to_string(),
            sha256: "regions".to_string(),
        }
    }

    fn uniform_regions(
        grid_width: u16,
        grid_height: u16,
        class: u8,
        strength: u8,
        sha256: &str,
    ) -> RegionDitherArtifact {
        let cell_count = usize::from(grid_width) * usize::from(grid_height);
        let mut class_counts = [0_u32; 4];
        class_counts[usize::from(class)] = u32::try_from(cell_count).unwrap();
        RegionDitherArtifact {
            grid_width,
            grid_height,
            class_map: vec![class; cell_count],
            strength_map: vec![strength; cell_count],
            class_counts,
            sampled_frame_count: 1,
            sampled_pixel_count: 1,
            weighted_sample_mass: 1.0,
            mean_dither_strength: f64::from(strength) / 255.0,
            mean_spatial_std: 0.0,
            mean_edge: 0.0,
            mean_skin_ratio: f64::from(class == 2),
            mean_temporal_delta: 0.0,
            mean_high_frequency_noise: 0.0,
            class_map_sha256: format!("classes-{sha256}"),
            strength_map_sha256: format!("strengths-{sha256}"),
            sha256: sha256.to_string(),
        }
    }

    #[test]
    fn region_cell_lookup_matches_floor_bounds_for_non_divisible_extent() {
        let extent = 420_usize;
        let grid = 16_usize;
        for cell in 0..grid {
            let start = cell * extent / grid;
            let end = (cell + 1) * extent / grid;
            for position in start..end {
                assert_eq!(
                    region_cell_coordinate_for_pixel(position, extent, grid),
                    cell,
                    "position {position} escaped cell {cell} [{start}, {end})"
                );
            }
        }
    }

    #[test]
    fn v5_full_frame_diffusion_is_invariant_to_uniform_region_partitioning() {
        let width = 64_u16;
        let height = 32_u16;
        let pixels =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 1, 72, 96);
        let palette = gray_palette(&[64, 96, 128, 160, 192]);
        let one = uniform_regions(1, 1, 0, 18, "uniform-1x1");
        let two = uniform_regions(2, 1, 0, 18, "uniform-2x1");
        let tiled = uniform_regions(16, 16, 0, 18, "uniform-16x16");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &one)
            .unwrap()
            .indices;
        let policy = TemporalHysteresisPolicy {
            max_hold_frames: 0,
            max_hold_duration_cs: 0,
        };
        let run = |regions: &RegionDitherArtifact| {
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                regions,
                &[4],
                policy,
                false,
                &fallback,
                "regional_ordered",
            )
            .unwrap()
        };
        let one_result = run(&one);
        let two_result = run(&two);
        let tiled_result = run(&tiled);

        assert_eq!(one_result.indices, two_result.indices);
        assert_eq!(one_result.indices, tiled_result.indices);
        assert_eq!(
            one_result.reconstructed_rgb24,
            two_result.reconstructed_rgb24
        );
        assert_eq!(
            one_result.reconstructed_rgb24,
            tiled_result.reconstructed_rgb24
        );
        assert_eq!(one_result.report.metrics, two_result.report.metrics);
        assert_eq!(one_result.report.metrics, tiled_result.report.metrics);
        assert_ne!(
            one_result.report.artifact_sha256,
            two_result.report.artifact_sha256
        );
        assert_ne!(
            one_result.report.artifact_sha256,
            tiled_result.report.artifact_sha256
        );
        let diagnostics = one_result.report.error_diffusion.as_ref().unwrap();
        assert_eq!(
            one_result.report.spatial_kernel_id,
            "oklab_hybrid_coherent_edge_protected_serpentine_fs_temporal_v5"
        );
        assert_eq!(diagnostics.cell_reset_count, 0);
        assert_eq!(diagnostics.frame_error_buffer_reset_count, 1);
        assert!(diagnostics.gradient_eligible_pixel_count > 0);
        assert!(diagnostics.eligible_index_change_count > 0);
        assert_eq!(diagnostics.ineligible_index_change_count, 0);
    }

    #[test]
    fn v5_preserves_fallback_outside_eligible_spans_and_closes_link_accounting() {
        let width = 64_u16;
        let height = 24_u16;
        let pixels =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 2, 72, 96);
        let palette = gray_palette(&[64, 96, 128, 160, 192]);
        let region_map = regions(vec![0, 1], vec![18, 30]);
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4],
                TemporalHysteresisPolicy {
                    max_hold_frames: 0,
                    max_hold_duration_cs: 0,
                },
                false,
                &fallback,
                "regional_ordered",
            )
            .unwrap();
        let frame_pixels = usize::from(width) * usize::from(height);
        for frame in 0..2 {
            for y in 0..usize::from(height) {
                let row = frame * frame_pixels + y * usize::from(width);
                let ineligible_start = row + usize::from(width) / 2;
                let end = row + usize::from(width);
                assert_eq!(
                    &candidate.indices[ineligible_start..end],
                    &fallback[ineligible_start..end]
                );
            }
        }
        let diagnostics = candidate.report.error_diffusion.as_ref().unwrap();
        assert_eq!(diagnostics.fallback_route_id, "regional_ordered");
        assert_eq!(
            diagnostics.fallback_indices_sha256,
            format!("{:x}", Sha256::digest(&fallback))
        );
        assert_eq!(diagnostics.ineligible_index_change_count, 0);
        assert!(diagnostics.fallback_preserved_pixel_count >= frame_pixels as u64);
        assert!(diagnostics.eligible_index_change_count > 0);
        assert!(diagnostics.cross_cell_rejected_eligibility_count > 0);
        assert_eq!(
            diagnostics.residual_link_candidate_count,
            diagnostics
                .full_conductance_residual_link_count
                .saturating_add(diagnostics.attenuated_residual_link_count)
                .saturating_add(diagnostics.blocked_residual_link_count)
        );
        assert_eq!(
            diagnostics.cross_cell_candidate_link_count,
            diagnostics
                .cross_cell_propagated_link_count
                .saturating_add(diagnostics.cross_cell_rejected_class_count)
                .saturating_add(diagnostics.cross_cell_rejected_eligibility_count)
                .saturating_add(diagnostics.cross_cell_rejected_protection_count)
                .saturating_add(diagnostics.cross_cell_blocked_hard_edge_count)
        );
        assert_eq!(
            diagnostics.temporal_prev_candidate_count,
            diagnostics
                .temporal_regularized_hold_count
                .saturating_add(diagnostics.temporal_prev_rejected_by_color_count)
                .saturating_add(diagnostics.temporal_prev_rejected_by_budget_count)
                .saturating_add(diagnostics.temporal_prev_rejected_by_regularizer_count)
        );
    }

    #[test]
    fn v5_scene_cut_suppresses_temporal_hold_without_disabling_spatial_diffusion() {
        let width = 64_u16;
        let height = 24_u16;
        let frame_pixels = usize::from(width) * usize::from(height);
        let mut pixels =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 1, 72, 80);
        pixels.extend(horizontal_gray_gradient_frames(
            usize::from(width),
            usize::from(height),
            1,
            112,
            80,
        ));
        let palette = gray_palette(&[64, 96, 128, 160, 192, 224]);
        let region_map = uniform_regions(1, 1, 0, 18, "scene-cut-spatial");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &fallback,
                "regional_ordered",
            )
            .unwrap();

        assert!(candidate.indices[frame_pixels..]
            .iter()
            .zip(&fallback[frame_pixels..])
            .any(|(candidate, fallback)| candidate != fallback));
    }

    #[test]
    fn v5_semantic_cell_boundary_isolates_residuals() {
        let width = 64_u16;
        let height = 24_u16;
        let original =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 1, 72, 96);
        let mut perturbed = original.clone();
        for y in 0..usize::from(height) {
            for x in 0..usize::from(width) / 2 {
                let byte = (y * usize::from(width) + x) * 3;
                for channel in &mut perturbed[byte..byte + 3] {
                    *channel = channel.saturating_add(2);
                }
            }
        }
        let palette = gray_palette(&[64, 96, 128, 160, 192]);
        let region_map = regions(vec![0, 2], vec![18, 50]);
        let policy = TemporalHysteresisPolicy {
            max_hold_frames: 0,
            max_hold_duration_cs: 0,
        };
        let run = |pixels: &[u8]| {
            let fallback = quantize_rgb24_with_region(pixels, width, height, &palette, &region_map)
                .unwrap()
                .indices;
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4],
                policy,
                false,
                &fallback,
                "regional_ordered",
            )
            .unwrap()
        };
        let baseline = run(&original);
        let changed = run(&perturbed);
        for y in 0..usize::from(height) {
            let start = y * usize::from(width) + usize::from(width) / 2;
            let end = (y + 1) * usize::from(width);
            assert_eq!(&baseline.indices[start..end], &changed.indices[start..end]);
        }
        assert!(
            baseline
                .report
                .error_diffusion
                .as_ref()
                .unwrap()
                .cross_cell_rejected_class_count
                > 0
        );
    }

    #[test]
    fn v5_rejects_invalid_fallback_contracts() {
        let pixels = solid_gray_frames(&[128], 16 * 16);
        let palette = gray_palette(&[96, 128, 160]);
        let region_map = uniform_regions(1, 1, 0, 18, "invalid-fallback");
        let policy = TemporalHysteresisPolicy {
            max_hold_frames: 0,
            max_hold_duration_cs: 0,
        };
        assert!(matches!(
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                16,
                16,
                &palette,
                &region_map,
                &[4],
                policy,
                false,
                &[0; 3],
                "ffmpeg_mapper",
            ),
            Err(RegionalQuantizationError::InvalidFallbackSize { .. })
        ));
        let mut invalid = vec![0_u8; 16 * 16];
        invalid[17] = 200;
        assert!(matches!(
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                16,
                16,
                &palette,
                &region_map,
                &[4],
                policy,
                false,
                &invalid,
                "ffmpeg_mapper",
            ),
            Err(RegionalQuantizationError::InvalidFallbackIndex {
                pixel_index: 17,
                index: 200,
                ..
            })
        ));
    }

    #[test]
    fn v5_rescues_coherent_subcell_gradients() {
        let width = 32_u16;
        let height = 16_u16;
        let mut pixels = Vec::with_capacity(usize::from(width) * usize::from(height) * 3);
        for _y in 0..usize::from(height) {
            for x in 0..usize::from(width) {
                let (start, local_x) = if x < 16 {
                    (100_u8, x)
                } else {
                    (102_u8, x - 16)
                };
                let value = start.saturating_add(u8::try_from(local_x * 2 / 15).unwrap_or(2));
                pixels.extend_from_slice(&[value, value, value]);
            }
        }
        let palette = gray_palette(&[96, 100, 104, 108]);
        let region_map = uniform_regions(2, 1, 0, 18, "coherent-subcell-gradient");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4],
                TemporalHysteresisPolicy {
                    max_hold_frames: 0,
                    max_hold_duration_cs: 0,
                },
                false,
                &fallback,
                "regional_ordered",
            )
            .unwrap();
        let diagnostics = candidate.report.error_diffusion.as_ref().unwrap();
        let pixel_count = u64::from(width) * u64::from(height);

        assert_eq!(diagnostics.direct_gradient_eligible_cell_count, 0);
        assert_eq!(diagnostics.coherence_rescued_cell_count, 2);
        assert_eq!(diagnostics.coherence_rescued_pixel_count, pixel_count);
        assert_eq!(diagnostics.pre_protection_gradient_pixel_count, pixel_count);
        assert_eq!(diagnostics.gradient_eligible_pixel_count, pixel_count);
        assert_eq!(diagnostics.protected_edge_halo_pixel_count, 0);
    }

    #[test]
    fn v5_does_not_rescue_a_flat_cell_from_an_already_direct_gradient_neighbor() {
        let width = 32_u16;
        let height = 16_u16;
        let mut pixels = Vec::with_capacity(usize::from(width) * usize::from(height) * 3);
        for _y in 0..usize::from(height) {
            for x in 0..usize::from(width) {
                let value = if x < 16 {
                    100
                } else {
                    101_u8.saturating_add(u8::try_from((x - 16) * 3 / 15).unwrap_or(3))
                };
                pixels.extend_from_slice(&[value, value, value]);
            }
        }
        let layout = validate_layout(&pixels, width, height).unwrap();
        let region_map = uniform_regions(2, 1, 0, 18, "direct-neighbor-no-rescue");
        let plan = plan_error_diffusion_v5_eligibility(&pixels, &layout, &region_map);

        assert_eq!(plan.direct, vec![false, true]);
        assert_eq!(plan.coherence_rescued, vec![false, false]);
        assert_eq!(plan.strengths[0], 0.0);
        assert!(plan.strengths[1] > 0.0);
    }

    #[test]
    fn v5_hard_edge_halo_preserves_exact_fallback_and_blocks_residuals() {
        let width = 64_u16;
        let height = 32_u16;
        let mut pixels =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 1, 72, 48);
        let edge_x = usize::from(width) / 2;
        let edge_y = usize::from(height) / 2;
        let edge_byte = (edge_y * usize::from(width) + edge_x) * 3;
        pixels[edge_byte..edge_byte + 3].copy_from_slice(&[208, 208, 208]);
        let palette = gray_palette(&[64, 80, 96, 112, 128, 160, 192, 208]);
        let region_map = uniform_regions(1, 1, 0, 18, "hard-edge-halo");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4],
                TemporalHysteresisPolicy {
                    max_hold_frames: 0,
                    max_hold_duration_cs: 0,
                },
                false,
                &fallback,
                "regional_ordered",
            )
            .unwrap();
        let diagnostics = candidate.report.error_diffusion.as_ref().unwrap();

        assert!(diagnostics.protected_edge_seed_pixel_count > 0);
        assert!(
            diagnostics.protected_edge_halo_pixel_count
                > diagnostics.protected_edge_seed_pixel_count
        );
        assert_eq!(
            diagnostics.pre_protection_gradient_pixel_count,
            diagnostics.gradient_eligible_pixel_count + diagnostics.protected_edge_halo_pixel_count
        );
        assert_eq!(
            diagnostics.protected_edge_fallback_pixel_count,
            diagnostics.protected_edge_halo_pixel_count
        );
        assert_eq!(diagnostics.protected_edge_index_change_count, 0);
        assert!(diagnostics.protected_target_link_count > 0);
        assert!(diagnostics.protected_target_link_count <= diagnostics.blocked_residual_link_count);
    }

    #[test]
    fn v5_vfr_allows_one_temporal_hold_on_an_over_budget_frame() {
        let width = 64_u16;
        let height = 32_u16;
        let mut pixels = Vec::new();
        for start in [72_u8, 73, 74] {
            pixels.extend(horizontal_gray_gradient_frames(
                usize::from(width),
                usize::from(height),
                1,
                start,
                96,
            ));
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let region_map = uniform_regions(2, 1, 0, 18, "vfr-single-frame-extension");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 100, 100],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &fallback,
                "regional_ordered",
            )
            .unwrap();
        let diagnostics = candidate.report.error_diffusion.as_ref().unwrap();

        assert!(diagnostics.temporal_prev_candidate_count > 0);
        assert!(diagnostics.temporal_vfr_single_frame_extension_count > 0);
        assert!(diagnostics.temporal_prev_rejected_by_budget_count > 0);
        assert_eq!(
            diagnostics.temporal_vfr_single_frame_extension_count,
            diagnostics.temporal_regularized_hold_count
        );
        assert_eq!(
            candidate.report.temporal_hold_count,
            diagnostics.temporal_regularized_hold_count
        );
        assert!(candidate.report.temporal_max_observed_hold_duration_cs > 16);
    }

    #[test]
    fn v5_looping_seeds_the_first_frame_from_the_last_fallback() {
        let width = 64_u16;
        let height = 32_u16;
        let mut pixels = Vec::new();
        for start in [72_u8, 73] {
            pixels.extend(horizontal_gray_gradient_frames(
                usize::from(width),
                usize::from(height),
                1,
                start,
                96,
            ));
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let region_map = uniform_regions(2, 1, 0, 18, "loop-first-frame-seed");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let run = |looping| {
            quantize_rgb24_with_region_error_diffusion_v5_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                looping,
                &fallback,
                "regional_ordered",
            )
            .unwrap()
        };
        let non_looping = run(false);
        let looping = run(true);
        let non_looping_diagnostics = non_looping.report.error_diffusion.as_ref().unwrap();
        let looping_diagnostics = looping.report.error_diffusion.as_ref().unwrap();

        assert_eq!(non_looping_diagnostics.loop_seeded_pixel_count, 0);
        assert!(looping_diagnostics.loop_seeded_pixel_count > 0);
        assert!(
            looping_diagnostics.temporal_prev_candidate_count
                > non_looping_diagnostics.temporal_prev_candidate_count
        );
        assert_ne!(
            looping.report.artifact_sha256,
            non_looping.report.artifact_sha256
        );
    }

    #[test]
    fn phase_locked_pair_is_deterministic_and_changes_a_smooth_gradient() {
        let width = 64_u16;
        let height = 32_u16;
        let pixels =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 4, 72, 96);
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let region_map = uniform_regions(1, 1, 0, 18, "phase-gradient");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let run = || {
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4, 4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &fallback,
                "ffmpeg_global_palette",
            )
            .unwrap()
        };
        let first = run();
        let second = run();
        let diagnostics = first.report.phase_locked_pair.as_ref().unwrap();
        let frame_pixels = usize::from(width) * usize::from(height);

        assert_eq!(first, second);
        assert_ne!(&first.indices[..frame_pixels], &fallback[..frame_pixels]);
        assert!(diagnostics.eligible_pixel_count > 0);
        assert!(diagnostics.paired_pixel_count > 0);
        assert!(diagnostics.changed_pixel_count > 0, "{diagnostics:?}");
        assert_eq!(diagnostics.stored_frame_early_reject_count, 0);
        assert_eq!(diagnostics.protected_edge_index_change_count, 0);
        assert_eq!(diagnostics.ineligible_index_change_count, 0);
        assert_eq!(diagnostics.kernel_config_sha256.len(), 64);
        assert_eq!(diagnostics.pair_lookup_sha256.len(), 64);
        assert_eq!(diagnostics.eligibility_mask_sha256.len(), 64);
        assert_eq!(diagnostics.edge_protection_mask_sha256.len(), 64);
        assert_eq!(first.report.artifact_sha256.len(), 64);
    }

    #[test]
    fn phase_locked_pair_non_looping_static_first_frame_has_no_initialization_flip() {
        let width = 64_u16;
        let height = 32_u16;
        let frame_pixels = usize::from(width) * usize::from(height);
        let frame_bytes = frame_pixels * 3;
        let frame =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 1, 72, 96);
        let pixels = frame.repeat(2);
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let region_map = uniform_regions(1, 1, 0, 18, "phase-static-first-frame");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &fallback,
                "ffmpeg_global_palette",
            )
            .unwrap();
        let diagnostics = candidate.report.phase_locked_pair.as_ref().unwrap();

        assert!(diagnostics.paired_pixel_count > 0, "{diagnostics:?}");
        assert!(diagnostics.changed_pixel_count > 0, "{diagnostics:?}");
        assert_ne!(
            &candidate.indices[..frame_pixels],
            &fallback[..frame_pixels]
        );
        assert_eq!(
            &candidate.indices[..frame_pixels],
            &candidate.indices[frame_pixels..frame_pixels * 2]
        );
        assert_eq!(
            &candidate.reconstructed_rgb24[..frame_bytes],
            &candidate.reconstructed_rgb24[frame_bytes..frame_bytes * 2]
        );
        assert_eq!(diagnostics.static_index_flip_count, 0);
        assert_eq!(diagnostics.vfr_weighted_static_index_flip_rate, 0.0);
        assert_eq!(diagnostics.temporal_candidate_count, 0);
        assert_eq!(diagnostics.temporal_hold_count, 0);
    }

    #[test]
    fn phase_locked_pair_kernel_config_hash_is_stable() {
        let first = phase_locked_pair_kernel_config_sha256();
        assert_eq!(first.len(), 64);
        assert_eq!(first, phase_locked_pair_kernel_config_sha256());
        assert_eq!(
            first,
            "fea10bac4b8d0bcc973e2f91d7f2a92c32f990b4d60fd05eca97b414f218d137"
        );
        assert_ne!(first, error_diffusion_v5_kernel_config_sha256());
    }

    #[test]
    fn phase_locked_pair_preserves_edges_texture_and_transparency_exactly() {
        let width = 64_u16;
        let height = 32_u16;
        let mut frame =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 1, 72, 96);
        let spike_x = usize::from(width) / 4;
        let spike_y = usize::from(height) / 2;
        let spike_byte = (spike_y * usize::from(width) + spike_x) * 3;
        frame[spike_byte..spike_byte + 3].copy_from_slice(&[240, 240, 240]);
        let pixels = frame.repeat(4);
        let palette = gray_palette(&[64, 80, 96, 112, 128, 160, 192, 224, 240]);
        let region_map = regions(vec![0, 3], vec![18, 255]);
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4, 4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &fallback,
                "ffmpeg_global_palette",
            )
            .unwrap();
        let diagnostics = candidate.report.phase_locked_pair.as_ref().unwrap();
        let frame_pixels = usize::from(width) * usize::from(height);

        assert!(diagnostics.protected_edge_pixel_count > 0);
        assert_eq!(diagnostics.protected_edge_index_change_count, 0);
        assert_eq!(diagnostics.ineligible_index_change_count, 0);
        for frame_index in 0..4 {
            let frame_offset = frame_index * frame_pixels;
            for y in 0..usize::from(height) {
                let start = frame_offset + y * usize::from(width) + usize::from(width) / 2;
                let end = frame_offset + (y + 1) * usize::from(width);
                assert_eq!(&candidate.indices[start..end], &fallback[start..end]);
            }
        }

        let transparent_width = 16_u16;
        let transparent_height = 16_u16;
        let transparent_pixels = horizontal_gray_gradient_frames(16, 16, 2, 96, 8);
        let transparent_fallback = vec![255_u8; 16 * 16 * 2];
        let transparent =
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &transparent_pixels,
                transparent_width,
                transparent_height,
                &palette,
                &uniform_regions(1, 1, 0, 18, "transparent"),
                &[4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &transparent_fallback,
                "ffmpeg_transparent",
            )
            .unwrap();
        let transparent_diagnostics = transparent.report.phase_locked_pair.as_ref().unwrap();
        assert_eq!(transparent.indices, transparent_fallback);
        assert_eq!(
            transparent_diagnostics.transparent_fallback_pixel_count,
            512
        );
        assert_eq!(transparent_diagnostics.changed_pixel_count, 0);
    }

    #[test]
    fn phase_locked_pair_skin_hue_and_chroma_guards_fail_closed() {
        let width = 32_u16;
        let height = 16_u16;
        let mut frame = Vec::with_capacity(usize::from(width) * usize::from(height) * 3);
        for _y in 0..usize::from(height) {
            for x in 0..usize::from(width) {
                let step = u8::try_from(x * 8 / usize::from(width)).unwrap_or(8);
                frame.extend_from_slice(&[
                    186_u8.saturating_add(step),
                    122_u8.saturating_add(step),
                    104_u8.saturating_add(step),
                ]);
            }
        }
        let pixels = frame.repeat(4);
        let palette = rgb_palette(&[[180, 112, 94], [80, 120, 220], [80, 200, 100]]);
        let region_map = uniform_regions(1, 1, 2, 96, "skin-guard");
        let fallback = vec![0_u8; usize::from(width) * usize::from(height) * 4];
        let candidate =
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4, 4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &fallback,
                "ffmpeg_skin",
            )
            .unwrap();
        let diagnostics = candidate.report.phase_locked_pair.as_ref().unwrap();
        let source = srgb8_to_oklab([190, 126, 108]);
        let (hue_rejected, chroma_rejected) = phase_locked_skin_pair_rejection(
            source,
            srgb8_to_oklab([180, 112, 94]),
            srgb8_to_oklab([80, 120, 220]),
        );

        assert!(hue_rejected);
        assert!(chroma_rejected);
        assert!(diagnostics.skin_pair_hue_rejection_count > 0);
        assert!(diagnostics.skin_pair_chroma_rejection_count > 0);
        assert_eq!(diagnostics.changed_pixel_count, 0);
        assert_eq!(candidate.indices, fallback);
    }

    #[test]
    fn phase_locked_pair_reduces_micro_change_index_flips() {
        let width = 64_u16;
        let height = 32_u16;
        let mut pixels = Vec::new();
        for start in [72_u8, 73, 72, 73, 72, 73] {
            pixels.extend(horizontal_gray_gradient_frames(
                usize::from(width),
                usize::from(height),
                1,
                start,
                96,
            ));
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let region_map = uniform_regions(1, 1, 0, 18, "micro-flips");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4, 4, 4, 4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &fallback,
                "ffmpeg_global_palette",
            )
            .unwrap();
        let diagnostics = candidate.report.phase_locked_pair.as_ref().unwrap();

        assert!(diagnostics.fallback_static_index_flip_count > 0);
        assert!(
            diagnostics.static_index_flip_count < diagnostics.fallback_static_index_flip_count,
            "{diagnostics:?}"
        );
        assert!(diagnostics.temporal_hold_count > 0);
        assert!(
            diagnostics.vfr_weighted_static_index_flip_rate
                < diagnostics.fallback_vfr_weighted_static_index_flip_rate
        );
    }

    #[test]
    fn phase_locked_pair_vfr_hold_never_exceeds_conservative_limits() {
        let width = 64_u16;
        let height = 32_u16;
        let mut pixels = Vec::new();
        for start in [72_u8, 73, 72] {
            pixels.extend(horizontal_gray_gradient_frames(
                usize::from(width),
                usize::from(height),
                1,
                start,
                96,
            ));
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let region_map = uniform_regions(1, 1, 0, 18, "vfr-bound");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 100, 100],
                TemporalHysteresisPolicy {
                    max_hold_frames: u8::MAX,
                    max_hold_duration_cs: u16::MAX,
                },
                false,
                &fallback,
                "ffmpeg_global_palette",
            )
            .unwrap();
        let diagnostics = candidate.report.phase_locked_pair.as_ref().unwrap();

        assert_eq!(candidate.report.temporal_policy_max_hold_frames, 2);
        assert_eq!(candidate.report.temporal_policy_max_hold_duration_cs, 16);
        assert!(diagnostics.temporal_candidate_count > 0);
        assert!(diagnostics.temporal_rejected_by_budget_count > 0);
        assert!(diagnostics.temporal_max_observed_hold_duration_cs <= 16);
    }

    #[test]
    fn phase_locked_pair_scene_cut_resets_and_preserves_fallback() {
        let width = 64_u16;
        let height = 32_u16;
        let frame_pixels = usize::from(width) * usize::from(height);
        let mut pixels =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 1, 72, 64);
        pixels.extend(horizontal_gray_gradient_frames(
            usize::from(width),
            usize::from(height),
            1,
            176,
            64,
        ));
        let palette = gray_palette(&[64, 80, 96, 112, 128, 160, 176, 192, 208, 224]);
        let region_map = uniform_regions(1, 1, 0, 18, "cut-reset");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let candidate =
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                &fallback,
                "ffmpeg_global_palette",
            )
            .unwrap();
        let diagnostics = candidate.report.phase_locked_pair.as_ref().unwrap();

        assert_ne!(
            &candidate.indices[..frame_pixels],
            &fallback[..frame_pixels]
        );
        assert_eq!(
            &candidate.indices[frame_pixels..frame_pixels * 2],
            &fallback[frame_pixels..frame_pixels * 2]
        );
        assert!(diagnostics.changed_pixel_count > 0);
        assert_eq!(diagnostics.cut_reset_pixel_count, frame_pixels as u64);
        assert_eq!(
            diagnostics.scene_cut_fallback_pixel_count,
            frame_pixels as u64
        );
    }

    #[test]
    fn phase_locked_pair_loop_seeds_last_to_first_without_unbounded_hold() {
        let width = 64_u16;
        let height = 32_u16;
        let mut pixels = Vec::new();
        for start in [72_u8, 73, 72, 73] {
            pixels.extend(horizontal_gray_gradient_frames(
                usize::from(width),
                usize::from(height),
                1,
                start,
                96,
            ));
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let region_map = uniform_regions(1, 1, 0, 18, "loop-seed");
        let fallback = quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map)
            .unwrap()
            .indices;
        let run = |looping| {
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[4, 4, 4, 4],
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                looping,
                &fallback,
                "ffmpeg_global_palette",
            )
            .unwrap()
        };
        let one_shot = run(false);
        let looping = run(true);
        let one_shot_diagnostics = one_shot.report.phase_locked_pair.as_ref().unwrap();
        let looping_diagnostics = looping.report.phase_locked_pair.as_ref().unwrap();

        assert_eq!(one_shot_diagnostics.loop_seeded_pixel_count, 0);
        assert!(looping_diagnostics.loop_seeded_pixel_count > 0);
        assert!(looping_diagnostics.temporal_max_observed_hold_duration_cs <= 16);
        assert_ne!(
            looping.report.artifact_sha256,
            one_shot.report.artifact_sha256
        );
        assert_eq!(
            looping_diagnostics.eligibility_mask_sha256,
            one_shot_diagnostics.eligibility_mask_sha256
        );
    }

    #[test]
    fn phase_locked_pair_rejects_invalid_inputs_fail_closed() {
        let width = 16_u16;
        let height = 16_u16;
        let pixels = horizontal_gray_gradient_frames(16, 16, 2, 96, 8);
        let palette = gray_palette(&[96, 104, 112]);
        let region_map = uniform_regions(1, 1, 0, 18, "invalid-input");
        let fallback = vec![0_u8; 16 * 16 * 2];
        let run = |palette: &OklabPaletteArtifact, delays: &[u16], fallback: &[u8]| {
            quantize_rgb24_with_region_phase_locked_pair_temporal_with_delays_and_fallback(
                &pixels,
                width,
                height,
                palette,
                &region_map,
                delays,
                TemporalHysteresisPolicy::CONSERVATIVE_V1,
                false,
                fallback,
                "ffmpeg_global_palette",
            )
        };

        assert_eq!(
            run(&palette, &[4], &fallback),
            Err(RegionalQuantizationError::InvalidFrameDelayCount {
                expected: 2,
                actual: 1,
            })
        );
        assert_eq!(
            run(&palette, &[4, 4], &fallback[..fallback.len() - 1]),
            Err(RegionalQuantizationError::InvalidFallbackSize {
                expected: fallback.len(),
                actual: fallback.len() - 1,
            })
        );
        let mut invalid_palette = palette.clone();
        invalid_palette.rgba[3] = 0;
        assert_eq!(
            run(&invalid_palette, &[4, 4], &fallback),
            Err(RegionalQuantizationError::InvalidPalette)
        );
    }

    #[test]
    fn texture_strength_uses_secondary_colors_while_flat_strength_stays_nearest() {
        let width = 32_u16;
        let height = 16_u16;
        let frame = [128_u8, 128, 128].repeat(usize::from(width) * usize::from(height) * 2);
        let artifact = quantize_rgb24_with_region(
            &frame,
            width,
            height,
            &black_white_palette(),
            &regions(vec![0, 3], vec![0, 255]),
        )
        .unwrap();

        assert_eq!(artifact.report.frame_count, 2);
        assert_eq!(artifact.report.secondary_choice_by_class[0], 0);
        assert!(artifact.report.secondary_choice_by_class[3] > 0);
        let frame_pixels = usize::from(width) * usize::from(height);
        assert_eq!(
            &artifact.indices[..frame_pixels],
            &artifact.indices[frame_pixels..]
        );
        assert_eq!(artifact.report.metrics.static_temporal_residual, 0.0);
        assert_eq!(artifact.report.artifact_sha256.len(), 64);
    }

    #[test]
    fn quantization_is_byte_deterministic() {
        let pixels = (0_u8..=255)
            .flat_map(|value| [value, value.wrapping_mul(3), 255 - value])
            .collect::<Vec<_>>();
        let first = quantize_rgb24_with_region(
            &pixels,
            16,
            16,
            &black_white_palette(),
            &regions(vec![0, 3], vec![20, 220]),
        )
        .unwrap();
        let second = quantize_rgb24_with_region(
            &pixels,
            16,
            16,
            &black_white_palette(),
            &regions(vec![0, 3], vec![20, 220]),
        )
        .unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn cell_error_diffusion_is_deterministic_temporally_stable_and_region_isolated() {
        let width = 64_u16;
        let height = 32_u16;
        let frame_count = 3_usize;
        let pixels = horizontal_gray_gradient_frames(
            usize::from(width),
            usize::from(height),
            frame_count,
            72,
            96,
        );
        let palette = gray_palette(&[64, 96, 128, 160, 192]);
        let region_map = regions(vec![0, 1], vec![18, 30]);
        let baseline =
            quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map).unwrap();
        let policy = TemporalHysteresisPolicy {
            max_hold_frames: 0,
            max_hold_duration_cs: 0,
        };
        let first = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4, 4, 4],
            policy,
        )
        .unwrap();
        let second = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4, 4, 4],
            policy,
        )
        .unwrap();

        assert_eq!(first, second);
        assert_eq!(
            first.report.spatial_kernel_id,
            "oklab_cell_edge_aware_serpentine_fs_temporal_v3"
        );
        let diagnostics = first.report.error_diffusion.as_ref().unwrap();
        assert_eq!(diagnostics.kernel_config_sha256.len(), 64);
        assert_eq!(
            diagnostics.kernel_config_sha256,
            error_diffusion_kernel_config_sha256()
        );
        assert_eq!(
            first.report.indices_sha256,
            "fc560c061cdcfac5d42a74f11fc2f4db788a2e9ed3f06d6dfdbddc00a90e0a29"
        );
        assert_eq!(
            first.report.reconstructed_rgb24_sha256,
            "84318d5da2198c5627578e4d8ee78c3cfce784c74de13d6cbcb5200f98ba06f9"
        );
        assert_eq!(
            first.report.artifact_sha256,
            "a3a1ee5e613ae9309fe4bc0d82040e67af522938afc5ab06e15fe09278d15ad7"
        );
        assert_eq!(
            diagnostics.cell_reset_count,
            u64::try_from(frame_count).unwrap()
        );
        assert_eq!(diagnostics.diffused_pixel_by_class[1], 0);
        assert!(diagnostics.gradient_eligible_pixel_count > 0);
        assert!(diagnostics.diffused_pixel_by_class[0] > 0);
        assert_eq!(diagnostics.static_index_flip_count, 0);
        assert_eq!(diagnostics.vfr_weighted_static_index_flip_rate, 0.0);
        let pixels_per_frame = usize::from(width) * usize::from(height);
        assert_eq!(
            &first.indices[..pixels_per_frame],
            &first.indices[pixels_per_frame..pixels_per_frame * 2]
        );
        assert!(
            first.report.metrics.multiscale_low_frequency_oklab_error
                < baseline.report.metrics.multiscale_low_frequency_oklab_error * 0.80,
            "baseline={:?} error_diffusion={:?}",
            baseline.report.metrics,
            first.report.metrics
        );
    }

    #[test]
    fn error_diffusion_eligibility_is_per_frame_and_hard_edge_clears_holds() {
        let width = 64_u16;
        let height = 16_u16;
        let pixels_per_frame = usize::from(width) * usize::from(height);
        let mut pixels =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 2, 72, 48);
        for _y in 0..usize::from(height) {
            for x in 0..usize::from(width) {
                let value = if (x / 4) % 2 == 0 { 80_u8 } else { 160_u8 };
                pixels.extend_from_slice(&[value, value, value]);
            }
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176]);
        let region_map = regions(vec![0, 0], vec![0, 0]);
        let nearest =
            quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map).unwrap();
        let candidate = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4, 4, 4],
            TemporalHysteresisPolicy::CONSERVATIVE_V1,
        )
        .unwrap();
        let diagnostics = candidate.report.error_diffusion.as_ref().unwrap();
        let final_frame_start = pixels_per_frame * 2;

        assert_eq!(diagnostics.cell_reset_count, 4);
        assert_eq!(
            diagnostics.gradient_eligible_pixel_count,
            u64::try_from(pixels_per_frame * 2).unwrap()
        );
        assert_eq!(
            &candidate.indices[final_frame_start..final_frame_start + pixels_per_frame],
            &nearest.indices[final_frame_start..final_frame_start + pixels_per_frame],
            "the hard-edge frame must use nearest mapping and cannot retain a prior diffused index"
        );
    }

    #[test]
    fn error_diffusion_error_state_is_isolated_at_real_cell_boundaries() {
        let width = 64_u16;
        let height = 16_u16;
        let half_width = usize::from(width) / 2;
        let build_frame = |left_start: u8| {
            let mut frame = Vec::with_capacity(usize::from(width) * usize::from(height) * 3);
            for _y in 0..usize::from(height) {
                for x in 0..usize::from(width) {
                    let (start, local_x) = if x < half_width {
                        (left_start, x)
                    } else {
                        (112_u8, x - half_width)
                    };
                    let value = start.saturating_add(
                        u8::try_from(local_x.saturating_mul(24) / half_width).unwrap_or(24),
                    );
                    frame.extend_from_slice(&[value, value, value]);
                }
            }
            frame
        };
        let first_pixels = build_frame(48);
        let perturbed_left_pixels = build_frame(176);
        let palette = gray_palette(&[32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208]);
        let region_map = regions(vec![0, 0], vec![0, 0]);
        let policy = TemporalHysteresisPolicy {
            max_hold_frames: 0,
            max_hold_duration_cs: 0,
        };
        let first = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &first_pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4],
            policy,
        )
        .unwrap();
        let perturbed = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &perturbed_left_pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4],
            policy,
        )
        .unwrap();

        assert_ne!(
            &first.indices[..half_width],
            &perturbed.indices[..half_width]
        );
        for y in 0..usize::from(height) {
            let right_start = y * usize::from(width) + half_width;
            let right_end = (y + 1) * usize::from(width);
            assert_eq!(
                &first.indices[right_start..right_end],
                &perturbed.indices[right_start..right_end],
                "left-cell residual leaked into right cell on row {y}"
            );
        }
    }

    #[test]
    fn error_diffusion_kernel_config_hash_is_stable() {
        assert_eq!(
            error_diffusion_kernel_config_sha256(),
            "16f585bdde8bb35d2a7bb72c400c15c565f562727c458d6c29561c8e359c7e96"
        );
    }

    #[test]
    fn error_diffusion_v5_kernel_config_hash_is_stable() {
        assert_eq!(
            error_diffusion_v5_kernel_config_sha256(),
            "c2a32d60b469e0b1a2f5a33ca0865724d522e798b3bcf5592bdacf0a58e686ed"
        );
    }

    #[test]
    fn error_diffusion_blocks_residual_at_an_intra_cell_hard_edge() {
        let width = 64_u16;
        let height = 16_u16;
        let build_frame = |left_bias: u8| {
            let mut frame = Vec::with_capacity(usize::from(width) * usize::from(height) * 3);
            for _y in 0..usize::from(height) {
                for x in 0..usize::from(width) {
                    let value = if x < 16 {
                        left_bias.saturating_add(u8::try_from(x).unwrap_or(15))
                    } else if x < 32 {
                        176_u8.saturating_add(u8::try_from(x - 16).unwrap_or(15))
                    } else {
                        32
                    };
                    frame.extend_from_slice(&[value, value, value]);
                }
            }
            frame
        };
        let baseline_pixels = build_frame(72);
        let perturbed_pixels = build_frame(88);
        let palette = gray_palette(&[32, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208]);
        let region_map = regions(vec![0, 1], vec![0, 0]);
        let policy = TemporalHysteresisPolicy {
            max_hold_frames: 0,
            max_hold_duration_cs: 0,
        };
        let baseline = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &baseline_pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4],
            policy,
        )
        .unwrap();
        let perturbed = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &perturbed_pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4],
            policy,
        )
        .unwrap();
        let baseline_diagnostics = baseline.report.error_diffusion.as_ref().unwrap();
        let perturbed_diagnostics = perturbed.report.error_diffusion.as_ref().unwrap();

        assert!(baseline_diagnostics.blocked_residual_link_count > 0);
        assert!(baseline_diagnostics.edge_guarded_pixel_count > 0);
        assert!(perturbed_diagnostics.blocked_residual_link_count > 0);
        assert_ne!(&baseline.indices[..16], &perturbed.indices[..16]);
        for y in 0..usize::from(height) {
            let protected_start = y * usize::from(width) + 16;
            let protected_end = y * usize::from(width) + 32;
            assert_eq!(
                &baseline.indices[protected_start..protected_end],
                &perturbed.indices[protected_start..protected_end],
                "left-side residual crossed the hard edge on row {y}"
            );
        }
    }

    #[test]
    fn error_diffusion_vfr_gradient_keeps_identical_loop_endpoint_stable() {
        let width = 64_u16;
        let height = 16_u16;
        let pixels_per_frame = usize::from(width) * usize::from(height);
        let mut pixels = Vec::new();
        for start in [72_u8, 73, 72] {
            pixels.extend(horizontal_gray_gradient_frames(
                usize::from(width),
                usize::from(height),
                1,
                start,
                48,
            ));
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144]);
        let region_map = regions(vec![0, 0], vec![0, 0]);
        let candidate = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            &[1, 100, 100],
            TemporalHysteresisPolicy::CONSERVATIVE_V1,
        )
        .unwrap();
        let diagnostics = candidate.report.error_diffusion.as_ref().unwrap();
        let looping = evaluate_timing_aware_temporal_residual(
            &pixels,
            &candidate.reconstructed_rgb24,
            width,
            height,
            &[1, 100, 100],
            true,
        )
        .unwrap();

        assert_eq!(candidate.report.temporal_hold_count, 0);
        assert_eq!(candidate.report.temporal_hold_duration_cs, 0);
        assert_eq!(
            diagnostics.gradient_eligible_pixel_count,
            u64::try_from(pixels_per_frame * 3).unwrap()
        );
        assert_eq!(
            &candidate.indices[..pixels_per_frame],
            &candidate.indices[pixels_per_frame * 2..],
            "per-frame cell resets must make identical loop endpoints byte-identical"
        );
        assert_eq!(
            looping.loop_seam_sampled_static_pixel_count,
            u64::try_from(pixels_per_frame).unwrap()
        );
        assert_eq!(looping.loop_seam_static_temporal_residual, Some(0.0));
        assert_eq!(
            looping.loop_seam_multiscale_static_temporal_residual,
            Some(0.0)
        );
    }

    #[test]
    fn error_diffusion_emitted_residual_preserves_local_mean_after_hold_override() {
        let palette = vec![
            srgb8_to_oklab([96, 96, 96]),
            srgb8_to_oklab([104, 104, 104]),
        ];
        let source = srgb8_to_oklab([101, 101, 101]);
        let (emitted_residual, _) =
            emitted_error_diffusion_residual(source, 0, &palette, ERROR_DIFFUSION_FLAT_STRENGTH, 0);
        let (stale_spatial_residual, _) =
            emitted_error_diffusion_residual(source, 1, &palette, ERROR_DIFFUSION_FLAT_STRENGTH, 0);
        let emitted_next = nearest_palette_index_for_lab(
            add_oklab(source, scale_oklab(emitted_residual, 7.0 / 16.0)),
            &palette,
        );
        let stale_next = nearest_palette_index_for_lab(
            add_oklab(source, scale_oklab(stale_spatial_residual, 7.0 / 16.0)),
            &palette,
        );
        let emitted_pair_mean = (96_u16 + [96_u16, 104][usize::from(emitted_next)]) / 2;
        let stale_pair_mean = (96_u16 + [96_u16, 104][usize::from(stale_next)]) / 2;

        assert_eq!(emitted_next, 1);
        assert_eq!(stale_next, 0);
        assert!(
            emitted_pair_mean.abs_diff(101) < stale_pair_mean.abs_diff(101),
            "residual must be computed from held index 0, not the superseded spatial index 1"
        );
    }

    #[test]
    fn skin_residual_limits_are_stricter_than_flat_limits() {
        let residual = Oklab {
            l: 0.080,
            a: -0.060,
            b: 0.060,
        };
        let (flat, flat_clamped) = clamp_error_diffusion_residual(residual, 0);
        let (skin, skin_clamped) = clamp_error_diffusion_residual(residual, 2);

        assert!(flat_clamped);
        assert!(skin_clamped);
        assert_eq!(flat.l, ERROR_DIFFUSION_FLAT_RESIDUAL_L_LIMIT);
        assert_eq!(flat.a, -ERROR_DIFFUSION_FLAT_RESIDUAL_CHROMA_LIMIT);
        assert_eq!(flat.b, ERROR_DIFFUSION_FLAT_RESIDUAL_CHROMA_LIMIT);
        assert_eq!(skin.l, ERROR_DIFFUSION_SKIN_RESIDUAL_L_LIMIT);
        assert_eq!(skin.a, -ERROR_DIFFUSION_SKIN_RESIDUAL_CHROMA_LIMIT);
        assert_eq!(skin.b, ERROR_DIFFUSION_SKIN_RESIDUAL_CHROMA_LIMIT);
        assert!(skin.l < flat.l);
        assert!(skin.b < flat.b);
    }

    #[test]
    fn skin_gradient_enables_only_the_skin_error_diffusion_class() {
        let width = 64_u16;
        let height = 16_u16;
        let pixels =
            horizontal_gray_gradient_frames(usize::from(width), usize::from(height), 1, 72, 96);
        let artifact = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176]),
            &regions(vec![2, 1], vec![255, 0]),
            &[4],
            TemporalHysteresisPolicy {
                max_hold_frames: 0,
                max_hold_duration_cs: 0,
            },
        )
        .unwrap();
        let diagnostics = artifact.report.error_diffusion.as_ref().unwrap();

        assert_eq!(
            diagnostics.gradient_eligible_pixel_count,
            u64::from(width / 2) * u64::from(height)
        );
        assert!(diagnostics.diffused_pixel_by_class[2] > 0);
        assert_eq!(diagnostics.diffused_pixel_by_class[0], 0);
        assert_eq!(diagnostics.diffused_pixel_by_class[1], 0);
        assert_eq!(diagnostics.diffused_pixel_by_class[3], 0);
        assert_eq!(diagnostics.temporal_regularized_hold_count, 0);
    }

    #[test]
    fn static_index_flip_rate_weights_the_current_vfr_frame_duration() {
        let pixels = [100_u8, 100, 100].repeat(3);
        let indices = [0_u8, 1, 1];
        let layout = validate_layout(&pixels, 1, 1).unwrap();
        let (long_flip_count, long_flip_rate) =
            measure_static_index_flips(&pixels, &indices, &layout, &[1, 100, 1]);
        let (short_flip_count, short_flip_rate) =
            measure_static_index_flips(&pixels, &indices, &layout, &[1, 1, 100]);

        assert_eq!(long_flip_count, 1);
        assert_eq!(short_flip_count, 1);
        assert!((long_flip_rate - 100.0 / 101.0).abs() < f64::EPSILON);
        assert!((short_flip_rate - 1.0 / 101.0).abs() < f64::EPSILON);
    }

    #[test]
    fn cell_error_diffusion_temporal_lock_reduces_micro_gradient_index_flips() {
        let width = 64_u16;
        let height = 32_u16;
        let mut pixels = Vec::new();
        for start in [72_u8, 73, 72, 73, 72] {
            pixels.extend(horizontal_gray_gradient_frames(
                usize::from(width),
                usize::from(height),
                1,
                start,
                96,
            ));
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let region_map = regions(vec![0, 0], vec![18, 18]);
        let spatial = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4; 5],
            TemporalHysteresisPolicy {
                max_hold_frames: 0,
                max_hold_duration_cs: 0,
            },
        )
        .unwrap();
        let temporal = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            &[4; 5],
            TemporalHysteresisPolicy::CONSERVATIVE_V1,
        )
        .unwrap();
        let spatial_diagnostics = spatial.report.error_diffusion.as_ref().unwrap();
        let temporal_diagnostics = temporal.report.error_diffusion.as_ref().unwrap();

        assert!(temporal.report.temporal_hold_count > 0);
        assert!(temporal_diagnostics.temporal_prev_candidate_count > 0);
        assert!(temporal_diagnostics.temporal_regularized_hold_count > 0);
        assert!(temporal_diagnostics.temporal_prev_rejected_by_color_count > 0);
        assert!(temporal_diagnostics.temporal_prev_rejected_by_regularizer_count > 0);
        assert_eq!(
            temporal_diagnostics.temporal_prev_rejected_by_budget_count,
            0
        );
        assert_eq!(
            temporal_diagnostics.temporal_prev_candidate_count,
            temporal_diagnostics.temporal_regularized_hold_count
                + temporal_diagnostics.temporal_prev_rejected_by_color_count
                + temporal_diagnostics.temporal_prev_rejected_by_budget_count
                + temporal_diagnostics.temporal_prev_rejected_by_regularizer_count,
            "every previous-index candidate must close into one diagnostic outcome"
        );
        assert!(
            temporal_diagnostics.vfr_weighted_static_index_flip_rate
                < spatial_diagnostics.vfr_weighted_static_index_flip_rate,
            "spatial={spatial_diagnostics:?} temporal={temporal_diagnostics:?}"
        );
        assert!(
            temporal.report.metrics.static_temporal_residual
                <= spatial.report.metrics.static_temporal_residual,
            "spatial={:?} temporal={:?}",
            spatial.report.metrics,
            temporal.report.metrics
        );
    }

    #[test]
    fn error_diffusion_temporal_hold_rejects_a_vfr_frame_over_budget() {
        let width = 64_u16;
        let height = 32_u16;
        let mut pixels = Vec::new();
        for start in [72_u8, 73] {
            pixels.extend(horizontal_gray_gradient_frames(
                usize::from(width),
                usize::from(height),
                1,
                start,
                96,
            ));
        }
        let palette = gray_palette(&[64, 80, 96, 112, 128, 144, 160, 176, 192]);
        let artifact = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &regions(vec![0, 0], vec![18, 18]),
            &[4, 100],
            TemporalHysteresisPolicy::CONSERVATIVE_V1,
        )
        .unwrap();
        let diagnostics = artifact.report.error_diffusion.as_ref().unwrap();

        assert!(diagnostics.temporal_prev_candidate_count > 0);
        assert_eq!(
            diagnostics.temporal_prev_candidate_count,
            diagnostics.temporal_prev_rejected_by_budget_count
        );
        assert_eq!(diagnostics.temporal_regularized_hold_count, 0);
        assert_eq!(artifact.report.temporal_hold_count, 0);
        assert_eq!(artifact.report.temporal_hold_by_class[1], 0);
        assert_eq!(artifact.report.temporal_hold_by_class[3], 0);
        assert!(
            artifact.report.temporal_max_observed_hold_duration_cs
                <= TemporalHysteresisPolicy::CONSERVATIVE_V1.max_hold_duration_cs
        );
    }

    #[test]
    fn temporal_hysteresis_is_deterministic_and_reduces_static_micro_noise() {
        let width = 16_u16;
        let height = 16_u16;
        let pixels_per_frame = usize::from(width) * usize::from(height);
        let pixels = solid_gray_frames(&[99, 101, 99, 101, 99], pixels_per_frame);
        let palette = gray_palette(&[96, 104]);
        let region_map = regions(vec![0, 0], vec![0, 0]);
        let baseline =
            quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map).unwrap();
        let first = quantize_rgb24_with_region_temporal_hysteresis(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            TemporalHysteresisPolicy::CONSERVATIVE_V1,
        )
        .unwrap();
        let second = quantize_rgb24_with_region_temporal_hysteresis(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            TemporalHysteresisPolicy::CONSERVATIVE_V1,
        )
        .unwrap();

        assert_eq!(first, second);
        assert!(first.report.temporal_hold_count > 0);
        assert_eq!(
            first.report.temporal_hold_by_class,
            [first.report.temporal_hold_count, 0, 0, 0]
        );
        assert!(
            first.report.metrics.static_temporal_residual
                < baseline.report.metrics.static_temporal_residual,
            "baseline={:?} temporal={:?}",
            baseline.report.metrics,
            first.report.metrics
        );
        assert!(
            first.report.metrics.multiscale_static_temporal_residual
                < baseline.report.metrics.multiscale_static_temporal_residual,
            "baseline={:?} temporal={:?}",
            baseline.report.metrics,
            first.report.metrics
        );
    }

    #[test]
    fn temporal_hysteresis_is_bounded_and_obvious_motion_resets_it() {
        let width = 16_u16;
        let height = 16_u16;
        let pixels_per_frame = usize::from(width) * usize::from(height);
        let pixels = solid_gray_frames(&[99, 101, 101, 101, 192], pixels_per_frame);
        let palette = gray_palette(&[96, 104, 192]);
        let region_map = regions(vec![0, 0], vec![0, 0]);
        let baseline =
            quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map).unwrap();
        let temporal = quantize_rgb24_with_region_temporal_hysteresis(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            TemporalHysteresisPolicy {
                max_hold_frames: 2,
                max_hold_duration_cs: 16,
            },
        )
        .unwrap();
        let baseline_first = (0..5)
            .map(|frame| baseline.indices[frame * pixels_per_frame])
            .collect::<Vec<_>>();
        let temporal_first = (0..5)
            .map(|frame| temporal.indices[frame * pixels_per_frame])
            .collect::<Vec<_>>();

        assert_ne!(baseline_first[0], baseline_first[1]);
        assert_eq!(temporal_first[0], baseline_first[0]);
        assert_eq!(temporal_first[1], baseline_first[0]);
        assert_eq!(temporal_first[2], baseline_first[0]);
        assert_eq!(temporal_first[3], baseline_first[3]);
        assert_ne!(temporal_first[3], temporal_first[0]);
        assert_eq!(temporal_first[4], baseline_first[4]);
        assert_ne!(temporal_first[4], temporal_first[3]);
        assert_eq!(
            temporal.report.temporal_hold_count,
            u64::try_from(pixels_per_frame * 2).unwrap()
        );
        assert_eq!(temporal.report.temporal_policy_max_hold_frames, 2);
        assert_eq!(temporal.report.temporal_policy_max_hold_duration_cs, 16);
        assert_eq!(temporal.report.temporal_max_observed_hold_duration_cs, 2);
    }

    #[test]
    fn temporal_hysteresis_vfr_duration_budget_prevents_long_frame_freeze() {
        let width = 16_u16;
        let height = 16_u16;
        let pixels_per_frame = usize::from(width) * usize::from(height);
        let pixels = solid_gray_frames(&[99, 101, 99], pixels_per_frame);
        let palette = gray_palette(&[96, 104]);
        let region_map = regions(vec![0, 0], vec![0, 0]);
        let baseline =
            quantize_rgb24_with_region(&pixels, width, height, &palette, &region_map).unwrap();
        let temporal = quantize_rgb24_with_region_temporal_hysteresis_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            &[1, 100, 100],
            TemporalHysteresisPolicy {
                max_hold_frames: 2,
                max_hold_duration_cs: 16,
            },
        )
        .unwrap();

        assert_eq!(temporal.indices, baseline.indices);
        assert_eq!(temporal.report.temporal_hold_count, 0);
        assert_eq!(temporal.report.temporal_hold_duration_cs, 0);
        assert_eq!(temporal.report.temporal_max_observed_hold_duration_cs, 0);
        assert_eq!(temporal.report.temporal_policy_max_hold_duration_cs, 16);
    }

    #[test]
    fn temporal_hysteresis_vfr_short_frames_hold_within_both_budgets() {
        let width = 16_u16;
        let height = 16_u16;
        let pixels_per_frame = usize::from(width) * usize::from(height);
        let pixels = solid_gray_frames(&[99, 101, 101, 101], pixels_per_frame);
        let palette = gray_palette(&[96, 104]);
        let region_map = regions(vec![0, 0], vec![0, 0]);
        let policy = TemporalHysteresisPolicy {
            max_hold_frames: 3,
            max_hold_duration_cs: 10,
        };
        let temporal = quantize_rgb24_with_region_temporal_hysteresis_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &region_map,
            &[1, 5, 5, 5],
            policy,
        )
        .unwrap();
        let same_indices_different_timing =
            quantize_rgb24_with_region_temporal_hysteresis_with_delays(
                &pixels,
                width,
                height,
                &palette,
                &region_map,
                &[1, 4, 6, 5],
                policy,
            )
            .unwrap();
        let first_indices = (0..4)
            .map(|frame| temporal.indices[frame * pixels_per_frame])
            .collect::<Vec<_>>();

        assert_eq!(first_indices[0], first_indices[1]);
        assert_eq!(first_indices[1], first_indices[2]);
        assert_ne!(first_indices[2], first_indices[3]);
        assert_eq!(
            temporal.report.temporal_hold_count,
            u64::try_from(pixels_per_frame * 2).unwrap()
        );
        assert_eq!(
            temporal.report.temporal_hold_duration_cs,
            u64::try_from(pixels_per_frame * 10).unwrap()
        );
        assert_eq!(temporal.report.temporal_max_observed_hold_duration_cs, 10);
        assert_eq!(temporal.indices, same_indices_different_timing.indices);
        assert_ne!(
            temporal.report.artifact_sha256,
            same_indices_different_timing.report.artifact_sha256
        );
    }

    #[test]
    fn timing_aware_temporal_residual_weights_long_vfr_frames() {
        let width = 16_u16;
        let height = 16_u16;
        let pixels_per_frame = usize::from(width) * usize::from(height);
        let reference = solid_gray_frames(&[99, 99, 99], pixels_per_frame);
        let candidate = solid_gray_frames(&[96, 104, 104], pixels_per_frame);
        let equal_timing = evaluate_timing_aware_temporal_residual(
            &reference,
            &candidate,
            width,
            height,
            &[1, 1, 1],
            false,
        )
        .unwrap();
        let vfr = evaluate_timing_aware_temporal_residual(
            &reference,
            &candidate,
            width,
            height,
            &[1, 100, 1],
            false,
        )
        .unwrap();

        assert!(
            vfr.weighted_static_temporal_residual
                > equal_timing.weighted_static_temporal_residual * 1.9
        );
        assert!(
            vfr.weighted_multiscale_static_temporal_residual
                > equal_timing.weighted_multiscale_static_temporal_residual * 1.9
        );
        assert_eq!(
            vfr.weighted_static_sample_duration_cs,
            u64::try_from(pixels_per_frame * 101).unwrap()
        );
        assert_eq!(vfr.loop_seam_static_temporal_residual, None);
    }

    #[test]
    fn timing_aware_temporal_residual_reports_infinite_loop_seam() {
        let width = 16_u16;
        let height = 16_u16;
        let pixels_per_frame = usize::from(width) * usize::from(height);
        let reference = solid_gray_frames(&[99, 200, 100], pixels_per_frame);
        let candidate = solid_gray_frames(&[96, 192, 104], pixels_per_frame);
        let one_shot = evaluate_timing_aware_temporal_residual(
            &reference,
            &candidate,
            width,
            height,
            &[5, 5, 5],
            false,
        )
        .unwrap();
        let looping = evaluate_timing_aware_temporal_residual(
            &reference,
            &candidate,
            width,
            height,
            &[5, 5, 5],
            true,
        )
        .unwrap();

        assert_eq!(one_shot.sampled_static_transition_count, 0);
        assert_eq!(one_shot.weighted_static_temporal_residual, 0.0);
        assert_eq!(one_shot.loop_seam_static_temporal_residual, None);
        assert_eq!(
            looping.loop_seam_sampled_static_pixel_count,
            u64::try_from(pixels_per_frame).unwrap()
        );
        assert!(looping.loop_seam_static_temporal_residual.unwrap() > 0.0);
        assert!(
            looping
                .loop_seam_multiscale_static_temporal_residual
                .unwrap()
                > 0.0
        );
        assert!(looping.weighted_static_temporal_residual > 0.0);
    }

    #[test]
    fn identical_rgb24_candidate_has_zero_error() {
        let pixels = [17_u8, 90, 201].repeat(16 * 16 * 2);
        assert_eq!(
            evaluate_rgb24_candidate(&pixels, &pixels, 16, 16).unwrap(),
            QuantizationMetrics {
                sampled_pixel_count: 512,
                sampled_static_pixel_count: 256,
                mean_oklab_error: 0.0,
                p95_oklab_error: 0.0,
                edge_weighted_mean_oklab_error: 0.0,
                multiscale_low_frequency_oklab_error: 0.0,
                multiscale_banding_score: 0.0,
                edge_gradient_error: 0.0,
                static_temporal_residual: 0.0,
                multiscale_static_temporal_residual: 0.0,
            }
        );
    }

    #[test]
    fn banding_proxy_detects_adjacent_luma_plateaus_and_is_deterministic() {
        let width = 320_usize;
        let height = 180_usize;
        let banded = (0..height)
            .flat_map(|_| (0..width).map(|x| 72_u8 + (x / 32) as u8))
            .collect::<Vec<_>>();
        let flat = vec![96_u8; width * height];
        let first = banding_frame_score(&banded, width, height);
        let second = banding_frame_score(&banded, width, height);

        assert_eq!(first, second);
        assert!(first > banding_frame_score(&flat, width, height) + 0.0005);
        assert_eq!(limited_range_luma([0, 0, 0]), 16);
        assert_eq!(limited_range_luma([255, 255, 255]), 235);
    }

    #[test]
    fn banding_proxy_applies_bt1886_visibility_thresholds() {
        let width = 320_usize;
        let height = 180_usize;
        let dark_bands = (0..height)
            .flat_map(|_| (0..width).map(|x| 68_u8 + (x / 32) as u8))
            .collect::<Vec<_>>();
        let light_bands = (0..height)
            .flat_map(|_| (0..width).map(|x| 200_u8 + (x / 32) as u8))
            .collect::<Vec<_>>();

        assert!(
            banding_frame_score(&dark_bands, width, height)
                > banding_frame_score(&light_bands, width, height) + 0.0005
        );
    }

    #[test]
    fn lookup_bucket_refines_the_nearest_color_for_the_actual_rgb() {
        let palette = vec![srgb8_to_oklab([0, 0, 0]), srgb8_to_oklab([7, 7, 7])];
        let lookup = build_choice_lookup(&palette);
        let bucket = lookup[histogram_index(0, 0, 0)];

        assert_eq!(palette_choice([0, 0, 0], bucket, &palette).nearest, 0);
        assert_eq!(palette_choice([7, 7, 7], bucket, &palette).nearest, 1);
    }

    #[test]
    fn error_diffusion_adjusted_lab_searches_the_full_palette_deterministically() {
        let values = [
            0_u8, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255,
        ];
        let palette = values
            .iter()
            .copied()
            .map(|value| srgb8_to_oklab([value, value, value]))
            .collect::<Vec<_>>();
        let original_bucket = build_choice_lookup(&palette)[histogram_index(0, 0, 0)];
        let adjusted_target = u8::try_from(values.len() - 1).unwrap();

        assert!(!palette_bucket_contains(original_bucket, adjusted_target));
        let selected =
            nearest_palette_index_for_lab(palette[usize::from(adjusted_target)], &palette);
        assert_eq!(selected, adjusted_target);
        for _ in 0..8 {
            assert_eq!(
                nearest_palette_index_for_lab(palette[usize::from(adjusted_target)], &palette),
                selected
            );
        }
    }

    #[test]
    fn error_diffusion_max_palette_selects_opaque_254_and_never_transparent_255() {
        let mut rgba = Vec::with_capacity(256 * 4);
        for value in 0_u8..=254 {
            rgba.extend_from_slice(&[value, value, value, 255]);
        }
        rgba.extend_from_slice(&[0, 0, 0, 0]);
        let palette = OklabPaletteArtifact {
            sha256: format!("{:x}", Sha256::digest(&rgba)),
            rgba,
            emitted_colors: 256,
            sampled_frame_count: 1,
            sampled_pixel_count: 1,
            weighted_sample_mass: 1.0,
            weighted_histogram_mean_oklab_error: 0.0,
            weighted_histogram_p95_oklab_error: 0.0,
        };
        let opaque_rgb = opaque_palette_rgb(&palette).unwrap();
        let palette_labs = opaque_rgb
            .iter()
            .copied()
            .map(srgb8_to_oklab)
            .collect::<Vec<_>>();

        assert_eq!(opaque_rgb.len(), 255);
        assert_eq!(
            nearest_palette_index_for_lab(srgb8_to_oklab([254, 254, 254]), &palette_labs),
            254
        );

        let width = 16_u16;
        let height = 16_u16;
        let pixels = [254_u8, 254, 254].repeat(usize::from(width) * usize::from(height));
        let artifact = quantize_rgb24_with_region_error_diffusion_temporal_with_delays(
            &pixels,
            width,
            height,
            &palette,
            &regions(vec![0, 0], vec![0, 0]),
            &[4],
            TemporalHysteresisPolicy::CONSERVATIVE_V1,
        )
        .unwrap();

        assert!(artifact.indices.iter().all(|index| *index == 254));
        assert!(!artifact.indices.contains(&255));
        assert!(artifact
            .reconstructed_rgb24
            .chunks_exact(3)
            .all(|rgb| rgb == [254, 254, 254]));
    }

    #[test]
    fn static_temporal_metric_measures_residual_instead_of_rewarding_freeze() {
        let pixels_per_frame = 16 * 16;
        let mut reference = [100_u8, 100, 100].repeat(pixels_per_frame);
        reference.extend_from_slice(&[104_u8, 104, 104].repeat(pixels_per_frame));
        let frozen = [100_u8, 100, 100].repeat(pixels_per_frame * 2);

        let exact = evaluate_rgb24_candidate(&reference, &reference, 16, 16).unwrap();
        let frozen = evaluate_rgb24_candidate(&reference, &frozen, 16, 16).unwrap();
        assert_eq!(exact.static_temporal_residual, 0.0);
        assert!(frozen.static_temporal_residual > 0.0, "{frozen:?}");
        assert_eq!(exact.multiscale_static_temporal_residual, 0.0);
        assert!(
            frozen.multiscale_static_temporal_residual > 0.0,
            "{frozen:?}"
        );
    }

    #[test]
    fn multiscale_metrics_separate_low_frequency_color_shift_from_edge_damage() {
        let width = 16_u16;
        let height = 16_u16;
        let mut reference = Vec::with_capacity(16 * 16 * 3);
        for y in 0..16 {
            for x in 0..16 {
                let value = if x < 8 { 40_u8 } else { 210_u8 };
                reference.extend_from_slice(&[value, value, value.saturating_add(y)]);
            }
        }
        let low_frequency_shift = reference
            .chunks_exact(3)
            .flat_map(|pixel| [pixel[0].saturating_add(12), pixel[1], pixel[2]])
            .collect::<Vec<_>>();
        let mut edge_damage = reference.clone();
        for y in 0..16_usize {
            for x in 0..16_usize {
                let byte = (y * 16 + x) * 3;
                for channel in &mut edge_damage[byte..byte + 3] {
                    *channel = if (x + y) % 2 == 0 {
                        channel.saturating_add(20)
                    } else {
                        channel.saturating_sub(20)
                    };
                }
            }
        }

        let shifted =
            evaluate_rgb24_candidate(&reference, &low_frequency_shift, width, height).unwrap();
        let damaged = evaluate_rgb24_candidate(&reference, &edge_damage, width, height).unwrap();
        assert!(
            shifted.multiscale_low_frequency_oklab_error
                > damaged.multiscale_low_frequency_oklab_error,
            "shifted={shifted:?} damaged={damaged:?}"
        );
        assert!(
            damaged.edge_gradient_error > shifted.edge_gradient_error,
            "shifted={shifted:?} damaged={damaged:?}"
        );
    }

    #[test]
    fn invalid_region_class_and_candidate_size_are_rejected() {
        let pixels = [0_u8, 0, 0].repeat(16 * 16);
        assert_eq!(
            quantize_rgb24_with_region(
                &pixels,
                16,
                16,
                &black_white_palette(),
                &regions(vec![0, 9], vec![0, 255]),
            ),
            Err(RegionalQuantizationError::InvalidRegionClass { index: 1, value: 9 })
        );
        assert_eq!(
            evaluate_rgb24_candidate(&pixels, &pixels[..pixels.len() - 3], 16, 16),
            Err(RegionalQuantizationError::InvalidCandidateSize {
                expected: pixels.len(),
                actual: pixels.len() - 3,
            })
        );
    }
}
