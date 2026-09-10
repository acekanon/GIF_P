//! Bounded compression experiments and an opt-in production structure search.
//! Every proposal starts from the frozen input; serialized GIF bytes are the cost.
use super::indexed_gif::{
    simulate_indexed_gif, write_indexed_gif, IndexedGifDisposal as Disposal,
    IndexedGifFrame as Frame, IndexedGifPlan as Plan, IndexedGifRepeat,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{self, Write},
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
    external_bytes: usize,
    stage_probe_limit: Option<usize>,
    stage_deadline: Option<Instant>,
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
            external_bytes: 0,
            stage_probe_limit: None,
            stage_deadline: None,
            cancelled,
            probes: 0,
            estimated_peak_bytes: 0,
        }
    }

    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        (self.cancelled)()?;
        if self.started.elapsed() >= self.max_time {
            return Err("compression wall-time budget exhausted".into());
        }
        if self
            .stage_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err("compression stage wall-time budget exhausted".into());
        }
        Ok(())
    }

    pub(crate) fn probe(&mut self) -> Result<(), String> {
        self.checkpoint()?;
        if self.probes >= self.max_probes {
            return Err("compression probe budget exhausted".into());
        }
        if self
            .stage_probe_limit
            .is_some_and(|limit| self.probes >= limit)
        {
            return Err("compression stage probe budget exhausted".into());
        }
        self.probes += 1;
        Ok(())
    }

    /// Replace the count of additional live buffers owned by the adapter.
    /// RGB reference and mask arguments passed to a controlled lossy function
    /// are already included there; do not count those twice. During structure
    /// or encode phases, count any RGB/mask buffers still held by the adapter.
    pub(crate) fn reserve_external(&mut self, bytes: usize) -> Result<(), String> {
        self.checkpoint()?;
        if bytes > self.max_memory {
            return Err("compression external memory budget exhausted".into());
        }
        self.external_bytes = bytes;
        self.estimated_peak_bytes = self.estimated_peak_bytes.max(bytes);
        Ok(())
    }

    /// A failed/exhausted candidate cannot consume another candidate's reserved
    /// probes. Global counters/deadline remain in force across all stages.
    pub(crate) fn with_stage_budget<T>(
        &mut self,
        probes: usize,
        time: Duration,
        run: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let old_probe_limit = self.stage_probe_limit;
        let old_deadline = self.stage_deadline;
        let probe_limit = self.probes.saturating_add(probes).min(self.max_probes);
        self.stage_probe_limit =
            Some(old_probe_limit.map_or(probe_limit, |old| old.min(probe_limit)));
        self.stage_deadline = match (old_deadline, Instant::now().checked_add(time)) {
            (Some(old), Some(new)) => Some(old.min(new)),
            (old, None) => old,
            (None, new) => new,
        };
        let result = self.checkpoint().and_then(|()| run(self));
        self.stage_probe_limit = old_probe_limit;
        self.stage_deadline = old_deadline;
        result
    }

    fn account_memory(&mut self, bytes: usize) -> Result<(), String> {
        let estimate = bytes
            .checked_add(self.external_bytes)
            .ok_or_else(|| "compression memory budget overflow".to_string())?;
        self.estimated_peak_bytes = self.estimated_peak_bytes.max(estimate);
        if estimate > self.max_memory {
            return Err("compression memory budget exhausted".into());
        }
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
        self.account_memory(estimate)
    }

    fn preflight_indices(
        &mut self,
        plan: &Plan,
        reference: usize,
        mask: usize,
    ) -> Result<(), String> {
        self.checkpoint()?;
        let pixels = usize::from(plan.width) * usize::from(plan.height);
        let estimate = pixels
            .checked_mul(plan.frames.len())
            .and_then(|v| v.checked_mul(4))
            .and_then(|v| v.checked_add(reference))
            .and_then(|v| v.checked_add(mask))
            .and_then(|v| v.checked_add(pixels.checked_mul(24)?))
            .and_then(|v| v.checked_add(32 * 1024 * 1024))
            .ok_or_else(|| "compression memory budget overflow".to_string())?;
        self.account_memory(estimate)
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
    /// Same-writer cost, excluding source-writer differences. Values are sums
    /// of independently encoded image costs, whose constant headers cancel.
    #[serde(skip_serializing_if = "is_zero")]
    pub baseline_bytes: usize,
    #[serde(skip_serializing_if = "is_zero")]
    pub selected_bytes: usize,
    #[serde(skip_serializing_if = "is_zero")]
    pub accepted_moves: usize,
    #[serde(skip_serializing_if = "is_zero")]
    pub protected_pixels: usize,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

pub(crate) fn encode(plan: &Plan) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    write_indexed_gif(&mut bytes, plan).map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub(crate) fn display(plan: &Plan) -> Result<Vec<Vec<u8>>, String> {
    simulate_indexed_gif(plan).map_err(|e| e.to_string())
}

struct CheckedWriter<'a, 'b> {
    bytes: &'a mut Vec<u8>,
    control: &'a SearchControl<'b>,
}

impl Write for CheckedWriter<'_, '_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.control.checkpoint().map_err(io::Error::other)?;
        self.bytes.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.control.checkpoint().map_err(io::Error::other)
    }
}

/// Count one complete real GIF encoding; cancellation is checked before
/// validation and at every writer call (including image-data sub-blocks).
pub(crate) fn encode_controlled(
    plan: &Plan,
    control: &mut SearchControl<'_>,
) -> Result<Vec<u8>, String> {
    control.preflight_indices(plan, 0, 0)?;
    validate_indices(plan, false, control)?;
    control.probe()?;
    let mut bytes = Vec::new();
    write_indexed_gif(
        CheckedWriter {
            bytes: &mut bytes,
            control,
        },
        plan,
    )
    .map_err(|e| e.to_string())?;
    control.checkpoint()?;
    Ok(bytes)
}

pub(crate) fn display_controlled(
    plan: &Plan,
    control: &mut SearchControl<'_>,
) -> Result<Vec<Vec<u8>>, String> {
    control.preflight(plan, 0)?;
    controlled_display(plan, control)
}

fn validate_indices(plan: &Plan, full: bool, control: &SearchControl<'_>) -> Result<usize, String> {
    control.checkpoint()?;
    let pixels = usize::from(plan.width) * usize::from(plan.height);
    if pixels == 0 || plan.frames.is_empty() {
        return Err("empty indexed timeline".into());
    }
    if plan.global_palette_rgb.len() < 6
        || plan.global_palette_rgb.len() > 768
        || !plan.global_palette_rgb.len().is_multiple_of(3)
        || !(plan.global_palette_rgb.len() / 3).is_power_of_two()
    {
        return Err("invalid global indexed palette".into());
    }
    for frame in &plan.frames {
        control.checkpoint()?;
        let count = usize::from(frame.width) * usize::from(frame.height);
        let table = palette(plan, frame);
        if count == 0
            || frame.indices.len() != count
            || usize::from(frame.left) + usize::from(frame.width) > usize::from(plan.width)
            || usize::from(frame.top) + usize::from(frame.height) > usize::from(plan.height)
            || table.len() < 6
            || table.len() > 768
            || !table.len().is_multiple_of(3)
            || !(table.len() / 3).is_power_of_two()
            || frame
                .transparent_index
                .is_some_and(|i| usize::from(i) >= table.len() / 3)
        {
            return Err("invalid indexed frame or palette".into());
        }
        if full
            && (frame.left != 0
                || frame.top != 0
                || frame.width != plan.width
                || frame.height != plan.height)
        {
            return Err("controlled lossy search requires full display frames".into());
        }
        for chunk in frame.indices.chunks(4096) {
            control.checkpoint()?;
            if chunk.iter().any(|&i| usize::from(i) >= table.len() / 3) {
                return Err("invalid indexed color".into());
            }
        }
    }
    pixels
        .checked_mul(plan.frames.len())
        .ok_or_else(|| "indexed timeline size overflow".into())
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
    control: &mut SearchControl<'_>,
) -> Result<usize, String> {
    // A GIF image starts its own dictionary. Constant per-image wrapper bytes
    // cancel for comparisons, so these are exact serialized-LZW cost deltas.
    let bytes = encode_controlled(
        &Plan {
            width: plan.width,
            height: plan.height,
            global_palette_rgb: plan.global_palette_rgb.clone(),
            frames: vec![frame.clone()],
            repeat: IndexedGifRepeat::None,
        },
        control,
    )?;
    stats.compression_probes += 1;
    Ok(bytes.len())
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
                    let cost = frame_cost(full, &frame, &mut stats, control)?;
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
    temporal_controlled(
        full,
        reference,
        static_limit,
        error_limit,
        None,
        &mut research_control(usize::MAX),
    )
}

/// Reference and eligibility are frame-major, full-canvas RGB24 and one byte
/// per pixel respectively. A zero eligibility byte can only tighten the gate.
pub(crate) fn temporal_controlled(
    full: &Plan,
    reference: &[u8],
    static_limit: u8,
    error_limit: u8,
    eligibility: Option<&[u8]>,
    control: &mut SearchControl<'_>,
) -> Result<(Plan, SearchStats), String> {
    control.preflight_indices(full, reference.len(), eligibility.map_or(0, <[u8]>::len))?;
    let total = validate_indices(full, true, control)?;
    if total.checked_mul(3) != Some(reference.len())
        || eligibility.is_some_and(|m| m.len() != total)
    {
        return Err("invalid temporal reference or eligibility length".into());
    }
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
        control.checkpoint()?;
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
            if p.is_multiple_of(4096) {
                control.checkpoint()?;
            }
            if eligibility.is_some_and(|mask| mask[n * pixels + p] == 0) {
                stats.protected_pixels += 1;
                holds[p] = 0;
                durations[p] = 0;
                anchors[p * 3..p * 3 + 3]
                    .copy_from_slice(&reference[(n * pixels + p) * 3..(n * pixels + p) * 3 + 3]);
                continue;
            }
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
    control.checkpoint()?;
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
    control: &SearchControl<'_>,
) -> Result<Vec<u8>, String> {
    let mut result = start.to_vec();
    let (w, h) = (usize::from(frame.width), usize::from(frame.height));
    for p in range {
        if p.is_multiple_of(4096) {
            control.checkpoint()?;
        }
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
    Ok(result)
}

/// Coordinate descent in index space. Each move is measured by the actual
/// GIF/LZW writer, including dictionary growth and clear decisions. Proxy run
/// length alone cannot select a winner. Error always refers to the input frame.
pub(crate) fn lzw(plan: &Plan, epsilon: u8, budget: usize) -> Result<(Plan, SearchStats), String> {
    if !(1..=4).contains(&epsilon) {
        return Err("LZW envelope must be 1..=4".into());
    }
    let mut control = research_control(budget);
    control.preflight_indices(plan, 0, 0)?;
    validate_indices(plan, false, &control)?;
    let mut output = plan.clone();
    let mut stats = SearchStats::default();
    for (n, frame) in plan.frames.iter().enumerate() {
        control.checkpoint()?;
        let table = palette(plan, frame);
        let mut best = frame.clone();
        let mut best_cost = frame_cost(plan, &best, &mut stats, &mut control)?;
        let len = frame.indices.len();
        let middle = (usize::from(frame.height) / 2) * usize::from(frame.width);
        for range in [0..len, 0..middle, middle..len] {
            let anchor = best.indices.clone();
            for vertical in [false, true] {
                let indices = spatial_variant(
                    frame,
                    table,
                    &anchor,
                    epsilon,
                    vertical,
                    range.clone(),
                    &control,
                )?;
                if indices == best.indices {
                    continue;
                }
                let mut squared = 0_u64;
                for (candidate, original) in indices.chunks(4096).zip(frame.indices.chunks(4096)) {
                    control.checkpoint()?;
                    squared += candidate
                        .iter()
                        .zip(original)
                        .map(|(&a, &b)| {
                            let a = color(table, a);
                            let b = color(table, b);
                            (0..3)
                                .map(|c| u64::from(a[c].abs_diff(b[c])).pow(2))
                                .sum::<u64>()
                        })
                        .sum::<u64>();
                }
                if squared > (len * 3 * 9) as u64 {
                    continue;
                }
                let candidate = Frame {
                    indices,
                    ..frame.clone()
                };
                let bytes = frame_cost(plan, &candidate, &mut stats, &mut control)?;
                if bytes < best_cost {
                    best_cost = bytes;
                    best = candidate;
                }
            }
        }
        for (source, candidate) in frame.indices.chunks(4096).zip(best.indices.chunks(4096)) {
            control.checkpoint()?;
            stats.changed_indices += source.iter().zip(candidate).filter(|(a, b)| a != b).count();
        }
        output.frames[n] = best;
    }
    Ok((output, stats))
}

const LZW_GUARD_BLOCK: usize = 8;

#[derive(Clone, Copy)]
enum GuardedMove {
    Alias,
    Nearest,
    Neighbor(bool),
    Period(usize),
    Pair { vertical: bool, phase: usize },
}

/// Guard RGB changes to locally flat source blocks. Exact-color aliases remain
/// legal outside those blocks; external eligibility zero forbids all changes.
fn lzw_eligibility(
    frame: &Frame,
    table: &[u8],
    reference: Option<&[u8]>,
    mask: Option<&[u8]>,
    control: &SearchControl<'_>,
) -> Result<Vec<u8>, String> {
    let (w, h) = (usize::from(frame.width), usize::from(frame.height));
    let mut flags = vec![1; w * h];
    for (p, flag) in flags.iter_mut().enumerate() {
        if p.is_multiple_of(4096) {
            control.checkpoint()?;
        }
        if mask.is_some_and(|m| m[p] == 0) || Some(frame.indices[p]) == frame.transparent_index {
            *flag = 0;
        }
    }
    let Some(reference) = reference else {
        return Ok(flags);
    };
    for top in (0..h).step_by(LZW_GUARD_BLOCK) {
        control.checkpoint()?;
        for left in (0..w).step_by(LZW_GUARD_BLOCK) {
            let right = (left + LZW_GUARD_BLOCK).min(w);
            let bottom = (top + LZW_GUARD_BLOCK).min(h);
            let mut minimum = [255_u8; 3];
            let mut maximum = [0_u8; 3];
            for y in top..bottom {
                for x in left..right {
                    let p = (y * w + x) * 3;
                    for c in 0..3 {
                        minimum[c] = minimum[c].min(reference[p + c]);
                        maximum[c] = maximum[c].max(reference[p + c]);
                    }
                }
            }
            // A smooth ramp spanning >1/255 per 8x8 cell is not quantization
            // noise. Keep it unchanged instead of trusting a global RMSE score.
            if (0..3).any(|c| maximum[c] - minimum[c] > 1) {
                continue;
            }
            for y in top..bottom {
                for x in left..right {
                    let p = y * w + x;
                    if flags[p] == 0
                        || protected(&frame.indices, table, frame.transparent_index, p, w, h)
                    {
                        continue;
                    }
                    let rgb = &reference[p * 3..p * 3 + 3];
                    if [p - 1, p + 1, p - w, p + w]
                        .iter()
                        .any(|&q| delta(rgb, &reference[q * 3..q * 3 + 3]) > 8)
                    {
                        continue;
                    }
                    flags[p] = 2;
                }
            }
        }
    }
    Ok(flags)
}

fn squared_rgb(a: &[u8], b: &[u8]) -> u32 {
    (0..3).map(|c| u32::from(a[c].abs_diff(b[c])).pow(2)).sum()
}

fn guarded_replacement(
    frame: &Frame,
    table: &[u8],
    reference: Option<&[u8]>,
    flags: &[u8],
    p: usize,
    candidate: u8,
) -> bool {
    if flags[p] == 0 || Some(candidate) == frame.transparent_index {
        return false;
    }
    let original = color(table, frame.indices[p]);
    let replacement = color(table, candidate);
    if original == replacement {
        return true;
    }
    flags[p] == 2
        && reference.is_some_and(|rgb| {
            let target = &rgb[p * 3..p * 3 + 3];
            squared_rgb(&replacement, target) <= squared_rgb(&original, target)
        })
}

/// Enforce a source-anchored DC guard on every block, not only the whole image.
/// Unsafe blocks revert to the frozen input before the candidate is measured.
fn preserve_block_means(
    frame: &Frame,
    table: &[u8],
    reference: &[u8],
    indices: &mut [u8],
    control: &SearchControl<'_>,
) -> Result<(), String> {
    let (w, h) = (usize::from(frame.width), usize::from(frame.height));
    for top in (0..h).step_by(LZW_GUARD_BLOCK) {
        control.checkpoint()?;
        for left in (0..w).step_by(LZW_GUARD_BLOCK) {
            let right = (left + LZW_GUARD_BLOCK).min(w);
            let bottom = (top + LZW_GUARD_BLOCK).min(h);
            let mut old_bias = [0_i32; 3];
            let mut new_bias = [0_i32; 3];
            for y in top..bottom {
                for x in left..right {
                    let p = y * w + x;
                    if Some(frame.indices[p]) == frame.transparent_index {
                        continue;
                    }
                    let a = color(table, frame.indices[p]);
                    let b = color(table, indices[p]);
                    for c in 0..3 {
                        old_bias[c] += i32::from(a[c]) - i32::from(reference[p * 3 + c]);
                        new_bias[c] += i32::from(b[c]) - i32::from(reference[p * 3 + c]);
                    }
                }
            }
            if (0..3).any(|c| new_bias[c].abs() > old_bias[c].abs()) {
                for y in top..bottom {
                    indices[y * w + left..y * w + right]
                        .copy_from_slice(&frame.indices[y * w + left..y * w + right]);
                }
            }
        }
    }
    Ok(())
}

struct GuardedFrame<'a> {
    frame: &'a Frame,
    table: &'a [u8],
    reference: Option<&'a [u8]>,
    flags: Vec<u8>,
    alternatives: Vec<Vec<u8>>,
    aliases: Vec<u8>,
}

impl GuardedFrame<'_> {
    fn proposal(
        &self,
        start: &[u8],
        movement: GuardedMove,
        control: &SearchControl<'_>,
    ) -> Result<Vec<u8>, String> {
        let (w, h) = (
            usize::from(self.frame.width),
            usize::from(self.frame.height),
        );
        let mut result = start.to_vec();
        for y in 0..h {
            control.checkpoint()?;
            for x in 0..w {
                let p = y * w + x;
                if self.flags[p] == 0 {
                    continue;
                }
                let original = self.frame.indices[p];
                let alternatives = &self.alternatives[usize::from(original)];
                let allowed = |index: u8| {
                    alternatives.contains(&index)
                        && guarded_replacement(
                            self.frame,
                            self.table,
                            self.reference,
                            &self.flags,
                            p,
                            index,
                        )
                };
                let replacement = match movement {
                    GuardedMove::Alias => Some(self.aliases[usize::from(original)]),
                    GuardedMove::Nearest | GuardedMove::Pair { .. } => {
                        self.reference.and_then(|reference| {
                            let target = &reference[p * 3..p * 3 + 3];
                            let mut first: Option<(u32, [u8; 3], u8)> = None;
                            let mut second: Option<(u32, [u8; 3], u8)> = None;
                            for &index in alternatives {
                                if !allowed(index) {
                                    continue;
                                }
                                let rgb = color(self.table, index);
                                let item = (squared_rgb(&rgb, target), rgb, index);
                                if first.is_none_or(|old| item < old) {
                                    second = first;
                                    first = Some(item);
                                } else if first.is_some_and(|old| old.1 != rgb)
                                    && second.is_none_or(|old| item < old)
                                {
                                    second = Some(item);
                                }
                            }
                            let second_phase = match movement {
                                GuardedMove::Pair { vertical, phase } => {
                                    ((if vertical { x + y } else { x }) + phase) % 2 == 1
                                }
                                _ => false,
                            };
                            if second_phase {
                                second.or(first).map(|v| v.2)
                            } else {
                                first.map(|v| v.2)
                            }
                        })
                    }
                    GuardedMove::Neighbor(vertical) if x > 0 && y > 0 => {
                        let neighbors = if vertical {
                            [result[p - w], result[p - 1]]
                        } else {
                            [result[p - 1], result[p - w]]
                        };
                        neighbors.into_iter().find(|&index| allowed(index))
                    }
                    GuardedMove::Period(period) if x >= period => Some(result[p - period]),
                    _ => None,
                };
                if let Some(index) = replacement.filter(|&index| allowed(index)) {
                    result[p] = index;
                }
            }
        }
        if let Some(reference) = self.reference {
            preserve_block_means(self.frame, self.table, reference, &mut result, control)?;
        }
        Ok(result)
    }
}

/// Product LZW search uses actual serialized image costs for independent
/// dictionary-pattern moves, source-nearest choices and equivalent color aliases.
/// Every changed channel is <= epsilon from the frozen input; summed RGB
/// squared error per pixel cannot increase against the supplied source. Changes
/// remain outside edges/gradients and cannot increase block-mean error. The adapter must
/// still apply independent perceptual/timeline gates before adopting a file.
/// Missing source RGB only permits exactly equivalent palette aliases.
pub(crate) fn lzw_controlled(
    plan: &Plan,
    epsilon: u8,
    reference: Option<&[u8]>,
    eligibility: Option<&[u8]>,
    control: &mut SearchControl<'_>,
) -> Result<(Plan, SearchStats), String> {
    if !(1..=2).contains(&epsilon) {
        return Err("controlled LZW envelope must be 1..=2".into());
    }
    control.preflight_indices(
        plan,
        reference.map_or(0, <[u8]>::len),
        eligibility.map_or(0, <[u8]>::len),
    )?;
    let total = validate_indices(plan, true, control)?;
    if reference.is_some_and(|r| total.checked_mul(3) != Some(r.len()))
        || eligibility.is_some_and(|m| m.len() != total)
    {
        return Err("invalid LZW reference or eligibility length".into());
    }
    let pixels = usize::from(plan.width) * usize::from(plan.height);
    let mut output = plan.clone();
    let mut stats = SearchStats::default();
    for (n, frame) in plan.frames.iter().enumerate() {
        control.checkpoint()?;
        let table = palette(plan, frame);
        let reference = reference.map(|r| &r[n * pixels * 3..(n + 1) * pixels * 3]);
        let mask = eligibility.map(|m| &m[n * pixels..(n + 1) * pixels]);
        let flags = lzw_eligibility(frame, table, reference, mask, control)?;
        let mut aliases = Vec::with_capacity(table.len() / 3);
        let mut alternatives = Vec::with_capacity(table.len() / 3);
        for (index, rgb) in table.chunks_exact(3).enumerate() {
            control.checkpoint()?;
            let choices: Vec<u8> = table
                .chunks_exact(3)
                .enumerate()
                .filter(|(other, candidate)| {
                    Some(*other as u8) != frame.transparent_index
                        && delta(rgb, candidate) <= epsilon
                })
                .map(|(other, _)| other as u8)
                .collect();
            aliases.push(
                choices
                    .iter()
                    .copied()
                    .find(|&i| color(table, i).as_slice() == rgb)
                    .unwrap_or(index as u8),
            );
            alternatives.push(choices);
        }
        let (mut has_alias, mut has_lossy) = (false, false);
        for (block, indices) in frame.indices.chunks(4096).enumerate() {
            control.checkpoint()?;
            for (offset, &index) in indices.iter().enumerate() {
                let p = block * 4096 + offset;
                stats.protected_pixels += usize::from(flags[p] != 2);
                has_alias |= flags[p] != 0 && aliases[usize::from(index)] != index;
                has_lossy |= flags[p] == 2;
            }
        }
        let mut best = frame.clone();
        let baseline = frame_cost(plan, frame, &mut stats, control)?;
        let mut best_cost = baseline;
        stats.baseline_bytes += baseline;
        if has_alias || has_lossy {
            let guarded = GuardedFrame {
                frame,
                table,
                reference,
                flags,
                alternatives,
                aliases,
            };
            let movements = [
                GuardedMove::Alias,
                GuardedMove::Nearest,
                GuardedMove::Pair {
                    vertical: false,
                    phase: 0,
                },
                GuardedMove::Pair {
                    vertical: false,
                    phase: 1,
                },
                GuardedMove::Pair {
                    vertical: true,
                    phase: 0,
                },
                GuardedMove::Pair {
                    vertical: true,
                    phase: 1,
                },
                GuardedMove::Neighbor(false),
                GuardedMove::Neighbor(true),
                GuardedMove::Period(2),
                GuardedMove::Period(4),
                GuardedMove::Period(8),
            ];
            for movement in movements {
                control.checkpoint()?;
                if !has_lossy && !matches!(movement, GuardedMove::Alias) {
                    continue;
                }
                let indices = guarded.proposal(&best.indices, movement, control)?;
                if indices == best.indices {
                    continue;
                }
                let candidate = Frame {
                    indices,
                    ..frame.clone()
                };
                let bytes = frame_cost(plan, &candidate, &mut stats, control)?;
                if bytes < best_cost {
                    best = candidate;
                    best_cost = bytes;
                    stats.accepted_moves += 1;
                }
            }
        }
        for (source, candidate) in frame.indices.chunks(4096).zip(best.indices.chunks(4096)) {
            control.checkpoint()?;
            stats.changed_indices += source.iter().zip(candidate).filter(|(a, b)| a != b).count();
        }
        stats.selected_bytes += best_cost;
        output.frames[n] = best;
    }
    control.checkpoint()?;
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

    fn noisy_flat_fixture(w: u16, h: u16) -> Plan {
        let mut plan = fixture(w, h, 2);
        let mut seed = 0x9a2d_7613_u32;
        for frame in &mut plan.frames {
            for index in &mut frame.indices {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *index = if seed & 1 == 0 { 99 } else { 101 };
            }
        }
        plan
    }

    #[test]
    fn controlled_lzw_exact_alias_gain_is_separate_from_writer_reencoding() {
        let mut plan = noisy_flat_fixture(96, 64);
        plan.global_palette_rgb[303..306].fill(99);
        let mut control = research_control(100);
        let (selected, stats) = lzw_controlled(&plan, 1, None, None, &mut control).unwrap();
        let baseline_bytes = encode(&plan).unwrap().len();
        let selected_bytes = encode(&selected).unwrap().len();
        assert!(stats.accepted_moves > 0 && stats.changed_indices > 0);
        assert!(selected_bytes < baseline_bytes);
        assert_eq!(
            baseline_bytes - selected_bytes,
            stats.baseline_bytes - stats.selected_bytes
        );
        assert_eq!(display(&plan).unwrap(), display(&selected).unwrap());
        assert_eq!(stats.compression_probes, control.probes);
    }

    #[test]
    fn controlled_lzw_repairs_flat_quantization_with_one_level_error_limit() {
        let mut plan = noisy_flat_fixture(96, 64);
        let mut reference = vec![100; 96 * 64 * 3 * 2];
        for (n, frame) in plan.frames.iter_mut().enumerate() {
            for y in 10..54 {
                frame.indices[y * 96 + 48] = 220;
                reference[(n * 96 * 64 + y * 96 + 48) * 3..(n * 96 * 64 + y * 96 + 48) * 3 + 3]
                    .fill(220);
            }
        }
        let mut control = research_control(100);
        let (selected, stats) =
            lzw_controlled(&plan, 1, Some(&reference), None, &mut control).unwrap();
        assert!(stats.accepted_moves > 0 && stats.baseline_bytes > stats.selected_bytes);
        assert_eq!(
            encode(&plan).unwrap().len() - encode(&selected).unwrap().len(),
            stats.baseline_bytes - stats.selected_bytes
        );
        for (n, (source, candidate)) in plan.frames.iter().zip(&selected.frames).enumerate() {
            for (p, (&a, &b)) in source.indices.iter().zip(&candidate.indices).enumerate() {
                assert!(a.abs_diff(b) <= 1);
                let target = &reference[(n * 96 * 64 + p) * 3..(n * 96 * 64 + p) * 3 + 3];
                assert!(
                    squared_rgb(&color(&plan.global_palette_rgb, b), target)
                        <= squared_rgb(&color(&plan.global_palette_rgb, a), target)
                );
            }
            for y in 10..54 {
                assert_eq!(candidate.indices[y * 96 + 48], 220);
            }
        }
    }

    #[test]
    fn controlled_lzw_finds_repeating_balanced_patterns_without_erasing_dither_mean() {
        let mut plan = noisy_flat_fixture(96, 64);
        // The true flat source color is absent: a balanced 99/101 pattern is
        // useful, while collapsing to either color would add a block DC bias.
        plan.global_palette_rgb[300..303].fill(102);
        let reference = vec![100; 96 * 64 * 3 * 2];
        let mut control = research_control(100);
        let (selected, stats) =
            lzw_controlled(&plan, 2, Some(&reference), None, &mut control).unwrap();
        assert!(stats.accepted_moves > 0 && stats.baseline_bytes > stats.selected_bytes);
        assert!(encode(&selected).unwrap().len() < encode(&plan).unwrap().len());
        for (source, candidate) in plan.frames.iter().zip(&selected.frames) {
            let mut checked = candidate.indices.clone();
            preserve_block_means(
                source,
                &plan.global_palette_rgb,
                &reference[..96 * 64 * 3],
                &mut checked,
                &control,
            )
            .unwrap();
            assert_eq!(checked, candidate.indices);
            assert!(candidate.indices.iter().all(|&i| matches!(i, 99 | 101)));
        }
    }

    #[test]
    fn controlled_lzw_preserves_low_frequency_gradients_and_external_masks() {
        let mut plan = fixture(96, 64, 2);
        let mut reference = vec![0; 96 * 64 * 3 * 2];
        for (n, frame) in plan.frames.iter_mut().enumerate() {
            for y in 0..64 {
                for x in 0..96 {
                    let value = 40 + x as u8;
                    frame.indices[y * 96 + x] = if x % 2 == 0 { value - 1 } else { value + 1 };
                    reference[(n * 96 * 64 + y * 96 + x) * 3..(n * 96 * 64 + y * 96 + x) * 3 + 3]
                        .fill(value);
                }
            }
        }
        let mut control = research_control(100);
        let (selected, stats) =
            lzw_controlled(&plan, 2, Some(&reference), None, &mut control).unwrap();
        assert_eq!(selected, plan);
        assert_eq!(stats.changed_indices, 0);
        assert_eq!(stats.baseline_bytes, stats.selected_bytes);
        let plan = noisy_flat_fixture(96, 64);
        let reference = vec![100; 96 * 64 * 3 * 2];
        let mask = vec![0; 96 * 64 * 2];
        let (selected, _) =
            lzw_controlled(&plan, 2, Some(&reference), Some(&mask), &mut control).unwrap();
        assert_eq!(selected, plan);
    }

    #[test]
    fn controlled_temporal_matches_research_and_respects_protected_pixels() {
        let plan = noisy_flat_fixture(24, 24);
        let reference = vec![100; 24 * 24 * 3 * 2];
        let (legacy, _) = temporal(&plan, &reference, 1, 2).unwrap();
        let mut control = research_control(100);
        let (selected, _) =
            temporal_controlled(&plan, &reference, 1, 2, None, &mut control).unwrap();
        assert_eq!(selected, legacy);
        let mask = vec![0; 24 * 24 * 2];
        let (selected, stats) =
            temporal_controlled(&plan, &reference, 1, 2, Some(&mask), &mut control).unwrap();
        assert_eq!(selected, plan);
        assert_eq!(stats.changed_indices, 0);
    }

    #[test]
    fn shared_stage_budgets_restore_limits_and_include_external_memory() {
        let mut control = SearchControl::new(3, Duration::MAX, 64 * 1024 * 1024, &|| Ok(()));
        assert!(control
            .with_stage_budget(0, Duration::MAX, |c| c.probe())
            .unwrap_err()
            .contains("stage probe"));
        control.probe().unwrap();
        assert!(control
            .with_stage_budget(2, Duration::ZERO, |c| c.probe())
            .unwrap_err()
            .contains("stage wall-time"));
        control.probe().unwrap();
        assert_eq!(control.probes, 2);
        control.reserve_external(40 * 1024 * 1024).unwrap();
        assert!(control
            .preflight_indices(&fixture(24, 24, 2), 0, 0)
            .unwrap_err()
            .contains("memory budget"));
        control.reserve_external(0).unwrap();
        control
            .preflight_indices(&fixture(24, 24, 2), 0, 0)
            .unwrap();
        control.probe().unwrap();
        assert!(control.probe().unwrap_err().contains("probe budget"));
    }

    #[test]
    fn nested_stage_limits_restore_without_resetting_global_probes() {
        let mut control = SearchControl::new(5, Duration::MAX, usize::MAX, &|| Ok(()));
        control
            .with_stage_budget(3, Duration::MAX, |stage| {
                stage.probe()?;
                assert!(stage
                    .with_stage_budget(0, Duration::MAX, |inner| inner.probe())
                    .is_err());
                stage.probe()?;
                stage.probe()?;
                assert!(stage.probe().is_err());
                Ok(())
            })
            .unwrap();
        assert_eq!(control.probes, 3);
        control.probe().unwrap();
        control.probe().unwrap();
        assert!(control.probe().is_err());
    }

    #[test]
    fn controlled_searches_fail_closed_on_cancellation_invalid_layout_and_probe_budget() {
        let plan = noisy_flat_fixture(96, 64);
        let reference = vec![100; 96 * 64 * 3 * 2];
        let calls = std::cell::Cell::new(0);
        let cancelled = || {
            calls.set(calls.get() + 1);
            if calls.get() >= 10 {
                Err("cancelled during pixel work".into())
            } else {
                Ok(())
            }
        };
        let mut control = SearchControl::new(100, Duration::MAX, usize::MAX, &cancelled);
        assert!(
            lzw_controlled(&plan, 2, Some(&reference), None, &mut control)
                .unwrap_err()
                .contains("cancelled")
        );
        calls.set(0);
        let mut control = SearchControl::new(100, Duration::MAX, usize::MAX, &cancelled);
        assert!(
            temporal_controlled(&plan, &reference, 1, 2, None, &mut control)
                .unwrap_err()
                .contains("cancelled")
        );
        let mut control = research_control(0);
        assert!(
            lzw_controlled(&plan, 2, Some(&reference), None, &mut control)
                .unwrap_err()
                .contains("probe budget")
        );
        let mut control = research_control(100);
        assert!(lzw_controlled(&plan, 2, Some(&reference[..12]), None, &mut control).is_err());
        let mut invalid = plan;
        invalid.frames.clear();
        assert!(temporal_controlled(&invalid, &[], 1, 2, None, &mut control).is_err());
    }

    #[test]
    fn controlled_writer_checks_cancellation_after_probe_started() {
        let plan = noisy_flat_fixture(128, 128);
        let calls = std::cell::Cell::new(0);
        let cancelled = || {
            calls.set(calls.get() + 1);
            if calls.get() >= 24 {
                Err("writer cancelled".into())
            } else {
                Ok(())
            }
        };
        let mut control = SearchControl::new(10, Duration::MAX, usize::MAX, &cancelled);
        assert!(encode_controlled(&plan, &mut control)
            .unwrap_err()
            .contains("cancelled"));
        assert_eq!(control.probes, 1);
    }
}
