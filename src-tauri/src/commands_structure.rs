//! Opt-in lossless rectangle/transparency/disposal search. Every accepted file
//! passes an independent decoder, including alpha, delays and loop boundaries.
use super::index_compression::{read_plan, Plan};
use super::*;
use crate::core::compression_search::{self, SearchControl};
use std::borrow::Cow;
use std::io::BufReader;

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RGBA_BYTES: usize = 256 * 1024 * 1024;
const MAX_MEMORY_BYTES: usize = 384 * 1024 * 1024;
const MAX_PROBES: usize = 1024;
const MAX_TIME: Duration = Duration::from_secs(30);
const BEAM_WIDTH: usize = 3;

#[derive(Clone, Debug, Serialize)]
pub struct GifStructureReport {
    pub status: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub adopted: bool,
    pub verified: bool,
    pub method: &'static str,
    pub compression_probes: usize,
    pub palette_boundary_rectangles: usize,
    pub frame_count: usize,
    pub estimated_peak_bytes: usize,
    pub elapsed_ms: u64,
    pub reason: Option<String>,
}

fn error(value: impl ToString) -> AppError {
    AppError::EncodeFailed(value.to_string())
}

pub(super) fn indexed(
    source: &Plan,
    background: u8,
    control: &SearchControl<'_>,
) -> Result<IndexedGifPlan, AppError> {
    if usize::from(background) * 3 + 2 >= source.palette.len() {
        return Err(error("GIF background index exceeds its global palette"));
    }
    let mut result = IndexedGifPlan {
        width: source.width,
        height: source.height,
        global_palette_rgb: source.palette.clone(),
        // The core supports one/no limit or infinite loops. Search conservatively
        // checks two loops for every repeating source; the writer restores the
        // exact NETSCAPE finite value, never converting it to infinite.
        repeat: if source.repeat == gif::Repeat::Finite(0) {
            IndexedGifRepeat::None
        } else {
            IndexedGifRepeat::Infinite
        },
        frames: source
            .frames
            .iter()
            .map(|f| IndexedGifFrame {
                left: f.left,
                top: f.top,
                width: f.width,
                height: f.height,
                delay_cs: f.delay,
                transparent_index: f.transparent,
                disposal: match f.dispose {
                    gif::DisposalMethod::Any => IndexedGifDisposal::Unspecified,
                    gif::DisposalMethod::Keep => IndexedGifDisposal::Keep,
                    gif::DisposalMethod::Previous => IndexedGifDisposal::Previous,
                    gif::DisposalMethod::Background => IndexedGifDisposal::Background,
                },
                local_palette_rgb: f.palette.clone(),
                indices: f.buffer.to_vec(),
            })
            .collect(),
    };
    // The core/writer fixes logical background to zero. Relocate that color
    // and remap global-table references; local palettes retain their own index
    // meaning. This handles FFmpeg's common background=31/255 without guessing.
    if background != 0 {
        for c in 0..3 {
            result
                .global_palette_rgb
                .swap(c, usize::from(background) * 3 + c);
        }
        let remap = |index| {
            if index == 0 {
                background
            } else if index == background {
                0
            } else {
                index
            }
        };
        for frame in &mut result.frames {
            if frame.local_palette_rgb.is_some() {
                continue;
            }
            for chunk in frame.indices.chunks_mut(4096) {
                control.checkpoint().map_err(error)?;
                for index in chunk {
                    *index = remap(*index);
                }
            }
            frame.transparent_index = frame.transparent_index.map(remap);
        }
    }
    Ok(result)
}

pub(super) fn write_candidate(
    plan: &IndexedGifPlan,
    repeat: gif::Repeat,
    path: &Path,
    control: &mut SearchControl<'_>,
) -> Result<(), AppError> {
    control.probe().map_err(error)?;
    let mut encoder = gif::Encoder::new(
        File::create(path).map_err(error)?,
        plan.width,
        plan.height,
        &plan.global_palette_rgb,
    )
    .map_err(error)?;
    if repeat != gif::Repeat::Finite(0) {
        encoder.set_repeat(repeat).map_err(error)?;
    }
    for frame in &plan.frames {
        control.checkpoint().map_err(error)?;
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
            .map_err(error)?;
    }
    encoder.into_inner().map_err(error)?;
    control.checkpoint().map_err(error)
}

fn verification_size(plan: &Plan) -> Result<(usize, usize, usize), AppError> {
    let cycles = if matches!(plan.repeat, gif::Repeat::Finite(0 | 1)) {
        1
    } else {
        2
    };
    let count = plan
        .frames
        .len()
        .checked_mul(cycles)
        .ok_or_else(|| error("frame count overflow"))?;
    let frame_bytes = usize::from(plan.width) * usize::from(plan.height) * 4;
    let bytes = count
        .checked_mul(frame_bytes)
        .ok_or_else(|| error("RGBA budget overflow"))?;
    if bytes > MAX_RGBA_BYTES {
        return Err(error("智能无损验证超过 256 MiB 单路预算，保留原结果"));
    }
    Ok((count, frame_bytes, bytes))
}

/// A bounded subprocess, with no in-memory RGBA accumulation or pipe deadlock.
pub(super) fn decode(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    frames: usize,
    bytes: usize,
    control: &SearchControl<'_>,
) -> Result<(), AppError> {
    control.checkpoint().map_err(error)?;
    let mut command = Command::new(ffmpeg);
    command
        .args(["-y", "-v", "error", "-ignore_loop", "0", "-i"])
        .arg(input)
        .args(["-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v"])
        .arg(frames.to_string())
        .args(["-pix_fmt", "rgba", "-f", "rawvideo"])
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
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
        if fs::metadata(output).is_ok_and(|m| m.len() > bytes as u64) {
            break Err(error("智能无损验证解码超过数据预算"));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(error("智能无损验证解码失败"))
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
    if fs::metadata(output).map_err(error)?.len() != bytes as u64 {
        return Err(error("智能无损验证帧数或画布变化"));
    }
    control.checkpoint().map_err(error)
}

fn timeline(
    ffmpeg: &Path,
    path: &Path,
    plan: &Plan,
    raw: &Path,
    control: &SearchControl<'_>,
) -> Result<Vec<([u8; 32], u16)>, AppError> {
    let (count, frame_bytes, bytes) = verification_size(plan)?;
    decode(ffmpeg, path, raw, count, bytes, control)?;
    let mut reader = BufReader::new(File::open(raw).map_err(error)?);
    let mut buffer = vec![0_u8; frame_bytes];
    let mut timeline = Vec::with_capacity(count);
    for n in 0..count {
        control.checkpoint().map_err(error)?;
        reader.read_exact(&mut buffer).map_err(error)?;
        for chunk in buffer.chunks_mut(16 * 1024) {
            control.checkpoint().map_err(error)?;
            for pixel in chunk.chunks_exact_mut(4) {
                // RGB under fully transparent pixels has no presentation value.
                if pixel[3] == 0 {
                    pixel[..3].fill(0);
                }
            }
        }
        timeline.push((
            Sha256::digest(&buffer).into(),
            plan.frames[n % plan.frames.len()].delay,
        ));
    }
    Ok(timeline)
}

pub(super) fn publish_candidate(
    candidate: &Path,
    source: &Path,
    control: &SearchControl<'_>,
) -> Result<(), AppError> {
    let staged = stage_publish_file(candidate, source)?;
    let result = (|| {
        control.checkpoint().map_err(error)?;
        if let Some(task) = current_conversion_task() {
            let phase = task
                .phase
                .lock()
                .map_err(|_| error("Conversion phase lock poisoned"))?;
            if *phase == ConversionTaskPhase::Cancelled || task.cancelled.load(Ordering::Acquire) {
                return Err(AppError::Cancelled(task.id.clone()));
            }
            // This replaces an internal staged export. The outer conversion
            // owns the final publication and its Finished transition.
            finish_staged_publish(&staged, source, true)
        } else {
            finish_staged_publish(&staged, source, true)
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

fn optimize(
    ffmpeg: &Path,
    source: &Path,
    target: Option<u64>,
    report: &mut GifStructureReport,
    control: &mut SearchControl<'_>,
) -> Result<(), AppError> {
    control.checkpoint().map_err(error)?;
    if report.before_bytes > MAX_FILE_BYTES {
        return Err(error("智能无损暂不处理超过 32 MiB 的 GIF"));
    }
    let mut header = [0_u8; 13];
    File::open(source)
        .map_err(error)?
        .read_exact(&mut header)
        .map_err(error)?;
    if !matches!(&header[..6], b"GIF87a" | b"GIF89a") || header[10] & 0x80 == 0 {
        return Err(error("智能无损暂不处理无全局调色表的 GIF"));
    }
    let original = read_plan(source, false)?;
    control.checkpoint().map_err(error)?;
    report.frame_count = original.frames.len();
    verification_size(&original)?;
    if original.frames.iter().any(|f| f.needs_user_input) {
        return Err(error("智能无损保留需要用户输入的 GIF"));
    }
    let normalized = indexed(&original, header[11], control)?;
    let full = compression_search::flatten_controlled(&normalized, control).map_err(error)?;
    drop(normalized);
    let (candidate, stats) =
        compression_search::structure_controlled(&full, BEAM_WIDTH, control).map_err(error)?;
    drop(full);
    let temp = OwnedTempDir::create("gifp-structure")?;
    let path = temp.path().join("candidate.gif");
    write_candidate(&candidate, original.repeat, &path, control)?;
    drop(candidate);
    // The gif writer emits unspecified pixel aspect. Preserve the source's
    // exact aspect byte (FFmpeg commonly uses 49 for square pixels).
    if header[12] != 0 {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(error)?;
        file.seek(io::SeekFrom::Start(12)).map_err(error)?;
        file.write_all(&header[12..13]).map_err(error)?;
    }
    let after = fs::metadata(&path).map_err(error)?.len();
    if after >= report.before_bytes || target.is_some_and(|cap| after > cap) {
        return Ok(());
    }
    let decoded = read_plan(&path, true)?;
    control.checkpoint().map_err(error)?;
    if (
        original.width,
        original.height,
        original.repeat,
        original.frames.len(),
    ) != (
        decoded.width,
        decoded.height,
        decoded.repeat,
        decoded.frames.len(),
    ) {
        return Err(error("智能无损改变画布、帧数或循环"));
    }
    let before_timeline = timeline(
        ffmpeg,
        source,
        &original,
        &temp.path().join("before.rgba"),
        control,
    )?;
    let after_timeline = timeline(
        ffmpeg,
        &path,
        &decoded,
        &temp.path().join("after.rgba"),
        control,
    )?;
    if before_timeline != after_timeline {
        return Err(error("智能无损改变显示像素、透明度或播放时序"));
    }
    report.verified = true;
    publish_candidate(&path, source, control)?;
    report.status = "optimized".into();
    report.adopted = true;
    report.after_bytes = after;
    report.palette_boundary_rectangles = stats.palette_boundary_rectangles;
    Ok(())
}

pub(super) fn optional(
    ffmpeg: &Path,
    source: &Path,
    target: Option<u64>,
) -> Result<GifStructureReport, AppError> {
    optional_with_budget(
        ffmpeg,
        source,
        target,
        MAX_PROBES,
        MAX_TIME,
        MAX_MEMORY_BYTES,
    )
}

fn optional_with_budget(
    ffmpeg: &Path,
    source: &Path,
    target: Option<u64>,
    probes: usize,
    time: Duration,
    memory: usize,
) -> Result<GifStructureReport, AppError> {
    let _phase = export_pipeline::stage(Phase::Validation);
    check_conversion_cancelled()?;
    let started = Instant::now();
    let bytes = fs::metadata(source).map_err(error)?.len();
    let mut report = GifStructureReport {
        status: "retained".into(),
        before_bytes: bytes,
        after_bytes: bytes,
        adopted: false,
        verified: false,
        method: "rgba_rectangle_transparency_disposal_v1",
        compression_probes: 0,
        palette_boundary_rectangles: 0,
        frame_count: 0,
        estimated_peak_bytes: 0,
        elapsed_ms: 0,
        reason: None,
    };
    let cancelled = || check_conversion_cancelled().map_err(|e| e.to_string());
    let mut control = SearchControl::new(probes, time, memory, &cancelled);
    if let Err(reason) = optimize(ffmpeg, source, target, &mut report, &mut control) {
        check_conversion_cancelled()?;
        report.reason = Some(reason.to_string());
    }
    check_conversion_cancelled()?;
    if !report.adopted && report.reason.is_none() {
        report.reason = Some("没有更小且满足体积限制、完全保持画面的候选".into());
    }
    report.compression_probes = control.probes;
    report.estimated_peak_bytes = control.estimated_peak_bytes;
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(alpha: bool) -> IndexedGifPlan {
        let table: Vec<u8> = (0_u16..256).flat_map(|v| [v as u8; 3]).collect();
        IndexedGifPlan {
            width: 96,
            height: 64,
            global_palette_rgb: table.clone(),
            repeat: IndexedGifRepeat::Infinite,
            frames: (0..6)
                .map(|n| {
                    let mut indices = vec![if alpha { 255 } else { 100 }; 96 * 64];
                    for y in 12..24 {
                        for x in 8 + n * 10..16 + n * 10 {
                            indices[y * 96 + x] = 120;
                        }
                    }
                    let mut local = table.clone();
                    if n % 2 == 1 {
                        for c in 0..3 {
                            local.swap(300 + c, 303 + c);
                        }
                        for index in &mut indices {
                            if *index == 100 {
                                *index = 101;
                            }
                        }
                    }
                    IndexedGifFrame {
                        left: 0,
                        top: 0,
                        width: 96,
                        height: 64,
                        delay_cs: 3 + n as u16,
                        disposal: if alpha {
                            IndexedGifDisposal::Background
                        } else {
                            IndexedGifDisposal::Keep
                        },
                        transparent_index: alpha.then_some(255),
                        local_palette_rgb: Some(local),
                        indices,
                    }
                })
                .collect(),
        }
    }

    fn save(plan: &IndexedGifPlan, repeat: gif::Repeat, path: &Path) {
        let mut control = SearchControl::new(10, MAX_TIME, MAX_MEMORY_BYTES, &|| Ok(()));
        write_candidate(plan, repeat, path, &mut control).unwrap();
    }

    #[test]
    fn resource_budgets_preserve_staged_bytes_without_ffmpeg() {
        let temp = OwnedTempDir::create("structure-budgets").unwrap();
        let path = temp.path().join("input.gif");
        save(&fixture(false), gif::Repeat::Finite(3), &path);
        let original = fs::read(&path).unwrap();
        for (probes, time, memory) in [
            (0, MAX_TIME, MAX_MEMORY_BYTES),
            (MAX_PROBES, Duration::ZERO, MAX_MEMORY_BYTES),
            (MAX_PROBES, MAX_TIME, 1),
        ] {
            let report = optional_with_budget(
                Path::new("missing-ffmpeg"),
                &path,
                None,
                probes,
                time,
                memory,
            )
            .unwrap();
            assert!(!report.adopted, "{report:?}");
            assert!(report.reason.unwrap().contains("budget"));
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }

    #[test]
    fn cancellation_never_replaces_staged_export() {
        let temp = OwnedTempDir::create("structure-cancel").unwrap();
        let path = temp.path().join("input.gif");
        save(&fixture(false), gif::Repeat::Infinite, &path);
        let original = fs::read(&path).unwrap();
        let id = format!("structure-cancel-{}", std::process::id());
        let scope = ConversionTaskScope::register(Some(&id)).unwrap();
        scope.activate();
        cancel_conversion_task(id).unwrap();
        assert!(matches!(
            optional(Path::new("missing-ffmpeg"), &path, None),
            Err(AppError::Cancelled(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn cancellation_at_publication_checkpoint_keeps_original_bytes() {
        let temp = OwnedTempDir::create("structure-publish-cancel").unwrap();
        let source = temp.path().join("input.gif");
        let candidate = temp.path().join("candidate.gif");
        save(&fixture(false), gif::Repeat::Infinite, &source);
        save(&fixture(true), gif::Repeat::Infinite, &candidate);
        let original = fs::read(&source).unwrap();
        let id = format!("structure-publish-cancel-{}", std::process::id());
        let scope = ConversionTaskScope::register(Some(&id)).unwrap();
        scope.activate();
        let cancelled = || {
            cancel_conversion_task(id.clone()).unwrap();
            check_conversion_cancelled().map_err(|e| e.to_string())
        };
        let control = SearchControl::new(MAX_PROBES, MAX_TIME, MAX_MEMORY_BYTES, &cancelled);
        assert!(publish_candidate(&candidate, &source, &control).is_err());
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    #[test]
    fn normalization_remaps_global_indices_and_leaves_local_palettes_unchanged() {
        let temp = OwnedTempDir::create("structure-background").unwrap();
        let path = temp.path().join("input.gif");
        let mut plan = fixture(false);
        plan.frames[0].local_palette_rgb = None;
        save(&plan, gif::Repeat::Finite(3), &path);
        let source = read_plan(&path, false).unwrap();
        let control = SearchControl::new(100, MAX_TIME, MAX_MEMORY_BYTES, &|| Ok(()));
        let normalized = indexed(&source, 100, &control).unwrap();
        assert_eq!(&normalized.global_palette_rgb[..3], &[100; 3]);
        assert_eq!(normalized.frames[0].indices[0], 0);
        assert_eq!(
            normalized.frames[1].indices.as_slice(),
            source.frames[1].buffer.as_ref()
        );
        assert_eq!(
            normalized.frames[1].local_palette_rgb,
            source.frames[1].palette
        );
    }

    #[test]
    fn no_global_palette_is_retained_without_guessing_background() {
        let temp = OwnedTempDir::create("structure-no-global").unwrap();
        let path = temp.path().join("input.gif");
        save(&fixture(false), gif::Repeat::Finite(3), &path);
        let mut bytes = fs::read(&path).unwrap();
        bytes[10] &= 0x7f;
        bytes.drain(13..13 + 768);
        fs::write(&path, &bytes).unwrap();
        let report = optional(Path::new("missing-ffmpeg"), &path, None).unwrap();
        assert!(!report.adopted);
        assert!(report.reason.unwrap().contains("全局调色表"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    #[ignore = "requires FFmpeg; verifies byte gains, full RGBA, timing, finite repeat, alpha and hard caps"]
    fn structure_native_equivalence_smoke() {
        let ffmpeg = locate_ffmpeg().unwrap();
        let temp = OwnedTempDir::create("structure-smoke").unwrap();
        for (i, repeat) in [
            gif::Repeat::Finite(0),
            gif::Repeat::Finite(1),
            gif::Repeat::Finite(3),
            gif::Repeat::Infinite,
        ]
        .into_iter()
        .enumerate()
        {
            for alpha in [false, true] {
                let path = temp.path().join(format!("{i}-{alpha}.gif"));
                let mut plan = fixture(alpha);
                plan.frames[0].local_palette_rgb = None;
                save(&plan, repeat, &path);
                let mut bytes = fs::read(&path).unwrap();
                bytes[11] = if alpha { 255 } else { 100 };
                bytes[12] = 49;
                fs::write(&path, bytes).unwrap();
                let original = fs::read(&path).unwrap();
                let cap = optional(&ffmpeg, &path, Some(1)).unwrap();
                assert!(!cap.adopted, "{cap:?}");
                assert_eq!(fs::read(&path).unwrap(), original);
                let report = optional(&ffmpeg, &path, None).unwrap();
                assert!(report.adopted && report.verified, "{report:?}");
                assert!(report.after_bytes < report.before_bytes, "{report:?}");
                assert_eq!(read_plan(&path, true).unwrap().repeat, repeat);
                assert_eq!(fs::read(&path).unwrap()[12], 49);
                assert!(report.compression_probes <= MAX_PROBES);
            }
        }
    }

    #[test]
    #[ignore = "requires saved run-002 480p audit fixtures and FFmpeg"]
    fn structure_saved_480p_audit_budget_smoke() {
        let ffmpeg = locate_ffmpeg().unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../audits/2026-09-09-compression-research/run-002/manifest.json");
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(manifest).unwrap()).unwrap();
        let temp = OwnedTempDir::create("structure-480p").unwrap();
        for id in ["local-ui", "noisy-motion"] {
            let source = fixtures.iter().find(|f| f["id"] == id).unwrap()["input"]
                .as_str()
                .unwrap();
            let path = temp.path().join(format!("{id}.gif"));
            fs::copy(source, &path).unwrap();
            let report = optional(&ffmpeg, &path, None).unwrap();
            eprintln!("{id}: {}", serde_json::to_string(&report).unwrap());
            assert!(report.adopted && report.verified, "{report:?}");
            assert!(report.after_bytes < report.before_bytes);
            assert!(report.compression_probes <= MAX_PROBES);
            assert!(report.estimated_peak_bytes <= MAX_MEMORY_BYTES);
        }
    }
}
