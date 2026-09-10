//! Bounded spatial index reuse: standard GIF, unchanged palette and timing.
//! Candidates are scored against the unmodified staged export, never one another.
use super::*;
use std::borrow::Cow;
use std::io::{BufReader, Read};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
const MAX_RGBA_BYTES: usize = 256 * 1024 * 1024;
const EDGE_DELTA: u8 = 24;

#[derive(Clone, Debug, Serialize)]
pub struct IndexCompressionReport {
    pub gentle: bool,
    pub algorithm: &'static str,
    pub status: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub verified: bool,
    pub threshold: u8,
    pub max_channel_error: u8,
    pub worst_frame_rmse: f64,
    pub candidates_tested: u8,
    pub elapsed_ms: u64,
    pub reason: Option<String>,
}

#[derive(Clone)]
pub(super) struct Plan {
    pub(super) width: u16,
    pub(super) height: u16,
    pub(super) palette: Vec<u8>,
    pub(super) repeat: gif::Repeat,
    pub(super) frames: Vec<gif::Frame<'static>>,
}

pub(super) fn read_plan(path: &Path, strict_end: bool) -> Result<Plan, AppError> {
    if strict_end {
        verify_lzw_stream(path)?;
    }
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    options.check_frame_consistency(true);
    // A fixed output buffer can make gif's strict-end driver report NoProgress
    // before consuming a valid terminal code. Verify it separately, with room
    // to detect both the terminal code and an excess decoded pixel.
    options.check_lzw_end_code(false);
    let mut decoder = options
        .read_info(File::open(path).map_err(decode_error)?)
        .map_err(decode_error)?;
    let mut plan = Plan {
        width: decoder.width(),
        height: decoder.height(),
        palette: decoder.global_palette().unwrap_or(&[]).to_vec(),
        repeat: gif::Repeat::Finite(0),
        frames: Vec::new(),
    };
    if usize::from(plan.width) * usize::from(plan.height) > 4 * 1024 * 1024 {
        return Err(decode_error("索引压缩暂不处理超过 4 百万像素的画布"));
    }
    let mut index_bytes = 0;
    while let Some(frame) = decoder.read_next_frame().map_err(decode_error)? {
        check_conversion_cancelled()?;
        index_bytes += frame.buffer.len();
        if index_bytes > MAX_INDEX_BYTES || plan.frames.len() >= 240 {
            return Err(AppError::UnsupportedVideo(
                "索引压缩最多处理 240 帧、64 MiB 索引数据".into(),
            ));
        }
        let mut owned = frame.clone();
        owned.buffer = Cow::Owned(frame.buffer.to_vec());
        owned.interlaced = false; // read_next_frame already deinterlaces pixels.
        plan.frames.push(owned);
    }
    plan.repeat = decoder.repeat();
    if plan.width == 0 || plan.height == 0 || plan.frames.is_empty() {
        return Err(decode_error("Empty GIF"));
    }
    Ok(plan)
}

fn verify_lzw_data(data: &[u8], expected: usize) -> Result<(), AppError> {
    let (&minimum, compressed) = data
        .split_first()
        .ok_or_else(|| decode_error("Empty LZW data"))?;
    if !(2..=8).contains(&minimum) || expected > MAX_INDEX_BYTES {
        return Err(decode_error("Invalid LZW size"));
    }
    let mut decoder = weezl::decode::Decoder::new(weezl::BitOrder::Lsb, minimum);
    let mut buffer = vec![0; expected + 1];
    let (mut consumed, mut written) = (0, 0);
    loop {
        check_conversion_cancelled()?;
        let result = decoder.decode_bytes(&compressed[consumed..], &mut buffer[written..]);
        consumed += result.consumed_in;
        written += result.consumed_out;
        if written > expected {
            return Err(decode_error("Excess LZW pixels"));
        }
        match result.status.map_err(decode_error)? {
            weezl::LzwStatus::Done if written == expected && decoder.has_ended() => return Ok(()),
            weezl::LzwStatus::Ok if result.consumed_in + result.consumed_out > 0 => {}
            _ => return Err(decode_error("Missing LZW end code or incomplete pixels")),
        }
    }
}

fn verify_lzw_stream(path: &Path) -> Result<(), AppError> {
    let mut options = gif::DecodeOptions::new();
    options.skip_frame_decoding(true);
    options.check_frame_consistency(true);
    let mut reader = options
        .read_info(File::open(path).map_err(decode_error)?)
        .map_err(decode_error)?;
    let (mut count, mut pixels) = (0, 0);
    while let Some(frame) = reader.read_next_frame().map_err(decode_error)? {
        let expected = usize::from(frame.width) * usize::from(frame.height);
        count += 1;
        pixels += expected;
        if count > 240 || pixels > MAX_INDEX_BYTES {
            return Err(decode_error("LZW verification budget exceeded"));
        }
        verify_lzw_data(&frame.buffer, expected)?;
    }
    Ok(())
}

fn decode_error(error: impl ToString) -> AppError {
    AppError::DecodeFailed(error.to_string())
}
fn encode_error(error: impl ToString) -> AppError {
    AppError::EncodeFailed(error.to_string())
}

fn distance(a: &[u8], b: &[u8]) -> u8 {
    (0..3).map(|i| a[i].abs_diff(b[i])).max().unwrap_or(0)
}

fn simplify(
    frame: &gif::Frame<'_>,
    palette: &[u8],
    threshold: u8,
) -> Result<(Vec<u8>, usize), AppError> {
    let (w, h) = (usize::from(frame.width), usize::from(frame.height));
    let source = frame.buffer.as_ref();
    if source.len() != w * h
        || source
            .iter()
            .any(|&i| usize::from(i) * 3 + 2 >= palette.len())
    {
        return Err(decode_error("Invalid palette or index buffer"));
    }
    let color = |index: u8| &palette[usize::from(index) * 3..usize::from(index) * 3 + 3];
    let mut output = source.to_vec();
    let mut changed = 0;
    // Keep rectangle boundaries and sharp transitions exact. Every substitution
    // is bounded against the original pixel, so errors cannot drift along a run.
    for y in 1..h.saturating_sub(1) {
        check_conversion_cancelled()?;
        for x in 1..w.saturating_sub(1) {
            let p = y * w + x;
            if Some(source[p]) == frame.transparent {
                continue;
            }
            let original = color(source[p]);
            let neighbors = [p - 1, p + 1, p - w, p + w];
            if neighbors.iter().any(|&n| {
                Some(source[n]) == frame.transparent
                    || distance(original, color(source[n])) > EDGE_DELTA
            }) {
                continue;
            }
            // Left / above reuse favors longer repeated index strings for LZW.
            let candidates = [output[p - 1], output[p - w]];
            if let Some(&replacement) = candidates
                .iter()
                .filter(|&&index| {
                    Some(index) != frame.transparent
                        && index != source[p]
                        && distance(original, color(index)) <= threshold
                })
                .min_by_key(|&&index| distance(original, color(index)))
            {
                output[p] = replacement;
                changed += usize::from(replacement != source[p]);
            }
        }
    }
    Ok((output, changed))
}

fn write_candidate(plan: &Plan, threshold: u8, path: &Path) -> Result<usize, AppError> {
    let mut changed = 0;
    let file = File::create(path).map_err(encode_error)?;
    let mut encoder =
        gif::Encoder::new(file, plan.width, plan.height, &plan.palette).map_err(encode_error)?;
    if plan.repeat != gif::Repeat::Finite(0) {
        encoder.set_repeat(plan.repeat).map_err(encode_error)?;
    }
    for frame in &plan.frames {
        check_conversion_cancelled()?;
        let palette = frame.palette.as_deref().unwrap_or(&plan.palette);
        let (indices, count) = simplify(frame, palette, threshold)?;
        changed += count;
        let mut candidate = frame.clone();
        candidate.buffer = Cow::Owned(indices);
        encoder.write_frame(&candidate).map_err(encode_error)?;
    }
    encoder.into_inner().map_err(encode_error)?;
    Ok(changed)
}

pub(super) fn raw_decode(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    frames: usize,
    bytes: usize,
) -> Result<(), AppError> {
    let result = Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-ignore_loop", "0", "-i"])
        .arg(input)
        .args(["-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v"])
        .arg(frames.to_string())
        .args(["-pix_fmt", "rgba", "-f", "rawvideo"])
        .arg(output)
        .output_for_conversion_task()
        .map_err(decode_error)?;
    check_conversion_cancelled()?;
    if !result.status.success() || fs::metadata(output).map_err(decode_error)?.len() != bytes as u64
    {
        return Err(decode_error("Index compression validation decode failed"));
    }
    Ok(())
}

fn compare_frame(
    source: &[u8],
    candidate: &[u8],
    width: usize,
    limit: u8,
) -> Result<(u8, f64), AppError> {
    if source.len() != candidate.len() || !source.len().is_multiple_of(4) || width == 0 {
        return Err(decode_error("Frame size changed"));
    }
    let mut maximum = 0;
    let mut sum = 0_u64;
    let pixels = source.len() / 4;
    let mut visible = 0_u64;
    for p in 0..pixels {
        if p % width == 0 {
            check_conversion_cancelled()?;
        }
        let a = &source[p * 4..p * 4 + 4];
        let b = &candidate[p * 4..p * 4 + 4];
        if a[3] != b[3] {
            return Err(decode_error("Transparency changed"));
        }
        if a[3] == 0 {
            continue;
        }
        let error = distance(a, b);
        if error > limit {
            return Err(decode_error("Pixel error exceeds the selected bound"));
        }
        if error > 0 {
            let neighbors = [
                p.checked_sub(1).filter(|_| p % width > 0),
                (p % width + 1 < width).then_some(p + 1),
                p.checked_sub(width),
                (p + width < pixels).then_some(p + width),
            ];
            if neighbors.into_iter().flatten().any(|n| {
                source[n * 4 + 3] != a[3] || distance(a, &source[n * 4..n * 4 + 4]) > EDGE_DELTA
            }) {
                return Err(decode_error("Strong edge changed"));
            }
        }
        maximum = maximum.max(error);
        sum += (0..3)
            .map(|c| u64::from(a[c].abs_diff(b[c])).pow(2))
            .sum::<u64>();
        visible += 1;
    }
    let rmse = (sum as f64 / (visible.max(1) * 3) as f64).sqrt();
    if rmse > 3.0 {
        return Err(decode_error("Frame RMSE exceeds 3/255"));
    }
    Ok((maximum, rmse))
}

fn verify_pixels(
    source: &Path,
    candidate: &Path,
    width: usize,
    frame_bytes: usize,
    count: usize,
    limit: u8,
) -> Result<(u8, f64), AppError> {
    let mut a = BufReader::new(File::open(source).map_err(decode_error)?);
    let mut b = BufReader::new(File::open(candidate).map_err(decode_error)?);
    let mut source_frame = vec![0; frame_bytes];
    let mut candidate_frame = vec![0; frame_bytes];
    let mut maximum = 0;
    let mut worst = 0.0_f64;
    for _ in 0..count {
        a.read_exact(&mut source_frame).map_err(decode_error)?;
        b.read_exact(&mut candidate_frame).map_err(decode_error)?;
        let (error, rmse) = compare_frame(&source_frame, &candidate_frame, width, limit)?;
        maximum = maximum.max(error);
        worst = worst.max(rmse);
    }
    Ok((maximum, worst))
}

fn optimize(
    ffmpeg: &Path,
    source: &Path,
    target: Option<u64>,
    report: &mut IndexCompressionReport,
) -> Result<(), AppError> {
    if report.before_bytes > MAX_FILE_BYTES {
        return Err(encode_error("索引压缩暂不处理超过 32 MiB 的文件"));
    }
    // Read the staged baseline normally. Candidates additionally undergo an
    // explicit bounded LZW end-code check and complete presentation comparison.
    let plan = read_plan(source, false)?;
    let cycles = if matches!(plan.repeat, gif::Repeat::Finite(0 | 1)) {
        1
    } else {
        2
    };
    let count = plan.frames.len() * cycles;
    let frame_bytes = usize::from(plan.width) * usize::from(plan.height) * 4;
    let bytes = frame_bytes
        .checked_mul(count)
        .ok_or_else(|| decode_error("Decode budget overflow"))?;
    if bytes > MAX_RGBA_BYTES {
        return Err(encode_error(
            "索引压缩展示验证超出 256 MiB 单路预算，保留原输出",
        ));
    }
    let temp = OwnedTempDir::create("gifp-index-compression")?;
    let baseline = temp.path().join("baseline.rgba");
    let decoded = temp.path().join("candidate.rgba");
    let candidate = temp.path().join("candidate.gif");
    let best = temp.path().join("best.gif");
    let mut baseline_decoded = false;
    let thresholds: &[u8] = if report.gentle { &[1, 2] } else { &[2, 4, 8] };
    for &threshold in thresholds {
        check_conversion_cancelled()?;
        let changed = write_candidate(&plan, threshold, &candidate)?;
        report.candidates_tested += 1;
        let size = fs::metadata(&candidate).map_err(decode_error)?.len();
        if changed == 0
            || size >= report.after_bytes
            || report.before_bytes - size < 64.max(report.before_bytes / 100)
            || target.is_some_and(|cap| size > cap)
        {
            continue;
        }
        let layout = read_plan(&candidate, true)?;
        if layout.width != plan.width
            || layout.height != plan.height
            || layout.repeat != plan.repeat
            || layout.frames.len() != plan.frames.len()
            || layout.frames.iter().zip(&plan.frames).any(|(a, b)| {
                a.delay != b.delay
                    || a.dispose != b.dispose
                    || a.transparent != b.transparent
                    || a.left != b.left
                    || a.top != b.top
                    || a.width != b.width
                    || a.height != b.height
            })
        {
            continue;
        }
        if !baseline_decoded {
            raw_decode(ffmpeg, source, &baseline, count, bytes)?;
            baseline_decoded = true;
        }
        raw_decode(ffmpeg, &candidate, &decoded, count, bytes)?;
        match verify_pixels(
            &baseline,
            &decoded,
            usize::from(plan.width),
            frame_bytes,
            count,
            threshold,
        ) {
            Ok((maximum, worst)) => {
                if report.gentle && worst > 1.0 {
                    continue;
                }
                fs::copy(&candidate, &best).map_err(encode_error)?;
                report.after_bytes = size;
                report.threshold = threshold;
                report.max_channel_error = maximum;
                report.worst_frame_rmse = worst;
            }
            Err(_) => {
                check_conversion_cancelled()?;
            }
        }
    }
    if report.after_bytes < report.before_bytes {
        verify_delivery_output(&best, AnimationFormat::Gif)?;
        check_conversion_cancelled()?;
        publish_file_atomically(&best, source, true)?;
        report.status = "optimized".into();
        report.verified = true;
    }
    Ok(())
}

pub(super) fn optional(
    ffmpeg: &Path,
    source: &Path,
    target: Option<u64>,
    gentle: bool,
) -> Result<IndexCompressionReport, AppError> {
    let _stage = export_pipeline::stage(Phase::Validation);
    let started = Instant::now();
    let bytes = fs::metadata(source).map_err(decode_error)?.len();
    let mut report = IndexCompressionReport {
        gentle,
        algorithm: "gifp.index_reuse.v1",
        status: "retained".into(),
        before_bytes: bytes,
        after_bytes: bytes,
        verified: false,
        threshold: 0,
        max_channel_error: 0,
        worst_frame_rmse: 0.0,
        candidates_tested: 0,
        elapsed_ms: 0,
        reason: None,
    };
    if let Err(error) = optimize(ffmpeg, source, target, &mut report) {
        check_conversion_cancelled()?;
        report.after_bytes = bytes;
        report.verified = false;
        report.threshold = 0;
        report.max_channel_error = 0;
        report.worst_frame_rmse = 0.0;
        report.reason = Some(error.to_string());
    }
    if report.status == "retained" && report.reason.is_none() {
        report.reason = Some("没有满足画面误差限制且明显更小的候选".into());
    }
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "real FFmpeg and prior 480p study; validates gentle policy"]
    fn gentle_index_native_smoke() {
        let ffmpeg = locate_ffmpeg().unwrap();
        let work = OwnedTempDir::create("gentle-index").unwrap();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let rows: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("audits/2026-09-09-gif-boundary/results.json")).unwrap(),
        )
        .unwrap();
        let row = rows
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["source"] == "smooth-gradient" && r["method"] == "gifp-best-current")
            .unwrap();
        let output = std::env::var_os("GIFP_SWITCH_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| work.path().to_path_buf());
        fs::create_dir_all(&output).unwrap();
        let path = output.join("gentle-gradient.gif");
        fs::copy(row["path"].as_str().unwrap(), &path).unwrap();
        let report = optional(&ffmpeg, &path, None, true).unwrap();
        assert!(report.gentle);
        assert!(report.verified, "{report:?}");
        assert!(
            report.threshold <= 2
                && report.max_channel_error <= 2
                && report.worst_frame_rmse <= 1.0
        );
        let plan = read_plan(&path, true).unwrap();
        assert_eq!((plan.width, plan.height, plan.frames.len()), (854, 480, 60));
        fs::write(
            output.join("gentle-report.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        eprintln!("{report:?}");
    }
    #[test]
    fn index_reused_streams_have_complete_lzw_data() {
        let work = OwnedTempDir::create("index-lzw-unit").unwrap();
        let source = work.path().join("source.gif");
        weak_texture(&source, gif::Repeat::Infinite, false);
        let plan = read_plan(&source, false).unwrap();
        let candidate = work.path().join("candidate.gif");
        assert!(write_candidate(&plan, 2, &candidate).unwrap() > 0);
        let decoded = read_plan(&candidate, true).unwrap();
        assert_eq!(decoded.frames.len(), 6);
        let mut options = gif::DecodeOptions::new();
        options.skip_frame_decoding(true);
        let mut decoder = options.read_info(File::open(candidate).unwrap()).unwrap();
        let frame = decoder.read_next_frame().unwrap().unwrap();
        assert!(verify_lzw_data(&frame.buffer, 128 * 96).is_ok());
        assert!(verify_lzw_data(&frame.buffer, 128 * 96 - 1).is_err());
        assert!(verify_lzw_data(&frame.buffer[..1], 128 * 96).is_err());
    }
    fn weak_texture(path: &Path, repeat: gif::Repeat, transparent: bool) {
        let palette = [100, 100, 100, 102, 102, 102, 255, 255, 255, 0, 0, 0];
        let mut encoder =
            gif::Encoder::new(File::create(path).unwrap(), 128, 96, &palette).unwrap();
        if repeat != gif::Repeat::Finite(0) {
            encoder.set_repeat(repeat).unwrap();
        }
        for f in 0..6 {
            let mut state = 17_u32 + f;
            let pixels = (0..128 * 96)
                .map(|i| {
                    state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                    if i % 128 < 4 || i % 128 > 123 {
                        if transparent {
                            3
                        } else {
                            2
                        }
                    } else {
                        (state >> 31) as u8
                    }
                })
                .collect::<Vec<_>>();
            let frame = gif::Frame {
                width: 128,
                height: 96,
                delay: if f % 3 == 2 { 9 } else { 8 },
                transparent: transparent.then_some(3),
                dispose: gif::DisposalMethod::Background,
                buffer: Cow::Owned(pixels),
                ..Default::default()
            };
            encoder.write_frame(&frame).unwrap();
        }
    }
    #[test]
    #[ignore = "real FFmpeg; covers adoption, caps, alpha, repeat and cancellation"]
    fn index_compression_delivery_smoke() {
        let ffmpeg = locate_ffmpeg().unwrap();
        let work = OwnedTempDir::create("gifp-index-test").unwrap();
        for (i, repeat) in [
            gif::Repeat::Finite(0),
            gif::Repeat::Finite(1),
            gif::Repeat::Infinite,
        ]
        .into_iter()
        .enumerate()
        {
            let input = work.path().join(format!("source-{i}.gif"));
            weak_texture(&input, repeat, i == 2);
            let before = fs::read(&input).unwrap();
            let limited = optional(&ffmpeg, &input, Some(1), false).unwrap();
            assert!(!limited.verified);
            assert_eq!(fs::read(&input).unwrap(), before);
            let report = optional(&ffmpeg, &input, None, false).unwrap();
            assert!(report.verified, "{report:?}");
            assert!(report.after_bytes < report.before_bytes);
            assert_eq!(read_plan(&input, true).unwrap().repeat, repeat);
        }
        let input = work.path().join("cancel.gif");
        weak_texture(&input, gif::Repeat::Infinite, false);
        let before = fs::read(&input).unwrap();
        let id = format!("index-cancel-{}", std::process::id());
        let task = ConversionTaskScope::register(Some(&id)).unwrap();
        task.activate();
        assert!(cancel_conversion_task(id).unwrap());
        assert!(matches!(
            optional(&ffmpeg, &input, None, false),
            Err(AppError::Cancelled(_))
        ));
        assert_eq!(fs::read(&input).unwrap(), before);
        drop(task);
        // Exercise the command's adopted-result metadata on the proven 480p
        // gradient, rather than requiring a benefit on an already tiny GIF.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let study: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("audits/2026-09-09-gif-boundary/gifp-lab.json")).unwrap(),
        )
        .unwrap();
        let record = study["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["fixture_id"] == "smooth-gradient" && r["profile_id"] == "best-current")
            .unwrap();
        let mut request: GifRequest = serde_json::from_value(record["request"].clone()).unwrap();
        request.output_dir = work.path().to_string_lossy().into_owned();
        request.index_compression = true;
        let mut invalid = request.clone();
        invalid.output_format = "webp".into();
        assert!(matches!(
            convert_animation_inner(invalid),
            Err(AppError::InvalidInput(_))
        ));
        let result = convert_animation_inner(request).unwrap();
        assert_eq!(
            result.size_bytes,
            fs::metadata(&result.output_path).unwrap().len()
        );
        assert_eq!(result.output_width, 854);
        let report = result.index_compression_report.as_ref().unwrap();
        assert!(report.verified, "{report:?}");
        assert_eq!(result.size_bytes, report.after_bytes);
        assert!(result.encoder_used.contains("+index_reuse_v1"));
        assert!(result.palette_report.is_none() && result.indexed_gif_writer_report.is_none());
    }
    #[test]
    #[ignore = "real FFmpeg / fixed 480p study outputs; set GIFP_INDEX_OUTPUT"]
    fn index_compression_native_bench() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let output =
            PathBuf::from(std::env::var_os("GIFP_INDEX_OUTPUT").expect("set GIFP_INDEX_OUTPUT"));
        fs::create_dir_all(&output).unwrap();
        let rows: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("audits/2026-09-09-gif-boundary/results.json")).unwrap(),
        )
        .unwrap();
        let ffmpeg = locate_ffmpeg().unwrap();
        let mut reports = Vec::new();
        let mut adopted = 0;
        for row in rows
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["method"] == "gifp-best-current")
        {
            let input = PathBuf::from(row["path"].as_str().unwrap());
            let destination = output.join(format!("{}-index.gif", row["source"].as_str().unwrap()));
            fs::copy(&input, &destination).unwrap();
            let report = optional(&ffmpeg, &destination, None, false).unwrap();
            let a = read_plan(&input, false).unwrap();
            let b = read_plan(&destination, report.verified).unwrap();
            assert_eq!(
                (a.width, a.height, a.repeat, a.frames.len()),
                (b.width, b.height, b.repeat, b.frames.len())
            );
            assert_eq!(
                a.frames.iter().map(|f| f.delay).collect::<Vec<_>>(),
                b.frames.iter().map(|f| f.delay).collect::<Vec<_>>()
            );
            assert_eq!(
                report.after_bytes,
                fs::metadata(&destination).unwrap().len()
            );
            if report.verified {
                adopted += 1;
                assert!(report.after_bytes < report.before_bytes);
            } else {
                assert_eq!(fs::read(&input).unwrap(), fs::read(&destination).unwrap());
            }
            eprintln!(
                "{}: {} -> {} ({})",
                row["source"], report.before_bytes, report.after_bytes, report.status
            );
            reports.push(serde_json::json!({"source":row["source"],"input":input,"output":destination,"report":report}));
        }
        fs::write(
            output.join("report.json"),
            serde_json::to_vec_pretty(&reports).unwrap(),
        )
        .unwrap();
        assert_eq!(reports.len(), 4);
        assert!(
            adopted > 0,
            "new algorithm must provide a measured saving on at least one study example"
        );
    }
    #[test]
    fn index_reuse_bounds_each_pixel_and_keeps_edges_and_alpha() {
        let palette = [100, 100, 100, 102, 102, 102, 255, 255, 255, 0, 0, 0];
        let mut frame = gif::Frame {
            width: 8,
            height: 8,
            buffer: Cow::Owned((0..64).map(|i| (i % 2) as u8).collect()),
            ..Default::default()
        };
        frame.buffer.to_mut()[27] = 2;
        frame.buffer.to_mut()[36] = 3;
        frame.transparent = Some(3);
        let (indices, changed) = simplify(&frame, &palette, 2).unwrap();
        assert!(changed > 0);
        assert_eq!(indices[27], 2);
        assert_eq!(indices[36], 3);
        for (&a, &b) in frame.buffer.iter().zip(&indices) {
            assert!(
                distance(
                    &palette[a as usize * 3..][..3],
                    &palette[b as usize * 3..][..3]
                ) <= 2
            );
        }
    }
    #[test]
    fn decoded_gate_rejects_edges_alpha_and_excessive_error() {
        let source = [100, 100, 100, 255].repeat(16);
        let mut candidate = source.clone();
        candidate[20] = 102;
        assert!(compare_frame(&source, &candidate, 4, 2).is_ok());
        candidate[20] = 110;
        assert!(compare_frame(&source, &candidate, 4, 2).is_err());
        candidate = source.clone();
        candidate[23] = 0;
        assert!(compare_frame(&source, &candidate, 4, 8).is_err());
        let mut edge = source.clone();
        edge[16..19].fill(0);
        candidate = edge.clone();
        candidate[20] = 101;
        assert!(compare_frame(&edge, &candidate, 4, 8).is_err());
    }
}
