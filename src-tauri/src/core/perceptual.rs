//! GIFP 3.2 alpha frame analysis and perceptual Drop-and-Hold scheduling.
//!
//! This module intentionally depends only on `std`. Decoding remains an
//! orchestration concern: callers provide complete, fixed-size RGB24 frames,
//! and the analyzer produces compact frame metadata. The scheduler consumes
//! only that metadata and never inspects pixels.

use std::{error::Error, fmt, str::FromStr};

/// GIF delay precision is one centisecond.
pub const CENTISECOND_US: u64 = 10_000;

// Drop-and-Hold is evaluated at presentation time, where a high mean score can
// hide a few severely stale frames. Continuous motion is bounded by elapsed
// source time, while a genuinely local transition spike is rescued immediately.
// This keeps the pass deterministic without turning smooth full-frame motion
// into an all-frames-mandatory schedule.
const PRESENTATION_DYNAMIC_HOLD_LIMIT_US: u64 = 160_000;
const PRESENTATION_MATERIAL_MOTION_STEP: f32 = 0.0005;
const PRESENTATION_MATERIAL_CHANGED_AREA_STEP: f32 = 0.001;
const PRESENTATION_MATERIAL_SCENE_STEP: f32 = 0.001;
const PRESENTATION_LOCAL_SPIKE_MIN_CHANGED_AREA: f32 = 0.004;
const PRESENTATION_LOCAL_SPIKE_MAX_CHANGED_AREA: f32 = 0.08;
const PRESENTATION_LOCAL_SPIKE_BASELINE_MULTIPLIER: f32 = 3.0;
const PRESENTATION_LOCAL_SPIKE_MIN_EXCESS: f32 = 0.003;
const PRESENTATION_LOCAL_BASELINE_RADIUS: usize = 2;

/// A complete RGB24 frame and its source-timeline metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rgb24Frame {
    pub pixels: Vec<u8>,
    pub pts_us: i64,
    pub duration_us: u64,
    /// Explicit exclusions are never emitted by the scheduler, including at
    /// the beginning or end of a sequence.
    pub excluded: bool,
    /// Indicates that upstream decoding stopped early. The frame itself must
    /// still contain exactly `width * height * 3` bytes.
    pub truncated: bool,
}

impl Rgb24Frame {
    pub fn new(pixels: Vec<u8>, pts_us: i64, duration_us: u64) -> Self {
        Self {
            pixels,
            pts_us,
            duration_us,
            excluded: false,
            truncated: false,
        }
    }
}

/// User-visible emphasis used while ranking otherwise optional frames.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum PerceptualFocus {
    #[default]
    Auto,
    Subject,
    Motion,
    TextUi,
    FlatArt,
}

impl PerceptualFocus {
    pub fn parse(value: &str) -> Result<Self, PerceptualError> {
        value.parse()
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Subject => "subject",
            Self::Motion => "motion",
            Self::TextUi => "text_ui",
            Self::FlatArt => "flat_art",
        }
    }
}

impl FromStr for PerceptualFocus {
    type Err = PerceptualError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_")
            .as_str()
        {
            "auto" => Ok(Self::Auto),
            "subject" | "person" | "people" => Ok(Self::Subject),
            "motion" | "movement" => Ok(Self::Motion),
            "text" | "ui" | "text_ui" => Ok(Self::TextUi),
            "flat" | "flat_art" | "illustration" => Ok(Self::FlatArt),
            _ => Err(PerceptualError::InvalidFocus(value.to_owned())),
        }
    }
}

impl fmt::Display for PerceptualFocus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Compact analyzer output for one source frame.
///
/// Every signal is finite and clamped to `0.0..=1.0`.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameSignals {
    pub source_index: usize,
    pub pts_us: i64,
    pub duration_us: u64,
    pub excluded: bool,
    pub truncated: bool,
    pub motion: f32,
    pub scene_change: f32,
    /// Joint edge density and text/UI likelihood.
    pub edge_text: f32,
    /// Center-weighted subject saliency; skin evidence contributes mildly.
    pub subject_saliency: f32,
    pub skin_ratio: f32,
    pub noise: f32,
    /// Share of spatial neighbors with a small, non-zero RGB delta. Smooth
    /// gradients score high while solid fills and hard edges do not.
    pub smooth_gradient_ratio: f32,
    pub compression_cost: f32,
    pub changed_area: f32,
}

impl FrameSignals {
    pub fn signals_in_range(&self) -> bool {
        [
            self.motion,
            self.scene_change,
            self.edge_text,
            self.subject_saliency,
            self.skin_ratio,
            self.noise,
            self.smooth_gradient_ratio,
            self.compression_cost,
            self.changed_area,
        ]
        .into_iter()
        .all(|value| value.is_finite() && (0.0..=1.0).contains(&value))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PerceptualAnalysis {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<FrameSignals>,
    pub total_duration_us: u64,
    pub input_truncated: bool,
}

/// Aggregate signals used by automatic focus selection, scheduling policy,
/// and user-visible audit reports.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PerceptualSummary {
    pub mean_motion: f32,
    pub mean_changed_area: f32,
    pub mean_edge_text: f32,
    pub mean_noise: f32,
    pub mean_smooth_gradient_ratio: f32,
    pub mean_subject_saliency: f32,
    pub mean_skin_ratio: f32,
}

impl PerceptualAnalysis {
    pub fn summary(&self) -> PerceptualSummary {
        let denominator = self.frames.len().max(1) as f32;
        let average = |signal: fn(&FrameSignals) -> f32| {
            self.frames.iter().map(signal).sum::<f32>() / denominator
        };
        PerceptualSummary {
            mean_motion: average(|frame| frame.motion),
            mean_changed_area: average(|frame| frame.changed_area),
            mean_edge_text: average(|frame| frame.edge_text),
            mean_noise: average(|frame| frame.noise),
            mean_smooth_gradient_ratio: average(|frame| frame.smooth_gradient_ratio),
            mean_subject_saliency: average(|frame| frame.subject_saliency),
            mean_skin_ratio: average(|frame| frame.skin_ratio),
        }
    }
}

impl PerceptualSummary {
    pub fn is_smooth_color_motion(self) -> bool {
        self.mean_changed_area >= 0.20
            && self.mean_smooth_gradient_ratio >= 0.18
            && self.mean_edge_text <= 0.08
            && self.mean_noise <= 0.05
    }

    /// Resolve Auto using temporal evidence before center saliency. Synthetic
    /// motion and scrolling layouts often have a salient center but should not
    /// be scheduled as a mostly static portrait.
    pub fn resolve_focus(self, requested: PerceptualFocus) -> PerceptualFocus {
        if requested != PerceptualFocus::Auto {
            return requested;
        }
        if self.is_smooth_color_motion() {
            PerceptualFocus::FlatArt
        } else if self.mean_motion >= 0.025 || self.mean_changed_area >= 0.04 {
            PerceptualFocus::Motion
        } else if self.mean_edge_text >= 0.28 && self.mean_noise <= 0.35 {
            PerceptualFocus::TextUi
        } else if self.mean_subject_saliency * 0.7 + self.mean_skin_ratio * 0.9 >= 0.28 {
            PerceptualFocus::Subject
        } else {
            PerceptualFocus::FlatArt
        }
    }
}

/// Controls the alpha scheduler without coupling it to an encoder backend.
#[derive(Clone, Debug, PartialEq)]
pub struct SchedulerConfig {
    pub focus: PerceptualFocus,
    /// Desired upper fraction of eligible frames after mandatory frames are
    /// reserved. `0.0` still retains mandatory first/last and scene cuts.
    pub retention_ratio: f32,
    /// Optional hard cap. Mandatory frames take precedence when they exceed it.
    pub max_frames: Option<usize>,
    pub scene_change_threshold: f32,
    pub duplicate_motion_threshold: f32,
    pub low_value_threshold: f32,
    /// Weight of distance from already retained frames during greedy selection.
    pub temporal_spacing_weight: f32,
    /// When the product explicitly asks to fill the retention target, admit
    /// tightly spaced subtle changes after the normal quality ranking is
    /// exhausted. Exact duplicate frames remain collapsible.
    pub fill_target_with_subtle_changes: bool,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            focus: PerceptualFocus::Auto,
            retention_ratio: 0.60,
            max_frames: None,
            scene_change_threshold: 0.62,
            duplicate_motion_threshold: 0.012,
            low_value_threshold: 0.16,
            temporal_spacing_weight: 0.15,
            fill_target_with_subtle_changes: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScheduledFrame {
    pub source_index: usize,
    pub pts_us: i64,
    pub delay_cs: u32,
    pub importance: f32,
    pub scene_boundary: bool,
}

/// Per-source-frame audit trail for Drop-and-Hold.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FrameDisposition {
    Kept {
        schedule_index: usize,
    },
    DropAndHold {
        held_by_source_index: usize,
        explicitly_excluded: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct FrameSchedule {
    pub frames: Vec<ScheduledFrame>,
    pub dispositions: Vec<FrameDisposition>,
    /// Focus actually used after resolving `Auto`.
    pub resolved_focus: PerceptualFocus,
    pub source_duration_us: u64,
    pub quantized_duration_cs: u64,
    pub input_truncated: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct PresentationSafetyStats {
    rescue_count: usize,
    max_dynamic_hold_us: u64,
}

impl FrameSchedule {
    pub fn kept_indices(&self) -> Vec<usize> {
        self.frames.iter().map(|frame| frame.source_index).collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PerceptualError {
    EmptyInput,
    ZeroDimensions,
    DimensionOverflow,
    InvalidFrameSize {
        index: usize,
        expected: usize,
        actual: usize,
    },
    ZeroDuration {
        index: usize,
    },
    NonMonotonicPts {
        index: usize,
        previous: i64,
        current: i64,
    },
    TimestampOverflow {
        index: usize,
    },
    DurationOverflow,
    DelayOverflow,
    InvalidFocus(String),
    InvalidConfig(&'static str),
    InvalidAnalysis(&'static str),
    NoSchedulableFrames,
}

impl fmt::Display for PerceptualError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyInput => formatter.write_str("at least one RGB24 frame is required"),
            Self::ZeroDimensions => formatter.write_str("frame dimensions must be non-zero"),
            Self::DimensionOverflow => formatter.write_str("RGB24 frame dimensions overflow usize"),
            Self::InvalidFrameSize {
                index,
                expected,
                actual,
            } => write!(
                formatter,
                "frame {index} has {actual} RGB24 bytes; expected {expected}"
            ),
            Self::ZeroDuration { index } => {
                write!(formatter, "frame {index} has a zero duration")
            }
            Self::NonMonotonicPts {
                index,
                previous,
                current,
            } => write!(
                formatter,
                "frame {index} PTS {current} is not after previous PTS {previous}"
            ),
            Self::TimestampOverflow { index } => {
                write!(formatter, "frame {index} end timestamp overflows i64")
            }
            Self::DurationOverflow => formatter.write_str("source duration overflows u64"),
            Self::DelayOverflow => formatter.write_str("centisecond delay overflows u32"),
            Self::InvalidFocus(value) => write!(formatter, "unknown perceptual focus: {value}"),
            Self::InvalidConfig(field) => write!(formatter, "invalid scheduler field: {field}"),
            Self::InvalidAnalysis(reason) => {
                write!(formatter, "invalid perceptual analysis: {reason}")
            }
            Self::NoSchedulableFrames => {
                formatter.write_str("all source frames were explicitly excluded")
            }
        }
    }
}

impl Error for PerceptualError {}

/// Analyze complete fixed-size RGB24 frames without selecting any frame.
pub fn analyze_rgb_frames(
    width: u32,
    height: u32,
    frames: &[Rgb24Frame],
) -> Result<PerceptualAnalysis, PerceptualError> {
    if frames.is_empty() {
        return Err(PerceptualError::EmptyInput);
    }
    if width == 0 || height == 0 {
        return Err(PerceptualError::ZeroDimensions);
    }

    let pixel_count = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(PerceptualError::DimensionOverflow)?;
    let expected_bytes = pixel_count
        .checked_mul(3)
        .ok_or(PerceptualError::DimensionOverflow)?;

    let mut total_duration_us = 0u64;
    let mut previous_pts = None;
    let mut previous_pixels: Option<&[u8]> = None;
    let mut previous_histogram: Option<[[u32; 16]; 3]> = None;
    let mut result = Vec::with_capacity(frames.len());

    for (index, frame) in frames.iter().enumerate() {
        if frame.pixels.len() != expected_bytes {
            return Err(PerceptualError::InvalidFrameSize {
                index,
                expected: expected_bytes,
                actual: frame.pixels.len(),
            });
        }
        if frame.duration_us == 0 {
            return Err(PerceptualError::ZeroDuration { index });
        }
        if let Some(previous) = previous_pts {
            if frame.pts_us <= previous {
                return Err(PerceptualError::NonMonotonicPts {
                    index,
                    previous,
                    current: frame.pts_us,
                });
            }
        }
        let duration_i64 = i64::try_from(frame.duration_us)
            .map_err(|_| PerceptualError::TimestampOverflow { index })?;
        frame
            .pts_us
            .checked_add(duration_i64)
            .ok_or(PerceptualError::TimestampOverflow { index })?;
        total_duration_us = total_duration_us
            .checked_add(frame.duration_us)
            .ok_or(PerceptualError::DurationOverflow)?;

        let spatial = analyze_spatial(width as usize, height as usize, &frame.pixels);
        let (motion, changed_area) = previous_pixels.map_or((0.0, 0.0), |previous| {
            transition_signals(previous, &frame.pixels)
        });
        let scene_change = previous_histogram.map_or(0.0, |previous| {
            clamp01(histogram_distance(&previous, &spatial.histogram) * 0.72 + motion * 0.42)
        });

        result.push(FrameSignals {
            source_index: index,
            pts_us: frame.pts_us,
            duration_us: frame.duration_us,
            excluded: frame.excluded,
            truncated: frame.truncated,
            motion,
            scene_change,
            edge_text: spatial.edge_text,
            subject_saliency: spatial.subject_saliency,
            skin_ratio: spatial.skin_ratio,
            noise: spatial.noise,
            smooth_gradient_ratio: spatial.smooth_gradient_ratio,
            compression_cost: clamp01(
                spatial.color_complexity * 0.42
                    + spatial.edge_text * 0.19
                    + spatial.noise * 0.21
                    + changed_area * 0.18,
            ),
            changed_area,
        });

        previous_pts = Some(frame.pts_us);
        previous_pixels = Some(&frame.pixels);
        previous_histogram = Some(spatial.histogram);
    }

    Ok(PerceptualAnalysis {
        width,
        height,
        input_truncated: frames.iter().any(|frame| frame.truncated),
        frames: result,
        total_duration_us,
    })
}

/// Select frames using deterministic perceptual Drop-and-Hold scheduling.
pub fn schedule_frames(
    analysis: &PerceptualAnalysis,
    config: &SchedulerConfig,
) -> Result<FrameSchedule, PerceptualError> {
    validate_analysis(analysis)?;
    validate_config(config)?;

    let eligible: Vec<usize> = analysis
        .frames
        .iter()
        .enumerate()
        .filter_map(|(index, frame)| (!frame.excluded).then_some(index))
        .collect();
    let first = *eligible
        .first()
        .ok_or(PerceptualError::NoSchedulableFrames)?;
    let last = *eligible
        .last()
        .ok_or(PerceptualError::NoSchedulableFrames)?;
    let resolved_focus = analysis.summary().resolve_focus(config.focus);
    let importance: Vec<f32> = analysis
        .frames
        .iter()
        .map(|signals| frame_importance(signals, resolved_focus))
        .collect();

    let mut kept = vec![false; analysis.frames.len()];
    kept[first] = true;
    kept[last] = true;
    for &index in &eligible {
        if analysis.frames[index].scene_change >= config.scene_change_threshold {
            kept[index] = true;
        }
    }

    let configured_cap = config.max_frames.unwrap_or(eligible.len());
    let scene_mandatory_count = kept.iter().filter(|value| **value).count();
    // Presentation rescues take precedence over the soft retention target. An
    // explicit max_frames still bounds new rescues; only the pre-existing
    // first/last/scene mandatory set may already exceed that cap, matching the
    // scheduler's established mandatory-frame semantics.
    let safety_cap = configured_cap
        .max(scene_mandatory_count)
        .min(eligible.len());
    let safety_stats = promote_presentation_safety(analysis, &mut kept, safety_cap);
    debug_assert!(safety_stats.rescue_count <= safety_cap);
    debug_assert!(safety_stats.max_dynamic_hold_us <= analysis.total_duration_us);

    let mandatory_count = kept.iter().filter(|value| **value).count();
    let ratio_target = ((eligible.len() as f32) * config.retention_ratio).ceil() as usize;
    let target = ratio_target
        .max(mandatory_count)
        .min(configured_cap.max(mandatory_count))
        .min(eligible.len());

    while kept.iter().filter(|value| **value).count() < target {
        let candidate = eligible
            .iter()
            .copied()
            .filter(|index| !kept[*index])
            .filter_map(|index| {
                let signals = &analysis.frames[index];
                let spacing = temporal_spacing(index, &kept);
                let normal_candidate = signals.motion > config.duplicate_motion_threshold
                    || signals.changed_area > config.duplicate_motion_threshold * 2.0;
                // A slow fade or sub-pixel pan may stay below the adjacent-frame
                // threshold forever. Admit a widely spaced rescue candidate when
                // there is real (but subtle) change, while exact duplicates remain
                // collapsible to a single hold.
                let subtle_change = signals.motion > 0.001
                    || signals.changed_area > 0.001
                    || signals.scene_change > 0.001;
                let temporal_rescue = subtle_change && spacing >= 0.08;
                if !normal_candidate && !temporal_rescue {
                    return None;
                }
                let score = importance[index] + spacing * config.temporal_spacing_weight;
                Some((index, score, temporal_rescue))
            })
            .filter(|(_, score, temporal_rescue)| {
                *temporal_rescue || *score >= config.low_value_threshold
            })
            .max_by(|left, right| {
                left.1
                    .total_cmp(&right.1)
                    // Stable deterministic tie break: earlier source frame.
                    .then_with(|| right.0.cmp(&left.0))
            });

        match candidate {
            Some((index, _, _)) => kept[index] = true,
            None if config.fill_target_with_subtle_changes => {
                let fallback = eligible
                    .iter()
                    .copied()
                    .filter(|index| !kept[*index])
                    .filter_map(|index| {
                        let signals = &analysis.frames[index];
                        let subtle_change = signals.motion > 0.001
                            || signals.changed_area > 0.001
                            || signals.scene_change > 0.001;
                        subtle_change.then(|| {
                            let spacing = temporal_spacing(index, &kept);
                            (
                                index,
                                importance[index] + spacing * config.temporal_spacing_weight,
                            )
                        })
                    })
                    .max_by(|left, right| {
                        left.1
                            .total_cmp(&right.1)
                            .then_with(|| right.0.cmp(&left.0))
                    });
                match fallback {
                    Some((index, _)) => kept[index] = true,
                    None => break,
                }
            }
            None => break,
        }
    }

    let kept_indices: Vec<usize> = kept
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.then_some(index))
        .collect();
    let mut held_durations = vec![0u64; kept_indices.len()];
    let mut owners = vec![0usize; analysis.frames.len()];
    let mut schedule_cursor = 0usize;

    for (source_index, signals) in analysis.frames.iter().enumerate() {
        while schedule_cursor + 1 < kept_indices.len()
            && kept_indices[schedule_cursor + 1] <= source_index
        {
            schedule_cursor += 1;
        }
        // Leading excluded frames are represented by holding the first emitted
        // visual. Thereafter every dropped frame extends the preceding visual.
        let owner = if source_index < kept_indices[0] {
            0
        } else {
            schedule_cursor
        };
        owners[source_index] = owner;
        held_durations[owner] = held_durations[owner]
            .checked_add(signals.duration_us)
            .ok_or(PerceptualError::DurationOverflow)?;
    }

    let quantized_duration_cs = round_centiseconds(analysis.total_duration_us)?;
    let delays_cs = quantize_buckets(&held_durations, quantized_duration_cs)?;
    let frames: Vec<ScheduledFrame> = kept_indices
        .iter()
        .enumerate()
        .map(|(schedule_index, source_index)| ScheduledFrame {
            source_index: *source_index,
            pts_us: analysis.frames[*source_index].pts_us,
            delay_cs: delays_cs[schedule_index],
            importance: importance[*source_index],
            scene_boundary: analysis.frames[*source_index].scene_change
                >= config.scene_change_threshold,
        })
        .collect();

    let schedule_lookup: Vec<Option<usize>> = kept
        .iter()
        .scan(0usize, |next_schedule, is_kept| {
            let value = if *is_kept {
                let current = *next_schedule;
                *next_schedule += 1;
                Some(current)
            } else {
                None
            };
            Some(value)
        })
        .collect();
    let dispositions = analysis
        .frames
        .iter()
        .enumerate()
        .map(
            |(source_index, signals)| match schedule_lookup[source_index] {
                Some(schedule_index) => FrameDisposition::Kept { schedule_index },
                None => FrameDisposition::DropAndHold {
                    held_by_source_index: kept_indices[owners[source_index]],
                    explicitly_excluded: signals.excluded,
                },
            },
        )
        .collect();

    debug_assert_eq!(
        frames
            .iter()
            .map(|frame| u64::from(frame.delay_cs))
            .sum::<u64>(),
        quantized_duration_cs
    );

    Ok(FrameSchedule {
        frames,
        dispositions,
        resolved_focus,
        source_duration_us: analysis.total_duration_us,
        quantized_duration_cs,
        input_truncated: analysis.input_truncated,
    })
}

/// Promote the earliest unsafe held frame before optional importance ranking.
///
/// Material continuous change is bounded by elapsed source time. A local
/// `changed_area` spike is promoted immediately so a short pulse cannot fall
/// entirely inside that time budget. The spike test compares against a local
/// transition baseline and rejects broad full-frame changes, so smooth waves
/// and continuous line art remain available to the normal greedy target fill.
fn promote_presentation_safety(
    analysis: &PerceptualAnalysis,
    kept: &mut [bool],
    max_kept: usize,
) -> PresentationSafetyStats {
    let mut kept_count = kept.iter().filter(|value| **value).count();
    let mut rescue_count = 0usize;
    let mut held_duration_us = 0u64;
    let mut observed_material_change = false;

    for (index, signals) in analysis.frames.iter().enumerate() {
        if kept[index] {
            held_duration_us = 0;
            observed_material_change = false;
            continue;
        }

        held_duration_us = held_duration_us.saturating_add(signals.duration_us);
        if signals.excluded {
            // Explicit exclusions are an upstream timeline decision. Their
            // duration remains part of the hold, but safety never revives them
            // or treats their pixels as trustworthy transition evidence.
            continue;
        }

        observed_material_change |= is_material_transition(signals);
        let unsafe_presentation = is_localized_transition_spike(analysis, index)
            || (observed_material_change && held_duration_us >= PRESENTATION_DYNAMIC_HOLD_LIMIT_US);

        if unsafe_presentation && kept_count < max_kept {
            kept[index] = true;
            kept_count += 1;
            rescue_count += 1;
            held_duration_us = 0;
            observed_material_change = false;
        }
    }

    PresentationSafetyStats {
        rescue_count,
        max_dynamic_hold_us: maximum_dynamic_hold_us(analysis, kept),
    }
}

fn is_material_transition(signals: &FrameSignals) -> bool {
    signals.motion >= PRESENTATION_MATERIAL_MOTION_STEP
        || signals.changed_area >= PRESENTATION_MATERIAL_CHANGED_AREA_STEP
        || signals.scene_change >= PRESENTATION_MATERIAL_SCENE_STEP
}

fn is_localized_transition_spike(analysis: &PerceptualAnalysis, index: usize) -> bool {
    let Some(signals) = analysis.frames.get(index) else {
        return false;
    };
    let current = signals.changed_area;
    if index == 0
        || signals.excluded
        || !(PRESENTATION_LOCAL_SPIKE_MIN_CHANGED_AREA..=PRESENTATION_LOCAL_SPIKE_MAX_CHANGED_AREA)
            .contains(&current)
    {
        return false;
    }

    let start = index.saturating_sub(PRESENTATION_LOCAL_BASELINE_RADIUS);
    let end = index
        .saturating_add(PRESENTATION_LOCAL_BASELINE_RADIUS)
        .min(analysis.frames.len().saturating_sub(1));
    let mut neighbors = [0.0f32; PRESENTATION_LOCAL_BASELINE_RADIUS * 2];
    let mut neighbor_count = 0usize;
    for neighbor_index in start..=end {
        if neighbor_index == 0 || neighbor_index == index {
            continue;
        }
        let neighbor = &analysis.frames[neighbor_index];
        if neighbor.excluded {
            continue;
        }
        neighbors[neighbor_count] = neighbor.changed_area;
        neighbor_count += 1;
    }
    if neighbor_count == 0 {
        return false;
    }
    let neighbors = &mut neighbors[..neighbor_count];
    neighbors.sort_by(f32::total_cmp);
    let middle = neighbor_count / 2;
    let baseline = if neighbor_count.is_multiple_of(2) {
        (neighbors[middle - 1] + neighbors[middle]) * 0.5
    } else {
        neighbors[middle]
    };

    current - baseline >= PRESENTATION_LOCAL_SPIKE_MIN_EXCESS
        && current >= baseline * PRESENTATION_LOCAL_SPIKE_BASELINE_MULTIPLIER
}

fn maximum_dynamic_hold_us(analysis: &PerceptualAnalysis, kept: &[bool]) -> u64 {
    let mut held_duration_us = 0u64;
    let mut maximum = 0u64;
    let mut observed_material_change = false;

    for (index, signals) in analysis.frames.iter().enumerate() {
        if kept[index] {
            held_duration_us = 0;
            observed_material_change = false;
            continue;
        }
        held_duration_us = held_duration_us.saturating_add(signals.duration_us);
        if !signals.excluded {
            observed_material_change |= is_material_transition(signals);
        }
        if observed_material_change {
            maximum = maximum.max(held_duration_us);
        }
    }
    maximum
}

/// Public score helper used by reports and scheduler diagnostics.
pub fn frame_importance(signals: &FrameSignals, focus: PerceptualFocus) -> f32 {
    let focus = if focus == PerceptualFocus::Auto {
        PerceptualFocus::FlatArt
    } else {
        focus
    };
    let score = match focus {
        PerceptualFocus::Auto => unreachable!("auto focus is resolved above"),
        PerceptualFocus::Subject => {
            signals.subject_saliency * 0.31
                + signals.skin_ratio * 0.17
                + signals.motion * 0.16
                + signals.scene_change * 0.18
                + signals.edge_text * 0.07
                + signals.changed_area * 0.11
                - signals.compression_cost * 0.07
        }
        PerceptualFocus::Motion => {
            signals.motion * 0.39
                + signals.changed_area * 0.22
                + signals.scene_change * 0.20
                + signals.edge_text * 0.06
                + signals.subject_saliency * 0.08
                - signals.compression_cost * 0.06
        }
        PerceptualFocus::TextUi => {
            signals.edge_text * 0.43
                + signals.scene_change * 0.18
                + signals.changed_area * 0.11
                + signals.motion * 0.08
                + signals.subject_saliency * 0.06
                - signals.noise * 0.09
                - signals.compression_cost * 0.05
        }
        PerceptualFocus::FlatArt => {
            signals.edge_text * 0.28
                + signals.scene_change * 0.21
                + signals.changed_area * 0.15
                + signals.motion * 0.12
                + signals.subject_saliency * 0.09
                + (1.0 - signals.noise) * 0.08
                - signals.compression_cost * 0.07
        }
    };
    clamp01(score)
}

#[derive(Clone, Copy)]
struct SpatialSignals {
    histogram: [[u32; 16]; 3],
    edge_text: f32,
    subject_saliency: f32,
    skin_ratio: f32,
    noise: f32,
    smooth_gradient_ratio: f32,
    color_complexity: f32,
}

fn analyze_spatial(width: usize, height: usize, pixels: &[u8]) -> SpatialSignals {
    let pixel_count = width * height;
    let mut luma = Vec::with_capacity(pixel_count);
    let mut histogram = [[0u32; 16]; 3];
    let mut quantized_colors = [false; 4096];
    let mut unique_colors = 0usize;
    let mut skin_count = 0usize;
    let mut center_skin_count = 0usize;
    let mut center_count = 0usize;
    let mut outer_count = 0usize;
    let mut center_luma_sum = 0u64;
    let mut outer_luma_sum = 0u64;

    for (index, pixel) in pixels.chunks_exact(3).enumerate() {
        let r = pixel[0];
        let g = pixel[1];
        let b = pixel[2];
        let y = rgb_luma(r, g, b);
        luma.push(y);
        histogram[0][usize::from(r >> 4)] += 1;
        histogram[1][usize::from(g >> 4)] += 1;
        histogram[2][usize::from(b >> 4)] += 1;

        let color_key =
            (usize::from(r >> 4) << 8) | (usize::from(g >> 4) << 4) | usize::from(b >> 4);
        if !quantized_colors[color_key] {
            quantized_colors[color_key] = true;
            unique_colors += 1;
        }

        let x = index % width;
        let y_pos = index / width;
        let in_center = x >= width / 4
            && x < width.saturating_sub(width / 4)
            && y_pos >= height / 4
            && y_pos < height.saturating_sub(height / 4);
        let skin = is_skin(r, g, b);
        skin_count += usize::from(skin);
        if in_center {
            center_count += 1;
            center_luma_sum += u64::from(y);
            center_skin_count += usize::from(skin);
        } else {
            outer_count += 1;
            outer_luma_sum += u64::from(y);
        }
    }

    let mut edge_count = 0usize;
    let mut edge_total = 0usize;
    let mut gradient_sum = 0u64;
    let mut center_gradient_sum = 0u64;
    let mut center_gradient_count = 0usize;
    let mut outer_gradient_sum = 0u64;
    let mut outer_gradient_count = 0usize;
    let mut smooth_gradient_neighbors = 0usize;
    let mut spatial_neighbors = 0usize;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let mut gradient = 0u16;
            let mut neighbors = 0u16;
            if x + 1 < width {
                gradient += u16::from(luma[index].abs_diff(luma[index + 1]));
                neighbors += 1;
                spatial_neighbors += 1;
                smooth_gradient_neighbors += usize::from(is_smooth_rgb_step(
                    &pixels[index * 3..index * 3 + 3],
                    &pixels[(index + 1) * 3..(index + 1) * 3 + 3],
                ));
            }
            if y + 1 < height {
                gradient += u16::from(luma[index].abs_diff(luma[index + width]));
                neighbors += 1;
                spatial_neighbors += 1;
                smooth_gradient_neighbors += usize::from(is_smooth_rgb_step(
                    &pixels[index * 3..index * 3 + 3],
                    &pixels[(index + width) * 3..(index + width) * 3 + 3],
                ));
            }
            if neighbors == 0 {
                continue;
            }
            let mean_gradient = gradient / neighbors;
            edge_total += 1;
            gradient_sum += u64::from(mean_gradient);
            edge_count += usize::from(mean_gradient >= 24);

            let in_center = x >= width / 4
                && x < width.saturating_sub(width / 4)
                && y >= height / 4
                && y < height.saturating_sub(height / 4);
            if in_center {
                center_gradient_sum += u64::from(mean_gradient);
                center_gradient_count += 1;
            } else {
                outer_gradient_sum += u64::from(mean_gradient);
                outer_gradient_count += 1;
            }
        }
    }

    let edge_density = ratio(edge_count, edge_total);
    let mean_gradient = normalized_mean(gradient_sum, edge_total, 255.0);
    let raw_noise = laplacian_noise(width, height, &luma);
    let noise = clamp01(raw_noise * 2.8 - edge_density * 0.24);
    let unique_denominator = pixel_count.clamp(1, 512) as f32;
    let color_complexity = clamp01(unique_colors as f32 / unique_denominator);
    let flat_color_bonus = 1.0 - color_complexity;
    let edge_text = clamp01(
        edge_density * 1.15 + mean_gradient * 1.35 + edge_density * flat_color_bonus * 0.45
            - noise * 0.20,
    );

    let center_luma = normalized_mean(center_luma_sum, center_count, 255.0);
    let outer_luma = normalized_mean(outer_luma_sum, outer_count, 255.0);
    let center_gradient = normalized_mean(center_gradient_sum, center_gradient_count, 255.0);
    let outer_gradient = normalized_mean(outer_gradient_sum, outer_gradient_count, 255.0);
    let center_skin = ratio(center_skin_count, center_count);
    let center_contrast = (center_luma - outer_luma).abs();
    let detail_advantage = (center_gradient - outer_gradient).max(0.0);
    let subject_saliency =
        clamp01(center_contrast * 1.9 + detail_advantage * 2.1 + center_skin * 0.52);

    SpatialSignals {
        histogram,
        edge_text,
        subject_saliency,
        skin_ratio: ratio(skin_count, pixel_count),
        noise,
        smooth_gradient_ratio: ratio(smooth_gradient_neighbors, spatial_neighbors),
        color_complexity,
    }
}

fn is_smooth_rgb_step(left: &[u8], right: &[u8]) -> bool {
    let maximum_delta = left[0]
        .abs_diff(right[0])
        .max(left[1].abs_diff(right[1]))
        .max(left[2].abs_diff(right[2]));
    (1..=16).contains(&maximum_delta)
}

fn transition_signals(previous: &[u8], current: &[u8]) -> (f32, f32) {
    let mut luma_delta_sum = 0u64;
    let mut changed = 0usize;
    let pixel_count = current.len() / 3;
    for (left, right) in previous.chunks_exact(3).zip(current.chunks_exact(3)) {
        let left_luma = rgb_luma(left[0], left[1], left[2]);
        let right_luma = rgb_luma(right[0], right[1], right[2]);
        luma_delta_sum += u64::from(left_luma.abs_diff(right_luma));
        let channel_delta = left[0]
            .abs_diff(right[0])
            .max(left[1].abs_diff(right[1]))
            .max(left[2].abs_diff(right[2]));
        changed += usize::from(channel_delta >= 12);
    }
    (
        normalized_mean(luma_delta_sum, pixel_count, 255.0),
        ratio(changed, pixel_count),
    )
}

fn histogram_distance(previous: &[[u32; 16]; 3], current: &[[u32; 16]; 3]) -> f32 {
    let total = current[0].iter().copied().sum::<u32>().max(1) as f32;
    let absolute_difference = previous
        .iter()
        .zip(current)
        .flat_map(|(left, right)| left.iter().zip(right))
        .map(|(left, right)| left.abs_diff(*right) as f32)
        .sum::<f32>();
    clamp01(absolute_difference / (total * 3.0 * 2.0))
}

fn laplacian_noise(width: usize, height: usize, luma: &[u8]) -> f32 {
    if width < 3 || height < 3 {
        return 0.0;
    }
    let mut residual = 0u64;
    let mut count = 0usize;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let index = y * width + x;
            let center = i32::from(luma[index]) * 4;
            let neighbors = i32::from(luma[index - 1])
                + i32::from(luma[index + 1])
                + i32::from(luma[index - width])
                + i32::from(luma[index + width]);
            residual += u64::from(center.abs_diff(neighbors));
            count += 1;
        }
    }
    normalized_mean(residual, count, 255.0 * 4.0)
}

fn temporal_spacing(index: usize, kept: &[bool]) -> f32 {
    let nearest = kept
        .iter()
        .enumerate()
        .filter_map(|(other, value)| value.then_some(index.abs_diff(other)))
        .min()
        .unwrap_or(kept.len());
    nearest as f32 / kept.len().max(1) as f32
}

fn validate_analysis(analysis: &PerceptualAnalysis) -> Result<(), PerceptualError> {
    if analysis.frames.is_empty() {
        return Err(PerceptualError::EmptyInput);
    }
    if analysis.width == 0 || analysis.height == 0 {
        return Err(PerceptualError::ZeroDimensions);
    }
    let mut duration = 0u64;
    let mut previous_pts = None;
    for (index, frame) in analysis.frames.iter().enumerate() {
        if frame.source_index != index {
            return Err(PerceptualError::InvalidAnalysis(
                "source indices must be contiguous",
            ));
        }
        if frame.duration_us == 0 {
            return Err(PerceptualError::ZeroDuration { index });
        }
        if !frame.signals_in_range() {
            return Err(PerceptualError::InvalidAnalysis(
                "signals must be finite values in 0..=1",
            ));
        }
        if let Some(previous) = previous_pts {
            if frame.pts_us <= previous {
                return Err(PerceptualError::NonMonotonicPts {
                    index,
                    previous,
                    current: frame.pts_us,
                });
            }
        }
        duration = duration
            .checked_add(frame.duration_us)
            .ok_or(PerceptualError::DurationOverflow)?;
        previous_pts = Some(frame.pts_us);
    }
    if duration != analysis.total_duration_us {
        return Err(PerceptualError::InvalidAnalysis(
            "total duration does not match frame durations",
        ));
    }
    Ok(())
}

fn validate_config(config: &SchedulerConfig) -> Result<(), PerceptualError> {
    validate_unit(config.retention_ratio, "retention_ratio")?;
    validate_unit(config.scene_change_threshold, "scene_change_threshold")?;
    validate_unit(
        config.duplicate_motion_threshold,
        "duplicate_motion_threshold",
    )?;
    validate_unit(config.low_value_threshold, "low_value_threshold")?;
    validate_unit(config.temporal_spacing_weight, "temporal_spacing_weight")?;
    if config.max_frames == Some(0) {
        return Err(PerceptualError::InvalidConfig("max_frames"));
    }
    Ok(())
}

fn validate_unit(value: f32, field: &'static str) -> Result<(), PerceptualError> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(PerceptualError::InvalidConfig(field))
    }
}

fn quantize_buckets(durations_us: &[u64], target_cs: u64) -> Result<Vec<u32>, PerceptualError> {
    let mut floor_sum = 0u64;
    let mut quantized = Vec::with_capacity(durations_us.len());
    let mut remainders = Vec::with_capacity(durations_us.len());
    for (index, duration) in durations_us.iter().copied().enumerate() {
        let floor = duration / CENTISECOND_US;
        floor_sum = floor_sum
            .checked_add(floor)
            .ok_or(PerceptualError::DelayOverflow)?;
        quantized.push(u32::try_from(floor).map_err(|_| PerceptualError::DelayOverflow)?);
        remainders.push((index, duration % CENTISECOND_US));
    }

    let additions = target_cs
        .checked_sub(floor_sum)
        .ok_or(PerceptualError::InvalidAnalysis(
            "quantized duration is less than bucket floors",
        ))?;
    remainders.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    if additions > remainders.len() as u64 {
        return Err(PerceptualError::InvalidAnalysis(
            "duration buckets do not sum to source duration",
        ));
    }
    for &(index, _) in remainders.iter().take(additions as usize) {
        quantized[index] = quantized[index]
            .checked_add(1)
            .ok_or(PerceptualError::DelayOverflow)?;
    }
    Ok(quantized)
}

fn round_centiseconds(duration_us: u64) -> Result<u64, PerceptualError> {
    duration_us
        .checked_add(CENTISECOND_US / 2)
        .map(|rounded| rounded / CENTISECOND_US)
        .ok_or(PerceptualError::DurationOverflow)
}

pub(crate) fn rgb_luma(r: u8, g: u8, b: u8) -> u8 {
    ((u32::from(r) * 54 + u32::from(g) * 183 + u32::from(b) * 19) >> 8) as u8
}

pub(crate) fn is_skin(r: u8, g: u8, b: u8) -> bool {
    let maximum = r.max(g).max(b);
    let minimum = r.min(g).min(b);
    let classic = r > 95
        && g > 40
        && b > 20
        && maximum.abs_diff(minimum) > 15
        && r.abs_diff(g) > 15
        && r > g
        && r > b;
    let bright = r > 200 && g > 170 && b > 120 && r >= g && g > b && r.abs_diff(g) <= 45;
    classic || bright
}

fn ratio(numerator: usize, denominator: usize) -> f32 {
    if denominator == 0 {
        0.0
    } else {
        clamp01(numerator as f32 / denominator as f32)
    }
}

fn normalized_mean(sum: u64, count: usize, maximum: f32) -> f32 {
    if count == 0 || maximum <= 0.0 {
        0.0
    } else {
        clamp01(sum as f32 / (count as f32 * maximum))
    }
}

fn clamp01(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDTH: u32 = 8;
    const HEIGHT: u32 = 8;
    const FRAME_US: u64 = 40_000;

    fn solid(rgb: [u8; 3], index: usize) -> Rgb24Frame {
        let pixels = (0..WIDTH * HEIGHT).flat_map(|_| rgb).collect::<Vec<_>>();
        Rgb24Frame::new(pixels, index as i64 * FRAME_US as i64, FRAME_US)
    }

    fn checker(index: usize, invert: bool) -> Rgb24Frame {
        let mut pixels = Vec::with_capacity((WIDTH * HEIGHT * 3) as usize);
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let light = ((x + y) % 2 == 0) ^ invert;
                pixels.extend_from_slice(if light { &[255, 255, 255] } else { &[0, 0, 0] });
            }
        }
        Rgb24Frame::new(pixels, index as i64 * FRAME_US as i64, FRAME_US)
    }

    fn horizontal_gradient(index: usize) -> Rgb24Frame {
        let mut pixels = Vec::with_capacity((WIDTH * HEIGHT * 3) as usize);
        for _y in 0..HEIGHT {
            for x in 0..WIDTH {
                let value = 48 + x as u8 * 8;
                pixels.extend_from_slice(&[value, value.saturating_add(4), value]);
            }
        }
        Rgb24Frame::new(pixels, index as i64 * FRAME_US as i64, FRAME_US)
    }

    fn localized_pulse(index: usize, active: bool) -> Rgb24Frame {
        let mut frame = solid([12, 14, 16], index);
        if active {
            for y in 3..5 {
                for x in 5..7 {
                    let offset = ((y * WIDTH + x) * 3) as usize;
                    frame.pixels[offset..offset + 3].copy_from_slice(&[240, 190, 72]);
                }
            }
        }
        frame
    }

    fn smooth_motion(index: usize) -> Rgb24Frame {
        let mut pixels = Vec::with_capacity((WIDTH * HEIGHT * 3) as usize);
        for _y in 0..HEIGHT {
            for x in 0..WIDTH {
                let value = 32 + x as u8 * 8 + index as u8 * 4;
                pixels.extend_from_slice(&[value, value.saturating_add(3), value]);
            }
        }
        Rgb24Frame::new(pixels, index as i64 * FRAME_US as i64, FRAME_US)
    }

    fn moving_line(index: usize) -> Rgb24Frame {
        let mut frame = solid([16, 18, 20], index);
        let x = index as u32 % WIDTH;
        for y in 0..HEIGHT {
            let offset = ((y * WIDTH + x) * 3) as usize;
            frame.pixels[offset..offset + 3].copy_from_slice(&[232, 236, 224]);
        }
        frame
    }

    fn moving_dot(index: usize) -> Rgb24Frame {
        let mut frame = solid([16, 18, 20], index);
        let x = index as u32 % WIDTH;
        let offset = ((3 * WIDTH + x) * 3) as usize;
        frame.pixels[offset..offset + 3].copy_from_slice(&[232, 236, 224]);
        frame
    }

    fn tiny_pixel_step(level: u8, pts_us: i64, duration_us: u64) -> Rgb24Frame {
        let mut pixels = vec![0; (WIDTH * HEIGHT * 3) as usize];
        pixels[..3].fill(level);
        Rgb24Frame::new(pixels, pts_us, duration_us)
    }

    fn timed_solid(level: u8, pts_us: i64, duration_us: u64) -> Rgb24Frame {
        Rgb24Frame::new(
            vec![level; (WIDTH * HEIGHT * 3) as usize],
            pts_us,
            duration_us,
        )
    }

    fn presentation_only_config() -> SchedulerConfig {
        SchedulerConfig {
            focus: PerceptualFocus::FlatArt,
            retention_ratio: 0.0,
            scene_change_threshold: 1.0,
            duplicate_motion_threshold: 1.0,
            low_value_threshold: 1.0,
            temporal_spacing_weight: 0.0,
            fill_target_with_subtle_changes: false,
            ..SchedulerConfig::default()
        }
    }

    fn kept_mask(analysis: &PerceptualAnalysis, schedule: &FrameSchedule) -> Vec<bool> {
        let mut kept = vec![false; analysis.frames.len()];
        for index in schedule.kept_indices() {
            kept[index] = true;
        }
        kept
    }

    fn analyze(frames: Vec<Rgb24Frame>) -> PerceptualAnalysis {
        analyze_rgb_frames(WIDTH, HEIGHT, &frames).expect("analyze test frames")
    }

    #[test]
    fn parses_focus_names_and_aliases() {
        assert_eq!(
            PerceptualFocus::parse("text-ui"),
            Ok(PerceptualFocus::TextUi)
        );
        assert_eq!(
            PerceptualFocus::parse("flat art"),
            Ok(PerceptualFocus::FlatArt)
        );
        assert!(PerceptualFocus::parse("cinematic").is_err());
    }

    #[test]
    fn auto_focus_uses_temporal_evidence_before_center_saliency() {
        let summary = PerceptualSummary {
            mean_motion: 0.011,
            mean_changed_area: 0.078,
            mean_subject_saliency: 0.90,
            mean_skin_ratio: 0.20,
            ..PerceptualSummary::default()
        };

        assert_eq!(
            summary.resolve_focus(PerceptualFocus::Auto),
            PerceptualFocus::Motion
        );
        assert_eq!(
            summary.resolve_focus(PerceptualFocus::Subject),
            PerceptualFocus::Subject
        );
    }

    #[test]
    fn auto_focus_recognizes_scrolling_ui_before_subject_saliency() {
        let summary = PerceptualSummary {
            mean_motion: 0.0025,
            mean_changed_area: 0.014,
            mean_edge_text: 0.31,
            mean_noise: 0.04,
            mean_subject_saliency: 1.0,
            mean_skin_ratio: 0.30,
            ..PerceptualSummary::default()
        };

        assert_eq!(
            summary.resolve_focus(PerceptualFocus::Auto),
            PerceptualFocus::TextUi
        );
    }

    #[test]
    fn auto_focus_separates_smooth_full_frame_color_motion_from_texture() {
        let smooth = PerceptualSummary {
            mean_motion: 0.052,
            mean_changed_area: 0.54,
            mean_edge_text: 0.054,
            mean_noise: 0.018,
            mean_smooth_gradient_ratio: 0.52,
            mean_subject_saliency: 0.66,
            ..PerceptualSummary::default()
        };
        let textured = PerceptualSummary {
            mean_edge_text: 0.15,
            ..smooth
        };

        assert!(smooth.is_smooth_color_motion());
        assert_eq!(
            smooth.resolve_focus(PerceptualFocus::Auto),
            PerceptualFocus::FlatArt
        );
        assert!(!textured.is_smooth_color_motion());
        assert_eq!(
            textured.resolve_focus(PerceptualFocus::Auto),
            PerceptualFocus::Motion
        );
    }

    #[test]
    fn smooth_gradient_ratio_separates_gradual_steps_from_fills_and_hard_edges() {
        let gradient = analyze(vec![horizontal_gradient(0)]);
        let solid_fill = analyze(vec![solid([80, 84, 80], 0)]);
        let hard_edges = analyze(vec![checker(0, false)]);

        assert!(gradient.frames[0].smooth_gradient_ratio >= 0.45);
        assert_eq!(solid_fill.frames[0].smooth_gradient_ratio, 0.0);
        assert_eq!(hard_edges.frames[0].smooth_gradient_ratio, 0.0);
        assert_eq!(
            gradient.summary().mean_smooth_gradient_ratio,
            gradient.frames[0].smooth_gradient_ratio
        );
    }

    #[test]
    fn rejects_incomplete_rgb24_frame_even_when_marked_truncated() {
        let mut frame = solid([0, 0, 0], 0);
        frame.pixels.pop();
        frame.truncated = true;
        assert!(matches!(
            analyze_rgb_frames(WIDTH, HEIGHT, &[frame]),
            Err(PerceptualError::InvalidFrameSize { .. })
        ));
    }

    #[test]
    fn every_signal_is_finite_and_in_range() {
        let mut center_subject = solid([20, 30, 40], 2);
        for y in 2..6 {
            for x in 2..6 {
                let offset = ((y * WIDTH + x) * 3) as usize;
                center_subject.pixels[offset..offset + 3].copy_from_slice(&[220, 170, 130]);
            }
        }
        let analysis = analyze(vec![solid([0, 0, 0], 0), checker(1, false), center_subject]);
        assert!(analysis.frames.iter().all(FrameSignals::signals_in_range));
        assert!(analysis.frames[1].motion > 0.0);
        assert!(analysis.frames[1].changed_area > 0.0);
        assert!(analysis.frames[1].edge_text > 0.0);
        assert!(analysis.frames[2].skin_ratio > 0.0);
        assert!(analysis.frames[2].subject_saliency > 0.0);
    }

    #[test]
    fn repeated_frames_are_compressed_to_first_and_last() {
        let frames = (0..8).map(|index| solid([32, 32, 32], index)).collect();
        let analysis = analyze(frames);
        let schedule = schedule_frames(&analysis, &SchedulerConfig::default()).expect("schedule");

        assert_eq!(schedule.kept_indices(), vec![0, 7]);
        assert!(matches!(
            schedule.dispositions[3],
            FrameDisposition::DropAndHold {
                held_by_source_index: 0,
                ..
            }
        ));
        assert_eq!(
            maximum_dynamic_hold_us(&analysis, &kept_mask(&analysis, &schedule)),
            0
        );
    }

    #[test]
    fn localized_short_pulse_promotes_both_presentation_edges() {
        let frames = (0..12)
            .map(|index| localized_pulse(index, (4..7).contains(&index)))
            .collect();
        let analysis = analyze(frames);
        let mut safety_kept = vec![false; analysis.frames.len()];
        safety_kept[0] = true;
        safety_kept[11] = true;
        let safety = promote_presentation_safety(&analysis, &mut safety_kept, 12);
        let schedule = schedule_frames(&analysis, &presentation_only_config()).expect("schedule");

        assert_eq!(safety.rescue_count, 2);
        assert_eq!(safety.max_dynamic_hold_us, 0);
        assert_eq!(schedule.kept_indices(), vec![0, 4, 7, 11]);
        assert!(is_localized_transition_spike(&analysis, 4));
        assert!(is_localized_transition_spike(&analysis, 7));
        assert_eq!(
            maximum_dynamic_hold_us(&analysis, &kept_mask(&analysis, &schedule)),
            0
        );
    }

    #[test]
    fn smooth_full_frame_motion_is_time_bounded_without_all_frame_rescue() {
        let analysis = analyze((0..12).map(smooth_motion).collect());
        let schedule = schedule_frames(&analysis, &presentation_only_config()).expect("schedule");

        assert_eq!(schedule.kept_indices(), vec![0, 4, 8, 11]);
        assert_eq!(
            maximum_dynamic_hold_us(&analysis, &kept_mask(&analysis, &schedule)),
            120_000
        );
        assert!(analysis
            .frames
            .iter()
            .enumerate()
            .all(|(index, _)| !is_localized_transition_spike(&analysis, index)));
    }

    #[test]
    fn dynamic_line_art_is_time_bounded_without_all_frame_rescue() {
        let analysis = analyze((0..8).map(moving_line).collect());
        let schedule = schedule_frames(&analysis, &presentation_only_config()).expect("schedule");

        assert_eq!(schedule.kept_indices(), vec![0, 4, 7]);
        assert!(analysis.frames[1..]
            .iter()
            .all(|frame| frame.changed_area > PRESENTATION_LOCAL_SPIKE_MAX_CHANGED_AREA));
        assert!(analysis
            .frames
            .iter()
            .enumerate()
            .all(|(index, _)| !is_localized_transition_spike(&analysis, index)));
    }

    #[test]
    fn continuous_local_motion_is_not_misclassified_as_a_spike() {
        let analysis = analyze((0..8).map(moving_dot).collect());
        let schedule = schedule_frames(&analysis, &presentation_only_config()).expect("schedule");

        assert!(analysis.frames[1..].iter().all(|frame| {
            (PRESENTATION_LOCAL_SPIKE_MIN_CHANGED_AREA..=PRESENTATION_LOCAL_SPIKE_MAX_CHANGED_AREA)
                .contains(&frame.changed_area)
        }));
        assert!(analysis
            .frames
            .iter()
            .enumerate()
            .all(|(index, _)| !is_localized_transition_spike(&analysis, index)));
        assert_eq!(schedule.kept_indices(), vec![0, 4, 7]);
    }

    #[test]
    fn dynamic_hold_limit_uses_source_duration_instead_of_frame_count() {
        let mut short_pts = 0i64;
        let short = (0..20)
            .map(|index| {
                let frame = tiny_pixel_step(index as u8, short_pts, 5_000);
                short_pts += 5_000;
                frame
            })
            .collect();
        let short_analysis = analyze(short);
        let short_schedule =
            schedule_frames(&short_analysis, &presentation_only_config()).expect("short schedule");
        assert_eq!(short_schedule.kept_indices(), vec![0, 19]);

        let long = vec![
            timed_solid(0, 0, 40_000),
            timed_solid(16, 40_000, 170_000),
            timed_solid(32, 210_000, 40_000),
        ];
        let long_analysis = analyze(long);
        let long_schedule =
            schedule_frames(&long_analysis, &presentation_only_config()).expect("long schedule");
        assert_eq!(long_schedule.kept_indices(), vec![0, 1, 2]);
    }

    #[test]
    fn explicit_max_frames_caps_presentation_rescues() {
        let analysis = analyze((0..8).map(moving_line).collect());
        let mut safety_kept = vec![false; analysis.frames.len()];
        safety_kept[0] = true;
        safety_kept[7] = true;
        let safety = promote_presentation_safety(&analysis, &mut safety_kept, 2);
        let config = SchedulerConfig {
            max_frames: Some(2),
            ..presentation_only_config()
        };
        let schedule = schedule_frames(&analysis, &config).expect("schedule");
        let kept = kept_mask(&analysis, &schedule);

        assert_eq!(safety.rescue_count, 0);
        assert_eq!(safety.max_dynamic_hold_us, 240_000);
        assert_eq!(schedule.kept_indices(), vec![0, 7]);
        assert!(maximum_dynamic_hold_us(&analysis, &kept) > PRESENTATION_DYNAMIC_HOLD_LIMIT_US);
    }

    #[test]
    fn presentation_safety_never_revives_an_explicit_exclusion() {
        let mut frames = (0..6).map(moving_line).collect::<Vec<_>>();
        frames[2].excluded = true;
        let analysis = analyze(frames);
        let schedule = schedule_frames(&analysis, &presentation_only_config()).expect("schedule");

        assert_eq!(schedule.kept_indices(), vec![0, 4, 5]);
        assert!(matches!(
            schedule.dispositions[2],
            FrameDisposition::DropAndHold {
                explicitly_excluded: true,
                ..
            }
        ));
    }

    #[test]
    fn slow_fade_receives_temporally_spaced_rescue_frames() {
        let frames = (0..12)
            .map(|index| solid([32 + index as u8; 3], index))
            .collect();
        let analysis = analyze(frames);
        assert!(analysis.frames[1].motion < SchedulerConfig::default().duplicate_motion_threshold);
        assert!(analysis
            .frames
            .iter()
            .all(|frame| frame.scene_change < 0.01));

        let schedule = schedule_frames(&analysis, &SchedulerConfig::default()).expect("schedule");
        let indices = schedule.kept_indices();
        assert!(indices.len() > 2, "{indices:?}");
        assert!(
            indices.iter().any(|index| (3..=8).contains(index)),
            "{indices:?}"
        );
    }

    #[test]
    fn forced_target_fill_keeps_tight_subtle_changes_but_not_exact_duplicates() {
        let frames = (0..60)
            .map(|index| {
                let level = 32 + if index >= 25 { index - 1 } else { index } as u8;
                solid([level; 3], index)
            })
            .collect();
        let analysis = analyze(frames);
        assert_eq!(analysis.frames[25].motion, 0.0);
        assert_eq!(analysis.frames[25].changed_area, 0.0);

        let conservative = SchedulerConfig {
            focus: PerceptualFocus::Motion,
            retention_ratio: 1.0,
            duplicate_motion_threshold: 0.5,
            low_value_threshold: 1.0,
            ..SchedulerConfig::default()
        };
        let conservative_schedule =
            schedule_frames(&analysis, &conservative).expect("conservative schedule");
        assert!(
            conservative_schedule.kept_indices().len() < 59,
            "{:?}",
            conservative_schedule.kept_indices()
        );

        let filled = SchedulerConfig {
            fill_target_with_subtle_changes: true,
            ..conservative
        };
        let filled_schedule = schedule_frames(&analysis, &filled).expect("filled schedule");
        let indices = filled_schedule.kept_indices();
        assert_eq!(indices.len(), 59, "{indices:?}");
        assert!(!indices.contains(&25), "{indices:?}");
    }

    #[test]
    fn strong_scene_change_is_always_retained() {
        let analysis = analyze(vec![
            solid([0, 0, 0], 0),
            solid([0, 0, 0], 1),
            solid([255, 255, 255], 2),
            solid([255, 255, 255], 3),
            solid([255, 255, 255], 4),
        ]);
        assert!(analysis.frames[2].scene_change >= 0.62);
        let config = SchedulerConfig {
            retention_ratio: 0.0,
            max_frames: Some(1),
            ..SchedulerConfig::default()
        };
        let schedule = schedule_frames(&analysis, &config).expect("schedule");

        assert_eq!(schedule.kept_indices(), vec![0, 2, 4]);
        assert!(schedule.frames[1].scene_boundary);
    }

    #[test]
    fn focus_changes_the_ranking_weights() {
        let subject = FrameSignals {
            source_index: 0,
            pts_us: 0,
            duration_us: FRAME_US,
            excluded: false,
            truncated: false,
            motion: 0.08,
            scene_change: 0.10,
            edge_text: 0.12,
            subject_saliency: 0.95,
            skin_ratio: 0.70,
            noise: 0.05,
            smooth_gradient_ratio: 0.0,
            compression_cost: 0.20,
            changed_area: 0.15,
        };
        let moving = FrameSignals {
            source_index: 1,
            pts_us: FRAME_US as i64,
            duration_us: FRAME_US,
            excluded: false,
            truncated: false,
            motion: 0.92,
            scene_change: 0.10,
            edge_text: 0.10,
            subject_saliency: 0.05,
            skin_ratio: 0.0,
            noise: 0.08,
            smooth_gradient_ratio: 0.0,
            compression_cost: 0.20,
            changed_area: 0.90,
        };

        assert!(
            frame_importance(&subject, PerceptualFocus::Subject)
                > frame_importance(&moving, PerceptualFocus::Subject)
        );
        assert!(
            frame_importance(&moving, PerceptualFocus::Motion)
                > frame_importance(&subject, PerceptualFocus::Motion)
        );
    }

    #[test]
    fn explicit_exclusion_overrides_first_last_and_scene_rules() {
        let mut first = solid([0, 0, 0], 0);
        first.excluded = true;
        let mut scene = solid([255, 255, 255], 2);
        scene.excluded = true;
        let mut last = solid([255, 255, 255], 4);
        last.excluded = true;
        let analysis = analyze(vec![
            first,
            solid([0, 0, 0], 1),
            scene,
            solid([255, 255, 255], 3),
            last,
        ]);
        let schedule = schedule_frames(&analysis, &SchedulerConfig::default()).expect("schedule");

        assert_eq!(schedule.kept_indices(), vec![1, 3]);
        for index in [0, 2, 4] {
            assert!(matches!(
                schedule.dispositions[index],
                FrameDisposition::DropAndHold {
                    explicitly_excluded: true,
                    ..
                }
            ));
        }
    }

    #[test]
    fn centisecond_delays_conserve_rounded_source_duration() {
        let durations = [16_667u64, 16_667, 16_667, 33_333, 8_333];
        let mut pts = 0i64;
        let frames = durations
            .into_iter()
            .enumerate()
            .map(|(index, duration)| {
                let mut frame = solid([index as u8 * 30; 3], index);
                frame.pts_us = pts;
                frame.duration_us = duration;
                pts += duration as i64;
                frame
            })
            .collect::<Vec<_>>();
        let analysis = analyze(frames);
        let schedule = schedule_frames(&analysis, &SchedulerConfig::default()).expect("schedule");
        let emitted = schedule
            .frames
            .iter()
            .map(|frame| u64::from(frame.delay_cs))
            .sum::<u64>();

        assert_eq!(schedule.source_duration_us, 91_667);
        assert_eq!(schedule.quantized_duration_cs, 9);
        assert_eq!(emitted, schedule.quantized_duration_cs);
    }

    #[test]
    fn truncated_input_flag_is_propagated() {
        let mut final_frame = solid([60, 60, 60], 1);
        final_frame.truncated = true;
        let analysis = analyze(vec![solid([20, 20, 20], 0), final_frame]);
        let schedule = schedule_frames(&analysis, &SchedulerConfig::default()).expect("schedule");
        assert!(analysis.input_truncated);
        assert!(schedule.input_truncated);
    }

    #[test]
    fn analysis_and_schedule_are_deterministic() {
        let source = vec![
            solid([0, 0, 0], 0),
            checker(1, false),
            checker(2, true),
            solid([40, 80, 120], 3),
            solid([40, 80, 120], 4),
        ];
        let first_analysis = analyze_rgb_frames(WIDTH, HEIGHT, &source).expect("first analysis");
        let second_analysis = analyze_rgb_frames(WIDTH, HEIGHT, &source).expect("second analysis");
        assert_eq!(first_analysis, second_analysis);

        let config = SchedulerConfig {
            focus: PerceptualFocus::Motion,
            retention_ratio: 0.5,
            ..SchedulerConfig::default()
        };
        assert_eq!(
            schedule_frames(&first_analysis, &config),
            schedule_frames(&second_analysis, &config)
        );
    }
}
