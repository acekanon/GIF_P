use crate::{
    commands::{ConversionCommandExt, MediaInspection},
    core::{animation_demux_args, oklab_distance_srgb8},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub(crate) const ANALYSIS_FPS: u32 = 30;
const ANALYSIS_MAX_EDGE: u32 = 96;
const PRESENTATION_MAX_EDGE: u32 = 320;
const ALPHA_ANALYSIS_MAX_WIDTH: u32 = 480;
const MAX_ALPHA_COMBINED_BUFFER_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_ANALYSIS_FRAMES: usize = 900;
const MAX_RGBA_BUFFER_BYTES: usize = 64 * 1024 * 1024;
const STATIC_OKLAB_THRESHOLD: f64 = 0.012;
const EDGE_THRESHOLD: f64 = 0.08;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ObjectiveQualityMetrics {
    pub status: String,
    pub analysis_fps: u32,
    pub compared_frames: u64,
    pub presentation_width: u32,
    pub presentation_height: u32,
    pub sample_width: u32,
    pub sample_height: u32,
    pub alpha_sample_width: u32,
    pub alpha_sample_height: u32,
    pub raw_vmaf_log_path: String,
    pub vmaf_neg_mean: f64,
    pub vmaf_neg_p05: f64,
    pub vmaf_neg_min: f64,
    pub psnr_y_mean_db: Option<f64>,
    pub ssim_mean: f64,
    pub ssim_min: f64,
    pub ms_ssim_mean: Option<f64>,
    pub ms_ssim_min: Option<f64>,
    pub ms_ssim_valid_ratio: f64,
    /// libvmaf `ciede` feature quality score; higher is better. This is not raw Delta E.
    pub ciede2000_mean: Option<f64>,
    /// P95 of the libvmaf `ciede` quality score; higher is better.
    pub ciede2000_p95: Option<f64>,
    pub ciede2000_valid_ratio: f64,
    pub cambi_mean: f64,
    pub cambi_p95: f64,
    pub mean_oklab_error: f64,
    pub static_region_oklab_error: f64,
    pub static_region_temporal_residual: f64,
    pub static_pixel_ratio: f64,
    pub edge_error: f64,
    pub edge_preservation: f64,
    pub edge_pixel_ratio: f64,
    pub alpha_mean_absolute_error: f64,
    pub alpha_coverage_error: f64,
    pub reference_loop_seam_oklab: f64,
    pub output_loop_seam_oklab: f64,
    pub loop_seam_excess_oklab: f64,
}

#[derive(Debug, Deserialize)]
struct VmafLog {
    frames: Vec<VmafFrame>,
    pooled_metrics: HashMap<String, VmafPool>,
}

#[derive(Debug, Deserialize)]
struct VmafFrame {
    metrics: HashMap<String, Option<f64>>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct VmafPool {
    min: Option<f64>,
    mean: Option<f64>,
}

#[derive(Debug)]
struct VmafSummary {
    frame_count: usize,
    vmaf_mean: f64,
    vmaf_p05: f64,
    vmaf_min: f64,
    psnr_y_mean: Option<f64>,
    ssim_mean: f64,
    ssim_min: f64,
    ms_ssim_mean: Option<f64>,
    ms_ssim_min: Option<f64>,
    ms_ssim_valid_ratio: f64,
    // libvmaf reports a CIEDE2000-derived quality score here, not raw color error.
    ciede_mean: Option<f64>,
    ciede_p95: Option<f64>,
    ciede_valid_ratio: f64,
    cambi_mean: f64,
    cambi_p95: f64,
    log_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RawMetrics {
    pub(crate) mean_oklab_error: f64,
    pub(crate) static_region_oklab_error: f64,
    pub(crate) static_region_temporal_residual: f64,
    pub(crate) static_pixel_ratio: f64,
    pub(crate) edge_error: f64,
    pub(crate) edge_preservation: f64,
    pub(crate) edge_pixel_ratio: f64,
    pub(crate) reference_loop_seam_oklab: f64,
    pub(crate) output_loop_seam_oklab: f64,
    pub(crate) loop_seam_excess_oklab: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct AlphaMetrics {
    frame_count: usize,
    mean_absolute_error: f64,
    coverage_error: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ObjectiveAlphaContract {
    sample_width: u32,
    sample_height: u32,
    metrics: AlphaMetrics,
}

pub(crate) fn evaluate_quality(
    ffmpeg: &Path,
    reference: &Path,
    distorted: &Path,
    reference_inspection: &MediaInspection,
    output_inspection: &MediaInspection,
    duration_seconds: f64,
    work_dir: &Path,
) -> Result<ObjectiveQualityMetrics, String> {
    if reference_inspection.width == 0
        || reference_inspection.height == 0
        || output_inspection.width == 0
        || output_inspection.height == 0
    {
        return Err("Objective quality requires non-zero reference and output sizes".to_string());
    }
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err("Objective quality requires a positive finite duration".to_string());
    }
    fs::create_dir_all(work_dir).map_err(|error| {
        format!(
            "Failed to create objective metric directory {}: {error}",
            work_dir.display()
        )
    })?;

    let (presentation_width, presentation_height) = scaled_even_dimensions(
        PRESENTATION_MAX_EDGE,
        reference_inspection.width,
        reference_inspection.height,
    )?;
    let vmaf = evaluate_vmaf(
        ffmpeg,
        reference,
        distorted,
        presentation_width,
        presentation_height,
        duration_seconds,
        work_dir,
    )?;
    let (sample_width, sample_height) =
        analysis_dimensions(output_inspection.width, output_inspection.height)?;
    let reference_frames = decode_rgba_frames(
        ffmpeg,
        reference,
        sample_width,
        sample_height,
        duration_seconds,
    )?;
    let distorted_frames = decode_rgba_frames(
        ffmpeg,
        distorted,
        sample_width,
        sample_height,
        duration_seconds,
    )?;
    let frame_bytes = frame_bytes(sample_width, sample_height)?;
    let reference_count = reference_frames.len() / frame_bytes;
    let distorted_count = distorted_frames.len() / frame_bytes;
    if reference_count != distorted_count {
        return Err(format!(
            "Timestamp-resampled frame count differs: reference={reference_count}, distorted={distorted_count}"
        ));
    }
    if reference_count != vmaf.frame_count {
        return Err(format!(
            "Objective metric frame count differs: raw={reference_count}, libvmaf={}",
            vmaf.frame_count
        ));
    }
    let raw = compute_raw_metrics(
        &reference_frames,
        &distorted_frames,
        sample_width,
        sample_height,
    )?;
    let uses_alpha =
        requires_alpha_analysis(reference_inspection.has_alpha, output_inspection.has_alpha);
    let native_alpha = if uses_alpha {
        let (alpha_width, alpha_height) =
            alpha_analysis_dimensions(output_inspection.width, output_inspection.height)?;
        validate_alpha_memory_budget(alpha_width, alpha_height, duration_seconds)?;
        let reference_alpha = decode_alpha_frames(
            ffmpeg,
            reference,
            alpha_width,
            alpha_height,
            duration_seconds,
        )?;
        let distorted_alpha = decode_alpha_frames(
            ffmpeg,
            distorted,
            alpha_width,
            alpha_height,
            duration_seconds,
        )?;
        let metrics = compute_alpha_metrics(
            &reference_alpha,
            &distorted_alpha,
            alpha_width,
            alpha_height,
        )?;
        Some((alpha_width, alpha_height, metrics))
    } else {
        None
    };
    let alpha = objective_alpha_contract(
        uses_alpha,
        sample_width,
        sample_height,
        reference_count,
        native_alpha,
    )?;

    Ok(ObjectiveQualityMetrics {
        status: "full".to_string(),
        analysis_fps: ANALYSIS_FPS,
        compared_frames: reference_count as u64,
        presentation_width,
        presentation_height,
        sample_width,
        sample_height,
        alpha_sample_width: alpha.sample_width,
        alpha_sample_height: alpha.sample_height,
        raw_vmaf_log_path: vmaf.log_path.to_string_lossy().to_string(),
        vmaf_neg_mean: vmaf.vmaf_mean,
        vmaf_neg_p05: vmaf.vmaf_p05,
        vmaf_neg_min: vmaf.vmaf_min,
        psnr_y_mean_db: vmaf.psnr_y_mean,
        ssim_mean: vmaf.ssim_mean,
        ssim_min: vmaf.ssim_min,
        ms_ssim_mean: vmaf.ms_ssim_mean,
        ms_ssim_min: vmaf.ms_ssim_min,
        ms_ssim_valid_ratio: vmaf.ms_ssim_valid_ratio,
        ciede2000_mean: vmaf.ciede_mean,
        ciede2000_p95: vmaf.ciede_p95,
        ciede2000_valid_ratio: vmaf.ciede_valid_ratio,
        cambi_mean: vmaf.cambi_mean,
        cambi_p95: vmaf.cambi_p95,
        mean_oklab_error: raw.mean_oklab_error,
        static_region_oklab_error: raw.static_region_oklab_error,
        static_region_temporal_residual: raw.static_region_temporal_residual,
        static_pixel_ratio: raw.static_pixel_ratio,
        edge_error: raw.edge_error,
        edge_preservation: raw.edge_preservation,
        edge_pixel_ratio: raw.edge_pixel_ratio,
        alpha_mean_absolute_error: alpha.metrics.mean_absolute_error,
        alpha_coverage_error: alpha.metrics.coverage_error,
        reference_loop_seam_oklab: raw.reference_loop_seam_oklab,
        output_loop_seam_oklab: raw.output_loop_seam_oklab,
        loop_seam_excess_oklab: raw.loop_seam_excess_oklab,
    })
}

/// GIF inspection can report an Alpha-capable transparent palette index even
/// when an opaque source never uses it. Native Alpha analysis is therefore a
/// source-content contract, not an output-container capability check.
fn requires_alpha_analysis(reference_has_alpha: bool, _output_has_alpha: bool) -> bool {
    reference_has_alpha
}

fn evaluate_vmaf(
    ffmpeg: &Path,
    reference: &Path,
    distorted: &Path,
    width: u32,
    height: u32,
    duration_seconds: f64,
    work_dir: &Path,
) -> Result<VmafSummary, String> {
    let log_name = "objective-vmaf.json";
    let log_path = work_dir.join(log_name);
    let graph = format!(
        "[0:v]trim=duration={duration_seconds:.6},fps={ANALYSIS_FPS}:round=near,scale={width}:{height}:flags=bicubic,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[dist];\
         [1:v]trim=duration={duration_seconds:.6},fps={ANALYSIS_FPS}:round=near,scale={width}:{height}:flags=bicubic,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[ref];\
         [dist][ref]libvmaf=log_fmt=json:log_path={log_name}:model='version=vmaf_v0.6.1neg':feature='name=psnr|name=float_ssim|name=float_ms_ssim|name=ciede|name=cambi\\:full_ref=true':n_subsample=1:shortest=1"
    );
    let null_output = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let output = Command::new(ffmpeg)
        .current_dir(work_dir)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .args(animation_demux_args(distorted))
        .arg("-i")
        .arg(distorted)
        .args(animation_demux_args(reference))
        .arg("-i")
        .arg(reference)
        .arg("-filter_complex")
        .arg(graph)
        .arg("-an")
        .arg("-f")
        .arg("null")
        .arg(null_output)
        .output_for_conversion_task()
        .map_err(|error| format!("Failed to start FFmpeg libvmaf: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "FFmpeg libvmaf failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let bytes = fs::read(&log_path)
        .map_err(|error| format!("Failed to read {}: {error}", log_path.display()))?;
    let log: VmafLog = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid libvmaf JSON {}: {error}", log_path.display()))?;
    if log.frames.is_empty() {
        return Err("libvmaf produced no frame metrics".to_string());
    }
    let values = |key: &str| -> Vec<f64> {
        log.frames
            .iter()
            .filter_map(|frame| {
                frame
                    .metrics
                    .get(key)
                    .copied()
                    .flatten()
                    .filter(|value| value.is_finite())
            })
            .collect()
    };
    let pool = |key: &str, frame_values: &[f64]| -> (Option<f64>, Option<f64>) {
        let pooled = log.pooled_metrics.get(key).copied();
        let minimum = pooled
            .and_then(|value| value.min)
            .filter(|metric| metric.is_finite())
            .or_else(|| frame_values.iter().copied().min_by(f64::total_cmp));
        let mean = pooled
            .and_then(|value| value.mean)
            .filter(|metric| metric.is_finite())
            .or_else(|| finite_mean(frame_values));
        (minimum, mean)
    };
    let required = |key: &str, frame_values: Vec<f64>| -> Result<Vec<f64>, String> {
        if frame_values.is_empty() {
            Err(format!("libvmaf produced no finite '{key}' frame metrics"))
        } else {
            Ok(frame_values)
        }
    };
    let frame_count = log.frames.len();
    let vmaf_values = required("vmaf", values("vmaf"))?;
    let ssim_values = required("float_ssim", values("float_ssim"))?;
    let ms_ssim_values = values("float_ms_ssim");
    let ciede_values = values("ciede2000");
    let cambi_values = required("cambi", values("cambi"))?;
    let vmaf = pool("vmaf", &vmaf_values);
    let ssim = pool("float_ssim", &ssim_values);
    let ms_ssim = pool("float_ms_ssim", &ms_ssim_values);
    let ciede = pool("ciede2000", &ciede_values);
    let cambi = pool("cambi", &cambi_values);
    Ok(VmafSummary {
        frame_count,
        vmaf_mean: vmaf
            .1
            .ok_or_else(|| "libvmaf VMAF mean is unavailable".to_string())?,
        vmaf_p05: percentile(vmaf_values, 0.05),
        vmaf_min: vmaf
            .0
            .ok_or_else(|| "libvmaf VMAF minimum is unavailable".to_string())?,
        psnr_y_mean: log
            .pooled_metrics
            .get("psnr_y")
            .and_then(|value| value.mean)
            .filter(|value| value.is_finite()),
        ssim_mean: ssim
            .1
            .ok_or_else(|| "libvmaf SSIM mean is unavailable".to_string())?,
        ssim_min: ssim
            .0
            .ok_or_else(|| "libvmaf SSIM minimum is unavailable".to_string())?,
        ms_ssim_mean: ms_ssim.1,
        ms_ssim_min: ms_ssim.0,
        ms_ssim_valid_ratio: valid_ratio(ms_ssim_values.len(), frame_count),
        ciede_mean: ciede.1,
        ciede_p95: (!ciede_values.is_empty()).then(|| percentile(ciede_values, 0.95)),
        ciede_valid_ratio: valid_ratio(
            log.frames
                .iter()
                .filter(|frame| {
                    frame
                        .metrics
                        .get("ciede2000")
                        .copied()
                        .flatten()
                        .is_some_and(f64::is_finite)
                })
                .count(),
            frame_count,
        ),
        cambi_mean: cambi
            .1
            .ok_or_else(|| "libvmaf CAMBI mean is unavailable".to_string())?,
        cambi_p95: percentile(cambi_values, 0.95),
        log_path,
    })
}

pub(crate) fn decode_rgba_frames(
    ffmpeg: &Path,
    input: &Path,
    width: u32,
    height: u32,
    duration_seconds: f64,
) -> Result<Vec<u8>, String> {
    decode_rgba_frames_with_prefix(ffmpeg, input, &[], None, width, height, duration_seconds)
}

pub(crate) fn decode_rgba_frames_with_prefix(
    ffmpeg: &Path,
    input: &Path,
    input_args: &[String],
    filter_prefix: Option<&str>,
    width: u32,
    height: u32,
    duration_seconds: f64,
) -> Result<Vec<u8>, String> {
    let decode_limit = rgba_decode_frame_limit(width, height, duration_seconds)?;
    let presentation_filter = format!(
        "trim=duration={duration_seconds:.6},fps={ANALYSIS_FPS}:round=near,scale={width}:{height}:flags=area,setsar=1,format=rgba"
    );
    let filter = filter_prefix
        .filter(|prefix| !prefix.trim().is_empty())
        .map_or(presentation_filter.clone(), |prefix| {
            format!("{prefix},{presentation_filter}")
        });
    let mut command = Command::new(ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .args(input_args);
    command.args(animation_demux_args(input));
    let output = command
        .arg("-i")
        .arg(input)
        .arg("-vf")
        .arg(filter)
        .arg("-an")
        .arg("-fps_mode")
        .arg("passthrough")
        .arg("-frames:v")
        .arg(decode_limit.to_string())
        .arg("-f")
        .arg("rawvideo")
        .arg("-pix_fmt")
        .arg("rgba")
        .arg("-")
        .output_for_conversion_task()
        .map_err(|error| {
            format!(
                "Failed to decode {} for quality metrics: {error}",
                input.display()
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "Failed to decode {} for quality metrics: {}",
            input.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let frame_bytes = frame_bytes(width, height)?;
    if output.stdout.len() % frame_bytes != 0 {
        return Err(format!(
            "Decoded RGBA buffer for {} is not frame-aligned",
            input.display()
        ));
    }
    let frame_count = output.stdout.len() / frame_bytes;
    if frame_count == 0 || frame_count >= decode_limit {
        return Err(format!(
            "Decoded RGBA frame count {frame_count} for {} is outside the bounded range 1..={} (64 MiB buffer limit)",
            input.display(), decode_limit - 1
        ));
    }
    Ok(output.stdout)
}

fn rgba_decode_frame_limit(width: u32, height: u32, duration: f64) -> Result<usize, String> {
    if width == 0 || height == 0 || !duration.is_finite() || duration <= 0.0 {
        return Err(
            "RGBA validation requires non-zero dimensions and a positive finite duration"
                .to_string(),
        );
    }
    let bytes = frame_bytes(width, height)?;
    // Reserve one sentinel frame: reaching the limit is an error, never a
    // silently truncated quality result. Do not infer length from duration;
    // an input/prefix can legitimately end before the requested trim window.
    let limit = (MAX_RGBA_BUFFER_BYTES / bytes).min(MAX_ANALYSIS_FRAMES + 1);
    if limit < 2 {
        return Err("RGBA validation dimensions exceed the 64 MiB buffer budget".to_string());
    }
    Ok(limit)
}

fn decode_alpha_frames(
    ffmpeg: &Path,
    input: &Path,
    width: u32,
    height: u32,
    duration_seconds: f64,
) -> Result<Vec<u8>, String> {
    let filter = format!(
        "trim=duration={duration_seconds:.6},fps={ANALYSIS_FPS}:round=near,scale={width}:{height}:flags=area,setsar=1,format=rgba,alphaextract,format=gray"
    );
    let mut command = Command::new(ffmpeg);
    command.arg("-hide_banner").arg("-loglevel").arg("error");
    command.args(animation_demux_args(input));
    let output = command
        .arg("-i")
        .arg(input)
        .arg("-vf")
        .arg(filter)
        .arg("-an")
        .arg("-fps_mode")
        .arg("passthrough")
        .arg("-f")
        .arg("rawvideo")
        .arg("-pix_fmt")
        .arg("gray")
        .arg("-")
        .output_for_conversion_task()
        .map_err(|error| {
            format!(
                "Failed to decode {} alpha plane for quality metrics: {error}",
                input.display()
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "Failed to decode {} alpha plane for quality metrics: {}",
            input.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let frame_bytes = alpha_frame_bytes(width, height)?;
    if output.stdout.len() % frame_bytes != 0 {
        return Err(format!(
            "Decoded alpha buffer for {} is not frame-aligned",
            input.display()
        ));
    }
    if output.stdout.len() as u64 > MAX_ALPHA_COMBINED_BUFFER_BYTES / 2 {
        return Err(format!(
            "Decoded alpha buffer for {} exceeds the {}-byte per-timeline limit",
            input.display(),
            MAX_ALPHA_COMBINED_BUFFER_BYTES / 2
        ));
    }
    let frame_count = output.stdout.len() / frame_bytes;
    if frame_count == 0 || frame_count > MAX_ANALYSIS_FRAMES {
        return Err(format!(
            "Decoded alpha frame count {frame_count} for {} is outside 1..={MAX_ANALYSIS_FRAMES}",
            input.display()
        ));
    }
    Ok(output.stdout)
}

fn compute_alpha_metrics(
    reference: &[u8],
    distorted: &[u8],
    width: u32,
    height: u32,
) -> Result<AlphaMetrics, String> {
    let frame_bytes = alpha_frame_bytes(width, height)?;
    if reference.len() != distorted.len()
        || reference.is_empty()
        || !reference.len().is_multiple_of(frame_bytes)
    {
        return Err(
            "Reference and distorted alpha buffers must contain aligned frames".to_string(),
        );
    }

    let mut absolute_error = 0.0;
    let mut coverage_mismatch = 0u64;
    for (&reference_alpha, &distorted_alpha) in reference.iter().zip(distorted) {
        absolute_error += (f64::from(reference_alpha) - f64::from(distorted_alpha)).abs() / 255.0;
        coverage_mismatch += u64::from((reference_alpha >= 128) != (distorted_alpha >= 128));
    }
    let sample_count = reference.len() as u64;
    Ok(AlphaMetrics {
        frame_count: reference.len() / frame_bytes,
        mean_absolute_error: safe_mean(absolute_error, sample_count),
        coverage_error: safe_mean(coverage_mismatch as f64, sample_count),
    })
}

fn objective_alpha_contract(
    uses_alpha: bool,
    main_sample_width: u32,
    main_sample_height: u32,
    main_frame_count: usize,
    native_alpha: Option<(u32, u32, AlphaMetrics)>,
) -> Result<ObjectiveAlphaContract, String> {
    if !uses_alpha {
        return Ok(ObjectiveAlphaContract {
            sample_width: main_sample_width,
            sample_height: main_sample_height,
            metrics: AlphaMetrics {
                frame_count: main_frame_count,
                ..AlphaMetrics::default()
            },
        });
    }

    let (sample_width, sample_height, metrics) = native_alpha
        .ok_or_else(|| "Alpha quality contract requires native alpha metrics".to_string())?;
    if metrics.frame_count != main_frame_count {
        return Err(format!(
            "Alpha metric frame count differs: alpha={}, raw/libvmaf={main_frame_count}",
            metrics.frame_count
        ));
    }
    Ok(ObjectiveAlphaContract {
        sample_width,
        sample_height,
        metrics,
    })
}

pub(crate) fn compute_raw_metrics(
    reference: &[u8],
    distorted: &[u8],
    width: u32,
    height: u32,
) -> Result<RawMetrics, String> {
    let frame_bytes = frame_bytes(width, height)?;
    if reference.len() != distorted.len()
        || reference.is_empty()
        || !reference.len().is_multiple_of(frame_bytes)
    {
        return Err("Reference and distorted RGBA buffers must contain aligned frames".to_string());
    }
    let frames = reference.len() / frame_bytes;
    let pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "Quality metric dimensions overflow usize".to_string())?;

    let mut spatial_error_sum = 0.0;
    let mut spatial_count = 0_u64;
    let mut static_error_sum = 0.0;
    let mut static_temporal_sum = 0.0;
    let mut static_count = 0_u64;
    let mut edge_error_sum = 0.0;
    let mut edge_count = 0_u64;

    for frame_index in 0..frames {
        let frame_offset = frame_index * frame_bytes;
        let reference_frame = &reference[frame_offset..frame_offset + frame_bytes];
        let distorted_frame = &distorted[frame_offset..frame_offset + frame_bytes];
        for pixel_index in 0..pixels {
            let offset = pixel_index * 4;
            let reference_rgba = rgba_at(reference_frame, offset);
            let distorted_rgba = rgba_at(distorted_frame, offset);
            let reference_rgb = composite_rgb(reference_rgba);
            let distorted_rgb = composite_rgb(distorted_rgba);
            spatial_error_sum += oklab_distance_srgb8(reference_rgb, distorted_rgb);
            spatial_count += 1;

            if frame_index > 0 {
                let previous_offset = (frame_index - 1) * frame_bytes + offset;
                let previous_reference = composite_rgb(rgba_at(reference, previous_offset));
                let previous_distorted = composite_rgb(rgba_at(distorted, previous_offset));
                let reference_delta = oklab_distance_srgb8(previous_reference, reference_rgb);
                if reference_delta <= STATIC_OKLAB_THRESHOLD {
                    let distorted_delta = oklab_distance_srgb8(previous_distorted, distorted_rgb);
                    static_error_sum += oklab_distance_srgb8(reference_rgb, distorted_rgb);
                    static_temporal_sum += (distorted_delta - reference_delta).abs();
                    static_count += 1;
                }
            }
        }

        let reference_luma = luma_plane(reference_frame, pixels);
        let distorted_luma = luma_plane(distorted_frame, pixels);
        if width >= 3 && height >= 3 {
            for y in 1..height as usize - 1 {
                for x in 1..width as usize - 1 {
                    let reference_edge = sobel(&reference_luma, width as usize, x, y);
                    if reference_edge < EDGE_THRESHOLD {
                        continue;
                    }
                    let distorted_edge = sobel(&distorted_luma, width as usize, x, y);
                    edge_error_sum += ((distorted_edge - reference_edge).abs()
                        / reference_edge.max(EDGE_THRESHOLD))
                    .min(1.0);
                    edge_count += 1;
                }
            }
        }
    }

    let reference_loop_seam = loop_seam_error(reference, frame_bytes, pixels);
    let distorted_loop_seam = loop_seam_error(distorted, frame_bytes, pixels);
    let possible_static = frames.saturating_sub(1).saturating_mul(pixels) as f64;
    let possible_edges = frames
        .saturating_mul((width as usize).saturating_sub(2))
        .saturating_mul((height as usize).saturating_sub(2)) as f64;
    let edge_error = safe_mean(edge_error_sum, edge_count);
    Ok(RawMetrics {
        mean_oklab_error: safe_mean(spatial_error_sum, spatial_count),
        static_region_oklab_error: safe_mean(static_error_sum, static_count),
        static_region_temporal_residual: safe_mean(static_temporal_sum, static_count),
        static_pixel_ratio: if possible_static > 0.0 {
            static_count as f64 / possible_static
        } else {
            1.0
        },
        edge_error,
        edge_preservation: 1.0 - edge_error,
        edge_pixel_ratio: if possible_edges > 0.0 {
            edge_count as f64 / possible_edges
        } else {
            0.0
        },
        reference_loop_seam_oklab: reference_loop_seam,
        output_loop_seam_oklab: distorted_loop_seam,
        loop_seam_excess_oklab: (distorted_loop_seam - reference_loop_seam).max(0.0),
    })
}

fn frame_bytes(width: u32, height: u32) -> Result<usize, String> {
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Quality metric frame size overflowed usize".to_string())
}

fn alpha_frame_bytes(width: u32, height: u32) -> Result<usize, String> {
    if width == 0 || height == 0 {
        return Err("Alpha quality metric dimensions must be non-zero".to_string());
    }
    (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "Alpha quality metric frame size overflowed usize".to_string())
}

fn alpha_analysis_dimensions(width: u32, height: u32) -> Result<(u32, u32), String> {
    if width == 0 || height == 0 {
        return Err("Alpha quality requires non-zero output dimensions".to_string());
    }
    if width <= ALPHA_ANALYSIS_MAX_WIDTH {
        return Ok((width, height));
    }
    let scaled_height = u64::from(height)
        .checked_mul(u64::from(ALPHA_ANALYSIS_MAX_WIDTH))
        .and_then(|value| value.checked_add(u64::from(width) / 2))
        .map(|value| value / u64::from(width))
        .ok_or_else(|| "Alpha analysis dimensions overflowed u64".to_string())?
        .max(1);
    let scaled_height = u32::try_from(scaled_height)
        .map_err(|_| "Alpha analysis height overflowed u32".to_string())?;
    Ok((ALPHA_ANALYSIS_MAX_WIDTH, scaled_height))
}

fn validate_alpha_memory_budget(
    width: u32,
    height: u32,
    duration_seconds: f64,
) -> Result<(), String> {
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err("Alpha quality requires a positive finite duration".to_string());
    }
    let estimated_frames = (duration_seconds * f64::from(ANALYSIS_FPS)).ceil().max(1.0);
    if estimated_frames > MAX_ANALYSIS_FRAMES as f64 {
        return Err(format!(
            "Alpha quality estimated frame count {:.0} exceeds {MAX_ANALYSIS_FRAMES}",
            estimated_frames
        ));
    }
    let estimated_frames = estimated_frames as u64;
    let combined_bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(estimated_frames))
        .and_then(|timeline| timeline.checked_mul(2))
        .ok_or_else(|| "Alpha quality memory estimate overflowed u64".to_string())?;
    if combined_bytes > MAX_ALPHA_COMBINED_BUFFER_BYTES {
        return Err(format!(
            "Alpha quality requires an estimated {combined_bytes} bytes, above the {MAX_ALPHA_COMBINED_BUFFER_BYTES}-byte combined buffer limit"
        ));
    }
    Ok(())
}

pub(crate) fn analysis_dimensions(width: u32, height: u32) -> Result<(u32, u32), String> {
    scaled_even_dimensions(ANALYSIS_MAX_EDGE, width, height)
}

/// Fit the long edge, retaining portrait geometry and the existing pixel budget.
/// Round the short edge to an even size for libvmaf's YUV420 presentation proxy.
fn scaled_even_dimensions(
    max_edge: u32,
    source_width: u32,
    source_height: u32,
) -> Result<(u32, u32), String> {
    if source_width == 0 || source_height == 0 || max_edge < 2 {
        return Err(
            "Quality proxy dimensions must be non-zero with a limit of at least 2".to_string(),
        );
    }
    let limit = max_edge - max_edge % 2;
    let source_long_edge = f64::from(source_width.max(source_height));
    let scale = |side| {
        let scaled = (f64::from(limit) * f64::from(side) / source_long_edge)
            .round()
            .clamp(2.0, f64::from(limit)) as u32;
        (scaled + scaled % 2).min(limit)
    };
    Ok((scale(source_width), scale(source_height)))
}

fn rgba_at(buffer: &[u8], offset: usize) -> [u8; 4] {
    [
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]
}

fn composite_rgb(rgba: [u8; 4]) -> [u8; 3] {
    const BACKGROUND: [u8; 3] = [246, 243, 235];
    let alpha = f64::from(rgba[3]) / 255.0;
    let mix = |channel: usize| {
        (f64::from(rgba[channel]) * alpha + f64::from(BACKGROUND[channel]) * (1.0 - alpha))
            .round()
            .clamp(0.0, 255.0) as u8
    };
    [mix(0), mix(1), mix(2)]
}

fn luma_plane(frame: &[u8], pixels: usize) -> Vec<f64> {
    (0..pixels)
        .map(|pixel| {
            let rgb = composite_rgb(rgba_at(frame, pixel * 4));
            (0.2126 * f64::from(rgb[0]) + 0.7152 * f64::from(rgb[1]) + 0.0722 * f64::from(rgb[2]))
                / 255.0
        })
        .collect()
}

fn sobel(luma: &[f64], width: usize, x: usize, y: usize) -> f64 {
    let at = |dx: isize, dy: isize| {
        let index = (y as isize + dy) as usize * width + (x as isize + dx) as usize;
        luma[index]
    };
    let gx = -at(-1, -1) + at(1, -1) - 2.0 * at(-1, 0) + 2.0 * at(1, 0) - at(-1, 1) + at(1, 1);
    let gy = -at(-1, -1) - 2.0 * at(0, -1) - at(1, -1) + at(-1, 1) + 2.0 * at(0, 1) + at(1, 1);
    gx.hypot(gy) / 4.0
}

fn loop_seam_error(frames: &[u8], frame_bytes: usize, pixels: usize) -> f64 {
    let frame_count = frames.len() / frame_bytes;
    if frame_count < 2 {
        return 0.0;
    }
    let last_offset = (frame_count - 1) * frame_bytes;
    let mut sum = 0.0;
    for pixel in 0..pixels {
        let first = composite_rgb(rgba_at(frames, pixel * 4));
        let last = composite_rgb(rgba_at(frames, last_offset + pixel * 4));
        sum += oklab_distance_srgb8(first, last);
    }
    sum / pixels as f64
}

fn percentile(mut values: Vec<f64>, quantile: f64) -> f64 {
    values.retain(|value| value.is_finite());
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    let index = ((values.len() - 1) as f64 * quantile.clamp(0.0, 1.0)).round() as usize;
    values[index]
}

fn finite_mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn valid_ratio(valid: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        valid as f64 / total as f64
    }
}

fn safe_mean(sum: f64, count: u64) -> f64 {
    if count == 0 {
        0.0
    } else {
        sum / count as f64
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn rgba_decode_budget_reserves_a_sentinel_and_rejects_invalid_geometry() {
        assert_eq!(super::rgba_decode_frame_limit(96, 96, 30.0), Ok(901));
        assert_eq!(super::rgba_decode_frame_limit(1024, 1024, 0.1), Ok(16));
        assert!(super::rgba_decode_frame_limit(0, 96, 1.0).is_err());
        assert!(super::rgba_decode_frame_limit(u32::MAX, u32::MAX, 1.0).is_err());
        assert!(super::rgba_decode_frame_limit(4096, 4096, 1.0).is_err());
        for duration in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(super::rgba_decode_frame_limit(96, 96, duration).is_err());
        }
    }

    #[test]
    fn rgba_preflight_fails_before_starting_an_executable() {
        let error = super::decode_rgba_frames(
            std::path::Path::new("missing-ffmpeg"),
            std::path::Path::new("missing-input"),
            0,
            96,
            1.0,
        )
        .unwrap_err();
        assert!(error.contains("non-zero dimensions"));
    }
    use super::*;

    fn solid_frames(color: [u8; 4], width: u32, height: u32, frames: usize) -> Vec<u8> {
        let mut output = Vec::new();
        for _ in 0..frames {
            for _ in 0..width * height {
                output.extend_from_slice(&color);
            }
        }
        output
    }

    #[test]
    fn identical_rgba_timelines_have_perfect_custom_metrics() {
        let frames = solid_frames([90, 140, 120, 255], 4, 4, 3);
        let metrics = compute_raw_metrics(&frames, &frames, 4, 4).expect("metrics");
        assert_eq!(metrics.mean_oklab_error, 0.0);
        assert_eq!(metrics.static_region_temporal_residual, 0.0);
        assert_eq!(metrics.edge_preservation, 1.0);
        assert_eq!(metrics.loop_seam_excess_oklab, 0.0);
    }

    #[test]
    fn static_reference_detects_output_flicker() {
        let reference = solid_frames([90, 140, 120, 64], 4, 4, 3);
        let mut distorted = reference.clone();
        let frame_bytes = frame_bytes(4, 4).expect("frame size");
        for pixel in 0..16 {
            let offset = frame_bytes + pixel * 4;
            distorted[offset] = 220;
            distorted[offset + 3] = 255;
        }
        let metrics = compute_raw_metrics(&reference, &distorted, 4, 4).expect("metrics");
        assert!(metrics.static_region_temporal_residual > 0.01);
        assert!(metrics.static_region_oklab_error > 0.01);
    }

    #[test]
    fn identical_native_binary_masks_have_zero_alpha_coverage_error() {
        let mask = vec![0, 255, 0, 255, 255, 0, 255, 0, 255, 0, 0, 255];
        let metrics = compute_alpha_metrics(&mask, &mask, 3, 2).expect("alpha metrics");

        assert_eq!(metrics.frame_count, 2);
        assert_eq!(metrics.mean_absolute_error, 0.0);
        assert_eq!(metrics.coverage_error, 0.0);
    }

    #[test]
    fn alpha_coverage_uses_the_128_threshold() {
        let reference = [127, 128, 0, 255];
        let distorted = [128, 127, 0, 255];
        let metrics = compute_alpha_metrics(&reference, &distorted, 2, 2).expect("alpha metrics");

        assert_eq!(metrics.frame_count, 1);
        assert_eq!(metrics.coverage_error, 0.5);
        assert!((metrics.mean_absolute_error - 2.0 / (4.0 * 255.0)).abs() < f64::EPSILON);
    }

    #[test]
    fn alpha_metrics_reject_misaligned_dimensions_and_frame_counts() {
        assert!(compute_alpha_metrics(&[0, 0, 0], &[0, 0, 0], 2, 2).is_err());
        assert!(compute_alpha_metrics(&[0; 4], &[0; 8], 2, 2).is_err());
        assert!(compute_alpha_metrics(&[0], &[0], 0, 1).is_err());

        let mismatched_timeline = AlphaMetrics {
            frame_count: 1,
            mean_absolute_error: 0.0,
            coverage_error: 0.0,
        };
        assert!(objective_alpha_contract(
            true,
            ANALYSIS_MAX_EDGE,
            54,
            2,
            Some((320, 180, mismatched_timeline)),
        )
        .is_err());
    }

    #[test]
    fn alpha_analysis_preserves_native_size_until_the_480_width_cap() {
        assert_eq!(alpha_analysis_dimensions(320, 181), Ok((320, 181)));
        assert_eq!(alpha_analysis_dimensions(480, 271), Ok((480, 271)));
        assert_eq!(alpha_analysis_dimensions(960, 540), Ok((480, 270)));
        assert_eq!(alpha_analysis_dimensions(1080, 1920), Ok((480, 853)));
        assert!(alpha_analysis_dimensions(0, 180).is_err());

        assert!(validate_alpha_memory_budget(480, 270, 3.0).is_ok());
        assert!(validate_alpha_memory_budget(480, 4096, 30.0).is_err());
    }

    #[test]
    fn output_alpha_capability_does_not_trigger_native_analysis_for_an_opaque_source() {
        assert!(!requires_alpha_analysis(false, true));
        assert!(!requires_alpha_analysis(false, false));
        assert!(requires_alpha_analysis(true, false));
        assert!(requires_alpha_analysis(true, true));
    }

    #[test]
    fn native_alpha_contract_is_not_overwritten_by_the_96px_proxy() {
        let proxy_reference = vec![0; 4];
        let proxy_distorted = vec![255; 4];
        let proxy = compute_alpha_metrics(&proxy_reference, &proxy_distorted, 2, 2)
            .expect("proxy alpha metrics");
        assert_eq!(proxy.coverage_error, 1.0);

        let native_mask = [0, 255, 255, 0];
        let native =
            compute_alpha_metrics(&native_mask, &native_mask, 4, 1).expect("native metrics");
        let contract =
            objective_alpha_contract(true, ANALYSIS_MAX_EDGE, 54, 1, Some((4, 1, native)))
                .expect("native alpha contract");

        assert_eq!((contract.sample_width, contract.sample_height), (4, 1));
        assert_eq!(contract.metrics.mean_absolute_error, 0.0);
        assert_eq!(contract.metrics.coverage_error, 0.0);

        let opaque = objective_alpha_contract(false, ANALYSIS_MAX_EDGE, 54, 90, None)
            .expect("opaque alpha contract");
        assert_eq!(
            (opaque.sample_width, opaque.sample_height),
            (ANALYSIS_MAX_EDGE, 54)
        );
        assert_eq!(opaque.metrics.frame_count, 90);
        assert_eq!(opaque.metrics.coverage_error, 0.0);
    }

    #[test]
    fn percentile_uses_sorted_nearest_rank() {
        assert_eq!(percentile(vec![5.0, 1.0, 4.0, 2.0, 3.0], 0.0), 1.0);
        assert_eq!(percentile(vec![5.0, 1.0, 4.0, 2.0, 3.0], 0.5), 3.0);
        assert_eq!(percentile(vec![5.0, 1.0, 4.0, 2.0, 3.0], 1.0), 5.0);
    }

    #[test]
    fn optional_metric_helpers_do_not_invent_missing_values() {
        assert_eq!(finite_mean(&[]), None);
        assert_eq!(finite_mean(&[0.25, 0.75]), Some(0.5));
        assert_eq!(valid_ratio(0, 90), 0.0);
        assert_eq!(valid_ratio(45, 90), 0.5);
    }

    #[test]
    fn quality_proxies_preserve_landscape_portrait_and_square_geometry() {
        for (width, height, analysis, presentation) in [
            (1920, 1080, (96, 54), (320, 180)),
            (1080, 1920, (54, 96), (180, 320)),
            (320, 240, (96, 72), (320, 240)),
            (240, 320, (72, 96), (240, 320)),
            (1080, 1080, (96, 96), (320, 320)),
            (104, 59, (96, 54), (320, 182)),
            (59, 104, (54, 96), (182, 320)),
        ] {
            assert_eq!(analysis_dimensions(width, height).unwrap(), analysis);
            assert_eq!(
                scaled_even_dimensions(320, width, height).unwrap(),
                presentation
            );
        }
    }

    #[test]
    fn quality_proxies_bound_extreme_aspects_and_reject_empty_dimensions() {
        for (width, height) in [(1, u32::MAX), (u32::MAX, 1), (u32::MAX, u32::MAX)] {
            let (w, h) = analysis_dimensions(width, height).unwrap();
            assert!((2..=96).contains(&w) && (2..=96).contains(&h));
            assert!(w.is_multiple_of(2) && h.is_multiple_of(2));
            assert!(w * h <= 96 * 96);
        }
        assert!(analysis_dimensions(0, 1080).is_err());
        assert!(analysis_dimensions(1080, 0).is_err());
    }
}
