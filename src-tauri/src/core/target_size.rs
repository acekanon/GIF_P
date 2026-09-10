#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TargetCandidate {
    pub width: u32,
    pub fps: u32,
    pub colors: u16,
    pub bayer_scale: u8,
}

impl TargetCandidate {
    pub fn normalized(self) -> Self {
        let width = self.width.clamp(96, 1920) & !1;
        Self {
            width: width.max(96),
            fps: self.fps.clamp(1, 60),
            colors: self.colors.clamp(3, 256),
            bayer_scale: self.bayer_scale.min(5),
        }
    }
}

pub const REINVEST_SPATIAL_SAFETY_FACTOR: f64 = 0.96;

pub fn reinvest_target_savings(
    selected: TargetCandidate,
    ceiling: TargetCandidate,
    observed_bytes: u64,
    target_bytes: u64,
) -> Option<TargetCandidate> {
    let selected = selected.normalized();
    let ceiling = ceiling.normalized();
    if observed_bytes == 0 || observed_bytes >= target_bytes {
        return None;
    }
    let ratio = (target_bytes as f64 / observed_bytes as f64).clamp(1.0, 16.0);
    let predicted_width = even(
        (f64::from(selected.width) * ratio.sqrt() * REINVEST_SPATIAL_SAFETY_FACTOR).round() as u32,
    )
    .clamp(selected.width, ceiling.width.max(selected.width));
    let mut candidate = TargetCandidate {
        width: predicted_width,
        ..selected
    };
    if candidate.width == ceiling.width && selected.colors < ceiling.colors {
        candidate.colors = ((f64::from(selected.colors) * ratio.powf(0.20) * 0.98).round() as u16)
            .clamp(selected.colors, ceiling.colors);
    }
    candidate = candidate.normalized();
    (candidate != selected).then_some(candidate)
}

pub fn estimate_reinvestment_size(
    source: TargetCandidate,
    candidate: TargetCandidate,
    source_size_bytes: u64,
) -> u64 {
    let source = source.normalized();
    let candidate = candidate.normalized();
    let width_ratio = f64::from(candidate.width) / f64::from(source.width.max(1));
    let fps_ratio = f64::from(candidate.fps) / f64::from(source.fps.max(1));
    let color_ratio = f64::from(candidate.colors) / f64::from(source.colors.max(1));
    let estimate =
        source_size_bytes.max(1) as f64 * width_ratio.powi(2) * fps_ratio * color_ratio.powf(0.20);
    estimate.round().clamp(1.0, u64::MAX as f64) as u64
}

pub fn correct_reinvestment_overshoot(
    lower: TargetCandidate,
    upper: TargetCandidate,
    lower_size_bytes: u64,
    upper_size_bytes: u64,
    target_bytes: u64,
) -> Option<TargetCandidate> {
    let lower = lower.normalized();
    let upper = upper.normalized();
    if lower_size_bytes >= target_bytes
        || upper_size_bytes <= target_bytes
        || upper_size_bytes <= lower_size_bytes
    {
        return None;
    }
    let guarded_target = target_bytes.saturating_mul(98) / 100;
    if guarded_target <= lower_size_bytes {
        return None;
    }
    let fraction = ((guarded_target - lower_size_bytes) as f64
        / (upper_size_bytes - lower_size_bytes) as f64)
        .clamp(0.05, 0.95);
    let mut corrected = lower;
    if upper.width > lower.width.saturating_add(2) {
        let lower_area = f64::from(lower.width).powi(2);
        let upper_area = f64::from(upper.width).powi(2);
        let width = even(
            (lower_area + (upper_area - lower_area) * fraction)
                .sqrt()
                .round() as u32,
        );
        corrected.width = width.clamp(lower.width.saturating_add(2), upper.width.saturating_sub(2));
        // The overshooting probe may have raised width and colors together.
        // Correct one dimension at a time so the second real encode stays bracketed.
        corrected.colors = lower.colors;
    } else if upper.colors > lower.colors.saturating_add(1) {
        let colors = (f64::from(lower.colors) + f64::from(upper.colors - lower.colors) * fraction)
            .round() as u16;
        corrected.colors = colors.clamp(
            lower.colors.saturating_add(1),
            upper.colors.saturating_sub(1),
        );
    } else {
        return None;
    }
    corrected = corrected.normalized();
    (corrected != lower && corrected != upper).then_some(corrected)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TargetPreference {
    #[default]
    Balanced,
    Clarity,
    Smoothness,
    Smallest,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TargetConstraint {
    #[default]
    HardCap,
    SymmetricMatch,
}

impl TargetConstraint {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HardCap => "hard_cap",
            Self::SymmetricMatch => "symmetric_match",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "hard_cap" => Some(Self::HardCap),
            "symmetric_match" => Some(Self::SymmetricMatch),
            _ => None,
        }
    }

    pub fn selection_ceiling(self, target_bytes: u64, tolerance_percent: f64) -> u64 {
        match self {
            Self::HardCap => target_bytes,
            Self::SymmetricMatch => {
                let tolerance = tolerance_percent.clamp(1.0, 25.0) / 100.0;
                ((target_bytes as f64) * (2.0 + tolerance) / (2.0 - tolerance))
                    .floor()
                    .clamp(1.0, u64::MAX as f64) as u64
            }
        }
    }

    pub fn within_tolerance(
        self,
        size_bytes: u64,
        target_bytes: u64,
        tolerance_percent: f64,
    ) -> bool {
        (self == Self::SymmetricMatch || size_bytes <= target_bytes)
            && symmetric_target_deviation_percent(size_bytes, target_bytes)
                <= tolerance_percent.clamp(1.0, 25.0)
    }
}

pub fn symmetric_target_deviation_percent(size_bytes: u64, target_bytes: u64) -> f64 {
    let denominator = size_bytes as f64 + target_bytes as f64;
    if denominator <= f64::EPSILON {
        0.0
    } else {
        size_bytes.abs_diff(target_bytes) as f64 * 200.0 / denominator
    }
}

impl TargetPreference {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Balanced => "balanced",
            Self::Clarity => "clarity",
            Self::Smoothness => "smoothness",
            Self::Smallest => "smallest",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "balanced" => Some(Self::Balanced),
            "clarity" => Some(Self::Clarity),
            "smoothness" => Some(Self::Smoothness),
            "smallest" => Some(Self::Smallest),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetObservation {
    pub candidate: TargetCandidate,
    pub size_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetFit {
    Exact,
    Under,
    Over,
    Unreachable,
}

#[derive(Clone, Debug)]
pub struct TargetSizeSearch {
    target_bytes: u64,
    tolerance_percent: f64,
    max_attempts: usize,
    base: TargetCandidate,
    preference: TargetPreference,
    constraint: TargetConstraint,
    minimum_width: u32,
    observations: Vec<TargetObservation>,
}

impl TargetSizeSearch {
    pub fn new(
        target_bytes: u64,
        tolerance_percent: f64,
        max_attempts: usize,
        base: TargetCandidate,
    ) -> Self {
        Self {
            target_bytes: target_bytes.max(1),
            tolerance_percent: tolerance_percent.clamp(1.0, 25.0),
            max_attempts: max_attempts.clamp(1, 12),
            base: base.normalized(),
            preference: TargetPreference::Balanced,
            constraint: TargetConstraint::HardCap,
            minimum_width: 96,
            observations: Vec::new(),
        }
    }

    pub fn with_preference(mut self, preference: TargetPreference) -> Self {
        self.preference = preference;
        self
    }

    pub fn with_constraint(mut self, constraint: TargetConstraint) -> Self {
        self.constraint = constraint;
        self
    }

    pub const fn preference(&self) -> TargetPreference {
        self.preference
    }

    pub const fn constraint(&self) -> TargetConstraint {
        self.constraint
    }

    pub fn observations(&self) -> &[TargetObservation] {
        &self.observations
    }

    pub fn record(&mut self, candidate: TargetCandidate, size_bytes: u64) {
        let candidate = candidate.normalized();
        if let Some(existing) = self
            .observations
            .iter_mut()
            .find(|item| item.candidate == candidate)
        {
            existing.size_bytes = size_bytes;
            return;
        }
        self.observations.push(TargetObservation {
            candidate,
            size_bytes,
        });
    }

    pub fn next_candidate(&self) -> Option<TargetCandidate> {
        if self.observations.len() >= self.max_attempts {
            return None;
        }
        if self.observations.is_empty() {
            return Some(self.base);
        }
        if self.best_exact().is_some() {
            return None;
        }

        let last = self.observations.last()?;
        let mut next = if last.size_bytes > self.target_bytes {
            self.next_smaller(last)
        } else {
            self.next_between_bounds(last)
        }?;
        next = next.normalized();
        if self.observations.iter().any(|item| item.candidate == next) {
            return self.next_discrete_step(last);
        }
        Some(next)
    }

    pub fn best_observation(&self) -> Option<&TargetObservation> {
        if let Some(exact) = self.best_exact() {
            return Some(exact);
        }
        let upper = self.upper_bound();
        let feasible = preferred_observation(
            self.observations
                .iter()
                .filter(|item| item.size_bytes <= upper),
            self.preference,
        );
        feasible.or_else(|| {
            self.observations
                .iter()
                .min_by_key(|item| item.size_bytes.abs_diff(self.target_bytes))
        })
    }

    pub fn pareto_frontier(&self) -> Vec<&TargetObservation> {
        let feasible = self
            .observations
            .iter()
            .filter(|item| item.size_bytes <= self.upper_bound())
            .collect::<Vec<_>>();
        let mut frontier = feasible
            .iter()
            .copied()
            .filter(|candidate| {
                !feasible
                    .iter()
                    .copied()
                    .any(|other| !std::ptr::eq(*candidate, other) && dominates(other, candidate))
            })
            .collect::<Vec<_>>();
        frontier.sort_by(|left, right| {
            right
                .candidate
                .width
                .cmp(&left.candidate.width)
                .then_with(|| right.candidate.fps.cmp(&left.candidate.fps))
                .then_with(|| right.candidate.colors.cmp(&left.candidate.colors))
                .then_with(|| left.size_bytes.cmp(&right.size_bytes))
                .then_with(|| left.candidate.bayer_scale.cmp(&right.candidate.bayer_scale))
        });
        frontier
    }

    pub fn recommendation(&self, preference: TargetPreference) -> Option<&TargetObservation> {
        preferred_observation(self.pareto_frontier().into_iter(), preference)
    }

    pub fn fit(&self) -> TargetFit {
        if self.best_exact().is_some() {
            return TargetFit::Exact;
        }
        match self.best_observation() {
            Some(item) if item.size_bytes <= self.target_bytes => TargetFit::Under,
            Some(_)
                if self.observations.len() >= self.max_attempts
                    || self.next_candidate().is_none() =>
            {
                TargetFit::Unreachable
            }
            Some(_) => TargetFit::Over,
            None => TargetFit::Unreachable,
        }
    }

    fn lower_bound(&self) -> u64 {
        let tolerance = self.tolerance_percent / 100.0;
        let minimum_ratio = (2.0 - tolerance) / (2.0 + tolerance);
        ((self.target_bytes as f64) * minimum_ratio).ceil() as u64
    }

    fn upper_bound(&self) -> u64 {
        self.constraint
            .selection_ceiling(self.target_bytes, self.tolerance_percent)
    }

    fn best_exact(&self) -> Option<&TargetObservation> {
        let lower = self.lower_bound();
        let upper = self.upper_bound();
        preferred_observation(
            self.observations
                .iter()
                .filter(|item| (lower..=upper).contains(&item.size_bytes)),
            self.preference,
        )
    }

    fn next_smaller(&self, last: &TargetObservation) -> Option<TargetCandidate> {
        if let Some(under) = self
            .observations
            .iter()
            .filter(|item| {
                item.size_bytes <= self.target_bytes
                    && item.candidate.fps == last.candidate.fps
                    && item.candidate.colors == last.candidate.colors
            })
            .max_by_key(|item| item.candidate.width)
        {
            let midpoint = even((under.candidate.width + last.candidate.width) / 2);
            if midpoint > under.candidate.width && midpoint < last.candidate.width {
                return Some(TargetCandidate {
                    width: midpoint,
                    ..last.candidate
                });
            }
        }

        if let Some(width) = self.last_chance_symmetric_width(last) {
            return Some(TargetCandidate {
                width,
                ..last.candidate
            });
        }

        let ratio = (self.target_bytes as f64 / last.size_bytes.max(1) as f64).clamp(0.05, 0.99);
        let predicted_width =
            even(((last.candidate.width as f64) * ratio.sqrt() * 0.985).round() as u32)
                .max(self.minimum_width);
        if predicted_width + 2 < last.candidate.width {
            return Some(TargetCandidate {
                width: predicted_width,
                ..last.candidate
            });
        }
        self.next_discrete_step(last)
    }

    fn last_chance_symmetric_width(&self, last: &TargetObservation) -> Option<u32> {
        if self.constraint != TargetConstraint::SymmetricMatch
            || self.observations.len() + 1 != self.max_attempts
            || last.size_bytes <= self.upper_bound()
        {
            return None;
        }
        let previous = self
            .observations
            .iter()
            .filter(|item| {
                item.candidate.width > last.candidate.width
                    && item.candidate.fps == last.candidate.fps
                    && item.candidate.colors == last.candidate.colors
                    && item.candidate.bayer_scale == last.candidate.bayer_scale
                    && item.size_bytes > last.size_bytes
            })
            .min_by_key(|item| item.candidate.width)?;
        let previous_area = f64::from(previous.candidate.width).powi(2);
        let last_area = f64::from(last.candidate.width).powi(2);
        let area_delta = previous_area - last_area;
        let byte_delta = (previous.size_bytes - last.size_bytes) as f64;
        if area_delta <= f64::EPSILON || byte_delta <= f64::EPSILON {
            return None;
        }

        // Tiny GIFs can be dominated by container/frame overhead, so the usual
        // square-root byte ratio shrinks too cautiously. On the final numeric
        // attempt, use the measured local bytes-per-pixel slope to aim at the
        // symmetric upper bound. This is reference-only behavior: hard-cap
        // searches keep their conservative progression.
        let bytes_per_area = byte_delta / area_delta;
        let bytes_to_remove = (last.size_bytes - self.upper_bound()) as f64;
        let predicted_area = (last_area - bytes_to_remove / bytes_per_area)
            .max(f64::from(self.minimum_width).powi(2));
        let predicted_width = even(predicted_area.sqrt().floor() as u32)
            .clamp(self.minimum_width, last.candidate.width.saturating_sub(2));
        (predicted_width + 2 < last.candidate.width).then_some(predicted_width)
    }

    fn next_between_bounds(&self, last: &TargetObservation) -> Option<TargetCandidate> {
        let over = self
            .observations
            .iter()
            .filter(|item| {
                item.size_bytes > self.target_bytes
                    && item.candidate.fps == last.candidate.fps
                    && item.candidate.colors == last.candidate.colors
            })
            .min_by_key(|item| item.candidate.width);
        if let Some(over) = over {
            let midpoint = even((last.candidate.width + over.candidate.width) / 2);
            if midpoint > last.candidate.width && midpoint < over.candidate.width {
                return Some(TargetCandidate {
                    width: midpoint,
                    ..last.candidate
                });
            }
        }

        if last.candidate.width < self.base.width {
            let ratio = (self.target_bytes as f64 / last.size_bytes.max(1) as f64).clamp(1.0, 16.0);
            let predicted =
                even(((last.candidate.width as f64) * ratio.sqrt() * 0.985).round() as u32)
                    .clamp(self.minimum_width, self.base.width);
            let width = predicted
                .max(last.candidate.width.saturating_add(2))
                .min(self.base.width);
            if width > last.candidate.width {
                return Some(TargetCandidate {
                    width,
                    ..last.candidate
                });
            }
        }

        let over_fps = self
            .observations
            .iter()
            .filter(|item| {
                item.size_bytes > self.target_bytes
                    && item.candidate.width == last.candidate.width
                    && item.candidate.colors == last.candidate.colors
                    && item.candidate.fps > last.candidate.fps
            })
            .min_by_key(|item| item.candidate.fps);
        if let Some(over) = over_fps {
            let midpoint = (last.candidate.fps + over.candidate.fps) / 2;
            if midpoint > last.candidate.fps && midpoint < over.candidate.fps {
                return Some(TargetCandidate {
                    fps: midpoint,
                    ..last.candidate
                });
            }
        }
        None
    }

    fn next_discrete_step(&self, current: &TargetObservation) -> Option<TargetCandidate> {
        let fps_ladder = [60, 48, 30, 24, 20, 18, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1];
        for next_fps in fps_ladder
            .into_iter()
            .filter(|value| *value < current.candidate.fps)
        {
            let ratio = (self.target_bytes as f64 / current.size_bytes.max(1) as f64
                * f64::from(current.candidate.fps)
                / f64::from(next_fps))
            .clamp(0.01, 16.0);
            let predicted_width =
                even(((current.candidate.width as f64) * ratio.sqrt() * 0.985).round() as u32)
                    .clamp(self.minimum_width, self.base.width);
            let next = TargetCandidate {
                width: predicted_width,
                fps: next_fps,
                ..current.candidate
            }
            .normalized();
            if !self.observations.iter().any(|item| item.candidate == next) {
                return Some(next);
            }
        }

        let color_ladder = [
            256, 224, 192, 160, 128, 112, 96, 80, 64, 48, 32, 24, 16, 8, 4, 3,
        ];
        for next_colors in color_ladder
            .into_iter()
            .filter(|value| *value < current.candidate.colors)
        {
            let next = TargetCandidate {
                colors: next_colors,
                ..current.candidate
            }
            .normalized();
            if !self.observations.iter().any(|item| item.candidate == next) {
                return Some(next);
            }
        }

        (current.candidate.bayer_scale < 5).then_some(TargetCandidate {
            bayer_scale: current.candidate.bayer_scale + 1,
            ..current.candidate
        })
    }
}

fn even(value: u32) -> u32 {
    value & !1
}

fn preferred_observation<'a>(
    observations: impl Iterator<Item = &'a TargetObservation>,
    preference: TargetPreference,
) -> Option<&'a TargetObservation> {
    observations.max_by(|left, right| preference_cmp(left, right, preference))
}

fn preference_cmp(
    left: &TargetObservation,
    right: &TargetObservation,
    preference: TargetPreference,
) -> std::cmp::Ordering {
    let quality = match preference {
        TargetPreference::Balanced => left
            .candidate
            .width
            .cmp(&right.candidate.width)
            .then_with(|| left.candidate.fps.cmp(&right.candidate.fps))
            .then_with(|| left.candidate.colors.cmp(&right.candidate.colors)),
        TargetPreference::Clarity => left
            .candidate
            .width
            .cmp(&right.candidate.width)
            .then_with(|| left.candidate.colors.cmp(&right.candidate.colors))
            .then_with(|| left.candidate.fps.cmp(&right.candidate.fps)),
        TargetPreference::Smoothness => left
            .candidate
            .fps
            .cmp(&right.candidate.fps)
            .then_with(|| left.candidate.width.cmp(&right.candidate.width))
            .then_with(|| left.candidate.colors.cmp(&right.candidate.colors)),
        TargetPreference::Smallest => right.size_bytes.cmp(&left.size_bytes),
    };
    quality
        .then_with(|| right.size_bytes.cmp(&left.size_bytes))
        .then_with(|| right.candidate.bayer_scale.cmp(&left.candidate.bayer_scale))
}

fn dominates(left: &TargetObservation, right: &TargetObservation) -> bool {
    let no_worse = left.size_bytes <= right.size_bytes
        && left.candidate.width >= right.candidate.width
        && left.candidate.fps >= right.candidate.fps
        && left.candidate.colors >= right.candidate.colors;
    let strictly_better = left.size_bytes < right.size_bytes
        || left.candidate.width > right.candidate.width
        || left.candidate.fps > right.candidate.fps
        || left.candidate.colors > right.candidate.colors;
    no_worse && strictly_better
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> TargetCandidate {
        TargetCandidate {
            width: 480,
            fps: 18,
            colors: 160,
            bayer_scale: 2,
        }
    }

    #[test]
    fn starts_from_user_quality_ceiling() {
        let search = TargetSizeSearch::new(2_000_000, 5.0, 8, base());
        assert_eq!(search.next_candidate(), Some(base()));
    }

    #[test]
    fn oversized_result_predicts_smaller_even_width() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 8, base());
        search.record(base(), 4_000_000);
        let next = search.next_candidate().expect("next candidate");
        assert!(next.width < 480);
        assert_eq!(next.width % 2, 0);
        assert_eq!(next.fps, 18);
    }

    #[test]
    fn lowering_fps_uses_the_observed_size_instead_of_resetting_width() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 8, base());
        search.record(base(), 8_000_000);
        search.record(
            TargetCandidate {
                width: 96,
                ..base()
            },
            2_400_000,
        );

        let next = search.next_candidate().expect("lower-fps candidate");
        assert_eq!(next.width, 96);
        assert_eq!(next.fps, 15);
        assert_eq!(next.colors, base().colors);
    }

    #[test]
    fn minimum_width_overage_lowers_fps_without_resetting_width() {
        let mut search = TargetSizeSearch::new(
            2_000,
            5.0,
            12,
            TargetCandidate {
                width: 320,
                fps: 12,
                colors: 96,
                bayer_scale: 2,
            },
        );
        let minimum = TargetCandidate {
            width: 96,
            fps: 12,
            colors: 96,
            bayer_scale: 2,
        };
        search.record(minimum, 2_400);
        let next = search.next_candidate().expect("lower-fps candidate");
        assert_eq!(next.width, 96);
        assert_eq!(next.fps, 10);
    }

    #[test]
    fn unbracketed_under_target_result_searches_upward() {
        let mut search = TargetSizeSearch::new(2_000, 5.0, 12, base());
        let under = TargetCandidate {
            width: 240,
            ..base()
        };
        search.record(under, 1_500);
        let next = search.next_candidate().expect("larger candidate");
        assert!(
            next.width > under.width && next.width <= base().width,
            "{next:?}"
        );
        assert_eq!(next.fps, under.fps);
    }

    #[test]
    fn transparent_palette_candidates_never_drop_below_three_colors() {
        let normalized = TargetCandidate {
            colors: 2,
            ..base()
        }
        .normalized();
        assert_eq!(normalized.colors, 3);
    }

    #[test]
    fn exact_result_stops_search() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 8, base());
        search.record(base(), 1_960_000);
        assert_eq!(search.fit(), TargetFit::Exact);
        assert_eq!(search.next_candidate(), None);
    }

    #[test]
    fn exact_lower_bound_matches_the_symmetric_size_delta_rule() {
        let mut accepted = TargetSizeSearch::new(10_000, 5.0, 12, base());
        accepted.record(base(), 9_513);
        assert_eq!(accepted.fit(), TargetFit::Exact);

        let mut rejected = TargetSizeSearch::new(10_000, 5.0, 1, base());
        rejected.record(base(), 9_512);
        assert_ne!(rejected.fit(), TargetFit::Exact);
    }

    #[test]
    fn search_never_treats_over_target_as_exact() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 1, base());
        search.record(base(), 2_000_001);
        assert_eq!(search.fit(), TargetFit::Unreachable);
    }

    #[test]
    fn symmetric_match_accepts_a_slight_overshoot_without_weakening_hard_cap() {
        let mut matched = TargetSizeSearch::new(2_077, 5.0, 12, base())
            .with_constraint(TargetConstraint::SymmetricMatch);
        matched.record(base(), 2_169);
        assert_eq!(matched.fit(), TargetFit::Exact);
        assert_eq!(matched.next_candidate(), None);

        let mut hard_cap = TargetSizeSearch::new(2_077, 5.0, 1, base());
        hard_cap.record(base(), 2_169);
        assert_eq!(hard_cap.fit(), TargetFit::Unreachable);
    }

    #[test]
    fn symmetric_last_attempt_accounts_for_tiny_gif_fixed_overhead() {
        let base = TargetCandidate {
            width: 320,
            fps: 12,
            colors: 96,
            bayer_scale: 2,
        };
        let observations = [
            (320, 2_485),
            (272, 2_357),
            (238, 2_269),
            (212, 2_207),
            (192, 2_157),
            (176, 2_119),
            (162, 2_085),
            (150, 2_055),
            (140, 2_033),
            (132, 2_013),
            (124, 1_995),
        ];
        let mut matched = TargetSizeSearch::new(1_864, 5.0, 12, base)
            .with_constraint(TargetConstraint::SymmetricMatch);
        for (width, size_bytes) in observations {
            matched.record(TargetCandidate { width, ..base }, size_bytes);
        }
        let final_probe = matched.next_candidate().expect("last symmetric probe");
        assert_eq!(final_probe.width, 106);
        assert_eq!(final_probe.fps, 12);

        let mut hard_cap = TargetSizeSearch::new(1_864, 5.0, 12, base);
        for (width, size_bytes) in observations {
            hard_cap.record(TargetCandidate { width, ..base }, size_bytes);
        }
        assert_eq!(
            hard_cap
                .next_candidate()
                .expect("conservative hard-cap probe")
                .width,
            118
        );
    }

    #[test]
    fn target_constraint_parser_only_accepts_public_wire_values() {
        assert_eq!(
            TargetConstraint::parse("symmetric_match"),
            Some(TargetConstraint::SymmetricMatch)
        );
        assert_eq!(
            TargetConstraint::parse("hard_cap"),
            Some(TargetConstraint::HardCap)
        );
        assert_eq!(TargetConstraint::parse("loose"), None);
    }

    #[test]
    fn duplicate_observation_is_replaced_not_reencoded() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 8, base());
        search.record(base(), 4_000_000);
        search.record(base(), 3_500_000);
        assert_eq!(search.observations().len(), 1);
        assert_eq!(search.observations()[0].size_bytes, 3_500_000);
    }

    #[test]
    fn best_feasible_candidate_prefers_quality() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 8, base());
        let low = TargetCandidate {
            width: 240,
            fps: 8,
            colors: 64,
            bayer_scale: 3,
        };
        let high = TargetCandidate {
            width: 400,
            fps: 15,
            colors: 128,
            bayer_scale: 2,
        };
        search.record(low, 1_500_000);
        search.record(high, 1_850_000);
        assert_eq!(search.best_observation().unwrap().candidate, high);
    }

    #[test]
    fn exact_candidate_is_selected_over_higher_quality_far_under_candidate() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 12, base());
        let higher_quality = TargetCandidate {
            width: 440,
            fps: 15,
            colors: 128,
            bayer_scale: 2,
        };
        let exact = TargetCandidate {
            width: 320,
            fps: 12,
            colors: 96,
            bayer_scale: 2,
        };
        search.record(higher_quality, 1_700_000);
        search.record(exact, 1_960_000);
        assert_eq!(search.best_observation().unwrap().candidate, exact);
        assert_eq!(search.fit(), TargetFit::Exact);
    }

    #[test]
    fn pareto_frontier_removes_a_larger_lower_quality_candidate() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 8, base());
        let dominated = TargetCandidate {
            width: 240,
            fps: 8,
            colors: 64,
            bayer_scale: 3,
        };
        let better = TargetCandidate {
            width: 320,
            fps: 12,
            colors: 96,
            bayer_scale: 2,
        };
        search.record(dominated, 1_900_000);
        search.record(better, 1_800_000);

        let frontier = search.pareto_frontier();
        assert_eq!(frontier.len(), 1);
        assert_eq!(frontier[0].candidate, better);
    }

    #[test]
    fn recommendations_expose_clarity_smoothness_and_smallest_tradeoffs() {
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 8, base());
        let clarity = TargetCandidate {
            width: 420,
            fps: 8,
            colors: 160,
            bayer_scale: 2,
        };
        let smoothness = TargetCandidate {
            width: 300,
            fps: 18,
            colors: 96,
            bayer_scale: 2,
        };
        let smallest = TargetCandidate {
            width: 280,
            fps: 12,
            colors: 80,
            bayer_scale: 3,
        };
        search.record(clarity, 1_920_000);
        search.record(smoothness, 1_850_000);
        search.record(smallest, 1_500_000);

        assert_eq!(
            search
                .recommendation(TargetPreference::Clarity)
                .unwrap()
                .candidate,
            clarity
        );
        assert_eq!(
            search
                .recommendation(TargetPreference::Smoothness)
                .unwrap()
                .candidate,
            smoothness
        );
        assert_eq!(
            search
                .recommendation(TargetPreference::Smallest)
                .unwrap()
                .candidate,
            smallest
        );
    }

    #[test]
    fn stored_preference_selects_between_multiple_exact_candidates_without_weights() {
        let clarity = TargetCandidate {
            width: 420,
            fps: 8,
            colors: 160,
            bayer_scale: 2,
        };
        let smoothness = TargetCandidate {
            width: 300,
            fps: 18,
            colors: 96,
            bayer_scale: 2,
        };
        let mut search = TargetSizeSearch::new(2_000_000, 5.0, 8, base())
            .with_preference(TargetPreference::Smoothness);
        search.record(clarity, 1_970_000);
        search.record(smoothness, 1_980_000);

        assert_eq!(search.preference().as_str(), "smoothness");
        assert_eq!(search.best_observation().unwrap().candidate, smoothness);
    }

    #[test]
    fn target_preference_parser_accepts_only_public_wire_values() {
        assert_eq!(
            TargetPreference::parse(" smoothness "),
            Some(TargetPreference::Smoothness)
        );
        assert_eq!(
            TargetPreference::parse("SMALLEST"),
            Some(TargetPreference::Smallest)
        );
        assert_eq!(TargetPreference::parse("auto"), None);
        assert_eq!(TargetPreference::parse("quality"), None);
    }

    #[test]
    fn perceptual_savings_are_reinvested_into_even_width_without_exceeding_the_ceiling() {
        let selected = TargetCandidate {
            width: 240,
            fps: 12,
            colors: 96,
            bayer_scale: 2,
        };
        let ceiling = TargetCandidate {
            width: 480,
            fps: 18,
            colors: 160,
            bayer_scale: 2,
        };
        let candidate = reinvest_target_savings(selected, ceiling, 1_000_000, 2_000_000)
            .expect("reinvestment candidate");
        assert!(candidate.width > selected.width && candidate.width <= ceiling.width);
        assert_eq!(candidate.width % 2, 0);
        assert_eq!(candidate.fps, selected.fps);
    }

    #[test]
    fn reinvestment_can_raise_colors_after_reaching_the_width_ceiling() {
        let selected = TargetCandidate {
            width: 480,
            fps: 12,
            colors: 64,
            bayer_scale: 2,
        };
        let ceiling = TargetCandidate {
            width: 480,
            fps: 18,
            colors: 160,
            bayer_scale: 2,
        };
        let candidate = reinvest_target_savings(selected, ceiling, 900_000, 2_000_000)
            .expect("color reinvestment candidate");
        assert_eq!(candidate.width, 480);
        assert!(candidate.colors > selected.colors && candidate.colors <= ceiling.colors);
    }

    #[test]
    fn reinvestment_is_skipped_without_savings_or_quality_headroom() {
        let selected = base();
        assert!(reinvest_target_savings(selected, selected, 1_000_000, 2_000_000).is_none());
        assert!(reinvest_target_savings(selected, base(), 2_000_000, 2_000_000).is_none());
    }

    #[test]
    fn reinvestment_estimate_tracks_spatial_fps_and_color_scale() {
        let source = TargetCandidate {
            width: 200,
            fps: 10,
            colors: 64,
            bayer_scale: 2,
        };
        assert_eq!(estimate_reinvestment_size(source, source, 100_000), 100_000);
        let spatial = TargetCandidate {
            width: 400,
            ..source
        };
        assert_eq!(
            estimate_reinvestment_size(source, spatial, 100_000),
            400_000
        );
        let richer = TargetCandidate {
            fps: 20,
            colors: 128,
            ..source
        };
        let estimate = estimate_reinvestment_size(source, richer, 100_000);
        assert!(estimate > 220_000 && estimate < 240_000, "{estimate}");
    }

    #[test]
    fn overshooting_width_is_corrected_strictly_inside_the_measured_bracket() {
        let lower = TargetCandidate {
            width: 240,
            fps: 12,
            colors: 96,
            bayer_scale: 2,
        };
        let upper = TargetCandidate {
            width: 480,
            colors: 160,
            ..lower
        };
        let corrected = correct_reinvestment_overshoot(lower, upper, 600_000, 1_400_000, 1_000_000)
            .expect("bounded correction");
        assert!(corrected.width > lower.width && corrected.width < upper.width);
        assert_eq!(corrected.width % 2, 0);
        assert_eq!(corrected.colors, lower.colors);
        assert_eq!(corrected.fps, lower.fps);
    }

    #[test]
    fn color_only_overshoot_is_corrected_without_changing_spatial_or_time_budget() {
        let lower = TargetCandidate {
            width: 480,
            fps: 12,
            colors: 64,
            bayer_scale: 2,
        };
        let upper = TargetCandidate {
            colors: 160,
            ..lower
        };
        let corrected = correct_reinvestment_overshoot(lower, upper, 500_000, 1_300_000, 900_000)
            .expect("color correction");
        assert_eq!(corrected.width, lower.width);
        assert_eq!(corrected.fps, lower.fps);
        assert!(corrected.colors > lower.colors && corrected.colors < upper.colors);
    }

    #[test]
    fn overshoot_correction_requires_a_real_under_over_bracket_and_headroom() {
        let lower = base();
        let upper = TargetCandidate {
            width: lower.width + 2,
            colors: lower.colors + 1,
            ..lower
        };
        assert!(correct_reinvestment_overshoot(lower, upper, 900, 1_100, 1_000).is_none());
        assert!(correct_reinvestment_overshoot(lower, upper, 1_000, 1_100, 1_000).is_none());
        assert!(correct_reinvestment_overshoot(lower, upper, 800, 900, 1_000).is_none());
    }
}
