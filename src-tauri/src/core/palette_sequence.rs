//! Deterministic scene segmentation for stable palette planning.
//!
//! The planner consumes already-audited perceptual signals and the final
//! Drop-and-Hold schedule. It never decodes pixels and does not decide whether
//! a segment palette reaches the encoder; that remains a quality-gated caller
//! decision.

use super::perceptual::{FrameSchedule, PerceptualAnalysis};
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

pub const MAX_PALETTE_SEGMENTS: usize = 4;
const HARD_CUT_THRESHOLD: f32 = 0.42;
const COLOR_DRIFT_THRESHOLD: f32 = 0.22;
const COLOR_DRIFT_CHANGED_AREA: f32 = 0.08;
const MOTION_SHIFT_THRESHOLD: f32 = 0.08;
const CHANGED_AREA_SHIFT_THRESHOLD: f32 = 0.15;
const SOFT_BOUNDARY_SCORE_THRESHOLD: f32 = 0.28;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PaletteBoundaryReason {
    HardCut,
    ColorDrift,
    MotionShift,
}

impl PaletteBoundaryReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HardCut => "hard_cut",
            Self::ColorDrift => "color_drift",
            Self::MotionShift => "motion_shift",
        }
    }

    const fn code(self) -> u8 {
        match self {
            Self::HardCut => 1,
            Self::ColorDrift => 2,
            Self::MotionShift => 3,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaletteSegment {
    pub start_schedule_index: u32,
    pub end_schedule_index_exclusive: u32,
    pub start_source_index: u32,
    pub end_source_index: u32,
    pub duration_cs: u64,
    pub boundary_before: Option<PaletteBoundaryReason>,
    /// Quantized `0..=1000` score used for deterministic audit output.
    pub boundary_score_milli: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaletteSegmentationArtifact {
    pub segments: Vec<PaletteSegment>,
    pub hard_cut_count: u16,
    pub sha256: String,
}

impl PaletteSegmentationArtifact {
    pub fn frame_ranges(&self) -> Vec<(usize, usize)> {
        self.segments
            .iter()
            .map(|segment| {
                (
                    segment.start_schedule_index as usize,
                    segment.end_schedule_index_exclusive as usize,
                )
            })
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PaletteSegmentationError {
    EmptySchedule,
    SourceIndexOutOfRange {
        schedule_index: usize,
        source_index: usize,
    },
    NonIncreasingSourceIndex {
        schedule_index: usize,
        previous: usize,
        current: usize,
    },
    IndexOverflow,
    DurationOverflow,
}

impl fmt::Display for PaletteSegmentationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptySchedule => formatter.write_str("palette segmentation requires a schedule"),
            Self::SourceIndexOutOfRange {
                schedule_index,
                source_index,
            } => write!(
                formatter,
                "schedule frame {schedule_index} references missing source frame {source_index}"
            ),
            Self::NonIncreasingSourceIndex {
                schedule_index,
                previous,
                current,
            } => write!(
                formatter,
                "schedule frame {schedule_index} source index {current} does not follow {previous}"
            ),
            Self::IndexOverflow => formatter.write_str("palette segment index exceeds u32"),
            Self::DurationOverflow => {
                formatter.write_str("palette segment duration overflowed u64")
            }
        }
    }
}

impl Error for PaletteSegmentationError {}

#[derive(Clone, Copy, Debug)]
struct BoundaryCandidate {
    schedule_index: usize,
    reason: PaletteBoundaryReason,
    score_milli: u16,
}

impl BoundaryCandidate {
    fn hard_cut(self) -> bool {
        self.reason == PaletteBoundaryReason::HardCut
    }
}

pub fn plan_palette_segments(
    analysis: &PerceptualAnalysis,
    schedule: &FrameSchedule,
) -> Result<PaletteSegmentationArtifact, PaletteSegmentationError> {
    validate_schedule(analysis, schedule)?;

    let mut candidates = Vec::<BoundaryCandidate>::new();
    for source_index in 1..analysis.frames.len() {
        let schedule_index = schedule
            .frames
            .partition_point(|frame| frame.source_index < source_index);
        if schedule_index == 0 || schedule_index >= schedule.frames.len() {
            continue;
        }
        let previous = &analysis.frames[source_index - 1];
        let current = &analysis.frames[source_index];
        let motion_shift = (current.motion - previous.motion).abs();
        let changed_area_shift = (current.changed_area - previous.changed_area).abs();
        let hard_cut = current.scene_change >= HARD_CUT_THRESHOLD
            || (schedule.frames[schedule_index].source_index == source_index
                && schedule.frames[schedule_index].scene_boundary);
        let color_drift = current.scene_change >= COLOR_DRIFT_THRESHOLD
            && current.changed_area >= COLOR_DRIFT_CHANGED_AREA;
        let motion_state_shift = motion_shift >= MOTION_SHIFT_THRESHOLD
            || changed_area_shift >= CHANGED_AREA_SHIFT_THRESHOLD;
        let raw_score =
            current.scene_change * 0.68 + motion_shift * 0.18 + changed_area_shift * 0.14;
        let reason = if hard_cut {
            Some(PaletteBoundaryReason::HardCut)
        } else if color_drift {
            Some(PaletteBoundaryReason::ColorDrift)
        } else if motion_state_shift && raw_score >= SOFT_BOUNDARY_SCORE_THRESHOLD {
            Some(PaletteBoundaryReason::MotionShift)
        } else {
            None
        };
        if let Some(reason) = reason {
            let score = if reason == PaletteBoundaryReason::HardCut {
                raw_score.max(1.0)
            } else {
                raw_score
            };
            let candidate = BoundaryCandidate {
                schedule_index,
                reason,
                score_milli: (score.clamp(0.0, 1.0) * 1_000.0).round() as u16,
            };
            if let Some(existing) = candidates
                .iter_mut()
                .find(|existing| existing.schedule_index == schedule_index)
            {
                let replace = candidate.hard_cut() && !existing.hard_cut()
                    || candidate.hard_cut() == existing.hard_cut()
                        && candidate.score_milli > existing.score_milli;
                if replace {
                    *existing = candidate;
                }
            } else {
                candidates.push(candidate);
            }
        }
    }

    candidates.sort_by(|left, right| {
        right
            .hard_cut()
            .cmp(&left.hard_cut())
            .then_with(|| right.score_milli.cmp(&left.score_milli))
            .then_with(|| left.schedule_index.cmp(&right.schedule_index))
    });
    let mut selected = Vec::new();
    for candidate in candidates {
        if selected.len() >= MAX_PALETTE_SEGMENTS - 1 {
            break;
        }
        let soft_has_context = candidate.hard_cut()
            || (schedule.frames.len() >= 3
                && candidate.schedule_index > 0
                && candidate.schedule_index < schedule.frames.len()
                && selected.iter().all(|existing: &BoundaryCandidate| {
                    existing.schedule_index != candidate.schedule_index
                }));
        if soft_has_context {
            selected.push(candidate);
        }
    }
    selected.sort_by_key(|candidate| candidate.schedule_index);

    let mut boundaries = Vec::with_capacity(selected.len() + 2);
    boundaries.push(0);
    boundaries.extend(selected.iter().map(|candidate| candidate.schedule_index));
    boundaries.push(schedule.frames.len());
    let mut segments = Vec::with_capacity(boundaries.len() - 1);
    for (segment_index, window) in boundaries.windows(2).enumerate() {
        let start = window[0];
        let end = window[1];
        let duration_cs = schedule.frames[start..end]
            .iter()
            .try_fold(0_u64, |total, frame| {
                total
                    .checked_add(u64::from(frame.delay_cs))
                    .ok_or(PaletteSegmentationError::DurationOverflow)
            })?;
        let boundary = segment_index
            .checked_sub(1)
            .and_then(|index| selected.get(index));
        segments.push(PaletteSegment {
            start_schedule_index: u32::try_from(start)
                .map_err(|_| PaletteSegmentationError::IndexOverflow)?,
            end_schedule_index_exclusive: u32::try_from(end)
                .map_err(|_| PaletteSegmentationError::IndexOverflow)?,
            start_source_index: u32::try_from(schedule.frames[start].source_index)
                .map_err(|_| PaletteSegmentationError::IndexOverflow)?,
            end_source_index: u32::try_from(schedule.frames[end - 1].source_index)
                .map_err(|_| PaletteSegmentationError::IndexOverflow)?,
            duration_cs,
            boundary_before: boundary.map(|candidate| candidate.reason),
            boundary_score_milli: boundary.map_or(0, |candidate| candidate.score_milli),
        });
    }

    let hard_cut_count = u16::try_from(
        selected
            .iter()
            .filter(|candidate| candidate.hard_cut())
            .count(),
    )
    .expect("at most three palette boundaries");
    let sha256 = segmentation_sha256(&segments, hard_cut_count);
    Ok(PaletteSegmentationArtifact {
        segments,
        hard_cut_count,
        sha256,
    })
}

fn validate_schedule(
    analysis: &PerceptualAnalysis,
    schedule: &FrameSchedule,
) -> Result<(), PaletteSegmentationError> {
    if schedule.frames.is_empty() {
        return Err(PaletteSegmentationError::EmptySchedule);
    }
    let mut previous = None;
    for (schedule_index, frame) in schedule.frames.iter().enumerate() {
        if frame.source_index >= analysis.frames.len() {
            return Err(PaletteSegmentationError::SourceIndexOutOfRange {
                schedule_index,
                source_index: frame.source_index,
            });
        }
        if let Some(previous) = previous {
            if frame.source_index <= previous {
                return Err(PaletteSegmentationError::NonIncreasingSourceIndex {
                    schedule_index,
                    previous,
                    current: frame.source_index,
                });
            }
        }
        previous = Some(frame.source_index);
    }
    Ok(())
}

fn segmentation_sha256(segments: &[PaletteSegment], hard_cut_count: u16) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.palette-segmentation.v1\0");
    hasher.update((segments.len() as u64).to_le_bytes());
    hasher.update(hard_cut_count.to_le_bytes());
    for segment in segments {
        hasher.update(segment.start_schedule_index.to_le_bytes());
        hasher.update(segment.end_schedule_index_exclusive.to_le_bytes());
        hasher.update(segment.start_source_index.to_le_bytes());
        hasher.update(segment.end_source_index.to_le_bytes());
        hasher.update(segment.duration_cs.to_le_bytes());
        hasher.update([segment
            .boundary_before
            .map_or(0, PaletteBoundaryReason::code)]);
        hasher.update(segment.boundary_score_milli.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::perceptual::{
        FrameDisposition, FrameSignals, PerceptualFocus, ScheduledFrame,
    };

    fn signal(index: usize, scene_change: f32, motion: f32, changed_area: f32) -> FrameSignals {
        FrameSignals {
            source_index: index,
            pts_us: index as i64 * 100_000,
            duration_us: 100_000,
            excluded: false,
            truncated: false,
            motion,
            scene_change,
            edge_text: 0.1,
            subject_saliency: 0.1,
            skin_ratio: 0.0,
            noise: 0.0,
            smooth_gradient_ratio: 0.0,
            compression_cost: 0.1,
            changed_area,
        }
    }

    fn fixture(values: &[(f32, f32, f32)]) -> (PerceptualAnalysis, FrameSchedule) {
        let frames = values
            .iter()
            .enumerate()
            .map(|(index, (scene, motion, changed))| signal(index, *scene, *motion, *changed))
            .collect::<Vec<_>>();
        let scheduled = frames
            .iter()
            .map(|frame| ScheduledFrame {
                source_index: frame.source_index,
                pts_us: frame.pts_us,
                delay_cs: 10,
                importance: 0.5,
                scene_boundary: frame.scene_change >= HARD_CUT_THRESHOLD,
            })
            .collect::<Vec<_>>();
        let frame_count = frames.len();
        (
            PerceptualAnalysis {
                width: 1,
                height: 1,
                frames,
                total_duration_us: frame_count as u64 * 100_000,
                input_truncated: false,
            },
            FrameSchedule {
                frames: scheduled,
                dispositions: (0..frame_count)
                    .map(|schedule_index| FrameDisposition::Kept { schedule_index })
                    .collect(),
                resolved_focus: PerceptualFocus::FlatArt,
                source_duration_us: frame_count as u64 * 100_000,
                quantized_duration_cs: frame_count as u64 * 10,
                input_truncated: false,
            },
        )
    }

    #[test]
    fn stable_timeline_produces_one_deterministic_segment() {
        let (analysis, schedule) = fixture(&[(0.0, 0.01, 0.01); 5]);
        let first = plan_palette_segments(&analysis, &schedule).expect("segmentation");
        let second = plan_palette_segments(&analysis, &schedule).expect("segmentation");
        assert_eq!(first, second);
        assert_eq!(first.segments.len(), 1);
        assert_eq!(first.frame_ranges(), vec![(0, 5)]);
        assert_eq!(first.sha256.len(), 64);
    }

    #[test]
    fn hard_cuts_take_priority_and_segment_count_is_capped() {
        let (analysis, schedule) = fixture(&[
            (0.0, 0.01, 0.01),
            (0.8, 0.4, 0.8),
            (0.9, 0.5, 0.9),
            (0.7, 0.3, 0.7),
            (0.95, 0.6, 0.9),
            (0.0, 0.01, 0.01),
        ]);
        let artifact = plan_palette_segments(&analysis, &schedule).expect("segmentation");
        assert_eq!(artifact.segments.len(), MAX_PALETTE_SEGMENTS);
        assert_eq!(artifact.hard_cut_count, 3);
        assert!(artifact.segments[1..]
            .iter()
            .all(|segment| segment.boundary_before == Some(PaletteBoundaryReason::HardCut)));
        assert_eq!(
            artifact
                .segments
                .iter()
                .map(|segment| segment.duration_cs)
                .sum::<u64>(),
            60
        );
    }

    #[test]
    fn soft_color_drift_requires_context_on_both_sides() {
        let (analysis, schedule) = fixture(&[
            (0.0, 0.01, 0.01),
            (0.30, 0.03, 0.20),
            (0.0, 0.02, 0.02),
            (0.35, 0.04, 0.30),
            (0.0, 0.02, 0.02),
            (0.0, 0.01, 0.01),
        ]);
        let artifact = plan_palette_segments(&analysis, &schedule).expect("segmentation");
        assert_eq!(artifact.frame_ranges(), vec![(0, 1), (1, 3), (3, 6)]);
        assert!(artifact.segments[1..]
            .iter()
            .all(|segment| segment.boundary_before == Some(PaletteBoundaryReason::ColorDrift)));
    }

    #[test]
    fn invalid_schedule_source_index_is_rejected() {
        let (analysis, mut schedule) = fixture(&[(0.0, 0.0, 0.0); 2]);
        schedule.frames[1].source_index = 99;
        assert!(matches!(
            plan_palette_segments(&analysis, &schedule),
            Err(PaletteSegmentationError::SourceIndexOutOfRange { .. })
        ));
    }
}
