//! Bounded compression experiments and an opt-in production structure search.
//! Every proposal starts from the frozen input; serialized GIF bytes are the cost.
use super::indexed_gif::{
    simulate_indexed_gif, write_indexed_gif, IndexedGifDisposal as Disposal,
    IndexedGifFrame as Frame, IndexedGifPlan as Plan, IndexedGifRepeat,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

/// One budget shared by flattening, proposal encodes and final verification.
/// The callback lets product callers propagate task cancellation without a UI
/// dependency in the research core. Research wrappers keep their original API.
pub(crate) struct SearchControl<'a> {
    started: Instant,
    max_time: Duration,
    max_probes: usize,
    max_memory: usize,
    cancelled: &'a dyn Fn() -> Result<(), String>,
    pub(crate) probes: usize,
    pub(crate) estimated_peak_bytes: usize,
}

impl<'a> SearchControl<'a> {
    pub(crate) fn new(
        max_probes: usize,
        max_time: Duration,
        max_memory: usize,
        cancelled: &'a dyn Fn() -> Result<(), String>,
    ) -> Self {
        Self {
            started: Instant::now(),
            max_time,
            max_probes,
            max_memory,
            cancelled,
            probes: 0,
            estimated_peak_bytes: 0,
        }
    }

    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        (self.cancelled)()?;
        if self.started.elapsed() >= self.max_time {
            return Err("structure wall-time budget exhausted".into());
        }
        Ok(())
    }

    pub(crate) fn probe(&mut self) -> Result<(), String> {
        self.checkpoint()?;
        if self.probes >= self.max_probes {
            return Err("compression probe budget exhausted".into());
        }
        self.probes += 1;
        Ok(())
    }

    pub(crate) fn preflight(&mut self, plan: &Plan, beam_width: usize) -> Result<(), String> {
        self.checkpoint()?;
        let pixels = usize::from(plan.width) * usize::from(plan.height);
        // Original/flattened/candidate indices, one RGBA timeline, and bounded
        // beam proposals. No second RGBA timeline is materialized for checking.
        let estimate = pixels
            .checked_mul(plan.frames.len())
            .and_then(|v| v.checked_mul(8))
            .and_then(|v| v.checked_add(pixels.checked_mul(beam_width * 80 + 24)?))
            .and_then(|v| v.checked_add(32 * 1024 * 1024))
            .ok_or_else(|| "structure memory budget overflow".to_string())?;
        self.estimated_peak_bytes = self.estimated_peak_bytes.max(estimate);
        if estimate > self.max_memory {
            return Err("structure memory budget exhausted".into());
        }
        Ok(())
    }
}

fn research_control(budget: usize) -> SearchControl<'static> {
    SearchControl::new(budget, Duration::MAX, usize::MAX, &|| Ok(()))
}

/// Row-level cancellation and streaming equivalence checks avoid allocating a
/// second complete display timeline or concatenating two loops in memory.
fn visit_displayed(
    plan: &Plan,
    cycles: usize,
    control: &SearchControl<'_>,
    mut visit: impl FnMut(usize, &[u8]) -> Result<(), String>,
) -> Result<(), String> {
    control.checkpoint()?;
    let (w, h) = (usize::from(plan.width), usize::from(plan.height));
    if w == 0 || h == 0 || plan.frames.is_empty() || plan.global_palette_rgb.len() < 6 {
        return Err("invalid structure canvas or global palette".into());
    }
    let bg = if plan.frames.iter().any(|f| f.transparent_index.is_some()) {
        [0, 0, 0, 0]
    } else {
        [
            plan.global_palette_rgb[0],
            plan.global_palette_rgb[1],
            plan.global_palette_rgb[2],
            255,
        ]
    };
    let mut canvas = bg.repeat(w * h);
    for n in 0..plan.frames.len() * cycles {
        control.checkpoint()?;
        let frame = &plan.frames[n % plan.frames.len()];
        let (fw, fh, left, top) = (
            usize::from(frame.width),
            usize::from(frame.height),
            usize::from(frame.left),
            usize::from(frame.top),
        );
        let table = palette(plan, frame);
        if fw == 0
            || fh == 0
            || left + fw > w
            || top + fh > h
            || frame.indices.len() != fw * fh
            || table.len() < 6
            || table.len() > 768
            || !table.len().is_multiple_of(3)
        {
            return Err("invalid structure frame".into());
        }
        let restore = (frame.disposal == Disposal::Previous).then(|| canvas.clone());
        for y in 0..fh {
            control.checkpoint()?;
            for x in 0..fw {
                let index = frame.indices[y * fw + x];
                if usize::from(index) * 3 + 2 >= table.len() {
                    return Err("invalid structure palette index".into());
                }
                if Some(index) == frame.transparent_index {
                    continue;
                }
                let p = ((top + y) * w + left + x) * 4;
                canvas[p..p + 3]
                    .copy_from_slice(&table[usize::from(index) * 3..usize::from(index) * 3 + 3]);
                canvas[p + 3] = 255;
            }
        }
        visit(n, &canvas)?;
        match frame.disposal {
            Disposal::Previous => canvas = restore.expect("previous canvas"),
            Disposal::Background => {
                for y in top..top + fh {
                    control.checkpoint()?;
                    for x in left..left + fw {
                        canvas[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&bg);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn controlled_display(plan: &Plan, control: &SearchControl<'_>) -> Result<Vec<Vec<u8>>, String> {
    let mut displayed = Vec::with_capacity(plan.frames.len());
    visit_displayed(plan, 1, control, |_, rgba| {
        displayed.push(rgba.to_vec());
        Ok(())
    })?;
    Ok(displayed)
}

fn check_display(
    plan: &Plan,
    desired: &[Vec<u8>],
    cycles: usize,
    control: &SearchControl<'_>,
) -> Result<(), String> {
    visit_displayed(plan, cycles, control, |n, rgba| {
        if rgba != desired[n % desired.len()] {
            return Err("structure display mismatch".into());
        }
        Ok(())
    })
}

#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct SearchStats {
    pub compression_probes: usize,
    pub changed_indices: usize,
    pub temporal_holds: usize,
    pub exact_source_choices: usize,
    pub palette_boundary_rectangles: usize,
}

pub(crate) fn encode(plan: &Plan) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    write_indexed_gif(&mut bytes, plan).map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub(crate) fn display(plan: &Plan) -> Result<Vec<Vec<u8>>, String> {
    simulate_indexed_gif(plan).map_err(|e| e.to_string())
}

fn palette<'a>(plan: &'a Plan, frame: &'a Frame) -> &'a [u8] {
    frame
        .local_palette_rgb
        .as_deref()
        .unwrap_or(&plan.global_palette_rgb)
}

fn color(table: &[u8], index: u8) -> [u8; 3] {
    let p = usize::from(index) * 3;
    [table[p], table[p + 1], table[p + 2]]
}

fn delta(a: &[u8], b: &[u8]) -> u8 {
    (0..3).map(|c| a[c].abs_diff(b[c])).max().unwrap_or(0)
}

/// Recover full display frames without quantizing. A composed frame can have
/// colors absent from its active palette: that case is explicitly inapplicable.
pub(crate) fn flatten(plan: &Plan) -> Result<Plan, String> {
    flatten_controlled(plan, &mut research_control(usize::MAX))
}

pub(crate) fn flatten_controlled(
    plan: &Plan,
    control: &mut SearchControl<'_>,
) -> Result<Plan, String> {
    control.preflight(plan, 3)?;
    let displayed = controlled_display(plan, control)?;
    let mut full = plan.clone();
    for ((frame, original), rgba) in full.frames.iter_mut().zip(&plan.frames).zip(&displayed) {
        control.checkpoint()?;
        let table = palette(plan, original);
        let mut map = HashMap::new();
        for (index, rgb) in table.chunks_exact(3).enumerate() {
            if original.transparent_index != Some(index as u8) {
                map.entry([rgb[0], rgb[1], rgb[2], 255])
                    .or_insert(index as u8);
            }
        }
        if let Some(index) = original.transparent_index {
            map.insert([0, 0, 0, 0], index);
        }
        let indices = rgba
            .chunks_exact(4)
            .enumerate()
            .map(|(n, p)| {
                if n.is_multiple_of(4096) {
                    control.checkpoint()?;
                }
                let key = if p[3] == 0 {
                    [0, 0, 0, 0]
                } else {
                    [p[0], p[1], p[2], p[3]]
                };
                map.get(&key)
                    .copied()
                    .ok_or_else(|| "composited color is absent from active palette".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        frame.left = 0;
        frame.top = 0;
        frame.width = plan.width;
        frame.height = plan.height;
        frame.indices = indices;
        frame.disposal = Disposal::Background;
    }
    check_display(&full, &displayed, 1, control)?;
    Ok(full)
}

fn frame_cost(
    plan: &Plan,
    frame: &Frame,
    stats: &mut SearchStats,
    budget: usize,
) -> Result<usize, String> {
    if stats.compression_probes >= budget {
        return Err("compression probe budget exhausted".into());
    }
    stats.compression_probes += 1;
    // A GIF image starts its own LZW dictionary. The extra header/trailer is
    // constant for all alternatives at this frame and therefore cancels out.
    encode(&Plan {
        width: plan.width,
        height: plan.height,
        global_palette_rgb: plan.global_palette_rgb.clone(),
        frames: vec![frame.clone()],
        repeat: IndexedGifRepeat::None,
    })
    .map(|v| v.len())
}

#[derive(Clone)]
struct State {
    history: Vec<Arc<Frame>>,
    canvas: Vec<u8>,
    bytes: usize,
}

fn bounds(
    before: &[u8],
    after: &[u8],
    width: usize,
    height: usize,
    control: &SearchControl<'_>,
) -> Result<(usize, usize, usize, usize), String> {
    let (mut left, mut top, mut right, mut bottom) = (width, height, 0, 0);
    for p in 0..width * height {
        if p.is_multiple_of(4096) {
            control.checkpoint()?;
        }
        if before[p * 4..p * 4 + 4] != after[p * 4..p * 4 + 4] {
            left = left.min(p % width);
            top = top.min(p / width);
            right = right.max(p % width + 1);
            bottom = bottom.max(p / width + 1);
        }
    }
    if left == width {
        Ok((0, 0, 1, 1))
    } else {
        Ok((left, top, right - left, bottom - top))
    }
}

fn crop_frame(
    plan: &Plan,
    source: &Frame,
    before: &[u8],
    target: &[u8],
    rect: (usize, usize, usize, usize),
    mask: bool,
    control: &SearchControl<'_>,
) -> Result<Option<Frame>, String> {
    let (left, top, width, height) = rect;
    let screen_width = usize::from(plan.width);
    let mut frame = Frame {
        left: left as u16,
        top: top as u16,
        width: width as u16,
        height: height as u16,
        delay_cs: source.delay_cs,
        disposal: source.disposal,
        transparent_index: source.transparent_index,
        local_palette_rgb: source.local_palette_rgb.clone(),
        indices: Vec::with_capacity(width * height),
    };
    if mask && frame.transparent_index.is_none() {
        let table = palette(plan, source);
        let mut used = [false; 256];
        for chunk in source.indices.chunks(4096) {
            control.checkpoint()?;
            for &index in chunk {
                used[usize::from(index)] = true;
            }
        }
        let free = (0..table.len() / 3).find(|&i| !used[i]);
        if let Some(index) = free {
            frame.transparent_index = Some(index as u8);
        } else if table.len() < 768 {
            let index = table.len() / 3;
            let mut expanded = table.to_vec();
            expanded.resize((index + 1).next_power_of_two() * 3, 0);
            frame.local_palette_rgb = Some(expanded);
            frame.transparent_index = Some(index as u8);
        } else {
            return Ok(None);
        }
    }
    for y in top..top + height {
        control.checkpoint()?;
        for x in left..left + width {
            let p = y * screen_width + x;
            let unchanged = before[p * 4..p * 4 + 4] == target[p * 4..p * 4 + 4];
            // Transparent drawing cannot erase an earlier opaque pixel.
            if target[p * 4 + 3] == 0 && !unchanged {
                return Ok(None);
            }
            frame.indices.push(if mask && unchanged {
                frame.transparent_index.expect("mask transparency")
            } else {
                source.indices[p]
            });
        }
    }
    Ok(Some(frame))
}

/// Joint rectangle / transparent-hole / disposal beam search. Local palette
/// switches are compared in resolved RGBA, never in palette-index space.
pub(crate) fn structure(
    full: &Plan,
    beam_width: usize,
    budget: usize,
) -> Result<(Plan, SearchStats), String> {
    structure_controlled(full, beam_width, &mut research_control(budget))
}

pub(crate) fn structure_controlled(
    full: &Plan,
    beam_width: usize,
    control: &mut SearchControl<'_>,
) -> Result<(Plan, SearchStats), String> {
    if !(1..=4).contains(&beam_width) {
        return Err("beam width must be 1..=4".into());
    }
    control.preflight(full, beam_width)?;
    if full
        .frames
        .iter()
        .any(|f| f.left != 0 || f.top != 0 || f.width != full.width || f.height != full.height)
    {
        return Err("structure search requires full frames".into());
    }
    let desired = controlled_display(full, control)?;
    let (w, h) = (usize::from(full.width), usize::from(full.height));
    let background = if full.frames.iter().any(|f| f.transparent_index.is_some()) {
        [0, 0, 0, 0]
    } else {
        [
            full.global_palette_rgb[0],
            full.global_palette_rgb[1],
            full.global_palette_rgb[2],
            255,
        ]
    };
    let mut states = vec![State {
        history: vec![],
        canvas: background.repeat(w * h),
        bytes: 0,
    }];
    let mut stats = SearchStats::default();
    for (n, (source, target)) in full.frames.iter().zip(&desired).enumerate() {
        control.checkpoint()?;
        let mut proposals = Vec::new();
        for state in &states {
            let mut rects = vec![(0, 0, w, h)];
            if n > 0 {
                let rect = bounds(&state.canvas, target, w, h, control)?;
                if rect != rects[0] {
                    rects.push(rect);
                }
            }
            for rect in rects {
                for mask in [false, true] {
                    // The first display is a complete anchor on every loop.
                    if n == 0 && mask {
                        continue;
                    }
                    let Some(frame) =
                        crop_frame(full, source, &state.canvas, target, rect, mask, control)?
                    else {
                        continue;
                    };
                    control.probe()?;
                    let cost = frame_cost(full, &frame, &mut stats, usize::MAX)?;
                    control.checkpoint()?;
                    for disposal in [Disposal::Keep, Disposal::Previous, Disposal::Background] {
                        let mut next = target.clone();
                        match disposal {
                            Disposal::Previous => next.clone_from(&state.canvas),
                            Disposal::Background => {
                                for y in rect.1..rect.1 + rect.3 {
                                    control.checkpoint()?;
                                    for x in rect.0..rect.0 + rect.2 {
                                        next[(y * w + x) * 4..(y * w + x) * 4 + 4]
                                            .copy_from_slice(&background);
                                    }
                                }
                            }
                            _ => {}
                        }
                        // When a masked candidate introduces transparency to an
                        // opaque stream, Background would change initialization
                        // semantics. Keep/Previous remain well-defined.
                        if disposal == Disposal::Background && background[3] == 255 {
                            continue;
                        }
                        if n == 0 && background[3] == 255 && disposal == Disposal::Previous {
                            continue;
                        }
                        if n + 1 == full.frames.len()
                            && full.repeat == IndexedGifRepeat::Infinite
                            && desired[0]
                                .chunks_exact(4)
                                .zip(next.chunks_exact(4))
                                .any(|(a, b)| a[3] == 0 && a != b)
                        {
                            continue;
                        }
                        let mut frame = frame.clone();
                        frame.disposal = disposal;
                        let mut history = state.history.clone();
                        history.push(Arc::new(frame));
                        proposals.push(State {
                            history,
                            canvas: next,
                            bytes: state.bytes + cost,
                        });
                    }
                }
            }
        }
        proposals.sort_by_key(|s| s.bytes);
        states.clear();
        for state in proposals {
            if states.iter().any(|s| s.canvas == state.canvas) {
                continue;
            }
            states.push(state);
            if states.len() == beam_width {
                break;
            }
        }
        if states.is_empty() {
            return Err("no valid disposal path".into());
        }
    }
    // Cost ordering is exact for this restricted search; pixel equivalence is
    // checked again, including two loop cycles. The input remains a fallback.
    for state in states {
        let candidate = Plan {
            frames: state.history.into_iter().map(|f| (*f).clone()).collect(),
            width: full.width,
            height: full.height,
            global_palette_rgb: full.global_palette_rgb.clone(),
            repeat: full.repeat,
        };
        let cycles = if full.repeat == IndexedGifRepeat::Infinite {
            2
        } else {
            1
        };
        if check_display(&candidate, &desired, cycles, control).is_err() {
            control.checkpoint()?;
            continue;
        }
        stats.palette_boundary_rectangles = candidate
            .frames
            .iter()
            .enumerate()
            .skip(1)
            .filter(|(n, f)| {
                palette(full, &full.frames[*n - 1]) != palette(full, &full.frames[*n])
                    && (f.width != full.width || f.height != full.height)
            })
            .count();
        return Ok((candidate, stats));
    }
    Err("structure candidates failed display equivalence".into())
}

fn protected(
    indices: &[u8],
    table: &[u8],
    transparent: Option<u8>,
    p: usize,
    w: usize,
    h: usize,
) -> bool {
    if p.is_multiple_of(w)
        || p % w + 1 == w
        || p < w
        || p + w >= w * h
        || Some(indices[p]) == transparent
    {
        return true;
    }
    [p - 1, p + 1, p - w, p + w].iter().any(|&n| {
        Some(indices[n]) == transparent
            || delta(&color(table, indices[p]), &color(table, indices[n])) > 24
    })
}

/// Source-anchored temporal index reuse: bounded hold duration, no cumulative
/// source drift, no per-pixel RGB squared-error increase against the source.
pub(crate) fn temporal(
    full: &Plan,
    reference: &[u8],
    static_limit: u8,
    error_limit: u8,
) -> Result<(Plan, SearchStats), String> {
    let (w, h) = (usize::from(full.width), usize::from(full.height));
    let pixels = w * h;
    if reference.len() != pixels * 3 * full.frames.len() || static_limit > 2 || error_limit > 4 {
        return Err("invalid temporal reference or envelope".into());
    }
    if full
        .frames
        .iter()
        .any(|f| f.width != full.width || f.height != full.height || f.left != 0 || f.top != 0)
    {
        return Err("temporal search requires full frames".into());
    }
    let mut output = full.clone();
    let mut anchors = reference[..pixels * 3].to_vec();
    let mut holds = vec![0_u8; pixels];
    let mut durations = vec![0_u16; pixels];
    let mut stats = SearchStats::default();
    for n in 1..full.frames.len() {
        let source = &full.frames[n];
        let table = palette(full, source);
        let previous = &output.frames[n - 1];
        let previous_table = palette(full, previous);
        let mut map = HashMap::new();
        for (index, rgb) in table.chunks_exact(3).enumerate() {
            if Some(index as u8) != source.transparent_index {
                map.entry([rgb[0], rgb[1], rgb[2]]).or_insert(index as u8);
            }
        }
        let previous_indices = previous.indices.clone();
        let previous_table = previous_table.to_vec();
        for p in 0..pixels {
            let current_rgb = &reference[(n * pixels + p) * 3..(n * pixels + p) * 3 + 3];
            let prior_rgb = &reference[((n - 1) * pixels + p) * 3..((n - 1) * pixels + p) * 3 + 3];
            let original = color(table, source.indices[p]);
            let prior = color(&previous_table, previous_indices[p]);
            let squared = |rgb: &[u8]| -> u32 {
                (0..3)
                    .map(|c| u32::from(rgb[c].abs_diff(current_rgb[c])).pow(2))
                    .sum()
            };
            let source_edge = p % w == 0
                || p % w + 1 == w
                || p < w
                || p + w >= pixels
                || [p - 1, p + 1, p - w, p + w].iter().any(|&q| {
                    delta(
                        current_rgb,
                        &reference[(n * pixels + q) * 3..(n * pixels + q) * 3 + 3],
                    ) > 24
                });
            let can_hold = !source_edge
                && !protected(&source.indices, table, source.transparent_index, p, w, h)
                && full.frames[n - 1].transparent_index != Some(previous_indices[p])
                && delta(current_rgb, prior_rgb) <= static_limit
                && delta(current_rgb, &anchors[p * 3..p * 3 + 3]) <= static_limit
                && delta(&original, &prior) <= error_limit
                && squared(&prior) <= squared(&original)
                && holds[p] < 2
                && durations[p].saturating_add(source.delay_cs) <= 16;
            let exact = map
                .get(&[current_rgb[0], current_rgb[1], current_rgb[2]])
                .filter(|_| {
                    !source_edge
                        && !protected(&source.indices, table, source.transparent_index, p, w, h)
                        && delta(current_rgb, prior_rgb) <= static_limit
                        && delta(&original, current_rgb) <= error_limit
                });
            if let Some(&index) = exact {
                output.frames[n].indices[p] = index;
                stats.exact_source_choices += usize::from(index != source.indices[p]);
                holds[p] = 0;
                durations[p] = 0;
                anchors[p * 3..p * 3 + 3].copy_from_slice(current_rgb);
            } else if let Some(&index) = map.get(&prior).filter(|_| can_hold) {
                output.frames[n].indices[p] = index;
                holds[p] += 1;
                durations[p] += source.delay_cs;
                stats.temporal_holds += usize::from(index != source.indices[p]);
            } else {
                holds[p] = 0;
                durations[p] = 0;
                anchors[p * 3..p * 3 + 3].copy_from_slice(current_rgb);
            }
        }
    }
    stats.changed_indices = stats.temporal_holds + stats.exact_source_choices;
    Ok((output, stats))
}

fn spatial_variant(
    frame: &Frame,
    table: &[u8],
    start: &[u8],
    epsilon: u8,
    vertical: bool,
    range: std::ops::Range<usize>,
) -> Vec<u8> {
    let mut result = start.to_vec();
    let (w, h) = (usize::from(frame.width), usize::from(frame.height));
    for p in range {
        if protected(&frame.indices, table, frame.transparent_index, p, w, h) {
            continue;
        }
        let neighbors = if vertical {
            [result[p - w], result[p - 1]]
        } else {
            [result[p - 1], result[p - w]]
        };
        if let Some(&index) = neighbors.iter().find(|&&index| {
            Some(index) != frame.transparent_index
                && delta(&color(table, frame.indices[p]), &color(table, index)) <= epsilon
        }) {
            result[p] = index;
        }
    }
    result
}

/// Coordinate descent in index space. Each move is measured by the actual
/// GIF/LZW writer, including dictionary growth and clear decisions. Proxy run
/// length alone cannot select a winner. Error always refers to the input frame.
pub(crate) fn lzw(plan: &Plan, epsilon: u8, budget: usize) -> Result<(Plan, SearchStats), String> {
    if !(1..=4).contains(&epsilon) {
        return Err("LZW envelope must be 1..=4".into());
    }
    let mut output = plan.clone();
    let mut stats = SearchStats::default();
    for (n, frame) in plan.frames.iter().enumerate() {
        let table = palette(plan, frame);
        let mut best = frame.clone();
        let mut best_cost = frame_cost(plan, &best, &mut stats, budget)?;
        let len = frame.indices.len();
        let middle = (usize::from(frame.height) / 2) * usize::from(frame.width);
        for range in [0..len, 0..middle, middle..len] {
            let anchor = best.indices.clone();
            for vertical in [false, true] {
                let indices =
                    spatial_variant(frame, table, &anchor, epsilon, vertical, range.clone());
                if indices == best.indices {
                    continue;
                }
                let squared: u64 = indices
                    .iter()
                    .zip(&frame.indices)
                    .map(|(&a, &b)| {
                        let a = color(table, a);
                        let b = color(table, b);
                        (0..3)
                            .map(|c| u64::from(a[c].abs_diff(b[c])).pow(2))
                            .sum::<u64>()
                    })
                    .sum();
                if squared > (len * 3 * 9) as u64 {
                    continue;
                }
                let candidate = Frame {
                    indices,
                    ..frame.clone()
                };
                let bytes = frame_cost(plan, &candidate, &mut stats, budget)?;
                if bytes < best_cost {
                    best_cost = bytes;
                    best = candidate;
                }
            }
        }
        stats.changed_indices += frame
            .indices
            .iter()
            .zip(&best.indices)
            .filter(|(a, b)| a != b)
            .count();
        output.frames[n] = best;
    }
    Ok((output, stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(w: u16, h: u16, count: usize) -> Plan {
        let table: Vec<u8> = (0_u16..256).flat_map(|v| [v as u8; 3]).collect();
        Plan {
            width: w,
            height: h,
            global_palette_rgb: table,
            repeat: IndexedGifRepeat::Infinite,
            frames: (0..count)
                .map(|_| Frame {
                    left: 0,
                    top: 0,
                    width: w,
                    height: h,
                    delay_cs: 8,
                    disposal: Disposal::Keep,
                    transparent_index: None,
                    local_palette_rgb: None,
                    indices: vec![100; usize::from(w) * usize::from(h)],
                })
                .collect(),
        }
    }
    #[test]
    fn structure_reuses_resolved_colors_across_palette_switches() {
        let mut plan = fixture(96, 64, 3);
        let mut table = plan.global_palette_rgb.clone();
        table.swap(300, 303);
        table.swap(301, 304);
        table.swap(302, 305);
        plan.frames[1].local_palette_rgb = Some(table);
        plan.frames[1].indices.fill(101);
        plan.frames[1].indices[300] = 110;
        let (candidate, stats) = structure(&plan, 3, 100).unwrap();
        assert_eq!(display(&candidate).unwrap(), display(&plan).unwrap());
        assert!(stats.palette_boundary_rectangles > 0);
        assert!(encode(&candidate).unwrap().len() < encode(&plan).unwrap().len());
    }
    #[test]
    fn structure_clears_transparent_sprite_and_preserves_two_loops() {
        let mut plan = fixture(48, 32, 4);
        for (n, f) in plan.frames.iter_mut().enumerate() {
            f.transparent_index = Some(255);
            f.disposal = Disposal::Background;
            f.indices.fill(255);
            for y in 10..16 {
                for x in 5 + n * 8..11 + n * 8 {
                    f.indices[y * 48 + x] = 120;
                }
            }
        }
        let (candidate, _) = structure(&plan, 3, 150).unwrap();
        let mut twice = candidate.clone();
        twice.frames.extend(candidate.frames.clone());
        let expected = display(&plan).unwrap();
        assert_eq!(
            display(&twice).unwrap(),
            expected
                .iter()
                .chain(&expected)
                .cloned()
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn structure_fails_closed_on_budget_exhaustion() {
        assert!(structure(&fixture(8, 8, 3), 3, 1)
            .unwrap_err()
            .contains("budget"));
    }
    #[test]
    fn structure_cancellation_interrupts_pixel_work_before_encoding() {
        let calls = std::cell::Cell::new(0);
        let cancelled = || {
            calls.set(calls.get() + 1);
            if calls.get() >= 10 {
                Err("test cancelled".into())
            } else {
                Ok(())
            }
        };
        let mut control = SearchControl::new(100, Duration::MAX, usize::MAX, &cancelled);
        assert!(structure_controlled(&fixture(96, 64, 6), 3, &mut control)
            .unwrap_err()
            .contains("cancelled"));
        assert_eq!(control.probes, 0);
        assert_eq!(calls.get(), 10);
    }
    #[test]
    fn structure_memory_estimate_allows_480p_60_frames_and_rejects_large_timelines() {
        let mut control = SearchControl::new(1024, Duration::MAX, 384 * 1024 * 1024, &|| Ok(()));
        let plan = fixture(854, 480, 60);
        control.preflight(&plan, 3).unwrap();
        assert!(control.estimated_peak_bytes < 384 * 1024 * 1024);
        let mut excessive = plan;
        excessive.width = 1920;
        excessive.height = 1080;
        assert!(control
            .preflight(&excessive, 3)
            .unwrap_err()
            .contains("memory budget"));
    }
    #[test]
    fn controlled_flatten_matches_existing_disposal_simulator() {
        let mut source = fixture(32, 24, 5);
        for (n, frame) in source.frames.iter_mut().enumerate() {
            frame.transparent_index = Some(255);
            frame.indices.fill(255);
            frame.indices[n * 70] = 100 + n as u8;
            frame.disposal = [Disposal::Keep, Disposal::Previous, Disposal::Background][n % 3];
        }
        let mut control = research_control(100);
        assert_eq!(
            controlled_display(&source, &control).unwrap(),
            display(&source).unwrap()
        );
        let flattened = flatten_controlled(&source, &mut control).unwrap();
        assert_eq!(display(&flattened).unwrap(), display(&source).unwrap());
    }
    #[test]
    fn temporal_stabilizes_equal_error_dither_without_freezing_motion() {
        let mut plan = fixture(24, 24, 4);
        plan.global_palette_rgb[300..303].fill(102);
        plan.frames[0].indices.fill(99);
        plan.frames[1].indices.fill(101);
        plan.frames[2].indices.fill(101);
        plan.frames[3].indices.fill(120);
        let mut reference = vec![100; 24 * 24 * 3 * 4];
        reference[24 * 24 * 3 * 3..].fill(120);
        let (candidate, stats) = temporal(&plan, &reference, 0, 2).unwrap();
        assert!(stats.temporal_holds > 0);
        assert_eq!(candidate.frames[1].indices[25], 99);
        assert_eq!(candidate.frames[3].indices, plan.frames[3].indices);
        assert_eq!(candidate.frames[1].indices[0], 101);
    }
    #[test]
    fn temporal_releases_holds_when_display_duration_exceeds_budget() {
        let mut plan = fixture(12, 12, 2);
        plan.global_palette_rgb[300..303].fill(102);
        plan.frames[0].indices.fill(99);
        plan.frames[1].indices.fill(101);
        plan.frames[1].delay_cs = 25;
        let (candidate, stats) = temporal(&plan, &vec![100; 12 * 12 * 3 * 2], 0, 2).unwrap();
        assert_eq!(candidate, plan);
        assert_eq!(stats.temporal_holds, 0);
    }
    #[test]
    fn temporal_exact_source_choice_removes_static_quantization_noise() {
        let mut plan = fixture(12, 12, 3);
        plan.frames[0].indices.fill(99);
        plan.frames[1].indices.fill(101);
        plan.frames[2].indices.fill(99);
        let (candidate, stats) = temporal(&plan, &vec![100; 12 * 12 * 3 * 3], 0, 2).unwrap();
        assert!(stats.exact_source_choices > 0);
        assert_eq!(candidate.frames[1].indices[13], 100);
        assert_eq!(candidate.frames[2].indices[13], 100);
    }

    #[test]
    fn lzw_selects_real_byte_savings_and_keeps_strong_edges() {
        let mut plan = fixture(96, 64, 2);
        for frame in &mut plan.frames {
            let mut seed = 0x1234_abcd_u32;
            for i in &mut frame.indices {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *i = 100 + (seed % 3) as u8;
            }
            for y in 10..54 {
                frame.indices[y * 96 + 48] = 220;
            }
        }
        let (candidate, stats) = lzw(&plan, 2, 100).unwrap();
        assert!(stats.changed_indices > 0);
        assert!(encode(&candidate).unwrap().len() < encode(&plan).unwrap().len());
        for y in 10..54 {
            assert_eq!(candidate.frames[0].indices[y * 96 + 48], 220);
        }
        for (a, b) in candidate.frames[0]
            .indices
            .iter()
            .zip(&plan.frames[0].indices)
        {
            assert!(a.abs_diff(*b) <= 2);
        }
    }
}
