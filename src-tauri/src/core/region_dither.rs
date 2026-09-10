//! Deterministic low-resolution region and dither-strength planning.
//!
//! The artifact is intentionally encoder-neutral. It classifies the final
//! transformed, scheduled RGB frames into stable spatial regions and produces
//! quantized dither strengths that a later Rust indexed-frame writer can
//! consume without recomputing content semantics.

use super::perceptual::{is_skin, rgb_luma};
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

pub const REGION_DITHER_GRID_SIDE: u16 = 16;

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegionClass {
    Flat = 0,
    TextEdge = 1,
    SkinSubject = 2,
    Texture = 3,
}

impl RegionClass {
    const fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegionDitherArtifact {
    pub grid_width: u16,
    pub grid_height: u16,
    /// One `RegionClass as u8` per row-major grid cell.
    pub class_map: Vec<u8>,
    /// One `0..=255` dither strength per row-major grid cell.
    pub strength_map: Vec<u8>,
    /// Flat, text/edge, skin/subject, texture counts in enum order.
    pub class_counts: [u32; 4],
    pub sampled_frame_count: u32,
    pub sampled_pixel_count: u64,
    pub weighted_sample_mass: f64,
    pub mean_dither_strength: f64,
    pub mean_spatial_std: f64,
    pub mean_edge: f64,
    pub mean_skin_ratio: f64,
    pub mean_temporal_delta: f64,
    pub mean_high_frequency_noise: f64,
    pub class_map_sha256: String,
    pub strength_map_sha256: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RegionDitherError {
    EmptyInput,
    ZeroDimensions,
    GridExceedsFrame {
        grid_width: u16,
        grid_height: u16,
        width: u32,
        height: u32,
    },
    DimensionOverflow,
    InvalidFrameBufferSize {
        expected: usize,
        actual: usize,
    },
    InvalidWeight {
        index: usize,
        weight: f64,
    },
    SampleCountOverflow,
    WeightOverflow,
}

impl fmt::Display for RegionDitherError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyInput => formatter.write_str("region planning requires at least one frame"),
            Self::ZeroDimensions => {
                formatter.write_str("region frame and grid dimensions must be non-zero")
            }
            Self::GridExceedsFrame {
                grid_width,
                grid_height,
                width,
                height,
            } => write!(
                formatter,
                "region grid {grid_width}x{grid_height} exceeds frame {width}x{height}"
            ),
            Self::DimensionOverflow => formatter.write_str("region dimensions overflow usize"),
            Self::InvalidFrameBufferSize { expected, actual } => write!(
                formatter,
                "region RGB24 buffer has {actual} bytes; expected {expected}"
            ),
            Self::InvalidWeight { index, weight } => write!(
                formatter,
                "region frame {index} has invalid weight {weight}; expected finite and positive"
            ),
            Self::SampleCountOverflow => {
                formatter.write_str("region sample count overflowed its report field")
            }
            Self::WeightOverflow => formatter.write_str("region sample weight is not finite"),
        }
    }
}

impl Error for RegionDitherError {}

#[derive(Clone, Copy, Debug, Default)]
struct CellSignals {
    spatial_std: f64,
    edge: f64,
    skin_ratio: f64,
    temporal_delta: f64,
    high_frequency_noise: f64,
}

pub fn build_region_dither_plan_from_contiguous_rgb24(
    pixels: &[u8],
    frame_weights: &[f64],
    width: u32,
    height: u32,
    grid_width: u16,
    grid_height: u16,
) -> Result<RegionDitherArtifact, RegionDitherError> {
    if frame_weights.is_empty() {
        return Err(RegionDitherError::EmptyInput);
    }
    if width == 0 || height == 0 || grid_width == 0 || grid_height == 0 {
        return Err(RegionDitherError::ZeroDimensions);
    }
    if u32::from(grid_width) > width || u32::from(grid_height) > height {
        return Err(RegionDitherError::GridExceedsFrame {
            grid_width,
            grid_height,
            width,
            height,
        });
    }
    for (index, weight) in frame_weights.iter().copied().enumerate() {
        if !weight.is_finite() || weight <= 0.0 {
            return Err(RegionDitherError::InvalidWeight { index, weight });
        }
    }

    let width_usize = usize::try_from(width).map_err(|_| RegionDitherError::DimensionOverflow)?;
    let height_usize = usize::try_from(height).map_err(|_| RegionDitherError::DimensionOverflow)?;
    let pixels_per_frame = width_usize
        .checked_mul(height_usize)
        .ok_or(RegionDitherError::DimensionOverflow)?;
    let frame_bytes = pixels_per_frame
        .checked_mul(3)
        .ok_or(RegionDitherError::DimensionOverflow)?;
    let expected = frame_bytes
        .checked_mul(frame_weights.len())
        .ok_or(RegionDitherError::DimensionOverflow)?;
    if pixels.len() != expected {
        return Err(RegionDitherError::InvalidFrameBufferSize {
            expected,
            actual: pixels.len(),
        });
    }
    let sampled_frame_count =
        u32::try_from(frame_weights.len()).map_err(|_| RegionDitherError::SampleCountOverflow)?;
    let sampled_pixel_count = u64::try_from(pixels_per_frame)
        .ok()
        .and_then(|per_frame| per_frame.checked_mul(u64::from(sampled_frame_count)))
        .ok_or(RegionDitherError::SampleCountOverflow)?;
    let frame_weight_sum = frame_weights.iter().copied().sum::<f64>();
    let weighted_sample_mass = frame_weight_sum * pixels_per_frame as f64;
    if !frame_weight_sum.is_finite()
        || !weighted_sample_mass.is_finite()
        || weighted_sample_mass <= 0.0
    {
        return Err(RegionDitherError::WeightOverflow);
    }

    let cell_count = usize::from(grid_width)
        .checked_mul(usize::from(grid_height))
        .ok_or(RegionDitherError::DimensionOverflow)?;
    let mut class_map = Vec::with_capacity(cell_count);
    let mut strength_map = Vec::with_capacity(cell_count);
    let mut class_counts = [0_u32; 4];
    let mut signal_totals = CellSignals::default();
    for grid_y in 0..usize::from(grid_height) {
        let y0 = grid_y * height_usize / usize::from(grid_height);
        let y1 = (grid_y + 1) * height_usize / usize::from(grid_height);
        for grid_x in 0..usize::from(grid_width) {
            let x0 = grid_x * width_usize / usize::from(grid_width);
            let x1 = (grid_x + 1) * width_usize / usize::from(grid_width);
            let signals = aggregate_cell_signals(
                pixels,
                frame_weights,
                width_usize,
                frame_bytes,
                x0,
                x1,
                y0,
                y1,
            );
            let class = classify_region(signals);
            let strength = dither_strength(class, signals);
            signal_totals.spatial_std += signals.spatial_std;
            signal_totals.edge += signals.edge;
            signal_totals.skin_ratio += signals.skin_ratio;
            signal_totals.temporal_delta += signals.temporal_delta;
            signal_totals.high_frequency_noise += signals.high_frequency_noise;
            class_map.push(class as u8);
            strength_map.push(strength);
            class_counts[class.index()] = class_counts[class.index()].saturating_add(1);
        }
    }

    let mean_dither_strength = strength_map
        .iter()
        .map(|value| f64::from(*value) / 255.0)
        .sum::<f64>()
        / strength_map.len() as f64;
    let cell_denominator = cell_count as f64;
    let mean_spatial_std = signal_totals.spatial_std / cell_denominator;
    let mean_edge = signal_totals.edge / cell_denominator;
    let mean_skin_ratio = signal_totals.skin_ratio / cell_denominator;
    let mean_temporal_delta = signal_totals.temporal_delta / cell_denominator;
    let mean_high_frequency_noise = signal_totals.high_frequency_noise / cell_denominator;
    let class_map_sha256 = hash_map(
        b"gifp.region-class-map.v1\0",
        grid_width,
        grid_height,
        &class_map,
    );
    let strength_map_sha256 = hash_map(
        b"gifp.region-dither-map.v1\0",
        grid_width,
        grid_height,
        &strength_map,
    );
    let mut hasher = Sha256::new();
    hasher.update(b"gifp.region-dither-artifact.v1\0");
    hasher.update(grid_width.to_le_bytes());
    hasher.update(grid_height.to_le_bytes());
    hasher.update(sampled_frame_count.to_le_bytes());
    hasher.update(sampled_pixel_count.to_le_bytes());
    hasher.update(weighted_sample_mass.to_bits().to_le_bytes());
    hasher.update(mean_spatial_std.to_bits().to_le_bytes());
    hasher.update(mean_edge.to_bits().to_le_bytes());
    hasher.update(mean_skin_ratio.to_bits().to_le_bytes());
    hasher.update(mean_temporal_delta.to_bits().to_le_bytes());
    hasher.update(mean_high_frequency_noise.to_bits().to_le_bytes());
    hasher.update(class_map_sha256.as_bytes());
    hasher.update(strength_map_sha256.as_bytes());
    let sha256 = format!("{:x}", hasher.finalize());
    Ok(RegionDitherArtifact {
        grid_width,
        grid_height,
        class_map,
        strength_map,
        class_counts,
        sampled_frame_count,
        sampled_pixel_count,
        weighted_sample_mass,
        mean_dither_strength,
        mean_spatial_std,
        mean_edge,
        mean_skin_ratio,
        mean_temporal_delta,
        mean_high_frequency_noise,
        class_map_sha256,
        strength_map_sha256,
        sha256,
    })
}

#[allow(clippy::too_many_arguments)]
fn aggregate_cell_signals(
    pixels: &[u8],
    frame_weights: &[f64],
    width: usize,
    frame_bytes: usize,
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
) -> CellSignals {
    let cell_pixels = (x1 - x0) * (y1 - y0);
    let mut weighted = CellSignals::default();
    let mut total_weight = 0.0_f64;
    for (frame_index, weight) in frame_weights.iter().copied().enumerate() {
        let frame = &pixels[frame_index * frame_bytes..(frame_index + 1) * frame_bytes];
        let previous = frame_index
            .checked_sub(1)
            .map(|previous_index| &pixels[previous_index * frame_bytes..frame_index * frame_bytes]);
        let mut luma_sum = 0.0_f64;
        let mut luma_squared_sum = 0.0_f64;
        let mut skin_count = 0_usize;
        let mut edge_sum = 0.0_f64;
        let mut edge_count = 0_usize;
        let mut temporal_sum = 0.0_f64;
        let mut high_frequency_sum = 0.0_f64;
        let mut high_frequency_count = 0_usize;
        for y in y0..y1 {
            for x in x0..x1 {
                let pixel_offset = (y * width + x) * 3;
                let rgb = &frame[pixel_offset..pixel_offset + 3];
                let luma_u8 = rgb_luma(rgb[0], rgb[1], rgb[2]);
                let luma = f64::from(luma_u8) / 255.0;
                luma_sum += luma;
                luma_squared_sum += luma * luma;
                skin_count += usize::from(is_skin(rgb[0], rgb[1], rgb[2]));
                if x + 1 < x1 {
                    let right = &frame[pixel_offset + 3..pixel_offset + 6];
                    edge_sum +=
                        f64::from(luma_u8.abs_diff(rgb_luma(right[0], right[1], right[2]))) / 255.0;
                    edge_count += 1;
                }
                if y + 1 < y1 {
                    let down_offset = ((y + 1) * width + x) * 3;
                    let down = &frame[down_offset..down_offset + 3];
                    edge_sum +=
                        f64::from(luma_u8.abs_diff(rgb_luma(down[0], down[1], down[2]))) / 255.0;
                    edge_count += 1;
                }
                if x > x0 && x + 1 < x1 && y > y0 && y + 1 < y1 {
                    let left = &frame[pixel_offset - 3..pixel_offset];
                    let right = &frame[pixel_offset + 3..pixel_offset + 6];
                    let up_offset = ((y - 1) * width + x) * 3;
                    let up = &frame[up_offset..up_offset + 3];
                    let down_offset = ((y + 1) * width + x) * 3;
                    let down = &frame[down_offset..down_offset + 3];
                    let mut channel_noise = 0.0_f64;
                    for channel in 0..3 {
                        let laplacian = 4 * i32::from(rgb[channel])
                            - i32::from(left[channel])
                            - i32::from(right[channel])
                            - i32::from(up[channel])
                            - i32::from(down[channel]);
                        channel_noise = channel_noise.max(f64::from(laplacian.unsigned_abs()));
                    }
                    high_frequency_sum += channel_noise / (4.0 * 255.0);
                    high_frequency_count += 1;
                }
                if let Some(previous) = previous {
                    let previous_rgb = &previous[pixel_offset..pixel_offset + 3];
                    let channel_delta = (0..3)
                        .map(|channel| rgb[channel].abs_diff(previous_rgb[channel]))
                        .max()
                        .unwrap_or(0);
                    temporal_sum += f64::from(channel_delta) / 255.0;
                }
            }
        }
        let denominator = cell_pixels as f64;
        let mean = luma_sum / denominator;
        let spatial_std = (luma_squared_sum / denominator - mean * mean)
            .max(0.0)
            .sqrt();
        weighted.spatial_std += weight * spatial_std;
        weighted.edge += weight * edge_sum / edge_count.max(1) as f64;
        weighted.skin_ratio += weight * skin_count as f64 / denominator;
        weighted.temporal_delta += weight * temporal_sum / denominator;
        weighted.high_frequency_noise +=
            weight * high_frequency_sum / high_frequency_count.max(1) as f64;
        total_weight += weight;
    }
    CellSignals {
        spatial_std: weighted.spatial_std / total_weight,
        edge: weighted.edge / total_weight,
        skin_ratio: weighted.skin_ratio / total_weight,
        temporal_delta: weighted.temporal_delta / total_weight,
        high_frequency_noise: weighted.high_frequency_noise / total_weight,
    }
}

fn classify_region(signals: CellSignals) -> RegionClass {
    if signals.skin_ratio >= 0.18
        && (signals.spatial_std >= 0.025 || signals.edge >= 0.02)
        && signals.spatial_std <= 0.32
    {
        RegionClass::SkinSubject
    } else if signals.edge >= 0.08 && signals.spatial_std <= 0.38 && signals.temporal_delta <= 0.20
    {
        RegionClass::TextEdge
    } else if signals.high_frequency_noise >= 0.012 {
        RegionClass::Texture
    } else if signals.spatial_std <= 0.08 && signals.edge <= 0.05 {
        // A coherent cut or color animation is still spatially flat. Temporal
        // change alone must not turn every cell into a texture region.
        RegionClass::Flat
    } else {
        RegionClass::Texture
    }
}

fn dither_strength(class: RegionClass, signals: CellSignals) -> u8 {
    let value = match class {
        RegionClass::Flat => 18.0,
        RegionClass::TextEdge => 30.0 + signals.edge * 45.0,
        RegionClass::SkinSubject => 50.0 + (signals.edge + signals.temporal_delta * 0.15) * 45.0,
        RegionClass::Texture => {
            142.0
                + (signals.spatial_std
                    + signals.edge
                    + signals.high_frequency_noise * 2.0
                    + signals.temporal_delta * 0.35)
                    * 70.0
        }
    };
    value.round().clamp(0.0, 255.0) as u8
}

fn hash_map(domain: &[u8], width: u16, height: u16, values: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update((values.len() as u64).to_le_bytes());
    hasher.update(values);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classified_fixture() -> Vec<u8> {
        let width = 8;
        let height = 8;
        let mut pixels = vec![0_u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let rgb = if x < 4 && y < 4 {
                    [96, 96, 96]
                } else if x >= 4 && y < 4 {
                    if (x + y) % 2 == 0 {
                        [0, 0, 0]
                    } else {
                        [255, 255, 255]
                    }
                } else if x < 4 {
                    if (x + y) % 2 == 0 {
                        [210, 150, 120]
                    } else {
                        [180, 110, 80]
                    }
                } else if x == 4 && y == 4 {
                    [255, 255, 255]
                } else {
                    [0, 0, 0]
                };
                let offset = (y * width + x) * 3;
                pixels[offset..offset + 3].copy_from_slice(&rgb);
            }
        }
        pixels
    }

    #[test]
    fn classifies_flat_texture_skin_and_text_regions() {
        let pixels = classified_fixture();
        let artifact = build_region_dither_plan_from_contiguous_rgb24(&pixels, &[1.0], 8, 8, 2, 2)
            .expect("region plan");
        assert_eq!(
            artifact.class_map,
            vec![
                RegionClass::Flat as u8,
                RegionClass::Texture as u8,
                RegionClass::SkinSubject as u8,
                RegionClass::TextEdge as u8,
            ]
        );
        assert!(artifact.strength_map[0] < artifact.strength_map[3]);
        assert!(artifact.strength_map[3] < artifact.strength_map[1]);
        assert_eq!(artifact.class_counts, [1, 1, 1, 1]);
    }

    #[test]
    fn artifact_is_deterministic_and_weights_affect_its_hash() {
        let frame = classified_fixture();
        let mut pixels = frame.clone();
        pixels.extend_from_slice(&frame);
        let first =
            build_region_dither_plan_from_contiguous_rgb24(&pixels, &[1.0, 2.0], 8, 8, 2, 2)
                .unwrap();
        let repeated =
            build_region_dither_plan_from_contiguous_rgb24(&pixels, &[1.0, 2.0], 8, 8, 2, 2)
                .unwrap();
        let reweighted =
            build_region_dither_plan_from_contiguous_rgb24(&pixels, &[2.0, 2.0], 8, 8, 2, 2)
                .unwrap();
        assert_eq!(first, repeated);
        assert_ne!(first.sha256, reweighted.sha256);
        assert_eq!(first.class_map_sha256.len(), 64);
        assert_eq!(first.strength_map_sha256.len(), 64);
        assert_eq!(first.sha256.len(), 64);
    }

    #[test]
    fn separates_coherent_color_cuts_from_low_amplitude_pixel_noise() {
        let uniform_a = vec![24_u8; 8 * 8 * 3];
        let uniform_b = vec![96_u8; 8 * 8 * 3];
        let mut hard_cut = uniform_a;
        hard_cut.extend_from_slice(&uniform_b);
        let hard_cut_artifact =
            build_region_dither_plan_from_contiguous_rgb24(&hard_cut, &[1.0, 1.0], 8, 8, 1, 1)
                .unwrap();
        assert_eq!(hard_cut_artifact.class_map, vec![RegionClass::Flat as u8]);
        assert!(hard_cut_artifact.mean_temporal_delta > 0.1);
        assert_eq!(hard_cut_artifact.mean_high_frequency_noise, 0.0);

        let mut noisy = vec![0_u8; 8 * 8 * 3];
        for y in 0..8 {
            for x in 0..8 {
                let rgb = if (x + y) % 2 == 0 {
                    [26, 20, 26]
                } else {
                    [20, 26, 20]
                };
                let offset = (y * 8 + x) * 3;
                noisy[offset..offset + 3].copy_from_slice(&rgb);
            }
        }
        let noisy_artifact =
            build_region_dither_plan_from_contiguous_rgb24(&noisy, &[1.0], 8, 8, 1, 1).unwrap();
        assert_eq!(noisy_artifact.class_map, vec![RegionClass::Texture as u8]);
        assert!(noisy_artifact.mean_high_frequency_noise >= 0.012);
    }

    #[test]
    fn invalid_buffers_weights_and_grids_are_rejected() {
        assert_eq!(
            build_region_dither_plan_from_contiguous_rgb24(&[], &[], 1, 1, 1, 1),
            Err(RegionDitherError::EmptyInput)
        );
        assert!(matches!(
            build_region_dither_plan_from_contiguous_rgb24(&[0, 0, 0], &[1.0], 1, 1, 2, 1),
            Err(RegionDitherError::GridExceedsFrame { .. })
        ));
        assert!(matches!(
            build_region_dither_plan_from_contiguous_rgb24(&[0, 0], &[1.0], 1, 1, 1, 1),
            Err(RegionDitherError::InvalidFrameBufferSize { .. })
        ));
        assert!(matches!(
            build_region_dither_plan_from_contiguous_rgb24(&[0, 0, 0], &[f64::NAN], 1, 1, 1, 1),
            Err(RegionDitherError::InvalidWeight { .. })
        ));
    }
}
