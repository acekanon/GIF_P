//! Conservative, bounded admission gate for palette/index compression candidates.
//!
//! This is an engineering regression screen, not a proof of perceptual losslessness.
//! A GIF-only reference can establish a small perturbation of the already quantized
//! display; it cannot establish improved fidelity to the original video. Source RGB
//! must contain the exact same displayed samples, in the exact same order. Timing,
//! repeat semantics and decoder agreement remain the production adapter's contract.
//! No image-sized allocation is made here, and every image row checks cancellation.

use super::palette::oklab_distance_srgb8;
use serde::Serialize;

const MAX_PIXELS_PER_FRAME: usize = 4 * 1024 * 1024;
const MAX_TOTAL_PIXELS: usize = 64 * 1024 * 1024;
const MAX_FRAMES: usize = 240;
const MAX_CHANNEL_CHANGE: u8 = 2;

pub(crate) struct QualityInput<'a> {
    pub width: usize,
    pub height: usize,
    pub baseline_rgba: &'a [Vec<u8>],
    pub candidate_rgba: &'a [Vec<u8>],
    /// Contiguous RGB24 samples aligned with the displayed GIF frames; never an
    /// arbitrary constant-rate decode or an RGB conversion of the baseline GIF.
    pub source_rgb: Option<&'a [u8]>,
    pub delays_cs: &'a [u16],
    pub looping: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct QualityMetrics {
    pub mean_oklab_error: f64,
    pub edge_weighted_mean_oklab_error: f64,
    /// Mean absolute sRGB channel error, in 0..255 channel units.
    pub mean_abs_rgb_error: f64,
    /// Mean absolute RGB bias of nonoverlapping 4x4 and 16x16 blocks.
    pub low_frequency_rgb_error: f64,
    pub max_low_frequency_rgb_error: f64,
    /// Adjacent low-contrast plateaus separated by a step, normalized by 255.
    /// This is a deterministic banding-risk proxy, not a perceptual banding score.
    pub plateau_banding_score: f64,
    /// Source mode: absolute temporal-delta residual in source-static regions.
    /// GIF mode: only excess fluctuation above the frozen baseline's fluctuation.
    pub static_temporal_residual: f64,
    pub max_static_block_residual: f64,
    pub loop_seam_residual: Option<f64>,
    pub loop_seam_max_block_residual: Option<f64>,
    pub weighted_visible_samples: u64,
    pub weighted_static_samples: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct PixelEnvelope {
    pub max_channel_change: u8,
    pub worst_frame_rmse: f64,
    pub alpha_exact: bool,
    pub strong_edges_exact: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct QualityGateReport {
    pub gate_id: &'static str,
    pub reference_kind: &'static str,
    pub accepted: bool,
    pub reasons: Vec<String>,
    pub envelope: PixelEnvelope,
    pub baseline: QualityMetrics,
    pub candidate: QualityMetrics,
}

/// Delays weight visible error and transitions; a zero GIF delay uses one
/// centisecond for metric weighting only. It does not alter the exported delay.
pub(crate) fn evaluate_quality_gate(
    input: QualityInput<'_>,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<QualityGateReport, String> {
    checkpoint()?;
    validate(&input)?;
    let envelope = measure_envelope(&input, checkpoint)?;
    let baseline = measure(&input, input.baseline_rgba, checkpoint)?;
    let candidate = measure(&input, input.candidate_rgba, checkpoint)?;
    let mut reasons = Vec::new();
    if !envelope.alpha_exact {
        reasons.push("alpha changed".into());
    }
    if !envelope.strong_edges_exact {
        reasons.push("strong edge changed".into());
    }
    if envelope.max_channel_change > MAX_CHANNEL_CHANGE {
        reasons.push("channel change exceeds 2/255".into());
    }
    if envelope.worst_frame_rmse > 1.25 {
        reasons.push("frame RGB RMSE exceeds 1.25/255".into());
    }

    // Versioned tolerances, fixed before candidate search. Source-reference
    // tolerances follow the existing research gate's 1-3% regression limits;
    // absolute floors prevent floating-point noise from rejecting identical data.
    // GIF-reference allowances describe a bounded perturbation, not source quality.
    let source = input.source_rgb.is_some();
    let color_floor = if source { 0.0002 } else { 0.0015 };
    let edge_floor = if source { 0.0001 } else { 0.0010 };
    for (name, a, b, relative, absolute) in [
        (
            "mean color",
            candidate.mean_oklab_error,
            baseline.mean_oklab_error,
            1.03,
            color_floor,
        ),
        (
            "edge color",
            candidate.edge_weighted_mean_oklab_error,
            baseline.edge_weighted_mean_oklab_error,
            1.01,
            edge_floor,
        ),
        (
            "mean RGB",
            candidate.mean_abs_rgb_error,
            baseline.mean_abs_rgb_error,
            1.03,
            if source { 0.05 } else { 0.55 },
        ),
        (
            "low-frequency bias",
            candidate.low_frequency_rgb_error,
            baseline.low_frequency_rgb_error,
            1.01,
            if source { 0.05 } else { 0.25 },
        ),
        (
            "local low-frequency bias",
            candidate.max_low_frequency_rgb_error,
            baseline.max_low_frequency_rgb_error,
            1.01,
            if source { 0.10 } else { 0.75 },
        ),
        (
            "plateau banding",
            candidate.plateau_banding_score,
            baseline.plateau_banding_score,
            1.01,
            0.00001,
        ),
        (
            "static temporal fluctuation",
            candidate.static_temporal_residual,
            baseline.static_temporal_residual,
            1.01,
            0.025,
        ),
        (
            "local static temporal fluctuation",
            candidate.max_static_block_residual,
            baseline.max_static_block_residual,
            1.01,
            0.10,
        ),
    ] {
        if !a.is_finite() || !b.is_finite() || a > b * relative + absolute {
            reasons.push(format!("{name} regression"));
        }
    }
    match (candidate.loop_seam_residual, baseline.loop_seam_residual) {
        (Some(a), Some(b)) if !a.is_finite() || !b.is_finite() || a > b * 1.01 + 0.025 => {
            reasons.push("loop seam regression".into());
        }
        (None, Some(_)) => reasons.push("missing loop seam metric".into()),
        _ => {}
    }
    if let (Some(a), Some(b)) = (
        candidate.loop_seam_max_block_residual,
        baseline.loop_seam_max_block_residual,
    ) {
        if !a.is_finite() || !b.is_finite() || a > b * 1.01 + 0.10 {
            reasons.push("local loop seam regression".into());
        }
    }
    checkpoint()?;
    Ok(QualityGateReport {
        gate_id: "bounded_rgba_color_plateau_temporal_v1",
        reference_kind: if source {
            "aligned_source_rgb"
        } else {
            "frozen_gif_display"
        },
        accepted: reasons.is_empty(),
        reasons,
        envelope,
        baseline,
        candidate,
    })
}

fn validate(input: &QualityInput<'_>) -> Result<(), String> {
    let pixels = input
        .width
        .checked_mul(input.height)
        .ok_or("quality geometry overflow")?;
    let count = input.baseline_rgba.len();
    let total = pixels
        .checked_mul(count)
        .ok_or("quality timeline overflow")?;
    if pixels == 0
        || pixels > MAX_PIXELS_PER_FRAME
        || count == 0
        || count > MAX_FRAMES
        || total > MAX_TOTAL_PIXELS
    {
        return Err("quality geometry/frame budget exceeded".into());
    }
    if input.candidate_rgba.len() != count || input.delays_cs.len() != count {
        return Err("quality frame count or delay count mismatch".into());
    }
    if input
        .baseline_rgba
        .iter()
        .chain(input.candidate_rgba)
        .any(|frame| frame.len() != pixels * 4)
    {
        return Err("quality RGBA frame size mismatch".into());
    }
    if input.source_rgb.is_some_and(|rgb| rgb.len() != total * 3) {
        return Err("quality source RGB sample alignment/size mismatch".into());
    }
    Ok(())
}

fn rgb(frame: &[u8], p: usize) -> [u8; 3] {
    [frame[p * 4], frame[p * 4 + 1], frame[p * 4 + 2]]
}

fn reference(input: &QualityInput<'_>, n: usize, p: usize) -> [u8; 3] {
    if let Some(source) = input.source_rgb {
        let start = (n * input.width * input.height + p) * 3;
        [source[start], source[start + 1], source[start + 2]]
    } else {
        rgb(&input.baseline_rgba[n], p)
    }
}

fn delta(a: [u8; 3], b: [u8; 3]) -> u8 {
    (0..3).map(|c| a[c].abs_diff(b[c])).max().unwrap_or(0)
}

fn luma(a: [u8; 3]) -> f64 {
    0.2126 * f64::from(a[0]) + 0.7152 * f64::from(a[1]) + 0.0722 * f64::from(a[2])
}

fn neighbors(p: usize, w: usize, h: usize) -> [Option<usize>; 4] {
    [
        p.checked_sub(1).filter(|_| !p.is_multiple_of(w)),
        (p % w + 1 < w).then_some(p + 1),
        p.checked_sub(w),
        (p / w + 1 < h).then_some(p + w),
    ]
}

fn measure_envelope(
    input: &QualityInput<'_>,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<PixelEnvelope, String> {
    let mut result = PixelEnvelope {
        alpha_exact: true,
        strong_edges_exact: true,
        ..Default::default()
    };
    for (a, b) in input.baseline_rgba.iter().zip(input.candidate_rgba) {
        let (mut squares, mut visible) = (0_u64, 0_u64);
        for y in 0..input.height {
            checkpoint()?;
            for x in 0..input.width {
                let p = y * input.width + x;
                result.alpha_exact &= a[p * 4 + 3] == b[p * 4 + 3];
                if a[p * 4 + 3] == 0 {
                    continue;
                }
                visible += 1;
                let difference = delta(rgb(a, p), rgb(b, p));
                result.max_channel_change = result.max_channel_change.max(difference);
                squares += (0..3)
                    .map(|c| u64::from(a[p * 4 + c].abs_diff(b[p * 4 + c])).pow(2))
                    .sum::<u64>();
                if difference > 0
                    && neighbors(p, input.width, input.height)
                        .into_iter()
                        .flatten()
                        .any(|q| a[q * 4 + 3] != a[p * 4 + 3] || delta(rgb(a, p), rgb(a, q)) > 24)
                {
                    result.strong_edges_exact = false;
                }
            }
        }
        result.worst_frame_rmse = result
            .worst_frame_rmse
            .max((squares as f64 / (visible.max(1) * 3) as f64).sqrt());
    }
    Ok(result)
}

#[derive(Default)]
struct Accumulator {
    color: f64,
    edge_color: f64,
    edge_weight: f64,
    rgb_error: f64,
    banding: f64,
    banding_samples: u64,
    visible: u64,
    temporal: f64,
    temporal_samples: u64,
    seam: f64,
    seam_samples: u64,
    low: f64,
    low_samples: u64,
    max_low: f64,
    max_block_temporal: f64,
    seam_max_block_temporal: f64,
}

fn measure(
    input: &QualityInput<'_>,
    output: &[Vec<u8>],
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<QualityMetrics, String> {
    let mut sum = Accumulator::default();
    for (n, frame) in output.iter().enumerate() {
        let delay = u64::from(input.delays_cs[n].max(1));
        let previous = n
            .checked_sub(1)
            .or_else(|| input.looping.then_some(output.len() - 1));
        for y in 0..input.height {
            checkpoint()?;
            for x in 0..input.width {
                let p = y * input.width + x;
                if input.baseline_rgba[n][p * 4 + 3] == 0 {
                    continue;
                }
                let a = reference(input, n, p);
                let b = rgb(frame, p);
                let error = if a == b {
                    0.0
                } else {
                    oklab_distance_srgb8(a, b)
                };
                let edge = neighbors(p, input.width, input.height)
                    .into_iter()
                    .flatten()
                    .filter(|q| input.baseline_rgba[n][q * 4 + 3] != 0)
                    .map(|q| delta(a, reference(input, n, q)))
                    .max()
                    .unwrap_or(0);
                let edge_weight = 1.0 + 4.0 * f64::from(edge) / 255.0;
                sum.visible += delay;
                sum.color += error * delay as f64;
                sum.edge_color += error * edge_weight * delay as f64;
                sum.edge_weight += edge_weight * delay as f64;
                sum.rgb_error += (0..3)
                    .map(|c| f64::from(a[c].abs_diff(b[c])) / 3.0)
                    .sum::<f64>()
                    * delay as f64;

                // [flat, flat, step, flat] signatures along both axes. Four
                // opaque pixels are required so transparency edges never count.
                for (step, fits) in [
                    (1, x > 0 && x + 2 < input.width),
                    (input.width, y > 0 && y + 2 < input.height),
                ] {
                    if !fits {
                        continue;
                    }
                    let positions = [p - step, p, p + step, p + step * 2];
                    if positions
                        .iter()
                        .any(|q| input.baseline_rgba[n][q * 4 + 3] == 0)
                    {
                        continue;
                    }
                    let levels = positions.map(|q| luma(rgb(frame, q)));
                    let jump = (levels[2] - levels[1]).abs();
                    if (levels[1] - levels[0]).abs() < 0.25
                        && (levels[3] - levels[2]).abs() < 0.25
                        && (1.5..=24.0).contains(&jump)
                    {
                        sum.banding += jump / 255.0 * delay as f64;
                    }
                    sum.banding_samples += delay;
                }

                if let Some(prev) = previous {
                    if input.baseline_rgba[prev][p * 4 + 3] != 0 {
                        let reference_before = reference(input, prev, p);
                        if delta(a, reference_before) <= 4 {
                            let residual = temporal_residual(
                                input.source_rgb.is_some(),
                                a,
                                reference_before,
                                b,
                                rgb(&output[prev], p),
                            );
                            sum.temporal += residual * delay as f64;
                            sum.temporal_samples += delay;
                            if n == 0 {
                                sum.seam += residual * delay as f64;
                                sum.seam_samples += delay;
                            }
                        }
                    }
                }
            }
        }
        measure_blocks(input, output, n, delay, &mut sum, checkpoint)?;
    }
    Ok(QualityMetrics {
        mean_oklab_error: mean(sum.color, sum.visible),
        edge_weighted_mean_oklab_error: sum.edge_color / sum.edge_weight.max(f64::EPSILON),
        mean_abs_rgb_error: mean(sum.rgb_error, sum.visible),
        low_frequency_rgb_error: mean(sum.low, sum.low_samples),
        max_low_frequency_rgb_error: sum.max_low,
        plateau_banding_score: mean(sum.banding, sum.banding_samples),
        static_temporal_residual: mean(sum.temporal, sum.temporal_samples),
        max_static_block_residual: sum.max_block_temporal,
        loop_seam_residual: input.looping.then(|| mean(sum.seam, sum.seam_samples)),
        loop_seam_max_block_residual: input.looping.then_some(sum.seam_max_block_temporal),
        weighted_visible_samples: sum.visible,
        weighted_static_samples: sum.temporal_samples,
    })
}

fn mean(sum: f64, count: u64) -> f64 {
    sum / count.max(1) as f64
}

fn temporal_residual(
    source: bool,
    now: [u8; 3],
    before: [u8; 3],
    out: [u8; 3],
    out_before: [u8; 3],
) -> f64 {
    (0..3)
        .map(|c| {
            if source {
                // Signed deltas catch phase inversion, not only changes in amplitude.
                ((f64::from(out[c]) - f64::from(out_before[c]))
                    - (f64::from(now[c]) - f64::from(before[c])))
                .abs()
            } else {
                (f64::from(out[c].abs_diff(out_before[c])) - f64::from(now[c].abs_diff(before[c])))
                    .max(0.0)
            }
        })
        .sum::<f64>()
        / 3.0
}

fn measure_blocks(
    input: &QualityInput<'_>,
    output: &[Vec<u8>],
    n: usize,
    delay: u64,
    sum: &mut Accumulator,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let frame = &output[n];
    let previous = n
        .checked_sub(1)
        .or_else(|| input.looping.then_some(output.len() - 1));
    for scale in [4, 16] {
        for by in (0..input.height).step_by(scale) {
            for bx in (0..input.width).step_by(scale) {
                let (mut error, mut count) = ([0_i64; 3], 0_u64);
                let (mut temporal, mut temporal_count) = (0.0, 0_u64);
                for y in by..(by + scale).min(input.height) {
                    checkpoint()?;
                    for x in bx..(bx + scale).min(input.width) {
                        let p = y * input.width + x;
                        if input.baseline_rgba[n][p * 4 + 3] == 0 {
                            continue;
                        }
                        let a = reference(input, n, p);
                        let b = rgb(frame, p);
                        for c in 0..3 {
                            error[c] += i64::from(b[c]) - i64::from(a[c]);
                        }
                        count += 1;
                        if let Some(prev) = previous {
                            let before = reference(input, prev, p);
                            if input.baseline_rgba[prev][p * 4 + 3] != 0 && delta(a, before) <= 4 {
                                temporal += temporal_residual(
                                    input.source_rgb.is_some(),
                                    a,
                                    before,
                                    b,
                                    rgb(&output[prev], p),
                                );
                                temporal_count += 1;
                            }
                        }
                    }
                }
                if count > 0 {
                    let bias = error
                        .iter()
                        .map(|v| v.unsigned_abs() as f64 / count as f64)
                        .sum::<f64>()
                        / 3.0;
                    sum.low += bias * (count * delay) as f64;
                    sum.low_samples += count * delay;
                    sum.max_low = sum.max_low.max(bias);
                }
                if temporal_count > 0 {
                    let residual = mean(temporal, temporal_count);
                    sum.max_block_temporal = sum.max_block_temporal.max(residual);
                    if n == 0 {
                        sum.seam_max_block_temporal = sum.seam_max_block_temporal.max(residual);
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn frame(width: usize, height: usize, pixel: impl Fn(usize, usize) -> u8) -> Vec<u8> {
        (0..height)
            .flat_map(|y| {
                (0..width).flat_map({
                    let pixel = &pixel;
                    move |x| {
                        let v = pixel(x, y);
                        [v, v, v, 255]
                    }
                })
            })
            .collect()
    }

    fn check(
        width: usize,
        height: usize,
        a: &[Vec<u8>],
        b: &[Vec<u8>],
        source: Option<&[u8]>,
        looping: bool,
    ) -> QualityGateReport {
        evaluate_quality_gate(
            QualityInput {
                width,
                height,
                baseline_rgba: a,
                candidate_rgba: b,
                source_rgb: source,
                delays_cs: &vec![5; a.len()],
                looping,
            },
            &|| Ok(()),
        )
        .unwrap()
    }

    #[test]
    fn unchanged_display_passes_with_hidden_transparent_rgb_ignored() {
        let mut a = frame(4, 4, |x, y| (x + y * 4) as u8);
        a[3] = 0;
        let mut b = a.clone();
        b[0] = 255;
        let report = check(4, 4, &[a], &[b], None, true);
        assert!(report.accepted, "{:?}", report.reasons);
        assert_eq!(report.reference_kind, "frozen_gif_display");
        assert_eq!(report.candidate.mean_oklab_error, 0.0);
    }

    #[test]
    fn source_aligned_micro_dither_stabilization_passes() {
        let a = vec![
            frame(
                16,
                8,
                |x, y| if (x + y).is_multiple_of(2) { 100 } else { 102 },
            ),
            frame(
                16,
                8,
                |x, y| if (x + y).is_multiple_of(2) { 102 } else { 100 },
            ),
        ];
        let b = vec![frame(16, 8, |_, _| 101); 2];
        let source = vec![101; 16 * 8 * 3 * 2];
        let report = check(16, 8, &a, &b, Some(&source), true);
        assert!(report.accepted, "{:?}", report.reasons);
        assert_eq!(report.reference_kind, "aligned_source_rgb");
        assert!(
            report.candidate.static_temporal_residual < report.baseline.static_temporal_residual
        );
        assert_eq!(report.candidate.mean_oklab_error, 0.0);
    }

    #[test]
    fn balanced_sparse_micro_dither_reuse_can_pass_without_source() {
        let a = vec![frame(16, 8, |x, y| {
            if (x + y * 16).is_multiple_of(8) {
                100
            } else if (x + y * 16) % 8 == 1 {
                102
            } else {
                101
            }
        })];
        let b = vec![frame(16, 8, |_, _| 101)];
        let report = check(16, 8, &a, &b, None, false);
        assert!(report.accepted, "{:?}", report.reasons);
        assert_eq!(report.candidate.low_frequency_rgb_error, 0.0);
    }

    #[test]
    fn small_rgb_envelope_does_not_admit_gradient_plateaus() {
        let a = vec![frame(64, 8, |x, _| 80 + x as u8)];
        let b = vec![frame(64, 8, |x, _| 81 + (x / 4 * 4) as u8)];
        let report = check(64, 8, &a, &b, None, false);
        assert!(report.envelope.max_channel_change <= 2);
        assert!(!report.accepted);
        assert!(report
            .reasons
            .iter()
            .any(|s| s == "plateau banding regression"));
    }

    #[test]
    fn large_region_bias_is_rejected_even_with_one_channel_level_change() {
        let a = vec![frame(16, 16, |_, _| 120)];
        let b = vec![frame(16, 16, |_, _| 121)];
        let report = check(16, 16, &a, &b, None, false);
        assert_eq!(report.envelope.max_channel_change, 1);
        assert!(report
            .reasons
            .iter()
            .any(|s| s == "low-frequency bias regression"));
    }

    #[test]
    fn tiny_change_on_text_edge_is_rejected() {
        let a = vec![frame(16, 8, |x, _| if x < 8 { 30 } else { 230 })];
        let mut b = a.clone();
        b[0][7 * 4] += 1;
        let report = check(16, 8, &a, &b, None, false);
        assert!(!report.envelope.strong_edges_exact);
        assert!(report.reasons.iter().any(|s| s == "strong edge changed"));
    }

    #[test]
    fn static_flicker_and_loop_seam_are_checked_separately() {
        let a = vec![frame(16, 8, |_, _| 101); 3];
        let b = vec![
            frame(
                16,
                8,
                |x, y| if (x + y).is_multiple_of(2) { 100 } else { 102 },
            ),
            a[1].clone(),
            frame(
                16,
                8,
                |x, y| if (x + y).is_multiple_of(2) { 102 } else { 100 },
            ),
        ];
        let report = check(16, 8, &a, &b, None, true);
        assert!(report
            .reasons
            .iter()
            .any(|s| s == "static temporal fluctuation regression"));
        assert!(report.reasons.iter().any(|s| s == "loop seam regression"));
        assert!(
            report.candidate.loop_seam_residual.unwrap()
                > report.candidate.static_temporal_residual
        );
    }

    #[test]
    fn signed_source_temporal_delta_detects_phase_reversal() {
        assert_eq!(
            temporal_residual(true, [102; 3], [100; 3], [100; 3], [102; 3]),
            4.0
        );
    }

    #[test]
    fn rejects_alpha_mismatch_and_misaligned_source() {
        let a = vec![frame(4, 4, |_, _| 101)];
        let mut b = a.clone();
        b[0][3] = 0;
        assert!(check(4, 4, &a, &b, None, false)
            .reasons
            .contains(&"alpha changed".into()));
        let bad = evaluate_quality_gate(
            QualityInput {
                width: 4,
                height: 4,
                baseline_rgba: &a,
                candidate_rgba: &a,
                source_rgb: Some(&[0; 3]),
                delays_cs: &[5],
                looping: false,
            },
            &|| Ok(()),
        );
        assert!(bad.unwrap_err().contains("alignment"));
    }

    #[test]
    fn cancellation_is_observed_between_rows() {
        let a = vec![frame(64, 32, |_, _| 100)];
        let calls = Cell::new(0);
        let result = evaluate_quality_gate(
            QualityInput {
                width: 64,
                height: 32,
                baseline_rgba: &a,
                candidate_rgba: &a,
                source_rgb: None,
                delays_cs: &[5],
                looping: true,
            },
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() >= 5 {
                    Err("cancelled by user".into())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(result.unwrap_err(), "cancelled by user");
        assert_eq!(calls.get(), 5);
    }

    #[test]
    fn display_duration_weights_color_error_without_dropping_short_frames() {
        let a = vec![frame(8, 8, |_, _| 101); 2];
        let b = vec![
            a[0].clone(),
            frame(
                8,
                8,
                |x, y| if (x + y).is_multiple_of(2) { 100 } else { 102 },
            ),
        ];
        let source = vec![101; 8 * 8 * 3 * 2];
        let evaluate = |delays| {
            evaluate_quality_gate(
                QualityInput {
                    width: 8,
                    height: 8,
                    baseline_rgba: &a,
                    candidate_rgba: &b,
                    source_rgb: Some(&source),
                    delays_cs: delays,
                    looping: false,
                },
                &|| Ok(()),
            )
            .unwrap()
        };
        let short = evaluate(&[50, 5]);
        let long = evaluate(&[5, 50]);
        assert!(
            (long.candidate.mean_oklab_error / short.candidate.mean_oklab_error - 10.0).abs()
                < 1e-10
        );
        assert_eq!(short.candidate.weighted_static_samples, 8 * 8 * 5);
        assert_eq!(long.candidate.weighted_static_samples, 8 * 8 * 50);
        assert!(short
            .reasons
            .contains(&"static temporal fluctuation regression".into()));
    }

    #[test]
    fn rejects_geometry_budget_before_accessing_frame_data() {
        let result = evaluate_quality_gate(
            QualityInput {
                width: 4096,
                height: 4096,
                baseline_rgba: &[Vec::new()],
                candidate_rgba: &[Vec::new()],
                source_rgb: None,
                delays_cs: &[5],
                looping: false,
            },
            &|| Ok(()),
        );
        assert!(result.unwrap_err().contains("budget"));
    }
}
