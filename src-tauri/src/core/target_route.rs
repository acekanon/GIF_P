use super::target_size::{symmetric_target_deviation_percent, TargetConstraint, TargetPreference};
use std::cmp::Reverse;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TargetRouteTimeline {
    #[default]
    Cfr,
    PerceptualDropHold,
}

impl TargetRouteTimeline {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cfr => "cfr",
            Self::PerceptualDropHold => "perceptual_drop_hold",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetRouteObservation {
    pub route_id: String,
    pub dither: String,
    pub palette_stats_mode: String,
    pub size_bytes: Option<u64>,
    pub timeline: TargetRouteTimeline,
}

impl TargetRouteObservation {
    pub fn encoded(
        route_id: impl Into<String>,
        dither: impl Into<String>,
        palette_stats_mode: impl Into<String>,
        size_bytes: u64,
    ) -> Self {
        Self {
            route_id: route_id.into(),
            dither: dither.into(),
            palette_stats_mode: palette_stats_mode.into(),
            size_bytes: Some(size_bytes),
            timeline: TargetRouteTimeline::Cfr,
        }
    }

    pub fn perceptual_encoded(
        route_id: impl Into<String>,
        dither: impl Into<String>,
        palette_stats_mode: impl Into<String>,
        size_bytes: u64,
    ) -> Self {
        Self {
            timeline: TargetRouteTimeline::PerceptualDropHold,
            ..Self::encoded(route_id, dither, palette_stats_mode, size_bytes)
        }
    }
}

pub fn select_target_route(
    observations: &[TargetRouteObservation],
    preference: TargetPreference,
    recommended_stats_mode: &str,
    target_bytes: u64,
    tolerance_percent: f64,
    constraint: TargetConstraint,
) -> Option<usize> {
    let encoded = observations
        .iter()
        .enumerate()
        .filter(|(_, observation)| observation.size_bytes.is_some())
        .collect::<Vec<_>>();
    if constraint == TargetConstraint::SymmetricMatch {
        return encoded
            .iter()
            .copied()
            .filter(|(_, observation)| observation.timeline == TargetRouteTimeline::Cfr)
            .min_by(|(left_index, left), (right_index, right)| {
                let left_size = left.size_bytes.unwrap_or(u64::MAX);
                let right_size = right.size_bytes.unwrap_or(u64::MAX);
                let left_matches =
                    constraint.within_tolerance(left_size, target_bytes, tolerance_percent);
                let right_matches =
                    constraint.within_tolerance(right_size, target_bytes, tolerance_percent);
                (!left_matches)
                    .cmp(&(!right_matches))
                    .then_with(|| {
                        symmetric_target_deviation_percent(left_size, target_bytes).total_cmp(
                            &symmetric_target_deviation_percent(right_size, target_bytes),
                        )
                    })
                    .then_with(|| {
                        (left.route_id != "baseline").cmp(&(right.route_id != "baseline"))
                    })
                    .then_with(|| left_index.cmp(right_index))
            })
            .map(|(index, _)| index);
    }
    let feasible = encoded
        .iter()
        .copied()
        .filter(|(_, observation)| {
            observation.size_bytes.is_some_and(|size| {
                size <= constraint.selection_ceiling(target_bytes, tolerance_percent)
            })
        })
        .collect::<Vec<_>>();
    let candidates = if feasible.is_empty() {
        encoded.as_slice()
    } else {
        feasible.as_slice()
    };

    match preference {
        TargetPreference::Clarity => candidates
            .iter()
            .copied()
            .max_by_key(|(_, observation)| {
                (
                    match observation.route_id.as_str() {
                        "perceptual_reinvest_corrected" => 2,
                        "perceptual_reinvest" => 1,
                        _ => 0,
                    },
                    observation.dither == "sierra2_4a",
                    observation.palette_stats_mode == recommended_stats_mode,
                    observation.route_id != "perceptual_timeline",
                    observation.route_id == "baseline",
                    Reverse(observation.size_bytes.unwrap_or(u64::MAX)),
                )
            })
            .map(|(index, _)| index),
        TargetPreference::Smallest => candidates
            .iter()
            .copied()
            .min_by_key(|(_, observation)| observation.size_bytes.unwrap_or(u64::MAX))
            .map(|(index, _)| index),
        TargetPreference::Balanced | TargetPreference::Smoothness => candidates
            .iter()
            .copied()
            .max_by_key(|(_, observation)| {
                (
                    observation.route_id == "baseline",
                    observation.palette_stats_mode == recommended_stats_mode,
                    observation.dither == "bayer",
                    Reverse(observation.size_bytes.unwrap_or(u64::MAX)),
                )
            })
            .map(|(index, _)| index),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observations() -> Vec<TargetRouteObservation> {
        vec![
            TargetRouteObservation::encoded("baseline", "bayer", "diff", 1_900),
            TargetRouteObservation::encoded("sierra_quality", "sierra2_4a", "diff", 1_980),
            TargetRouteObservation::encoded("alternate_stats", "bayer", "full", 1_760),
            TargetRouteObservation::perceptual_encoded(
                "perceptual_timeline",
                "bayer",
                "diff",
                1_500,
            ),
            TargetRouteObservation::perceptual_encoded(
                "perceptual_reinvest",
                "bayer",
                "diff",
                2_050,
            ),
            TargetRouteObservation::perceptual_encoded(
                "perceptual_reinvest_corrected",
                "bayer",
                "diff",
                1_940,
            ),
        ]
    }

    #[test]
    fn clarity_prefers_verified_reinvestment_only_when_it_respects_the_hard_size_limit() {
        assert_eq!(
            select_target_route(
                &observations(),
                TargetPreference::Clarity,
                "diff",
                2_000,
                5.0,
                TargetConstraint::HardCap,
            ),
            Some(5)
        );
        assert_eq!(
            select_target_route(
                &observations(),
                TargetPreference::Clarity,
                "diff",
                1_950,
                5.0,
                TargetConstraint::HardCap,
            ),
            Some(5)
        );
        assert_eq!(
            select_target_route(
                &observations(),
                TargetPreference::Clarity,
                "diff",
                1_930,
                5.0,
                TargetConstraint::HardCap,
            ),
            Some(0)
        );
    }

    #[test]
    fn smallest_uses_actual_bytes_instead_of_a_declared_route_name() {
        assert_eq!(
            select_target_route(
                &observations(),
                TargetPreference::Smallest,
                "diff",
                2_000,
                5.0,
                TargetConstraint::HardCap,
            ),
            Some(3)
        );
    }

    #[test]
    fn balanced_and_smoothness_keep_the_content_recommended_baseline() {
        for preference in [TargetPreference::Balanced, TargetPreference::Smoothness] {
            assert_eq!(
                select_target_route(
                    &observations(),
                    preference,
                    "diff",
                    2_000,
                    5.0,
                    TargetConstraint::HardCap,
                ),
                Some(0)
            );
        }
    }

    #[test]
    fn failed_routes_are_ignored_and_an_over_target_fallback_is_deterministic() {
        let mut routes = observations();
        routes[0].size_bytes = None;
        assert_eq!(
            select_target_route(
                &routes,
                TargetPreference::Clarity,
                "diff",
                1_000,
                5.0,
                TargetConstraint::HardCap,
            ),
            Some(5)
        );
    }

    #[test]
    fn symmetric_match_prefers_the_closest_real_bytes_even_when_slightly_over() {
        let routes = vec![
            TargetRouteObservation::encoded("baseline", "bayer", "diff", 2_111),
            TargetRouteObservation::perceptual_encoded(
                "perceptual_timeline",
                "bayer",
                "diff",
                2_078,
            ),
        ];
        assert_eq!(
            select_target_route(
                &routes,
                TargetPreference::Balanced,
                "diff",
                2_077,
                5.0,
                TargetConstraint::SymmetricMatch,
            ),
            Some(0)
        );
    }
}
