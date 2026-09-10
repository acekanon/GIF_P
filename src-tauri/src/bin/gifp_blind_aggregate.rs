use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const HELP: &str = r#"GIFP blind-vote aggregator

Usage:
  gifp_blind_aggregate --report PATH --votes PATH [--votes PATH ...] [--output PATH]
    [--reference-profile ID --candidate-profile ID]

Defaults:
  --output tmp/quality-lab/blind-audit.json
  profile pair: first declared symmetric-match reference and its candidate

Only protocol-v2 votes tied to the same clean Quality Lab run are accepted.
"#;
const VOTE_SCHEMA_VERSION: u16 = 2;
const VOTE_PROTOCOL: &str = "gifp-paired-blind-v2";
const FORMAL_MAX_SIZE_DELTA_PERCENT: f64 = 5.0;
const MINIMUM_REVIEWER_COUNT: usize = 3;

#[derive(Debug)]
struct CliOptions {
    report_path: PathBuf,
    vote_paths: Vec<PathBuf>,
    output_path: PathBuf,
    reference_profile_id: Option<String>,
    candidate_profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QualityReport {
    schema_version: u16,
    run_id: String,
    manifest_sha256: String,
    git_commit: Option<String>,
    git_dirty: Option<bool>,
    manifest: ReportManifest,
    sources: Vec<ReportSource>,
    runs: Vec<ReportRun>,
}

#[derive(Debug, Deserialize)]
struct ReportManifest {
    corpus_id: String,
    profiles: Vec<ReportProfile>,
}

#[derive(Debug, Deserialize)]
struct ReportProfile {
    id: String,
    generation_mode: String,
    match_target_profile_id: Option<String>,
    target_constraint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReportSource {
    fixture_id: String,
    category: String,
}

#[derive(Debug, Deserialize)]
struct ReportRun {
    fixture_id: String,
    profile_id: String,
    status: String,
    metrics: Option<ReportMetrics>,
    correctness: Option<ReportCorrectness>,
}

#[derive(Debug, Deserialize)]
struct ReportMetrics {
    size_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct ReportCorrectness {
    all_passed: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct VoteBundle {
    schema_version: u16,
    protocol: String,
    run_id: String,
    corpus_id: String,
    manifest_sha256: String,
    git_commit: Option<String>,
    git_dirty: Option<bool>,
    reviewer_id: String,
    reviewer_label: Option<String>,
    exported_at: String,
    expected_pair_count: usize,
    available_pair_count: usize,
    formal_pair_count: usize,
    formal_vote_count: usize,
    votes: Vec<BlindVote>,
}

#[derive(Clone, Debug, Deserialize)]
struct BlindVote {
    fixture_id: String,
    category: String,
    formal_vote_eligible: bool,
    blind_vote_eligible: bool,
    choice: String,
    chosen_profile_id: Option<String>,
    candidate_a_profile_id: String,
    candidate_b_profile_id: String,
    first_voted_at: Option<String>,
    last_voted_at: Option<String>,
    revision_count: u32,
    identity_revealed_before_or_during_vote: bool,
}

#[derive(Clone, Debug)]
struct ExpectedPair {
    category: String,
    candidate_a_profile_id: String,
    candidate_b_profile_id: String,
    formal_vote_eligible: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
struct Tally {
    total_votes: usize,
    candidate_wins: usize,
    reference_wins: usize,
    ties: usize,
    decisive_votes: usize,
    candidate_decisive_win_rate: Option<f64>,
    candidate_preference_score: Option<f64>,
    decisive_win_rate_wilson_low_95: Option<f64>,
    decisive_win_rate_wilson_high_95: Option<f64>,
}

impl Tally {
    fn record(&mut self, outcome: VoteOutcome) {
        self.total_votes += 1;
        match outcome {
            VoteOutcome::Candidate => self.candidate_wins += 1,
            VoteOutcome::Reference => self.reference_wins += 1,
            VoteOutcome::Tie => self.ties += 1,
        }
        self.finish();
    }

    fn finish(&mut self) {
        self.decisive_votes = self.candidate_wins + self.reference_wins;
        self.candidate_decisive_win_rate = (self.decisive_votes > 0)
            .then(|| self.candidate_wins as f64 / self.decisive_votes as f64);
        self.candidate_preference_score = (self.total_votes > 0).then(|| {
            (self.candidate_wins as f64 + self.ties as f64 * 0.5) / self.total_votes as f64
        });
        let interval = wilson_interval_95(self.candidate_wins, self.decisive_votes);
        self.decisive_win_rate_wilson_low_95 = interval.map(|value| value.0);
        self.decisive_win_rate_wilson_high_95 = interval.map(|value| value.1);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VoteOutcome {
    Candidate,
    Reference,
    Tie,
}

#[derive(Debug, Serialize)]
struct ReviewerSummary {
    reviewer_id: String,
    reviewer_label: Option<String>,
    exported_at: String,
    formal_votes: usize,
    complete: bool,
}

#[derive(Debug, Serialize)]
struct AuditGates {
    minimum_reviewer_count: usize,
    reviewer_count_passed: bool,
    formal_vote_coverage_target: f64,
    formal_vote_coverage_passed: bool,
    overall_decisive_win_rate_target: f64,
    category_decisive_win_rate_floor: f64,
    overall_target_passed: Option<bool>,
    categories_below_floor: Vec<String>,
    categories_without_decisive_votes: Vec<String>,
    all_reviewers_complete: bool,
    quality_gate_passed: bool,
}

#[derive(Debug, Serialize)]
struct BlindAudit {
    schema_version: u16,
    generated_at_unix_ms: u128,
    quality_report_path: String,
    quality_report_schema_version: u16,
    run_id: String,
    corpus_id: String,
    manifest_sha256: String,
    git_commit: String,
    reviewer_count: usize,
    complete_reviewer_count: usize,
    formal_pair_count: usize,
    formal_vote_count: usize,
    exploratory_vote_count: usize,
    formal_vote_coverage_ratio: f64,
    reference_profile_id: String,
    candidate_profile_id: String,
    overall: Tally,
    categories: BTreeMap<String, Tally>,
    fixtures: BTreeMap<String, Tally>,
    reviewers: Vec<ReviewerSummary>,
    gates: AuditGates,
}

fn main() {
    if let Err(error) = run(env::args().skip(1)) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run<I, S>(args: I) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let Some(options) = parse_options(args)? else {
        println!("{HELP}");
        return Ok(());
    };
    let report: QualityReport = read_json(&options.report_path, "quality report")?;
    let bundles = options
        .vote_paths
        .iter()
        .map(|path| read_json(path, "vote bundle").map(|bundle| (path, bundle)))
        .collect::<Result<Vec<(&PathBuf, VoteBundle)>, String>>()?;
    let audit = aggregate_votes(
        &options.report_path,
        &report,
        &bundles,
        options.reference_profile_id.as_deref(),
        options.candidate_profile_id.as_deref(),
    )?;
    let mut json = serde_json::to_string_pretty(&audit)
        .map_err(|error| format!("Failed to serialize blind audit: {error}"))?;
    json.push('\n');
    if let Some(parent) = options
        .output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create audit directory {}: {error}",
                parent.display()
            )
        })?;
    }
    fs::write(&options.output_path, json).map_err(|error| {
        format!(
            "Failed to write audit {}: {error}",
            options.output_path.display()
        )
    })?;
    println!(
        "Blind audit: {} reviewers, {} formal votes, {:.1}% coverage",
        audit.reviewer_count,
        audit.formal_vote_count,
        audit.formal_vote_coverage_ratio * 100.0
    );
    println!("Report: {}", options.output_path.display());
    Ok(())
}

fn parse_options<I, S>(args: I) -> Result<Option<CliOptions>, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut values = args.into_iter().map(Into::into);
    let mut report_path = None;
    let mut vote_paths = Vec::new();
    let mut output_path = PathBuf::from("tmp/quality-lab/blind-audit.json");
    let mut reference_profile_id = None;
    let mut candidate_profile_id = None;
    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--report" => {
                report_path = Some(PathBuf::from(
                    values
                        .next()
                        .ok_or_else(|| "--report requires a path".to_string())?,
                ));
            }
            "--votes" => vote_paths.push(PathBuf::from(
                values
                    .next()
                    .ok_or_else(|| "--votes requires a path".to_string())?,
            )),
            "--output" => {
                output_path = PathBuf::from(
                    values
                        .next()
                        .ok_or_else(|| "--output requires a path".to_string())?,
                );
            }
            "--reference-profile" => {
                reference_profile_id = Some(
                    values
                        .next()
                        .ok_or_else(|| "--reference-profile requires an ID".to_string())?,
                );
            }
            "--candidate-profile" => {
                candidate_profile_id = Some(
                    values
                        .next()
                        .ok_or_else(|| "--candidate-profile requires an ID".to_string())?,
                );
            }
            "--help" | "-h" => return Ok(None),
            other => return Err(format!("Unknown option '{other}'.\n\n{HELP}")),
        }
    }
    let report_path = report_path.ok_or_else(|| format!("--report is required.\n\n{HELP}"))?;
    if vote_paths.is_empty() {
        return Err(format!("At least one --votes path is required.\n\n{HELP}"));
    }
    if reference_profile_id.is_some() != candidate_profile_id.is_some() {
        return Err(format!(
            "--reference-profile and --candidate-profile must be supplied together.\n\n{HELP}"
        ));
    }
    Ok(Some(CliOptions {
        report_path,
        vote_paths,
        output_path,
        reference_profile_id,
        candidate_profile_id,
    }))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("Failed to read {label} {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid {label} JSON {}: {error}", path.display()))
}

fn select_profiles<'a>(
    report: &'a QualityReport,
    reference_profile_id: Option<&str>,
    candidate_profile_id: Option<&str>,
) -> Result<(&'a ReportProfile, &'a ReportProfile), String> {
    let profiles = &report.manifest.profiles;
    let (reference, candidate) = match (reference_profile_id, candidate_profile_id) {
        (Some(reference_id), Some(candidate_id)) => {
            let reference = profiles
                .iter()
                .find(|profile| profile.id == reference_id)
                .ok_or_else(|| format!("Unknown reference profile '{reference_id}'"))?;
            let candidate = profiles
                .iter()
                .find(|profile| profile.id == candidate_id)
                .ok_or_else(|| format!("Unknown candidate profile '{candidate_id}'"))?;
            (reference, candidate)
        }
        (None, None) => {
            if let Some(reference) = profiles.iter().find(|profile| {
                profile.generation_mode == "target_size"
                    && matches!(
                        profile.target_constraint.as_deref(),
                        None | Some("symmetric_match")
                    )
                    && profile
                        .match_target_profile_id
                        .as_ref()
                        .is_some_and(|candidate_id| {
                            profiles.iter().any(|candidate| {
                                candidate.id == *candidate_id
                                    && candidate.generation_mode == "best_gif"
                            })
                        })
            }) {
                let candidate_id = reference
                    .match_target_profile_id
                    .as_deref()
                    .expect("selected symmetric reference has a candidate");
                let candidate = profiles
                    .iter()
                    .find(|profile| profile.id == candidate_id)
                    .expect("selected candidate was checked above");
                (reference, candidate)
            } else {
                let reference = profiles
                    .iter()
                    .find(|profile| profile.generation_mode == "fast_gif")
                    .ok_or_else(|| {
                        "Quality report has no symmetric target_size or fast_gif reference"
                            .to_string()
                    })?;
                let candidate = profiles
                    .iter()
                    .find(|profile| profile.generation_mode == "best_gif")
                    .ok_or_else(|| "Quality report has no best_gif candidate".to_string())?;
                (reference, candidate)
            }
        }
        _ => {
            return Err("Reference and candidate profile IDs must be supplied together".to_string())
        }
    };

    if candidate.generation_mode != "best_gif" {
        return Err(format!(
            "Blind candidate '{}' must use best_gif mode",
            candidate.id
        ));
    }
    match reference.generation_mode.as_str() {
        "fast_gif" => {}
        "target_size"
            if matches!(
                reference.target_constraint.as_deref(),
                None | Some("symmetric_match")
            ) && reference.match_target_profile_id.as_deref() == Some(candidate.id.as_str()) => {}
        "target_size" => {
            return Err(format!(
                "Blind reference '{}' is not a symmetric match for candidate '{}'",
                reference.id, candidate.id
            ))
        }
        _ => {
            return Err(format!(
                "Blind reference '{}' must use symmetric target_size or fast_gif mode",
                reference.id
            ))
        }
    }
    Ok((reference, candidate))
}

fn aggregate_votes(
    report_path: &Path,
    report: &QualityReport,
    bundles: &[(&PathBuf, VoteBundle)],
    reference_profile_id: Option<&str>,
    candidate_profile_id: Option<&str>,
) -> Result<BlindAudit, String> {
    let git_commit = report
        .git_commit
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Formal vote aggregation requires a report with a Git commit".to_string())?;
    if report.git_dirty != Some(false) {
        return Err("Formal vote aggregation requires git_dirty=false".to_string());
    }
    let (reference, candidate) =
        select_profiles(report, reference_profile_id, candidate_profile_id)?;
    let expected = expected_pairs(report, &reference.id, &candidate.id)?;
    let formal_pair_count = expected
        .values()
        .filter(|pair| pair.formal_vote_eligible)
        .count();
    let mut reviewer_ids = HashSet::new();
    let mut reviewers = Vec::with_capacity(bundles.len());
    let mut overall = Tally::default();
    let mut categories = BTreeMap::<String, Tally>::new();
    let mut fixtures = BTreeMap::<String, Tally>::new();
    let mut formal_vote_count = 0_usize;
    let mut exploratory_vote_count = 0_usize;

    for (path, bundle) in bundles {
        validate_bundle_header(report, bundle, git_commit, path)?;
        if !reviewer_ids.insert(bundle.reviewer_id.clone()) {
            return Err(format!(
                "Duplicate reviewer_id '{}' in {}",
                bundle.reviewer_id,
                path.display()
            ));
        }
        if bundle.expected_pair_count != report.sources.len()
            || bundle.available_pair_count != expected.len()
            || bundle.formal_pair_count != formal_pair_count
        {
            return Err(format!(
                "Vote counts in {} do not match the quality report",
                path.display()
            ));
        }
        let mut seen = HashSet::new();
        let mut reviewer_formal_votes = 0_usize;
        for vote in &bundle.votes {
            if !seen.insert(vote.fixture_id.clone()) {
                return Err(format!(
                    "Duplicate fixture '{}' in {}",
                    vote.fixture_id,
                    path.display()
                ));
            }
            let pair = expected.get(&vote.fixture_id).ok_or_else(|| {
                format!(
                    "Unknown fixture '{}' in {}",
                    vote.fixture_id,
                    path.display()
                )
            })?;
            validate_vote(vote, pair, candidate, reference, path)?;
            if vote.blind_vote_eligible {
                let outcome = vote_outcome(vote, &candidate.id, &reference.id)?;
                overall.record(outcome);
                categories
                    .entry(pair.category.clone())
                    .or_default()
                    .record(outcome);
                fixtures
                    .entry(vote.fixture_id.clone())
                    .or_default()
                    .record(outcome);
                formal_vote_count += 1;
                reviewer_formal_votes += 1;
            } else {
                exploratory_vote_count += 1;
            }
        }
        if reviewer_formal_votes != bundle.formal_vote_count {
            return Err(format!(
                "formal_vote_count mismatch in {}: declared {}, validated {}",
                path.display(),
                bundle.formal_vote_count,
                reviewer_formal_votes
            ));
        }
        reviewers.push(ReviewerSummary {
            reviewer_id: bundle.reviewer_id.clone(),
            reviewer_label: bundle.reviewer_label.clone(),
            exported_at: bundle.exported_at.clone(),
            formal_votes: reviewer_formal_votes,
            complete: reviewer_formal_votes == formal_pair_count,
        });
    }

    let complete_reviewer_count = reviewers
        .iter()
        .filter(|reviewer| reviewer.complete)
        .count();
    let possible_formal_votes = formal_pair_count.saturating_mul(reviewers.len());
    let coverage = if possible_formal_votes == 0 {
        0.0
    } else {
        formal_vote_count as f64 / possible_formal_votes as f64
    };
    let categories_below_floor = categories
        .iter()
        .filter_map(|(category, tally)| {
            tally
                .candidate_decisive_win_rate
                .filter(|rate| *rate < 0.45)
                .map(|_| category.clone())
        })
        .collect::<Vec<_>>();
    let expected_categories = expected
        .values()
        .filter(|pair| pair.formal_vote_eligible)
        .map(|pair| pair.category.clone())
        .collect::<HashSet<_>>();
    let mut categories_without_decisive_votes = expected_categories
        .into_iter()
        .filter(|category| {
            categories
                .get(category)
                .and_then(|tally| tally.candidate_decisive_win_rate)
                .is_none()
        })
        .collect::<Vec<_>>();
    categories_without_decisive_votes.sort();
    let all_reviewers_complete = complete_reviewer_count == reviewers.len();
    let reviewer_count_passed = reviewers.len() >= MINIMUM_REVIEWER_COUNT;
    let formal_vote_coverage_passed = (coverage - 1.0).abs() < f64::EPSILON;
    let overall_target_passed = overall.candidate_decisive_win_rate.map(|rate| rate >= 0.60);
    let quality_gate_passed = reviewer_count_passed
        && formal_vote_coverage_passed
        && all_reviewers_complete
        && overall_target_passed == Some(true)
        && categories_below_floor.is_empty()
        && categories_without_decisive_votes.is_empty();
    let gates = AuditGates {
        minimum_reviewer_count: MINIMUM_REVIEWER_COUNT,
        reviewer_count_passed,
        formal_vote_coverage_target: 1.0,
        formal_vote_coverage_passed,
        overall_decisive_win_rate_target: 0.60,
        category_decisive_win_rate_floor: 0.45,
        overall_target_passed,
        categories_below_floor,
        categories_without_decisive_votes,
        all_reviewers_complete,
        quality_gate_passed,
    };
    let generated_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before Unix epoch: {error}"))?
        .as_millis();
    Ok(BlindAudit {
        schema_version: 1,
        generated_at_unix_ms,
        quality_report_path: report_path.to_string_lossy().to_string(),
        quality_report_schema_version: report.schema_version,
        run_id: report.run_id.clone(),
        corpus_id: report.manifest.corpus_id.clone(),
        manifest_sha256: report.manifest_sha256.clone(),
        git_commit: git_commit.to_string(),
        reviewer_count: reviewers.len(),
        complete_reviewer_count,
        formal_pair_count,
        formal_vote_count,
        exploratory_vote_count,
        formal_vote_coverage_ratio: coverage,
        reference_profile_id: reference.id.clone(),
        candidate_profile_id: candidate.id.clone(),
        overall,
        categories,
        fixtures,
        reviewers,
        gates,
    })
}

fn validate_bundle_header(
    report: &QualityReport,
    bundle: &VoteBundle,
    git_commit: &str,
    path: &Path,
) -> Result<(), String> {
    let valid = bundle.schema_version == VOTE_SCHEMA_VERSION
        && bundle.protocol == VOTE_PROTOCOL
        && bundle.run_id == report.run_id
        && bundle.corpus_id == report.manifest.corpus_id
        && bundle.manifest_sha256 == report.manifest_sha256
        && bundle.git_commit.as_deref() == Some(git_commit)
        && bundle.git_dirty == Some(false)
        && !bundle.reviewer_id.trim().is_empty();
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Vote bundle {} does not match the clean Quality Lab run or protocol v2",
            path.display()
        ))
    }
}

fn expected_pairs(
    report: &QualityReport,
    reference_profile_id: &str,
    candidate_profile_id: &str,
) -> Result<HashMap<String, ExpectedPair>, String> {
    let mut output = HashMap::new();
    for source in &report.sources {
        let reference = find_run(report, &source.fixture_id, reference_profile_id)?;
        let candidate = find_run(report, &source.fixture_id, candidate_profile_id)?;
        if reference.status != "ok" || candidate.status != "ok" {
            continue;
        }
        let reference_metrics = reference.metrics.as_ref().ok_or_else(|| {
            format!(
                "{} / {reference_profile_id} has no metrics",
                source.fixture_id
            )
        })?;
        let candidate_metrics = candidate.metrics.as_ref().ok_or_else(|| {
            format!(
                "{} / {candidate_profile_id} has no metrics",
                source.fixture_id
            )
        })?;
        let reference_correct = reference
            .correctness
            .as_ref()
            .is_some_and(|value| value.all_passed);
        let candidate_correct = candidate
            .correctness
            .as_ref()
            .is_some_and(|value| value.all_passed);
        let formal = symmetric_size_delta_percent(
            reference_metrics.size_bytes,
            candidate_metrics.size_bytes,
        ) <= FORMAL_MAX_SIZE_DELTA_PERCENT
            && reference_correct
            && candidate_correct
            && report.git_dirty == Some(false)
            && report
                .git_commit
                .as_ref()
                .is_some_and(|value| !value.is_empty());
        let swap = assignment_swaps(&report.run_id, &source.fixture_id);
        let (candidate_a_profile_id, candidate_b_profile_id) = if swap {
            (candidate_profile_id, reference_profile_id)
        } else {
            (reference_profile_id, candidate_profile_id)
        };
        output.insert(
            source.fixture_id.clone(),
            ExpectedPair {
                category: source.category.clone(),
                candidate_a_profile_id: candidate_a_profile_id.to_string(),
                candidate_b_profile_id: candidate_b_profile_id.to_string(),
                formal_vote_eligible: formal,
            },
        );
    }
    Ok(output)
}

fn find_run<'a>(
    report: &'a QualityReport,
    fixture_id: &str,
    profile_id: &str,
) -> Result<&'a ReportRun, String> {
    report
        .runs
        .iter()
        .find(|run| run.fixture_id == fixture_id && run.profile_id == profile_id)
        .ok_or_else(|| format!("Missing run {fixture_id} / {profile_id}"))
}

fn validate_vote(
    vote: &BlindVote,
    expected: &ExpectedPair,
    candidate: &ReportProfile,
    reference: &ReportProfile,
    path: &Path,
) -> Result<(), String> {
    let choice_valid = matches!(vote.choice.as_str(), "A" | "B" | "same");
    let expected_chosen = match vote.choice.as_str() {
        "A" => Some(expected.candidate_a_profile_id.as_str()),
        "B" => Some(expected.candidate_b_profile_id.as_str()),
        "same" => None,
        _ => None,
    };
    let blind_eligible = expected.formal_vote_eligible
        && !vote.identity_revealed_before_or_during_vote
        && vote.first_voted_at.is_some()
        && vote.last_voted_at.is_some();
    let profiles_are_expected = [
        expected.candidate_a_profile_id.as_str(),
        expected.candidate_b_profile_id.as_str(),
    ]
    .into_iter()
    .collect::<HashSet<_>>()
        == [candidate.id.as_str(), reference.id.as_str()]
            .into_iter()
            .collect::<HashSet<_>>();
    let valid = vote.category == expected.category
        && vote.formal_vote_eligible == expected.formal_vote_eligible
        && vote.blind_vote_eligible == blind_eligible
        && vote.candidate_a_profile_id == expected.candidate_a_profile_id
        && vote.candidate_b_profile_id == expected.candidate_b_profile_id
        && vote.chosen_profile_id.as_deref() == expected_chosen
        && choice_valid
        && profiles_are_expected
        && vote.revision_count <= 1_000_000;
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Invalid or tampered vote for '{}' in {}",
            vote.fixture_id,
            path.display()
        ))
    }
}

fn vote_outcome(
    vote: &BlindVote,
    candidate_profile_id: &str,
    reference_profile_id: &str,
) -> Result<VoteOutcome, String> {
    match vote.choice.as_str() {
        "same" => Ok(VoteOutcome::Tie),
        "A" | "B" if vote.chosen_profile_id.as_deref() == Some(candidate_profile_id) => {
            Ok(VoteOutcome::Candidate)
        }
        "A" | "B" if vote.chosen_profile_id.as_deref() == Some(reference_profile_id) => {
            Ok(VoteOutcome::Reference)
        }
        _ => Err(format!("Vote '{}' has no valid outcome", vote.fixture_id)),
    }
}

fn assignment_swaps(run_id: &str, fixture_id: &str) -> bool {
    let digest = Sha256::digest(format!("{run_id}:{fixture_id}").as_bytes());
    digest.last().is_some_and(|value| value & 1 == 1)
}

fn symmetric_size_delta_percent(first: u64, second: u64) -> f64 {
    if first == 0 && second == 0 {
        return 0.0;
    }
    let first = first as f64;
    let second = second as f64;
    (first - second).abs() / ((first + second) / 2.0) * 100.0
}

fn wilson_interval_95(successes: usize, trials: usize) -> Option<(f64, f64)> {
    if trials == 0 || successes > trials {
        return None;
    }
    let z = 1.959_963_984_540_054_f64;
    let n = trials as f64;
    let p = successes as f64 / n;
    let denominator = 1.0 + z * z / n;
    let center = (p + z * z / (2.0 * n)) / denominator;
    let margin = z * ((p * (1.0 - p) / n + z * z / (4.0 * n * n)).sqrt()) / denominator;
    Some(((center - margin).max(0.0), (center + margin).min(1.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean_report() -> QualityReport {
        QualityReport {
            schema_version: 3,
            run_id: "clean-run".to_string(),
            manifest_sha256: "a".repeat(64),
            git_commit: Some("b".repeat(40)),
            git_dirty: Some(false),
            manifest: ReportManifest {
                corpus_id: "quality-corpus-v1".to_string(),
                profiles: vec![
                    ReportProfile {
                        id: "best-current".to_string(),
                        generation_mode: "best_gif".to_string(),
                        match_target_profile_id: None,
                        target_constraint: None,
                    },
                    ReportProfile {
                        id: "ffmpeg-size-match".to_string(),
                        generation_mode: "target_size".to_string(),
                        match_target_profile_id: Some("best-current".to_string()),
                        target_constraint: Some("symmetric_match".to_string()),
                    },
                    ReportProfile {
                        id: "regional-experimental".to_string(),
                        generation_mode: "best_gif".to_string(),
                        match_target_profile_id: None,
                        target_constraint: None,
                    },
                    ReportProfile {
                        id: "ffmpeg-regional-size-match".to_string(),
                        generation_mode: "target_size".to_string(),
                        match_target_profile_id: Some("regional-experimental".to_string()),
                        target_constraint: Some("symmetric_match".to_string()),
                    },
                ],
            },
            sources: vec![ReportSource {
                fixture_id: "fixture-a".to_string(),
                category: "motion".to_string(),
            }],
            runs: vec![
                ReportRun {
                    fixture_id: "fixture-a".to_string(),
                    profile_id: "ffmpeg-size-match".to_string(),
                    status: "ok".to_string(),
                    metrics: Some(ReportMetrics { size_bytes: 100 }),
                    correctness: Some(ReportCorrectness { all_passed: true }),
                },
                ReportRun {
                    fixture_id: "fixture-a".to_string(),
                    profile_id: "best-current".to_string(),
                    status: "ok".to_string(),
                    metrics: Some(ReportMetrics { size_bytes: 100 }),
                    correctness: Some(ReportCorrectness { all_passed: true }),
                },
                ReportRun {
                    fixture_id: "fixture-a".to_string(),
                    profile_id: "regional-experimental".to_string(),
                    status: "ok".to_string(),
                    metrics: Some(ReportMetrics { size_bytes: 100 }),
                    correctness: Some(ReportCorrectness { all_passed: true }),
                },
                ReportRun {
                    fixture_id: "fixture-a".to_string(),
                    profile_id: "ffmpeg-regional-size-match".to_string(),
                    status: "ok".to_string(),
                    metrics: Some(ReportMetrics { size_bytes: 100 }),
                    correctness: Some(ReportCorrectness { all_passed: true }),
                },
            ],
        }
    }

    fn complete_candidate_vote_for(
        report: &QualityReport,
        reviewer_id: &str,
        reference_profile_id: &str,
        candidate_profile_id: &str,
    ) -> VoteBundle {
        let swap = assignment_swaps(&report.run_id, "fixture-a");
        let (candidate_a, candidate_b, choice) = if swap {
            (candidate_profile_id, reference_profile_id, "A")
        } else {
            (reference_profile_id, candidate_profile_id, "B")
        };
        VoteBundle {
            schema_version: VOTE_SCHEMA_VERSION,
            protocol: VOTE_PROTOCOL.to_string(),
            run_id: report.run_id.clone(),
            corpus_id: report.manifest.corpus_id.clone(),
            manifest_sha256: report.manifest_sha256.clone(),
            git_commit: report.git_commit.clone(),
            git_dirty: report.git_dirty,
            reviewer_id: reviewer_id.to_string(),
            reviewer_label: None,
            exported_at: "2026-07-14T00:00:00.000Z".to_string(),
            expected_pair_count: 1,
            available_pair_count: 1,
            formal_pair_count: 1,
            formal_vote_count: 1,
            votes: vec![BlindVote {
                fixture_id: "fixture-a".to_string(),
                category: "motion".to_string(),
                formal_vote_eligible: true,
                blind_vote_eligible: true,
                choice: choice.to_string(),
                chosen_profile_id: Some(candidate_profile_id.to_string()),
                candidate_a_profile_id: candidate_a.to_string(),
                candidate_b_profile_id: candidate_b.to_string(),
                first_voted_at: Some("2026-07-14T00:00:00.000Z".to_string()),
                last_voted_at: Some("2026-07-14T00:00:00.000Z".to_string()),
                revision_count: 0,
                identity_revealed_before_or_during_vote: false,
            }],
        }
    }

    fn complete_candidate_vote(report: &QualityReport, reviewer_id: &str) -> VoteBundle {
        complete_candidate_vote_for(report, reviewer_id, "ffmpeg-size-match", "best-current")
    }

    #[test]
    fn symmetric_size_delta_uses_the_pair_mean() {
        assert_eq!(symmetric_size_delta_percent(100, 100), 0.0);
        assert!((symmetric_size_delta_percent(95, 100) - 5.128_205_128).abs() < 1e-6);
        assert_eq!(
            symmetric_size_delta_percent(95, 100),
            symmetric_size_delta_percent(100, 95)
        );
    }

    #[test]
    fn tally_reports_decisive_and_tie_aware_rates() {
        let mut tally = Tally::default();
        tally.record(VoteOutcome::Candidate);
        tally.record(VoteOutcome::Candidate);
        tally.record(VoteOutcome::Reference);
        tally.record(VoteOutcome::Tie);
        assert_eq!(tally.total_votes, 4);
        assert_eq!(tally.decisive_votes, 3);
        assert!((tally.candidate_decisive_win_rate.unwrap() - 2.0 / 3.0).abs() < 1e-12);
        assert!((tally.candidate_preference_score.unwrap() - 0.625).abs() < 1e-12);
    }

    #[test]
    fn wilson_interval_contains_the_observed_rate() {
        let (low, high) = wilson_interval_95(6, 10).expect("interval");
        assert!(low < 0.6 && high > 0.6);
        assert_eq!(wilson_interval_95(0, 0), None);
    }

    #[test]
    fn assignment_is_deterministic() {
        assert_eq!(
            assignment_swaps("run-a", "fixture-a"),
            assignment_swaps("run-a", "fixture-a")
        );
    }

    #[test]
    fn quality_gate_requires_three_complete_reviewers() {
        let report = clean_report();
        let first = complete_candidate_vote(&report, "reviewer-1");
        let first_path = PathBuf::from("reviewer-1.json");
        let one_reviewer = aggregate_votes(
            Path::new("report.json"),
            &report,
            &[(&first_path, first)],
            None,
            None,
        )
        .expect("single-reviewer audit");
        assert!(!one_reviewer.gates.reviewer_count_passed);
        assert!(!one_reviewer.gates.quality_gate_passed);

        let bundles = (1..=3)
            .map(|index| {
                (
                    PathBuf::from(format!("reviewer-{index}.json")),
                    complete_candidate_vote(&report, &format!("reviewer-{index}")),
                )
            })
            .collect::<Vec<_>>();
        let borrowed = bundles
            .iter()
            .map(|(path, bundle)| (path, bundle.clone()))
            .collect::<Vec<_>>();
        let three_reviewers =
            aggregate_votes(Path::new("report.json"), &report, &borrowed, None, None)
                .expect("full audit");
        assert_eq!(three_reviewers.formal_vote_coverage_ratio, 1.0);
        assert_eq!(three_reviewers.reference_profile_id, "ffmpeg-size-match");
        assert_eq!(three_reviewers.candidate_profile_id, "best-current");
        assert!(three_reviewers.gates.reviewer_count_passed);
        assert!(three_reviewers.gates.quality_gate_passed);
    }

    #[test]
    fn duplicate_reviewer_ids_are_rejected() {
        let report = clean_report();
        let first = complete_candidate_vote(&report, "reviewer-1");
        let duplicate = complete_candidate_vote(&report, "reviewer-1");
        let first_path = PathBuf::from("first.json");
        let duplicate_path = PathBuf::from("duplicate.json");
        let error = aggregate_votes(
            Path::new("report.json"),
            &report,
            &[(&first_path, first), (&duplicate_path, duplicate)],
            None,
            None,
        )
        .expect_err("duplicate reviewer should fail");
        assert!(error.contains("Duplicate reviewer_id"));
    }

    #[test]
    fn explicit_profile_pair_produces_an_independent_regional_audit() {
        let report = clean_report();
        let vote = complete_candidate_vote_for(
            &report,
            "reviewer-regional",
            "ffmpeg-regional-size-match",
            "regional-experimental",
        );
        let vote_path = PathBuf::from("regional.json");
        let audit = aggregate_votes(
            Path::new("report.json"),
            &report,
            &[(&vote_path, vote)],
            Some("ffmpeg-regional-size-match"),
            Some("regional-experimental"),
        )
        .expect("regional audit");
        assert_eq!(audit.reference_profile_id, "ffmpeg-regional-size-match");
        assert_eq!(audit.candidate_profile_id, "regional-experimental");
        assert_eq!(audit.overall.candidate_wins, 1);
    }

    #[test]
    fn vote_packet_for_another_profile_pair_is_rejected() {
        let report = clean_report();
        let default_vote = complete_candidate_vote(&report, "reviewer-default");
        let vote_path = PathBuf::from("default.json");
        let error = aggregate_votes(
            Path::new("report.json"),
            &report,
            &[(&vote_path, default_vote)],
            Some("ffmpeg-regional-size-match"),
            Some("regional-experimental"),
        )
        .expect_err("cross-pair vote must fail");
        assert!(error.contains("Invalid or tampered vote"), "{error}");
    }

    #[test]
    fn profile_selection_flags_must_be_supplied_together() {
        let error = parse_options([
            "--report",
            "report.json",
            "--votes",
            "votes.json",
            "--candidate-profile",
            "regional-experimental",
        ])
        .expect_err("half a profile pair must fail");
        assert!(error.contains("must be supplied together"), "{error}");
    }
}
