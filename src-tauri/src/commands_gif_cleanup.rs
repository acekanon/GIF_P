//! Optional lossless cleanup, with complete timed-presentation verification.
use super::index_compression::{raw_decode, read_plan, Plan};
use super::*;
use std::borrow::Cow;
use std::io::{BufReader, Read};

const MAX_RGBA_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct GifCleanupReport {
    pub status: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub verified: bool,
    pub merged_frames: usize,
    pub removed_palette_entries: u64,
    pub merge_requested: bool,
    pub palette_requested: bool,
    pub elapsed_ms: u64,
    pub reason: Option<String>,
}

fn error(value: impl ToString) -> AppError {
    AppError::EncodeFailed(value.to_string())
}

fn merge_repeats(plan: &mut Plan) -> usize {
    if plan.frames.iter().any(|frame| frame.delay < 2) {
        return 0;
    }
    let before = plan.frames.len();
    let mut frames: Vec<gif::Frame<'static>> = Vec::with_capacity(before);
    for frame in plan.frames.drain(..) {
        if let Some(previous) = frames.last_mut() {
            let same = !frame.needs_user_input
                && !previous.needs_user_input
                && frame.dispose == gif::DisposalMethod::Keep
                && previous.dispose == gif::DisposalMethod::Keep
                && (
                    previous.left,
                    previous.top,
                    previous.width,
                    previous.height,
                    previous.transparent,
                ) == (
                    frame.left,
                    frame.top,
                    frame.width,
                    frame.height,
                    frame.transparent,
                )
                && previous.palette == frame.palette
                && previous.buffer == frame.buffer;
            if same {
                if let Some(delay) = previous.delay.checked_add(frame.delay) {
                    previous.delay = delay;
                    continue;
                }
            }
        }
        frames.push(frame);
    }
    plan.frames = frames;
    before - plan.frames.len()
}

fn compact_tables(plan: &mut Plan) -> Result<(u64, bool), AppError> {
    // The existing compactor preserves background entry zero. Files with only
    // local tables can still benefit from duplicate-frame merging.
    if plan.palette.len() < 6 {
        return Ok((0, false));
    }
    let indexed = IndexedGifPlan {
        width: plan.width,
        height: plan.height,
        global_palette_rgb: plan.palette.clone(),
        // Compaction simulates one displayed cycle. The serializer below keeps
        // the original finite/infinite repetition value without converting it.
        repeat: IndexedGifRepeat::None,
        frames: plan
            .frames
            .iter()
            .map(|frame| IndexedGifFrame {
                left: frame.left,
                top: frame.top,
                width: frame.width,
                height: frame.height,
                delay_cs: frame.delay,
                disposal: match frame.dispose {
                    gif::DisposalMethod::Any => IndexedGifDisposal::Unspecified,
                    gif::DisposalMethod::Keep => IndexedGifDisposal::Keep,
                    gif::DisposalMethod::Background => IndexedGifDisposal::Background,
                    gif::DisposalMethod::Previous => IndexedGifDisposal::Previous,
                },
                transparent_index: frame.transparent,
                local_palette_rgb: frame.palette.clone(),
                indices: frame.buffer.to_vec(),
            })
            .collect(),
    };
    let (compacted, report) =
        crate::core::compact_indexed_palette_tables(&indexed).map_err(error)?;
    plan.palette = compacted.global_palette_rgb;
    for (frame, compacted) in plan.frames.iter_mut().zip(compacted.frames) {
        frame.palette = compacted.local_palette_rgb;
        frame.transparent = compacted.transparent_index;
        frame.buffer = Cow::Owned(compacted.indices);
    }
    let removed =
        u64::from(report.original_global_palette_entries - report.compacted_global_palette_entries)
            + report.original_local_palette_entries
            - report.compacted_local_palette_entries;
    Ok((removed, removed > 0 || report.remapped_frame_count > 0))
}

fn budget(plan: &Plan) -> Result<(usize, usize, usize), AppError> {
    let cycles = if matches!(plan.repeat, gif::Repeat::Finite(0 | 1)) {
        1
    } else {
        2
    };
    let count = plan.frames.len() * cycles;
    let frame_bytes = usize::from(plan.width) * usize::from(plan.height) * 4;
    let bytes = count
        .checked_mul(frame_bytes)
        .ok_or_else(|| error("GIF cleanup size overflow"))?;
    if bytes > MAX_RGBA_BYTES {
        return Err(error("无损整理展示验证超过 256 MiB 单路预算，保留原结果"));
    }
    Ok((count, frame_bytes, bytes))
}

fn timeline(
    ffmpeg: &Path,
    input: &Path,
    plan: &Plan,
    raw: &Path,
    strict: bool,
) -> Result<Vec<([u8; 32], u64)>, AppError> {
    let (count, frame_bytes, bytes) = budget(plan)?;
    raw_decode(ffmpeg, input, raw, count, bytes)?;
    let mut input = BufReader::new(File::open(raw).map_err(error)?);
    let mut buffer = vec![0; frame_bytes];
    let mut frames: Vec<([u8; 32], u64)> = Vec::new();
    for index in 0..count {
        check_conversion_cancelled()?;
        input.read_exact(&mut buffer).map_err(error)?;
        for pixel in buffer.chunks_exact_mut(4) {
            if pixel[3] == 0 {
                pixel[..3].fill(0);
            }
        }
        let hash: [u8; 32] = Sha256::digest(&buffer).into();
        let delay = u64::from(plan.frames[index % plan.frames.len()].delay);
        if !strict && frames.last().is_some_and(|last| last.0 == hash) {
            frames.last_mut().expect("existing frame").1 += delay;
        } else {
            frames.push((hash, delay));
        }
    }
    Ok(frames)
}

fn write_plan(plan: &Plan, path: &Path) -> Result<(), AppError> {
    let mut encoder = gif::Encoder::new(
        File::create(path).map_err(error)?,
        plan.width,
        plan.height,
        &plan.palette,
    )
    .map_err(error)?;
    if plan.repeat != gif::Repeat::Finite(0) {
        encoder.set_repeat(plan.repeat).map_err(error)?;
    }
    for frame in &plan.frames {
        check_conversion_cancelled()?;
        encoder.write_frame(frame).map_err(error)?;
    }
    encoder.into_inner().map_err(error)?;
    Ok(())
}

fn optimize(
    ffmpeg: &Path,
    source: &Path,
    target: Option<u64>,
    report: &mut GifCleanupReport,
) -> Result<(), AppError> {
    if report.before_bytes > 32 * 1024 * 1024 {
        return Err(error("无损整理暂不处理超过 32 MiB 的 GIF"));
    }
    let original = read_plan(source, false)?;
    budget(&original)?;
    let mut candidate = original.clone();
    if report.merge_requested {
        report.merged_frames = merge_repeats(&mut candidate);
    }
    let mut palette_changed = false;
    if report.palette_requested {
        (report.removed_palette_entries, palette_changed) = compact_tables(&mut candidate)?;
    }
    if report.merged_frames == 0 && !palette_changed {
        return Ok(());
    }
    let temp = OwnedTempDir::create("gifp-cleanup")?;
    let path = temp.path().join("candidate.gif");
    write_plan(&candidate, &path)?;
    let after = fs::metadata(&path).map_err(error)?.len();
    if after >= report.before_bytes || target.is_some_and(|limit| after > limit) {
        return Ok(());
    }
    let decoded = read_plan(&path, true)?;
    if (decoded.width, decoded.height, decoded.repeat)
        != (original.width, original.height, original.repeat)
    {
        return Err(error("无损整理改变画布或循环"));
    }
    let strict = original.frames.iter().any(|frame| frame.delay < 2)
        || decoded.frames.iter().any(|frame| frame.delay < 2);
    if timeline(
        ffmpeg,
        source,
        &original,
        &temp.path().join("before.rgba"),
        strict,
    )? != timeline(
        ffmpeg,
        &path,
        &decoded,
        &temp.path().join("after.rgba"),
        strict,
    )? {
        return Err(error("无损整理改变可见像素或播放时序"));
    }
    verify_delivery_output(&path, AnimationFormat::Gif)?;
    check_conversion_cancelled()?;
    publish_file_atomically(&path, source, true)?;
    report.after_bytes = after;
    report.status = "optimized".into();
    report.verified = true;
    Ok(())
}

pub(super) fn optional(
    ffmpeg: &Path,
    source: &Path,
    target: Option<u64>,
    merge: bool,
    palette: bool,
) -> Result<GifCleanupReport, AppError> {
    let _phase = export_pipeline::stage(Phase::Validation);
    let started = Instant::now();
    let bytes = fs::metadata(source).map_err(error)?.len();
    let mut report = GifCleanupReport {
        status: "retained".into(),
        before_bytes: bytes,
        after_bytes: bytes,
        verified: false,
        merged_frames: 0,
        removed_palette_entries: 0,
        merge_requested: merge,
        palette_requested: palette,
        elapsed_ms: 0,
        reason: None,
    };
    if let Err(reason) = optimize(ffmpeg, source, target, &mut report) {
        check_conversion_cancelled()?;
        report.reason = Some(reason.to_string());
    }
    if !report.verified {
        report.after_bytes = bytes;
        report.merged_frames = 0;
        report.removed_palette_entries = 0;
        if report.reason.is_none() {
            report.reason = Some("没有更小且完全保持画面的候选".into());
        }
    }
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> Plan {
        let frame = gif::Frame {
            width: 8,
            height: 8,
            delay: 8,
            dispose: gif::DisposalMethod::Keep,
            buffer: Cow::Owned(vec![200; 64]),
            ..Default::default()
        };
        Plan {
            width: 8,
            height: 8,
            palette: (0..256).flat_map(|i| [i as u8, i as u8, i as u8]).collect(),
            repeat: gif::Repeat::Infinite,
            frames: vec![frame.clone(), frame.clone(), frame],
        }
    }
    #[test]
    fn merge_only_idempotent_frames_and_keep_short_delays_and_overflow() {
        let mut p = plan();
        assert_eq!(merge_repeats(&mut p), 2);
        assert_eq!(p.frames[0].delay, 24);
        let mut p = plan();
        p.frames[1].dispose = gif::DisposalMethod::Background;
        assert_eq!(merge_repeats(&mut p), 0);
        let mut p = plan();
        p.frames[0].delay = 1;
        assert_eq!(merge_repeats(&mut p), 0);
        let mut p = plan();
        p.frames[0].delay = u16::MAX;
        assert_eq!(merge_repeats(&mut p), 1);
        assert_eq!(p.frames.len(), 2);
        let mut p = plan();
        p.frames[1].needs_user_input = true;
        assert_eq!(merge_repeats(&mut p), 0);
    }
    #[test]
    fn compact_keeps_visible_color_and_repetition() {
        let mut p = plan();
        assert!(compact_tables(&mut p).unwrap().0 > 0);
        assert_eq!(p.repeat, gif::Repeat::Infinite);
        assert_eq!(p.frames.len(), 3);
        let index = usize::from(p.frames[0].buffer[0]) * 3;
        assert_eq!(&p.palette[index..index + 3], &[200, 200, 200]);
        assert!(p.palette.len() < 768);
    }
    #[test]
    #[ignore = "requires FFmpeg; lossless cleanup, alpha, repeat, caps, cancellation"]
    fn cleanup_native_smoke() {
        let ffmpeg = locate_ffmpeg().unwrap();
        let temp = OwnedTempDir::create("cleanup-smoke").unwrap();
        for (i, repeat) in [
            gif::Repeat::Finite(0),
            gif::Repeat::Finite(1),
            gif::Repeat::Infinite,
        ]
        .into_iter()
        .enumerate()
        {
            let mut p = plan();
            p.repeat = repeat;
            if i == 2 {
                for frame in &mut p.frames {
                    frame.transparent = Some(255);
                    frame.buffer.to_mut()[0] = 255;
                }
            }
            for (merge, palette) in [(true, false), (false, true), (true, true)] {
                let path = temp.path().join(format!("{i}-{merge}-{palette}.gif"));
                write_plan(&p, &path).unwrap();
                let before = fs::read(&path).unwrap();
                let cap = optional(&ffmpeg, &path, Some(1), merge, palette).unwrap();
                assert!(!cap.verified);
                assert_eq!(fs::read(&path).unwrap(), before);
                let r = optional(&ffmpeg, &path, None, merge, palette).unwrap();
                assert!(r.verified, "{r:?}");
                assert!(r.after_bytes < r.before_bytes);
                assert_eq!(read_plan(&path, true).unwrap().repeat, repeat);
                if merge {
                    assert_eq!(r.merged_frames, 2);
                }
                if palette {
                    assert!(r.removed_palette_entries > 0);
                }
            }
        }
        let path = temp.path().join("cancel.gif");
        write_plan(&plan(), &path).unwrap();
        let before = fs::read(&path).unwrap();
        let id = format!("cleanup-cancel-{}", std::process::id());
        let scope = ConversionTaskScope::register(Some(&id)).unwrap();
        scope.activate();
        cancel_conversion_task(id).unwrap();
        assert!(matches!(
            optional(&ffmpeg, &path, None, true, true),
            Err(AppError::Cancelled(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
        drop(scope);
        let request:GifRequest=serde_json::from_value(serde_json::json!({
            "schema_version":1,"input_path":path,"output_dir":temp.path(),"width":128,"fps":12,"colors":128,
            "dither":"bayer","optimize_level":3,"lossy":20,"start_seconds":0.0,"end_seconds":0.24,
            "encoder":"ffmpeg_fast","filter_style":"original","loop_output":true,"crop_enabled":false,
            "crop_left":0.0,"crop_top":0.0,"crop_right":0.0,"crop_bottom":0.0,"deleted_frames":[],
            "generation_mode":"fast_gif","gif_merge_frames":true,"gif_compact_palette":true,
            "index_compression":true,"index_compression_gentle":true
        })).unwrap();
        let result = convert_animation_inner(request).unwrap();
        assert!(result.gif_cleanup_report.as_ref().unwrap().verified);
        assert!(result.index_compression_report.as_ref().unwrap().gentle);
        assert_eq!(
            result.size_bytes,
            fs::metadata(&result.output_path).unwrap().len()
        );
        assert!(result.encoder_used.contains("+native_gif_cleanup"));
        assert!(result.palette_report.is_none());
    }
}
