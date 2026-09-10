//! Validated indexed-frame GIF container writer.
//!
//! GIFP owns the timeline, palette, index buffers, rectangles, transparency,
//! and disposal policy. The permissively licensed `gif` crate is deliberately
//! restricted to container serialization and LZW compression.

use gif::{DisposalMethod, Encoder, Frame, Repeat};
use sha2::{Digest, Sha256};
use std::{borrow::Cow, error::Error, fmt, io::Write};

pub const GIF_GLOBAL_PALETTE_ENTRIES: usize = 256;
pub const GIF_TRANSPARENT_INDEX: u8 = 255;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IndexedGifRepeat {
    None,
    Infinite,
}

#[allow(dead_code)] // Public disposal contract; encoder selection does not emit every mode yet.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IndexedGifDisposal {
    Unspecified,
    Keep,
    Background,
    Previous,
}

impl IndexedGifDisposal {
    const fn code(self) -> u8 {
        match self {
            Self::Unspecified => 0,
            Self::Keep => 1,
            Self::Background => 2,
            Self::Previous => 3,
        }
    }

    const fn as_gif(self) -> DisposalMethod {
        match self {
            Self::Unspecified => DisposalMethod::Any,
            Self::Keep => DisposalMethod::Keep,
            Self::Background => DisposalMethod::Background,
            Self::Previous => DisposalMethod::Previous,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedGifFrame {
    pub left: u16,
    pub top: u16,
    pub width: u16,
    pub height: u16,
    pub delay_cs: u16,
    pub disposal: IndexedGifDisposal,
    pub transparent_index: Option<u8>,
    /// Optional power-of-two RGB Local Color Table for this frame.
    pub local_palette_rgb: Option<Vec<u8>>,
    pub indices: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedGifPlan {
    pub width: u16,
    pub height: u16,
    /// Power-of-two RGB Global Color Table with 2..=256 entries.
    pub global_palette_rgb: Vec<u8>,
    pub repeat: IndexedGifRepeat,
    pub frames: Vec<IndexedGifFrame>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedGifWriteReport {
    pub frame_count: u32,
    pub full_frame_count: u32,
    pub total_indexed_pixels: u64,
    pub total_delay_cs: u64,
    pub local_palette_frame_count: u32,
    pub global_palette_sha256: String,
    pub local_palette_sequence_sha256: Option<String>,
    pub indexed_timeline_sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IndexedGifOptimizationReport {
    pub original_indexed_pixels: u64,
    pub optimized_indexed_pixels: u64,
    pub rectangle_frame_count: u32,
    pub transparent_hold_frame_count: u32,
    pub palette_boundary_full_frame_count: u32,
    pub background_disposal_frame_count: u32,
    pub previous_disposal_frame_count: u32,
    pub disposal_candidate_count: u8,
    pub selected_disposal_strategy: String,
    pub indexed_pixel_reduction_percent: f64,
    pub disposal_simulation_verified: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedGifPaletteCompactionReport {
    pub original_global_palette_entries: u16,
    pub compacted_global_palette_entries: u16,
    pub original_local_palette_entries: u64,
    pub compacted_local_palette_entries: u64,
    pub compacted_local_palette_frame_count: u32,
    pub remapped_frame_count: u32,
    pub display_simulation_verified: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexedGifError {
    ZeroCanvas,
    InvalidGlobalPaletteSize {
        actual: usize,
    },
    InvalidLocalPaletteSize {
        index: usize,
        actual: usize,
    },
    PaletteIndexOutOfRange {
        frame_index: usize,
        pixel_index: usize,
        value: u8,
        palette_entries: usize,
    },
    EmptyTimeline,
    ZeroFrame {
        index: usize,
    },
    FrameOutsideCanvas {
        index: usize,
    },
    InvalidFrameBufferSize {
        index: usize,
        expected: usize,
        actual: usize,
    },
    InvalidTransparentIndex {
        index: usize,
        value: u8,
    },
    RectangleOptimizationRequiresFullFrames {
        index: usize,
    },
    TransparentSourceOptimizationUnsupported {
        index: usize,
    },
    DisposalSimulationMismatch,
    CountOverflow,
    Encoding(String),
}

struct PendingRgbaDisposal {
    method: IndexedGifDisposal,
    left: u16,
    top: u16,
    width: u16,
    height: u16,
    restore: Option<Vec<u8>>,
}

impl fmt::Display for IndexedGifError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroCanvas => formatter.write_str("indexed GIF canvas must be non-zero"),
            Self::InvalidGlobalPaletteSize { actual } => write!(
                formatter,
                "indexed GIF global palette has {actual} RGB bytes; expected 2..=256 power-of-two RGB entries"
            ),
            Self::InvalidLocalPaletteSize {
                index,
                actual,
            } => write!(
                formatter,
                "indexed GIF frame {index} local palette has {actual} RGB bytes; expected 2..=256 power-of-two RGB entries"
            ),
            Self::PaletteIndexOutOfRange {
                frame_index,
                pixel_index,
                value,
                palette_entries,
            } => write!(
                formatter,
                "indexed GIF frame {frame_index} pixel {pixel_index} uses palette index {value}; active table has {palette_entries} entries"
            ),
            Self::EmptyTimeline => {
                formatter.write_str("indexed GIF timeline requires at least one frame")
            }
            Self::ZeroFrame { index } => {
                write!(formatter, "indexed GIF frame {index} has a zero dimension")
            }
            Self::FrameOutsideCanvas { index } => write!(
                formatter,
                "indexed GIF frame {index} extends outside the logical screen"
            ),
            Self::InvalidFrameBufferSize {
                index,
                expected,
                actual,
            } => write!(
                formatter,
                "indexed GIF frame {index} has {actual} indices; expected {expected}"
            ),
            Self::InvalidTransparentIndex { index, value } => write!(
                formatter,
                "indexed GIF frame {index} uses transparent index {value} outside its active color table"
            ),
            Self::RectangleOptimizationRequiresFullFrames { index } => write!(
                formatter,
                "indexed GIF rectangle optimization requires a full-size source frame at index {index}"
            ),
            Self::TransparentSourceOptimizationUnsupported { index } => write!(
                formatter,
                "indexed GIF rectangle optimization does not yet flatten source transparency in frame {index}"
            ),
            Self::DisposalSimulationMismatch => formatter.write_str(
                "indexed GIF optimized rectangles do not reconstruct the source display timeline",
            ),
            Self::CountOverflow => formatter.write_str("indexed GIF report count overflow"),
            Self::Encoding(message) => write!(formatter, "indexed GIF encoding failed: {message}"),
        }
    }
}

impl Error for IndexedGifError {}

/// Validate and serialize a GIFP-owned indexed timeline.
///
/// Validation completes before the first byte is written, so a caller can
/// safely fall back to another backend without mistaking a partial file for a
/// successful GIF.
pub fn write_indexed_gif<W: Write>(
    writer: W,
    plan: &IndexedGifPlan,
) -> Result<IndexedGifWriteReport, IndexedGifError> {
    let report = validate_and_report(plan)?;
    let mut encoder = Encoder::new(writer, plan.width, plan.height, &plan.global_palette_rgb)
        .map_err(|error| IndexedGifError::Encoding(error.to_string()))?;
    match plan.repeat {
        IndexedGifRepeat::None => {}
        IndexedGifRepeat::Infinite => encoder
            .set_repeat(Repeat::Infinite)
            .map_err(|error| IndexedGifError::Encoding(error.to_string()))?,
    }
    for indexed in &plan.frames {
        let frame = Frame {
            delay: indexed.delay_cs,
            dispose: indexed.disposal.as_gif(),
            transparent: indexed.transparent_index,
            needs_user_input: false,
            top: indexed.top,
            left: indexed.left,
            width: indexed.width,
            height: indexed.height,
            interlaced: false,
            palette: indexed.local_palette_rgb.clone(),
            buffer: Cow::Borrowed(&indexed.indices),
        };
        encoder
            .write_frame(&frame)
            .map_err(|error| IndexedGifError::Encoding(error.to_string()))?;
    }
    encoder
        .into_inner()
        .map_err(|error| IndexedGifError::Encoding(error.to_string()))?;
    Ok(report)
}

/// Densely remap every active color table while preserving the displayed RGBA
/// timeline, frame geometry, delays, transparency, and disposal semantics.
///
/// The Global Color Table keeps its logical-screen background color at index
/// zero. Local tables are independent per frame. Both table kinds retain only
/// referenced entries, pad to the next GIF power-of-two size, and move used
/// indices into a contiguous low range so the LZW writer can use the smallest
/// valid initial code width.
pub fn compact_indexed_palette_tables(
    plan: &IndexedGifPlan,
) -> Result<(IndexedGifPlan, IndexedGifPaletteCompactionReport), IndexedGifError> {
    validate_and_report(plan)?;
    let source_displayed = simulate_indexed_gif(plan)?;
    let original_global_palette_entries = palette_entries(&plan.global_palette_rgb);
    let original_local_palette_entries = plan.frames.iter().try_fold(0_u64, |total, frame| {
        let entries = frame
            .local_palette_rgb
            .as_ref()
            .map_or(0_usize, |palette| palette_entries(palette));
        total
            .checked_add(u64::try_from(entries).map_err(|_| IndexedGifError::CountOverflow)?)
            .ok_or(IndexedGifError::CountOverflow)
    })?;

    let mut global_used = [false; GIF_GLOBAL_PALETTE_ENTRIES];
    // The GIF logical-screen background index is zero and image-gif writes no
    // alternate background-index field, so preserve that entry even if every
    // image frame has a Local Color Table.
    global_used[0] = true;
    for frame in &plan.frames {
        if frame.local_palette_rgb.is_none() {
            mark_used_indices(&mut global_used, frame);
        }
    }
    let (global_palette_rgb, global_remap) =
        compact_palette(&plan.global_palette_rgb, &global_used, true)?;
    let compacted_global_palette_entries = palette_entries(&global_palette_rgb);

    let mut frames = Vec::with_capacity(plan.frames.len());
    let mut compacted_local_palette_entries = 0_u64;
    let mut compacted_local_palette_frame_count = 0_u32;
    let mut remapped_frame_count = 0_u32;
    for source in &plan.frames {
        let mut frame = source.clone();
        let remap = if let Some(local_palette) = source.local_palette_rgb.as_ref() {
            let mut used = [false; GIF_GLOBAL_PALETTE_ENTRIES];
            mark_used_indices(&mut used, source);
            let (compacted, remap) = compact_palette(local_palette, &used, false)?;
            if compacted.len() < local_palette.len() {
                compacted_local_palette_frame_count = compacted_local_palette_frame_count
                    .checked_add(1)
                    .ok_or(IndexedGifError::CountOverflow)?;
            }
            compacted_local_palette_entries = compacted_local_palette_entries
                .checked_add(
                    u64::try_from(palette_entries(&compacted))
                        .map_err(|_| IndexedGifError::CountOverflow)?,
                )
                .ok_or(IndexedGifError::CountOverflow)?;
            frame.local_palette_rgb = Some(compacted);
            remap
        } else {
            global_remap
        };
        let mut changed = false;
        for value in &mut frame.indices {
            let remapped = remap[usize::from(*value)];
            changed |= remapped != *value;
            *value = remapped;
        }
        if let Some(transparent) = &mut frame.transparent_index {
            let remapped = remap[usize::from(*transparent)];
            changed |= remapped != *transparent;
            *transparent = remapped;
        }
        if changed || frame.local_palette_rgb != source.local_palette_rgb {
            remapped_frame_count = remapped_frame_count
                .checked_add(1)
                .ok_or(IndexedGifError::CountOverflow)?;
        }
        frames.push(frame);
    }
    let compacted = IndexedGifPlan {
        width: plan.width,
        height: plan.height,
        global_palette_rgb,
        repeat: plan.repeat,
        frames,
    };
    validate_and_report(&compacted)?;
    if simulate_indexed_gif(&compacted)? != source_displayed {
        return Err(IndexedGifError::DisposalSimulationMismatch);
    }
    Ok((
        compacted,
        IndexedGifPaletteCompactionReport {
            original_global_palette_entries: u16::try_from(original_global_palette_entries)
                .map_err(|_| IndexedGifError::CountOverflow)?,
            compacted_global_palette_entries: u16::try_from(compacted_global_palette_entries)
                .map_err(|_| IndexedGifError::CountOverflow)?,
            original_local_palette_entries,
            compacted_local_palette_entries,
            compacted_local_palette_frame_count,
            remapped_frame_count,
            display_simulation_verified: true,
        },
    ))
}

fn palette_entries(palette_rgb: &[u8]) -> usize {
    palette_rgb.len() / 3
}

fn mark_used_indices(used: &mut [bool; GIF_GLOBAL_PALETTE_ENTRIES], frame: &IndexedGifFrame) {
    for value in &frame.indices {
        used[usize::from(*value)] = true;
    }
    if let Some(transparent) = frame.transparent_index {
        used[usize::from(transparent)] = true;
    }
}

fn compact_palette(
    palette_rgb: &[u8],
    used: &[bool; GIF_GLOBAL_PALETTE_ENTRIES],
    pin_zero: bool,
) -> Result<(Vec<u8>, [u8; GIF_GLOBAL_PALETTE_ENTRIES]), IndexedGifError> {
    let entries = palette_entries(palette_rgb);
    let mut order = Vec::with_capacity(entries);
    if pin_zero {
        order.push(0_usize);
    }
    for (index, is_used) in used.iter().copied().enumerate().take(entries) {
        if is_used && (!pin_zero || index != 0) {
            order.push(index);
        }
    }
    if order.is_empty() {
        return Err(IndexedGifError::EmptyTimeline);
    }
    let compacted_entries = order.len().max(2).next_power_of_two();
    let mut compacted = Vec::with_capacity(compacted_entries * 3);
    let mut remap = [0_u8; GIF_GLOBAL_PALETTE_ENTRIES];
    for (new_index, old_index) in order.iter().copied().enumerate() {
        remap[old_index] = u8::try_from(new_index).map_err(|_| IndexedGifError::CountOverflow)?;
        let offset = old_index * 3;
        compacted.extend_from_slice(&palette_rgb[offset..offset + 3]);
    }
    let final_color = compacted[compacted.len() - 3..].to_vec();
    while compacted.len() < compacted_entries * 3 {
        compacted.extend_from_slice(&final_color);
    }
    Ok((compacted, remap))
}

fn logical_screen_background(plan: &IndexedGifPlan) -> [u8; 4] {
    if plan
        .frames
        .iter()
        .any(|frame| frame.transparent_index.is_some())
    {
        // Real-world GIF compositors initialize/restore alpha GIF canvases to
        // transparent; the gif crate documents the logical background index as
        // effectively unused. Independent FFmpeg decode parity is the release gate.
        [0, 0, 0, 0]
    } else {
        [
            plan.global_palette_rgb[0],
            plan.global_palette_rgb[1],
            plan.global_palette_rgb[2],
            u8::MAX,
        ]
    }
}

/// Simulate the displayed RGBA logical screen after every frame.
///
/// Unlike index-canvas simulation, this remains valid across Local Color Table
/// switches because retained pixels keep their resolved colors rather than an
/// index whose meaning can change on the next frame.
pub fn simulate_indexed_gif(plan: &IndexedGifPlan) -> Result<Vec<Vec<u8>>, IndexedGifError> {
    validate_and_report(plan)?;
    let canvas_pixels = usize::from(plan.width)
        .checked_mul(usize::from(plan.height))
        .ok_or(IndexedGifError::CountOverflow)?;
    let background = logical_screen_background(plan);
    let mut canvas = Vec::with_capacity(
        canvas_pixels
            .checked_mul(4)
            .ok_or(IndexedGifError::CountOverflow)?,
    );
    for _ in 0..canvas_pixels {
        canvas.extend_from_slice(&background);
    }
    let mut displayed = Vec::with_capacity(plan.frames.len());
    let mut pending: Option<PendingRgbaDisposal> = None;

    for frame in &plan.frames {
        if let Some(pending_disposal) = pending.take() {
            match pending_disposal.method {
                IndexedGifDisposal::Unspecified | IndexedGifDisposal::Keep => {}
                IndexedGifDisposal::Background => fill_rgba_rect(
                    &mut canvas,
                    plan.width,
                    pending_disposal.left,
                    pending_disposal.top,
                    pending_disposal.width,
                    pending_disposal.height,
                    background,
                ),
                IndexedGifDisposal::Previous => {
                    canvas = pending_disposal
                        .restore
                        .ok_or(IndexedGifError::DisposalSimulationMismatch)?;
                }
            }
        }
        let restore = (frame.disposal == IndexedGifDisposal::Previous).then(|| canvas.clone());
        draw_rgba_frame(&mut canvas, plan.width, frame, &plan.global_palette_rgb);
        displayed.push(canvas.clone());
        pending = Some(PendingRgbaDisposal {
            method: frame.disposal,
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
            restore,
        });
    }
    Ok(displayed)
}

/// Convert a full-frame opaque timeline into minimum change rectangles while
/// preserving every frame and delay.
///
/// Identical display frames become 1x1 transparent holds. The result is
/// returned only after the disposal simulator reconstructs the exact source
/// display timeline.
pub fn optimize_full_frames_to_change_rectangles(
    plan: &IndexedGifPlan,
) -> Result<(IndexedGifPlan, IndexedGifOptimizationReport), IndexedGifError> {
    validate_and_report(plan)?;
    for (index, frame) in plan.frames.iter().enumerate() {
        if frame.left != 0
            || frame.top != 0
            || frame.width != plan.width
            || frame.height != plan.height
        {
            return Err(IndexedGifError::RectangleOptimizationRequiresFullFrames { index });
        }
        if frame.indices.contains(&GIF_TRANSPARENT_INDEX) {
            return Err(IndexedGifError::TransparentSourceOptimizationUnsupported { index });
        }
    }

    let source_displayed = simulate_indexed_gif(plan)?;
    let mut optimized_frames = Vec::with_capacity(plan.frames.len());
    optimized_frames.push(IndexedGifFrame {
        left: 0,
        top: 0,
        width: plan.width,
        height: plan.height,
        delay_cs: plan.frames[0].delay_cs,
        disposal: IndexedGifDisposal::Keep,
        transparent_index: visible_frame_transparent_index(&plan.frames[0]),
        local_palette_rgb: plan.frames[0].local_palette_rgb.clone(),
        indices: plan.frames[0].indices.clone(),
    });
    let mut rectangle_frame_count = 0_u32;
    let mut transparent_hold_frame_count = 0_u32;
    let mut palette_boundary_full_frame_count = 0_u32;
    for (index, target) in source_displayed.iter().enumerate().skip(1) {
        let previous = &source_displayed[index - 1];
        let source = &plan.frames[index];
        let previous_source = &plan.frames[index - 1];
        if active_palette(plan, previous_source) != active_palette(plan, source) {
            optimized_frames.push(IndexedGifFrame {
                left: 0,
                top: 0,
                width: plan.width,
                height: plan.height,
                delay_cs: source.delay_cs,
                disposal: IndexedGifDisposal::Keep,
                transparent_index: visible_frame_transparent_index(source),
                local_palette_rgb: source.local_palette_rgb.clone(),
                indices: source.indices.clone(),
            });
            palette_boundary_full_frame_count = palette_boundary_full_frame_count
                .checked_add(1)
                .ok_or(IndexedGifError::CountOverflow)?;
            continue;
        }
        match changed_rgba_bounds(previous, target, plan.width, plan.height) {
            None => {
                optimized_frames.push(IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 1,
                    height: 1,
                    delay_cs: source.delay_cs,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: Some(GIF_TRANSPARENT_INDEX),
                    local_palette_rgb: None,
                    indices: vec![GIF_TRANSPARENT_INDEX],
                });
                rectangle_frame_count = rectangle_frame_count
                    .checked_add(1)
                    .ok_or(IndexedGifError::CountOverflow)?;
                transparent_hold_frame_count = transparent_hold_frame_count
                    .checked_add(1)
                    .ok_or(IndexedGifError::CountOverflow)?;
            }
            Some((left, top, width, height)) => {
                optimized_frames.push(IndexedGifFrame {
                    left,
                    top,
                    width,
                    height,
                    delay_cs: source.delay_cs,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: visible_frame_transparent_index(source),
                    local_palette_rgb: source.local_palette_rgb.clone(),
                    indices: crop_indices(&source.indices, plan.width, left, top, width, height),
                });
                if left != 0 || top != 0 || width != plan.width || height != plan.height {
                    rectangle_frame_count = rectangle_frame_count
                        .checked_add(1)
                        .ok_or(IndexedGifError::CountOverflow)?;
                }
            }
        }
    }
    let optimized = IndexedGifPlan {
        width: plan.width,
        height: plan.height,
        global_palette_rgb: plan.global_palette_rgb.clone(),
        repeat: plan.repeat,
        frames: optimized_frames,
    };
    if simulate_indexed_gif(&optimized)? != source_displayed {
        return Err(IndexedGifError::DisposalSimulationMismatch);
    }
    let original_indexed_pixels = indexed_pixel_count(&plan.frames)?;
    let optimized_indexed_pixels = indexed_pixel_count(&optimized.frames)?;
    let indexed_pixel_reduction_percent = if original_indexed_pixels == 0 {
        0.0
    } else {
        (1.0 - optimized_indexed_pixels as f64 / original_indexed_pixels as f64) * 100.0
    };
    Ok((
        optimized,
        IndexedGifOptimizationReport {
            original_indexed_pixels,
            optimized_indexed_pixels,
            rectangle_frame_count,
            transparent_hold_frame_count,
            palette_boundary_full_frame_count,
            background_disposal_frame_count: 0,
            previous_disposal_frame_count: 0,
            disposal_candidate_count: 1,
            selected_disposal_strategy: "opaque_keep_rectangles_v1".to_string(),
            indexed_pixel_reduction_percent,
            disposal_simulation_verified: true,
        },
    ))
}

/// Build transparent-frame rectangle/disposal candidates, coalesce adjacent
/// identical display frames into longer delays, verify their timed RGBA
/// display timelines, serialize every valid candidate, and keep the smallest
/// real GIF byte stream.
pub fn optimize_transparent_full_frames_by_bytes(
    plan: &IndexedGifPlan,
) -> Result<(IndexedGifPlan, IndexedGifOptimizationReport), IndexedGifError> {
    validate_and_report(plan)?;
    for (index, frame) in plan.frames.iter().enumerate() {
        if frame.left != 0
            || frame.top != 0
            || frame.width != plan.width
            || frame.height != plan.height
        {
            return Err(IndexedGifError::RectangleOptimizationRequiresFullFrames { index });
        }
    }
    let desired = desired_full_frame_rgba_timeline(plan)?;
    let source_timeline = timed_rgba_timeline(desired.clone(), &plan.frames)?;
    let (coalesced_plan, desired) = coalesce_identical_full_frames(plan, desired);
    let mut candidates = vec![
        (
            "transparent_background_bbox_v1",
            independent_transparent_plan(&coalesced_plan, &desired, IndexedGifDisposal::Background),
        ),
        (
            "transparent_previous_bbox_v1",
            independent_transparent_plan(&coalesced_plan, &desired, IndexedGifDisposal::Previous),
        ),
    ];
    if let Ok(mixed) = mixed_transparent_plan(&coalesced_plan, &desired) {
        candidates.push(("transparent_mixed_disposal_v1", mixed));
    }

    let mut verified_candidate_count = 0_u8;
    let mut selected: Option<(usize, &'static str, IndexedGifPlan)> = None;
    for (strategy, candidate) in candidates {
        if timed_display_timeline(&candidate)? != source_timeline {
            continue;
        }
        let mut bytes = Vec::new();
        write_indexed_gif(&mut bytes, &candidate)?;
        verified_candidate_count = verified_candidate_count
            .checked_add(1)
            .ok_or(IndexedGifError::CountOverflow)?;
        if selected
            .as_ref()
            .is_none_or(|(selected_bytes, _, _)| bytes.len() < *selected_bytes)
        {
            selected = Some((bytes.len(), strategy, candidate));
        }
    }
    let (_, selected_disposal_strategy, optimized) =
        selected.ok_or(IndexedGifError::DisposalSimulationMismatch)?;
    let original_indexed_pixels = indexed_pixel_count(&plan.frames)?;
    let optimized_indexed_pixels = indexed_pixel_count(&optimized.frames)?;
    let indexed_pixel_reduction_percent = if original_indexed_pixels == 0 {
        0.0
    } else {
        (1.0 - optimized_indexed_pixels as f64 / original_indexed_pixels as f64) * 100.0
    };
    let rectangle_frame_count = u32::try_from(
        optimized
            .frames
            .iter()
            .filter(|frame| {
                frame.left != 0
                    || frame.top != 0
                    || frame.width != optimized.width
                    || frame.height != optimized.height
            })
            .count(),
    )
    .map_err(|_| IndexedGifError::CountOverflow)?;
    let transparent_hold_frame_count = u32::try_from(
        optimized
            .frames
            .iter()
            .filter(|frame| {
                frame.width == 1
                    && frame.height == 1
                    && frame.indices == [GIF_TRANSPARENT_INDEX]
                    && frame.transparent_index == Some(GIF_TRANSPARENT_INDEX)
            })
            .count(),
    )
    .map_err(|_| IndexedGifError::CountOverflow)?;
    let background_disposal_frame_count = u32::try_from(
        optimized
            .frames
            .iter()
            .filter(|frame| frame.disposal == IndexedGifDisposal::Background)
            .count(),
    )
    .map_err(|_| IndexedGifError::CountOverflow)?;
    let previous_disposal_frame_count = u32::try_from(
        optimized
            .frames
            .iter()
            .filter(|frame| frame.disposal == IndexedGifDisposal::Previous)
            .count(),
    )
    .map_err(|_| IndexedGifError::CountOverflow)?;
    Ok((
        optimized,
        IndexedGifOptimizationReport {
            original_indexed_pixels,
            optimized_indexed_pixels,
            rectangle_frame_count,
            transparent_hold_frame_count,
            palette_boundary_full_frame_count: 0,
            background_disposal_frame_count,
            previous_disposal_frame_count,
            disposal_candidate_count: verified_candidate_count,
            selected_disposal_strategy: selected_disposal_strategy.to_string(),
            indexed_pixel_reduction_percent,
            disposal_simulation_verified: true,
        },
    ))
}

fn coalesce_identical_full_frames(
    plan: &IndexedGifPlan,
    desired: Vec<Vec<u8>>,
) -> (IndexedGifPlan, Vec<Vec<u8>>) {
    let mut frames: Vec<IndexedGifFrame> = Vec::with_capacity(plan.frames.len());
    let mut coalesced_desired: Vec<Vec<u8>> = Vec::with_capacity(desired.len());
    for (source, target) in plan.frames.iter().zip(desired) {
        if coalesced_desired.last().is_some_and(|last| last == &target) {
            if let Some(delay_cs) = frames
                .last()
                .and_then(|last| last.delay_cs.checked_add(source.delay_cs))
            {
                frames.last_mut().expect("coalesced frame exists").delay_cs = delay_cs;
                continue;
            }
        }
        frames.push(source.clone());
        coalesced_desired.push(target);
    }
    (
        IndexedGifPlan {
            width: plan.width,
            height: plan.height,
            global_palette_rgb: plan.global_palette_rgb.clone(),
            repeat: plan.repeat,
            frames,
        },
        coalesced_desired,
    )
}

fn timed_display_timeline(plan: &IndexedGifPlan) -> Result<Vec<(Vec<u8>, u64)>, IndexedGifError> {
    let displayed = simulate_indexed_gif(plan)?;
    timed_rgba_timeline(displayed, &plan.frames)
}

fn timed_rgba_timeline(
    displayed: Vec<Vec<u8>>,
    frames: &[IndexedGifFrame],
) -> Result<Vec<(Vec<u8>, u64)>, IndexedGifError> {
    let mut timeline: Vec<(Vec<u8>, u64)> = Vec::with_capacity(displayed.len());
    for (rgba, frame) in displayed.into_iter().zip(frames) {
        if let Some((previous, duration_cs)) = timeline.last_mut() {
            if previous == &rgba {
                *duration_cs = duration_cs
                    .checked_add(u64::from(frame.delay_cs))
                    .ok_or(IndexedGifError::CountOverflow)?;
                continue;
            }
        }
        timeline.push((rgba, u64::from(frame.delay_cs)));
    }
    Ok(timeline)
}

fn desired_full_frame_rgba_timeline(
    plan: &IndexedGifPlan,
) -> Result<Vec<Vec<u8>>, IndexedGifError> {
    let frame_pixels = usize::from(plan.width)
        .checked_mul(usize::from(plan.height))
        .ok_or(IndexedGifError::CountOverflow)?;
    plan.frames
        .iter()
        .map(|frame| {
            let palette = active_palette(plan, frame);
            let mut rgba = Vec::with_capacity(
                frame_pixels
                    .checked_mul(4)
                    .ok_or(IndexedGifError::CountOverflow)?,
            );
            for value in &frame.indices {
                if frame.transparent_index == Some(*value) {
                    rgba.extend_from_slice(&[0, 0, 0, 0]);
                } else {
                    let offset = usize::from(*value) * 3;
                    rgba.extend_from_slice(&[
                        palette[offset],
                        palette[offset + 1],
                        palette[offset + 2],
                        u8::MAX,
                    ]);
                }
            }
            Ok(rgba)
        })
        .collect()
}

fn independent_transparent_plan(
    plan: &IndexedGifPlan,
    desired: &[Vec<u8>],
    disposal: IndexedGifDisposal,
) -> IndexedGifPlan {
    let frames = plan
        .frames
        .iter()
        .zip(desired)
        .map(|(source, target)| {
            let bounds = opaque_rgba_bounds(target, plan.width, plan.height);
            transparent_frame_from_bounds(plan, source, bounds, disposal)
        })
        .collect();
    IndexedGifPlan {
        width: plan.width,
        height: plan.height,
        global_palette_rgb: plan.global_palette_rgb.clone(),
        repeat: plan.repeat,
        frames,
    }
}

fn mixed_transparent_plan(
    plan: &IndexedGifPlan,
    desired: &[Vec<u8>],
) -> Result<IndexedGifPlan, IndexedGifError> {
    let canvas_bytes = usize::from(plan.width)
        .checked_mul(usize::from(plan.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(IndexedGifError::CountOverflow)?;
    let mut canvas = vec![0_u8; canvas_bytes];
    let mut frames = Vec::with_capacity(plan.frames.len());
    for (index, (source, target)) in plan.frames.iter().zip(desired).enumerate() {
        if target
            .chunks_exact(4)
            .zip(canvas.chunks_exact(4))
            .any(|(target, before)| target[3] == 0 && before[3] != 0)
        {
            return Err(IndexedGifError::DisposalSimulationMismatch);
        }
        let changed = changed_rgba_bounds(&canvas, target, plan.width, plan.height);
        let next = desired.get(index + 1);
        let clear = next
            .and_then(|next| opaque_to_transparent_bounds(target, next, plan.width, plan.height));
        let disposal = if changed.is_some() && next.is_some_and(|next| next == &canvas) {
            IndexedGifDisposal::Previous
        } else if clear.is_some() {
            IndexedGifDisposal::Background
        } else {
            IndexedGifDisposal::Keep
        };
        let bounds = if disposal == IndexedGifDisposal::Background {
            union_bounds(changed, clear)
        } else {
            changed
        };
        let frame = transparent_frame_from_bounds(plan, source, bounds, disposal);
        let before = canvas.clone();
        canvas.clone_from(target);
        match disposal {
            IndexedGifDisposal::Unspecified | IndexedGifDisposal::Keep => {}
            IndexedGifDisposal::Background => fill_rgba_rect(
                &mut canvas,
                plan.width,
                frame.left,
                frame.top,
                frame.width,
                frame.height,
                [0, 0, 0, 0],
            ),
            IndexedGifDisposal::Previous => canvas = before,
        }
        frames.push(frame);
    }
    Ok(IndexedGifPlan {
        width: plan.width,
        height: plan.height,
        global_palette_rgb: plan.global_palette_rgb.clone(),
        repeat: plan.repeat,
        frames,
    })
}

fn transparent_frame_from_bounds(
    plan: &IndexedGifPlan,
    source: &IndexedGifFrame,
    bounds: Option<(u16, u16, u16, u16)>,
    disposal: IndexedGifDisposal,
) -> IndexedGifFrame {
    match bounds {
        Some((left, top, width, height)) => IndexedGifFrame {
            left,
            top,
            width,
            height,
            delay_cs: source.delay_cs,
            disposal,
            transparent_index: source.transparent_index,
            local_palette_rgb: source.local_palette_rgb.clone(),
            indices: crop_indices(&source.indices, plan.width, left, top, width, height),
        },
        None => IndexedGifFrame {
            left: 0,
            top: 0,
            width: 1,
            height: 1,
            delay_cs: source.delay_cs,
            disposal: IndexedGifDisposal::Keep,
            transparent_index: Some(GIF_TRANSPARENT_INDEX),
            local_palette_rgb: None,
            indices: vec![GIF_TRANSPARENT_INDEX],
        },
    }
}

fn opaque_rgba_bounds(rgba: &[u8], width: u16, height: u16) -> Option<(u16, u16, u16, u16)> {
    pixel_predicate_bounds(rgba, width, height, |pixel| pixel[3] != 0)
}

fn opaque_to_transparent_bounds(
    current: &[u8],
    next: &[u8],
    width: u16,
    height: u16,
) -> Option<(u16, u16, u16, u16)> {
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0_u16;
    let mut max_y = 0_u16;
    let mut matched = false;
    for y in 0..height {
        for x in 0..width {
            let offset = (usize::from(y) * usize::from(width) + usize::from(x)) * 4;
            if current[offset + 3] != 0 && next[offset + 3] == 0 {
                matched = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    matched.then(|| (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
}

fn pixel_predicate_bounds(
    rgba: &[u8],
    width: u16,
    height: u16,
    predicate: impl Fn(&[u8]) -> bool,
) -> Option<(u16, u16, u16, u16)> {
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0_u16;
    let mut max_y = 0_u16;
    let mut matched = false;
    for y in 0..height {
        for x in 0..width {
            let offset = (usize::from(y) * usize::from(width) + usize::from(x)) * 4;
            if predicate(&rgba[offset..offset + 4]) {
                matched = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    matched.then(|| (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
}

fn union_bounds(
    left: Option<(u16, u16, u16, u16)>,
    right: Option<(u16, u16, u16, u16)>,
) -> Option<(u16, u16, u16, u16)> {
    match (left, right) {
        (None, None) => None,
        (Some(bounds), None) | (None, Some(bounds)) => Some(bounds),
        (
            Some((left_x, left_y, left_width, left_height)),
            Some((right_x, right_y, right_width, right_height)),
        ) => {
            let min_x = left_x.min(right_x);
            let min_y = left_y.min(right_y);
            let max_x = left_x
                .saturating_add(left_width)
                .max(right_x.saturating_add(right_width));
            let max_y = left_y
                .saturating_add(left_height)
                .max(right_y.saturating_add(right_height));
            Some((min_x, min_y, max_x - min_x, max_y - min_y))
        }
    }
}

fn draw_rgba_frame(
    canvas: &mut [u8],
    canvas_width: u16,
    frame: &IndexedGifFrame,
    global_palette_rgb: &[u8],
) {
    let canvas_width = usize::from(canvas_width);
    let frame_width = usize::from(frame.width);
    let left = usize::from(frame.left);
    let top = usize::from(frame.top);
    let palette = frame
        .local_palette_rgb
        .as_deref()
        .unwrap_or(global_palette_rgb);
    for row in 0..usize::from(frame.height) {
        let source_start = row * frame_width;
        let destination_start = (top + row) * canvas_width + left;
        for column in 0..frame_width {
            let value = frame.indices[source_start + column];
            if frame.transparent_index == Some(value) {
                continue;
            }
            let palette_offset = usize::from(value) * 3;
            let destination = (destination_start + column) * 4;
            canvas[destination..destination + 4].copy_from_slice(&[
                palette[palette_offset],
                palette[palette_offset + 1],
                palette[palette_offset + 2],
                u8::MAX,
            ]);
        }
    }
}

fn fill_rgba_rect(
    canvas: &mut [u8],
    canvas_width: u16,
    left: u16,
    top: u16,
    width: u16,
    height: u16,
    rgba: [u8; 4],
) {
    let canvas_width = usize::from(canvas_width);
    let left = usize::from(left);
    let top = usize::from(top);
    let width = usize::from(width);
    for row in 0..usize::from(height) {
        for column in 0..width {
            let destination = ((top + row) * canvas_width + left + column) * 4;
            canvas[destination..destination + 4].copy_from_slice(&rgba);
        }
    }
}

fn active_palette<'a>(plan: &'a IndexedGifPlan, frame: &'a IndexedGifFrame) -> &'a [u8] {
    frame
        .local_palette_rgb
        .as_deref()
        .unwrap_or(&plan.global_palette_rgb)
}

fn visible_frame_transparent_index(frame: &IndexedGifFrame) -> Option<u8> {
    frame
        .transparent_index
        .filter(|transparent| frame.indices.contains(transparent))
}

fn changed_rgba_bounds(
    previous: &[u8],
    target: &[u8],
    width: u16,
    height: u16,
) -> Option<(u16, u16, u16, u16)> {
    let width_usize = usize::from(width);
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0_u16;
    let mut max_y = 0_u16;
    let mut changed = false;
    for y in 0..height {
        for x in 0..width {
            let offset = (usize::from(y) * width_usize + usize::from(x)) * 4;
            if previous[offset..offset + 4] != target[offset..offset + 4] {
                changed = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    changed.then(|| (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
}

fn crop_indices(
    source: &[u8],
    source_width: u16,
    left: u16,
    top: u16,
    width: u16,
    height: u16,
) -> Vec<u8> {
    let source_width = usize::from(source_width);
    let left = usize::from(left);
    let top = usize::from(top);
    let width = usize::from(width);
    let mut cropped = Vec::with_capacity(width * usize::from(height));
    for row in 0..usize::from(height) {
        let start = (top + row) * source_width + left;
        cropped.extend_from_slice(&source[start..start + width]);
    }
    cropped
}

fn indexed_pixel_count(frames: &[IndexedGifFrame]) -> Result<u64, IndexedGifError> {
    frames.iter().try_fold(0_u64, |total, frame| {
        let pixels =
            u64::try_from(frame.indices.len()).map_err(|_| IndexedGifError::CountOverflow)?;
        total
            .checked_add(pixels)
            .ok_or(IndexedGifError::CountOverflow)
    })
}

fn validate_and_report(plan: &IndexedGifPlan) -> Result<IndexedGifWriteReport, IndexedGifError> {
    if plan.width == 0 || plan.height == 0 {
        return Err(IndexedGifError::ZeroCanvas);
    }
    let global_palette_entries = palette_entries(&plan.global_palette_rgb);
    if !plan.global_palette_rgb.len().is_multiple_of(3)
        || !(2..=GIF_GLOBAL_PALETTE_ENTRIES).contains(&global_palette_entries)
        || !global_palette_entries.is_power_of_two()
    {
        return Err(IndexedGifError::InvalidGlobalPaletteSize {
            actual: plan.global_palette_rgb.len(),
        });
    }
    if plan.frames.is_empty() {
        return Err(IndexedGifError::EmptyTimeline);
    }

    let mut full_frame_count = 0_u32;
    let mut local_palette_frame_count = 0_u32;
    let mut total_indexed_pixels = 0_u64;
    let mut total_delay_cs = 0_u64;
    let mut timeline_hasher = Sha256::new();
    timeline_hasher.update(b"gifp.indexed-gif-timeline.v3\0");
    let mut local_palette_hasher = Sha256::new();
    local_palette_hasher.update(b"gifp.indexed-gif-local-palettes.v1\0");
    local_palette_hasher.update((plan.frames.len() as u64).to_le_bytes());
    timeline_hasher.update(plan.width.to_le_bytes());
    timeline_hasher.update(plan.height.to_le_bytes());
    match plan.repeat {
        IndexedGifRepeat::None => timeline_hasher.update([0]),
        IndexedGifRepeat::Infinite => timeline_hasher.update([1]),
    }
    timeline_hasher.update(&plan.global_palette_rgb);

    for (index, frame) in plan.frames.iter().enumerate() {
        if frame.width == 0 || frame.height == 0 {
            return Err(IndexedGifError::ZeroFrame { index });
        }
        if u32::from(frame.left) + u32::from(frame.width) > u32::from(plan.width)
            || u32::from(frame.top) + u32::from(frame.height) > u32::from(plan.height)
        {
            return Err(IndexedGifError::FrameOutsideCanvas { index });
        }
        let expected = usize::from(frame.width)
            .checked_mul(usize::from(frame.height))
            .ok_or(IndexedGifError::CountOverflow)?;
        if frame.indices.len() != expected {
            return Err(IndexedGifError::InvalidFrameBufferSize {
                index,
                expected,
                actual: frame.indices.len(),
            });
        }
        if let Some(local_palette) = frame.local_palette_rgb.as_ref() {
            let palette_entries = local_palette.len() / 3;
            if !local_palette.len().is_multiple_of(3)
                || !(2..=GIF_GLOBAL_PALETTE_ENTRIES).contains(&palette_entries)
                || !palette_entries.is_power_of_two()
            {
                return Err(IndexedGifError::InvalidLocalPaletteSize {
                    index,
                    actual: local_palette.len(),
                });
            }
            local_palette_frame_count = local_palette_frame_count
                .checked_add(1)
                .ok_or(IndexedGifError::CountOverflow)?;
            local_palette_hasher.update((index as u64).to_le_bytes());
            local_palette_hasher.update((local_palette.len() as u64).to_le_bytes());
            local_palette_hasher.update(local_palette);
        }
        let palette_entries = frame
            .local_palette_rgb
            .as_ref()
            .map_or(global_palette_entries, |palette| palette.len() / 3);
        if let Some((pixel_index, value)) = frame
            .indices
            .iter()
            .copied()
            .enumerate()
            .find(|(_, value)| usize::from(*value) >= palette_entries)
        {
            return Err(IndexedGifError::PaletteIndexOutOfRange {
                frame_index: index,
                pixel_index,
                value,
                palette_entries,
            });
        }
        if frame
            .transparent_index
            .is_some_and(|value| usize::from(value) >= palette_entries)
        {
            return Err(IndexedGifError::InvalidTransparentIndex {
                index,
                value: frame.transparent_index.unwrap_or_default(),
            });
        }
        if frame.left == 0
            && frame.top == 0
            && frame.width == plan.width
            && frame.height == plan.height
        {
            full_frame_count = full_frame_count
                .checked_add(1)
                .ok_or(IndexedGifError::CountOverflow)?;
        }
        total_indexed_pixels = total_indexed_pixels
            .checked_add(u64::try_from(expected).map_err(|_| IndexedGifError::CountOverflow)?)
            .ok_or(IndexedGifError::CountOverflow)?;
        total_delay_cs = total_delay_cs
            .checked_add(u64::from(frame.delay_cs))
            .ok_or(IndexedGifError::CountOverflow)?;
        timeline_hasher.update(frame.left.to_le_bytes());
        timeline_hasher.update(frame.top.to_le_bytes());
        timeline_hasher.update(frame.width.to_le_bytes());
        timeline_hasher.update(frame.height.to_le_bytes());
        timeline_hasher.update(frame.delay_cs.to_le_bytes());
        timeline_hasher.update([frame.disposal.code()]);
        match frame.transparent_index {
            None => timeline_hasher.update([0, 0]),
            Some(value) => timeline_hasher.update([1, value]),
        }
        match frame.local_palette_rgb.as_ref() {
            None => timeline_hasher.update([0]),
            Some(local_palette) => {
                timeline_hasher.update([1]);
                timeline_hasher.update((local_palette.len() as u64).to_le_bytes());
                timeline_hasher.update(local_palette);
            }
        }
        timeline_hasher.update((frame.indices.len() as u64).to_le_bytes());
        timeline_hasher.update(&frame.indices);
    }
    let frame_count =
        u32::try_from(plan.frames.len()).map_err(|_| IndexedGifError::CountOverflow)?;
    Ok(IndexedGifWriteReport {
        frame_count,
        full_frame_count,
        total_indexed_pixels,
        total_delay_cs,
        local_palette_frame_count,
        global_palette_sha256: format!("{:x}", Sha256::digest(&plan.global_palette_rgb)),
        local_palette_sequence_sha256: (local_palette_frame_count > 0)
            .then(|| format!("{:x}", local_palette_hasher.finalize())),
        indexed_timeline_sha256: format!("{:x}", timeline_hasher.finalize()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gif::{ColorOutput, DecodeOptions};

    fn palette() -> Vec<u8> {
        (0_u16..=255)
            .flat_map(|index| {
                let value = index as u8;
                [value, u8::MAX - value, value / 2]
            })
            .collect()
    }

    fn frame(indices: &[u8], delay_cs: u16) -> IndexedGifFrame {
        IndexedGifFrame {
            left: 0,
            top: 0,
            width: 2,
            height: 2,
            delay_cs,
            disposal: IndexedGifDisposal::Keep,
            transparent_index: Some(GIF_TRANSPARENT_INDEX),
            local_palette_rgb: None,
            indices: indices.to_vec(),
        }
    }

    fn rgba_frame(indices: &[u8]) -> Vec<u8> {
        let palette = palette();
        indices
            .iter()
            .flat_map(|index| {
                let offset = usize::from(*index) * 3;
                [
                    palette[offset],
                    palette[offset + 1],
                    palette[offset + 2],
                    u8::MAX,
                ]
            })
            .collect()
    }

    #[test]
    fn writes_global_palette_full_frames_loop_and_exact_extreme_delays() {
        let plan = IndexedGifPlan {
            width: 2,
            height: 2,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::Infinite,
            frames: vec![frame(&[0, 1, 2, 3], 1), frame(&[4, 5, 6, 7], u16::MAX)],
        };
        let mut bytes = Vec::new();
        let report = write_indexed_gif(&mut bytes, &plan).unwrap();
        assert_eq!(report.frame_count, 2);
        assert_eq!(report.full_frame_count, 2);
        assert_eq!(report.total_indexed_pixels, 8);
        assert_eq!(report.total_delay_cs, u64::from(u16::MAX) + 1);
        assert_eq!(report.global_palette_sha256.len(), 64);
        assert_eq!(report.indexed_timeline_sha256.len(), 64);
        assert!(bytes.ends_with(&[0x3b]));

        let mut options = DecodeOptions::new();
        options.set_color_output(ColorOutput::Indexed);
        options.check_frame_consistency(true);
        options.check_lzw_end_code(true);
        let mut decoder = options.read_info(bytes.as_slice()).unwrap();
        assert_eq!(decoder.width(), 2);
        assert_eq!(decoder.height(), 2);
        assert_eq!(
            decoder.global_palette(),
            Some(plan.global_palette_rgb.as_slice())
        );
        assert_eq!(decoder.repeat(), Repeat::Infinite);
        let first = decoder.read_next_frame().unwrap().unwrap().clone();
        assert_eq!(first.buffer.as_ref(), [0, 1, 2, 3]);
        assert_eq!(first.delay, 1);
        assert_eq!(first.dispose, DisposalMethod::Keep);
        assert_eq!(first.transparent, Some(GIF_TRANSPARENT_INDEX));
        assert!(first.palette.is_none());
        let second = decoder.read_next_frame().unwrap().unwrap().clone();
        assert_eq!(second.buffer.as_ref(), [4, 5, 6, 7]);
        assert_eq!(second.delay, u16::MAX);
        assert!(decoder.read_next_frame().unwrap().is_none());
    }

    #[test]
    fn transparent_slot_decodes_with_zero_alpha_and_no_repeat_writes_no_netscape_block() {
        let plan = IndexedGifPlan {
            width: 2,
            height: 2,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::None,
            frames: vec![frame(&[0, GIF_TRANSPARENT_INDEX, 1, 2], 4)],
        };
        let mut bytes = Vec::new();
        write_indexed_gif(&mut bytes, &plan).unwrap();
        assert!(!bytes
            .windows(b"NETSCAPE2.0".len())
            .any(|window| window == b"NETSCAPE2.0"));

        let mut options = DecodeOptions::new();
        options.set_color_output(ColorOutput::RGBA);
        let mut decoder = options.read_info(bytes.as_slice()).unwrap();
        let decoded = decoder.read_next_frame().unwrap().unwrap();
        assert_eq!(decoded.buffer[3], u8::MAX);
        assert_eq!(decoded.buffer[7], 0);
    }

    #[test]
    fn rejects_invalid_contracts_before_writing() {
        let invalid_palette = IndexedGifPlan {
            width: 2,
            height: 2,
            global_palette_rgb: vec![0; 9],
            repeat: IndexedGifRepeat::None,
            frames: vec![frame(&[0, 1, 2, 3], 1)],
        };
        let mut bytes = Vec::new();
        assert!(matches!(
            write_indexed_gif(&mut bytes, &invalid_palette),
            Err(IndexedGifError::InvalidGlobalPaletteSize { .. })
        ));
        assert!(bytes.is_empty());

        let mut outside = invalid_palette;
        outside.global_palette_rgb = palette();
        outside.frames[0].left = 1;
        assert_eq!(
            write_indexed_gif(&mut Vec::new(), &outside),
            Err(IndexedGifError::FrameOutsideCanvas { index: 0 })
        );

        let mut wrong_transparency = outside;
        wrong_transparency.frames[0].left = 0;
        wrong_transparency.global_palette_rgb = palette()[..12].to_vec();
        wrong_transparency.frames[0].transparent_index = Some(17);
        assert_eq!(
            write_indexed_gif(&mut Vec::new(), &wrong_transparency),
            Err(IndexedGifError::InvalidTransparentIndex {
                index: 0,
                value: 17,
            })
        );

        let mut wrong_local_palette = wrong_transparency;
        wrong_local_palette.frames[0].transparent_index = None;
        wrong_local_palette.frames[0].local_palette_rgb = Some(vec![0; 9]);
        assert_eq!(
            write_indexed_gif(&mut Vec::new(), &wrong_local_palette),
            Err(IndexedGifError::InvalidLocalPaletteSize {
                index: 0,
                actual: 9,
            })
        );
    }

    #[test]
    fn writes_small_global_table_and_accepts_a_non_reserved_transparent_index() {
        let plan = IndexedGifPlan {
            width: 2,
            height: 2,
            global_palette_rgb: palette()[..12].to_vec(),
            repeat: IndexedGifRepeat::None,
            frames: vec![IndexedGifFrame {
                left: 0,
                top: 0,
                width: 2,
                height: 2,
                delay_cs: 4,
                disposal: IndexedGifDisposal::Keep,
                transparent_index: Some(3),
                local_palette_rgb: None,
                indices: vec![0, 1, 3, 2],
            }],
        };
        let mut bytes = Vec::new();
        write_indexed_gif(&mut bytes, &plan).unwrap();

        let mut options = DecodeOptions::new();
        options.set_color_output(ColorOutput::Indexed);
        let mut decoder = options.read_info(bytes.as_slice()).unwrap();
        assert_eq!(
            decoder.global_palette(),
            Some(plan.global_palette_rgb.as_slice())
        );
        let decoded = decoder.read_next_frame().unwrap().unwrap();
        assert_eq!(decoded.transparent, Some(3));
        assert_eq!(decoded.buffer.as_ref(), [0, 1, 3, 2]);
    }

    #[test]
    fn writes_index_255_as_opaque_when_the_frame_has_no_transparency() {
        let mut global_palette_rgb = vec![0_u8; GIF_GLOBAL_PALETTE_ENTRIES * 3];
        global_palette_rgb[usize::from(GIF_TRANSPARENT_INDEX) * 3..]
            .copy_from_slice(&[17, 211, 93]);
        let plan = IndexedGifPlan {
            width: 1,
            height: 1,
            global_palette_rgb,
            repeat: IndexedGifRepeat::None,
            frames: vec![IndexedGifFrame {
                left: 0,
                top: 0,
                width: 1,
                height: 1,
                delay_cs: 4,
                disposal: IndexedGifDisposal::Keep,
                transparent_index: None,
                local_palette_rgb: None,
                indices: vec![GIF_TRANSPARENT_INDEX],
            }],
        };
        let mut bytes = Vec::new();
        write_indexed_gif(&mut bytes, &plan).unwrap();

        let mut indexed_options = DecodeOptions::new();
        indexed_options.set_color_output(ColorOutput::Indexed);
        let mut indexed_decoder = indexed_options.read_info(bytes.as_slice()).unwrap();
        let indexed = indexed_decoder.read_next_frame().unwrap().unwrap();
        assert_eq!(indexed.transparent, None);
        assert_eq!(indexed.buffer.as_ref(), [GIF_TRANSPARENT_INDEX]);

        let mut rgba_options = DecodeOptions::new();
        rgba_options.set_color_output(ColorOutput::RGBA);
        let mut rgba_decoder = rgba_options.read_info(bytes.as_slice()).unwrap();
        let rgba = rgba_decoder.read_next_frame().unwrap().unwrap();
        assert_eq!(rgba.buffer.as_ref(), [17, 211, 93, u8::MAX]);
    }

    #[test]
    fn compacts_global_table_and_lzw_indices_with_exact_display_parity() {
        let width = 64_u16;
        let height = 32_u16;
        let pixels = usize::from(width) * usize::from(height);
        let mut frames = Vec::new();
        for frame_index in 0..12_usize {
            let mut indices = vec![64_u8; pixels];
            let left = (frame_index * 3) % 48;
            for y in 12..16_usize {
                indices[y * usize::from(width) + left..y * usize::from(width) + left + 4].fill(200);
            }
            frames.push(IndexedGifFrame {
                left: 0,
                top: 0,
                width,
                height,
                delay_cs: 6,
                disposal: IndexedGifDisposal::Keep,
                transparent_index: None,
                local_palette_rgb: None,
                indices,
            });
        }
        let source = IndexedGifPlan {
            width,
            height,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::Infinite,
            frames,
        };
        let (rectangles, _) = optimize_full_frames_to_change_rectangles(&source).unwrap();
        let (compacted, report) = compact_indexed_palette_tables(&rectangles).unwrap();
        let mut baseline_bytes = Vec::new();
        let mut compacted_bytes = Vec::new();
        write_indexed_gif(&mut baseline_bytes, &rectangles).unwrap();
        write_indexed_gif(&mut compacted_bytes, &compacted).unwrap();

        assert_eq!(
            simulate_indexed_gif(&compacted),
            simulate_indexed_gif(&rectangles)
        );
        assert_eq!(report.original_global_palette_entries, 256);
        assert_eq!(report.compacted_global_palette_entries, 4);
        assert!(report.display_simulation_verified);
        assert!(report.remapped_frame_count > 0);
        assert!(compacted_bytes.len() < baseline_bytes.len());
        assert!(compacted
            .frames
            .iter()
            .flat_map(|frame| frame.indices.iter())
            .all(|index| *index < 4));
    }

    #[test]
    fn compacts_each_local_table_independently() {
        let local = palette();
        let plan = IndexedGifPlan {
            width: 3,
            height: 1,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::None,
            frames: vec![
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 3,
                    height: 1,
                    delay_cs: 4,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: Some(255),
                    local_palette_rgb: Some(local.clone()),
                    indices: vec![127, 254, 255],
                },
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 3,
                    height: 1,
                    delay_cs: 5,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: Some(local),
                    indices: vec![3, 9, 3],
                },
            ],
        };
        let (compacted, report) = compact_indexed_palette_tables(&plan).unwrap();

        assert_eq!(
            simulate_indexed_gif(&compacted),
            simulate_indexed_gif(&plan)
        );
        assert_eq!(report.compacted_global_palette_entries, 2);
        assert_eq!(report.compacted_local_palette_frame_count, 2);
        assert_eq!(report.original_local_palette_entries, 512);
        assert_eq!(report.compacted_local_palette_entries, 6);
        assert_eq!(
            compacted.frames[0]
                .local_palette_rgb
                .as_ref()
                .unwrap()
                .len(),
            12
        );
        assert_eq!(compacted.frames[0].transparent_index, Some(2));
        assert_eq!(
            compacted.frames[1]
                .local_palette_rgb
                .as_ref()
                .unwrap()
                .len(),
            6
        );
    }

    #[test]
    fn optimizes_full_frames_to_verified_change_rectangles_and_transparent_holds() {
        let mut first = vec![0_u8; 12];
        first[0] = 1;
        let mut second = vec![0_u8; 12];
        second[1] = 1;
        let source = IndexedGifPlan {
            width: 4,
            height: 3,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::Infinite,
            frames: vec![
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 4,
                    height: 3,
                    delay_cs: 4,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: None,
                    indices: first,
                },
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 4,
                    height: 3,
                    delay_cs: 5,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: None,
                    indices: second.clone(),
                },
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 4,
                    height: 3,
                    delay_cs: 6,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: None,
                    indices: second,
                },
            ],
        };

        let source_displayed = simulate_indexed_gif(&source).unwrap();
        let (optimized, report) = optimize_full_frames_to_change_rectangles(&source).unwrap();

        assert_eq!(optimized.frames.len(), 3);
        assert_eq!(
            (
                optimized.frames[1].left,
                optimized.frames[1].top,
                optimized.frames[1].width,
                optimized.frames[1].height,
            ),
            (0, 0, 2, 1)
        );
        assert_eq!(optimized.frames[1].indices, [0, 1]);
        assert_eq!(optimized.frames[2].width, 1);
        assert_eq!(optimized.frames[2].height, 1);
        assert_eq!(optimized.frames[2].indices, [GIF_TRANSPARENT_INDEX]);
        assert_eq!(report.original_indexed_pixels, 36);
        assert_eq!(report.optimized_indexed_pixels, 15);
        assert_eq!(report.rectangle_frame_count, 2);
        assert_eq!(report.transparent_hold_frame_count, 1);
        assert!(report.indexed_pixel_reduction_percent > 50.0);
        assert!(report.disposal_simulation_verified);
        assert_eq!(simulate_indexed_gif(&optimized).unwrap(), source_displayed);
    }

    #[test]
    fn local_palette_boundaries_force_full_frames_and_rgba_simulation_stays_exact() {
        let mut local = palette()[..12].to_vec();
        local[3..6].copy_from_slice(&[220, 20, 40]);
        local[6..9].copy_from_slice(&[20, 180, 220]);
        let source = IndexedGifPlan {
            width: 2,
            height: 1,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::Infinite,
            frames: vec![
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 2,
                    height: 1,
                    delay_cs: 4,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: None,
                    indices: vec![1, 1],
                },
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 2,
                    height: 1,
                    delay_cs: 5,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: Some(local.clone()),
                    indices: vec![1, 1],
                },
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 2,
                    height: 1,
                    delay_cs: 6,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: Some(local.clone()),
                    indices: vec![1, 2],
                },
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 2,
                    height: 1,
                    delay_cs: 7,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: Some(local.clone()),
                    indices: vec![1, 2],
                },
            ],
        };
        let source_displayed = simulate_indexed_gif(&source).unwrap();
        let (optimized, optimization) = optimize_full_frames_to_change_rectangles(&source).unwrap();

        assert_eq!(optimization.palette_boundary_full_frame_count, 1);
        assert_eq!(optimization.rectangle_frame_count, 2);
        assert_eq!(optimization.transparent_hold_frame_count, 1);
        assert_eq!(optimized.frames[1].width, 2);
        assert_eq!(
            optimized.frames[1].local_palette_rgb.as_deref(),
            Some(local.as_slice())
        );
        assert_eq!(
            (optimized.frames[2].left, optimized.frames[2].width),
            (1, 1)
        );
        assert_eq!(
            optimized.frames[2].local_palette_rgb.as_deref(),
            Some(local.as_slice())
        );
        assert!(optimized.frames[3].local_palette_rgb.is_none());
        assert_eq!(simulate_indexed_gif(&optimized).unwrap(), source_displayed);

        let mut bytes = Vec::new();
        let report = write_indexed_gif(&mut bytes, &optimized).unwrap();
        assert_eq!(report.local_palette_frame_count, 2);
        assert!(report.local_palette_sequence_sha256.is_some());
        let mut options = DecodeOptions::new();
        options.set_color_output(ColorOutput::Indexed);
        options.check_frame_consistency(true);
        options.check_lzw_end_code(true);
        let mut decoder = options.read_info(bytes.as_slice()).unwrap();
        assert!(decoder
            .read_next_frame()
            .unwrap()
            .unwrap()
            .palette
            .is_none());
        assert_eq!(
            decoder
                .read_next_frame()
                .unwrap()
                .unwrap()
                .palette
                .as_deref(),
            Some(local.as_slice())
        );
        assert_eq!(
            decoder
                .read_next_frame()
                .unwrap()
                .unwrap()
                .palette
                .as_deref(),
            Some(local.as_slice())
        );
    }

    #[test]
    fn simulator_applies_background_and_previous_before_the_next_frame() {
        let plan = IndexedGifPlan {
            width: 3,
            height: 1,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::None,
            frames: vec![
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width: 3,
                    height: 1,
                    delay_cs: 1,
                    disposal: IndexedGifDisposal::Background,
                    transparent_index: None,
                    local_palette_rgb: None,
                    indices: vec![1, 1, 1],
                },
                IndexedGifFrame {
                    left: 1,
                    top: 0,
                    width: 1,
                    height: 1,
                    delay_cs: 1,
                    disposal: IndexedGifDisposal::Previous,
                    transparent_index: None,
                    local_palette_rgb: None,
                    indices: vec![2],
                },
                IndexedGifFrame {
                    left: 2,
                    top: 0,
                    width: 1,
                    height: 1,
                    delay_cs: 1,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: None,
                    indices: vec![3],
                },
            ],
        };

        assert_eq!(
            simulate_indexed_gif(&plan).unwrap(),
            vec![
                rgba_frame(&[1, 1, 1]),
                rgba_frame(&[0, 2, 0]),
                rgba_frame(&[0, 0, 3]),
            ]
        );
    }

    #[test]
    fn rectangle_optimizer_rejects_reserved_transparent_index_in_opaque_source() {
        let source = IndexedGifPlan {
            width: 2,
            height: 2,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::None,
            frames: vec![IndexedGifFrame {
                left: 0,
                top: 0,
                width: 2,
                height: 2,
                delay_cs: 1,
                disposal: IndexedGifDisposal::Keep,
                transparent_index: None,
                local_palette_rgb: None,
                indices: vec![0, 1, GIF_TRANSPARENT_INDEX, 2],
            }],
        };

        assert_eq!(
            optimize_full_frames_to_change_rectangles(&source),
            Err(IndexedGifError::TransparentSourceOptimizationUnsupported { index: 0 })
        );
    }

    #[test]
    fn small_change_rectangles_reduce_serialized_bytes_without_changing_displayed_pixels() {
        let width = 96_u16;
        let height = 64_u16;
        let mut frames = Vec::new();
        for frame_index in 0..20_u16 {
            let mut indices = vec![3_u8; usize::from(width) * usize::from(height)];
            let marker = if frame_index % 2 == 0 { 7 } else { 11 };
            for y in 48..56_usize {
                let start = y * usize::from(width) + 80;
                indices[start..start + 8].fill(marker);
            }
            frames.push(IndexedGifFrame {
                left: 0,
                top: 0,
                width,
                height,
                delay_cs: 10,
                disposal: IndexedGifDisposal::Keep,
                transparent_index: None,
                local_palette_rgb: None,
                indices,
            });
        }
        let full = IndexedGifPlan {
            width,
            height,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::Infinite,
            frames,
        };
        let (optimized, report) = optimize_full_frames_to_change_rectangles(&full).unwrap();
        let mut full_bytes = Vec::new();
        let mut optimized_bytes = Vec::new();
        write_indexed_gif(&mut full_bytes, &full).unwrap();
        write_indexed_gif(&mut optimized_bytes, &optimized).unwrap();

        assert_eq!(
            simulate_indexed_gif(&optimized),
            simulate_indexed_gif(&full)
        );
        assert_eq!(report.rectangle_frame_count, 19);
        assert!(report.indexed_pixel_reduction_percent > 90.0, "{report:?}");
        assert!(
            optimized_bytes.len() < full_bytes.len(),
            "optimized {} bytes, full {} bytes",
            optimized_bytes.len(),
            full_bytes.len()
        );
    }

    fn transparent_full_plan(
        width: u16,
        height: u16,
        frame_indices: Vec<Vec<u8>>,
    ) -> IndexedGifPlan {
        IndexedGifPlan {
            width,
            height,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::Infinite,
            frames: frame_indices
                .into_iter()
                .map(|indices| IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width,
                    height,
                    delay_cs: 8,
                    disposal: IndexedGifDisposal::Keep,
                    transparent_index: Some(GIF_TRANSPARENT_INDEX),
                    local_palette_rgb: None,
                    indices,
                })
                .collect(),
        }
    }

    #[test]
    fn transparent_optimizer_uses_previous_for_a_temporary_overlay_and_real_byte_search() {
        let width = 16_u16;
        let height = 8_u16;
        let pixels = usize::from(width) * usize::from(height);
        let mut base = vec![GIF_TRANSPARENT_INDEX; pixels];
        for y in 2..6_usize {
            base[y * usize::from(width) + 2..y * usize::from(width) + 14].fill(3);
        }
        let mut overlay = base.clone();
        for y in 0..2_usize {
            overlay[y * usize::from(width) + 6..y * usize::from(width) + 10].fill(7);
        }
        let source = transparent_full_plan(
            width,
            height,
            vec![base.clone(), overlay, base.clone(), base],
        );
        let desired = desired_full_frame_rgba_timeline(&source).unwrap();
        let (optimized, report) = optimize_transparent_full_frames_by_bytes(&source).unwrap();

        assert_eq!(
            timed_display_timeline(&optimized).unwrap(),
            timed_rgba_timeline(desired.clone(), &source.frames).unwrap()
        );
        assert_eq!(optimized.frames.len(), 3);
        assert_eq!(
            optimized
                .frames
                .iter()
                .map(|frame| u64::from(frame.delay_cs))
                .sum::<u64>(),
            source
                .frames
                .iter()
                .map(|frame| u64::from(frame.delay_cs))
                .sum::<u64>()
        );
        assert_eq!(
            report.selected_disposal_strategy,
            "transparent_mixed_disposal_v1"
        );
        assert_eq!(report.disposal_candidate_count, 3);
        assert!(report.previous_disposal_frame_count > 0, "{report:?}");
        assert!(report.indexed_pixel_reduction_percent > 80.0, "{report:?}");
        assert_eq!(desired.len(), 4);
    }

    #[test]
    fn transparent_optimizer_coalesces_identical_frames_without_overflowing_delay() {
        let width = 8_u16;
        let height = 4_u16;
        let pixels = usize::from(width) * usize::from(height);
        let still = vec![3_u8; pixels];
        let mut source =
            transparent_full_plan(width, height, vec![still.clone(), still.clone(), still]);
        source.frames[0].delay_cs = 10;
        source.frames[1].delay_cs = 20;
        source.frames[2].delay_cs = 30;

        let (optimized, _) = optimize_transparent_full_frames_by_bytes(&source).unwrap();
        let desired = desired_full_frame_rgba_timeline(&source).unwrap();

        assert_eq!(optimized.frames.len(), 1);
        assert_eq!(optimized.frames[0].delay_cs, 60);
        assert_eq!(
            timed_display_timeline(&optimized).unwrap(),
            timed_rgba_timeline(desired, &source.frames).unwrap()
        );

        source.frames[0].delay_cs = u16::MAX;
        source.frames[1].delay_cs = 1;
        source.frames[2].delay_cs = 2;
        let (overflow_safe, _) = optimize_transparent_full_frames_by_bytes(&source).unwrap();
        assert_eq!(overflow_safe.frames.len(), 2);
        assert_eq!(
            overflow_safe
                .frames
                .iter()
                .map(|frame| u64::from(frame.delay_cs))
                .sum::<u64>(),
            u64::from(u16::MAX) + 3
        );
    }

    #[test]
    fn transparent_optimizer_clears_a_moving_sprite_with_background_disposal() {
        let width = 20_u16;
        let height = 6_u16;
        let mut frames = Vec::new();
        for left in [0_usize, 7, 14] {
            let mut indices = vec![GIF_TRANSPARENT_INDEX; usize::from(width) * usize::from(height)];
            for y in 1..5_usize {
                indices[y * usize::from(width) + left..y * usize::from(width) + left + 4].fill(11);
            }
            frames.push(indices);
        }
        let source = transparent_full_plan(width, height, frames);
        let desired = desired_full_frame_rgba_timeline(&source).unwrap();
        let (optimized, report) = optimize_transparent_full_frames_by_bytes(&source).unwrap();

        assert_eq!(
            timed_display_timeline(&optimized).unwrap(),
            timed_rgba_timeline(desired, &source.frames).unwrap()
        );
        assert!(report.background_disposal_frame_count > 0, "{report:?}");
        assert_eq!(report.disposal_candidate_count, 3);
        assert!(report.disposal_simulation_verified);
        assert!(report.rectangle_frame_count > 0);
    }

    #[test]
    fn timeline_hash_distinguishes_opaque_index_255_from_transparent_index_255() {
        let mut opaque = IndexedGifPlan {
            width: 2,
            height: 2,
            global_palette_rgb: palette(),
            repeat: IndexedGifRepeat::None,
            frames: vec![frame(&[0, 1, 2, 3], 1)],
        };
        opaque.frames[0].transparent_index = None;
        let transparent = IndexedGifPlan {
            frames: vec![frame(&[0, 1, 2, 3], 1)],
            ..opaque.clone()
        };

        let opaque_report = write_indexed_gif(&mut Vec::new(), &opaque).unwrap();
        let transparent_report = write_indexed_gif(&mut Vec::new(), &transparent).unwrap();
        assert_ne!(
            opaque_report.indexed_timeline_sha256,
            transparent_report.indexed_timeline_sha256
        );
    }
}
