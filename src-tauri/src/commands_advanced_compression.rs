//! Source-aligned, bounded product admission for temporal and LZW proposals.
//! Every proposal is measured against one immutable export and an equivalent
//! structure-only writer control. Optional failure never changes staged bytes.
use super::index_compression::{read_plan, Plan};
use super::*;
use crate::core::compression_quality::{evaluate_quality_gate, QualityGateReport, QualityInput};
use crate::core::compression_search::{self, SearchControl, SearchStats};
use std::borrow::Cow;
use std::io::BufReader;

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TIMELINE_BYTES: usize = 96 * 1024 * 1024;
const MAX_MEMORY_BYTES: usize = 512 * 1024 * 1024;
const MAX_PROBES: usize = 1024;
const MAX_TIME: Duration = Duration::from_secs(60);
const STRUCTURE_BEAM: usize = 1;

pub(super) struct ReferenceSpec<'a> {
    pub(super) input: &'a Path,
    pub(super) request: &'a GifRequest,
    pub(super) encoder: &'a str,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdvancedCompressionStage {
    pub method: &'static str,
    pub status: String,
    pub before_bytes: u64,
    pub candidate_bytes: Option<u64>,
    pub writer_control_bytes: Option<u64>,
    pub algorithm_saved_bytes: u64,
    pub adopted: bool,
    pub verified: bool,
    pub compression_probes: usize,
    pub changed_pixels: usize,
    pub elapsed_ms: u64,
    pub reason: Option<String>,
    pub metrics: Option<QualityGateReport>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdvancedCompressionReport {
    pub algorithm_version: &'static str,
    pub status: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub adopted: bool,
    pub verified: bool,
    pub reference_kind: &'static str,
    pub elapsed_ms: u64,
    pub estimated_peak_bytes: usize,
    pub reason: Option<String>,
    pub stages: Vec<AdvancedCompressionStage>,
}

fn error(reason: impl ToString) -> AppError {
    AppError::EncodeFailed(reason.to_string())
}

// Diagnostics never expose filesystem paths or FFmpeg's command line.
fn public_reason(reason: &str) -> String {
    if reason.contains("budget") {
        "压缩搜索预算耗尽（budget），保留原结果".into()
    } else if reason.contains("source") {
        "源画面无法严格对齐，保留原结果".into()
    } else if reason.contains("decoder") || reason.contains("display") {
        "独立解码验证未通过，保留原结果".into()
    } else if reason.contains("metadata") {
        "帧数、播放时序或循环验证未通过，保留原结果".into()
    } else {
        "当前素材不适用或候选验证未通过，保留原结果".into()
    }
}

#[derive(Clone)]
struct Metadata {
    width: u16,
    height: u16,
    repeat: gif::Repeat,
    delays: Vec<u16>,
    aspect: u8,
}

impl Metadata {
    fn frames(&self) -> usize {
        self.delays.len()
    }

    fn pixels(&self) -> usize {
        usize::from(self.width) * usize::from(self.height)
    }

    fn rgba_bytes(&self) -> usize {
        self.pixels() * 4 * self.frames()
    }

    fn looping(&self) -> bool {
        self.repeat != gif::Repeat::Finite(0)
    }

    fn check(&self, plan: &Plan, aspect: u8) -> Result<(), AppError> {
        if plan.width != self.width
            || plan.height != self.height
            || plan.repeat != self.repeat
            || plan.frames.len() != self.frames()
            || plan
                .frames
                .iter()
                .zip(&self.delays)
                .any(|(f, &d)| f.delay != d)
            || aspect != self.aspect
            || plan.frames.iter().any(|f| f.needs_user_input)
        {
            return Err(error("metadata changed"));
        }
        Ok(())
    }
}

fn header(path: &Path) -> Result<[u8; 13], AppError> {
    let mut bytes = [0; 13];
    File::open(path)
        .map_err(error)?
        .read_exact(&mut bytes)
        .map_err(error)?;
    if !matches!(&bytes[..6], b"GIF87a" | b"GIF89a") || bytes[10] & 0x80 == 0 {
        return Err(error("GIF requires a global palette"));
    }
    Ok(bytes)
}

fn restore_aspect(path: &Path, aspect: u8) -> Result<(), AppError> {
    let mut file = OpenOptions::new().write(true).open(path).map_err(error)?;
    file.seek(io::SeekFrom::Start(12)).map_err(error)?;
    file.write_all(&[aspect]).map_err(error)
}

/// A bounded child writes raw pixels to disk. The process tree is killed on
/// cancellation/deadline/size overflow; neither stderr nor RGB uses a pipe.
fn run_bounded(
    mut command: Command,
    output: &Path,
    cap: usize,
    log: Option<&Path>,
    control: &SearchControl<'_>,
) -> Result<(), AppError> {
    control.checkpoint().map_err(error)?;
    command.stdout(Stdio::null()).stdin(Stdio::null());
    command.stderr(match log {
        Some(path) => Stdio::from(File::create(path).map_err(error)?),
        None => Stdio::null(),
    });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(error)?;
    let job = match KillOnCloseJob::attach(&child) {
        Ok(job) => job,
        Err(reason) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error(reason));
        }
    };
    let result = loop {
        if let Err(reason) = control.checkpoint() {
            break Err(error(reason));
        }
        if fs::metadata(output).is_ok_and(|m| m.len() > cap as u64)
            || log.is_some_and(|p| fs::metadata(p).is_ok_and(|m| m.len() > 1024 * 1024))
        {
            break Err(error("decode byte budget exhausted"));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(error("decoder failed"))
                }
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(reason) => break Err(error(reason)),
        }
    };
    if result.is_err() {
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
    }
    result?;
    if fs::metadata(output).map_err(error)?.len() > cap as u64
        || log.is_some_and(|p| fs::metadata(p).is_ok_and(|m| m.len() > 1024 * 1024))
    {
        return Err(error("decode byte budget exhausted"));
    }
    control.checkpoint().map_err(error)
}

fn normalize_alpha(frame: &mut [u8]) {
    for pixel in frame.chunks_exact_mut(4) {
        if pixel[3] == 0 {
            pixel[..3].fill(0);
        }
    }
}

fn visible_pixel_changes(
    before: &[Vec<u8>],
    after: &[Vec<u8>],
    width: usize,
    control: &SearchControl<'_>,
) -> Result<usize, AppError> {
    let row_bytes = width
        .checked_mul(4)
        .filter(|&n| n != 0)
        .ok_or_else(|| error("invalid display counter dimensions"))?;
    if before.len() != after.len() {
        return Err(error("display counter frame count mismatch"));
    }
    let mut changed = 0;
    for (before, after) in before.iter().zip(after) {
        if before.len() != after.len() || !before.len().is_multiple_of(row_bytes) {
            return Err(error("display counter frame dimensions mismatch"));
        }
        for (before, after) in before
            .chunks_exact(row_bytes)
            .zip(after.chunks_exact(row_bytes))
        {
            control.checkpoint().map_err(error)?;
            changed += before
                .chunks_exact(4)
                .zip(after.chunks_exact(4))
                .filter(|(a, b)| a[3] != b[3] || (a[3] != 0 && a[..3] != b[..3]))
                .count();
        }
    }
    Ok(changed)
}

/// Read one independent RGBA timeline; a second loop is compared on disk, so
/// a loop-dependent first frame can never be silently flattened away.
fn independent_display(
    ffmpeg: &Path,
    input: &Path,
    raw: &Path,
    metadata: &Metadata,
    control: &SearchControl<'_>,
) -> Result<Vec<Vec<u8>>, AppError> {
    // FFmpeg's GIF demuxer yields one cycle for NETSCAPE count 1. Preserve
    // that exact count in the file; the core checks loop reset separately.
    let cycles = if matches!(metadata.repeat, gif::Repeat::Finite(0 | 1)) {
        1
    } else {
        2
    };
    let count = metadata.frames() * cycles;
    let frame_bytes = metadata.pixels() * 4;
    structure_optimization::decode(ffmpeg, input, raw, count, frame_bytes * count, control)?;
    let mut reader = BufReader::new(File::open(raw).map_err(error)?);
    let mut frames = Vec::with_capacity(metadata.frames());
    for _ in 0..metadata.frames() {
        control.checkpoint().map_err(error)?;
        let mut frame = vec![0; frame_bytes];
        reader.read_exact(&mut frame).map_err(error)?;
        normalize_alpha(&mut frame);
        frames.push(frame);
    }
    if cycles == 2 {
        let mut frame = vec![0; frame_bytes];
        for expected in &frames {
            control.checkpoint().map_err(error)?;
            reader.read_exact(&mut frame).map_err(error)?;
            normalize_alpha(&mut frame);
            if &frame != expected {
                return Err(error("decoder loop display differs"));
            }
        }
    }
    Ok(frames)
}

fn source_dimensions(log: &str, width: u16, height: u16, count: usize) -> bool {
    let expected = format!("s:{width}x{height}");
    let lines: Vec<_> = log
        .lines()
        .filter(|line| line.contains("showinfo") && line.contains(" n:"))
        .collect();
    lines.len() == count
        && lines
            .iter()
            .all(|line| line.split_whitespace().any(|part| part == expected))
}

fn source_rgb(
    ffmpeg: &Path,
    reference: &ReferenceSpec<'_>,
    metadata: &Metadata,
    temp: &Path,
    control: &SearchControl<'_>,
) -> Result<Vec<u8>, AppError> {
    let raw = temp.join("source.rgba");
    let log = temp.join("source-decode.log");
    let expected = metadata.rgba_bytes();
    let frame_bytes = metadata.pixels() * 4;
    let mut command = Command::new(ffmpeg);
    command
        .args(["-y", "-v", "info"])
        .args(source_time_args(reference.request))
        .args(animation_demux_args(reference.input))
        .arg("-i")
        .arg(reference.input)
        .args(["-map", "0:v:0", "-an", "-vf"])
        .arg(format!(
            "{},showinfo",
            video_filter(reference.request, reference.encoder)
        ))
        .args(["-fps_mode", "passthrough", "-frames:v"])
        .arg((metadata.frames() + 1).to_string())
        .args(["-pix_fmt", "rgba", "-f", "rawvideo"])
        .arg(&raw);
    run_bounded(command, &raw, expected + frame_bytes, Some(&log), control)?;
    if fs::metadata(&raw).map_err(error)?.len() != expected as u64
        || !source_dimensions(
            &fs::read_to_string(&log).map_err(error)?,
            metadata.width,
            metadata.height,
            metadata.frames(),
        )
    {
        return Err(error("source sample alignment mismatch"));
    }
    let mut reader = BufReader::new(File::open(&raw).map_err(error)?);
    let mut frame = vec![0; frame_bytes];
    let mut rgb = Vec::with_capacity(expected / 4 * 3);
    for _ in 0..metadata.frames() {
        reader.read_exact(&mut frame).map_err(error)?;
        for row in frame.chunks(usize::from(metadata.width) * 4) {
            control.checkpoint().map_err(error)?;
            for pixel in row.chunks_exact(4) {
                if pixel[3] != 255 {
                    return Err(error("source contains alpha"));
                }
                rgb.extend_from_slice(&pixel[..3]);
            }
        }
    }
    Ok(rgb)
}

fn new_stage(method: &'static str, before_bytes: u64) -> AdvancedCompressionStage {
    AdvancedCompressionStage {
        method,
        status: "skipped".into(),
        before_bytes,
        candidate_bytes: None,
        writer_control_bytes: None,
        algorithm_saved_bytes: 0,
        adopted: false,
        verified: false,
        compression_probes: 0,
        changed_pixels: 0,
        elapsed_ms: 0,
        reason: None,
        metrics: None,
    }
}

struct CappedWriter<'a, 'b> {
    file: File,
    written: u64,
    control: &'a SearchControl<'b>,
}

impl Write for CappedWriter<'_, '_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.control.checkpoint().map_err(io::Error::other)?;
        if buffer.len() as u64 > MAX_FILE_BYTES.saturating_sub(self.written) {
            return Err(io::Error::other("candidate file byte budget exhausted"));
        }
        let count = self.file.write(buffer)?;
        self.written += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.control.checkpoint().map_err(io::Error::other)?;
        self.file.flush()
    }
}

fn write_bounded_candidate(
    plan: &IndexedGifPlan,
    repeat: gif::Repeat,
    path: &Path,
    control: &mut SearchControl<'_>,
) -> Result<(), String> {
    control.probe()?;
    let writer = CappedWriter {
        file: File::create(path).map_err(|e| e.to_string())?,
        written: 0,
        control,
    };
    let mut encoder = gif::Encoder::new(writer, plan.width, plan.height, &plan.global_palette_rgb)
        .map_err(|e| e.to_string())?;
    if repeat != gif::Repeat::Finite(0) {
        encoder.set_repeat(repeat).map_err(|e| e.to_string())?;
    }
    for frame in &plan.frames {
        control.checkpoint()?;
        encoder
            .write_frame(&gif::Frame {
                left: frame.left,
                top: frame.top,
                width: frame.width,
                height: frame.height,
                delay: frame.delay_cs,
                transparent: frame.transparent_index,
                dispose: match frame.disposal {
                    IndexedGifDisposal::Unspecified => gif::DisposalMethod::Any,
                    IndexedGifDisposal::Keep => gif::DisposalMethod::Keep,
                    IndexedGifDisposal::Previous => gif::DisposalMethod::Previous,
                    IndexedGifDisposal::Background => gif::DisposalMethod::Background,
                },
                palette: frame.local_palette_rgb.clone(),
                buffer: Cow::Borrowed(&frame.indices),
                ..Default::default()
            })
            .map_err(|e| e.to_string())?;
    }
    encoder.into_inner().map_err(|e| e.to_string())?;
    control.checkpoint()
}

fn write_compact(
    plan: &IndexedGifPlan,
    metadata: &Metadata,
    output: &Path,
    control: &mut SearchControl<'_>,
) -> Result<(), String> {
    let (compact, _) = compression_search::structure_controlled(plan, STRUCTURE_BEAM, control)?;
    write_bounded_candidate(&compact, metadata.repeat, output, control)?;
    restore_aspect(output, metadata.aspect).map_err(|e| e.to_string())?;
    Ok(())
}

struct Frozen {
    metadata: Metadata,
    full: IndexedGifPlan,
    display: Vec<Vec<u8>>,
    source: Option<Vec<u8>>,
    writer_bytes: u64,
}

fn prepare(
    ffmpeg: &Path,
    input: &Path,
    reference: Option<&ReferenceSpec<'_>>,
    temp: &Path,
    report: &mut AdvancedCompressionReport,
    control: &mut SearchControl<'_>,
) -> Result<Frozen, AppError> {
    control.checkpoint().map_err(error)?;
    if report.before_bytes > MAX_FILE_BYTES {
        return Err(error("file byte budget exhausted"));
    }
    let bytes = header(input)?;
    let original = read_plan(input, true)?;
    let metadata = Metadata {
        width: original.width,
        height: original.height,
        repeat: original.repeat,
        delays: original.frames.iter().map(|f| f.delay).collect(),
        aspect: bytes[12],
    };
    if metadata.frames() > 240 || metadata.rgba_bytes() > MAX_TIMELINE_BYTES {
        return Err(error("timeline memory budget exhausted"));
    }
    if original.frames.iter().any(|f| f.needs_user_input) {
        return Err(error("interactive GIF cannot be optimized"));
    }
    let original_index_bytes = original.frames.iter().map(|f| f.buffer.len()).sum();
    control
        .reserve_external(original_index_bytes)
        .map_err(error)?;
    let indexed = structure_optimization::indexed(&original, bytes[11], control)?;
    drop(original);
    control.reserve_external(0).map_err(error)?;
    let simulated = compression_search::display_controlled(&indexed, control).map_err(error)?;
    control
        .reserve_external(metadata.rgba_bytes())
        .map_err(error)?;
    let display = independent_display(
        ffmpeg,
        input,
        &temp.join("baseline.rgba"),
        &metadata,
        control,
    )?;
    if simulated != display {
        return Err(error("baseline simulator and decoder display differ"));
    }
    drop(simulated);
    control
        .reserve_external(metadata.rgba_bytes())
        .map_err(error)?;
    let full = compression_search::flatten_controlled(&indexed, control).map_err(error)?;
    drop(indexed);
    // Source extraction adds RGB24 plus one RGBA row/frame to the frozen data.
    let retained = metadata.rgba_bytes() + metadata.pixels() * metadata.frames();
    let source = if let Some(reference) = reference {
        control
            .reserve_external(retained + metadata.rgba_bytes() / 4 * 3 + metadata.pixels() * 4)
            .map_err(error)?;
        match control.with_stage_budget(0, Duration::from_secs(8), |control| {
            source_rgb(ffmpeg, reference, &metadata, temp, control).map_err(|e| e.to_string())
        }) {
            Ok(rgb) => {
                report.reference_kind = "prequantized_source";
                Some(rgb)
            }
            Err(_) => {
                check_conversion_cancelled()?;
                control.checkpoint().map_err(error)?;
                report.reference_kind = "unavailable";
                None
            }
        }
    } else {
        None
    };
    control
        .reserve_external(metadata.rgba_bytes() + source.as_ref().map_or(0, Vec::len))
        .map_err(error)?;
    let writer = temp.join("writer-control.gif");
    control
        .with_stage_budget(240, Duration::from_secs(15), |control| {
            write_compact(&full, &metadata, &writer, control)
        })
        .map_err(error)?;
    let writer_plan = read_plan(&writer, true)?;
    metadata.check(&writer_plan, header(&writer)?[12])?;
    drop(writer_plan);
    let writer_display = independent_display(
        ffmpeg,
        &writer,
        &temp.join("writer.rgba"),
        &metadata,
        control,
    )?;
    if writer_display != display {
        return Err(error("writer control decoder display differs"));
    }
    Ok(Frozen {
        metadata,
        full,
        display,
        source,
        writer_bytes: fs::metadata(&writer).map_err(error)?.len(),
    })
}

fn candidate(
    ffmpeg: &Path,
    frozen: &Frozen,
    output: &Path,
    target: Option<u64>,
    stage: &mut AdvancedCompressionStage,
    control: &mut SearchControl<'_>,
) -> Result<(), AppError> {
    let meta = &frozen.metadata;
    stage.writer_control_bytes = Some(frozen.writer_bytes);
    if stage.method == "temporal_stability" && frozen.source.is_none() {
        stage.reason = Some("没有严格对齐的不透明源画面，跳过跨帧稳定".into());
        return Ok(());
    }
    let external = meta.rgba_bytes();
    control.reserve_external(external).map_err(error)?;
    let (mut proposed, stats): (IndexedGifPlan, SearchStats) = control
        .with_stage_budget(
            380,
            Duration::from_secs(if stage.method == "temporal_stability" {
                15
            } else {
                20
            }),
            |control| {
                let (proposed, stats) = if stage.method == "temporal_stability" {
                    compression_search::temporal_controlled(
                        &frozen.full,
                        frozen.source.as_deref().expect("checked source"),
                        0,
                        2,
                        None,
                        control,
                    )?
                } else {
                    compression_search::lzw_controlled(
                        &frozen.full,
                        2,
                        frozen.source.as_deref(),
                        None,
                        control,
                    )?
                };
                if stats.changed_indices != 0 {
                    // Frozen source/full plan/display remain live outside structure.
                    control.reserve_external(
                        external
                            + frozen.source.as_ref().map_or(0, Vec::len)
                            + meta.pixels() * meta.frames(),
                    )?;
                    write_compact(&proposed, meta, output, control)?;
                }
                Ok((proposed, stats))
            },
        )
        .map_err(error)?;
    if stats.changed_indices == 0 {
        stage.status = "no_gain".into();
        stage.reason = Some("没有满足保护条件的索引变化".into());
        return Ok(());
    }
    // Free all candidate indices before allocating its independent RGBA.
    proposed.frames.clear();
    drop(proposed);
    let bytes = fs::metadata(output).map_err(error)?.len();
    stage.candidate_bytes = Some(bytes);
    stage.algorithm_saved_bytes = frozen.writer_bytes.saturating_sub(bytes);
    if bytes >= stage.before_bytes
        || bytes >= frozen.writer_bytes
        || target.is_some_and(|cap| bytes > cap)
    {
        stage.status = "no_gain".into();
        stage.reason = Some("候选未同时小于原文件和相同写入器对照，或未满足体积上限".into());
        return Ok(());
    }
    if bytes > MAX_FILE_BYTES {
        return Err(error("candidate byte budget exhausted"));
    }
    control
        .reserve_external(
            meta.rgba_bytes() * 2
                + frozen.source.as_ref().map_or(0, Vec::len)
                + meta.pixels() * meta.frames(),
        )
        .map_err(error)?;
    let decoded = read_plan(output, true)?;
    meta.check(&decoded, header(output)?[12])?;
    let normalized = structure_optimization::indexed(&decoded, header(output)?[11], control)?;
    drop(decoded);
    control
        .reserve_external(
            meta.rgba_bytes()
                + frozen.source.as_ref().map_or(0, Vec::len)
                + meta.pixels() * meta.frames(),
        )
        .map_err(error)?;
    let simulated = compression_search::display_controlled(&normalized, control).map_err(error)?;
    drop(normalized);
    let rgba = independent_display(
        ffmpeg,
        output,
        &output.with_extension("rgba"),
        meta,
        control,
    )?;
    if rgba != simulated {
        return Err(error("candidate simulator and decoder display differ"));
    }
    drop(simulated);
    stage.changed_pixels =
        visible_pixel_changes(&frozen.display, &rgba, usize::from(meta.width), control)?;
    if frozen.source.is_none() && rgba != frozen.display {
        return Err(error("GIF-only candidate changed display"));
    }
    let metrics = evaluate_quality_gate(
        QualityInput {
            width: usize::from(meta.width),
            height: usize::from(meta.height),
            baseline_rgba: &frozen.display,
            candidate_rgba: &rgba,
            source_rgb: frozen.source.as_deref(),
            delays_cs: &meta.delays,
            looping: meta.looping(),
        },
        &|| control.checkpoint(),
    )
    .map_err(error)?;
    let accepted = metrics.accepted;
    stage.metrics = Some(metrics);
    stage.verified = accepted;
    stage.status = if accepted { "not_selected" } else { "rejected" }.into();
    if !accepted {
        stage.reason = Some("画质、色带或跨帧稳定性保护未通过".into());
    }
    Ok(())
}

pub(super) fn optional(
    ffmpeg: &Path,
    input_gif: &Path,
    target: Option<u64>,
    temporal: bool,
    lzw: bool,
    reference: Option<ReferenceSpec<'_>>,
) -> Result<AdvancedCompressionReport, AppError> {
    optional_with_budget(
        ffmpeg,
        input_gif,
        target,
        temporal,
        lzw,
        reference,
        MAX_PROBES,
        MAX_TIME,
        MAX_MEMORY_BYTES,
    )
}

#[allow(clippy::too_many_arguments)]
fn optional_with_budget(
    ffmpeg: &Path,
    input: &Path,
    target: Option<u64>,
    temporal: bool,
    lzw: bool,
    reference: Option<ReferenceSpec<'_>>,
    probes: usize,
    time: Duration,
    memory: usize,
) -> Result<AdvancedCompressionReport, AppError> {
    let _phase = export_pipeline::stage(Phase::Validation);
    check_conversion_cancelled()?;
    let started = Instant::now();
    let before = fs::metadata(input).map_err(error)?.len();
    let mut report = AdvancedCompressionReport {
        algorithm_version: "source_guarded_temporal_lzw_v1",
        status: "retained".into(),
        before_bytes: before,
        after_bytes: before,
        adopted: false,
        verified: false,
        reference_kind: "gif_only",
        elapsed_ms: 0,
        estimated_peak_bytes: 0,
        reason: None,
        stages: Vec::new(),
    };
    for (enabled, method) in [(temporal, "temporal_stability"), (lzw, "lzw_cost_search")] {
        if enabled {
            report.stages.push(new_stage(method, before));
        }
    }
    let cancelled = || check_conversion_cancelled().map_err(|e| e.to_string());
    let mut control = SearchControl::new(probes, time, memory, &cancelled);
    let run = (|| -> Result<(), AppError> {
        if report.stages.is_empty() {
            return Ok(());
        }
        let temp = OwnedTempDir::create("gifp-advanced-compression")?;
        let frozen = prepare(
            ffmpeg,
            input,
            reference.as_ref(),
            temp.path(),
            &mut report,
            &mut control,
        )?;
        let mut selected: Option<(usize, PathBuf, u64)> = None;
        for (n, stage) in report.stages.iter_mut().enumerate() {
            let started = Instant::now();
            let probes = control.probes;
            let path = temp.path().join(format!("candidate-{n}.gif"));
            if let Err(reason) = candidate(ffmpeg, &frozen, &path, target, stage, &mut control) {
                check_conversion_cancelled()?;
                stage.status = if reason.to_string().contains("budget") {
                    "budget_exhausted"
                } else {
                    "rejected"
                }
                .into();
                stage.reason = Some(public_reason(&reason.to_string()));
            }
            stage.elapsed_ms = started.elapsed().as_millis() as u64;
            stage.compression_probes = control.probes - probes;
            if stage.verified
                && stage
                    .candidate_bytes
                    .is_some_and(|bytes| selected.as_ref().is_none_or(|(_, _, best)| bytes < *best))
            {
                selected = Some((n, path, stage.candidate_bytes.expect("checked bytes")));
            }
        }
        if let Some((n, path, bytes)) = selected {
            control.checkpoint().map_err(error)?;
            structure_optimization::publish_candidate(&path, input, &control)?;
            report.stages[n].status = "adopted".into();
            report.stages[n].adopted = true;
            report.status = "optimized".into();
            report.adopted = true;
            report.verified = true;
            report.after_bytes = bytes;
        }
        Ok(())
    })();
    if let Err(reason) = run {
        check_conversion_cancelled()?;
        let message = public_reason(&reason.to_string());
        for stage in &mut report.stages {
            if stage.reason.is_none() && !stage.verified {
                stage.status = if reason.to_string().contains("budget") {
                    "budget_exhausted"
                } else {
                    "skipped"
                }
                .into();
                stage.reason = Some(message.clone());
            }
        }
        report.reason = Some(message);
    }
    check_conversion_cancelled()?;
    if !report.adopted && report.reason.is_none() {
        report.reason = Some("没有同时通过实际字节、独立解码与画质保护的更小候选".into());
    }
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    report.estimated_peak_bytes = control.estimated_peak_bytes;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(alpha: bool) -> IndexedGifPlan {
        let palette = (0_u16..256).flat_map(|v| [v as u8; 3]).collect();
        IndexedGifPlan {
            width: 96,
            height: 64,
            global_palette_rgb: palette,
            repeat: IndexedGifRepeat::Infinite,
            frames: (0..4)
                .map(|n| {
                    let mut indices = vec![if alpha { 255 } else { 100 }; 96 * 64];
                    for y in 8..56 {
                        for x in 8..88 {
                            // Quantization noise around a precisely representable
                            // source color; no gradient or moving edge is removed.
                            indices[y * 96 + x] = if n == 0 {
                                100
                            } else if (x * 17 + y * 11 + n) % 7 < 3 {
                                99
                            } else {
                                101
                            };
                        }
                    }
                    IndexedGifFrame {
                        left: 0,
                        top: 0,
                        width: 96,
                        height: 64,
                        delay_cs: 5,
                        transparent_index: alpha.then_some(255),
                        disposal: if alpha {
                            IndexedGifDisposal::Background
                        } else {
                            IndexedGifDisposal::Keep
                        },
                        local_palette_rgb: None,
                        indices,
                    }
                })
                .collect(),
        }
    }

    fn save(plan: &IndexedGifPlan, path: &Path, repeat: gif::Repeat) {
        let mut control = SearchControl::new(MAX_PROBES, MAX_TIME, MAX_MEMORY_BYTES, &|| Ok(()));
        structure_optimization::write_candidate(plan, repeat, path, &mut control).unwrap();
        restore_aspect(path, 49).unwrap();
    }

    fn request(input: &Path, frames: usize) -> GifRequest {
        serde_json::from_value(serde_json::json!({
            "input_path":input.to_string_lossy(),"output_dir":"unused",
            "width":96,"fps":20,"colors":256,"dither":"none",
            "optimize_level":0,"lossy":0,"start_seconds":0,
            "end_seconds":frames as f64 / 20.0,"encoder":"ffmpeg",
            "filter_style":"original","loop_output":true,"crop_enabled":false,
            "crop_left":0,"crop_right":0,"crop_top":0,"crop_bottom":0,
            "deleted_frames":[],"tracked_effects":[]
        }))
        .unwrap()
    }

    fn make_source(ffmpeg: &Path, temp: &Path, rgb: &[u8], frames: usize) -> PathBuf {
        let raw = temp.join("reference.rgb");
        let source = temp.join("reference.mkv");
        fs::write(&raw, rgb).unwrap();
        let mut command = Command::new(ffmpeg);
        command
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "rawvideo",
                "-pixel_format",
                "rgb24",
                "-video_size",
                "96x64",
                "-framerate",
                "20",
                "-i",
            ])
            .arg(&raw)
            .args(["-frames:v"])
            .arg(frames.to_string())
            .args(["-c:v", "ffv1", "-pix_fmt", "bgr0", "-f", "matroska"])
            .arg(&source);
        let control = SearchControl::new(MAX_PROBES, MAX_TIME, MAX_MEMORY_BYTES, &|| Ok(()));
        run_bounded(command, &source, MAX_FILE_BYTES as usize, None, &control).unwrap();
        source
    }

    #[test]
    fn no_enabled_stage_does_not_open_decoder_or_rewrite_file() {
        let temp = OwnedTempDir::create("advanced-disabled").unwrap();
        let path = temp.path().join("input.gif");
        save(&fixture(false), &path, gif::Repeat::Finite(3));
        let before = fs::read(&path).unwrap();
        let report =
            optional(Path::new("missing-ffmpeg"), &path, None, false, false, None).unwrap();
        assert!(report.stages.is_empty());
        assert!(!report.adopted && !report.verified);
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn resource_and_decoder_failures_preserve_original_and_hide_paths() {
        let temp = OwnedTempDir::create("advanced-budget").unwrap();
        let path = temp.path().join("private-sensitive-source.gif");
        save(&fixture(false), &path, gif::Repeat::Finite(3));
        let before = fs::read(&path).unwrap();
        for (probes, time, memory) in [
            (0, Duration::ZERO, MAX_MEMORY_BYTES),
            (MAX_PROBES, MAX_TIME, 1),
            (MAX_PROBES, MAX_TIME, MAX_MEMORY_BYTES),
        ] {
            let report = optional_with_budget(
                Path::new("private-missing-ffmpeg"),
                &path,
                None,
                true,
                true,
                None,
                probes,
                time,
                memory,
            )
            .unwrap();
            assert!(!report.adopted && !report.verified, "{report:?}");
            assert_eq!(fs::read(&path).unwrap(), before);
            let json = serde_json::to_string(&report).unwrap();
            assert!(
                !json.contains("private-")
                    && !json.contains(&temp.path().to_string_lossy().to_string())
            );
        }
    }

    #[test]
    fn cancellation_never_changes_staged_bytes() {
        let temp = OwnedTempDir::create("advanced-cancel").unwrap();
        let path = temp.path().join("input.gif");
        save(&fixture(false), &path, gif::Repeat::Infinite);
        let before = fs::read(&path).unwrap();
        let id = format!("advanced-cancel-{}", std::process::id());
        let scope = ConversionTaskScope::register(Some(&id)).unwrap();
        scope.activate();
        cancel_conversion_task(id).unwrap();
        assert!(matches!(
            optional(Path::new("missing-ffmpeg"), &path, None, true, true, None),
            Err(AppError::Cancelled(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn source_dimensions_requires_every_sample_exactly_once() {
        let valid = "[Parsed_showinfo_3 @ a] n:   0 pts: 0 fmt:rgba s:96x64 i:P\n[Parsed_showinfo_3 @ a] n:   1 pts: 1 fmt:rgba s:96x64 i:P";
        assert!(source_dimensions(valid, 96, 64, 2));
        assert!(!source_dimensions(valid, 64, 96, 2));
        assert!(!source_dimensions(valid, 96, 64, 1));
        assert!(!source_dimensions(
            &valid.replace("s:96x64", "s:96x640"),
            96,
            64,
            2
        ));
    }

    #[test]
    fn bounded_writer_rejects_the_entire_overflowing_write() {
        let temp = OwnedTempDir::create("advanced-write-cap").unwrap();
        let path = temp.path().join("candidate.gif");
        let control = SearchControl::new(MAX_PROBES, MAX_TIME, MAX_MEMORY_BYTES, &|| Ok(()));
        let mut writer = CappedWriter {
            file: File::create(&path).unwrap(),
            written: MAX_FILE_BYTES - 1,
            control: &control,
        };
        assert!(writer
            .write_all(&[1, 2])
            .unwrap_err()
            .to_string()
            .contains("budget"));
        assert_eq!(writer.written, MAX_FILE_BYTES - 1);
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
    }

    #[test]
    fn changed_pixels_counts_visible_rgba_not_palette_aliases_or_hidden_rgb() {
        let control = SearchControl::new(MAX_PROBES, MAX_TIME, MAX_MEMORY_BYTES, &|| Ok(()));
        let baseline = vec![vec![100, 100, 100, 255, 25, 40, 90, 0]];
        // Different indices for equal palette colors decode identically. RGB
        // beneath two transparent pixels has no visible presentation value.
        let aliases = vec![vec![100, 100, 100, 255, 200, 210, 220, 0]];
        assert_eq!(
            visible_pixel_changes(&baseline, &aliases, 2, &control).unwrap(),
            0
        );
        let changed = vec![vec![101, 100, 100, 255, 25, 40, 90, 255]];
        assert_eq!(
            visible_pixel_changes(&baseline, &changed, 2, &control).unwrap(),
            2
        );
    }

    #[test]
    #[ignore = "requires FFmpeg; proves real source-backed gain for both independently gated routes"]
    fn native_both_algorithms_gain_over_same_writer_with_exact_metadata() {
        let ffmpeg = locate_ffmpeg().unwrap();
        let temp = OwnedTempDir::create("advanced-gain").unwrap();
        let source = make_source(&ffmpeg, temp.path(), &vec![100; 96 * 64 * 3 * 4], 4);
        let request = request(&source, 4);
        for (temporal, lzw) in [(true, false), (false, true), (true, true)] {
            for repeat in [
                gif::Repeat::Finite(0),
                gif::Repeat::Finite(1),
                gif::Repeat::Finite(3),
                gif::Repeat::Infinite,
            ] {
                let path = temp.path().join("input.gif");
                save(&fixture(false), &path, repeat);
                let before = fs::read(&path).unwrap();
                let report = optional(
                    &ffmpeg,
                    &path,
                    None,
                    temporal,
                    lzw,
                    Some(ReferenceSpec {
                        input: &source,
                        request: &request,
                        encoder: "ffmpeg",
                    }),
                )
                .unwrap();
                assert!(report.adopted && report.verified, "{report:?}");
                assert_eq!(report.reference_kind, "prequantized_source");
                let accepted = report.stages.iter().find(|s| s.adopted).unwrap();
                assert!(
                    accepted.algorithm_saved_bytes > 0 && accepted.changed_pixels > 0,
                    "{report:?}"
                );
                assert!(accepted.candidate_bytes.unwrap() < accepted.writer_control_bytes.unwrap());
                assert!(accepted.metrics.as_ref().unwrap().accepted);
                assert!(report.after_bytes < before.len() as u64);
                let actual = read_plan(&path, true).unwrap();
                assert_eq!(
                    (
                        actual.width,
                        actual.height,
                        actual.repeat,
                        actual.frames.len()
                    ),
                    (96, 64, repeat, 4)
                );
                assert!(actual.frames.iter().all(|f| f.delay == 5));
                assert_eq!(header(&path).unwrap()[12], 49);
                assert!(report.estimated_peak_bytes <= MAX_MEMORY_BYTES);
                eprintln!(
                    "advanced-native temporal={temporal} lzw={lzw} repeat={repeat:?}: {}",
                    serde_json::to_string(&report).unwrap()
                );
            }
        }
    }

    #[test]
    #[ignore = "requires FFmpeg; verifies caps, missing reference, alpha and sample mismatch stay atomic"]
    fn native_fallback_caps_alpha_and_source_alignment() {
        let ffmpeg = locate_ffmpeg().unwrap();
        let temp = OwnedTempDir::create("advanced-fallback").unwrap();
        let source = make_source(&ffmpeg, temp.path(), &vec![100; 96 * 64 * 3 * 4], 4);
        let request = request(&source, 4);
        let path = temp.path().join("input.gif");
        save(&fixture(false), &path, gif::Repeat::Finite(3));
        let before = fs::read(&path).unwrap();
        let capped = optional(
            &ffmpeg,
            &path,
            Some(1),
            true,
            true,
            Some(ReferenceSpec {
                input: &source,
                request: &request,
                encoder: "ffmpeg",
            }),
        )
        .unwrap();
        assert!(!capped.adopted && !capped.verified, "{capped:?}");
        assert_eq!(fs::read(&path).unwrap(), before);
        let no_reference = optional(&ffmpeg, &path, None, true, true, None).unwrap();
        assert!(!no_reference.adopted, "{no_reference:?}");
        assert_eq!(no_reference.reference_kind, "gif_only");
        assert_eq!(no_reference.stages[0].status, "skipped");
        assert_eq!(fs::read(&path).unwrap(), before);
        let mut mismatch = request.clone();
        mismatch.fps = 10;
        let mismatched = optional(
            &ffmpeg,
            &path,
            None,
            true,
            true,
            Some(ReferenceSpec {
                input: &source,
                request: &mismatch,
                encoder: "ffmpeg",
            }),
        )
        .unwrap();
        assert!(!mismatched.adopted, "{mismatched:?}");
        assert_eq!(mismatched.reference_kind, "unavailable");
        assert_eq!(fs::read(&path).unwrap(), before);
        save(&fixture(true), &path, gif::Repeat::Finite(3));
        let alpha_before = fs::read(&path).unwrap();
        let alpha = optional(&ffmpeg, &path, None, true, true, None).unwrap();
        assert!(!alpha.adopted, "{alpha:?}");
        assert_eq!(fs::read(&path).unwrap(), alpha_before);
    }

    #[test]
    fn harsh_gradient_candidate_is_rejected_by_frozen_source_gate() {
        // This is the final product gate, even if a future proposal expands
        // eligibility. It must never accept broad gradient flattening for size.
        let source: Vec<u8> = (0..64)
            .flat_map(|_| (0..96).flat_map(|x| [80 + x as u8; 3]))
            .collect();
        let before: Vec<u8> = source
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect();
        let bad: Vec<u8> = source
            .chunks_exact(3)
            .flat_map(|p| [p[0] / 8 * 8, p[1] / 8 * 8, p[2] / 8 * 8, 255])
            .collect();
        let gate = evaluate_quality_gate(
            QualityInput {
                width: 96,
                height: 64,
                baseline_rgba: &[before],
                candidate_rgba: &[bad],
                source_rgb: Some(&source),
                delays_cs: &[5],
                looping: false,
            },
            &|| Ok(()),
        )
        .unwrap();
        assert!(!gate.accepted, "{gate:?}");
        assert!(gate.envelope.max_channel_change > 2);
    }
}
