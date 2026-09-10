use crate::commands::ConversionCommandExt;
use std::{path::Path, process::Command};

use super::AppError;

const SAMPLE_SIDE: usize = 64;
const SAMPLE_BYTES: usize = SAMPLE_SIDE * SAMPLE_SIDE;
const SAMPLE_FPS: u32 = 4;
const MAX_SAMPLES: usize = 48;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuickContentProbe {
    pub sampled_frames: usize,
    pub mean_frame_delta: f64,
    pub median_frame_delta: f64,
    pub static_frame_ratio: f64,
    pub scene_cut_ratio: f64,
    pub scene_cut_times: Vec<f64>,
    pub mean_changed_area: f64,
    /// Fraction of interior samples that form a low-curvature grayscale ramp.
    pub mean_smooth_gradient_ratio: f64,
    /// Fraction of interior samples with a strong two-pixel spatial gradient.
    pub mean_spatial_edge_ratio: f64,
    /// Mean normalized five-tap Laplacian magnitude.
    pub mean_spatial_noise: f64,
}

impl QuickContentProbe {
    pub fn fallback() -> Self {
        Self {
            sampled_frames: 0,
            mean_frame_delta: 0.08,
            median_frame_delta: 0.08,
            static_frame_ratio: 0.25,
            scene_cut_ratio: 0.0,
            scene_cut_times: Vec::new(),
            mean_changed_area: 0.50,
            mean_smooth_gradient_ratio: 0.0,
            mean_spatial_edge_ratio: 0.10,
            mean_spatial_noise: 0.10,
        }
    }
}

pub fn probe_content(
    ffmpeg: &Path,
    input: &Path,
    source_args: &[String],
) -> Result<QuickContentProbe, AppError> {
    let filter = format!(
        "fps={SAMPLE_FPS},scale={SAMPLE_SIDE}:{SAMPLE_SIDE}:force_original_aspect_ratio=decrease:flags=bilinear,pad={SAMPLE_SIDE}:{SAMPLE_SIDE}:(ow-iw)/2:(oh-ih)/2:color=black,format=gray"
    );
    let output = Command::new(ffmpeg)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .args(source_args)
        .arg("-i")
        .arg(input)
        .arg("-an")
        .arg("-sn")
        .arg("-vf")
        .arg(filter)
        .arg("-frames:v")
        .arg(MAX_SAMPLES.to_string())
        .arg("-pix_fmt")
        .arg("gray")
        .arg("-f")
        .arg("rawvideo")
        .arg("pipe:1")
        .output_for_conversion_task()
        .map_err(|error| AppError::DecodeFailed(error.to_string()))?;

    if !output.status.success() {
        return Err(AppError::DecodeFailed(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    Ok(analyze_grayscale_samples(&output.stdout))
}

pub fn analyze_grayscale_samples(bytes: &[u8]) -> QuickContentProbe {
    let frames: Vec<&[u8]> = bytes.chunks_exact(SAMPLE_BYTES).take(MAX_SAMPLES).collect();
    if frames.len() < 2 {
        return QuickContentProbe {
            sampled_frames: frames.len(),
            ..QuickContentProbe::fallback()
        };
    }

    let mut deltas = Vec::with_capacity(frames.len() - 1);
    let mut changed_areas = Vec::with_capacity(frames.len() - 1);
    let mut static_frames = 0usize;
    let mut scene_cuts = 0usize;
    let mut scene_cut_times = Vec::new();
    let mut smooth_gradient_samples = 0_u64;
    let mut spatial_edge_samples = 0_u64;
    let mut spatial_laplacian_sum = 0_u64;

    for frame in &frames {
        for y in 1..SAMPLE_SIDE - 1 {
            for x in 1..SAMPLE_SIDE - 1 {
                let index = y * SAMPLE_SIDE + x;
                let center = i32::from(frame[index]);
                let left = i32::from(frame[index - 1]);
                let right = i32::from(frame[index + 1]);
                let up = i32::from(frame[index - SAMPLE_SIDE]);
                let down = i32::from(frame[index + SAMPLE_SIDE]);
                let gradient = ((right - left).abs() + (down - up).abs()) / 2;
                let laplacian = (4 * center - left - right - up - down).abs();
                if (4..=48).contains(&gradient) && laplacian <= 16 {
                    smooth_gradient_samples += 1;
                }
                if gradient >= 64 {
                    spatial_edge_samples += 1;
                }
                spatial_laplacian_sum += u64::try_from(laplacian).unwrap_or(u64::MAX);
            }
        }
    }

    for (transition_index, pair) in frames.windows(2).enumerate() {
        let previous = pair[0];
        let current = pair[1];
        let mut delta_sum = 0u64;
        let mut changed = 0usize;
        let mut min_x = SAMPLE_SIDE;
        let mut min_y = SAMPLE_SIDE;
        let mut max_x = 0usize;
        let mut max_y = 0usize;

        for (index, (left, right)) in previous.iter().zip(current.iter()).enumerate() {
            let delta = left.abs_diff(*right);
            delta_sum += u64::from(delta);
            if delta >= 12 {
                changed += 1;
                let x = index % SAMPLE_SIDE;
                let y = index / SAMPLE_SIDE;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }

        let mean_delta = delta_sum as f64 / (SAMPLE_BYTES as f64 * 255.0);
        let changed_ratio = changed as f64 / SAMPLE_BYTES as f64;
        let changed_area = if changed == 0 {
            0.0
        } else {
            ((max_x - min_x + 1) * (max_y - min_y + 1)) as f64 / SAMPLE_BYTES as f64
        };
        if mean_delta < 0.012 && changed_ratio < 0.08 {
            static_frames += 1;
        }
        if mean_delta > 0.18 && changed_ratio > 0.65 {
            scene_cuts += 1;
            scene_cut_times.push((transition_index + 1) as f64 / f64::from(SAMPLE_FPS));
        }
        deltas.push(mean_delta);
        changed_areas.push(changed_area);
    }

    let transitions = deltas.len().max(1) as f64;
    let mean_frame_delta = deltas.iter().sum::<f64>() / transitions;
    let mean_changed_area = changed_areas.iter().sum::<f64>() / transitions;
    deltas.sort_by(f64::total_cmp);
    let median_frame_delta = deltas[deltas.len() / 2];
    let spatial_sample_count = frames
        .len()
        .saturating_mul((SAMPLE_SIDE - 2).saturating_mul(SAMPLE_SIDE - 2))
        .max(1) as f64;

    QuickContentProbe {
        sampled_frames: frames.len(),
        mean_frame_delta,
        median_frame_delta,
        static_frame_ratio: static_frames as f64 / transitions,
        scene_cut_ratio: scene_cuts as f64 / transitions,
        scene_cut_times,
        mean_changed_area,
        mean_smooth_gradient_ratio: smooth_gradient_samples as f64 / spatial_sample_count,
        mean_spatial_edge_ratio: spatial_edge_samples as f64 / spatial_sample_count,
        mean_spatial_noise: spatial_laplacian_sum as f64 / (spatial_sample_count * 255.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(value: u8) -> Vec<u8> {
        vec![value; SAMPLE_BYTES]
    }

    #[test]
    fn repeated_frames_are_classified_as_static() {
        let bytes = [frame(30), frame(30), frame(30)].concat();
        let result = analyze_grayscale_samples(&bytes);
        assert_eq!(result.sampled_frames, 3);
        assert_eq!(result.static_frame_ratio, 1.0);
        assert_eq!(result.scene_cut_ratio, 0.0);
    }

    #[test]
    fn full_frame_jump_is_classified_as_scene_cut() {
        let bytes = [frame(0), frame(255), frame(0)].concat();
        let result = analyze_grayscale_samples(&bytes);
        assert_eq!(result.scene_cut_ratio, 1.0);
        assert_eq!(result.scene_cut_times, vec![0.25, 0.5]);
        assert!(result.mean_changed_area > 0.99);
    }

    #[test]
    fn small_moving_region_has_small_changed_area() {
        let first = frame(0);
        let mut second = frame(0);
        for y in 20..28 {
            for x in 20..28 {
                second[y * SAMPLE_SIDE + x] = 255;
            }
        }
        let result = analyze_grayscale_samples(&[first, second].concat());
        assert!(result.mean_changed_area < 0.03);
        assert_eq!(result.scene_cut_ratio, 0.0);
    }

    #[test]
    fn smooth_ramp_has_high_gradient_signal_without_edge_or_noise_signal() {
        let ramp = (0..SAMPLE_SIDE)
            .flat_map(|_| (0..SAMPLE_SIDE).map(|x| u8::try_from(x * 4).unwrap()))
            .collect::<Vec<_>>();
        let result = analyze_grayscale_samples(&[ramp.clone(), ramp].concat());

        assert!(result.mean_smooth_gradient_ratio > 0.95, "{result:?}");
        assert!(result.mean_spatial_edge_ratio < 0.01, "{result:?}");
        assert!(result.mean_spatial_noise < 0.001, "{result:?}");
    }

    #[test]
    fn checkerboard_has_edge_and_noise_signals_instead_of_a_smooth_ramp() {
        let checkerboard = (0..SAMPLE_SIDE * SAMPLE_SIDE)
            .map(|index| {
                let x = index % SAMPLE_SIDE;
                let y = index / SAMPLE_SIDE;
                if (x / 4 + y / 4).is_multiple_of(2) {
                    0
                } else {
                    255
                }
            })
            .collect::<Vec<_>>();
        let result = analyze_grayscale_samples(&[checkerboard.clone(), checkerboard].concat());

        assert!(result.mean_smooth_gradient_ratio < 0.05, "{result:?}");
        assert!(result.mean_spatial_edge_ratio > 0.20, "{result:?}");
        assert!(result.mean_spatial_noise > 0.20, "{result:?}");
    }
}
