//! Offline three-direction compression laboratory. Candidate files are research
//! artifacts; external decoder/source checks must precede any product promotion.
use crate::core::{
    compression_search::{self as search, SearchStats},
    evaluate_rgb24_candidate, evaluate_timing_aware_temporal_residual, IndexedGifDisposal,
    IndexedGifFrame, IndexedGifPlan, IndexedGifRepeat,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    time::Instant,
};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RENDER_BYTES: usize = 256 * 1024 * 1024;
const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
const MAX_FRAMES: usize = 240;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    input: PathBuf,
    reference_rgb: Option<PathBuf>,
    output_dir: PathBuf,
    #[serde(default = "default_budget")]
    max_probes_per_candidate: usize,
}
fn default_budget() -> usize {
    3000
}

#[derive(Clone, Debug, Serialize)]
struct Quality {
    mean_oklab: f64,
    edge_oklab: f64,
    banding: f64,
    low_frequency_error: f64,
    static_residual: f64,
    multiscale_static_residual: f64,
    loop_residual: Option<f64>,
}

#[derive(Debug, Default, Serialize)]
struct PixelEnvelope {
    alpha_exact: bool,
    strong_edges_exact: bool,
    max_channel_error: u8,
    worst_frame_rmse: f64,
}

#[derive(Serialize)]
struct Candidate {
    id: String,
    direction: String,
    comparison: String,
    bytes: Option<usize>,
    sha256: Option<String>,
    file: Option<String>,
    saved_percent_vs_input: Option<f64>,
    elapsed_ms: u128,
    search: Option<SearchStats>,
    pixels: Option<PixelEnvelope>,
    quality: Option<Quality>,
    internal_gate_passed: bool,
    reasons: Vec<String>,
}

#[derive(Serialize)]
struct Report {
    schema_version: u8,
    experiment: &'static str,
    gate_id: &'static str,
    input: PathBuf,
    input_sha256: String,
    reference_rgb_sha256: Option<String>,
    baseline_bytes: usize,
    width: u16,
    height: u16,
    delays_cs: Vec<u16>,
    looping: bool,
    max_probes_per_candidate: usize,
    baseline_quality: Option<Quality>,
    best_provisional: Option<String>,
    promotion_status: &'static str,
    candidates: Vec<Candidate>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verify_lzw(bytes: &[u8]) -> Result<(), String> {
    let mut options = gif::DecodeOptions::new();
    options.skip_frame_decoding(true);
    options.check_frame_consistency(true);
    let mut reader = options
        .read_info(Cursor::new(bytes))
        .map_err(|e| e.to_string())?;
    let mut frames = 0;
    let mut pixels = 0;
    while let Some(frame) = reader.read_next_frame().map_err(|e| e.to_string())? {
        frames += 1;
        let expected = usize::from(frame.width) * usize::from(frame.height);
        pixels += expected;
        if frames > MAX_FRAMES || pixels > MAX_INDEX_BYTES {
            return Err("LZW verification budget exceeded".into());
        }
        let (&minimum, compressed) = frame.buffer.split_first().ok_or("empty LZW data")?;
        if !(2..=8).contains(&minimum) {
            return Err("invalid LZW minimum code size".into());
        }
        let mut decoder = weezl::decode::Decoder::new(weezl::BitOrder::Lsb, minimum);
        let mut output = vec![0; expected + 1];
        let (mut consumed, mut written) = (0, 0);
        loop {
            let result = decoder.decode_bytes(&compressed[consumed..], &mut output[written..]);
            consumed += result.consumed_in;
            written += result.consumed_out;
            if written > expected {
                return Err("excess LZW pixels".into());
            }
            match result.status.map_err(|e| e.to_string())? {
                weezl::LzwStatus::Done if written == expected && decoder.has_ended() => break,
                weezl::LzwStatus::Ok if result.consumed_in + result.consumed_out > 0 => {}
                _ => return Err("missing LZW end code or incomplete pixels".into()),
            }
        }
    }
    Ok(())
}

fn read_plan(bytes: &[u8]) -> Result<IndexedGifPlan, String> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("input exceeds 32 MiB".into());
    }
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    options.check_frame_consistency(true);
    // Verify the terminal code separately: gif 0.14's fixed-size strict-end
    // driver can stop before consuming a valid terminal code.
    options.check_lzw_end_code(false);
    let mut reader = options
        .read_info(Cursor::new(bytes))
        .map_err(|e| e.to_string())?;
    let (width, height) = (reader.width(), reader.height());
    let canvas = usize::from(width) * usize::from(height);
    if canvas == 0 || canvas > 4 * 1024 * 1024 {
        return Err("canvas exceeds research limits".into());
    }
    let background_index = reader.bg_color().unwrap_or(0);
    let mut global_palette_rgb = reader
        .global_palette()
        .unwrap_or(&[0, 0, 0, 0, 0, 0])
        .to_vec();
    let mut frames = Vec::new();
    let mut indexed_pixels = 0;
    while let Some(frame) = reader.read_next_frame().map_err(|e| e.to_string())? {
        indexed_pixels += frame.buffer.len();
        if frames.len() >= MAX_FRAMES
            || indexed_pixels > MAX_INDEX_BYTES
            || canvas * 4 * (frames.len() + 1) > MAX_RENDER_BYTES
        {
            return Err("frame/index/render research budget exceeded".into());
        }
        if frame.delay == 0 || frame.needs_user_input {
            return Err(
                "zero-delay or user-input frames require a separate playback experiment".into(),
            );
        }
        frames.push(IndexedGifFrame {
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
        });
    }
    if frames.is_empty() {
        return Err("empty GIF".into());
    }
    let repeat = match reader.repeat() {
        gif::Repeat::Infinite => IndexedGifRepeat::Infinite,
        gif::Repeat::Finite(0) => IndexedGifRepeat::None,
        _ => return Err("finite repeat counts are not supported by this experiment".into()),
    };
    if background_index != 0 && !frames.iter().any(|f| f.transparent_index.is_some()) {
        // The shared writer emits background index zero. Rename global indices
        // bijectively so the background color and every displayed pixel survive.
        for c in 0..3 {
            global_palette_rgb.swap(c, background_index * 3 + c);
        }
        for frame in &mut frames {
            if frame.local_palette_rgb.is_none() {
                for index in &mut frame.indices {
                    if usize::from(*index) == background_index {
                        *index = 0;
                    } else if *index == 0 {
                        *index = background_index as u8;
                    }
                }
            }
        }
    }
    verify_lzw(bytes)?;
    Ok(IndexedGifPlan {
        width,
        height,
        global_palette_rgb,
        repeat,
        frames,
    })
}

fn quality(
    reference: &[u8],
    plan: &IndexedGifPlan,
    displayed: &[Vec<u8>],
) -> Result<Quality, String> {
    if displayed
        .iter()
        .any(|f| f.chunks_exact(4).any(|p| p[3] != 255))
    {
        return Err("source RGB quality gate requires an opaque display".into());
    }
    let rgb: Vec<u8> = displayed
        .iter()
        .flat_map(|f| f.chunks_exact(4).flat_map(|p| p[..3].iter().copied()))
        .collect();
    let metrics = evaluate_rgb24_candidate(reference, &rgb, plan.width, plan.height)
        .map_err(|e| e.to_string())?;
    let timing = evaluate_timing_aware_temporal_residual(
        reference,
        &rgb,
        plan.width,
        plan.height,
        &plan.frames.iter().map(|f| f.delay_cs).collect::<Vec<_>>(),
        plan.repeat == IndexedGifRepeat::Infinite,
    )
    .map_err(|e| e.to_string())?;
    Ok(Quality {
        mean_oklab: metrics.mean_oklab_error,
        edge_oklab: metrics.edge_weighted_mean_oklab_error,
        banding: metrics.multiscale_banding_score,
        low_frequency_error: metrics.multiscale_low_frequency_oklab_error,
        static_residual: timing.weighted_static_temporal_residual,
        multiscale_static_residual: timing.weighted_multiscale_static_temporal_residual,
        loop_residual: timing.loop_seam_static_temporal_residual,
    })
}

fn envelope(before: &[Vec<u8>], after: &[Vec<u8>], width: usize) -> Result<PixelEnvelope, String> {
    if before.len() != after.len() {
        return Err("display frame count changed".into());
    }
    let mut result = PixelEnvelope {
        alpha_exact: true,
        strong_edges_exact: true,
        ..Default::default()
    };
    for (a, b) in before.iter().zip(after) {
        if a.len() != b.len() {
            return Err("display canvas changed".into());
        }
        let mut squared = 0_u64;
        let mut visible = 0;
        for p in 0..a.len() / 4 {
            if a[p * 4 + 3] != b[p * 4 + 3] {
                result.alpha_exact = false;
            }
            if a[p * 4 + 3] == 0 {
                continue;
            }
            visible += 1;
            let difference = (0..3)
                .map(|c| a[p * 4 + c].abs_diff(b[p * 4 + c]))
                .max()
                .unwrap_or(0);
            result.max_channel_error = result.max_channel_error.max(difference);
            squared += (0..3)
                .map(|c| u64::from(a[p * 4 + c].abs_diff(b[p * 4 + c])).pow(2))
                .sum::<u64>();
            if difference > 0 {
                let neighbors = [
                    p.checked_sub(1).filter(|_| p % width > 0),
                    (p % width + 1 < width).then_some(p + 1),
                    p.checked_sub(width),
                    (p + width < a.len() / 4).then_some(p + width),
                ];
                if neighbors.into_iter().flatten().any(|n| {
                    a[n * 4 + 3] != a[p * 4 + 3]
                        || (0..3).any(|c| a[n * 4 + c].abs_diff(a[p * 4 + c]) > 24)
                }) {
                    result.strong_edges_exact = false;
                }
            }
        }
        result.worst_frame_rmse = result
            .worst_frame_rmse
            .max((squared as f64 / (visible.max(1) * 3) as f64).sqrt());
    }
    Ok(result)
}

fn quality_reasons(candidate: &Quality, baseline: &Quality) -> Vec<String> {
    let mut reasons = Vec::new();
    // Versioned engineering screening thresholds, not a claim of visual losslessness.
    for (name, a, b, relative, absolute) in [
        (
            "mean_oklab",
            candidate.mean_oklab,
            baseline.mean_oklab,
            1.03,
            0.0002,
        ),
        (
            "edge_oklab",
            candidate.edge_oklab,
            baseline.edge_oklab,
            1.01,
            0.0001,
        ),
        (
            "banding",
            candidate.banding,
            baseline.banding,
            1.01,
            0.00001,
        ),
        (
            "low_frequency",
            candidate.low_frequency_error,
            baseline.low_frequency_error,
            1.01,
            0.0001,
        ),
        (
            "static_residual",
            candidate.static_residual,
            baseline.static_residual,
            1.01,
            0.00001,
        ),
        (
            "multiscale_static",
            candidate.multiscale_static_residual,
            baseline.multiscale_static_residual,
            1.01,
            0.00001,
        ),
    ] {
        if !a.is_finite() || !b.is_finite() || a > b * relative + absolute {
            reasons.push(format!("{name} regression"));
        }
    }
    match (candidate.loop_residual, baseline.loop_residual) {
        (Some(a), Some(b)) if !a.is_finite() || !b.is_finite() || a > b * 1.01 + 0.00001 => {
            reasons.push("loop residual regression".into())
        }
        (None, Some(_)) => reasons.push("missing loop metric".into()),
        _ => {}
    }
    reasons
}

struct Evaluator<'a> {
    job: &'a Job,
    input: &'a IndexedGifPlan,
    input_bytes: usize,
    reference: Option<&'a [u8]>,
    baseline_display: &'a [Vec<u8>],
    baseline_quality: Option<&'a Quality>,
}

impl Evaluator<'_> {
    fn assess(
        &self,
        id: &str,
        direction: &str,
        comparison: &str,
        started: Instant,
        result: Result<(IndexedGifPlan, SearchStats), String>,
    ) -> Candidate {
        let mut record = Candidate {
            id: id.into(),
            direction: direction.into(),
            comparison: comparison.into(),
            bytes: None,
            sha256: None,
            file: None,
            saved_percent_vs_input: None,
            elapsed_ms: 0,
            search: None,
            pixels: None,
            quality: None,
            internal_gate_passed: false,
            reasons: vec![],
        };
        let assessment = (|| -> Result<(), String> {
            let (plan, stats) = result?;
            record.search = Some(stats);
            if plan.width != self.input.width
                || plan.height != self.input.height
                || plan.repeat != self.input.repeat
                || plan.frames.iter().map(|f| f.delay_cs).collect::<Vec<_>>()
                    != self
                        .input
                        .frames
                        .iter()
                        .map(|f| f.delay_cs)
                        .collect::<Vec<_>>()
            {
                return Err("playback structure changed".into());
            }
            let bytes = search::encode(&plan)?;
            let decoded = read_plan(&bytes)?;
            let displayed = search::display(&decoded)?;
            let pixels = envelope(self.baseline_display, &displayed, usize::from(plan.width))?;
            if !pixels.alpha_exact || !pixels.strong_edges_exact {
                record.reasons.push("alpha/strong edge mismatch".into());
            }
            if matches!(direction, "structure" | "serialization") {
                if pixels.max_channel_error != 0 {
                    record.reasons.push("lossless display mismatch".into());
                }
            } else if pixels.max_channel_error > 4 || pixels.worst_frame_rmse > 3.0 {
                record.reasons.push("pixel error envelope exceeded".into());
            }
            if plan.repeat == IndexedGifRepeat::Infinite {
                let mut twice = decoded.clone();
                twice.frames.extend(decoded.frames.clone());
                if search::display(&twice)?
                    != displayed
                        .iter()
                        .chain(&displayed)
                        .cloned()
                        .collect::<Vec<_>>()
                {
                    record.reasons.push("second loop display mismatch".into());
                }
            }
            record.quality = if pixels.max_channel_error == 0 {
                self.baseline_quality.cloned()
            } else {
                self.reference
                    .map(|r| quality(r, &plan, &displayed))
                    .transpose()?
            };
            if !matches!(direction, "structure" | "serialization") {
                match (record.quality.as_ref(), self.baseline_quality) {
                    (Some(a), Some(b)) => record.reasons.extend(quality_reasons(a, b)),
                    _ => record
                        .reasons
                        .push("source-reference quality unavailable".into()),
                }
            }
            if bytes.len() + 64.max(self.input_bytes / 100) > self.input_bytes {
                record.reasons.push("savings below 1% / 64 bytes".into());
            }
            record.saved_percent_vs_input =
                Some((1.0 - bytes.len() as f64 / self.input_bytes as f64) * 100.0);
            record.bytes = Some(bytes.len());
            record.sha256 = Some(digest(&bytes));
            record.pixels = Some(pixels);
            let name = format!("{id}.gif");
            fs::write(self.job.output_dir.join(&name), &bytes).map_err(|e| e.to_string())?;
            record.file = Some(name);
            record.internal_gate_passed = record.reasons.is_empty();
            Ok(())
        })();
        if let Err(error) = assessment {
            record.reasons.push(error);
        }
        record.elapsed_ms = started.elapsed().as_millis();
        println!(
            "{}: {:?} bytes, internal gate {}, {:?}",
            record.id, record.bytes, record.internal_gate_passed, record.reasons
        );
        record
    }
}

fn run(job: Job) -> Result<(), String> {
    if !(1..=10000).contains(&job.max_probes_per_candidate) {
        return Err("probe budget must be 1..=10000".into());
    }
    if fs::metadata(&job.input).map_err(|e| e.to_string())?.len() > MAX_FILE_BYTES {
        return Err("input exceeds 32 MiB".into());
    }
    let bytes = fs::read(&job.input).map_err(|e| e.to_string())?;
    let input = read_plan(&bytes)?;
    let expected = usize::from(input.width) * usize::from(input.height) * input.frames.len() * 3;
    let reference = job
        .reference_rgb
        .as_ref()
        .map(|path| -> Result<Vec<u8>, String> {
            if fs::metadata(path).map_err(|e| e.to_string())?.len() != expected as u64 {
                return Err(
                    "reference RGB must contain exactly one full canvas per stored display frame"
                        .into(),
                );
            }
            fs::read(path).map_err(|e| e.to_string())
        })
        .transpose()?;
    let baseline_display = search::display(&input)?;
    let baseline_quality = reference
        .as_deref()
        .map(|r| quality(r, &input, &baseline_display))
        .transpose()?;
    // Fresh outputs only; never rewrite an earlier generation or source.
    if let Some(parent) = job.output_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::create_dir(&job.output_dir)
        .map_err(|e| format!("a fresh output directory is required: {e}"))?;
    let evaluator = Evaluator {
        job: &job,
        input: &input,
        input_bytes: bytes.len(),
        reference: reference.as_deref(),
        baseline_display: &baseline_display,
        baseline_quality: baseline_quality.as_ref(),
    };
    let full = search::flatten(&input);
    let mut candidates = Vec::new();
    candidates.push(evaluator.assess(
        "writer-baseline",
        "serialization",
        "input",
        Instant::now(),
        Ok((input.clone(), SearchStats::default())),
    ));
    for beam in [1, 3] {
        let started = Instant::now();
        let result = full
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|p| search::structure(p, beam, job.max_probes_per_candidate));
        candidates.push(evaluator.assess(
            &format!("structure-beam{beam}"),
            "structure",
            "writer-baseline",
            started,
            result,
        ));
    }
    for static_limit in [0, 1] {
        let started = Instant::now();
        let result = full.as_ref().map_err(Clone::clone).and_then(|p| {
            let reference = reference
                .as_deref()
                .ok_or("temporal search requires source RGB")?;
            let (plan, mut stats) = search::temporal(p, reference, static_limit, 4)?;
            let (plan, spatial) = search::structure(&plan, 1, job.max_probes_per_candidate)?;
            stats.compression_probes = spatial.compression_probes;
            stats.palette_boundary_rectangles = spatial.palette_boundary_rectangles;
            Ok((plan, stats))
        });
        candidates.push(evaluator.assess(
            &format!("temporal-static{static_limit}"),
            "temporal",
            "structure-beam1",
            started,
            result,
        ));
    }
    for limit in [2, 4] {
        let started = Instant::now();
        let result = search::lzw(&input, limit, job.max_probes_per_candidate);
        candidates.push(evaluator.assess(
            &format!("lzw-error{limit}"),
            "lzw",
            "writer-baseline",
            started,
            result,
        ));
    }
    let best = candidates
        .iter()
        .filter(|c| c.internal_gate_passed)
        .min_by_key(|c| c.bytes.unwrap_or(usize::MAX))
        .map(|c| c.id.clone());
    let report = Report {
        schema_version: 1,
        experiment: "gifp.compression_research.v1",
        gate_id: "source_pixel_banding_temporal_v1",
        input: job.input.clone(),
        input_sha256: digest(&bytes),
        reference_rgb_sha256: reference.as_deref().map(digest),
        baseline_bytes: bytes.len(),
        width: input.width,
        height: input.height,
        delays_cs: input.frames.iter().map(|f| f.delay_cs).collect(),
        looping: input.repeat == IndexedGifRepeat::Infinite,
        max_probes_per_candidate: job.max_probes_per_candidate,
        baseline_quality,
        best_provisional: best,
        promotion_status: "requires_external_decode_source_checks_and_review",
        candidates,
    };
    fs::write(
        job.output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Run a reproducible job. Paths in its JSON are relative to the job file.
pub fn run_cli(args: impl Iterator<Item = String>) -> Result<(), String> {
    let args: Vec<_> = args.collect();
    if args == ["--help"] || args.is_empty() {
        println!("gifp_compression_research --job JOB.json\nJob: input, optional reference_rgb (RGB24 at stored-frame midpoints), output_dir (fresh), max_probes_per_candidate (1..10000).\nResearch only; source/decoder checks and review are required before promotion.");
        return Ok(());
    }
    if args.len() != 2 || args[0] != "--job" {
        return Err("expected --job JOB.json".into());
    }
    let job_file = Path::new(&args[1])
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mut job: Job = serde_json::from_slice(&fs::read(&job_file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let parent = job_file.parent().ok_or("job has no parent")?;
    if job.input.is_relative() {
        job.input = parent.join(job.input);
    }
    if job.output_dir.is_relative() {
        job.output_dir = parent.join(job.output_dir);
    }
    if let Some(path) = job.reference_rgb.as_mut() {
        if path.is_relative() {
            *path = parent.join(&path);
        }
    }
    run(job)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_inputs_are_rejected() {
        assert!(read_plan(b"GIF89a").is_err());
        assert!(read_plan(&vec![0; MAX_FILE_BYTES as usize + 1]).is_err());
        assert!(run_cli(["--bogus".into()].into_iter()).is_err());
    }
    #[test]
    fn background_index_is_normalized_without_changing_its_color() {
        let plan = IndexedGifPlan {
            width: 2,
            height: 1,
            global_palette_rgb: vec![0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255],
            repeat: IndexedGifRepeat::None,
            frames: vec![IndexedGifFrame {
                left: 0,
                top: 0,
                width: 1,
                height: 1,
                delay_cs: 8,
                disposal: IndexedGifDisposal::Keep,
                transparent_index: None,
                local_palette_rgb: None,
                indices: vec![1],
            }],
        };
        let mut bytes = search::encode(&plan).unwrap();
        bytes[11] = 2;
        let normalized = read_plan(&bytes).unwrap();
        assert_eq!(
            search::display(&normalized).unwrap()[0],
            vec![255, 0, 0, 255, 0, 255, 0, 255]
        );
        assert_eq!(&normalized.global_palette_rgb[..3], &[0, 255, 0]);
    }

    #[test]
    fn quality_gate_does_not_trade_banding_for_average_error() {
        let baseline = Quality {
            mean_oklab: 0.01,
            edge_oklab: 0.01,
            banding: 1.0,
            low_frequency_error: 0.01,
            static_residual: 0.01,
            multiscale_static_residual: 0.01,
            loop_residual: Some(0.01),
        };
        let mut candidate = baseline.clone();
        candidate.mean_oklab = 0.001;
        candidate.banding = 2.0;
        assert_eq!(
            quality_reasons(&candidate, &baseline),
            ["banding regression"]
        );
        candidate = baseline.clone();
        candidate.loop_residual = Some(0.1);
        assert_eq!(
            quality_reasons(&candidate, &baseline),
            ["loop residual regression"]
        );
    }
}
