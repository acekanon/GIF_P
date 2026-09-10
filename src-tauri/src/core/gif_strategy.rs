//! Pure strategy selection for FFmpeg-backed GIF generation.
//!
//! This module intentionally contains no process execution or Tauri concerns. It
//! turns a classified content profile plus available FFmpeg capabilities into a
//! deterministic encoding plan that a command layer can translate into filter
//! arguments.

/// User-facing generation intent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GifGenerationMode {
    /// Prefer one fast, deterministic FFmpeg pass after palette generation.
    Fast,
    /// Prefer visual quality over speed and output size.
    Best,
    /// Prefer a stable, compressible baseline for a target-size search.
    Target,
}

/// Coarse content classification produced by a separate analysis stage.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentProfile {
    /// A mostly static canvas with a small changing region.
    StaticOrSmallChanges,
    /// Continuous motion affects most of the frame, without frequent cuts.
    StableFullFrameMotion,
    /// The source contains several hard cuts or large palette changes.
    FrequentSceneChanges,
    /// Analysis was unavailable or inconclusive.
    Unknown,
}

/// Values accepted by FFmpeg's `palettegen=stats_mode=...` option.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PaletteStatsMode {
    Full,
    Diff,
    Single,
}

impl PaletteStatsMode {
    /// Return the exact value expected by FFmpeg.
    #[must_use]
    pub const fn as_ffmpeg_value(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Diff => "diff",
            Self::Single => "single",
        }
    }
}

/// Dithering choice selected by the generation mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FfmpegGifDither {
    Bayer,
    Sierra2_4a,
}

impl FfmpegGifDither {
    /// Return the exact value expected by FFmpeg's `paletteuse` filter.
    #[must_use]
    pub const fn as_ffmpeg_value(self) -> &'static str {
        match self {
            Self::Bayer => "bayer",
            Self::Sierra2_4a => "sierra2_4a",
        }
    }
}

/// Inputs needed to select a pure FFmpeg GIF strategy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyInput {
    pub mode: GifGenerationMode,
    pub content_profile: ContentProfile,
    /// Raw FFmpeg scale. Valid values are 0 through 5.
    pub bayer_scale: i32,
    /// GIF alpha cutoff. Valid values are 0 through 255.
    pub alpha_threshold: i32,
    /// Explicit opt-in for a per-frame palette on eligible content.
    pub allow_single_palette: bool,
    /// Capability-probe result for `palettegen=stats_mode=single` paired with
    /// `paletteuse=new=1`.
    pub supports_single_palette: bool,
    /// Capability-probe result for `paletteuse=diff_mode=rectangle`.
    pub supports_diff_rectangle: bool,
}

impl Default for StrategyInput {
    fn default() -> Self {
        Self {
            mode: GifGenerationMode::Fast,
            content_profile: ContentProfile::Unknown,
            bayer_scale: 2,
            alpha_threshold: 128,
            allow_single_palette: false,
            supports_single_palette: true,
            supports_diff_rectangle: true,
        }
    }
}

/// A validated, internally consistent FFmpeg GIF strategy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FfmpegGifPlan {
    pub generation_mode: GifGenerationMode,
    pub content_profile: ContentProfile,
    pub stats_mode: PaletteStatsMode,
    pub dither: FfmpegGifDither,
    /// Applies only when `dither` is [`FfmpegGifDither::Bayer`].
    pub bayer_scale: u8,
    pub alpha_threshold: u8,
    pub diff_mode_rectangle: bool,
    /// Maps to `paletteuse=new=1` when true.
    pub new_palette_per_frame: bool,
    /// Maps to the GIF encoder's `global_palette` option.
    pub global_palette: bool,
    /// GIF animation defaults should reserve an entry for temporal transparency.
    pub reserve_transparent: bool,
    /// Explains requested behavior that could not be honored.
    pub fallback_reason: Option<String>,
    /// Human-readable decision trace suitable for diagnostics and reports.
    pub rationale: Vec<String>,
}

impl FfmpegGifPlan {
    /// True when the plan requires a one-process, frame-synchronized palette
    /// graph rather than the existing two-pass single-palette pipeline.
    #[must_use]
    pub const fn requires_frame_synchronized_palette(&self) -> bool {
        matches!(self.stats_mode, PaletteStatsMode::Single)
    }
}

/// Build a deterministic FFmpeg GIF strategy without performing any I/O.
#[must_use]
pub fn plan_ffmpeg_gif(input: &StrategyInput) -> FfmpegGifPlan {
    let mut rationale = Vec::new();
    let mut fallback_reasons = Vec::new();

    let bayer_scale =
        clamp_with_rationale(input.bayer_scale, 0, 5, "bayer_scale", &mut rationale) as u8;
    let alpha_threshold = clamp_with_rationale(
        input.alpha_threshold,
        0,
        255,
        "alpha_threshold",
        &mut rationale,
    ) as u8;

    let dither = match input.mode {
        GifGenerationMode::Fast => {
            rationale.push(
                "fast mode uses deterministic Bayer dithering for speed and compressibility"
                    .to_string(),
            );
            FfmpegGifDither::Bayer
        }
        GifGenerationMode::Best => {
            rationale.push(
                "best mode uses Sierra 2-4A error diffusion as the FFmpeg quality baseline"
                    .to_string(),
            );
            FfmpegGifDither::Sierra2_4a
        }
        GifGenerationMode::Target => {
            rationale.push(
                "target mode uses deterministic Bayer output as a stable size-search baseline"
                    .to_string(),
            );
            FfmpegGifDither::Bayer
        }
    };

    let mut stats_mode = match input.content_profile {
        ContentProfile::StaticOrSmallChanges => {
            rationale.push(
                "static or small changes favor diff statistics so moving regions receive more palette weight"
                    .to_string(),
            );
            PaletteStatsMode::Diff
        }
        ContentProfile::StableFullFrameMotion => {
            rationale.push(
                "stable full-frame motion favors full statistics for a representative global palette"
                    .to_string(),
            );
            PaletteStatsMode::Full
        }
        ContentProfile::FrequentSceneChanges => {
            rationale.push(
                "frequent scene changes default to a full global palette unless per-frame palettes are explicitly enabled"
                    .to_string(),
            );
            PaletteStatsMode::Full
        }
        ContentProfile::Unknown => {
            rationale.push(
                "unknown content falls back to conservative full-frame palette statistics"
                    .to_string(),
            );
            PaletteStatsMode::Full
        }
    };

    let single_palette_mode_is_eligible = matches!(input.mode, GifGenerationMode::Best)
        && matches!(input.content_profile, ContentProfile::FrequentSceneChanges);

    if input.allow_single_palette {
        if !single_palette_mode_is_eligible {
            fallback_reasons.push(
                "per-frame palette was requested but is limited to best mode with frequent scene changes"
                    .to_string(),
            );
            rationale.push(
                "kept a global palette because the per-frame palette eligibility gate was not met"
                    .to_string(),
            );
        } else if !input.supports_single_palette {
            fallback_reasons.push(
                "per-frame palette was requested but the active FFmpeg backend did not pass the single/new capability probe"
                    .to_string(),
            );
            rationale.push(
                "fell back to full statistics with a global palette after capability probing"
                    .to_string(),
            );
        } else {
            stats_mode = PaletteStatsMode::Single;
            rationale.push(
                "selected per-frame palettes for frequent scene changes; this requires paletteuse new=1 and local palettes"
                    .to_string(),
            );
        }
    }

    let uses_single_palette = matches!(stats_mode, PaletteStatsMode::Single);
    let diff_mode_rectangle = if uses_single_palette {
        rationale.push(
            "disabled rectangle reuse because a new palette can remap otherwise unchanged pixels"
                .to_string(),
        );
        false
    } else if input.supports_diff_rectangle {
        rationale.push(
            "enabled rectangle processing to stabilize unchanged regions and improve GIF compressibility"
                .to_string(),
        );
        true
    } else {
        fallback_reasons
            .push("rectangle processing was unavailable in the active FFmpeg backend".to_string());
        rationale.push("fell back to full-frame palette application".to_string());
        false
    };

    FfmpegGifPlan {
        generation_mode: input.mode,
        content_profile: input.content_profile,
        stats_mode,
        dither,
        bayer_scale,
        alpha_threshold,
        diff_mode_rectangle,
        new_palette_per_frame: uses_single_palette,
        global_palette: !uses_single_palette,
        reserve_transparent: true,
        fallback_reason: if fallback_reasons.is_empty() {
            None
        } else {
            Some(fallback_reasons.join("; "))
        },
        rationale,
    }
}

fn clamp_with_rationale(
    value: i32,
    min: i32,
    max: i32,
    name: &str,
    rationale: &mut Vec<String>,
) -> i32 {
    let clamped = value.clamp(min, max);
    if clamped != value {
        rationale.push(format!(
            "clamped {name} from {value} to {clamped} (supported range {min}..={max})"
        ));
    }
    clamped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(mode: GifGenerationMode, content_profile: ContentProfile) -> StrategyInput {
        StrategyInput {
            mode,
            content_profile,
            ..StrategyInput::default()
        }
    }

    #[test]
    fn static_small_changes_choose_diff_and_rectangle() {
        let plan = plan_ffmpeg_gif(&input(
            GifGenerationMode::Fast,
            ContentProfile::StaticOrSmallChanges,
        ));

        assert_eq!(plan.stats_mode, PaletteStatsMode::Diff);
        assert!(plan.diff_mode_rectangle);
        assert!(!plan.new_palette_per_frame);
        assert!(plan.global_palette);
        assert_eq!(plan.dither, FfmpegGifDither::Bayer);
        assert!(plan.fallback_reason.is_none());
    }

    #[test]
    fn stable_full_frame_motion_chooses_full_and_rectangle() {
        let plan = plan_ffmpeg_gif(&input(
            GifGenerationMode::Best,
            ContentProfile::StableFullFrameMotion,
        ));

        assert_eq!(plan.stats_mode, PaletteStatsMode::Full);
        assert!(plan.diff_mode_rectangle);
        assert_eq!(plan.dither, FfmpegGifDither::Sierra2_4a);
        assert!(plan.global_palette);
    }

    #[test]
    fn frequent_scenes_best_can_choose_single_local_palettes() {
        let mut request = input(
            GifGenerationMode::Best,
            ContentProfile::FrequentSceneChanges,
        );
        request.allow_single_palette = true;

        let plan = plan_ffmpeg_gif(&request);

        assert_eq!(plan.stats_mode, PaletteStatsMode::Single);
        assert!(plan.new_palette_per_frame);
        assert!(!plan.global_palette);
        assert!(!plan.diff_mode_rectangle);
        assert!(plan.requires_frame_synchronized_palette());
        assert!(plan.fallback_reason.is_none());
    }

    #[test]
    fn unsupported_single_palette_falls_back_with_reason() {
        let mut request = input(
            GifGenerationMode::Best,
            ContentProfile::FrequentSceneChanges,
        );
        request.allow_single_palette = true;
        request.supports_single_palette = false;

        let plan = plan_ffmpeg_gif(&request);

        assert_eq!(plan.stats_mode, PaletteStatsMode::Full);
        assert!(!plan.new_palette_per_frame);
        assert!(plan.global_palette);
        assert!(plan.diff_mode_rectangle);
        assert!(plan
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("capability probe")));
    }

    #[test]
    fn fast_mode_rejects_requested_single_palette_with_reason() {
        let mut request = input(
            GifGenerationMode::Fast,
            ContentProfile::FrequentSceneChanges,
        );
        request.allow_single_palette = true;

        let plan = plan_ffmpeg_gif(&request);

        assert_eq!(plan.stats_mode, PaletteStatsMode::Full);
        assert!(plan.global_palette);
        assert!(plan
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("limited to best")));
    }

    #[test]
    fn target_mode_maps_to_compressible_global_bayer_plan() {
        let mut request = input(
            GifGenerationMode::Target,
            ContentProfile::FrequentSceneChanges,
        );
        request.allow_single_palette = true;

        let plan = plan_ffmpeg_gif(&request);

        assert_eq!(plan.dither, FfmpegGifDither::Bayer);
        assert_eq!(plan.stats_mode, PaletteStatsMode::Full);
        assert!(plan.global_palette);
        assert!(!plan.new_palette_per_frame);
    }

    #[test]
    fn unknown_content_uses_conservative_full_statistics() {
        let plan = plan_ffmpeg_gif(&StrategyInput::default());

        assert_eq!(plan.stats_mode, PaletteStatsMode::Full);
        assert!(plan.diff_mode_rectangle);
        assert!(plan
            .rationale
            .iter()
            .any(|reason| reason.contains("unknown content")));
    }

    #[test]
    fn bayer_and_alpha_values_are_clamped_at_both_ends() {
        let low = plan_ffmpeg_gif(&StrategyInput {
            bayer_scale: -9,
            alpha_threshold: -1,
            ..StrategyInput::default()
        });
        let high = plan_ffmpeg_gif(&StrategyInput {
            bayer_scale: 99,
            alpha_threshold: 999,
            ..StrategyInput::default()
        });

        assert_eq!(low.bayer_scale, 0);
        assert_eq!(low.alpha_threshold, 0);
        assert_eq!(high.bayer_scale, 5);
        assert_eq!(high.alpha_threshold, 255);
        assert!(low
            .rationale
            .iter()
            .any(|reason| reason.contains("clamped bayer_scale")));
        assert!(high
            .rationale
            .iter()
            .any(|reason| reason.contains("clamped alpha_threshold")));
    }

    #[test]
    fn valid_bayer_and_alpha_values_are_preserved() {
        let plan = plan_ffmpeg_gif(&StrategyInput {
            bayer_scale: 4,
            alpha_threshold: 96,
            ..StrategyInput::default()
        });

        assert_eq!(plan.bayer_scale, 4);
        assert_eq!(plan.alpha_threshold, 96);
        assert!(!plan
            .rationale
            .iter()
            .any(|reason| reason.starts_with("clamped")));
    }

    #[test]
    fn missing_rectangle_capability_falls_back_cleanly() {
        let request = StrategyInput {
            content_profile: ContentProfile::StaticOrSmallChanges,
            supports_diff_rectangle: false,
            ..StrategyInput::default()
        };

        let plan = plan_ffmpeg_gif(&request);

        assert_eq!(plan.stats_mode, PaletteStatsMode::Diff);
        assert!(!plan.diff_mode_rectangle);
        assert!(plan
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("rectangle processing")));
    }

    #[test]
    fn ffmpeg_option_values_are_exact() {
        assert_eq!(PaletteStatsMode::Full.as_ffmpeg_value(), "full");
        assert_eq!(PaletteStatsMode::Diff.as_ffmpeg_value(), "diff");
        assert_eq!(PaletteStatsMode::Single.as_ffmpeg_value(), "single");
        assert_eq!(FfmpegGifDither::Bayer.as_ffmpeg_value(), "bayer");
        assert_eq!(FfmpegGifDither::Sierra2_4a.as_ffmpeg_value(), "sierra2_4a");
    }

    #[test]
    fn every_plan_preserves_palette_invariants() {
        let modes = [
            GifGenerationMode::Fast,
            GifGenerationMode::Best,
            GifGenerationMode::Target,
        ];
        let profiles = [
            ContentProfile::StaticOrSmallChanges,
            ContentProfile::StableFullFrameMotion,
            ContentProfile::FrequentSceneChanges,
            ContentProfile::Unknown,
        ];

        for mode in modes {
            for content_profile in profiles {
                for allow_single_palette in [false, true] {
                    let plan = plan_ffmpeg_gif(&StrategyInput {
                        mode,
                        content_profile,
                        allow_single_palette,
                        ..StrategyInput::default()
                    });

                    if plan.stats_mode == PaletteStatsMode::Single {
                        assert!(plan.new_palette_per_frame);
                        assert!(!plan.global_palette);
                        assert!(!plan.diff_mode_rectangle);
                    } else {
                        assert!(!plan.new_palette_per_frame);
                        assert!(plan.global_palette);
                    }
                    assert!(plan.reserve_transparent);
                }
            }
        }
    }
}
