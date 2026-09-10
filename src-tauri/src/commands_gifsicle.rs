//! Optional external lossless postprocessing. The source is an owned staging
//! file; the public export is published only after this adapter has finished.
use super::*;

#[derive(Clone, Debug, Serialize)]
pub struct PostprocessReport {
    pub status: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub verified: bool,
    pub elapsed_ms: u64,
    pub reason: Option<String>,
}

impl PostprocessReport {
    pub(super) fn retained(status: &str, bytes: u64, reason: Option<String>) -> Self {
        Self {
            status: status.into(),
            before_bytes: bytes,
            after_bytes: bytes,
            verified: false,
            elapsed_ms: 0,
            reason,
        }
    }
}

struct Contract {
    width: u16,
    height: u16,
    delays: Vec<u16>,
    repeat: gif::Repeat,
}

fn contract(path: &Path) -> Result<Contract, AppError> {
    let mut options = gif::DecodeOptions::new();
    options.skip_frame_decoding(true);
    options.check_frame_consistency(true);
    let mut decoder = options
        .read_info(File::open(path).map_err(|e| AppError::DecodeFailed(e.to_string()))?)
        .map_err(|e| AppError::DecodeFailed(e.to_string()))?;
    let (width, height) = (decoder.width(), decoder.height());
    let mut delays = Vec::new();
    while let Some(frame) = decoder
        .read_next_frame()
        .map_err(|e| AppError::DecodeFailed(e.to_string()))?
    {
        check_conversion_cancelled()?;
        delays.push(frame.delay);
        if delays.len() > 1000 {
            return Err(AppError::UnsupportedVideo(
                "更小优先验证最多支持 1000 个 GIF 帧".into(),
            ));
        }
    }
    if width == 0 || height == 0 || delays.is_empty() {
        return Err(AppError::DecodeFailed("Empty GIF presentation".into()));
    }
    Ok(Contract {
        width,
        height,
        delays,
        repeat: decoder.repeat(),
    })
}

fn decode_budget(layout: &Contract) -> Result<(usize, usize, usize), AppError> {
    let cycles = match layout.repeat {
        gif::Repeat::Finite(0 | 1) => 1,
        _ => 2,
    };
    let frames = layout.delays.len() * cycles;
    let frame_bytes = usize::from(layout.width)
        .checked_mul(usize::from(layout.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| AppError::UnsupportedVideo("GIF validation frame size overflow".into()))?;
    let expected = frame_bytes
        .checked_mul(frames)
        .ok_or_else(|| AppError::UnsupportedVideo("GIF validation size overflow".into()))?;
    if expected > 64 * 1024 * 1024 {
        return Err(AppError::UnsupportedVideo(
            "更小优先的单路展示验证超过 64 MiB 预算，保留原输出".into(),
        ));
    }
    Ok((frames, frame_bytes, expected))
}

fn presentation(
    ffmpeg: &Path,
    input: &Path,
    layout: &Contract,
) -> Result<Vec<(String, u64)>, AppError> {
    let (frames, frame_bytes, expected) = decode_budget(layout)?;
    let output = Command::new(ffmpeg)
        .args(["-v", "error", "-ignore_loop", "0", "-i"])
        .arg(input)
        .args(["-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v"])
        .arg(frames.to_string())
        .args(["-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"])
        .output_for_conversion_task()
        .map_err(|e| AppError::DecodeFailed(e.to_string()))?;
    check_conversion_cancelled()?;
    if !output.status.success() || output.stdout.len() != expected {
        return Err(AppError::DecodeFailed(
            "GIF presentation decode failed or frame count changed".into(),
        ));
    }
    let strict = layout.delays.iter().any(|delay| *delay < 2);
    let mut timeline: Vec<(String, u64)> = Vec::new();
    for (index, frame) in output.stdout.chunks_exact(frame_bytes).enumerate() {
        check_conversion_cancelled()?;
        let hash = format!(
            "{:x}",
            Sha256::digest(canonicalize_transparent_rgb(frame.to_vec()))
        );
        let delay = u64::from(layout.delays[index % layout.delays.len()]);
        if !strict && timeline.last().is_some_and(|last| last.0 == hash) {
            timeline.last_mut().expect("non-empty timeline").1 += delay;
        } else {
            timeline.push((hash, delay));
        }
    }
    Ok(timeline)
}

pub(super) fn verify_equivalent(
    ffmpeg: &Path,
    source: &Path,
    candidate: &Path,
) -> Result<(), AppError> {
    let original = contract(source)?;
    let optimized = contract(candidate)?;
    if (original.width, original.height, original.repeat)
        != (optimized.width, optimized.height, optimized.repeat)
    {
        return Err(AppError::DecodeFailed(
            "Postprocess canvas or loop contract changed".into(),
        ));
    }
    if presentation(ffmpeg, source, &original)? != presentation(ffmpeg, candidate, &optimized)? {
        return Err(AppError::DecodeFailed(
            "Postprocess pixels or display timeline changed".into(),
        ));
    }
    Ok(())
}

pub(super) fn optimize(
    ffmpeg: &Path,
    tool: &Path,
    source: &Path,
    target: Option<u64>,
) -> Result<PostprocessReport, AppError> {
    let _stage = export_pipeline::stage(Phase::Validation);
    let started = Instant::now();
    check_conversion_cancelled()?;
    let before = fs::metadata(source)
        .map_err(|e| AppError::DecodeFailed(e.to_string()))?
        .len();
    if before > 16 * 1024 * 1024 {
        return Ok(PostprocessReport::retained(
            "budget_exceeded",
            before,
            Some("更小优先暂不处理超过 16 MiB 的 GIF".into()),
        ));
    }
    let original = contract(source)?;
    decode_budget(&original)?;
    let temp = OwnedTempDir::create("gifp-gifsicle")?;
    let tool_input = temp.path().join("input.gif");
    fs::copy(source, &tool_input).map_err(|e| AppError::EncodeFailed(e.to_string()))?;
    let candidate = temp.path().join("candidate.gif");
    {
        let _encode_stage = export_pipeline::stage(Phase::Encode);
        let output = Command::new(tool)
            .args(["-O3", "--no-ignore-errors", "--output"])
            .arg(&candidate)
            .arg(&tool_input)
            .output_for_conversion_task()
            .map_err(|e| AppError::EncodeFailed(e.to_string()))?;
        check_conversion_cancelled()?;
        if !output.status.success() {
            return Err(AppError::EncodeFailed(
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(2000)
                    .collect(),
            ));
        }
    }
    let after = fs::metadata(&candidate)
        .map_err(|e| AppError::DecodeFailed(e.to_string()))?
        .len();
    if after >= before {
        let mut report = PostprocessReport::retained("not_smaller", before, None);
        report.elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(report);
    }
    if target.is_some_and(|limit| after > limit) {
        return Err(AppError::EncodeFailed(
            "Postprocess candidate exceeds the hard cap".into(),
        ));
    }
    verify_equivalent(ffmpeg, source, &candidate)?;
    verify_delivery_output(&candidate, AnimationFormat::Gif)?;
    check_conversion_cancelled()?;
    publish_file_atomically(&candidate, source, true)?;
    Ok(PostprocessReport {
        status: "optimized".into(),
        before_bytes: before,
        after_bytes: after,
        verified: true,
        elapsed_ms: started.elapsed().as_millis() as u64,
        reason: None,
    })
}

pub(super) fn optional(
    ffmpeg: &Path,
    tool: Option<&Path>,
    source: &Path,
    target: Option<u64>,
) -> Result<PostprocessReport, AppError> {
    let started = Instant::now();
    let before = fs::metadata(source)
        .map_err(|e| AppError::DecodeFailed(e.to_string()))?
        .len();
    let Some(tool) = tool else {
        return Ok(PostprocessReport::retained(
            "unavailable",
            before,
            Some("未检测到可用的 Gifsicle，已保留原输出".into()),
        ));
    };
    match optimize(ffmpeg, tool, source, target) {
        Ok(report) => Ok(report),
        Err(error) => {
            check_conversion_cancelled()?;
            let mut report =
                PostprocessReport::retained("retained", before, Some(error.to_string()));
            report.elapsed_ms = started.elapsed().as_millis() as u64;
            Ok(report)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verification_budget_accounts_for_two_cycles() {
        let layout = Contract {
            width: 4096,
            height: 4096,
            delays: vec![8],
            repeat: gif::Repeat::Infinite,
        };
        assert!(decode_budget(&layout).is_err());
        let layout = Contract {
            width: 16,
            height: 16,
            delays: vec![8, 12],
            repeat: gif::Repeat::Infinite,
        };
        assert_eq!(decode_budget(&layout).unwrap(), (4, 1024, 4096));
    }
}
