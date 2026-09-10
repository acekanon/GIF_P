//! Deterministic, perceptually weighted global palette construction.
//!
//! Decoding and frame selection remain orchestration concerns. Callers provide
//! complete, fixed-size RGB24 frames after all spatial transforms, together
//! with a positive weight that can combine hold duration and perceptual
//! importance. Colors are accumulated in a 5-bit-per-channel histogram before
//! deterministic weighted k-means in OKLab.

use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

const PALETTE_ENTRIES: usize = 256;
const RGBA_CHANNELS: usize = 4;
const TRANSPARENT_INDEX: usize = 255;
const MAX_KMEANS_ITERATIONS: usize = 24;
const CONVERGENCE_EPSILON_SQUARED: f64 = 1.0e-14;
const MAX_SEGMENT_PALETTES: usize = 4;
const MAX_SHARED_ANCHORS: usize = 8;
const SHARED_ANCHOR_MAX_OKLAB_DISTANCE: f64 = 0.05;
const SHARED_ANCHOR_MIN_SEPARATION: f64 = 0.025;

/// RGB histogram precision used before deterministic OKLab clustering.
///
/// The standard 5-bit path is the compatibility baseline. The 6-bit path is
/// intentionally opt-in because it uses eight times as many histogram bins
/// and is reserved for experimentally detected smooth-gradient material.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PaletteHistogramPrecision {
    #[default]
    Standard5Bit,
    Fine6Bit,
}

impl PaletteHistogramPrecision {
    pub const fn bits(self) -> u8 {
        match self {
            Self::Standard5Bit => 5,
            Self::Fine6Bit => 6,
        }
    }

    const fn bin_count(self) -> usize {
        1_usize << (self.bits() * 3)
    }
}

/// Caller-controlled constraints for a palette fit.
///
/// The default preserves the legacy GIF path: index 255 is reserved as a
/// transparent entry and no opaque colors are pinned. `protected_rgb` is
/// canonicalized (lexicographically sorted and deduplicated) before fitting;
/// every surviving value is emitted as an exact, fixed opaque palette center.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaletteBuildOptions {
    /// Keep index 255 transparent, leaving at most 255 opaque colors.
    pub reserve_transparent: bool,
    /// Exact opaque RGB entries which must survive palette fitting.
    pub protected_rgb: Vec<[u8; 3]>,
}

impl Default for PaletteBuildOptions {
    fn default() -> Self {
        Self {
            reserve_transparent: true,
            protected_rgb: Vec::new(),
        }
    }
}

#[derive(Clone, Copy)]
struct PaletteSliceBuildOptions<'a> {
    protected_rgb: &'a [[u8; 3]],
    anchors: &'a [[u8; 3]],
    reserve_transparent: bool,
    histogram_precision: PaletteHistogramPrecision,
}

/// One complete RGB24 frame and its contribution to palette fitting.
///
/// `weight` must be finite and strictly positive. A caller can use source hold
/// duration directly, or multiply duration by an importance factor. Keeping
/// that policy outside this module makes the resulting artifact reproducible
/// from an auditable set of sampled frames.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq)]
struct WeightedRgb24Frame {
    pub pixels: Vec<u8>,
    pub weight: f64,
}

/// Canonical 256-entry global palette and its fit report.
#[derive(Clone, Debug, PartialEq)]
pub struct OklabPaletteArtifact {
    /// A row-major 16x16 RGBA palette image (exactly 1024 bytes).
    ///
    /// When transparency is reserved, index 255 is the only transparent entry.
    /// Otherwise all 256 entries are opaque. Every unused opaque slot repeats
    /// the final emitted opaque color so the byte representation is
    /// deterministic without introducing another semantic color.
    pub rgba: Vec<u8>,
    /// Number of semantically emitted entries. This includes the transparent
    /// slot only when the build reserved one, and can be below
    /// `requested_colors` when the input has fewer colors or rounded cluster
    /// centers collapse to the same RGB triplet.
    pub emitted_colors: u16,
    pub sampled_frame_count: u32,
    pub sampled_pixel_count: u64,
    /// Sum of per-pixel frame weights after hold-duration/importance weighting.
    pub weighted_sample_mass: f64,
    /// Weighted error of the 5-bit histogram representatives, not a
    /// pixel-by-pixel reconstruction metric.
    pub weighted_histogram_mean_oklab_error: f64,
    /// Weighted P95 error of the 5-bit histogram representatives.
    pub weighted_histogram_p95_oklab_error: f64,
    /// Lowercase SHA-256 of `rgba`.
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PaletteFrameRange {
    pub start: usize,
    pub end_exclusive: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OklabSegmentPaletteArtifact {
    pub start_frame: u32,
    pub end_frame_exclusive: u32,
    pub palette: OklabPaletteArtifact,
}

/// Experimental palette sequence planned from the same transformed frames as
/// the selected global palette. Callers must keep it out of the encoder until
/// a quality/size gate explicitly promotes it.
#[derive(Clone, Debug, PartialEq)]
pub struct OklabPaletteSequenceArtifact {
    pub segments: Vec<OklabSegmentPaletteArtifact>,
    pub shared_anchors_rgb: Vec<[u8; 3]>,
    pub shared_anchor_sha256: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PaletteError {
    EmptyInput,
    ZeroDimensions,
    DimensionOverflow,
    InvalidRequestedColors(u16),
    TooManyProtectedColors {
        protected: usize,
        opaque_capacity: usize,
    },
    InvalidFrameSize {
        index: usize,
        expected: usize,
        actual: usize,
    },
    InvalidFrameBufferSize {
        expected: usize,
        actual: usize,
    },
    InvalidWeight {
        index: usize,
        weight: f64,
    },
    TooManyPaletteSegments(usize),
    InvalidPaletteSegmentRange {
        index: usize,
        start: usize,
        end_exclusive: usize,
        expected_start: usize,
        frame_count: usize,
    },
    SampleCountOverflow,
    WeightOverflow,
}

impl fmt::Display for PaletteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyInput => formatter.write_str("at least one weighted RGB24 frame is required"),
            Self::ZeroDimensions => formatter.write_str("frame dimensions must be non-zero"),
            Self::DimensionOverflow => {
                formatter.write_str("RGB24 frame dimensions overflow usize")
            }
            Self::InvalidRequestedColors(colors) => write!(
                formatter,
                "requested palette color count {colors} is outside 3..=256"
            ),
            Self::TooManyProtectedColors {
                protected,
                opaque_capacity,
            } => write!(
                formatter,
                "requested {protected} protected palette colors but only {opaque_capacity} opaque slots are available"
            ),
            Self::InvalidFrameSize {
                index,
                expected,
                actual,
            } => write!(
                formatter,
                "frame {index} has {actual} RGB24 bytes; expected {expected}"
            ),
            Self::InvalidFrameBufferSize { expected, actual } => write!(
                formatter,
                "contiguous RGB24 frame buffer has {actual} bytes; expected {expected}"
            ),
            Self::InvalidWeight { index, weight } => write!(
                formatter,
                "frame {index} has invalid palette weight {weight}; expected a finite positive value"
            ),
            Self::TooManyPaletteSegments(count) => write!(
                formatter,
                "palette sequence has {count} segments; expected at most {MAX_SEGMENT_PALETTES}"
            ),
            Self::InvalidPaletteSegmentRange {
                index,
                start,
                end_exclusive,
                expected_start,
                frame_count,
            } => write!(
                formatter,
                "palette segment {index} range {start}..{end_exclusive} is invalid; expected contiguous start {expected_start} within {frame_count} frames"
            ),
            Self::SampleCountOverflow => formatter.write_str("sampled pixel count overflowed u64"),
            Self::WeightOverflow => {
                formatter.write_str("accumulated palette weight is not finite")
            }
        }
    }
}

impl Error for PaletteError {}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct HistogramBin {
    weight: f64,
    red_sum: f64,
    green_sum: f64,
    blue_sum: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Oklab {
    pub(crate) l: f64,
    pub(crate) a: f64,
    pub(crate) b: f64,
}

impl Oklab {
    pub(crate) fn distance_squared(self, other: Self) -> f64 {
        let dl = self.l - other.l;
        let da = self.a - other.a;
        let db = self.b - other.b;
        dl.mul_add(dl, da.mul_add(da, db * db))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WeightedColor {
    histogram_index: usize,
    weight: f64,
    lab: Oklab,
}

/// Builds a deterministic perceptual global palette.
///
/// `requested_colors` is the total active palette capacity and must be in
/// `3..=256`; one entry is always reserved for transparency. The returned RGBA
/// image is always the GIF-compatible canonical 16x16 layout, independent of
/// the requested capacity.
#[cfg(test)]
fn build_oklab_palette(
    frames: &[WeightedRgb24Frame],
    width: u32,
    height: u32,
    requested_colors: u16,
) -> Result<OklabPaletteArtifact, PaletteError> {
    build_oklab_palette_from_slices(
        frames
            .iter()
            .map(|frame| (frame.pixels.as_slice(), frame.weight)),
        frames.len(),
        width,
        height,
        requested_colors,
    )
}

/// Builds a palette directly from a contiguous sequence of fixed-size RGB24
/// frames without cloning each frame into a separate allocation.
#[cfg(test)]
pub fn build_oklab_palette_from_contiguous_rgb24(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    requested_colors: u16,
) -> Result<OklabPaletteArtifact, PaletteError> {
    build_oklab_palette_from_contiguous_rgb24_with_precision(
        pixels,
        frame_weights,
        width,
        height,
        requested_colors,
        PaletteHistogramPrecision::Standard5Bit,
    )
}

/// Builds a palette with an explicitly selected RGB histogram precision.
#[allow(dead_code)] // Retained as the compatibility wrapper for the options API.
pub fn build_oklab_palette_from_contiguous_rgb24_with_precision(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    requested_colors: u16,
    histogram_precision: PaletteHistogramPrecision,
) -> Result<OklabPaletteArtifact, PaletteError> {
    let options = PaletteBuildOptions::default();
    build_oklab_palette_from_contiguous_rgb24_with_precision_and_options(
        pixels,
        frame_weights,
        width,
        height,
        requested_colors,
        histogram_precision,
        &options,
    )
}

/// Builds a palette with caller-controlled transparency and protected colors.
///
/// This convenience entry point uses the compatibility-standard 5-bit RGB
/// histogram. `requested_colors` remains the total active capacity: when
/// `options.reserve_transparent` is false, a request for 256 makes all 256
/// palette slots opaque and available to the fit.
#[allow(dead_code)] // Exposed through core for command-layer integration.
pub fn build_oklab_palette_from_contiguous_rgb24_with_options(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    requested_colors: u16,
    options: &PaletteBuildOptions,
) -> Result<OklabPaletteArtifact, PaletteError> {
    build_oklab_palette_from_contiguous_rgb24_with_precision_and_options(
        pixels,
        frame_weights,
        width,
        height,
        requested_colors,
        PaletteHistogramPrecision::Standard5Bit,
        options,
    )
}

/// Builds a palette with an explicitly selected histogram precision and
/// caller-controlled transparency/protected colors.
pub fn build_oklab_palette_from_contiguous_rgb24_with_precision_and_options(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    requested_colors: u16,
    histogram_precision: PaletteHistogramPrecision,
    options: &PaletteBuildOptions,
) -> Result<OklabPaletteArtifact, PaletteError> {
    if frame_weights.is_empty() {
        return Err(PaletteError::EmptyInput);
    }
    if !(3..=256).contains(&requested_colors) {
        return Err(PaletteError::InvalidRequestedColors(requested_colors));
    }
    let protected_rgb = canonical_protected_rgb(
        &options.protected_rgb,
        opaque_capacity(requested_colors, options.reserve_transparent),
    )?;
    let expected_bytes = expected_frame_bytes(width, height)?;
    let expected_total = expected_bytes
        .checked_mul(frame_weights.len())
        .ok_or(PaletteError::DimensionOverflow)?;
    if pixels.len() != expected_total {
        return Err(PaletteError::InvalidFrameBufferSize {
            expected: expected_total,
            actual: pixels.len(),
        });
    }
    build_oklab_palette_from_slices_with_precision_and_options(
        pixels
            .chunks_exact(expected_bytes)
            .zip(frame_weights.iter().copied()),
        frame_weights.len(),
        width,
        height,
        requested_colors,
        PaletteSliceBuildOptions {
            protected_rgb: &protected_rgb,
            anchors: &[],
            reserve_transparent: options.reserve_transparent,
            histogram_precision,
        },
    )
}

/// Builds deterministic, shared-anchor segment palette candidates without
/// changing the already-selected global palette.
#[cfg(test)]
pub fn build_oklab_segment_palette_sequence_from_contiguous_rgb24(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    requested_colors: u16,
    global_palette: &OklabPaletteArtifact,
    ranges: &[PaletteFrameRange],
) -> Result<OklabPaletteSequenceArtifact, PaletteError> {
    build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_precision(
        pixels,
        frame_weights,
        width,
        height,
        requested_colors,
        global_palette,
        ranges,
        PaletteHistogramPrecision::Standard5Bit,
    )
}

/// Builds a segment-palette sequence using the same explicit histogram
/// precision as its global palette.
#[allow(dead_code)] // Retained as the compatibility wrapper for the options API.
#[allow(clippy::too_many_arguments)]
pub fn build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_precision(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    requested_colors: u16,
    global_palette: &OklabPaletteArtifact,
    ranges: &[PaletteFrameRange],
    histogram_precision: PaletteHistogramPrecision,
) -> Result<OklabPaletteSequenceArtifact, PaletteError> {
    let options = PaletteBuildOptions::default();
    build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_precision_and_options(
        pixels,
        frame_weights,
        width,
        height,
        requested_colors,
        global_palette,
        ranges,
        histogram_precision,
        &options,
    )
}

/// Builds a segment-palette sequence with caller-controlled transparency and
/// protected colors, using the compatibility-standard 5-bit histogram.
#[allow(clippy::too_many_arguments)]
#[allow(dead_code)] // Exposed through core for command-layer integration.
pub fn build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_options(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    requested_colors: u16,
    global_palette: &OklabPaletteArtifact,
    ranges: &[PaletteFrameRange],
    options: &PaletteBuildOptions,
) -> Result<OklabPaletteSequenceArtifact, PaletteError> {
    build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_precision_and_options(
        pixels,
        frame_weights,
        width,
        height,
        requested_colors,
        global_palette,
        ranges,
        PaletteHistogramPrecision::Standard5Bit,
        options,
    )
}

/// Builds a segment-palette sequence with an explicitly selected histogram
/// precision and caller-controlled transparency/protected colors.
#[allow(clippy::too_many_arguments)]
pub fn build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_precision_and_options(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    requested_colors: u16,
    global_palette: &OklabPaletteArtifact,
    ranges: &[PaletteFrameRange],
    histogram_precision: PaletteHistogramPrecision,
    options: &PaletteBuildOptions,
) -> Result<OklabPaletteSequenceArtifact, PaletteError> {
    if frame_weights.is_empty() {
        return Err(PaletteError::EmptyInput);
    }
    if !(3..=256).contains(&requested_colors) {
        return Err(PaletteError::InvalidRequestedColors(requested_colors));
    }
    let protected_rgb = canonical_protected_rgb(
        &options.protected_rgb,
        opaque_capacity(requested_colors, options.reserve_transparent),
    )?;
    if ranges.len() > MAX_SEGMENT_PALETTES {
        return Err(PaletteError::TooManyPaletteSegments(ranges.len()));
    }
    let frame_bytes = expected_frame_bytes(width, height)?;
    let expected_total = frame_bytes
        .checked_mul(frame_weights.len())
        .ok_or(PaletteError::DimensionOverflow)?;
    if pixels.len() != expected_total {
        return Err(PaletteError::InvalidFrameBufferSize {
            expected: expected_total,
            actual: pixels.len(),
        });
    }
    validate_palette_ranges(ranges, frame_weights.len())?;

    let mut provisional = Vec::with_capacity(ranges.len());
    for range in ranges {
        provisional.push(build_segment_palette(
            pixels,
            frame_weights,
            frame_bytes,
            width,
            height,
            requested_colors,
            *range,
            &protected_rgb,
            &[],
            options.reserve_transparent,
            histogram_precision,
        )?);
    }
    let anchors = select_shared_anchors(
        global_palette,
        &provisional,
        opaque_capacity(requested_colors, options.reserve_transparent),
        &protected_rgb,
    );
    let mut segments = Vec::with_capacity(ranges.len());
    for (range, provisional_palette) in ranges.iter().copied().zip(provisional) {
        let palette = if anchors.is_empty() {
            provisional_palette
        } else {
            build_segment_palette(
                pixels,
                frame_weights,
                frame_bytes,
                width,
                height,
                requested_colors,
                range,
                &protected_rgb,
                &anchors,
                options.reserve_transparent,
                histogram_precision,
            )?
        };
        segments.push(OklabSegmentPaletteArtifact {
            start_frame: u32::try_from(range.start)
                .map_err(|_| PaletteError::SampleCountOverflow)?,
            end_frame_exclusive: u32::try_from(range.end_exclusive)
                .map_err(|_| PaletteError::SampleCountOverflow)?,
            palette,
        });
    }

    let shared_anchor_sha256 = digest_rgb_triplets(&anchors);
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.oklab-palette-sequence.v1\0");
    hasher.update(global_palette.sha256.as_bytes());
    hasher.update(shared_anchor_sha256.as_bytes());
    for segment in &segments {
        hasher.update(segment.start_frame.to_le_bytes());
        hasher.update(segment.end_frame_exclusive.to_le_bytes());
        hasher.update(segment.palette.sha256.as_bytes());
    }
    let sha256 = format!("{:x}", hasher.finalize());
    Ok(OklabPaletteSequenceArtifact {
        segments,
        shared_anchors_rgb: anchors,
        shared_anchor_sha256,
        sha256,
    })
}

fn validate_palette_ranges(
    ranges: &[PaletteFrameRange],
    frame_count: usize,
) -> Result<(), PaletteError> {
    let mut expected_start = 0;
    for (index, range) in ranges.iter().enumerate() {
        if range.start != expected_start
            || range.start >= range.end_exclusive
            || range.end_exclusive > frame_count
        {
            return Err(PaletteError::InvalidPaletteSegmentRange {
                index,
                start: range.start,
                end_exclusive: range.end_exclusive,
                expected_start,
                frame_count,
            });
        }
        expected_start = range.end_exclusive;
    }
    if ranges.is_empty() || expected_start != frame_count {
        return Err(PaletteError::InvalidPaletteSegmentRange {
            index: ranges.len(),
            start: expected_start,
            end_exclusive: expected_start,
            expected_start,
            frame_count,
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_segment_palette(
    pixels: &[u8],
    frame_weights: &[f64],
    frame_bytes: usize,
    width: u32,
    height: u32,
    requested_colors: u16,
    range: PaletteFrameRange,
    protected_rgb: &[[u8; 3]],
    anchors: &[[u8; 3]],
    reserve_transparent: bool,
    histogram_precision: PaletteHistogramPrecision,
) -> Result<OklabPaletteArtifact, PaletteError> {
    let byte_start = range
        .start
        .checked_mul(frame_bytes)
        .ok_or(PaletteError::DimensionOverflow)?;
    let byte_end = range
        .end_exclusive
        .checked_mul(frame_bytes)
        .ok_or(PaletteError::DimensionOverflow)?;
    build_oklab_palette_from_slices_with_anchors_and_options(
        pixels[byte_start..byte_end].chunks_exact(frame_bytes).zip(
            frame_weights[range.start..range.end_exclusive]
                .iter()
                .copied(),
        ),
        range.end_exclusive - range.start,
        width,
        height,
        requested_colors,
        PaletteSliceBuildOptions {
            protected_rgb,
            anchors,
            reserve_transparent,
            histogram_precision,
        },
    )
}

fn select_shared_anchors(
    global_palette: &OklabPaletteArtifact,
    segment_palettes: &[OklabPaletteArtifact],
    opaque_capacity: usize,
    protected_rgb: &[[u8; 3]],
) -> Vec<[u8; 3]> {
    if segment_palettes.len() < 2 {
        return Vec::new();
    }
    let anchor_limit =
        MAX_SHARED_ANCHORS.min(opaque_capacity.saturating_sub(protected_rgb.len()) / 12);
    if anchor_limit == 0 {
        return Vec::new();
    }
    let segment_colors = segment_palettes
        .iter()
        .map(opaque_palette_colors)
        .collect::<Vec<_>>();
    let mut candidates = opaque_palette_colors(global_palette)
        .into_iter()
        .filter(|rgb| protected_rgb.binary_search(rgb).is_err())
        .filter_map(|rgb| {
            let distances = segment_colors
                .iter()
                .map(|colors| {
                    colors
                        .iter()
                        .map(|candidate| oklab_distance_srgb8(rgb, *candidate))
                        .min_by(f64::total_cmp)
                        .unwrap_or(f64::INFINITY)
                })
                .collect::<Vec<_>>();
            let max_distance = distances.iter().copied().fold(0.0_f64, f64::max);
            (max_distance <= SHARED_ANCHOR_MAX_OKLAB_DISTANCE)
                .then(|| (rgb, max_distance, distances.iter().copied().sum::<f64>()))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.2.total_cmp(&right.2))
            .then_with(|| left.0.cmp(&right.0))
    });

    let mut anchors = Vec::with_capacity(anchor_limit);
    for (rgb, _, _) in candidates {
        if anchors
            .iter()
            .all(|anchor| oklab_distance_srgb8(rgb, *anchor) >= SHARED_ANCHOR_MIN_SEPARATION)
        {
            anchors.push(rgb);
            if anchors.len() == anchor_limit {
                break;
            }
        }
    }
    anchors.sort_unstable();
    anchors
}

fn opaque_capacity(requested_colors: u16, reserve_transparent: bool) -> usize {
    usize::from(requested_colors) - if reserve_transparent { 1 } else { 0 }
}

fn canonical_protected_rgb(
    protected_rgb: &[[u8; 3]],
    opaque_capacity: usize,
) -> Result<Vec<[u8; 3]>, PaletteError> {
    let mut canonical = protected_rgb.to_vec();
    canonical.sort_unstable();
    canonical.dedup();
    if canonical.len() > opaque_capacity {
        return Err(PaletteError::TooManyProtectedColors {
            protected: canonical.len(),
            opaque_capacity,
        });
    }
    Ok(canonical)
}

fn merge_fixed_centers(
    protected_rgb: &[[u8; 3]],
    anchors: &[[u8; 3]],
    opaque_capacity: usize,
) -> Vec<[u8; 3]> {
    let mut fixed = protected_rgb.to_vec();
    let mut dynamic_anchors = anchors.to_vec();
    dynamic_anchors.sort_unstable();
    dynamic_anchors.dedup();
    for anchor in dynamic_anchors {
        if fixed.len() == opaque_capacity {
            break;
        }
        if !fixed.contains(&anchor) {
            fixed.push(anchor);
        }
    }
    fixed.sort_unstable();
    fixed
}

fn palette_reserves_transparency(artifact: &OklabPaletteArtifact) -> bool {
    artifact
        .rgba
        .get(TRANSPARENT_INDEX * RGBA_CHANNELS + 3)
        .copied()
        == Some(0)
}

fn opaque_palette_colors(artifact: &OklabPaletteArtifact) -> Vec<[u8; 3]> {
    let transparent_entries = if palette_reserves_transparency(artifact) {
        1
    } else {
        0
    };
    let opaque_count = usize::from(artifact.emitted_colors)
        .saturating_sub(transparent_entries)
        .min(PALETTE_ENTRIES - transparent_entries);
    artifact.rgba[..opaque_count.saturating_mul(4)]
        .chunks_exact(4)
        .map(|rgba| [rgba[0], rgba[1], rgba[2]])
        .collect()
}

fn digest_rgb_triplets(colors: &[[u8; 3]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.oklab-shared-anchors.v1\0");
    hasher.update((colors.len() as u64).to_le_bytes());
    for color in colors {
        hasher.update(color);
    }
    format!("{:x}", hasher.finalize())
}

fn expected_frame_bytes(width: u32, height: u32) -> Result<usize, PaletteError> {
    if width == 0 || height == 0 {
        return Err(PaletteError::ZeroDimensions);
    }
    let pixels_per_frame = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(PaletteError::DimensionOverflow)?;
    let expected_bytes_u64 = pixels_per_frame
        .checked_mul(3)
        .ok_or(PaletteError::DimensionOverflow)?;
    usize::try_from(expected_bytes_u64).map_err(|_| PaletteError::DimensionOverflow)
}

#[cfg(test)]
fn build_oklab_palette_from_slices<'a, I>(
    frames: I,
    frame_count: usize,
    width: u32,
    height: u32,
    requested_colors: u16,
) -> Result<OklabPaletteArtifact, PaletteError>
where
    I: IntoIterator<Item = (&'a [u8], f64)>,
{
    build_oklab_palette_from_slices_with_precision(
        frames,
        frame_count,
        width,
        height,
        requested_colors,
        PaletteHistogramPrecision::Standard5Bit,
    )
}

#[cfg(test)]
fn build_oklab_palette_from_slices_with_precision<'a, I>(
    frames: I,
    frame_count: usize,
    width: u32,
    height: u32,
    requested_colors: u16,
    histogram_precision: PaletteHistogramPrecision,
) -> Result<OklabPaletteArtifact, PaletteError>
where
    I: IntoIterator<Item = (&'a [u8], f64)>,
{
    build_oklab_palette_from_slices_with_precision_and_options(
        frames,
        frame_count,
        width,
        height,
        requested_colors,
        PaletteSliceBuildOptions {
            protected_rgb: &[],
            anchors: &[],
            reserve_transparent: true,
            histogram_precision,
        },
    )
}

fn build_oklab_palette_from_slices_with_precision_and_options<'a, I>(
    frames: I,
    frame_count: usize,
    width: u32,
    height: u32,
    requested_colors: u16,
    options: PaletteSliceBuildOptions<'_>,
) -> Result<OklabPaletteArtifact, PaletteError>
where
    I: IntoIterator<Item = (&'a [u8], f64)>,
{
    build_oklab_palette_from_slices_with_anchors_and_options(
        frames,
        frame_count,
        width,
        height,
        requested_colors,
        options,
    )
}

fn build_oklab_palette_from_slices_with_anchors_and_options<'a, I>(
    frames: I,
    frame_count: usize,
    width: u32,
    height: u32,
    requested_colors: u16,
    options: PaletteSliceBuildOptions<'_>,
) -> Result<OklabPaletteArtifact, PaletteError>
where
    I: IntoIterator<Item = (&'a [u8], f64)>,
{
    let PaletteSliceBuildOptions {
        protected_rgb,
        anchors,
        reserve_transparent,
        histogram_precision,
    } = options;
    if frame_count == 0 {
        return Err(PaletteError::EmptyInput);
    }
    if !(3..=256).contains(&requested_colors) {
        return Err(PaletteError::InvalidRequestedColors(requested_colors));
    }

    let expected_bytes = expected_frame_bytes(width, height)?;
    let pixels_per_frame = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(PaletteError::DimensionOverflow)?;
    let sampled_frame_count =
        u32::try_from(frame_count).map_err(|_| PaletteError::SampleCountOverflow)?;
    let frame_count = u64::from(sampled_frame_count);
    let sampled_pixels = pixels_per_frame
        .checked_mul(frame_count)
        .ok_or(PaletteError::SampleCountOverflow)?;

    let mut histogram = vec![HistogramBin::default(); histogram_precision.bin_count()];
    for (frame_index, (pixels, weight)) in frames.into_iter().enumerate() {
        if pixels.len() != expected_bytes {
            return Err(PaletteError::InvalidFrameSize {
                index: frame_index,
                expected: expected_bytes,
                actual: pixels.len(),
            });
        }
        if !weight.is_finite() || weight <= 0.0 {
            return Err(PaletteError::InvalidWeight {
                index: frame_index,
                weight,
            });
        }
        if !(weight * pixels_per_frame as f64).is_finite() {
            return Err(PaletteError::InvalidWeight {
                index: frame_index,
                weight,
            });
        }

        for rgb in pixels.chunks_exact(3) {
            let red = rgb[0];
            let green = rgb[1];
            let blue = rgb[2];
            let bin_index = histogram_index(red, green, blue, histogram_precision);
            let bin = &mut histogram[bin_index];
            bin.weight += weight;
            bin.red_sum += weight * f64::from(red);
            bin.green_sum += weight * f64::from(green);
            bin.blue_sum += weight * f64::from(blue);
            if !bin.weight.is_finite()
                || !bin.red_sum.is_finite()
                || !bin.green_sum.is_finite()
                || !bin.blue_sum.is_finite()
            {
                return Err(PaletteError::WeightOverflow);
            }
        }
    }

    let colors = histogram
        .into_iter()
        .enumerate()
        .filter_map(|(histogram_index, bin)| {
            if bin.weight == 0.0 {
                return None;
            }
            let rgb = [
                bin.red_sum / bin.weight / 255.0,
                bin.green_sum / bin.weight / 255.0,
                bin.blue_sum / bin.weight / 255.0,
            ];
            Some(WeightedColor {
                histogram_index,
                weight: bin.weight,
                lab: srgb_to_oklab(rgb),
            })
        })
        .collect::<Vec<_>>();
    let weighted_sample_mass = colors.iter().map(|color| color.weight).sum::<f64>();
    if !weighted_sample_mass.is_finite() || weighted_sample_mass <= 0.0 {
        return Err(PaletteError::WeightOverflow);
    }

    let opaque_capacity = opaque_capacity(requested_colors, reserve_transparent);
    let protected_rgb = canonical_protected_rgb(protected_rgb, opaque_capacity)?;
    let fixed_centers = merge_fixed_centers(&protected_rgb, anchors, opaque_capacity);
    let centers = if fixed_centers.is_empty() {
        fit_weighted_kmeans(&colors, opaque_capacity)
    } else {
        fit_weighted_kmeans_with_anchors(&colors, opaque_capacity, &fixed_centers)
    };
    let mut opaque_colors = centers
        .into_iter()
        .enumerate()
        .map(|(index, center)| {
            fixed_centers
                .get(index)
                .filter(|rgb| protected_rgb.binary_search(rgb).is_ok())
                .copied()
                .unwrap_or_else(|| oklab_to_srgb8(center))
        })
        .collect::<Vec<_>>();
    opaque_colors.sort_unstable();
    opaque_colors.dedup();

    // The validated non-empty RGB24 input necessarily contributes at least one
    // histogram bin and therefore at least one opaque output color.
    debug_assert!(!opaque_colors.is_empty());

    let mut rgba = vec![0_u8; PALETTE_ENTRIES * RGBA_CHANNELS];
    let fill_color = *opaque_colors.last().expect("non-empty opaque palette");
    let opaque_slot_count = if reserve_transparent {
        TRANSPARENT_INDEX
    } else {
        PALETTE_ENTRIES
    };
    for palette_index in 0..opaque_slot_count {
        let color = opaque_colors
            .get(palette_index)
            .copied()
            .unwrap_or(fill_color);
        let offset = palette_index * RGBA_CHANNELS;
        rgba[offset..offset + 3].copy_from_slice(&color);
        rgba[offset + 3] = u8::MAX;
    }
    if reserve_transparent {
        let transparent_offset = TRANSPARENT_INDEX * RGBA_CHANNELS;
        rgba[transparent_offset..transparent_offset + RGBA_CHANNELS].fill(0);
    }

    let output_labs = opaque_colors
        .iter()
        .map(|rgb| {
            srgb_to_oklab([
                f64::from(rgb[0]) / 255.0,
                f64::from(rgb[1]) / 255.0,
                f64::from(rgb[2]) / 255.0,
            ])
        })
        .collect::<Vec<_>>();
    let (weighted_histogram_mean_oklab_error, weighted_histogram_p95_oklab_error) =
        calculate_histogram_fit_error(&colors, &output_labs)?;

    let digest = Sha256::digest(&rgba);
    let sha256 = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    Ok(OklabPaletteArtifact {
        rgba,
        emitted_colors: u16::try_from(
            opaque_colors.len() + if reserve_transparent { 1 } else { 0 },
        )
        .expect("at most 256 emitted palette entries"),
        sampled_frame_count,
        sampled_pixel_count: sampled_pixels,
        weighted_sample_mass,
        weighted_histogram_mean_oklab_error,
        weighted_histogram_p95_oklab_error,
        sha256,
    })
}

fn histogram_index(red: u8, green: u8, blue: u8, precision: PaletteHistogramPrecision) -> usize {
    let bits = precision.bits();
    let shift = 8 - bits;
    (usize::from(red >> shift) << (bits * 2))
        | (usize::from(green >> shift) << bits)
        | usize::from(blue >> shift)
}

fn fit_weighted_kmeans(colors: &[WeightedColor], capacity: usize) -> Vec<Oklab> {
    let cluster_count = capacity.min(colors.len());
    if cluster_count == colors.len() {
        return colors.iter().map(|color| color.lab).collect();
    }

    let first_index = colors
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.weight
                .total_cmp(&right.weight)
                .then_with(|| right.histogram_index.cmp(&left.histogram_index))
        })
        .map(|(index, _)| index)
        .expect("validated input produces colors");
    let mut centers = vec![colors[first_index].lab];
    let mut selected = vec![false; colors.len()];
    selected[first_index] = true;
    let mut nearest_distances = colors
        .iter()
        .map(|color| color.lab.distance_squared(centers[0]))
        .collect::<Vec<_>>();

    while centers.len() < cluster_count {
        let next_index = colors
            .iter()
            .enumerate()
            .filter(|(index, _)| !selected[*index])
            .max_by(|(left_index, left), (right_index, right)| {
                (left.weight * nearest_distances[*left_index])
                    .total_cmp(&(right.weight * nearest_distances[*right_index]))
                    .then_with(|| right.histogram_index.cmp(&left.histogram_index))
            })
            .map(|(index, _)| index)
            .expect("cluster count does not exceed unique histogram colors");
        let next_center = colors[next_index].lab;
        centers.push(next_center);
        selected[next_index] = true;
        for (color, nearest_distance) in colors.iter().zip(nearest_distances.iter_mut()) {
            *nearest_distance = nearest_distance.min(color.lab.distance_squared(next_center));
        }
    }

    for _ in 0..MAX_KMEANS_ITERATIONS {
        let mut sums = vec![[0.0_f64; 4]; cluster_count];
        for color in colors {
            let cluster_index = nearest_center(color.lab, &centers);
            sums[cluster_index][0] += color.weight * color.lab.l;
            sums[cluster_index][1] += color.weight * color.lab.a;
            sums[cluster_index][2] += color.weight * color.lab.b;
            sums[cluster_index][3] += color.weight;
        }

        let mut movement_squared = 0.0_f64;
        for (cluster_index, sum) in sums.into_iter().enumerate() {
            if sum[3] == 0.0 {
                continue;
            }
            let next = Oklab {
                l: sum[0] / sum[3],
                a: sum[1] / sum[3],
                b: sum[2] / sum[3],
            };
            movement_squared = movement_squared.max(centers[cluster_index].distance_squared(next));
            centers[cluster_index] = next;
        }

        if movement_squared <= CONVERGENCE_EPSILON_SQUARED {
            break;
        }
    }

    centers
}

fn fit_weighted_kmeans_with_anchors(
    colors: &[WeightedColor],
    capacity: usize,
    anchors: &[[u8; 3]],
) -> Vec<Oklab> {
    let mut unique_anchors = anchors.to_vec();
    unique_anchors.sort_unstable();
    unique_anchors.dedup();
    unique_anchors.truncate(capacity);
    if unique_anchors.is_empty() {
        return fit_weighted_kmeans(colors, capacity);
    }

    let mut centers = unique_anchors
        .iter()
        .map(|rgb| {
            srgb_to_oklab([
                f64::from(rgb[0]) / 255.0,
                f64::from(rgb[1]) / 255.0,
                f64::from(rgb[2]) / 255.0,
            ])
        })
        .collect::<Vec<_>>();
    let fixed_center_count = centers.len();
    let cluster_count = capacity.min(colors.len().saturating_add(fixed_center_count));
    if centers.len() >= cluster_count {
        centers.truncate(cluster_count);
        return centers;
    }

    let mut selected = vec![false; colors.len()];
    let mut nearest_distances = colors
        .iter()
        .map(|color| nearest_distance_squared(color.lab, &centers))
        .collect::<Vec<_>>();
    while centers.len() < cluster_count {
        let next_index = colors
            .iter()
            .enumerate()
            .filter(|(index, _)| !selected[*index])
            .max_by(|(left_index, left), (right_index, right)| {
                (left.weight * nearest_distances[*left_index])
                    .total_cmp(&(right.weight * nearest_distances[*right_index]))
                    .then_with(|| right.histogram_index.cmp(&left.histogram_index))
            })
            .map(|(index, _)| index)
            .expect("anchor-aware cluster count does not exceed available centers");
        let next_center = colors[next_index].lab;
        centers.push(next_center);
        selected[next_index] = true;
        for (color, nearest_distance) in colors.iter().zip(nearest_distances.iter_mut()) {
            *nearest_distance = nearest_distance.min(color.lab.distance_squared(next_center));
        }
    }

    for _ in 0..MAX_KMEANS_ITERATIONS {
        let mut sums = vec![[0.0_f64; 4]; cluster_count];
        for color in colors {
            let cluster_index = nearest_center(color.lab, &centers);
            sums[cluster_index][0] += color.weight * color.lab.l;
            sums[cluster_index][1] += color.weight * color.lab.a;
            sums[cluster_index][2] += color.weight * color.lab.b;
            sums[cluster_index][3] += color.weight;
        }

        let mut movement_squared = 0.0_f64;
        for (cluster_index, sum) in sums.into_iter().enumerate().skip(fixed_center_count) {
            if sum[3] == 0.0 {
                continue;
            }
            let next = Oklab {
                l: sum[0] / sum[3],
                a: sum[1] / sum[3],
                b: sum[2] / sum[3],
            };
            movement_squared = movement_squared.max(centers[cluster_index].distance_squared(next));
            centers[cluster_index] = next;
        }
        if movement_squared <= CONVERGENCE_EPSILON_SQUARED {
            break;
        }
    }
    centers
}

fn nearest_center(color: Oklab, centers: &[Oklab]) -> usize {
    let mut best_index = 0;
    let mut best_distance = color.distance_squared(centers[0]);
    for (index, center) in centers.iter().enumerate().skip(1) {
        let distance = color.distance_squared(*center);
        if distance.total_cmp(&best_distance).is_lt() {
            best_index = index;
            best_distance = distance;
        }
    }
    best_index
}

fn nearest_distance_squared(color: Oklab, centers: &[Oklab]) -> f64 {
    color.distance_squared(centers[nearest_center(color, centers)])
}

fn calculate_histogram_fit_error(
    colors: &[WeightedColor],
    output_labs: &[Oklab],
) -> Result<(f64, f64), PaletteError> {
    let mut total_weight = 0.0_f64;
    let mut weighted_error_sum = 0.0_f64;
    let mut errors = Vec::with_capacity(colors.len());
    for color in colors {
        let error = nearest_distance_squared(color.lab, output_labs).sqrt();
        total_weight += color.weight;
        weighted_error_sum += color.weight * error;
        errors.push((error, color.histogram_index, color.weight));
    }
    if !total_weight.is_finite() || !weighted_error_sum.is_finite() {
        return Err(PaletteError::WeightOverflow);
    }

    errors.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    let p95_target = total_weight * 0.95;
    let mut cumulative_weight = 0.0_f64;
    let mut p95 = 0.0_f64;
    for (error, _, weight) in errors {
        cumulative_weight += weight;
        p95 = error;
        if cumulative_weight >= p95_target {
            break;
        }
    }

    Ok((weighted_error_sum / total_weight, p95))
}

fn srgb_to_oklab(rgb: [f64; 3]) -> Oklab {
    let red = srgb_channel_to_linear(rgb[0]);
    let green = srgb_channel_to_linear(rgb[1]);
    let blue = srgb_channel_to_linear(rgb[2]);

    let l = 0.412_221_470_8_f64.mul_add(
        red,
        0.536_332_536_3_f64.mul_add(green, 0.051_445_992_9 * blue),
    );
    let m = 0.211_903_498_2_f64.mul_add(
        red,
        0.680_699_545_1_f64.mul_add(green, 0.107_396_956_6 * blue),
    );
    let s = 0.088_302_461_9_f64.mul_add(
        red,
        0.281_718_837_6_f64.mul_add(green, 0.629_978_700_5 * blue),
    );
    let l_root = l.cbrt();
    let m_root = m.cbrt();
    let s_root = s.cbrt();

    Oklab {
        l: 0.210_454_255_3_f64.mul_add(
            l_root,
            0.793_617_785_f64.mul_add(m_root, -0.004_072_046_8 * s_root),
        ),
        a: 1.977_998_495_1_f64.mul_add(
            l_root,
            (-2.428_592_205_f64).mul_add(m_root, 0.450_593_709_9 * s_root),
        ),
        b: 0.025_904_037_1_f64.mul_add(
            l_root,
            0.782_771_766_2_f64.mul_add(m_root, -0.808_675_766 * s_root),
        ),
    }
}

pub(crate) fn oklab_distance_srgb8(first: [u8; 3], second: [u8; 3]) -> f64 {
    let to_unit = |value: u8| f64::from(value) / 255.0;
    srgb_to_oklab([to_unit(first[0]), to_unit(first[1]), to_unit(first[2])])
        .distance_squared(srgb_to_oklab([
            to_unit(second[0]),
            to_unit(second[1]),
            to_unit(second[2]),
        ]))
        .sqrt()
}

pub(crate) fn srgb8_to_oklab(rgb: [u8; 3]) -> Oklab {
    let to_unit = |value: u8| f64::from(value) / 255.0;
    srgb_to_oklab([to_unit(rgb[0]), to_unit(rgb[1]), to_unit(rgb[2])])
}

fn oklab_to_srgb8(lab: Oklab) -> [u8; 3] {
    let l_root = 0.396_337_777_4_f64.mul_add(lab.a, 0.215_803_757_3_f64.mul_add(lab.b, lab.l));
    let m_root =
        (-0.105_561_345_8_f64).mul_add(lab.a, (-0.063_854_172_8_f64).mul_add(lab.b, lab.l));
    let s_root = (-0.089_484_177_5_f64).mul_add(lab.a, (-1.291_485_548_f64).mul_add(lab.b, lab.l));
    let l = l_root * l_root * l_root;
    let m = m_root * m_root * m_root;
    let s = s_root * s_root * s_root;

    let red =
        4.076_741_662_1_f64.mul_add(l, (-3.307_711_591_3_f64).mul_add(m, 0.230_969_929_2 * s));
    let green =
        (-1.268_438_004_6_f64).mul_add(l, 2.609_757_401_1_f64.mul_add(m, -0.341_319_396_5 * s));
    let blue =
        (-0.004_196_086_3_f64).mul_add(l, (-0.703_418_614_7_f64).mul_add(m, 1.707_614_701 * s));

    [
        linear_channel_to_srgb8(red),
        linear_channel_to_srgb8(green),
        linear_channel_to_srgb8(blue),
    ]
}

fn srgb_channel_to_linear(value: f64) -> f64 {
    if value <= 0.040_45 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_channel_to_srgb8(value: f64) -> u8 {
    let srgb = if value <= 0.003_130_8 {
        12.92 * value
    } else {
        1.055 * value.max(0.0).powf(1.0 / 2.4) - 0.055
    };
    (srgb.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(rgb: &[[u8; 3]], weight: f64) -> WeightedRgb24Frame {
        WeightedRgb24Frame {
            pixels: rgb.iter().flat_map(|pixel| pixel.iter().copied()).collect(),
            weight,
        }
    }

    fn opaque_colors(artifact: &OklabPaletteArtifact) -> Vec<[u8; 3]> {
        opaque_palette_colors(artifact)
    }

    fn assert_lab_close(actual: Oklab, expected: Oklab) {
        assert!((actual.l - expected.l).abs() < 1.0e-7, "L: {actual:?}");
        assert!((actual.a - expected.a).abs() < 1.0e-7, "a: {actual:?}");
        assert!((actual.b - expected.b).abs() < 1.0e-7, "b: {actual:?}");
    }

    #[test]
    fn oklab_matches_reference_primary_vectors() {
        assert_lab_close(
            srgb_to_oklab([1.0, 0.0, 0.0]),
            Oklab {
                l: 0.627_955_360_6,
                a: 0.224_863_061_1,
                b: 0.125_846_298_5,
            },
        );
        assert_lab_close(
            srgb_to_oklab([0.0, 1.0, 0.0]),
            Oklab {
                l: 0.866_439_611_5,
                a: -0.233_887_574_2,
                b: 0.179_498_479_9,
            },
        );
        assert_lab_close(
            srgb_to_oklab([0.0, 0.0, 1.0]),
            Oklab {
                l: 0.452_013_718_4,
                a: -0.032_456_984_2,
                b: -0.311_528_147_7,
            },
        );
    }

    #[test]
    fn oklab_round_trip_preserves_srgb8_grid() {
        for red in [0_u8, 1, 32, 127, 200, 255] {
            for green in [0_u8, 17, 128, 254] {
                for blue in [0_u8, 64, 191, 255] {
                    let lab = srgb_to_oklab([
                        f64::from(red) / 255.0,
                        f64::from(green) / 255.0,
                        f64::from(blue) / 255.0,
                    ]);
                    assert_eq!(oklab_to_srgb8(lab), [red, green, blue]);
                }
            }
        }
    }

    #[test]
    fn srgb8_oklab_distance_is_symmetric_and_zero_for_identical_colors() {
        let first = [217, 154, 132];
        let second = [42, 184, 131];
        assert_eq!(oklab_distance_srgb8(first, first), 0.0);
        assert_eq!(
            oklab_distance_srgb8(first, second),
            oklab_distance_srgb8(second, first)
        );
        assert!(oklab_distance_srgb8(first, second) > 0.1);
    }

    #[test]
    fn palette_artifact_is_byte_for_byte_deterministic() {
        let frames = vec![
            frame(&[[10, 20, 30], [240, 180, 20], [10, 20, 31]], 2.5),
            frame(&[[11, 21, 29], [30, 220, 90], [90, 40, 200]], 1.25),
        ];
        let first = build_oklab_palette(&frames, 3, 1, 8).unwrap();
        let second = build_oklab_palette(&frames, 3, 1, 8).unwrap();
        let contiguous_pixels = frames
            .iter()
            .flat_map(|frame| frame.pixels.iter().copied())
            .collect::<Vec<_>>();
        let weights = frames.iter().map(|frame| frame.weight).collect::<Vec<_>>();
        let contiguous =
            build_oklab_palette_from_contiguous_rgb24(&contiguous_pixels, &weights, 3, 1, 8)
                .unwrap();

        assert_eq!(first, second);
        assert_eq!(first, contiguous);
        assert_eq!(first.rgba.len(), 1024);
        assert_eq!(
            first.sha256,
            "a1acd92d1265782c7adfca632c3a7f72d642f41afaf73394a335240423dd80b2"
        );
        assert_eq!(first.sampled_frame_count, 2);
        assert_eq!(first.sampled_pixel_count, 6);
    }

    #[test]
    fn fine_histogram_preserves_more_gradient_levels_without_changing_standard_path() {
        let pixels = (0_u16..=255)
            .flat_map(|value| {
                let value = value as u8;
                [value, value, value]
            })
            .collect::<Vec<_>>();
        let standard =
            build_oklab_palette_from_contiguous_rgb24(&pixels, &[1.0], 256, 1, 96).unwrap();
        let fine = build_oklab_palette_from_contiguous_rgb24_with_precision(
            &pixels,
            &[1.0],
            256,
            1,
            96,
            PaletteHistogramPrecision::Fine6Bit,
        )
        .unwrap();
        let repeated = build_oklab_palette_from_contiguous_rgb24_with_precision(
            &pixels,
            &[1.0],
            256,
            1,
            96,
            PaletteHistogramPrecision::Fine6Bit,
        )
        .unwrap();

        assert_eq!(standard.emitted_colors, 33);
        assert_eq!(fine, repeated);
        assert!(fine.emitted_colors > standard.emitted_colors);
        assert_ne!(fine.sha256, standard.sha256);
    }

    #[test]
    fn requested_color_boundaries_reserve_transparency() {
        let minimum_samples = vec![frame(&[[0, 0, 0], [255, 255, 255]], 1.0)];
        let maximum_pixels = (0_u16..255)
            .map(|index| [((index >> 5) as u8) * 8, ((index & 31) as u8) * 8, 0])
            .collect::<Vec<_>>();
        let maximum_samples = vec![frame(&maximum_pixels, 1.0)];
        let minimum = build_oklab_palette(&minimum_samples, 2, 1, 3).unwrap();
        let maximum = build_oklab_palette(&maximum_samples, 255, 1, 256).unwrap();

        assert_eq!(minimum.emitted_colors, 3);
        assert_eq!(maximum.emitted_colors, 256);
        assert_eq!(minimum.rgba.len(), 1024);
        assert_eq!(maximum.rgba.len(), 1024);
        assert_eq!(
            build_oklab_palette(&minimum_samples, 2, 1, 2),
            Err(PaletteError::InvalidRequestedColors(2))
        );
        assert_eq!(
            build_oklab_palette(&minimum_samples, 2, 1, 257),
            Err(PaletteError::InvalidRequestedColors(257))
        );
    }

    #[test]
    fn long_hold_weight_preserves_a_sparsely_sampled_color() {
        let uniform = vec![
            frame(&[[255, 0, 0]], 1.0),
            frame(&[[0, 255, 0]], 1.0),
            frame(&[[0, 0, 255]], 1.0),
            frame(&[[0, 0, 0]], 1.0),
        ];
        let weighted = vec![
            frame(&[[255, 0, 0]], 80.0),
            frame(&[[0, 255, 0]], 1.0),
            frame(&[[0, 0, 255]], 1.0),
            frame(&[[0, 0, 0]], 1.0),
        ];
        let uniform_palette = build_oklab_palette(&uniform, 1, 1, 3).unwrap();
        let weighted_palette = build_oklab_palette(&weighted, 1, 1, 3).unwrap();
        let red_lab = srgb_to_oklab([1.0, 0.0, 0.0]);
        let nearest_red_error = |artifact: &OklabPaletteArtifact| {
            opaque_colors(artifact)
                .into_iter()
                .map(|rgb| {
                    srgb_to_oklab([
                        f64::from(rgb[0]) / 255.0,
                        f64::from(rgb[1]) / 255.0,
                        f64::from(rgb[2]) / 255.0,
                    ])
                    .distance_squared(red_lab)
                })
                .fold(f64::INFINITY, f64::min)
        };

        let weighted_red_error = nearest_red_error(&weighted_palette);
        assert!(weighted_red_error < nearest_red_error(&uniform_palette));
        assert!(
            weighted_red_error < 0.001,
            "long-hold red should retain a perceptually near center: {:?}",
            opaque_colors(&weighted_palette)
        );
    }

    #[test]
    fn index_255_is_the_only_transparent_slot_and_unused_slots_are_stable() {
        let artifact = build_oklab_palette(&[frame(&[[7, 11, 19]], 1.0)], 1, 1, 16).unwrap();
        let entries = artifact.rgba.chunks_exact(4).collect::<Vec<_>>();

        assert_eq!(artifact.emitted_colors, 2);
        assert!(entries[..255].iter().all(|rgba| rgba[3] == 255));
        assert_eq!(entries[255], &[0, 0, 0, 0]);
        assert!(entries[..255]
            .iter()
            .all(|rgba| rgba[..3] == entries[0][..3]));
    }

    #[test]
    fn options_default_preserves_the_legacy_palette_bytes() {
        let pixels = vec![10, 20, 30, 240, 180, 20, 10, 20, 31];
        let legacy = build_oklab_palette_from_contiguous_rgb24_with_precision(
            &pixels,
            &[1.0],
            3,
            1,
            8,
            PaletteHistogramPrecision::Standard5Bit,
        )
        .unwrap();
        let explicit = build_oklab_palette_from_contiguous_rgb24_with_options(
            &pixels,
            &[1.0],
            3,
            1,
            8,
            &PaletteBuildOptions::default(),
        )
        .unwrap();

        assert_eq!(explicit, legacy);
        assert_eq!(explicit.rgba[TRANSPARENT_INDEX * RGBA_CHANNELS + 3], 0);
    }

    #[test]
    fn opaque_options_use_all_256_slots_without_a_transparent_entry() {
        let pixels = (0_u16..256)
            .flat_map(|index| {
                let index = index as u8;
                [(index & 0x0f) * 16, (index >> 4) * 16, 0]
            })
            .collect::<Vec<_>>();
        let options = PaletteBuildOptions {
            reserve_transparent: false,
            protected_rgb: Vec::new(),
        };
        let artifact = build_oklab_palette_from_contiguous_rgb24_with_options(
            &pixels,
            &[1.0],
            256,
            1,
            256,
            &options,
        )
        .unwrap();

        assert_eq!(artifact.emitted_colors, 256);
        assert_eq!(opaque_palette_colors(&artifact).len(), 256);
        assert!(artifact
            .rgba
            .chunks_exact(RGBA_CHANNELS)
            .all(|entry| entry[3] == u8::MAX));
    }

    #[test]
    fn protected_colors_are_exact_canonical_fixed_centers() {
        let pixels = vec![33, 147, 71];
        let options = PaletteBuildOptions {
            reserve_transparent: true,
            protected_rgb: vec![[255, 255, 255], [0, 0, 0], [255, 255, 255]],
        };
        let reordered = PaletteBuildOptions {
            reserve_transparent: true,
            protected_rgb: vec![[0, 0, 0], [255, 255, 255]],
        };
        let first = build_oklab_palette_from_contiguous_rgb24_with_options(
            &pixels,
            &[1.0],
            1,
            1,
            4,
            &options,
        )
        .unwrap();
        let second = build_oklab_palette_from_contiguous_rgb24_with_options(
            &pixels,
            &[1.0],
            1,
            1,
            4,
            &reordered,
        )
        .unwrap();

        assert_eq!(first, second);
        assert_eq!(first.emitted_colors, 4);
        let colors = opaque_palette_colors(&first);
        assert!(colors.contains(&[0, 0, 0]));
        assert!(colors.contains(&[255, 255, 255]));
        assert_eq!(first.rgba[TRANSPARENT_INDEX * RGBA_CHANNELS + 3], 0);
    }

    #[test]
    fn protected_colors_cannot_exceed_the_opaque_capacity() {
        let error = build_oklab_palette_from_contiguous_rgb24_with_options(
            &[10, 20, 30],
            &[1.0],
            1,
            1,
            3,
            &PaletteBuildOptions {
                reserve_transparent: true,
                protected_rgb: vec![[0, 0, 0], [1, 1, 1], [2, 2, 2]],
            },
        )
        .expect_err(
            "three protected colors cannot fit beside a transparent slot in a 3-color palette",
        );

        assert_eq!(
            error,
            PaletteError::TooManyProtectedColors {
                protected: 3,
                opaque_capacity: 2,
            }
        );
    }

    #[test]
    fn segment_options_keep_protected_colors_in_each_palette() {
        let pixels = vec![240, 30, 20, 30, 40, 230];
        let weights = [1.0, 1.0];
        let options = PaletteBuildOptions {
            reserve_transparent: false,
            protected_rgb: vec![[0, 0, 0], [255, 255, 255]],
        };
        let global = build_oklab_palette_from_contiguous_rgb24_with_options(
            &pixels, &weights, 1, 1, 8, &options,
        )
        .unwrap();
        let sequence = build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_options(
            &pixels,
            &weights,
            1,
            1,
            8,
            &global,
            &[
                PaletteFrameRange {
                    start: 0,
                    end_exclusive: 1,
                },
                PaletteFrameRange {
                    start: 1,
                    end_exclusive: 2,
                },
            ],
            &options,
        )
        .unwrap();

        assert!(sequence.segments.iter().all(|segment| {
            let colors = opaque_palette_colors(&segment.palette);
            colors.contains(&[0, 0, 0])
                && colors.contains(&[255, 255, 255])
                && segment
                    .palette
                    .rgba
                    .chunks_exact(RGBA_CHANNELS)
                    .all(|entry| entry[3] == u8::MAX)
        }));
    }

    #[test]
    fn segment_palette_sequence_shares_stable_anchors_deterministically() {
        let frame_pixels = [
            [[0, 0, 0], [255, 0, 0]],
            [[0, 0, 0], [240, 20, 10]],
            [[0, 0, 0], [0, 0, 255]],
            [[0, 0, 0], [10, 20, 240]],
        ];
        let pixels = frame_pixels
            .iter()
            .flatten()
            .flat_map(|rgb| rgb.iter().copied())
            .collect::<Vec<_>>();
        let weights = vec![1.0; frame_pixels.len()];
        let global =
            build_oklab_palette_from_contiguous_rgb24(&pixels, &weights, 2, 1, 16).unwrap();
        let ranges = [
            PaletteFrameRange {
                start: 0,
                end_exclusive: 2,
            },
            PaletteFrameRange {
                start: 2,
                end_exclusive: 4,
            },
        ];
        let first = build_oklab_segment_palette_sequence_from_contiguous_rgb24(
            &pixels, &weights, 2, 1, 16, &global, &ranges,
        )
        .unwrap();
        let second = build_oklab_segment_palette_sequence_from_contiguous_rgb24(
            &pixels, &weights, 2, 1, 16, &global, &ranges,
        )
        .unwrap();
        let explicit_default =
            build_oklab_segment_palette_sequence_from_contiguous_rgb24_with_options(
                &pixels,
                &weights,
                2,
                1,
                16,
                &global,
                &ranges,
                &PaletteBuildOptions::default(),
            )
            .unwrap();

        assert_eq!(first, second);
        assert_eq!(first, explicit_default);
        assert_eq!(first.shared_anchors_rgb, vec![[0, 0, 0]]);
        assert_eq!(first.segments.len(), 2);
        assert!(first.segments.iter().all(|segment| {
            opaque_colors(&segment.palette).contains(&first.shared_anchors_rgb[0])
        }));
        assert_eq!(first.shared_anchor_sha256.len(), 64);
        assert_eq!(first.sha256.len(), 64);
    }

    #[test]
    fn segment_palette_sequence_rejects_non_contiguous_ranges() {
        let pixels = vec![0_u8; 4 * 3];
        let weights = vec![1.0; 4];
        let global =
            build_oklab_palette_from_contiguous_rgb24(&pixels, &weights, 1, 1, 16).unwrap();
        let error = build_oklab_segment_palette_sequence_from_contiguous_rgb24(
            &pixels,
            &weights,
            1,
            1,
            16,
            &global,
            &[
                PaletteFrameRange {
                    start: 0,
                    end_exclusive: 2,
                },
                PaletteFrameRange {
                    start: 3,
                    end_exclusive: 4,
                },
            ],
        )
        .expect_err("non-contiguous ranges");
        assert!(matches!(
            error,
            PaletteError::InvalidPaletteSegmentRange {
                index: 1,
                expected_start: 2,
                ..
            }
        ));
    }

    #[test]
    fn invalid_inputs_are_reported_explicitly() {
        assert_eq!(
            build_oklab_palette(&[], 1, 1, 3),
            Err(PaletteError::EmptyInput)
        );
        assert_eq!(
            build_oklab_palette(&[frame(&[[0, 0, 0]], 1.0)], 0, 1, 3),
            Err(PaletteError::ZeroDimensions)
        );
        assert_eq!(
            build_oklab_palette(
                &[WeightedRgb24Frame {
                    pixels: Vec::new(),
                    weight: 1.0,
                }],
                u32::MAX,
                u32::MAX,
                3
            ),
            Err(PaletteError::DimensionOverflow)
        );
        assert_eq!(
            build_oklab_palette(
                &[WeightedRgb24Frame {
                    pixels: vec![0, 0],
                    weight: 1.0,
                }],
                1,
                1,
                3,
            ),
            Err(PaletteError::InvalidFrameSize {
                index: 0,
                expected: 3,
                actual: 2,
            })
        );
        assert_eq!(
            build_oklab_palette_from_contiguous_rgb24(&[0, 0], &[1.0], 1, 1, 3),
            Err(PaletteError::InvalidFrameBufferSize {
                expected: 3,
                actual: 2,
            })
        );

        for invalid_weight in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(matches!(
                build_oklab_palette(
                    &[WeightedRgb24Frame {
                        pixels: vec![0, 0, 0],
                        weight: invalid_weight,
                    }],
                    1,
                    1,
                    3
                ),
                Err(PaletteError::InvalidWeight { index: 0, .. })
            ));
        }
    }
}
