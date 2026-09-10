use crate::{
    commands::{
        convert_animation_inner, inspect_media_file, publish_file_atomically, GifRequest,
        GifResult, MediaInspection, TargetOptimizerReport,
    },
    core::{
        locate_ffmpeg, locate_ffprobe, TargetConstraint, ENCODE_REQUEST_SCHEMA_VERSION,
        REINVEST_SPATIAL_SAFETY_FACTOR,
    },
    quality_metrics::{evaluate_quality, ObjectiveQualityMetrics},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{self, Command},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
        Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

mod build_provenance;
use build_provenance::{
    current_executor_sha256, evaluate_build_provenance, tracked_tree_snapshot,
    BuildProvenanceEvidence, GitSnapshot,
};

const CORPUS_MANIFEST_SCHEMA_VERSION: u16 = 1;
const QUALITY_REPORT_SCHEMA_VERSION: u16 = 9;
const ARTIFACT_BUNDLE_SCHEMA_VERSION: u16 = 1;
const DURATION_TOLERANCE_MS: f64 = 20.0;
const ALPHA_COVERAGE_TOLERANCE: f64 = 0.02;
const SEMI_TRANSPARENT_ALPHA_COVERAGE_TOLERANCE: f64 = 0.04;
const LOOP_SEAM_EXCESS_TOLERANCE: f64 = 0.02;
const HARD_CAP_FILL_RATIO_FLOOR: f64 = 0.95;
const HARD_CAP_REQUIRED_HIT_RATE: f64 = 0.90;
const BEST_QUALITY_MAX_SIZE_DELTA_PERCENT: f64 = 5.0;
const BEST_QUALITY_MINIMUM_PAIR_COUNT: usize = 28;
const BEST_QUALITY_MINIMUM_CATEGORY_COUNT: usize = 7;
const BEST_QUALITY_REQUIRED_PAIR_COVERAGE: f64 = 1.0;
const BEST_QUALITY_REQUIRED_VMAF_WIN_RATE: f64 = 0.60;
const BEST_QUALITY_OVERALL_GUARD_MAX_LOSS_RATE: f64 = 0.25;
const BEST_QUALITY_CATEGORY_GUARD_MAX_LOSS_RATE: f64 = 0.25;
const BEST_QUALITY_OVERALL_GUARD_MIN_MEAN_TIE_UNITS: f64 = 0.0;
const BEST_QUALITY_CATEGORY_GUARD_MIN_MEAN_TIE_UNITS: f64 = -0.5;
const BEST_QUALITY_CANONICAL_CORPUS_ID: &str = "quality-corpus-v1";
const BEST_QUALITY_CANONICAL_MANIFEST_SHA256: &str =
    "b46be25216daf1d6760911f7f8546b5dd3418d6b07f0e68fe687770210fac37a";
const PROCESS_MEMORY_SAMPLE_INTERVAL_MS: u64 = 50;
const PROCESS_MEMORY_SAMPLER_ID: &str = "sysinfo.process_tree_rss.v3";
const QUALITY_COMMIT_LOCK_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(unix)]
const QUALITY_COMMIT_LOCK_POLL_INTERVAL: Duration = Duration::from_millis(25);
const QUALITY_STAGING_STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
static QUALITY_ARTIFACT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CLEANED_QUALITY_STAGING_DIRECTORIES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

const HELP: &str = r#"GIFP Quality Lab

Usage:
  gifp_quality_lab prepare [--manifest PATH] [--fixtures ID,ID,...]
  gifp_quality_lab run [--manifest PATH] [--output PATH] [--fixtures ID,ID,...]

Defaults:
  --manifest bench/corpus-manifest.json
  --output   tmp/quality-lab/latest.json

`run` normalizes manifest fixtures, invokes the same Fast/Best/Target conversion entry
point as the desktop app, then writes JSON, CSV, and paired blind-review HTML. Fixtures
may be reproducible lavfi sources or local external media pinned by SHA-256.
"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CorpusManifest {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    schema: Option<String>,
    schema_version: u16,
    corpus_id: String,
    #[serde(default)]
    description: String,
    fixture_root: String,
    canonical_fixture_identity: CanonicalFixtureIdentitySpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    coverage: Option<CoverageSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    performance_budget: Option<PerformanceBudgetSpec>,
    fixtures: Vec<FixtureSpec>,
    profiles: Vec<ProfileSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CanonicalFixtureIdentitySpec {
    contract_id: String,
    status: String,
    generator_ffmpeg_sha256: String,
    generator_ffprobe_sha256: String,
    reviewed_runtime_manifest_path: String,
    reviewed_runtime_manifest_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CoverageSpec {
    minimum_total: usize,
    minimum_per_category: usize,
    required_categories: Vec<String>,
    #[serde(default)]
    required_tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PerformanceBudgetSpec {
    profile_scope: String,
    required_build_profile: String,
    minimum_memory_coverage: f64,
    p95_encode_wall_elapsed_ms: u64,
    max_encode_wall_elapsed_ms: u64,
    p95_peak_tree_rss_bytes: u64,
    max_peak_tree_rss_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FixtureSpec {
    id: String,
    category: String,
    file: String,
    expected_source_sha256: Option<String>,
    duration_seconds: f64,
    #[serde(default)]
    tags: Vec<String>,
    generator: FixtureGenerator,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FixtureGenerator {
    kind: String,
    input: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    authorization: Option<String>,
    #[serde(default)]
    video_filter: Option<String>,
    #[serde(default = "default_fixture_pixel_format")]
    pixel_format: String,
}

fn default_fixture_pixel_format() -> String {
    "yuv444p".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProfileSpec {
    id: String,
    generation_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    match_target_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_constraint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_size_scale: Option<f64>,
    encoder: String,
    width: u32,
    fps: u32,
    colors: u16,
    dither: String,
    optimize_level: u8,
    lossy: u8,
    bayer_scale: u8,
    alpha_threshold: u8,
    filter_style: String,
    perceptual_focus: String,
    #[serde(default)]
    allow_experimental: bool,
}

impl ProfileSpec {
    fn effective_target_constraint(&self) -> TargetConstraint {
        self.target_constraint
            .as_deref()
            .and_then(TargetConstraint::parse)
            .unwrap_or_else(|| {
                if self.match_target_profile_id.is_some() {
                    TargetConstraint::SymmetricMatch
                } else {
                    TargetConstraint::HardCap
                }
            })
    }

    fn effective_target_size_scale(&self) -> f64 {
        self.target_size_scale.unwrap_or(1.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MatchedRequestCeiling {
    fps: u32,
    colors: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LabCommand {
    Prepare,
    Run,
}

#[derive(Debug)]
struct CliOptions {
    command: LabCommand,
    manifest_path: PathBuf,
    output_path: PathBuf,
    fixture_ids: Option<Vec<String>>,
}

#[derive(Debug)]
struct LoadedManifest {
    path: PathBuf,
    sha256: String,
    manifest: CorpusManifest,
}

#[derive(Debug)]
struct PreparedFixture {
    spec: FixtureSpec,
    path: PathBuf,
    sha256: String,
    inspection: MediaInspection,
}

#[derive(Debug, Serialize)]
struct HostSnapshot {
    os: String,
    os_version: Option<String>,
    kernel_version: Option<String>,
    arch: String,
    logical_parallelism: usize,
    physical_core_count: Option<usize>,
    cpu_brand: Option<String>,
    total_memory_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ToolchainSnapshot {
    gifp_version: String,
    build_profile: String,
    ffmpeg_path: String,
    ffmpeg_version: Option<String>,
    ffmpeg_sha256: String,
    ffprobe_path: String,
    ffprobe_version: Option<String>,
    ffprobe_sha256: String,
    reviewed_runtime_manifest_path: String,
    reviewed_runtime_manifest_sha256: Option<String>,
    canonical_generator_identity_passed: bool,
}

#[derive(Debug, Serialize)]
struct SourceSnapshot {
    fixture_id: String,
    category: String,
    tags: Vec<String>,
    path: String,
    sha256: String,
    expected_source_sha256: Option<String>,
    canonical_identity_passed: bool,
    inspection: MediaInspection,
}

#[derive(Debug, Serialize)]
struct QualityMetrics {
    size_bytes: u64,
    frame_count: u64,
    duration_seconds: f64,
    encode_elapsed_ms: u64,
    encode_wall_elapsed_ms: u64,
    encode_memory: Option<ProcessTreeMemoryMetrics>,
    metric_elapsed_ms: u64,
    total_wall_elapsed_ms: u64,
    objective: Option<ObjectiveQualityMetrics>,
}

#[derive(Clone, Debug, Serialize)]
struct ProcessTreeMemoryMetrics {
    sampler_id: String,
    metric: String,
    includes_root: bool,
    includes_descendants: bool,
    sample_interval_ms: u64,
    sample_count: u64,
    baseline_tree_rss_bytes: u64,
    peak_tree_rss_bytes: u64,
    peak_incremental_tree_rss_bytes: u64,
    max_process_count: usize,
    peak_processes: Vec<ProcessMemoryBreakdown>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct ProcessMemoryBreakdown {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    start_time_unix_seconds: u64,
    rss_bytes: u64,
    is_root: bool,
}

#[derive(Debug, Serialize)]
struct CorrectnessReport {
    duration_error_ms: f64,
    duration_passed: bool,
    frame_count_passed: bool,
    alpha_required: bool,
    alpha_coverage_tolerance: f64,
    alpha_passed: bool,
    seamless_loop_required: bool,
    seamless_loop_passed: bool,
    all_passed: bool,
    violations: Vec<String>,
}

#[derive(Debug, Serialize)]
struct QualityRunRecord {
    fixture_id: String,
    profile_id: String,
    status: String,
    source_sha256: String,
    request_sha256: String,
    request: Value,
    output_sha256: Option<String>,
    metrics: Option<QualityMetrics>,
    correctness: Option<CorrectnessReport>,
    output_inspection: Option<MediaInspection>,
    result: Option<GifResult>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct QualityLabReport {
    schema_version: u16,
    run_id: String,
    generated_at_unix_ms: u128,
    manifest_path: String,
    manifest_sha256: String,
    git_commit: Option<String>,
    git_dirty: Option<bool>,
    host: HostSnapshot,
    toolchain: ToolchainSnapshot,
    manifest: CorpusManifest,
    sources: Vec<SourceSnapshot>,
    successful_runs: usize,
    failed_runs: usize,
    target_reinvestment_calibration: TargetReinvestmentCalibrationReport,
    target_hard_cap_acceptance: HardCapAcceptanceReport,
    best_quality_acceptance: BestQualityAcceptanceReport,
    performance_baseline: PerformanceBaselineReport,
    runs: Vec<QualityRunRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact_bundle: Option<ArtifactBundleReference>,
    #[serde(skip)]
    provenance_context: QualityProvenanceContext,
    #[serde(skip)]
    build_provenance: Option<BuildProvenanceEvidence>,
}

#[derive(Clone, Debug)]
struct QualityProvenanceContext {
    repository_root: Option<PathBuf>,
    runtime_start: GitSnapshot,
    executor_start_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ArtifactBundleReference {
    schema_version: u16,
    run_id: String,
    root_path: String,
    manifest_path: String,
    manifest_sha256: String,
    artifacts: Vec<ArtifactBundleEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ArtifactBundleManifest {
    schema_version: u16,
    run_id: String,
    artifacts: Vec<ArtifactBundleEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct ArtifactBundleEntry {
    role: String,
    relative_path: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
struct PerformanceBaselineReport {
    baseline_id: String,
    build_profile: String,
    measurement_scope: String,
    memory_metric: String,
    memory_sampler_id: String,
    sample_interval_ms: u64,
    percentile_method: String,
    budget_evaluation: Option<PerformanceBudgetEvaluation>,
    overall: PerformanceBaselineSlice,
    profiles: Vec<PerformanceBaselineSlice>,
    categories: Vec<PerformanceBaselineSlice>,
}

#[derive(Debug, Serialize)]
struct PerformanceBudgetEvaluation {
    budget_id: String,
    profile_scope: String,
    profile_ids: Vec<String>,
    evaluated_run_count: usize,
    excluded_run_count: usize,
    actual: PerformanceBaselineSlice,
    required_build_profile: String,
    actual_build_profile: String,
    minimum_memory_coverage: f64,
    p95_encode_wall_elapsed_ms_limit: u64,
    max_encode_wall_elapsed_ms_limit: u64,
    p95_peak_tree_rss_bytes_limit: u64,
    max_peak_tree_rss_bytes_limit: u64,
    build_profile_passed: bool,
    memory_coverage_passed: bool,
    p95_encode_wall_elapsed_passed: bool,
    max_encode_wall_elapsed_passed: bool,
    p95_peak_tree_rss_passed: bool,
    max_peak_tree_rss_passed: bool,
    passed: bool,
    violations: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
struct PerformanceBaselineSlice {
    label: String,
    run_count: usize,
    timed_run_count: usize,
    memory_measured_run_count: usize,
    memory_coverage: Option<f64>,
    p50_encode_wall_elapsed_ms: Option<u64>,
    p95_encode_wall_elapsed_ms: Option<u64>,
    max_encode_wall_elapsed_ms: Option<u64>,
    p50_peak_tree_rss_bytes: Option<u64>,
    p95_peak_tree_rss_bytes: Option<u64>,
    max_peak_tree_rss_bytes: Option<u64>,
    p50_peak_incremental_tree_rss_bytes: Option<u64>,
    p95_peak_incremental_tree_rss_bytes: Option<u64>,
    max_peak_incremental_tree_rss_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
struct TargetReinvestmentCalibrationReport {
    calibration_id: String,
    baseline_spatial_safety_factor: f64,
    overall: TargetReinvestmentCalibrationSlice,
    categories: Vec<TargetReinvestmentCalibrationSlice>,
}

#[derive(Debug, Serialize)]
struct TargetReinvestmentCalibrationSlice {
    category: String,
    target_profile_run_count: usize,
    sample_count: usize,
    sample_rate: Option<f64>,
    initial_under_target_count: usize,
    initial_under_target_rate: Option<f64>,
    correction_attempt_count: usize,
    correction_success_count: usize,
    correction_success_rate: Option<f64>,
    mean_actual_to_predicted_ratio: Option<f64>,
    p95_actual_to_predicted_ratio: Option<f64>,
    recommended_spatial_safety_factor: Option<f64>,
}

#[derive(Debug, Serialize)]
struct HardCapAcceptanceReport {
    acceptance_id: String,
    fill_ratio_floor: f64,
    required_hit_rate: f64,
    overall: HardCapAcceptanceSlice,
    categories: Vec<HardCapAcceptanceSlice>,
}

#[derive(Debug, Serialize)]
struct HardCapAcceptanceSlice {
    category: String,
    target_run_count: usize,
    known_feasible_count: usize,
    unknown_feasibility_count: usize,
    accepted_hit_count: usize,
    undershoot_count: usize,
    overshoot_count: usize,
    unmeasurable_output_count: usize,
    correctness_failed_count: usize,
    hit_rate: Option<f64>,
    all_measurable_outputs_under_cap: bool,
    passed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BestQualityMetricDirection {
    HigherIsBetter,
    LowerIsBetter,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BestQualityMetricCondition {
    Always,
    StaticRegion,
    EdgeRegion,
    Transparent,
    SeamlessLoop,
}

impl BestQualityMetricDirection {
    fn wire_name(self) -> &'static str {
        match self {
            Self::HigherIsBetter => "higher_is_better",
            Self::LowerIsBetter => "lower_is_better",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct BestQualityMetricSpec {
    metric_id: &'static str,
    direction: BestQualityMetricDirection,
    condition: BestQualityMetricCondition,
    tie_absolute: f64,
    tie_relative: f64,
    severe_absolute: f64,
    severe_relative: f64,
}

const BEST_QUALITY_METRIC_SPECS: [BestQualityMetricSpec; 9] = [
    BestQualityMetricSpec {
        metric_id: "vmaf_neg_mean",
        direction: BestQualityMetricDirection::HigherIsBetter,
        condition: BestQualityMetricCondition::Always,
        tie_absolute: 0.25,
        tie_relative: 0.0,
        severe_absolute: 2.0,
        severe_relative: 0.0,
    },
    BestQualityMetricSpec {
        metric_id: "vmaf_neg_p05",
        direction: BestQualityMetricDirection::HigherIsBetter,
        condition: BestQualityMetricCondition::Always,
        tie_absolute: 0.50,
        tie_relative: 0.0,
        severe_absolute: 3.0,
        severe_relative: 0.0,
    },
    BestQualityMetricSpec {
        metric_id: "cambi_mean",
        direction: BestQualityMetricDirection::LowerIsBetter,
        condition: BestQualityMetricCondition::Always,
        tie_absolute: 0.02,
        tie_relative: 0.0,
        severe_absolute: 0.10,
        severe_relative: 0.0,
    },
    BestQualityMetricSpec {
        metric_id: "mean_oklab_error",
        direction: BestQualityMetricDirection::LowerIsBetter,
        condition: BestQualityMetricCondition::Always,
        tie_absolute: 0.0005,
        tie_relative: 0.0,
        severe_absolute: 0.003,
        severe_relative: 0.0,
    },
    BestQualityMetricSpec {
        metric_id: "edge_error",
        direction: BestQualityMetricDirection::LowerIsBetter,
        condition: BestQualityMetricCondition::EdgeRegion,
        tie_absolute: 0.0002,
        tie_relative: 0.02,
        severe_absolute: 0.005,
        severe_relative: 0.10,
    },
    BestQualityMetricSpec {
        metric_id: "static_region_temporal_residual",
        direction: BestQualityMetricDirection::LowerIsBetter,
        condition: BestQualityMetricCondition::StaticRegion,
        tie_absolute: 0.00005,
        tie_relative: 0.0,
        severe_absolute: 0.0002,
        severe_relative: 0.0,
    },
    BestQualityMetricSpec {
        metric_id: "alpha_coverage_error",
        direction: BestQualityMetricDirection::LowerIsBetter,
        condition: BestQualityMetricCondition::Transparent,
        tie_absolute: 0.001,
        tie_relative: 0.0,
        severe_absolute: 0.01,
        severe_relative: 0.0,
    },
    BestQualityMetricSpec {
        metric_id: "alpha_mean_absolute_error",
        direction: BestQualityMetricDirection::LowerIsBetter,
        condition: BestQualityMetricCondition::Transparent,
        tie_absolute: 0.001,
        tie_relative: 0.0,
        severe_absolute: 0.01,
        severe_relative: 0.0,
    },
    BestQualityMetricSpec {
        metric_id: "loop_seam_excess_oklab",
        direction: BestQualityMetricDirection::LowerIsBetter,
        condition: BestQualityMetricCondition::SeamlessLoop,
        tie_absolute: 0.001,
        tie_relative: 0.0,
        severe_absolute: 0.005,
        severe_relative: 0.0,
    },
];

#[derive(Debug, Serialize)]
struct BestQualityAcceptanceReport {
    acceptance_id: String,
    corpus_id: String,
    corpus_manifest_sha256: String,
    canonical_corpus_passed: bool,
    canonical_fixture_identity_passed: bool,
    applicable: bool,
    candidate_profile_id: Option<String>,
    reference_profile_id: Option<String>,
    maximum_size_delta_percent: f64,
    minimum_pair_count: usize,
    minimum_category_count: usize,
    required_pair_coverage: f64,
    required_vmaf_win_rate: f64,
    provenance_passed: bool,
    expected_pair_count: usize,
    eligible_pair_count: usize,
    omitted_pair_count: usize,
    pair_coverage: Option<f64>,
    overall: BestQualityAcceptanceSlice,
    categories: Vec<BestQualityAcceptanceSlice>,
    pairs: Vec<BestQualityPairObservation>,
    omissions: Vec<BestQualityPairOmission>,
    passed: bool,
    violations: Vec<String>,
}

#[derive(Debug, Serialize)]
struct BestQualityAcceptanceSlice {
    category: String,
    expected_pair_count: usize,
    eligible_pair_count: usize,
    pair_coverage: Option<f64>,
    metrics: Vec<BestQualityMetricSummary>,
    passed: bool,
}

#[derive(Debug, Serialize)]
struct BestQualityMetricSummary {
    metric_id: String,
    direction: String,
    applicable_pair_count: usize,
    win_count: usize,
    tie_count: usize,
    loss_count: usize,
    win_rate: Option<f64>,
    loss_rate: Option<f64>,
    decisive_count: usize,
    decisive_win_rate: Option<f64>,
    mean_quality_improvement: Option<f64>,
    mean_quality_improvement_in_tie_units: Option<f64>,
    minimum_quality_improvement: Option<f64>,
    p05_quality_improvement: Option<f64>,
    median_quality_improvement: Option<f64>,
    p95_quality_improvement: Option<f64>,
    maximum_quality_improvement: Option<f64>,
    severe_regression_count: usize,
    passed: bool,
}

#[derive(Debug, Serialize)]
struct BestQualityPairObservation {
    fixture_id: String,
    category: String,
    candidate_size_bytes: u64,
    reference_size_bytes: u64,
    size_delta_percent: f64,
    candidate_output_sha256: String,
    reference_output_sha256: String,
    metrics: Vec<BestQualityMetricComparison>,
}

#[derive(Clone, Debug, Serialize)]
struct BestQualityMetricComparison {
    metric_id: String,
    direction: String,
    candidate_value: f64,
    reference_value: f64,
    quality_improvement: f64,
    quality_improvement_in_tie_units: f64,
    tie_tolerance: f64,
    severe_regression_tolerance: f64,
    outcome: String,
    severe_regression: bool,
}

#[derive(Debug, Serialize)]
struct BestQualityPairOmission {
    fixture_id: String,
    category: String,
    reason: String,
}

#[derive(Clone, Debug, Default)]
struct HardCapAcceptanceAccumulator {
    target_run_count: usize,
    known_feasible_count: usize,
    unknown_feasibility_count: usize,
    accepted_hit_count: usize,
    undershoot_count: usize,
    overshoot_count: usize,
    unmeasurable_output_count: usize,
    correctness_failed_count: usize,
}

#[derive(Default)]
struct TargetReinvestmentCalibrationAccumulator {
    target_profile_run_count: usize,
    sample_ratios: Vec<f64>,
    initial_under_target_count: usize,
    correction_attempt_count: usize,
    correction_success_count: usize,
}

#[derive(Default)]
struct PerformanceBaselineAccumulator {
    run_count: usize,
    encode_wall_elapsed_ms: Vec<u64>,
    peak_tree_rss_bytes: Vec<u64>,
    peak_incremental_tree_rss_bytes: Vec<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProcessTreeMemorySnapshot {
    rss_bytes: u64,
    process_count: usize,
    processes: Vec<ProcessMemoryBreakdown>,
}

struct ProcessTreeMemorySampler {
    stop: mpsc::Sender<()>,
    worker: JoinHandle<Option<ProcessTreeMemoryMetrics>>,
}

impl ProcessTreeMemorySampler {
    fn start() -> Option<Self> {
        if !sysinfo::IS_SUPPORTED_SYSTEM {
            return None;
        }
        let root_pid = sysinfo::get_current_pid().ok()?;
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("gifp-memory-sampler".to_string())
            .spawn(move || {
                let mut system = System::new();
                let Some(baseline) = refresh_process_tree_memory(&mut system, root_pid) else {
                    let _ = ready_tx.send(false);
                    return None;
                };
                if ready_tx.send(true).is_err() {
                    return None;
                }

                let mut peak = baseline.clone();
                let mut max_process_count = baseline.process_count;
                let mut sample_count = 1_u64;
                let interval = Duration::from_millis(PROCESS_MEMORY_SAMPLE_INTERVAL_MS);
                loop {
                    let stop = match stop_rx.recv_timeout(interval) {
                        Ok(()) | Err(RecvTimeoutError::Disconnected) => true,
                        Err(RecvTimeoutError::Timeout) => false,
                    };
                    if let Some(sample) = refresh_process_tree_memory(&mut system, root_pid) {
                        retain_strict_process_tree_peak(&mut peak, &sample);
                        max_process_count = max_process_count.max(sample.process_count);
                        sample_count = sample_count.saturating_add(1);
                    }
                    if stop {
                        break;
                    }
                }

                if !valid_peak_process_breakdown(&peak.processes, peak.rss_bytes) {
                    return None;
                }

                Some(ProcessTreeMemoryMetrics {
                    sampler_id: PROCESS_MEMORY_SAMPLER_ID.to_string(),
                    metric: "summed_resident_set_bytes".to_string(),
                    includes_root: true,
                    includes_descendants: true,
                    sample_interval_ms: PROCESS_MEMORY_SAMPLE_INTERVAL_MS,
                    sample_count,
                    baseline_tree_rss_bytes: baseline.rss_bytes,
                    peak_tree_rss_bytes: peak.rss_bytes,
                    peak_incremental_tree_rss_bytes: peak
                        .rss_bytes
                        .saturating_sub(baseline.rss_bytes),
                    max_process_count,
                    peak_processes: peak.processes,
                })
            })
            .ok()?;
        match ready_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(true) => Some(Self {
                stop: stop_tx,
                worker,
            }),
            Ok(false) | Err(_) => {
                let _ = stop_tx.send(());
                let _ = worker.join();
                None
            }
        }
    }

    fn finish(self) -> Option<ProcessTreeMemoryMetrics> {
        let _ = self.stop.send(());
        self.worker.join().ok().flatten()
    }
}

fn retain_strict_process_tree_peak(
    peak: &mut ProcessTreeMemorySnapshot,
    sample: &ProcessTreeMemorySnapshot,
) {
    if sample.rss_bytes > peak.rss_bytes {
        peak.clone_from(sample);
    }
}

fn sort_process_breakdown(processes: &mut [ProcessMemoryBreakdown]) {
    processes.sort_by(|left, right| {
        right
            .rss_bytes
            .cmp(&left.rss_bytes)
            .then_with(|| left.pid.cmp(&right.pid))
    });
}

fn valid_peak_process_breakdown(
    processes: &[ProcessMemoryBreakdown],
    peak_tree_rss_bytes: u64,
) -> bool {
    if processes.is_empty() || processes.iter().filter(|process| process.is_root).count() != 1 {
        return false;
    }
    let unique_pid_count = processes
        .iter()
        .map(|process| process.pid)
        .collect::<HashSet<_>>()
        .len();
    if unique_pid_count != processes.len() {
        return false;
    }
    let process_ids = processes
        .iter()
        .map(|process| process.pid)
        .collect::<HashSet<_>>();
    let root_process = processes
        .iter()
        .find(|process| process.is_root)
        .expect("the single root was checked above");
    if processes
        .iter()
        .any(|process| process.start_time_unix_seconds == 0)
        || root_process
            .parent_pid
            .is_some_and(|parent_pid| process_ids.contains(&parent_pid))
    {
        return false;
    }
    let root_pid = Pid::from_u32(root_process.pid);
    let process_nodes = processes
        .iter()
        .map(|process| {
            (
                Pid::from_u32(process.pid),
                process.parent_pid.map(Pid::from_u32),
                process.start_time_unix_seconds,
            )
        })
        .collect::<Vec<_>>();
    descendant_process_ids(root_pid, &process_nodes).len() == processes.len()
        && processes.iter().fold(0_u64, |total, process| {
            total.saturating_add(process.rss_bytes)
        }) == peak_tree_rss_bytes
}

fn descendant_process_ids(root: Pid, process_nodes: &[(Pid, Option<Pid>, u64)]) -> HashSet<Pid> {
    let start_times = process_nodes
        .iter()
        .map(|(pid, _, start_time)| (*pid, *start_time))
        .collect::<HashMap<_, _>>();
    let mut included = HashSet::from([root]);
    loop {
        let mut changed = false;
        for (pid, parent, start_time) in process_nodes {
            let current_parent = parent.as_ref().is_some_and(|parent_pid| {
                included.contains(parent_pid)
                    && start_times
                        .get(parent_pid)
                        .is_some_and(|parent_start_time| {
                            // sysinfo exposes whole seconds, so real parent/child starts may tie.
                            *start_time != 0
                                && *parent_start_time != 0
                                && start_time >= parent_start_time
                        })
            });
            if current_parent && included.insert(*pid) {
                changed = true;
            }
        }
        if !changed {
            return included;
        }
    }
}

fn refresh_process_tree_memory(
    system: &mut System,
    root_pid: Pid,
) -> Option<ProcessTreeMemorySnapshot> {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().without_tasks(),
    );
    system.process(root_pid)?;
    let process_nodes = system
        .processes()
        .iter()
        .map(|(pid, process)| (*pid, process.parent(), process.start_time()))
        .collect::<Vec<_>>();
    let process_ids = descendant_process_ids(root_pid, &process_nodes);
    let mut processes = process_ids
        .iter()
        .filter_map(|pid| {
            let process = system.process(*pid)?;
            let process_name = process.name().to_string_lossy();
            Some(ProcessMemoryBreakdown {
                pid: pid.as_u32(),
                parent_pid: process.parent().map(Pid::as_u32),
                name: if process_name.is_empty() {
                    "<unknown>".to_string()
                } else {
                    process_name.into_owned()
                },
                start_time_unix_seconds: process.start_time(),
                rss_bytes: process.memory(),
                is_root: *pid == root_pid,
            })
        })
        .collect::<Vec<_>>();
    sort_process_breakdown(&mut processes);
    let rss_bytes = processes.iter().fold(0_u64, |total, process| {
        total.saturating_add(process.rss_bytes)
    });
    Some(ProcessTreeMemorySnapshot {
        rss_bytes,
        process_count: processes.len(),
        processes,
    })
}

#[derive(Debug, Serialize)]
struct BlindReportData {
    schema_version: u16,
    run_id: String,
    generated_at_unix_ms: u128,
    corpus_id: String,
    manifest_sha256: String,
    git_commit: Option<String>,
    git_dirty: Option<bool>,
    reference_profile_id: String,
    candidate_profile_id: String,
    formal_max_size_delta_percent: f64,
    expected_pairs: usize,
    available_pairs: usize,
    omitted_pairs: Vec<BlindOmission>,
    pairs: Vec<BlindPair>,
}

#[derive(Debug, Serialize)]
struct BlindOmission {
    fixture_id: String,
    reason: String,
}

#[derive(Debug, Serialize)]
struct BlindPair {
    fixture_id: String,
    category: String,
    tags: Vec<String>,
    size_delta_percent: f64,
    formal_vote_eligible: bool,
    candidate_a: BlindCandidate,
    candidate_b: BlindCandidate,
}

#[derive(Debug, Serialize)]
struct BlindCandidate {
    profile_id: String,
    generation_mode: String,
    image_src: String,
    correctness_passed: bool,
    size_bytes: u64,
    frame_count: u64,
    duration_seconds: f64,
    encode_elapsed_ms: u64,
    encoder_used: String,
    backend_id: String,
    palette_strategy: String,
    target_size_bytes: Option<u64>,
    target_deviation_percent: Option<f64>,
    target_attempts: u8,
    target_fit_status: String,
    vmaf_neg_mean: f64,
    vmaf_neg_p05: f64,
    ssim_mean: f64,
    ms_ssim_mean: Option<f64>,
    ms_ssim_valid_ratio: f64,
    ciede2000_mean: Option<f64>,
    ciede2000_valid_ratio: f64,
    cambi_mean: f64,
    mean_oklab_error: f64,
    static_region_temporal_residual: f64,
    edge_preservation: f64,
    alpha_coverage_error: f64,
    loop_seam_excess_oklab: f64,
}

#[derive(Debug)]
struct BlindReportArtifact {
    path: PathBuf,
    reference_profile_id: String,
    candidate_profile_id: String,
    available_pairs: usize,
}

#[derive(Debug)]
struct QualityCommitLock {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(unix)]
    file: Option<File>,
}

impl QualityCommitLock {
    fn acquire(artifact_path: &Path) -> Result<Self, String> {
        Self::acquire_with_timeout(artifact_path, QUALITY_COMMIT_LOCK_TIMEOUT)
    }

    fn acquire_with_timeout(artifact_path: &Path, timeout: Duration) -> Result<Self, String> {
        let (parent, digest) = quality_artifact_family_identity(artifact_path)?;

        #[cfg(windows)]
        {
            let _ = parent;
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::{
                Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::{CreateMutexW, WaitForSingleObject},
            };

            let name = format!("Local\\GIFP.QualityLab.{digest}");
            let wide = std::ffi::OsStr::new(&name)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
            if handle.is_null() {
                return Err(format!(
                    "Failed to create Quality Lab kernel mutex {name}: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let timeout_ms = timeout.as_millis().min(u128::from(u32::MAX)) as u32;
            let wait = unsafe { WaitForSingleObject(handle, timeout_ms) };
            if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
                return Ok(Self { handle });
            }
            unsafe {
                CloseHandle(handle);
            }
            if wait == WAIT_TIMEOUT {
                return Err(format!(
                    "Timed out waiting for Quality Lab kernel mutex {name}"
                ));
            }
            Err(format!(
                "Failed waiting for Quality Lab kernel mutex {name}: {}",
                std::io::Error::last_os_error()
            ))
        }

        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;

            let guard_path = parent.join(format!(".gifp-quality-kernel-{digest}.guard"));
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .open(&guard_path)
                .map_err(|error| {
                    format!(
                        "Failed to open Quality Lab kernel lock {}: {error}",
                        guard_path.display()
                    )
                })?;
            let started = Instant::now();
            loop {
                let locked =
                    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
                if locked == 0 {
                    return Ok(Self { file: Some(file) });
                }
                let error = std::io::Error::last_os_error();
                let busy = error
                    .raw_os_error()
                    .is_some_and(|code| code == libc::EWOULDBLOCK || code == libc::EAGAIN);
                if !busy {
                    return Err(format!(
                        "Failed to acquire Quality Lab kernel lock {}: {error}",
                        guard_path.display()
                    ));
                }
                if started.elapsed() >= timeout {
                    return Err(format!(
                        "Timed out waiting for Quality Lab kernel lock {}",
                        guard_path.display()
                    ));
                }
                thread::sleep(QUALITY_COMMIT_LOCK_POLL_INTERVAL);
            }
        }

        #[cfg(not(any(windows, unix)))]
        {
            let _ = (parent, digest, timeout);
            Err("Quality Lab kernel commit locks are unsupported on this platform".to_string())
        }
    }
}

fn quality_artifact_family_identity(artifact_path: &Path) -> Result<(PathBuf, String), String> {
    let artifact_path = absolute_path(artifact_path)?;
    let parent = artifact_path.parent().ok_or_else(|| {
        format!(
            "Artifact path {} has no parent directory",
            artifact_path.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create Quality Lab artifact directory {}: {error}",
            parent.display()
        )
    })?;
    let parent = fs::canonicalize(parent).map_err(|error| {
        format!(
            "Failed to canonicalize Quality Lab artifact directory {}: {error}",
            parent.display()
        )
    })?;
    let stem = artifact_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "Artifact path {} has no UTF-8 stem",
                artifact_path.display()
            )
        })?;
    let mut family = format!("{}\n{stem}", parent.to_string_lossy());
    #[cfg(windows)]
    {
        family = family.to_lowercase();
    }
    Ok((parent, sha256_bytes(family.as_bytes())))
}

fn process_is_live(owner_pid: u32) -> Option<bool> {
    if !sysinfo::IS_SUPPORTED_SYSTEM {
        return None;
    }
    let owner_pid = Pid::from_u32(owner_pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[owner_pid]),
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    Some(system.process(owner_pid).is_some())
}

impl Drop for QualityCommitLock {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::ReleaseMutex};
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
        #[cfg(unix)]
        if let Some(file) = self.file.take() {
            use std::os::fd::AsRawFd;
            unsafe {
                libc::flock(file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

fn unique_quality_token() -> String {
    let sequence = QUALITY_ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{sequence}", unix_millis(), process::id())
}

fn cleanup_stale_quality_staging_files(parent: &Path) {
    if !sysinfo::IS_SUPPORTED_SYSTEM {
        return;
    }
    let directory = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let should_scan = CLEANED_QUALITY_STAGING_DIRECTORIES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map(|mut scanned| scanned.insert(directory.clone()))
        .unwrap_or(false);
    if !should_scan {
        return;
    }

    let now_ms = unix_millis();
    let stale_after_ms = QUALITY_STAGING_STALE_AFTER.as_millis();
    let candidates = fs::read_dir(&directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() {
                return None;
            }
            let file_name = entry.file_name();
            let (created_ms, owner_pid) = quality_staging_owner(file_name.to_str()?)?;
            let token_is_stale = now_ms
                .checked_sub(created_ms)
                .is_some_and(|age| age >= stale_after_ms);
            let file_is_stale = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age >= QUALITY_STAGING_STALE_AFTER);
            (token_is_stale && file_is_stale).then_some((entry.path(), owner_pid))
        })
        .collect::<Vec<_>>();
    for (path, owner_pid) in candidates {
        if process_is_live(owner_pid).is_some_and(|live| !live) {
            let _ = fs::remove_file(path);
        }
    }
}

fn quality_staging_owner(file_name: &str) -> Option<(u128, u32)> {
    let token = file_name.strip_prefix(".gifp-quality-")?;
    let mut parts = token.splitn(3, '-');
    let created_ms = parts.next()?.parse::<u128>().ok()?;
    let owner_pid = parts.next()?.parse::<u32>().ok().filter(|pid| *pid > 0)?;
    let (sequence, extension) = parts.next()?.split_once('.')?;
    sequence.parse::<u64>().ok()?;
    if extension.is_empty() {
        return None;
    }
    Some((created_ms, owner_pid))
}

fn reserve_quality_staging_file(parent: &Path, extension: &str) -> Result<(PathBuf, File), String> {
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create Quality Lab staging directory {}: {error}",
            parent.display()
        )
    })?;
    cleanup_stale_quality_staging_files(parent);
    for _ in 0..128 {
        let path = parent.join(format!(
            ".gifp-quality-{}.{}",
            unique_quality_token(),
            extension
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to reserve Quality Lab staging file {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Err(format!(
        "Failed to reserve a unique Quality Lab staging file in {}",
        parent.display()
    ))
}

fn write_bytes_atomically(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let path = absolute_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path {} has no parent", path.display()))?;
    let (staged, mut file) = reserve_quality_staging_file(parent, "stage")?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|error| format!("Failed to stage {label} {}: {error}", staged.display()))?;
        file.flush()
            .map_err(|error| format!("Failed to flush {label} {}: {error}", staged.display()))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync {label} {}: {error}", staged.display()))?;
        drop(file);
        publish_file_atomically(&staged, &path, true).map_err(|error| {
            format!(
                "Failed to atomically publish {label} {}: {error}",
                path.display()
            )
        })
    })();
    let _ = fs::remove_file(&staged);
    result
}

fn create_exclusive_run_root(
    report_parent: &Path,
    revision: &str,
    generated_at_unix_ms: u128,
) -> Result<(String, PathBuf), String> {
    let runs_root = report_parent.join("runs");
    fs::create_dir_all(&runs_root).map_err(|error| {
        format!(
            "Failed to create Quality Lab runs directory {}: {error}",
            runs_root.display()
        )
    })?;
    for _ in 0..128 {
        let sequence = QUALITY_ARTIFACT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let run_id = format!(
            "{revision}-{generated_at_unix_ms}-{}-{sequence}",
            process::id()
        );
        let run_root = runs_root.join(&run_id);
        match fs::create_dir(&run_root) {
            Ok(()) => return Ok((run_id, run_root)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create exclusive run directory {}: {error}",
                    run_root.display()
                ));
            }
        }
    }
    Err(format!(
        "Failed to reserve an exclusive Quality Lab run directory under {}",
        runs_root.display()
    ))
}

/// Runs the offline quality-lab CLI without exposing product UI or Tauri state.
pub fn run_cli<I, S>(args: I) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let Some(options) = parse_cli_options(args)? else {
        println!("{HELP}");
        return Ok(());
    };
    // Provenance covers manifest parsing and fixture preparation as well as
    // the encoder run itself; fixture generation can be long-running and is
    // part of the execution represented by the final report.
    let repository_root = git_repository_root(
        options
            .manifest_path
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    );
    let provenance_context = QualityProvenanceContext {
        runtime_start: capture_runtime_git_snapshot(repository_root.as_deref()),
        repository_root,
        executor_start_sha256: current_executor_sha256()?,
    };
    let loaded = load_manifest(&options.manifest_path)?;
    let ffmpeg = resolve_executable(locate_ffmpeg().map_err(|error| error.to_string())?);
    let ffprobe = resolve_executable(locate_ffprobe().map_err(|error| error.to_string())?);
    let toolchain = capture_toolchain_snapshot(
        &loaded,
        &ffmpeg,
        &ffprobe,
        provenance_context.repository_root.as_deref(),
    )?;
    require_canonical_generator_identity(&loaded.manifest, &toolchain)?;
    let selected_fixtures =
        select_fixture_specs(&loaded.manifest.fixtures, options.fixture_ids.as_deref())?;
    let prepared = prepare_fixtures(&loaded, &selected_fixtures, &ffmpeg, &ffprobe)?;

    if options.command == LabCommand::Prepare {
        println!(
            "Prepared {} fixtures from {}",
            prepared.len(),
            loaded.path.display()
        );
        for fixture in prepared {
            println!(
                "  {}  {}  {} frames  {:.3}s",
                fixture.spec.id,
                fixture.sha256,
                fixture.inspection.frame_count,
                fixture.inspection.duration
            );
        }
        return Ok(());
    }

    let (mut report, run_root) = run_manifest(
        &loaded,
        prepared,
        &ffmpeg,
        &ffprobe,
        &options.output_path,
        provenance_context,
        toolchain,
    )?;
    refresh_report_build_provenance(&mut report)?;
    let artifact_bundle = write_report_bundle(&run_root, &report)?;
    report.artifact_bundle = Some(artifact_bundle);
    let hard_cap_gate_failed = report.target_hard_cap_acceptance.overall.target_run_count > 0
        && !report.target_hard_cap_acceptance.overall.passed;
    let performance_gate_failed = report
        .performance_baseline
        .budget_evaluation
        .as_ref()
        .is_some_and(|evaluation| !evaluation.passed);
    let csv_path = sibling_artifact_path(&options.output_path, "", "csv")?;
    let blind_path = sibling_artifact_path(&options.output_path, "-blind", "html")?;
    verify_report_build_provenance_seal(&report, "before acquiring the commit lock")?;
    let blind_reports = {
        let _commit_lock = QualityCommitLock::acquire(&options.output_path)?;
        // These flat siblings are compatibility mirrors only. Transactional
        // readers follow `artifact_bundle` from the JSON commit point.
        write_csv_report(&csv_path, &report)?;
        let blind_reports = write_blind_reports(&blind_path, &report)?;
        // Serialize and fsync the commit-point bytes first, then perform the
        // final provenance/bundle checks immediately before the single atomic
        // replacement visible to transactional readers.
        write_report_commit_point(&options.output_path, &report)?;
        blind_reports
    };
    println!(
        "Quality Lab completed: {} passed, {} failed",
        report.successful_runs, report.failed_runs
    );
    println!("Report: {}", absolute_path(&options.output_path)?.display());
    println!("CSV: {}", absolute_path(&csv_path)?.display());
    for (index, artifact) in blind_reports.iter().enumerate() {
        let label = if index == 0 {
            "Blind review"
        } else {
            "Additional blind review"
        };
        println!(
            "{label}: {} ({} vs {}, {} complete pairs)",
            absolute_path(&artifact.path)?.display(),
            artifact.candidate_profile_id,
            artifact.reference_profile_id,
            artifact.available_pairs
        );
    }
    if report.target_hard_cap_acceptance.overall.target_run_count > 0 {
        let hard_cap = &report.target_hard_cap_acceptance.overall;
        println!(
            "Hard-cap acceptance: {}/{} known-feasible hits ({:.2}%), {} overshoot(s), passed={}",
            hard_cap.accepted_hit_count,
            hard_cap.known_feasible_count,
            hard_cap.hit_rate.unwrap_or(0.0) * 100.0,
            hard_cap.overshoot_count,
            hard_cap.passed
        );
    }
    let best_quality = &report.best_quality_acceptance;
    println!(
        "Best same-size quality: {}/{} eligible pairs across {} categories, passed={}",
        best_quality.eligible_pair_count,
        best_quality.expected_pair_count,
        best_quality.categories.len(),
        best_quality.passed,
    );
    for metric in &best_quality.overall.metrics {
        println!(
            "  {}: {} win / {} loss / {} tie, severe={}, passed={}",
            metric.metric_id,
            metric.win_count,
            metric.loss_count,
            metric.tie_count,
            metric.severe_regression_count,
            metric.passed,
        );
    }
    let performance = &report.performance_baseline.overall;
    println!(
        "Performance baseline: encode P50/P95 {}/{} ms, peak tree RSS P50/P95 {}/{} MiB, memory {}/{} runs",
        performance
            .p50_encode_wall_elapsed_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| "n/a".to_string()),
        performance
            .p95_encode_wall_elapsed_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| "n/a".to_string()),
        performance
            .p50_peak_tree_rss_bytes
            .map(format_mebibytes)
            .unwrap_or_else(|| "n/a".to_string()),
        performance
            .p95_peak_tree_rss_bytes
            .map(format_mebibytes)
            .unwrap_or_else(|| "n/a".to_string()),
        performance.memory_measured_run_count,
        performance.timed_run_count,
    );
    if let Some(evaluation) = report.performance_baseline.budget_evaluation.as_ref() {
        let budget_actual = &evaluation.actual;
        println!(
            "Performance budget: scope={} ({} runs, {} excluded), build={}, coverage={:.2}%, P95/max={} / {} ms, RSS P95/max={}/{} MiB, passed={}",
            evaluation.profile_scope,
            evaluation.evaluated_run_count,
            evaluation.excluded_run_count,
            evaluation.actual_build_profile,
            budget_actual.memory_coverage.unwrap_or(0.0) * 100.0,
            budget_actual.p95_encode_wall_elapsed_ms.unwrap_or(0),
            budget_actual.max_encode_wall_elapsed_ms.unwrap_or(0),
            budget_actual
                .p95_peak_tree_rss_bytes
                .map(format_mebibytes)
                .unwrap_or_else(|| "n/a".to_string()),
            budget_actual
                .max_peak_tree_rss_bytes
                .map(format_mebibytes)
                .unwrap_or_else(|| "n/a".to_string()),
            evaluation.passed,
        );
    }
    if report.failed_runs > 0 {
        return Err(format!(
            "{} quality-lab run(s) failed; inspect {}",
            report.failed_runs,
            options.output_path.display()
        ));
    }
    if hard_cap_gate_failed {
        return Err(format!(
            "Hard-cap acceptance failed; inspect target_hard_cap_acceptance in {}",
            options.output_path.display()
        ));
    }
    if performance_gate_failed {
        return Err(format!(
            "Performance budget failed; inspect performance_baseline.budget_evaluation in {}",
            options.output_path.display()
        ));
    }
    Ok(())
}

fn format_mebibytes(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / (1024.0 * 1024.0))
}

fn parse_cli_options<I, S>(args: I) -> Result<Option<CliOptions>, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut values = args.into_iter().map(Into::into).peekable();
    if values
        .peek()
        .is_some_and(|value| value == "--help" || value == "-h")
    {
        return Ok(None);
    }

    let command = match values.peek().map(String::as_str) {
        Some("prepare") => {
            values.next();
            LabCommand::Prepare
        }
        Some("run") => {
            values.next();
            LabCommand::Run
        }
        Some(value) if !value.starts_with('-') => {
            return Err(format!("Unknown command '{value}'.\n\n{HELP}"));
        }
        _ => LabCommand::Run,
    };
    let mut manifest_path = PathBuf::from("bench/corpus-manifest.json");
    let mut output_path = PathBuf::from("tmp/quality-lab/latest.json");
    let mut fixture_ids = None;

    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--manifest" => {
                manifest_path = PathBuf::from(
                    values
                        .next()
                        .ok_or_else(|| "--manifest requires a path".to_string())?,
                );
            }
            "--output" if command == LabCommand::Run => {
                output_path = PathBuf::from(
                    values
                        .next()
                        .ok_or_else(|| "--output requires a path".to_string())?,
                );
            }
            "--fixtures" => {
                let raw = values
                    .next()
                    .ok_or_else(|| "--fixtures requires a comma-separated id list".to_string())?;
                let parsed = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                if parsed.is_empty() {
                    return Err("--fixtures requires at least one fixture id".to_string());
                }
                fixture_ids = Some(parsed);
            }
            "--help" | "-h" => return Ok(None),
            other => return Err(format!("Unknown option '{other}'.\n\n{HELP}")),
        }
    }

    if command == LabCommand::Run {
        output_path = normalize_quality_report_output_path(&output_path)?;
    }

    Ok(Some(CliOptions {
        command,
        manifest_path,
        output_path,
        fixture_ids,
    }))
}

fn normalize_quality_report_output_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = absolute_path(path)?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!(
                        "Quality report path {} traverses above its filesystem root",
                        path.display()
                    ));
                }
            }
        }
    }
    let extension = normalized
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            format!(
                "Quality report output {} must use the .json extension",
                path.display()
            )
        })?;
    if !extension.eq_ignore_ascii_case("json") {
        return Err(format!(
            "Quality report output {} must use the .json extension",
            path.display()
        ));
    }
    let stem = normalized
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Quality report output {} has no UTF-8 stem", path.display()))?;
    let _ = stem;
    normalized.set_extension("json");
    let parent = normalized.parent().ok_or_else(|| {
        format!(
            "Quality report output {} has no parent directory",
            path.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create Quality report directory {}: {error}",
            parent.display()
        )
    })?;
    let parent = fs::canonicalize(parent).map_err(|error| {
        format!(
            "Failed to canonicalize Quality report directory {}: {error}",
            parent.display()
        )
    })?;
    let file_name = normalized
        .file_name()
        .ok_or_else(|| format!("Quality report output {} has no file name", path.display()))?;
    let normalized = parent.join(file_name);
    if normalized.is_dir() {
        return Err(format!(
            "Quality report output {} is a directory",
            normalized.display()
        ));
    }
    Ok(normalized)
}

fn select_fixture_specs<'a>(
    fixtures: &'a [FixtureSpec],
    selected_ids: Option<&[String]>,
) -> Result<Vec<&'a FixtureSpec>, String> {
    let Some(selected_ids) = selected_ids else {
        return Ok(fixtures.iter().collect());
    };
    let mut requested = HashSet::new();
    for id in selected_ids {
        validate_id("selected fixture", id)?;
        requested.insert(id.clone());
    }
    let available = fixtures
        .iter()
        .map(|fixture| fixture.id.clone())
        .collect::<HashSet<_>>();
    let mut missing = requested
        .difference(&available)
        .cloned()
        .collect::<Vec<_>>();
    missing.sort_unstable();
    if !missing.is_empty() {
        return Err(format!("Unknown fixture id(s): {}", missing.join(", ")));
    }
    Ok(fixtures
        .iter()
        .filter(|fixture| requested.contains(&fixture.id))
        .collect())
}

fn load_manifest(path: &Path) -> Result<LoadedManifest, String> {
    let path = absolute_path(path)?;
    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read manifest {}: {error}", path.display()))?;
    let manifest: CorpusManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid manifest JSON {}: {error}", path.display()))?;
    validate_manifest(&manifest)?;
    Ok(LoadedManifest {
        path,
        sha256: sha256_bytes(&bytes),
        manifest,
    })
}

fn validate_manifest(manifest: &CorpusManifest) -> Result<(), String> {
    if manifest.schema_version != CORPUS_MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported corpus manifest schema {}; expected {}",
            manifest.schema_version, CORPUS_MANIFEST_SCHEMA_VERSION
        ));
    }
    validate_id("corpus", &manifest.corpus_id)?;
    validate_relative_path("fixture_root", &manifest.fixture_root)?;
    let identity = &manifest.canonical_fixture_identity;
    if identity.contract_id != "gifp.canonical_fixture_identity.v1" {
        return Err(format!(
            "Unsupported canonical fixture identity contract '{}'",
            identity.contract_id
        ));
    }
    if !matches!(identity.status.as_str(), "complete" | "incomplete") {
        return Err(format!(
            "Canonical fixture identity status '{}' must be complete or incomplete",
            identity.status
        ));
    }
    for (label, digest) in [
        ("generator_ffmpeg_sha256", &identity.generator_ffmpeg_sha256),
        (
            "generator_ffprobe_sha256",
            &identity.generator_ffprobe_sha256,
        ),
        (
            "reviewed_runtime_manifest_sha256",
            &identity.reviewed_runtime_manifest_sha256,
        ),
    ] {
        if !valid_sha256(digest) {
            return Err(format!(
                "Canonical fixture identity {label} must be 64 lowercase hexadecimal characters"
            ));
        }
    }
    validate_relative_path(
        "reviewed runtime manifest",
        &identity.reviewed_runtime_manifest_path,
    )?;
    if manifest.fixtures.is_empty() {
        return Err("Corpus manifest must contain at least one fixture".to_string());
    }
    if manifest.profiles.is_empty() {
        return Err("Corpus manifest must contain at least one profile".to_string());
    }

    let mut fixture_ids = HashSet::new();
    for fixture in &manifest.fixtures {
        validate_id("fixture", &fixture.id)?;
        if !fixture_ids.insert(fixture.id.as_str()) {
            return Err(format!("Duplicate fixture id '{}'", fixture.id));
        }
        if fixture.category.trim().is_empty() {
            return Err(format!("Fixture '{}' has no category", fixture.id));
        }
        validate_relative_path("fixture file", &fixture.file)?;
        let extension = Path::new(&fixture.file)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !extension.eq_ignore_ascii_case("mkv") {
            return Err(format!(
                "Fixture '{}' must use a .mkv file for the deterministic FFV1 bootstrap corpus",
                fixture.id
            ));
        }
        if let Some(expected_source_sha256) = fixture.expected_source_sha256.as_deref() {
            if !valid_sha256(expected_source_sha256) {
                return Err(format!(
                    "Fixture '{}' expected_source_sha256 must be null or 64 lowercase hexadecimal characters",
                    fixture.id
                ));
            }
        }
        if !fixture.duration_seconds.is_finite()
            || !(0.1..=30.0).contains(&fixture.duration_seconds)
        {
            return Err(format!(
                "Fixture '{}' duration must be between 0.1 and 30 seconds",
                fixture.id
            ));
        }
        if fixture.generator.input.trim().is_empty() {
            return Err(format!(
                "Fixture '{}' has an empty generator input",
                fixture.id
            ));
        }
        match fixture.generator.kind.as_str() {
            "lavfi" => {}
            "external" => {
                validate_relative_path("external fixture input", &fixture.generator.input)?;
                let source_sha256 =
                    fixture.generator.source_sha256.as_deref().ok_or_else(|| {
                        format!(
                            "External fixture '{}' must declare source_sha256",
                            fixture.id
                        )
                    })?;
                if !valid_sha256(source_sha256) {
                    return Err(format!(
                        "External fixture '{}' source_sha256 must be 64 lowercase hexadecimal characters",
                        fixture.id
                    ));
                }
                if fixture
                    .generator
                    .authorization
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    return Err(format!(
                        "External fixture '{}' must declare a non-empty authorization note",
                        fixture.id
                    ));
                }
            }
            kind => {
                return Err(format!(
                    "Fixture '{}' uses unsupported generator '{kind}'",
                    fixture.id
                ));
            }
        }
        if fixture.generator.pixel_format.trim().is_empty() {
            return Err(format!(
                "Fixture '{}' has an empty pixel format",
                fixture.id
            ));
        }
    }
    if identity.status == "complete"
        && manifest
            .fixtures
            .iter()
            .any(|fixture| fixture.expected_source_sha256.is_none())
    {
        return Err(
            "Canonical fixture identity cannot be complete while any expected_source_sha256 is null"
                .to_string(),
        );
    }

    if let Some(coverage) = manifest.coverage.as_ref() {
        if manifest.fixtures.len() < coverage.minimum_total {
            return Err(format!(
                "Corpus coverage requires at least {} fixtures; found {}",
                coverage.minimum_total,
                manifest.fixtures.len()
            ));
        }
        let mut category_counts = HashMap::<&str, usize>::new();
        let mut tags = HashSet::<&str>::new();
        for fixture in &manifest.fixtures {
            *category_counts.entry(&fixture.category).or_default() += 1;
            tags.extend(fixture.tags.iter().map(String::as_str));
        }
        for category in &coverage.required_categories {
            let count = category_counts.get(category.as_str()).copied().unwrap_or(0);
            if count < coverage.minimum_per_category {
                return Err(format!(
                    "Corpus category '{category}' requires at least {} fixtures; found {count}",
                    coverage.minimum_per_category
                ));
            }
        }
        for tag in &coverage.required_tags {
            if !tags.contains(tag.as_str()) {
                return Err(format!("Corpus coverage is missing required tag '{tag}'"));
            }
        }
    }

    if let Some(budget) = manifest.performance_budget.as_ref() {
        if budget.profile_scope != "stable_profiles" {
            return Err("Performance budget profile_scope must be 'stable_profiles'".to_string());
        }
        if !manifest
            .profiles
            .iter()
            .any(|profile| !profile.allow_experimental)
        {
            return Err(
                "Performance budget profile_scope 'stable_profiles' requires at least one non-experimental profile"
                    .to_string(),
            );
        }
        if budget.required_build_profile != "release" {
            return Err("Performance budget required_build_profile must be 'release'".to_string());
        }
        if !budget.minimum_memory_coverage.is_finite()
            || !(0.0..=1.0).contains(&budget.minimum_memory_coverage)
        {
            return Err(
                "Performance budget minimum_memory_coverage must be between 0 and 1".to_string(),
            );
        }
        if budget.p95_encode_wall_elapsed_ms == 0
            || budget.max_encode_wall_elapsed_ms < budget.p95_encode_wall_elapsed_ms
        {
            return Err(
                "Performance budget max encode time must be at least its positive P95 limit"
                    .to_string(),
            );
        }
        if budget.p95_peak_tree_rss_bytes == 0
            || budget.max_peak_tree_rss_bytes < budget.p95_peak_tree_rss_bytes
        {
            return Err(
                "Performance budget max tree RSS must be at least its positive P95 limit"
                    .to_string(),
            );
        }
    }

    let mut profile_ids = HashSet::new();
    for profile in &manifest.profiles {
        validate_id("profile", &profile.id)?;
        if !profile_ids.insert(profile.id.as_str()) {
            return Err(format!("Duplicate profile id '{}'", profile.id));
        }
        if !matches!(
            profile.generation_mode.as_str(),
            "fast_gif" | "best_gif" | "target_size"
        ) {
            return Err(format!(
                "Profile '{}' must use fast_gif, best_gif, or target_size",
                profile.id
            ));
        }
        if !(32..=3840).contains(&profile.width) {
            return Err(format!("Profile '{}' width is out of range", profile.id));
        }
        if !(1..=60).contains(&profile.fps) {
            return Err(format!("Profile '{}' fps is out of range", profile.id));
        }
        if !(2..=256).contains(&profile.colors) {
            return Err(format!("Profile '{}' colors are out of range", profile.id));
        }
        if profile.encoder.trim().is_empty()
            || profile.dither.trim().is_empty()
            || profile.filter_style.trim().is_empty()
            || profile.perceptual_focus.trim().is_empty()
        {
            return Err(format!(
                "Profile '{}' has an empty required setting",
                profile.id
            ));
        }
    }
    for (index, profile) in manifest.profiles.iter().enumerate() {
        match profile.generation_mode.as_str() {
            "target_size" => {
                let target_constraint = match profile.target_constraint.as_deref() {
                    Some(value) => TargetConstraint::parse(value).ok_or_else(|| {
                        format!(
                            "Target-size profile '{}' uses unknown target_constraint '{value}'",
                            profile.id
                        )
                    })?,
                    None => profile.effective_target_constraint(),
                };
                let target_size_scale = profile.effective_target_size_scale();
                if !target_size_scale.is_finite() || !(0.25..=4.0).contains(&target_size_scale) {
                    return Err(format!(
                        "Target-size profile '{}' target_size_scale must be finite and between 0.25 and 4.0",
                        profile.id
                    ));
                }
                let target_id = profile.match_target_profile_id.as_deref().ok_or_else(|| {
                    format!(
                        "Target-size profile '{}' must declare match_target_profile_id",
                        profile.id
                    )
                })?;
                validate_id("match target profile", target_id)?;
                let target_index = manifest
                    .profiles
                    .iter()
                    .position(|candidate| candidate.id == target_id)
                    .ok_or_else(|| {
                        format!(
                            "Target-size profile '{}' references missing profile '{target_id}'",
                            profile.id
                        )
                    })?;
                if target_index >= index {
                    return Err(format!(
                        "Target-size profile '{}' must reference an earlier profile",
                        profile.id
                    ));
                }
                let target_mode = manifest.profiles[target_index].generation_mode.as_str();
                if target_constraint == TargetConstraint::SymmetricMatch
                    && target_mode != "best_gif"
                {
                    return Err(format!(
                        "Symmetric target-size profile '{}' must match a best_gif profile",
                        profile.id
                    ));
                }
                if target_constraint == TargetConstraint::SymmetricMatch
                    && (target_size_scale - 1.0).abs() > f64::EPSILON
                {
                    return Err(format!(
                        "Symmetric target-size profile '{}' must use target_size_scale 1.0",
                        profile.id
                    ));
                }
                if target_constraint == TargetConstraint::HardCap
                    && !matches!(target_mode, "fast_gif" | "best_gif")
                {
                    return Err(format!(
                        "Hard-cap target-size profile '{}' must reference an earlier fast_gif or best_gif witness",
                        profile.id
                    ));
                }
            }
            _ if profile.match_target_profile_id.is_some()
                || profile.target_constraint.is_some()
                || profile.target_size_scale.is_some() =>
            {
                return Err(format!(
                    "Profile '{}' may only declare target matching fields in target_size mode",
                    profile.id
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_id(kind: &str, value: &str) -> Result<(), String> {
    let mut bytes = value.bytes();
    let valid = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte)
        });
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Invalid {kind} id '{value}'; use lowercase ASCII letters, digits, '-' or '_'"
        ))
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_relative_path(label: &str, value: &str) -> Result<(), String> {
    let path = Path::new(value);
    let safe = !value.trim().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir));
    if safe {
        Ok(())
    } else {
        Err(format!(
            "{label} '{value}' must be a relative path without parent traversal"
        ))
    }
}

fn canonical_path_within(root: &Path, path: &Path, label: &str) -> Result<PathBuf, String> {
    let resolved = fs::canonicalize(path)
        .map_err(|error| format!("Failed to resolve {label} {}: {error}", path.display()))?;
    if resolved == root || resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err(format!(
            "{label} {} resolves outside trusted root {}",
            path.display(),
            root.display()
        ))
    }
}

fn create_canonical_directory_within(
    root: &Path,
    path: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create {label} {}: {error}", path.display()))?;
    let resolved = canonical_path_within(root, path, label)?;
    if !resolved.is_dir() {
        return Err(format!("{label} {} is not a directory", resolved.display()));
    }
    Ok(resolved)
}

fn metadata_is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn safe_fixture_output_path(fixture_root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    let file_name = relative
        .file_name()
        .ok_or_else(|| format!("Fixture output '{}' has no file name", relative.display()))?;
    let relative_parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let requested_parent = fixture_root.join(relative_parent);
    let parent = create_canonical_directory_within(
        fixture_root,
        &requested_parent,
        "fixture output directory",
    )?;
    Ok(parent.join(file_name))
}

fn prepare_fixtures(
    loaded: &LoadedManifest,
    fixtures: &[&FixtureSpec],
    ffmpeg: &Path,
    ffprobe: &Path,
) -> Result<Vec<PreparedFixture>, String> {
    let manifest_dir = loaded
        .path
        .parent()
        .ok_or_else(|| "Manifest path has no parent directory".to_string())?;
    let manifest_dir = fs::canonicalize(manifest_dir).map_err(|error| {
        format!(
            "Failed to resolve manifest directory {}: {error}",
            manifest_dir.display()
        )
    })?;
    let requested_fixture_root = manifest_dir.join(&loaded.manifest.fixture_root);
    let fixture_root =
        create_canonical_directory_within(&manifest_dir, &requested_fixture_root, "fixture root")?;

    let cache_root = create_canonical_directory_within(
        &fixture_root,
        &fixture_root.join(".gifp-cache").join("sha256"),
        "immutable fixture cache",
    )?;

    let mut prepared = Vec::with_capacity(fixtures.len());
    for fixture in fixtures.iter().copied() {
        let output_path = safe_fixture_output_path(&fixture_root, &fixture.file)?;
        let fixture_extension = fixture_file_extension(fixture)?;
        let parent = output_path
            .parent()
            .ok_or_else(|| format!("Fixture output {} has no parent", output_path.display()))?;
        let (staged_path, staged_file) = reserve_quality_staging_file(parent, fixture_extension)?;
        drop(staged_file);
        println!("Preparing fixture {}", fixture.id);
        let result = (|| {
            generate_fixture(ffmpeg, fixture, &manifest_dir, &staged_path)?;
            let inspection = inspect_media_file(ffprobe, &staged_path)
                .map_err(|error| format!("Failed to inspect fixture '{}': {error}", fixture.id))?;
            let duration_error = (inspection.duration - fixture.duration_seconds).abs();
            if duration_error > 0.02 {
                return Err(format!(
                    "Fixture '{}' expected {:.3}s but FFprobe reported {:.3}s",
                    fixture.id, fixture.duration_seconds, inspection.duration
                ));
            }
            let sha256 = sha256_file(&staged_path)?;
            if let Some(expected_source_sha256) = fixture.expected_source_sha256.as_deref() {
                if sha256 != expected_source_sha256 {
                    return Err(format!(
                        "Fixture '{}' fixed identity mismatch: expected {}, generated {}",
                        fixture.id, expected_source_sha256, sha256
                    ));
                }
            }
            let cache_path = cache_root.join(format!("{sha256}.{fixture_extension}"));
            ensure_immutable_fixture_cache_entry(&staged_path, &cache_path, &sha256)?;
            publish_fixture_alias(&cache_path, &output_path, &sha256, &fixture.id)?;
            Ok(PreparedFixture {
                spec: fixture.clone(),
                sha256,
                // The human-facing alias may be replaced by another process;
                // runs consume the immutable content-addressed snapshot.
                path: cache_path,
                inspection,
            })
        })();
        let _ = fs::remove_file(&staged_path);
        prepared.push(result?);
    }
    Ok(prepared)
}

fn fixture_file_extension(fixture: &FixtureSpec) -> Result<&str, String> {
    Path::new(&fixture.file)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .ok_or_else(|| {
            format!(
                "Fixture '{}' output '{}' must have a file extension",
                fixture.id, fixture.file
            )
        })
}

fn ensure_immutable_fixture_cache_entry(
    staged_path: &Path,
    cache_path: &Path,
    expected_sha256: &str,
) -> Result<(), String> {
    if cache_path.is_file() {
        return verify_file_sha256(cache_path, expected_sha256, "fixture cache entry");
    }
    let publish_error = publish_file_atomically(staged_path, cache_path, false)
        .err()
        .map(|error| error.to_string());
    match verify_file_sha256(cache_path, expected_sha256, "fixture cache entry") {
        Ok(()) => Ok(()),
        Err(verify_error) => Err(match publish_error {
            Some(publish_error) => format!(
                "Failed to publish immutable fixture cache entry {}: {publish_error}; {verify_error}",
                cache_path.display()
            ),
            None => verify_error,
        }),
    }
}

fn publish_fixture_alias(
    cache_path: &Path,
    output_path: &Path,
    expected_sha256: &str,
    fixture_id: &str,
) -> Result<(), String> {
    let _publish_lock =
        QualityCommitLock::acquire_with_timeout(output_path, QUALITY_COMMIT_LOCK_TIMEOUT)?;
    if let Ok(metadata) = fs::symlink_metadata(output_path) {
        if metadata_is_link_or_reparse(&metadata) {
            return Err(format!(
                "Refusing to publish fixture '{fixture_id}' through linked output {}",
                output_path.display()
            ));
        }
    }
    publish_file_atomically(cache_path, output_path, true).map_err(|error| {
        format!(
            "Failed to atomically publish fixture '{fixture_id}' to {}: {error}",
            output_path.display()
        )
    })?;
    verify_file_sha256(output_path, expected_sha256, "published fixture")
}

fn verify_file_sha256(path: &Path, expected_sha256: &str, label: &str) -> Result<(), String> {
    let actual_sha256 = sha256_file(path)?;
    if actual_sha256 == expected_sha256 {
        Ok(())
    } else {
        Err(format!(
            "{label} {} SHA mismatch: expected {expected_sha256}, got {actual_sha256}",
            path.display()
        ))
    }
}

fn snapshot_external_fixture(
    manifest_dir: &Path,
    fixture: &FixtureSpec,
    staging_parent: &Path,
) -> Result<PathBuf, String> {
    let source_candidate = manifest_dir.join(&fixture.generator.input);
    let source_path =
        canonical_path_within(manifest_dir, &source_candidate, "external fixture source")?;
    let metadata = fs::metadata(&source_path).map_err(|error| {
        format!(
            "Failed to inspect external fixture '{}' at {}: {error}",
            fixture.id,
            source_path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "External fixture '{}' source {} is not a regular file",
            fixture.id,
            source_path.display()
        ));
    }
    let expected_sha256 = fixture
        .generator
        .source_sha256
        .as_deref()
        .ok_or_else(|| format!("External fixture '{}' has no source SHA", fixture.id))?;
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("source");
    let (snapshot_path, mut snapshot) = reserve_quality_staging_file(staging_parent, extension)?;
    let copy_result = (|| -> Result<(), String> {
        let mut source = File::open(&source_path).map_err(|error| {
            format!(
                "Failed to open external fixture '{}' at {}: {error}",
                fixture.id,
                source_path.display()
            )
        })?;
        std::io::copy(&mut source, &mut snapshot).map_err(|error| {
            format!(
                "Failed to snapshot external fixture '{}' from {}: {error}",
                fixture.id,
                source_path.display()
            )
        })?;
        snapshot.flush().map_err(|error| {
            format!(
                "Failed to flush external fixture '{}' snapshot: {error}",
                fixture.id
            )
        })?;
        snapshot.sync_all().map_err(|error| {
            format!(
                "Failed to sync external fixture '{}' snapshot: {error}",
                fixture.id
            )
        })?;
        Ok(())
    })();
    drop(snapshot);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&snapshot_path);
        return Err(error);
    }
    if let Err(error) =
        verify_file_sha256(&snapshot_path, expected_sha256, "external fixture snapshot")
    {
        let _ = fs::remove_file(&snapshot_path);
        return Err(format!("External fixture '{}': {error}", fixture.id));
    }
    Ok(snapshot_path)
}

fn generate_fixture(
    ffmpeg: &Path,
    fixture: &FixtureSpec,
    manifest_dir: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    let mut external_snapshot = None;
    command
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error");
    match fixture.generator.kind.as_str() {
        "lavfi" => {
            command
                .arg("-f")
                .arg("lavfi")
                .arg("-i")
                .arg(&fixture.generator.input);
        }
        "external" => {
            let staging_parent = output_path.parent().ok_or_else(|| {
                format!(
                    "External fixture '{}' output {} has no parent directory",
                    fixture.id,
                    output_path.display()
                )
            })?;
            let snapshot = snapshot_external_fixture(manifest_dir, fixture, staging_parent)?;
            command.arg("-i").arg(&snapshot);
            external_snapshot = Some(snapshot);
        }
        kind => {
            return Err(format!(
                "Fixture '{}' uses unsupported generator '{kind}'",
                fixture.id
            ));
        }
    }
    if let Some(filter) = fixture.generator.video_filter.as_deref() {
        if !filter.trim().is_empty() {
            command.arg("-vf").arg(filter);
        }
    }
    let result = command
        .arg("-t")
        .arg(format!("{:.6}", fixture.duration_seconds))
        .arg("-an")
        .arg("-c:v")
        .arg("ffv1")
        .arg("-level")
        .arg("3")
        .arg("-g")
        .arg("1")
        .arg("-threads")
        .arg("1")
        .arg("-pix_fmt")
        .arg(&fixture.generator.pixel_format)
        .arg("-fflags")
        .arg("+bitexact")
        .arg("-flags:v")
        .arg("+bitexact")
        .arg("-map_metadata")
        .arg("-1")
        .arg(output_path)
        .output();
    if let Some(snapshot) = external_snapshot {
        let _ = fs::remove_file(snapshot);
    }
    let result =
        result.map_err(|error| format!("Failed to start FFmpeg for '{}': {error}", fixture.id))?;
    if !result.status.success() {
        return Err(format!(
            "Failed to generate fixture '{}': {}",
            fixture.id,
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    if !output_path.is_file() {
        return Err(format!(
            "FFmpeg did not create fixture '{}' at {}",
            fixture.id,
            output_path.display()
        ));
    }
    Ok(())
}

impl TargetReinvestmentCalibrationAccumulator {
    fn observe(&mut self, report: Option<&TargetOptimizerReport>) {
        self.target_profile_run_count += 1;
        let Some(report) = report else {
            return;
        };
        if let Some(initial) = report
            .route_observations
            .iter()
            .find(|route| route.route_id == "perceptual_reinvest")
        {
            if let Some(ratio) = initial
                .prediction
                .as_ref()
                .and_then(|prediction| prediction.actual_to_predicted_ratio)
                .filter(|ratio| ratio.is_finite() && *ratio > 0.0)
            {
                self.sample_ratios.push(ratio);
                if initial.under_target {
                    self.initial_under_target_count += 1;
                }
            }
        }
        if let Some(correction) = report
            .route_observations
            .iter()
            .find(|route| route.route_id == "perceptual_reinvest_corrected")
        {
            self.correction_attempt_count += 1;
            if correction.status == "encoded"
                && correction.under_target
                && correction.timeline_verified
            {
                self.correction_success_count += 1;
            }
        }
    }
}

fn calibration_rate(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 / denominator as f64)
}

fn calibration_percentile_95(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut ordered = values.to_vec();
    ordered.sort_by(f64::total_cmp);
    let index = ((ordered.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(ordered.len() - 1);
    ordered.get(index).copied()
}

fn nearest_rank_percentile(values: &[u64], percentile: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut ordered = values.to_vec();
    ordered.sort_unstable();
    let rank = (ordered.len() as f64 * percentile.clamp(0.0, 1.0)).ceil() as usize;
    ordered
        .get(rank.saturating_sub(1).min(ordered.len() - 1))
        .copied()
}

impl PerformanceBaselineAccumulator {
    fn observe(&mut self, run: &QualityRunRecord) {
        self.run_count += 1;
        let Some(metrics) = run.metrics.as_ref() else {
            return;
        };
        self.encode_wall_elapsed_ms
            .push(metrics.encode_wall_elapsed_ms);
        if let Some(memory) = metrics.encode_memory.as_ref() {
            self.peak_tree_rss_bytes.push(memory.peak_tree_rss_bytes);
            self.peak_incremental_tree_rss_bytes
                .push(memory.peak_incremental_tree_rss_bytes);
        }
    }
}

fn build_performance_baseline_slice(
    label: String,
    accumulator: PerformanceBaselineAccumulator,
) -> PerformanceBaselineSlice {
    let timed_run_count = accumulator.encode_wall_elapsed_ms.len();
    let memory_measured_run_count = accumulator.peak_tree_rss_bytes.len();
    PerformanceBaselineSlice {
        label,
        run_count: accumulator.run_count,
        timed_run_count,
        memory_measured_run_count,
        memory_coverage: calibration_rate(memory_measured_run_count, timed_run_count),
        p50_encode_wall_elapsed_ms: nearest_rank_percentile(
            &accumulator.encode_wall_elapsed_ms,
            0.50,
        ),
        p95_encode_wall_elapsed_ms: nearest_rank_percentile(
            &accumulator.encode_wall_elapsed_ms,
            0.95,
        ),
        max_encode_wall_elapsed_ms: accumulator.encode_wall_elapsed_ms.iter().max().copied(),
        p50_peak_tree_rss_bytes: nearest_rank_percentile(&accumulator.peak_tree_rss_bytes, 0.50),
        p95_peak_tree_rss_bytes: nearest_rank_percentile(&accumulator.peak_tree_rss_bytes, 0.95),
        max_peak_tree_rss_bytes: accumulator.peak_tree_rss_bytes.iter().max().copied(),
        p50_peak_incremental_tree_rss_bytes: nearest_rank_percentile(
            &accumulator.peak_incremental_tree_rss_bytes,
            0.50,
        ),
        p95_peak_incremental_tree_rss_bytes: nearest_rank_percentile(
            &accumulator.peak_incremental_tree_rss_bytes,
            0.95,
        ),
        max_peak_incremental_tree_rss_bytes: accumulator
            .peak_incremental_tree_rss_bytes
            .iter()
            .max()
            .copied(),
    }
}

fn evaluate_performance_budget(
    budget: &PerformanceBudgetSpec,
    actual: &PerformanceBaselineSlice,
    profile_ids: Vec<String>,
    total_run_count: usize,
) -> PerformanceBudgetEvaluation {
    let actual_build_profile = build_profile().to_string();
    let build_profile_passed = actual_build_profile == budget.required_build_profile;
    let memory_coverage_passed = actual
        .memory_coverage
        .is_some_and(|coverage| coverage >= budget.minimum_memory_coverage);
    let p95_encode_wall_elapsed_passed = actual
        .p95_encode_wall_elapsed_ms
        .is_some_and(|actual| actual <= budget.p95_encode_wall_elapsed_ms);
    let max_encode_wall_elapsed_passed = actual
        .max_encode_wall_elapsed_ms
        .is_some_and(|actual| actual <= budget.max_encode_wall_elapsed_ms);
    let p95_peak_tree_rss_passed = actual
        .p95_peak_tree_rss_bytes
        .is_some_and(|actual| actual <= budget.p95_peak_tree_rss_bytes);
    let max_peak_tree_rss_passed = actual
        .max_peak_tree_rss_bytes
        .is_some_and(|actual| actual <= budget.max_peak_tree_rss_bytes);
    let mut violations = Vec::new();
    if !build_profile_passed {
        violations.push(format!(
            "build profile '{}' does not match required '{}'",
            actual_build_profile, budget.required_build_profile
        ));
    }
    if !memory_coverage_passed {
        violations.push(format!(
            "memory coverage {:.4} is below {:.4}",
            actual.memory_coverage.unwrap_or(0.0),
            budget.minimum_memory_coverage
        ));
    }
    if !p95_encode_wall_elapsed_passed {
        violations.push(format!(
            "P95 encode time {} ms exceeds {} ms",
            actual
                .p95_encode_wall_elapsed_ms
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unmeasured".to_string()),
            budget.p95_encode_wall_elapsed_ms
        ));
    }
    if !max_encode_wall_elapsed_passed {
        violations.push(format!(
            "max encode time {} ms exceeds {} ms",
            actual
                .max_encode_wall_elapsed_ms
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unmeasured".to_string()),
            budget.max_encode_wall_elapsed_ms
        ));
    }
    if !p95_peak_tree_rss_passed {
        violations.push(format!(
            "P95 tree RSS {} bytes exceeds {} bytes",
            actual
                .p95_peak_tree_rss_bytes
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unmeasured".to_string()),
            budget.p95_peak_tree_rss_bytes
        ));
    }
    if !max_peak_tree_rss_passed {
        violations.push(format!(
            "max tree RSS {} bytes exceeds {} bytes",
            actual
                .max_peak_tree_rss_bytes
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unmeasured".to_string()),
            budget.max_peak_tree_rss_bytes
        ));
    }
    let passed = violations.is_empty();
    PerformanceBudgetEvaluation {
        budget_id: "gifp.quality_lab.performance_budget.v2".to_string(),
        profile_scope: budget.profile_scope.clone(),
        profile_ids,
        evaluated_run_count: actual.run_count,
        excluded_run_count: total_run_count.saturating_sub(actual.run_count),
        actual: actual.clone(),
        required_build_profile: budget.required_build_profile.clone(),
        actual_build_profile,
        minimum_memory_coverage: budget.minimum_memory_coverage,
        p95_encode_wall_elapsed_ms_limit: budget.p95_encode_wall_elapsed_ms,
        max_encode_wall_elapsed_ms_limit: budget.max_encode_wall_elapsed_ms,
        p95_peak_tree_rss_bytes_limit: budget.p95_peak_tree_rss_bytes,
        max_peak_tree_rss_bytes_limit: budget.max_peak_tree_rss_bytes,
        build_profile_passed,
        memory_coverage_passed,
        p95_encode_wall_elapsed_passed,
        max_encode_wall_elapsed_passed,
        p95_peak_tree_rss_passed,
        max_peak_tree_rss_passed,
        passed,
        violations,
    }
}

fn build_performance_baseline(
    manifest: &CorpusManifest,
    sources: &[SourceSnapshot],
    runs: &[QualityRunRecord],
) -> PerformanceBaselineReport {
    let categories = sources
        .iter()
        .map(|source| (source.fixture_id.as_str(), source.category.as_str()))
        .collect::<HashMap<_, _>>();
    let mut overall = PerformanceBaselineAccumulator::default();
    let stable_profile_ids = manifest
        .profiles
        .iter()
        .filter(|profile| !profile.allow_experimental)
        .map(|profile| profile.id.clone())
        .collect::<Vec<_>>();
    let stable_profile_id_set = stable_profile_ids.iter().cloned().collect::<HashSet<_>>();
    let mut stable_overall = PerformanceBaselineAccumulator::default();
    let mut by_profile = BTreeMap::<String, PerformanceBaselineAccumulator>::new();
    let mut by_category = BTreeMap::<String, PerformanceBaselineAccumulator>::new();
    for run in runs {
        overall.observe(run);
        if stable_profile_id_set.contains(run.profile_id.as_str()) {
            stable_overall.observe(run);
        }
        by_profile
            .entry(run.profile_id.clone())
            .or_default()
            .observe(run);
        let category = categories
            .get(run.fixture_id.as_str())
            .copied()
            .unwrap_or("unknown")
            .to_string();
        by_category.entry(category).or_default().observe(run);
    }
    let profiles = manifest
        .profiles
        .iter()
        .map(|profile| {
            build_performance_baseline_slice(
                profile.id.clone(),
                by_profile.remove(&profile.id).unwrap_or_default(),
            )
        })
        .collect();
    let overall = build_performance_baseline_slice("all".to_string(), overall);
    let stable_overall =
        build_performance_baseline_slice("stable_profiles".to_string(), stable_overall);
    let budget_evaluation = manifest.performance_budget.as_ref().map(|budget| {
        evaluate_performance_budget(
            budget,
            &stable_overall,
            stable_profile_ids,
            overall.run_count,
        )
    });
    PerformanceBaselineReport {
        baseline_id: "gifp.quality_lab.performance.v1".to_string(),
        build_profile: build_profile().to_string(),
        measurement_scope: "convert_animation_inner".to_string(),
        memory_metric: "summed_process_tree_resident_set_bytes".to_string(),
        memory_sampler_id: PROCESS_MEMORY_SAMPLER_ID.to_string(),
        sample_interval_ms: PROCESS_MEMORY_SAMPLE_INTERVAL_MS,
        percentile_method: "nearest_rank".to_string(),
        budget_evaluation,
        overall,
        profiles,
        categories: by_category
            .into_iter()
            .map(|(category, accumulator)| build_performance_baseline_slice(category, accumulator))
            .collect(),
    }
}

const fn build_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

fn capture_host_snapshot() -> HostSnapshot {
    let system = System::new_all();
    let cpu_brand = system
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim())
        .filter(|brand| !brand.is_empty())
        .map(str::to_string);
    HostSnapshot {
        os: env::consts::OS.to_string(),
        os_version: System::long_os_version(),
        kernel_version: System::kernel_version(),
        arch: env::consts::ARCH.to_string(),
        logical_parallelism: std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
        physical_core_count: System::physical_core_count(),
        cpu_brand,
        total_memory_bytes: Some(system.total_memory()),
    }
}

fn build_target_reinvestment_calibration_slice(
    category: String,
    accumulator: TargetReinvestmentCalibrationAccumulator,
) -> TargetReinvestmentCalibrationSlice {
    let sample_count = accumulator.sample_ratios.len();
    let mean_ratio = (sample_count > 0)
        .then(|| accumulator.sample_ratios.iter().sum::<f64>() / sample_count as f64);
    let p95_ratio = calibration_percentile_95(&accumulator.sample_ratios);
    let recommended_spatial_safety_factor = (sample_count >= 3).then(|| {
        let p95 = p95_ratio.unwrap_or(1.0).max(0.01);
        (REINVEST_SPATIAL_SAFETY_FACTOR / p95.sqrt()).clamp(0.75, 0.99)
    });
    TargetReinvestmentCalibrationSlice {
        category,
        target_profile_run_count: accumulator.target_profile_run_count,
        sample_count,
        sample_rate: calibration_rate(sample_count, accumulator.target_profile_run_count),
        initial_under_target_count: accumulator.initial_under_target_count,
        initial_under_target_rate: calibration_rate(
            accumulator.initial_under_target_count,
            sample_count,
        ),
        correction_attempt_count: accumulator.correction_attempt_count,
        correction_success_count: accumulator.correction_success_count,
        correction_success_rate: calibration_rate(
            accumulator.correction_success_count,
            accumulator.correction_attempt_count,
        ),
        mean_actual_to_predicted_ratio: mean_ratio,
        p95_actual_to_predicted_ratio: p95_ratio,
        recommended_spatial_safety_factor,
    }
}

fn build_target_reinvestment_calibration(
    manifest: &CorpusManifest,
    sources: &[SourceSnapshot],
    runs: &[QualityRunRecord],
) -> TargetReinvestmentCalibrationReport {
    let target_profiles = manifest
        .profiles
        .iter()
        .filter(|profile| {
            profile.generation_mode == "target_size"
                && profile.effective_target_constraint() == TargetConstraint::HardCap
        })
        .map(|profile| profile.id.as_str())
        .collect::<HashSet<_>>();
    let categories = sources
        .iter()
        .map(|source| (source.fixture_id.as_str(), source.category.as_str()))
        .collect::<HashMap<_, _>>();
    let mut overall = TargetReinvestmentCalibrationAccumulator::default();
    let mut by_category = BTreeMap::<String, TargetReinvestmentCalibrationAccumulator>::new();
    for run in runs {
        if !target_profiles.contains(run.profile_id.as_str()) {
            continue;
        }
        let report = run
            .result
            .as_ref()
            .and_then(|result| result.target_optimizer_report.as_ref());
        overall.observe(report);
        let category = categories
            .get(run.fixture_id.as_str())
            .copied()
            .unwrap_or("unknown")
            .to_string();
        by_category.entry(category).or_default().observe(report);
    }
    TargetReinvestmentCalibrationReport {
        calibration_id: "gifp.target_reinvestment.calibration.v1".to_string(),
        baseline_spatial_safety_factor: REINVEST_SPATIAL_SAFETY_FACTOR,
        overall: build_target_reinvestment_calibration_slice("all".to_string(), overall),
        categories: by_category
            .into_iter()
            .map(|(category, accumulator)| {
                build_target_reinvestment_calibration_slice(category, accumulator)
            })
            .collect(),
    }
}

impl HardCapAcceptanceAccumulator {
    fn observe(
        &mut self,
        known_feasible: bool,
        target_bytes: Option<u64>,
        output_bytes: Option<u64>,
        correctness_passed: bool,
    ) {
        self.target_run_count += 1;
        if !known_feasible {
            self.unknown_feasibility_count += 1;
            return;
        }
        self.known_feasible_count += 1;
        let (Some(target_bytes), Some(output_bytes)) = (target_bytes, output_bytes) else {
            self.unmeasurable_output_count += 1;
            return;
        };
        if output_bytes > target_bytes {
            self.overshoot_count += 1;
        } else if output_bytes as f64 / (target_bytes.max(1) as f64) < HARD_CAP_FILL_RATIO_FLOOR {
            self.undershoot_count += 1;
        }
        if !correctness_passed {
            self.correctness_failed_count += 1;
            return;
        }
        let fill_ratio = output_bytes as f64 / target_bytes.max(1) as f64;
        if output_bytes <= target_bytes && fill_ratio >= HARD_CAP_FILL_RATIO_FLOOR {
            self.accepted_hit_count += 1;
        }
    }
}

fn build_hard_cap_acceptance_slice(
    category: String,
    accumulator: HardCapAcceptanceAccumulator,
) -> HardCapAcceptanceSlice {
    let hit_rate = calibration_rate(
        accumulator.accepted_hit_count,
        accumulator.known_feasible_count,
    );
    let all_measurable_outputs_under_cap = accumulator.overshoot_count == 0;
    let passed = accumulator.known_feasible_count > 0
        && hit_rate.is_some_and(|rate| rate >= HARD_CAP_REQUIRED_HIT_RATE)
        && all_measurable_outputs_under_cap;
    HardCapAcceptanceSlice {
        category,
        target_run_count: accumulator.target_run_count,
        known_feasible_count: accumulator.known_feasible_count,
        unknown_feasibility_count: accumulator.unknown_feasibility_count,
        accepted_hit_count: accumulator.accepted_hit_count,
        undershoot_count: accumulator.undershoot_count,
        overshoot_count: accumulator.overshoot_count,
        unmeasurable_output_count: accumulator.unmeasurable_output_count,
        correctness_failed_count: accumulator.correctness_failed_count,
        hit_rate,
        all_measurable_outputs_under_cap,
        passed,
    }
}

fn build_target_hard_cap_acceptance(
    manifest: &CorpusManifest,
    sources: &[SourceSnapshot],
    runs: &[QualityRunRecord],
) -> HardCapAcceptanceReport {
    let hard_cap_profiles = manifest
        .profiles
        .iter()
        .filter(|profile| {
            profile.generation_mode == "target_size"
                && profile.effective_target_constraint() == TargetConstraint::HardCap
        })
        .map(|profile| (profile.id.as_str(), profile))
        .collect::<HashMap<_, _>>();
    let categories = sources
        .iter()
        .map(|source| (source.fixture_id.as_str(), source.category.as_str()))
        .collect::<HashMap<_, _>>();
    let mut overall = HardCapAcceptanceAccumulator::default();
    let mut by_category = BTreeMap::<String, HardCapAcceptanceAccumulator>::new();

    for run in runs {
        let Some(profile) = hard_cap_profiles.get(run.profile_id.as_str()).copied() else {
            continue;
        };
        let target_bytes = run.request.get("target_size_bytes").and_then(Value::as_u64);
        let witness = profile
            .match_target_profile_id
            .as_deref()
            .and_then(|witness_id| {
                runs.iter().rev().find(|candidate| {
                    candidate.fixture_id == run.fixture_id && candidate.profile_id == witness_id
                })
            });
        let witness_size = witness
            .and_then(|value| value.metrics.as_ref())
            .map(|metrics| metrics.size_bytes);
        let witness_correct = witness
            .and_then(|value| value.correctness.as_ref())
            .is_some_and(|correctness| correctness.all_passed);
        let known_feasible = match (target_bytes, witness_size) {
            (Some(target), Some(size)) if witness_correct && target > 0 => {
                size <= target && size as f64 / target as f64 >= HARD_CAP_FILL_RATIO_FLOOR
            }
            _ => false,
        };
        let output_bytes = run.metrics.as_ref().map(|metrics| metrics.size_bytes);
        let correctness_passed = run
            .correctness
            .as_ref()
            .is_some_and(|correctness| correctness.all_passed);
        overall.observe(
            known_feasible,
            target_bytes,
            output_bytes,
            correctness_passed,
        );
        let category = categories
            .get(run.fixture_id.as_str())
            .copied()
            .unwrap_or("unknown")
            .to_string();
        by_category.entry(category).or_default().observe(
            known_feasible,
            target_bytes,
            output_bytes,
            correctness_passed,
        );
    }

    HardCapAcceptanceReport {
        acceptance_id: "gifp.target_size.hard_cap_acceptance.v1".to_string(),
        fill_ratio_floor: HARD_CAP_FILL_RATIO_FLOOR,
        required_hit_rate: HARD_CAP_REQUIRED_HIT_RATE,
        overall: build_hard_cap_acceptance_slice("all".to_string(), overall),
        categories: by_category
            .into_iter()
            .map(|(category, accumulator)| build_hard_cap_acceptance_slice(category, accumulator))
            .collect(),
    }
}

fn select_best_quality_profile_pair(
    manifest: &CorpusManifest,
) -> Result<(&ProfileSpec, &ProfileSpec), String> {
    let stable_best = manifest
        .profiles
        .iter()
        .filter(|profile| profile.generation_mode == "best_gif" && !profile.allow_experimental)
        .collect::<Vec<_>>();
    let candidate = stable_best
        .iter()
        .copied()
        .find(|profile| profile.id == "best-current")
        .or_else(|| (stable_best.len() == 1).then(|| stable_best[0]))
        .ok_or_else(|| match stable_best.len() {
            0 => "no stable best_gif profile is present".to_string(),
            count => format!(
                "{count} stable best_gif profiles are present without an unambiguous best-current profile"
            ),
        })?;
    let references = manifest
        .profiles
        .iter()
        .filter(|profile| {
            profile.generation_mode == "target_size"
                && profile.effective_target_constraint() == TargetConstraint::SymmetricMatch
                && profile.match_target_profile_id.as_deref() == Some(candidate.id.as_str())
                && !profile.allow_experimental
                && profile.encoder == "ffmpeg_fast"
        })
        .collect::<Vec<_>>();
    let reference = references
        .iter()
        .copied()
        .find(|profile| profile.id == "ffmpeg-size-match")
        .or_else(|| (references.len() == 1).then(|| references[0]))
        .ok_or_else(|| match references.len() {
            0 => format!(
                "stable Best profile '{}' has no FFmpeg symmetric-size reference",
                candidate.id
            ),
            count => format!(
                "stable Best profile '{}' has {count} FFmpeg symmetric-size references without an unambiguous ffmpeg-size-match profile",
                candidate.id
            ),
        })?;
    Ok((candidate, reference))
}

fn best_quality_metric_value(objective: &ObjectiveQualityMetrics, metric_id: &str) -> Option<f64> {
    match metric_id {
        "vmaf_neg_mean" => Some(objective.vmaf_neg_mean),
        "vmaf_neg_p05" => Some(objective.vmaf_neg_p05),
        "cambi_mean" => Some(objective.cambi_mean),
        "mean_oklab_error" => Some(objective.mean_oklab_error),
        "edge_error" => Some(objective.edge_error),
        "static_region_temporal_residual" => Some(objective.static_region_temporal_residual),
        "alpha_coverage_error" => Some(objective.alpha_coverage_error),
        "alpha_mean_absolute_error" => Some(objective.alpha_mean_absolute_error),
        "loop_seam_excess_oklab" => Some(objective.loop_seam_excess_oklab),
        _ => None,
    }
}

fn best_quality_metric_applies(
    spec: BestQualityMetricSpec,
    source: &SourceSnapshot,
    candidate: &ObjectiveQualityMetrics,
    reference: &ObjectiveQualityMetrics,
) -> Result<bool, String> {
    let ratios_match = |candidate: f64, reference: f64, label: &str| {
        ((candidate - reference).abs() <= 1e-12).then_some(()).ok_or_else(|| {
            format!(
                "objective {label} contract differs: candidate={candidate:.12}, reference={reference:.12}"
            )
        })
    };
    match spec.condition {
        BestQualityMetricCondition::Always => Ok(true),
        BestQualityMetricCondition::StaticRegion => {
            ratios_match(
                candidate.static_pixel_ratio,
                reference.static_pixel_ratio,
                "static_pixel_ratio",
            )?;
            Ok(reference.static_pixel_ratio >= 0.05)
        }
        BestQualityMetricCondition::EdgeRegion => {
            ratios_match(
                candidate.edge_pixel_ratio,
                reference.edge_pixel_ratio,
                "edge_pixel_ratio",
            )?;
            Ok(reference.edge_pixel_ratio >= 0.01)
        }
        BestQualityMetricCondition::Transparent => {
            Ok(source.tags.iter().any(|tag| tag == "transparent"))
        }
        BestQualityMetricCondition::SeamlessLoop => {
            Ok(source.tags.iter().any(|tag| tag == "seamless-loop"))
        }
    }
}

fn compare_best_quality_metric(
    spec: BestQualityMetricSpec,
    candidate_value: f64,
    reference_value: f64,
) -> BestQualityMetricComparison {
    let tie_tolerance = spec.tie_absolute + reference_value.abs() * spec.tie_relative;
    let severe_regression_tolerance =
        (spec.severe_absolute + reference_value.abs() * spec.severe_relative).max(tie_tolerance);
    let quality_improvement = match spec.direction {
        BestQualityMetricDirection::HigherIsBetter => candidate_value - reference_value,
        BestQualityMetricDirection::LowerIsBetter => reference_value - candidate_value,
    };
    let outcome = if quality_improvement > tie_tolerance {
        "win"
    } else if quality_improvement < -tie_tolerance {
        "loss"
    } else {
        "tie"
    };
    BestQualityMetricComparison {
        metric_id: spec.metric_id.to_string(),
        direction: spec.direction.wire_name().to_string(),
        candidate_value,
        reference_value,
        quality_improvement,
        quality_improvement_in_tie_units: quality_improvement / tie_tolerance.max(f64::EPSILON),
        tie_tolerance,
        severe_regression_tolerance,
        outcome: outcome.to_string(),
        severe_regression: quality_improvement <= -severe_regression_tolerance,
    }
}

fn valid_quality_hash(value: &str, width: usize) -> bool {
    value.len() == width
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn unique_quality_run<'a>(
    runs: &'a [QualityRunRecord],
    fixture_id: &str,
    profile_id: &str,
) -> Result<&'a QualityRunRecord, String> {
    let mut matching = runs
        .iter()
        .filter(|run| run.fixture_id == fixture_id && run.profile_id == profile_id);
    let run = matching
        .next()
        .ok_or_else(|| format!("missing run for profile {profile_id}"))?;
    if matching.next().is_some() {
        return Err(format!("duplicate run for profile {profile_id}"));
    }
    Ok(run)
}

fn validate_best_quality_run<'a>(
    run: &'a QualityRunRecord,
    source: &SourceSnapshot,
) -> Result<
    (
        &'a QualityMetrics,
        &'a ObjectiveQualityMetrics,
        &'a GifResult,
    ),
    String,
> {
    if run.status != "ok" {
        return Err(format!("{} status is {}", run.profile_id, run.status));
    }
    if run.source_sha256 != source.sha256 {
        return Err(format!("{} source SHA-256 does not match", run.profile_id));
    }
    if !valid_quality_hash(&run.request_sha256, 64) {
        return Err(format!("{} has no valid request SHA-256", run.profile_id));
    }
    if !run
        .correctness
        .as_ref()
        .is_some_and(|correctness| correctness.all_passed)
    {
        return Err(format!("{} correctness gate did not pass", run.profile_id));
    }
    run.output_sha256
        .as_deref()
        .filter(|value| valid_quality_hash(value, 64))
        .ok_or_else(|| format!("{} has no valid output SHA-256", run.profile_id))?;
    let metrics = run
        .metrics
        .as_ref()
        .ok_or_else(|| format!("{} has no measured output", run.profile_id))?;
    if metrics.size_bytes == 0 {
        return Err(format!("{} measured an empty output", run.profile_id));
    }
    let objective = metrics
        .objective
        .as_ref()
        .filter(|objective| objective.status == "full")
        .ok_or_else(|| format!("{} has no full objective metrics", run.profile_id))?;
    for spec in BEST_QUALITY_METRIC_SPECS {
        let value = best_quality_metric_value(objective, spec.metric_id)
            .ok_or_else(|| format!("{} metric {} is absent", run.profile_id, spec.metric_id))?;
        if !value.is_finite() {
            return Err(format!(
                "{} metric {} is not finite",
                run.profile_id, spec.metric_id
            ));
        }
    }
    let result = run
        .result
        .as_ref()
        .filter(|result| result.output_format == "gif")
        .ok_or_else(|| format!("{} has no GIF conversion result", run.profile_id))?;
    if result.size_bytes != metrics.size_bytes {
        return Err(format!(
            "{} result size {} differs from measured size {}",
            run.profile_id, result.size_bytes, metrics.size_bytes
        ));
    }
    let inspection = run
        .output_inspection
        .as_ref()
        .ok_or_else(|| format!("{} has no output inspection", run.profile_id))?;
    if inspection.frame_count != metrics.frame_count
        || (inspection.duration - metrics.duration_seconds).abs() > f64::EPSILON
    {
        return Err(format!(
            "{} output inspection differs from measured timeline",
            run.profile_id
        ));
    }
    Ok((metrics, objective, result))
}

fn build_best_quality_pair(
    source: &SourceSnapshot,
    candidate_profile: &ProfileSpec,
    reference_profile: &ProfileSpec,
    runs: &[QualityRunRecord],
) -> Result<BestQualityPairObservation, String> {
    let candidate = unique_quality_run(runs, &source.fixture_id, &candidate_profile.id)?;
    let reference = unique_quality_run(runs, &source.fixture_id, &reference_profile.id)?;
    let (candidate_metrics, candidate_objective, _) = validate_best_quality_run(candidate, source)?;
    let (reference_metrics, reference_objective, reference_result) =
        validate_best_quality_run(reference, source)?;
    if reference_result.backend_id != "ffmpeg.animation" {
        return Err(format!(
            "{} did not use the FFmpeg animation backend",
            reference_profile.id
        ));
    }
    if reference_result.status != "target_exact" {
        return Err(format!(
            "{} status is {}, expected target_exact",
            reference_profile.id, reference_result.status
        ));
    }
    if reference
        .request
        .get("generation_mode")
        .and_then(Value::as_str)
        != Some("target_size")
        || reference
            .request
            .get("target_constraint")
            .and_then(Value::as_str)
            != Some("symmetric_match")
    {
        return Err(format!(
            "{} request is not a symmetric_match target-size reference",
            reference_profile.id
        ));
    }
    let target_report = reference_result
        .target_optimizer_report
        .as_ref()
        .filter(|report| {
            report.constraint == "symmetric_match"
                && report.selection_policy
                    == "symmetric_match_closest_real_bytes_plus_route_probe_v1"
        })
        .ok_or_else(|| {
            format!(
                "{} did not report the frozen symmetric_match selection policy",
                reference_profile.id
            )
        })?;
    let selected_routes = target_report
        .route_observations
        .iter()
        .filter(|route| route.selected)
        .collect::<Vec<_>>();
    if selected_routes.len() != 1 {
        return Err(format!(
            "{} reported {} selected routes instead of one",
            reference_profile.id,
            selected_routes.len()
        ));
    }
    let selected_route = selected_routes[0];
    if selected_route.route_id != target_report.selected_route_id
        || selected_route.status != "encoded"
        || selected_route.timeline != "cfr"
        || !selected_route.timeline_verified
        || selected_route.size_bytes != Some(reference_metrics.size_bytes)
    {
        return Err(format!(
            "{} selected route is not a verified CFR reference with matching real bytes",
            reference_profile.id
        ));
    }
    let objective_contract_matches = candidate_objective.analysis_fps
        == reference_objective.analysis_fps
        && candidate_objective.compared_frames == reference_objective.compared_frames
        && candidate_objective.presentation_width == reference_objective.presentation_width
        && candidate_objective.presentation_height == reference_objective.presentation_height
        && candidate_objective.sample_width == reference_objective.sample_width
        && candidate_objective.sample_height == reference_objective.sample_height;
    if !objective_contract_matches {
        return Err("candidate/reference objective sampling contracts differ".to_string());
    }
    let size_delta_percent =
        symmetric_size_delta_percent(candidate_metrics.size_bytes, reference_metrics.size_bytes);
    if size_delta_percent > BEST_QUALITY_MAX_SIZE_DELTA_PERCENT {
        return Err(format!(
            "symmetric size delta {size_delta_percent:.4}% exceeds {:.2}%",
            BEST_QUALITY_MAX_SIZE_DELTA_PERCENT
        ));
    }
    let mut metrics = Vec::with_capacity(BEST_QUALITY_METRIC_SPECS.len());
    for spec in BEST_QUALITY_METRIC_SPECS {
        if best_quality_metric_applies(spec, source, candidate_objective, reference_objective)? {
            metrics.push(compare_best_quality_metric(
                spec,
                best_quality_metric_value(candidate_objective, spec.metric_id)
                    .expect("known metric"),
                best_quality_metric_value(reference_objective, spec.metric_id)
                    .expect("known metric"),
            ));
        }
    }
    Ok(BestQualityPairObservation {
        fixture_id: source.fixture_id.clone(),
        category: source.category.clone(),
        candidate_size_bytes: candidate_metrics.size_bytes,
        reference_size_bytes: reference_metrics.size_bytes,
        size_delta_percent,
        candidate_output_sha256: candidate
            .output_sha256
            .clone()
            .expect("validated candidate SHA-256"),
        reference_output_sha256: reference
            .output_sha256
            .clone()
            .expect("validated reference SHA-256"),
        metrics,
    })
}

fn best_quality_nearest_rank(values: &[f64], percentile: f64) -> Option<f64> {
    if values.is_empty() || !percentile.is_finite() || !(0.0..=1.0).contains(&percentile) {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = (percentile * sorted.len() as f64).ceil().max(1.0) as usize;
    sorted.get(rank.saturating_sub(1)).copied()
}

fn build_best_quality_acceptance_slice(
    category: String,
    expected_pair_count: usize,
    pairs: &[&BestQualityPairObservation],
    overall_gate: bool,
) -> BestQualityAcceptanceSlice {
    let metrics = BEST_QUALITY_METRIC_SPECS
        .iter()
        .map(|spec| {
            let comparisons = pairs
                .iter()
                .filter_map(|pair| {
                    pair.metrics
                        .iter()
                        .find(|metric| metric.metric_id == spec.metric_id)
                })
                .collect::<Vec<_>>();
            let win_count = comparisons
                .iter()
                .filter(|comparison| comparison.outcome == "win")
                .count();
            let tie_count = comparisons
                .iter()
                .filter(|comparison| comparison.outcome == "tie")
                .count();
            let loss_count = comparisons
                .iter()
                .filter(|comparison| comparison.outcome == "loss")
                .count();
            let decisive_count = win_count + loss_count;
            let applicable_pair_count = comparisons.len();
            let win_rate = calibration_rate(win_count, applicable_pair_count);
            let loss_rate = calibration_rate(loss_count, applicable_pair_count);
            let decisive_win_rate = calibration_rate(win_count, decisive_count);
            let mean_quality_improvement = (!comparisons.is_empty()).then(|| {
                comparisons
                    .iter()
                    .map(|comparison| comparison.quality_improvement)
                    .sum::<f64>()
                    / comparisons.len() as f64
            });
            let mean_quality_improvement_in_tie_units = (!comparisons.is_empty()).then(|| {
                comparisons
                    .iter()
                    .map(|comparison| comparison.quality_improvement_in_tie_units)
                    .sum::<f64>()
                    / comparisons.len() as f64
            });
            let improvements = comparisons
                .iter()
                .map(|comparison| comparison.quality_improvement)
                .collect::<Vec<_>>();
            let minimum_quality_improvement = improvements.iter().copied().min_by(f64::total_cmp);
            let maximum_quality_improvement = improvements.iter().copied().max_by(f64::total_cmp);
            let severe_regression_count = comparisons
                .iter()
                .filter(|comparison| comparison.severe_regression)
                .count();
            let passed = if applicable_pair_count == 0 {
                // A category need not contain every conditional feature, but
                // the canonical overall corpus must exercise every declared
                // first-tier guard. Otherwise a missing alpha/loop/static/edge
                // measurement could silently pass as "not applicable".
                !overall_gate
            } else if severe_regression_count > 0 {
                false
            } else if overall_gate {
                match spec.metric_id {
                    "vmaf_neg_mean" => {
                        win_rate.is_some_and(|rate| rate >= BEST_QUALITY_REQUIRED_VMAF_WIN_RATE)
                            && loss_rate.is_some_and(|rate| rate <= 0.10)
                            && mean_quality_improvement.is_some_and(|mean| mean >= 0.50)
                    }
                    "vmaf_neg_p05" => {
                        loss_rate.is_some_and(|rate| rate <= 0.25)
                            && mean_quality_improvement.is_some_and(|mean| mean >= -0.50)
                    }
                    _ => {
                        loss_rate
                            .is_some_and(|rate| rate <= BEST_QUALITY_OVERALL_GUARD_MAX_LOSS_RATE)
                            && mean_quality_improvement_in_tie_units.is_some_and(|mean| {
                                mean >= BEST_QUALITY_OVERALL_GUARD_MIN_MEAN_TIE_UNITS
                            })
                    }
                }
            } else {
                match spec.metric_id {
                    "vmaf_neg_mean" => {
                        loss_rate.is_some_and(|rate| rate <= 0.25)
                            && mean_quality_improvement.is_some_and(|mean| mean >= -0.25)
                    }
                    "vmaf_neg_p05" => loss_rate.is_some_and(|rate| rate <= 0.25),
                    _ => {
                        loss_rate
                            .is_some_and(|rate| rate <= BEST_QUALITY_CATEGORY_GUARD_MAX_LOSS_RATE)
                            && mean_quality_improvement_in_tie_units.is_some_and(|mean| {
                                mean >= BEST_QUALITY_CATEGORY_GUARD_MIN_MEAN_TIE_UNITS
                            })
                    }
                }
            };
            BestQualityMetricSummary {
                metric_id: spec.metric_id.to_string(),
                direction: spec.direction.wire_name().to_string(),
                applicable_pair_count,
                win_count,
                tie_count,
                loss_count,
                win_rate,
                loss_rate,
                decisive_count,
                decisive_win_rate,
                mean_quality_improvement,
                mean_quality_improvement_in_tie_units,
                minimum_quality_improvement,
                p05_quality_improvement: best_quality_nearest_rank(&improvements, 0.05),
                median_quality_improvement: best_quality_nearest_rank(&improvements, 0.50),
                p95_quality_improvement: best_quality_nearest_rank(&improvements, 0.95),
                maximum_quality_improvement,
                severe_regression_count,
                passed,
            }
        })
        .collect::<Vec<_>>();
    let eligible_pair_count = pairs.len();
    let pair_coverage = calibration_rate(eligible_pair_count, expected_pair_count);
    let passed = expected_pair_count > 0
        && eligible_pair_count == expected_pair_count
        && metrics.iter().all(|metric| metric.passed);
    BestQualityAcceptanceSlice {
        category,
        expected_pair_count,
        eligible_pair_count,
        pair_coverage,
        metrics,
        passed,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_best_quality_acceptance(
    manifest: &CorpusManifest,
    manifest_sha256: &str,
    sources: &[SourceSnapshot],
    runs: &[QualityRunRecord],
    git_commit: Option<&str>,
    git_dirty: Option<bool>,
    build_provenance_passed: bool,
    toolchain: &ToolchainSnapshot,
) -> BestQualityAcceptanceReport {
    let profile_pair = select_best_quality_profile_pair(manifest);
    let applicable = profile_pair.is_ok();
    let candidate_profile_id = profile_pair
        .as_ref()
        .ok()
        .map(|(candidate, _)| candidate.id.clone());
    let reference_profile_id = profile_pair
        .as_ref()
        .ok()
        .map(|(_, reference)| reference.id.clone());
    let provenance_passed = build_provenance_passed
        && git_dirty == Some(false)
        && git_commit.is_some_and(|commit| valid_quality_hash(commit, 40));
    let canonical_corpus_passed = manifest.corpus_id == BEST_QUALITY_CANONICAL_CORPUS_ID
        && manifest_sha256 == BEST_QUALITY_CANONICAL_MANIFEST_SHA256;
    let manifest_fixture_ids = manifest
        .fixtures
        .iter()
        .map(|fixture| fixture.id.as_str())
        .collect::<HashSet<_>>();
    let canonical_fixture_identity_passed = manifest.canonical_fixture_identity.status
        == "complete"
        && toolchain.canonical_generator_identity_passed
        && sources.len() == manifest.fixtures.len()
        && sources.iter().all(|source| {
            manifest_fixture_ids.contains(source.fixture_id.as_str())
                && source.canonical_identity_passed
                && source.expected_source_sha256.as_deref() == Some(source.sha256.as_str())
        });
    let expected_pair_count = sources.len();
    let mut pairs = Vec::with_capacity(expected_pair_count);
    let mut omissions = Vec::new();
    match profile_pair.as_ref() {
        Ok((candidate, reference)) => {
            for source in sources {
                match build_best_quality_pair(source, candidate, reference, runs) {
                    Ok(pair) => pairs.push(pair),
                    Err(reason) => omissions.push(BestQualityPairOmission {
                        fixture_id: source.fixture_id.clone(),
                        category: source.category.clone(),
                        reason,
                    }),
                }
            }
        }
        Err(reason) => {
            for source in sources {
                omissions.push(BestQualityPairOmission {
                    fixture_id: source.fixture_id.clone(),
                    category: source.category.clone(),
                    reason: reason.clone(),
                });
            }
        }
    }
    pairs.sort_by(|left, right| left.fixture_id.cmp(&right.fixture_id));
    omissions.sort_by(|left, right| left.fixture_id.cmp(&right.fixture_id));

    let mut expected_by_category = BTreeMap::<String, usize>::new();
    for source in sources {
        *expected_by_category
            .entry(source.category.clone())
            .or_default() += 1;
    }
    let pair_refs = pairs.iter().collect::<Vec<_>>();
    let overall = build_best_quality_acceptance_slice(
        "all".to_string(),
        expected_pair_count,
        &pair_refs,
        true,
    );
    let categories = expected_by_category
        .iter()
        .map(|(category, expected)| {
            let category_pairs = pairs
                .iter()
                .filter(|pair| pair.category == *category)
                .collect::<Vec<_>>();
            build_best_quality_acceptance_slice(category.clone(), *expected, &category_pairs, false)
        })
        .collect::<Vec<_>>();
    let eligible_pair_count = pairs.len();
    let pair_coverage = calibration_rate(eligible_pair_count, expected_pair_count);
    let mut violations = Vec::new();
    if let Err(error) = profile_pair {
        violations.push(error);
    }
    if !provenance_passed {
        violations.push(
            "formal quality acceptance requires a clean worktree and a 40-character commit SHA"
                .to_string(),
        );
    }
    if !canonical_corpus_passed {
        violations.push(format!(
            "formal quality acceptance requires canonical corpus {} at manifest SHA-256 {}",
            BEST_QUALITY_CANONICAL_CORPUS_ID, BEST_QUALITY_CANONICAL_MANIFEST_SHA256
        ));
    }
    if !canonical_fixture_identity_passed {
        violations.push(
            "formal quality acceptance requires a complete fixed identity for every canonical fixture and the reviewed FFmpeg/FFprobe toolchain"
                .to_string(),
        );
    }
    if expected_pair_count < BEST_QUALITY_MINIMUM_PAIR_COUNT {
        violations.push(format!(
            "expected pair count {expected_pair_count} is below the minimum {}",
            BEST_QUALITY_MINIMUM_PAIR_COUNT
        ));
    }
    if expected_by_category.len() < BEST_QUALITY_MINIMUM_CATEGORY_COUNT {
        violations.push(format!(
            "category count {} is below the minimum {}",
            expected_by_category.len(),
            BEST_QUALITY_MINIMUM_CATEGORY_COUNT
        ));
    }
    if pair_coverage.is_none_or(|coverage| coverage < BEST_QUALITY_REQUIRED_PAIR_COVERAGE) {
        violations.push(format!(
            "eligible same-size pair coverage is {eligible_pair_count}/{expected_pair_count}; {:.0}% is required",
            BEST_QUALITY_REQUIRED_PAIR_COVERAGE * 100.0
        ));
    }
    for metric in &overall.metrics {
        if !metric.passed {
            violations.push(format!(
                "overall {} failed: {} win / {} loss / {} tie, {} severe regression(s)",
                metric.metric_id,
                metric.win_count,
                metric.loss_count,
                metric.tie_count,
                metric.severe_regression_count
            ));
        }
    }
    for category in &categories {
        if !category.passed {
            violations.push(format!(
                "category '{}' failed same-size non-regression or coverage",
                category.category
            ));
        }
    }
    let passed =
        violations.is_empty() && overall.passed && categories.iter().all(|slice| slice.passed);
    BestQualityAcceptanceReport {
        acceptance_id: "gifp.best_same_size.first_tier.v1".to_string(),
        corpus_id: manifest.corpus_id.clone(),
        corpus_manifest_sha256: manifest_sha256.to_string(),
        canonical_corpus_passed,
        canonical_fixture_identity_passed,
        applicable,
        candidate_profile_id,
        reference_profile_id,
        maximum_size_delta_percent: BEST_QUALITY_MAX_SIZE_DELTA_PERCENT,
        minimum_pair_count: BEST_QUALITY_MINIMUM_PAIR_COUNT,
        minimum_category_count: BEST_QUALITY_MINIMUM_CATEGORY_COUNT,
        required_pair_coverage: BEST_QUALITY_REQUIRED_PAIR_COVERAGE,
        required_vmaf_win_rate: BEST_QUALITY_REQUIRED_VMAF_WIN_RATE,
        provenance_passed,
        expected_pair_count,
        eligible_pair_count,
        omitted_pair_count: omissions.len(),
        pair_coverage,
        overall,
        categories,
        pairs,
        omissions,
        passed,
        violations,
    }
}

fn run_manifest(
    loaded: &LoadedManifest,
    fixtures: Vec<PreparedFixture>,
    ffmpeg: &Path,
    ffprobe: &Path,
    report_path: &Path,
    provenance_context: QualityProvenanceContext,
    toolchain: ToolchainSnapshot,
) -> Result<(QualityLabReport, PathBuf), String> {
    let generated_at_unix_ms = unix_millis();
    let repository_root = provenance_context.repository_root.clone();
    let runtime_start = provenance_context.runtime_start.clone();
    let git_commit = runtime_start.commit.clone();
    let git_dirty = runtime_start.dirty;
    let executor_start_sha256 = provenance_context.executor_start_sha256.clone();
    let revision = git_commit
        .as_deref()
        .map(|commit| commit.chars().take(12).collect::<String>())
        .unwrap_or_else(|| "no-git".to_string());
    let absolute_report_path = absolute_path(report_path)?;
    let report_parent = absolute_report_path
        .parent()
        .ok_or_else(|| "Report path has no parent directory".to_string())?;
    let (run_id, run_root) =
        create_exclusive_run_root(report_parent, &revision, generated_at_unix_ms)?;

    let sources: Vec<SourceSnapshot> = fixtures
        .iter()
        .map(|fixture| SourceSnapshot {
            fixture_id: fixture.spec.id.clone(),
            category: fixture.spec.category.clone(),
            tags: fixture.spec.tags.clone(),
            path: fixture.path.to_string_lossy().to_string(),
            sha256: fixture.sha256.clone(),
            expected_source_sha256: fixture.spec.expected_source_sha256.clone(),
            canonical_identity_passed: fixture.spec.expected_source_sha256.as_deref()
                == Some(fixture.sha256.as_str()),
            inspection: fixture.inspection.clone(),
        })
        .collect();
    let mut runs = Vec::with_capacity(fixtures.len() * loaded.manifest.profiles.len());

    for fixture in &fixtures {
        for profile in &loaded.manifest.profiles {
            println!("Encoding {} / {}", fixture.spec.id, profile.id);
            let output_dir = run_root.join(&fixture.spec.id).join(&profile.id);
            fs::create_dir_all(&output_dir).map_err(|error| {
                format!(
                    "Failed to create output directory {}: {error}",
                    output_dir.display()
                )
            })?;
            let target_size_bytes = match matched_target_size(profile, fixture, &runs) {
                Ok(value) => value,
                Err(error) => {
                    let request = build_request_value(
                        fixture,
                        profile,
                        &output_dir,
                        None,
                        MatchedRequestCeiling {
                            fps: profile.fps,
                            colors: profile.colors,
                        },
                    );
                    let request_sha256 = request_fingerprint(&request, &fixture.sha256)?;
                    runs.push(QualityRunRecord {
                        fixture_id: fixture.spec.id.clone(),
                        profile_id: profile.id.clone(),
                        status: "error".to_string(),
                        source_sha256: fixture.sha256.clone(),
                        request_sha256,
                        request,
                        output_sha256: None,
                        metrics: None,
                        correctness: None,
                        output_inspection: None,
                        result: None,
                        error: Some(error),
                    });
                    continue;
                }
            };
            let request_ceiling =
                matched_request_ceiling(profile, fixture, target_size_bytes, &runs);
            let request = build_request_value(
                fixture,
                profile,
                &output_dir,
                target_size_bytes,
                request_ceiling,
            );
            let request_sha256 = request_fingerprint(&request, &fixture.sha256)?;
            let decoded: GifRequest = serde_json::from_value(request.clone()).map_err(|error| {
                format!(
                    "Failed to construct request for '{}' / '{}': {error}",
                    fixture.spec.id, profile.id
                )
            })?;
            let memory_sampler = ProcessTreeMemorySampler::start();
            let run_started = Instant::now();
            let conversion = convert_animation_inner(decoded);
            let encode_wall_elapsed_ms = elapsed_millis(run_started);
            let encode_memory = memory_sampler.and_then(ProcessTreeMemorySampler::finish);

            let record = match conversion {
                Ok(result) => match inspect_and_hash_output(ffprobe, &result) {
                    Ok((inspection, output_sha256)) => {
                        let metric_started = Instant::now();
                        let objective = evaluate_quality(
                            ffmpeg,
                            &fixture.path,
                            Path::new(&result.output_path),
                            &fixture.inspection,
                            &inspection,
                            fixture.spec.duration_seconds,
                            &output_dir,
                        );
                        let metric_elapsed_ms = elapsed_millis(metric_started);
                        let total_wall_elapsed_ms = elapsed_millis(run_started);
                        match objective {
                            Ok(objective) => {
                                let correctness =
                                    evaluate_correctness(fixture, &inspection, &objective);
                                let status = if correctness.all_passed {
                                    "ok"
                                } else {
                                    "gate_failed"
                                };
                                let error = (!correctness.all_passed)
                                    .then(|| correctness.violations.join("; "));
                                QualityRunRecord {
                                    fixture_id: fixture.spec.id.clone(),
                                    profile_id: profile.id.clone(),
                                    status: status.to_string(),
                                    source_sha256: fixture.sha256.clone(),
                                    request_sha256,
                                    request,
                                    output_sha256: Some(output_sha256),
                                    metrics: Some(QualityMetrics {
                                        size_bytes: result.size_bytes,
                                        frame_count: inspection.frame_count,
                                        duration_seconds: inspection.duration,
                                        encode_elapsed_ms: result.elapsed_ms,
                                        encode_wall_elapsed_ms,
                                        encode_memory: encode_memory.clone(),
                                        metric_elapsed_ms,
                                        total_wall_elapsed_ms,
                                        objective: Some(objective),
                                    }),
                                    correctness: Some(correctness),
                                    output_inspection: Some(inspection),
                                    result: Some(result),
                                    error,
                                }
                            }
                            Err(error) => QualityRunRecord {
                                fixture_id: fixture.spec.id.clone(),
                                profile_id: profile.id.clone(),
                                status: "error".to_string(),
                                source_sha256: fixture.sha256.clone(),
                                request_sha256,
                                request,
                                output_sha256: Some(output_sha256),
                                metrics: Some(QualityMetrics {
                                    size_bytes: result.size_bytes,
                                    frame_count: inspection.frame_count,
                                    duration_seconds: inspection.duration,
                                    encode_elapsed_ms: result.elapsed_ms,
                                    encode_wall_elapsed_ms,
                                    encode_memory,
                                    metric_elapsed_ms,
                                    total_wall_elapsed_ms,
                                    objective: None,
                                }),
                                correctness: None,
                                output_inspection: Some(inspection),
                                result: Some(result),
                                error: Some(error),
                            },
                        }
                    }
                    Err(error) => QualityRunRecord {
                        fixture_id: fixture.spec.id.clone(),
                        profile_id: profile.id.clone(),
                        status: "error".to_string(),
                        source_sha256: fixture.sha256.clone(),
                        request_sha256,
                        request,
                        output_sha256: None,
                        metrics: None,
                        correctness: None,
                        output_inspection: None,
                        result: Some(result),
                        error: Some(error),
                    },
                },
                Err(error) => QualityRunRecord {
                    fixture_id: fixture.spec.id.clone(),
                    profile_id: profile.id.clone(),
                    status: "error".to_string(),
                    source_sha256: fixture.sha256.clone(),
                    request_sha256,
                    request,
                    output_sha256: None,
                    metrics: None,
                    correctness: None,
                    output_inspection: None,
                    result: None,
                    error: Some(error.to_string()),
                },
            };
            runs.push(record);
        }
    }

    let successful_runs = runs.iter().filter(|run| run.status == "ok").count();
    let failed_runs = runs.len() - successful_runs;
    let target_reinvestment_calibration =
        build_target_reinvestment_calibration(&loaded.manifest, &sources, &runs);
    let target_hard_cap_acceptance =
        build_target_hard_cap_acceptance(&loaded.manifest, &sources, &runs);
    let runtime_end = capture_runtime_git_snapshot(repository_root.as_deref());
    let executor_end_sha256 = current_executor_sha256()?;
    let build_provenance = evaluate_build_provenance(
        &run_id,
        runtime_start.clone(),
        runtime_end,
        executor_start_sha256.clone(),
        executor_end_sha256,
    );
    let best_quality_acceptance = build_best_quality_acceptance(
        &loaded.manifest,
        &loaded.sha256,
        &sources,
        &runs,
        git_commit.as_deref(),
        git_dirty,
        build_provenance.passed,
        &toolchain,
    );
    let performance_baseline = build_performance_baseline(&loaded.manifest, &sources, &runs);
    let report = QualityLabReport {
        schema_version: QUALITY_REPORT_SCHEMA_VERSION,
        run_id,
        generated_at_unix_ms,
        manifest_path: loaded.path.to_string_lossy().to_string(),
        manifest_sha256: loaded.sha256.clone(),
        git_commit,
        git_dirty,
        host: capture_host_snapshot(),
        toolchain,
        manifest: loaded.manifest.clone(),
        sources,
        successful_runs,
        failed_runs,
        target_reinvestment_calibration,
        target_hard_cap_acceptance,
        best_quality_acceptance,
        performance_baseline,
        runs,
        artifact_bundle: None,
        provenance_context,
        build_provenance: Some(build_provenance),
    };
    Ok((report, run_root))
}

fn refresh_report_build_provenance(report: &mut QualityLabReport) -> Result<(), String> {
    let runtime_end =
        capture_runtime_git_snapshot(report.provenance_context.repository_root.as_deref());
    let executor_end_sha256 = current_executor_sha256()?;
    let evidence = evaluate_build_provenance(
        &report.run_id,
        report.provenance_context.runtime_start.clone(),
        runtime_end,
        report.provenance_context.executor_start_sha256.clone(),
        executor_end_sha256,
    );
    report.git_commit = report.provenance_context.runtime_start.commit.clone();
    report.git_dirty = report.provenance_context.runtime_start.dirty;
    report.best_quality_acceptance = build_best_quality_acceptance(
        &report.manifest,
        &report.manifest_sha256,
        &report.sources,
        &report.runs,
        report.git_commit.as_deref(),
        report.git_dirty,
        evidence.passed,
        &report.toolchain,
    );
    report.build_provenance = Some(evidence);
    Ok(())
}

fn verify_report_build_provenance_seal(
    report: &QualityLabReport,
    checkpoint: &str,
) -> Result<(), String> {
    let sealed = report
        .build_provenance
        .as_ref()
        .ok_or_else(|| "Quality Lab build provenance was not sealed".to_string())?;
    let runtime_now =
        capture_runtime_git_snapshot(report.provenance_context.repository_root.as_deref());
    let executor_now_sha256 = current_executor_sha256()?;
    if runtime_now != sealed.runtime_end {
        return Err(format!(
            "Quality Lab runtime Git state changed after provenance sealing ({checkpoint})"
        ));
    }
    if executor_now_sha256 != sealed.executor_end_sha256 {
        return Err(format!(
            "Quality Lab executor changed after provenance sealing ({checkpoint})"
        ));
    }
    let recomputed = evaluate_build_provenance(
        &report.run_id,
        report.provenance_context.runtime_start.clone(),
        runtime_now,
        report.provenance_context.executor_start_sha256.clone(),
        executor_now_sha256,
    );
    if &recomputed != sealed {
        return Err(format!(
            "Quality Lab build provenance no longer matches its sealed evidence ({checkpoint})"
        ));
    }
    Ok(())
}

fn build_request_value(
    fixture: &PreparedFixture,
    profile: &ProfileSpec,
    output_dir: &Path,
    target_size_bytes: Option<u64>,
    ceiling: MatchedRequestCeiling,
) -> Value {
    json!({
        "schema_version": ENCODE_REQUEST_SCHEMA_VERSION,
        "input_path": fixture.path.to_string_lossy(),
        "output_dir": output_dir.to_string_lossy(),
        "width": profile.width,
        "fps": ceiling.fps,
        "colors": ceiling.colors,
        "dither": profile.dither,
        "optimize_level": profile.optimize_level,
        "lossy": profile.lossy,
        "start_seconds": 0.0,
        "end_seconds": fixture.spec.duration_seconds,
        "encoder": profile.encoder,
        "filter_style": profile.filter_style,
        "loop_output": true,
        "crop_enabled": false,
        "crop_left": 0.0,
        "crop_top": 0.0,
        "crop_right": 0.0,
        "crop_bottom": 0.0,
        "deleted_frames": [],
        "playback_speed": 1.0,
        "output_format": "gif",
        "generation_mode": profile.generation_mode,
        "target_size_bytes": target_size_bytes,
        "target_tolerance_percent": 5.0,
        "target_max_attempts": 12,
        "target_constraint": profile.effective_target_constraint().as_str(),
        "bayer_scale": profile.bayer_scale,
        "alpha_threshold": profile.alpha_threshold,
        "allow_experimental": profile.allow_experimental,
        "perceptual_focus": profile.perceptual_focus,
    })
}

fn matched_request_ceiling(
    profile: &ProfileSpec,
    fixture: &PreparedFixture,
    target_size_bytes: Option<u64>,
    runs: &[QualityRunRecord],
) -> MatchedRequestCeiling {
    let base = MatchedRequestCeiling {
        fps: profile.fps,
        colors: profile.colors,
    };
    if profile.match_target_profile_id.is_none()
        || profile.effective_target_constraint() != TargetConstraint::SymmetricMatch
    {
        return base;
    }
    let Some(target_size_bytes) = target_size_bytes else {
        return base;
    };
    let ffmpeg_ceiling_size = runs.iter().rev().find_map(|run| {
        let request = &run.request;
        let is_matching_fast_ceiling = run.fixture_id == fixture.spec.id
            && request.get("generation_mode").and_then(Value::as_str) == Some("fast_gif")
            && request.get("width").and_then(Value::as_u64) == Some(u64::from(profile.width))
            && request.get("fps").and_then(Value::as_u64) == Some(u64::from(profile.fps))
            && request.get("colors").and_then(Value::as_u64) == Some(u64::from(profile.colors))
            && run
                .result
                .as_ref()
                .is_some_and(|result| result.backend_id == "ffmpeg.animation");
        if is_matching_fast_ceiling {
            run.metrics.as_ref().map(|metrics| metrics.size_bytes)
        } else {
            None
        }
    });
    ffmpeg_ceiling_size.map_or(base, |ceiling_size| {
        let colors = expanded_match_color_ceiling(profile.colors, target_size_bytes, ceiling_size);
        let source_fps = if fixture.inspection.duration > f64::EPSILON {
            fixture.inspection.frame_count as f64 / fixture.inspection.duration
        } else {
            f64::from(profile.fps)
        };
        MatchedRequestCeiling {
            fps: expanded_match_fps_ceiling(profile.fps, colors, source_fps),
            colors,
        }
    })
}

fn expanded_match_color_ceiling(base_colors: u16, target_size: u64, ceiling_size: u64) -> u16 {
    if target_size <= ceiling_size || symmetric_size_delta_percent(target_size, ceiling_size) <= 5.0
    {
        return base_colors;
    }
    // Palette cardinality has a sub-linear effect on GIF size. Empirically,
    // scaling the color ceiling by the squared byte ratio reaches the next
    // useful ladder rung without changing width or frame rate first.
    let size_ratio = target_size as f64 / ceiling_size.max(1) as f64;
    let estimated = (f64::from(base_colors) * size_ratio * size_ratio).ceil() as u16;
    const COLOR_LADDER: [u16; 16] = [
        3, 4, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256,
    ];
    COLOR_LADDER
        .into_iter()
        .find(|colors| *colors >= estimated.max(base_colors))
        .unwrap_or(256)
}

fn expanded_match_fps_ceiling(base_fps: u32, colors: u16, source_fps: f64) -> u32 {
    if colors < 256 || !source_fps.is_finite() {
        return base_fps;
    }
    (source_fps.round() as u32).clamp(base_fps, 60)
}

fn matched_target_size(
    profile: &ProfileSpec,
    fixture: &PreparedFixture,
    runs: &[QualityRunRecord],
) -> Result<Option<u64>, String> {
    let Some(target_profile_id) = profile.match_target_profile_id.as_deref() else {
        return Ok(None);
    };
    let target = runs
        .iter()
        .rev()
        .find(|run| run.fixture_id == fixture.spec.id && run.profile_id == target_profile_id)
        .ok_or_else(|| {
            format!(
                "Matched target profile '{target_profile_id}' has no run for '{}'",
                fixture.spec.id
            )
        })?;
    let size_bytes = target
        .metrics
        .as_ref()
        .map(|metrics| metrics.size_bytes)
        .ok_or_else(|| {
            format!(
                "Matched target profile '{target_profile_id}' produced no measurable output for '{}'",
                fixture.spec.id
            )
        })?;
    let scaled = (size_bytes as f64 * profile.effective_target_size_scale()).ceil();
    if !scaled.is_finite() || scaled <= 0.0 || scaled > u64::MAX as f64 {
        return Err(format!(
            "Matched target profile '{target_profile_id}' produced an invalid scaled target for '{}'",
            fixture.spec.id
        ));
    }
    Ok(Some(scaled as u64))
}

fn inspect_and_hash_output(
    ffprobe: &Path,
    result: &GifResult,
) -> Result<(MediaInspection, String), String> {
    let output_path = Path::new(&result.output_path);
    let inspection = inspect_media_file(ffprobe, output_path).map_err(|error| {
        format!(
            "Failed to inspect output {}: {error}",
            output_path.display()
        )
    })?;
    let sha256 = sha256_file(output_path)?;
    Ok((inspection, sha256))
}

fn evaluate_correctness(
    fixture: &PreparedFixture,
    inspection: &MediaInspection,
    objective: &ObjectiveQualityMetrics,
) -> CorrectnessReport {
    let duration_error_ms = (inspection.duration - fixture.spec.duration_seconds).abs() * 1_000.0;
    let duration_passed = duration_error_ms <= DURATION_TOLERANCE_MS;
    let expected_analysis_frames =
        (fixture.spec.duration_seconds * f64::from(objective.analysis_fps)).round() as u64;
    let frame_count_passed = inspection.frame_count > 0
        && objective.compared_frames == expected_analysis_frames
        && objective.status == "full";
    let alpha_required = fixture.spec.tags.iter().any(|tag| tag == "transparent");
    let alpha_coverage_tolerance = alpha_coverage_tolerance(&fixture.spec.tags);
    let alpha_passed = !alpha_required
        || (inspection.has_alpha && objective.alpha_coverage_error <= alpha_coverage_tolerance);
    let seamless_loop_required = fixture.spec.tags.iter().any(|tag| tag == "seamless-loop");
    let seamless_loop_passed =
        !seamless_loop_required || objective.loop_seam_excess_oklab <= LOOP_SEAM_EXCESS_TOLERANCE;

    let mut violations = Vec::new();
    if !duration_passed {
        violations.push(format!(
            "duration error {duration_error_ms:.3}ms exceeds {DURATION_TOLERANCE_MS:.1}ms"
        ));
    }
    if !frame_count_passed {
        violations.push(format!(
            "timeline comparison expected {expected_analysis_frames} frames but measured {}",
            objective.compared_frames
        ));
    }
    if !alpha_passed {
        violations.push(format!(
            "alpha coverage error {:.4} exceeds {:.4} or output alpha is absent",
            objective.alpha_coverage_error, alpha_coverage_tolerance
        ));
    }
    if !seamless_loop_passed {
        violations.push(format!(
            "loop seam excess {:.4} exceeds {:.4}",
            objective.loop_seam_excess_oklab, LOOP_SEAM_EXCESS_TOLERANCE
        ));
    }
    CorrectnessReport {
        duration_error_ms,
        duration_passed,
        frame_count_passed,
        alpha_required,
        alpha_coverage_tolerance,
        alpha_passed,
        seamless_loop_required,
        seamless_loop_passed,
        all_passed: violations.is_empty(),
        violations,
    }
}

fn alpha_coverage_tolerance(tags: &[String]) -> f64 {
    if tags.iter().any(|tag| tag == "semi-transparent") {
        SEMI_TRANSPARENT_ALPHA_COVERAGE_TOLERANCE
    } else {
        ALPHA_COVERAGE_TOLERANCE
    }
}

fn request_fingerprint(request: &Value, source_sha256: &str) -> Result<String, String> {
    let mut normalized = request.clone();
    let object = normalized
        .as_object_mut()
        .ok_or_else(|| "Quality request must be a JSON object".to_string())?;
    object.insert(
        "input_path".to_string(),
        Value::String("<fixture-by-sha256>".to_string()),
    );
    object.insert(
        "output_dir".to_string(),
        Value::String("<quality-run-output>".to_string()),
    );
    let fingerprint = json!({
        "source_sha256": source_sha256,
        "request": normalized,
    });
    let bytes = serde_json::to_vec(&fingerprint)
        .map_err(|error| format!("Failed to serialize request fingerprint: {error}"))?;
    Ok(sha256_bytes(&bytes))
}

fn write_report(path: &Path, report: &QualityLabReport) -> Result<(), String> {
    let path = absolute_path(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create report directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(report)
        .map_err(|error| format!("Failed to serialize quality report: {error}"))?;
    write_bytes_atomically(&path, &bytes, "quality report")
}

fn write_report_commit_point(path: &Path, report: &QualityLabReport) -> Result<(), String> {
    let path = absolute_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("Quality report path {} has no parent", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create report directory {}: {error}",
            parent.display()
        )
    })?;
    let bytes = serde_json::to_vec_pretty(report)
        .map_err(|error| format!("Failed to serialize quality report: {error}"))?;
    let (staged, mut file) = reserve_quality_staging_file(parent, "commit-stage")?;
    let result = (|| {
        file.write_all(&bytes).map_err(|error| {
            format!(
                "Failed to stage quality report commit point {}: {error}",
                staged.display()
            )
        })?;
        file.flush().map_err(|error| {
            format!(
                "Failed to flush quality report commit point {}: {error}",
                staged.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "Failed to sync quality report commit point {}: {error}",
                staged.display()
            )
        })?;
        drop(file);
        verify_report_build_provenance_seal(report, "before publishing the commit point")?;
        verify_artifact_bundle(
            report
                .artifact_bundle
                .as_ref()
                .ok_or_else(|| "Quality Lab artifact bundle was not sealed".to_string())?,
        )?;
        publish_file_atomically(&staged, &path, true).map_err(|error| {
            format!(
                "Failed to atomically publish quality report commit point {}: {error}",
                path.display()
            )
        })
    })();
    let _ = fs::remove_file(&staged);
    result
}

fn write_report_bundle(
    run_root: &Path,
    report: &QualityLabReport,
) -> Result<ArtifactBundleReference, String> {
    let bundle_root = run_root.join("report-bundle");
    fs::create_dir(&bundle_root).map_err(|error| {
        format!(
            "Failed to create exclusive Quality Lab report bundle {}: {error}",
            bundle_root.display()
        )
    })?;
    let report_path = bundle_root.join("report.json");
    let csv_path = bundle_root.join("report.csv");
    let blind_path = bundle_root.join("blind.html");
    let build_provenance_path = bundle_root.join("build-provenance.json");
    write_report(&report_path, report)?;
    write_csv_report(&csv_path, report)?;
    write_blind_reports(&blind_path, report)?;
    let build_provenance = report
        .build_provenance
        .as_ref()
        .ok_or_else(|| "Quality Lab build provenance was not sealed".to_string())?;
    let build_provenance_bytes = serde_json::to_vec_pretty(build_provenance)
        .map_err(|error| format!("Failed to serialize Quality Lab build provenance: {error}"))?;
    write_bytes_atomically(
        &build_provenance_path,
        &build_provenance_bytes,
        "Quality Lab build provenance",
    )?;

    finalize_artifact_bundle(&bundle_root, &report.run_id)
}

fn finalize_artifact_bundle(
    bundle_root: &Path,
    run_id: &str,
) -> Result<ArtifactBundleReference, String> {
    let mut artifacts = collect_artifact_bundle_entries(bundle_root)?;
    artifacts.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let manifest = ArtifactBundleManifest {
        schema_version: ARTIFACT_BUNDLE_SCHEMA_VERSION,
        run_id: run_id.to_string(),
        artifacts: artifacts.clone(),
    };
    let manifest_path = bundle_root.join("bundle-manifest.json");
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize Quality Lab bundle manifest: {error}"))?;
    write_bytes_atomically(
        &manifest_path,
        &manifest_bytes,
        "Quality Lab bundle manifest",
    )?;
    let reference = ArtifactBundleReference {
        schema_version: ARTIFACT_BUNDLE_SCHEMA_VERSION,
        run_id: run_id.to_string(),
        root_path: fs::canonicalize(bundle_root)
            .map_err(|error| {
                format!(
                    "Failed to canonicalize Quality Lab bundle {}: {error}",
                    bundle_root.display()
                )
            })?
            .to_string_lossy()
            .to_string(),
        manifest_path: fs::canonicalize(&manifest_path)
            .map_err(|error| {
                format!(
                    "Failed to canonicalize Quality Lab bundle manifest {}: {error}",
                    manifest_path.display()
                )
            })?
            .to_string_lossy()
            .to_string(),
        manifest_sha256: sha256_file(&manifest_path)?,
        artifacts,
    };
    verify_artifact_bundle(&reference)?;
    Ok(reference)
}

fn collect_artifact_bundle_entries(root: &Path) -> Result<Vec<ArtifactBundleEntry>, String> {
    fn visit(
        root: &Path,
        directory: &Path,
        entries: &mut Vec<ArtifactBundleEntry>,
    ) -> Result<(), String> {
        let children = fs::read_dir(directory).map_err(|error| {
            format!(
                "Failed to inventory Quality Lab bundle directory {}: {error}",
                directory.display()
            )
        })?;
        for child in children {
            let child = child.map_err(|error| {
                format!(
                    "Failed to inspect Quality Lab bundle directory {}: {error}",
                    directory.display()
                )
            })?;
            let path = child.path();
            let file_type = child.file_type().map_err(|error| {
                format!(
                    "Failed to inspect Quality Lab bundle artifact {}: {error}",
                    path.display()
                )
            })?;
            if file_type.is_dir() {
                let resolved = canonical_path_within(root, &path, "artifact bundle directory")?;
                visit(root, &resolved, entries)?;
            } else if file_type.is_file() {
                if path.file_name().and_then(|value| value.to_str()) == Some("bundle-manifest.json")
                {
                    continue;
                }
                let resolved = canonical_path_within(root, &path, "artifact bundle file")?;
                let relative = resolved.strip_prefix(root).map_err(|error| {
                    format!(
                        "Failed to relativize Quality Lab bundle artifact {}: {error}",
                        resolved.display()
                    )
                })?;
                let relative_path = relative
                    .components()
                    .map(|component| component.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                let size_bytes = child
                    .metadata()
                    .map_err(|error| {
                        format!(
                            "Failed to inspect Quality Lab bundle artifact {}: {error}",
                            path.display()
                        )
                    })?
                    .len();
                entries.push(ArtifactBundleEntry {
                    role: artifact_bundle_role(relative),
                    relative_path,
                    sha256: sha256_file(&resolved)?,
                    size_bytes,
                });
            } else {
                return Err(format!(
                    "Quality Lab bundle contains unsupported artifact {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    let mut entries = Vec::new();
    let root = fs::canonicalize(root).map_err(|error| {
        format!(
            "Failed to canonicalize Quality Lab artifact bundle {}: {error}",
            root.display()
        )
    })?;
    visit(&root, &root, &mut entries)?;
    Ok(entries)
}

fn artifact_bundle_role(relative_path: &Path) -> String {
    match relative_path.to_string_lossy().replace('\\', "/").as_str() {
        "report.json" => "report_json".to_string(),
        "report.csv" => "report_csv".to_string(),
        "build-provenance.json" => "build_provenance".to_string(),
        path if path.ends_with(".html") => "blind_html".to_string(),
        path if path.ends_with(".gif") => "blind_asset".to_string(),
        _ => "artifact".to_string(),
    }
}

fn verify_artifact_bundle(reference: &ArtifactBundleReference) -> Result<(), String> {
    if reference.schema_version != ARTIFACT_BUNDLE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Quality Lab artifact bundle schema {}",
            reference.schema_version
        ));
    }
    let root = fs::canonicalize(&reference.root_path).map_err(|error| {
        format!(
            "Failed to resolve Quality Lab artifact bundle {}: {error}",
            reference.root_path
        )
    })?;
    let manifest_path = fs::canonicalize(&reference.manifest_path).map_err(|error| {
        format!(
            "Failed to resolve Quality Lab artifact bundle manifest {}: {error}",
            reference.manifest_path
        )
    })?;
    if manifest_path.parent() != Some(root.as_path())
        || manifest_path.file_name().and_then(|value| value.to_str())
            != Some("bundle-manifest.json")
    {
        return Err(format!(
            "Quality Lab bundle manifest {} is outside its immutable root {}",
            manifest_path.display(),
            root.display()
        ));
    }
    verify_file_sha256(
        &manifest_path,
        &reference.manifest_sha256,
        "artifact bundle manifest",
    )?;
    let manifest: ArtifactBundleManifest =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|error| {
            format!(
                "Failed to read Quality Lab bundle manifest {}: {error}",
                manifest_path.display()
            )
        })?)
        .map_err(|error| {
            format!(
                "Failed to parse Quality Lab bundle manifest {}: {error}",
                manifest_path.display()
            )
        })?;
    if manifest.schema_version != reference.schema_version
        || manifest.run_id != reference.run_id
        || manifest.artifacts != reference.artifacts
    {
        return Err("Quality Lab bundle reference does not match its manifest".to_string());
    }
    let mut relative_paths = HashSet::new();
    for artifact in &manifest.artifacts {
        validate_relative_path("artifact bundle path", &artifact.relative_path)?;
        if !relative_paths.insert(artifact.relative_path.clone()) {
            return Err(format!(
                "Duplicate Quality Lab bundle artifact '{}'",
                artifact.relative_path
            ));
        }
        let requested_path = root.join(&artifact.relative_path);
        let path = canonical_path_within(&root, &requested_path, "artifact bundle entry")?;
        let size_bytes = fs::metadata(&path)
            .map_err(|error| {
                format!(
                    "Failed to inspect Quality Lab bundle artifact {}: {error}",
                    path.display()
                )
            })?
            .len();
        if size_bytes != artifact.size_bytes {
            return Err(format!(
                "Quality Lab bundle artifact {} size mismatch: expected {}, got {size_bytes}",
                path.display(),
                artifact.size_bytes
            ));
        }
        verify_file_sha256(&path, &artifact.sha256, "artifact bundle entry")?;
    }
    for required_role in [
        "report_json",
        "report_csv",
        "blind_html",
        "build_provenance",
    ] {
        if !manifest
            .artifacts
            .iter()
            .any(|artifact| artifact.role == required_role)
        {
            return Err(format!(
                "Quality Lab bundle is missing required role '{required_role}'"
            ));
        }
    }
    Ok(())
}

fn sibling_artifact_path(path: &Path, suffix: &str, extension: &str) -> Result<PathBuf, String> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Report path {} has no UTF-8 file stem", path.display()))?;
    if extension.is_empty() || extension.contains('/') || extension.contains('\\') {
        return Err(format!("Invalid report extension '{extension}'"));
    }
    Ok(path.with_file_name(format!("{stem}{suffix}.{extension}")))
}

fn write_csv_report(path: &Path, report: &QualityLabReport) -> Result<(), String> {
    const HEADER: &[&str] = &[
        "run_id",
        "git_commit",
        "git_dirty",
        "fixture_id",
        "category",
        "tags",
        "profile_id",
        "generation_mode",
        "status",
        "correctness_passed",
        "correctness_violations",
        "alpha_coverage_tolerance",
        "source_sha256",
        "request_sha256",
        "output_sha256",
        "size_bytes",
        "frame_count",
        "duration_seconds",
        "duration_error_ms",
        "encode_elapsed_ms",
        "encode_wall_elapsed_ms",
        "encode_memory_sampler_id",
        "encode_memory_sample_interval_ms",
        "encode_memory_sample_count",
        "encode_memory_baseline_tree_rss_bytes",
        "encode_memory_peak_tree_rss_bytes",
        "encode_memory_peak_incremental_tree_rss_bytes",
        "encode_memory_max_process_count",
        "metric_elapsed_ms",
        "total_wall_elapsed_ms",
        "encoder_used",
        "backend_id",
        "palette_strategy",
        "target_constraint",
        "target_size_bytes",
        "target_fill_ratio",
        "target_hard_cap_band_passed",
        "target_deviation_percent",
        "target_attempts",
        "target_fit_status",
        "target_reinvest_actual_bytes",
        "target_reinvest_predicted_bytes",
        "target_reinvest_actual_to_predicted_ratio",
        "target_reinvest_under_target",
        "target_reinvest_correction_attempted",
        "target_reinvest_correction_success",
        "analysis_fps",
        "compared_frames",
        "presentation_width",
        "presentation_height",
        "vmaf_neg_mean",
        "vmaf_neg_p05",
        "vmaf_neg_min",
        "psnr_y_mean_db",
        "ssim_mean",
        "ssim_min",
        "ms_ssim_mean",
        "ms_ssim_min",
        "ms_ssim_valid_ratio",
        "ciede2000_mean",
        "ciede2000_p95",
        "ciede2000_valid_ratio",
        "cambi_mean",
        "cambi_p95",
        "mean_oklab_error",
        "static_region_oklab_error",
        "static_region_temporal_residual",
        "static_pixel_ratio",
        "edge_error",
        "edge_preservation",
        "edge_pixel_ratio",
        "alpha_mean_absolute_error",
        "alpha_coverage_error",
        "reference_loop_seam_oklab",
        "output_loop_seam_oklab",
        "loop_seam_excess_oklab",
        "error",
    ];

    let sources = report
        .sources
        .iter()
        .map(|source| (source.fixture_id.as_str(), source))
        .collect::<HashMap<_, _>>();
    let profiles = report
        .manifest
        .profiles
        .iter()
        .map(|profile| (profile.id.as_str(), profile))
        .collect::<HashMap<_, _>>();
    let mut csv = String::new();
    append_csv_row(
        &mut csv,
        HEADER.iter().map(|value| (*value).to_string()).collect(),
    );

    for run in &report.runs {
        let source = sources.get(run.fixture_id.as_str()).copied();
        let profile = profiles.get(run.profile_id.as_str()).copied();
        let metrics = run.metrics.as_ref();
        let encode_memory = metrics.and_then(|metrics| metrics.encode_memory.as_ref());
        let objective = metrics.and_then(|metrics| metrics.objective.as_ref());
        let correctness = run.correctness.as_ref();
        let result = run.result.as_ref();
        let target_constraint = run.request.get("target_constraint").and_then(Value::as_str);
        let target_size_bytes = result.and_then(|value| value.target_size_bytes);
        let target_fill_ratio = metrics
            .zip(target_size_bytes)
            .map(|(metrics, target)| metrics.size_bytes as f64 / target.max(1) as f64);
        let target_hard_cap_band_passed = (target_constraint == Some("hard_cap")).then(|| {
            correctness.is_some_and(|value| value.all_passed)
                && target_fill_ratio
                    .is_some_and(|ratio| (HARD_CAP_FILL_RATIO_FLOOR..=1.0).contains(&ratio))
        });
        let target_optimizer = result.and_then(|value| value.target_optimizer_report.as_ref());
        let target_reinvest = target_optimizer.and_then(|optimizer| {
            optimizer
                .route_observations
                .iter()
                .find(|route| route.route_id == "perceptual_reinvest")
        });
        let target_reinvest_correction = target_optimizer.and_then(|optimizer| {
            optimizer
                .route_observations
                .iter()
                .find(|route| route.route_id == "perceptual_reinvest_corrected")
        });
        let row = vec![
            report.run_id.clone(),
            report.git_commit.clone().unwrap_or_default(),
            report
                .git_dirty
                .map(|value| value.to_string())
                .unwrap_or_default(),
            run.fixture_id.clone(),
            source
                .map(|value| value.category.clone())
                .unwrap_or_default(),
            source.map(|value| value.tags.join("|")).unwrap_or_default(),
            run.profile_id.clone(),
            profile
                .map(|value| value.generation_mode.clone())
                .unwrap_or_default(),
            run.status.clone(),
            correctness
                .map(|value| value.all_passed.to_string())
                .unwrap_or_default(),
            correctness
                .map(|value| value.violations.join("|"))
                .unwrap_or_default(),
            correctness
                .map(|value| csv_f64(value.alpha_coverage_tolerance))
                .unwrap_or_default(),
            run.source_sha256.clone(),
            run.request_sha256.clone(),
            run.output_sha256.clone().unwrap_or_default(),
            metrics
                .map(|value| value.size_bytes.to_string())
                .unwrap_or_default(),
            metrics
                .map(|value| value.frame_count.to_string())
                .unwrap_or_default(),
            metrics
                .map(|value| csv_f64(value.duration_seconds))
                .unwrap_or_default(),
            correctness
                .map(|value| csv_f64(value.duration_error_ms))
                .unwrap_or_default(),
            metrics
                .map(|value| value.encode_elapsed_ms.to_string())
                .unwrap_or_default(),
            metrics
                .map(|value| value.encode_wall_elapsed_ms.to_string())
                .unwrap_or_default(),
            encode_memory
                .map(|value| value.sampler_id.clone())
                .unwrap_or_default(),
            encode_memory
                .map(|value| value.sample_interval_ms.to_string())
                .unwrap_or_default(),
            encode_memory
                .map(|value| value.sample_count.to_string())
                .unwrap_or_default(),
            encode_memory
                .map(|value| value.baseline_tree_rss_bytes.to_string())
                .unwrap_or_default(),
            encode_memory
                .map(|value| value.peak_tree_rss_bytes.to_string())
                .unwrap_or_default(),
            encode_memory
                .map(|value| value.peak_incremental_tree_rss_bytes.to_string())
                .unwrap_or_default(),
            encode_memory
                .map(|value| value.max_process_count.to_string())
                .unwrap_or_default(),
            metrics
                .map(|value| value.metric_elapsed_ms.to_string())
                .unwrap_or_default(),
            metrics
                .map(|value| value.total_wall_elapsed_ms.to_string())
                .unwrap_or_default(),
            result
                .map(|value| value.encoder_used.clone())
                .unwrap_or_default(),
            result
                .map(|value| value.backend_id.clone())
                .unwrap_or_default(),
            result
                .map(|value| value.palette_strategy.clone())
                .unwrap_or_default(),
            target_constraint.unwrap_or_default().to_string(),
            target_size_bytes
                .map(|value| value.to_string())
                .unwrap_or_default(),
            target_fill_ratio.map(csv_f64).unwrap_or_default(),
            target_hard_cap_band_passed
                .map(|value| value.to_string())
                .unwrap_or_default(),
            result
                .and_then(|value| value.target_deviation_percent)
                .map(csv_f64)
                .unwrap_or_default(),
            result
                .map(|value| value.attempts.to_string())
                .unwrap_or_default(),
            result.map(|value| value.status.clone()).unwrap_or_default(),
            target_reinvest
                .and_then(|route| route.size_bytes)
                .map(|value| value.to_string())
                .unwrap_or_default(),
            target_reinvest
                .and_then(|route| route.prediction.as_ref())
                .map(|prediction| prediction.predicted_size_bytes.to_string())
                .unwrap_or_default(),
            target_reinvest
                .and_then(|route| route.prediction.as_ref())
                .and_then(|prediction| prediction.actual_to_predicted_ratio)
                .map(csv_f64)
                .unwrap_or_default(),
            target_reinvest
                .filter(|route| route.size_bytes.is_some())
                .map(|route| route.under_target.to_string())
                .unwrap_or_default(),
            target_optimizer
                .map(|_| target_reinvest_correction.is_some().to_string())
                .unwrap_or_default(),
            target_reinvest_correction
                .map(|route| {
                    (route.status == "encoded" && route.under_target && route.timeline_verified)
                        .to_string()
                })
                .unwrap_or_default(),
            objective
                .map(|value| value.analysis_fps.to_string())
                .unwrap_or_default(),
            objective
                .map(|value| value.compared_frames.to_string())
                .unwrap_or_default(),
            objective
                .map(|value| value.presentation_width.to_string())
                .unwrap_or_default(),
            objective
                .map(|value| value.presentation_height.to_string())
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.vmaf_neg_mean))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.vmaf_neg_p05))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.vmaf_neg_min))
                .unwrap_or_default(),
            objective
                .and_then(|value| value.psnr_y_mean_db)
                .map(csv_f64)
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.ssim_mean))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.ssim_min))
                .unwrap_or_default(),
            objective
                .and_then(|value| value.ms_ssim_mean)
                .map(csv_f64)
                .unwrap_or_default(),
            objective
                .and_then(|value| value.ms_ssim_min)
                .map(csv_f64)
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.ms_ssim_valid_ratio))
                .unwrap_or_default(),
            objective
                .and_then(|value| value.ciede2000_mean)
                .map(csv_f64)
                .unwrap_or_default(),
            objective
                .and_then(|value| value.ciede2000_p95)
                .map(csv_f64)
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.ciede2000_valid_ratio))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.cambi_mean))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.cambi_p95))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.mean_oklab_error))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.static_region_oklab_error))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.static_region_temporal_residual))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.static_pixel_ratio))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.edge_error))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.edge_preservation))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.edge_pixel_ratio))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.alpha_mean_absolute_error))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.alpha_coverage_error))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.reference_loop_seam_oklab))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.output_loop_seam_oklab))
                .unwrap_or_default(),
            objective
                .map(|value| csv_f64(value.loop_seam_excess_oklab))
                .unwrap_or_default(),
            run.error.clone().unwrap_or_default(),
        ];
        debug_assert_eq!(row.len(), HEADER.len());
        append_csv_row(&mut csv, row);
    }

    write_text_artifact(path, &csv, "CSV report")
}

fn append_csv_row(output: &mut String, fields: Vec<String>) {
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        if field.contains(',')
            || field.contains('"')
            || field.contains('\n')
            || field.contains('\r')
        {
            output.push('"');
            output.push_str(&field.replace('"', "\"\""));
            output.push('"');
        } else {
            output.push_str(field);
        }
    }
    output.push('\n');
}

fn csv_f64(value: f64) -> String {
    if value.is_finite() {
        format!("{value:.8}")
    } else {
        String::new()
    }
}

fn blind_profile_pairs(
    manifest: &CorpusManifest,
) -> Result<Vec<(&ProfileSpec, &ProfileSpec)>, String> {
    let mut pairs = Vec::new();
    for reference in manifest.profiles.iter().filter(|profile| {
        profile.generation_mode == "target_size"
            && profile.effective_target_constraint() == TargetConstraint::SymmetricMatch
    }) {
        let candidate_id = reference
            .match_target_profile_id
            .as_deref()
            .ok_or_else(|| {
                format!(
                    "Symmetric blind reference '{}' has no candidate profile",
                    reference.id
                )
            })?;
        let candidate = manifest
            .profiles
            .iter()
            .find(|profile| profile.id == candidate_id)
            .ok_or_else(|| {
                format!(
                    "Symmetric blind reference '{}' points to missing candidate '{candidate_id}'",
                    reference.id
                )
            })?;
        pairs.push((reference, candidate));
    }

    if pairs.is_empty() {
        let reference = manifest
            .profiles
            .iter()
            .find(|profile| profile.generation_mode == "fast_gif")
            .ok_or_else(|| {
                "Blind report requires a symmetric target_size or fast_gif reference profile"
                    .to_string()
            })?;
        let candidate = manifest
            .profiles
            .iter()
            .find(|profile| profile.generation_mode == "best_gif")
            .ok_or_else(|| "Blind report requires one best_gif profile".to_string())?;
        pairs.push((reference, candidate));
    }
    Ok(pairs)
}

fn write_blind_reports(
    default_path: &Path,
    report: &QualityLabReport,
) -> Result<Vec<BlindReportArtifact>, String> {
    let profile_pairs = blind_profile_pairs(&report.manifest)?;
    let mut artifacts = Vec::with_capacity(profile_pairs.len());
    for (index, (reference, candidate)) in profile_pairs.into_iter().enumerate() {
        let path = if index == 0 {
            default_path.to_path_buf()
        } else {
            sibling_artifact_path(
                default_path,
                &format!("-{}-vs-{}", candidate.id, reference.id),
                "html",
            )?
        };
        let asset_dir_name = if index == 0 {
            format!("gifp-blind-assets-{}", report.run_id)
        } else {
            format!(
                "gifp-blind-assets-{}-{}-vs-{}",
                report.run_id, candidate.id, reference.id
            )
        };
        let available_pairs =
            write_blind_report(&path, report, reference, candidate, &asset_dir_name)?;
        artifacts.push(BlindReportArtifact {
            path,
            reference_profile_id: reference.id.clone(),
            candidate_profile_id: candidate.id.clone(),
            available_pairs,
        });
    }
    Ok(artifacts)
}

fn write_blind_report(
    path: &Path,
    report: &QualityLabReport,
    reference_profile: &ProfileSpec,
    candidate_profile: &ProfileSpec,
    asset_dir_name: &str,
) -> Result<usize, String> {
    const FORMAL_MAX_SIZE_DELTA_PERCENT: f64 = 5.0;
    const TEMPLATE: &str = include_str!("../../bench/blind-report-template.html");

    let path = absolute_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("Blind report path {} has no parent", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create blind report directory {}: {error}",
            parent.display()
        )
    })?;
    let asset_root = parent.join(asset_dir_name);
    fs::create_dir_all(&asset_root).map_err(|error| {
        format!(
            "Failed to create blind report assets {}: {error}",
            asset_root.display()
        )
    })?;

    let mut pairs = Vec::with_capacity(report.sources.len());
    let mut omitted_pairs = Vec::new();
    for source in &report.sources {
        let outcome = build_blind_pair(
            report,
            source,
            reference_profile,
            candidate_profile,
            &asset_root,
            asset_dir_name,
            FORMAL_MAX_SIZE_DELTA_PERCENT,
        );
        match outcome {
            Ok(pair) => pairs.push(pair),
            Err(reason) => omitted_pairs.push(BlindOmission {
                fixture_id: source.fixture_id.clone(),
                reason,
            }),
        }
    }

    let available_pairs = pairs.len();
    let data = BlindReportData {
        schema_version: QUALITY_REPORT_SCHEMA_VERSION,
        run_id: report.run_id.clone(),
        generated_at_unix_ms: report.generated_at_unix_ms,
        corpus_id: report.manifest.corpus_id.clone(),
        manifest_sha256: report.manifest_sha256.clone(),
        git_commit: report.git_commit.clone(),
        git_dirty: report.git_dirty,
        reference_profile_id: reference_profile.id.clone(),
        candidate_profile_id: candidate_profile.id.clone(),
        formal_max_size_delta_percent: FORMAL_MAX_SIZE_DELTA_PERCENT,
        expected_pairs: report.sources.len(),
        available_pairs,
        omitted_pairs,
        pairs,
    };
    if !TEMPLATE.contains("__GIFP_BLIND_DATA__") {
        return Err("Blind report template is missing its data placeholder".to_string());
    }
    let embedded = serde_json::to_string(&data)
        .map_err(|error| format!("Failed to serialize blind report data: {error}"))?
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let html = TEMPLATE.replacen("__GIFP_BLIND_DATA__", &embedded, 1);
    write_text_artifact(&path, &html, "blind HTML report")?;
    Ok(available_pairs)
}

#[allow(clippy::too_many_arguments)]
fn build_blind_pair(
    report: &QualityLabReport,
    source: &SourceSnapshot,
    reference_profile: &ProfileSpec,
    candidate_profile: &ProfileSpec,
    asset_root: &Path,
    asset_dir_name: &str,
    formal_max_size_delta_percent: f64,
) -> Result<BlindPair, String> {
    let reference_run = report
        .runs
        .iter()
        .find(|run| run.fixture_id == source.fixture_id && run.profile_id == reference_profile.id)
        .ok_or_else(|| format!("missing run for profile {}", reference_profile.id))?;
    let candidate_run = report
        .runs
        .iter()
        .find(|run| run.fixture_id == source.fixture_id && run.profile_id == candidate_profile.id)
        .ok_or_else(|| format!("missing run for profile {}", candidate_profile.id))?;
    validate_blind_run(reference_run)?;
    validate_blind_run(candidate_run)?;

    let assignment = sha256_bytes(format!("{}:{}", report.run_id, source.fixture_id).as_bytes());
    let swap = assignment
        .chars()
        .last()
        .and_then(|value| value.to_digit(16))
        .is_some_and(|value| value % 2 == 1);
    let (a_run, a_profile, b_run, b_profile) = if swap {
        (
            candidate_run,
            candidate_profile,
            reference_run,
            reference_profile,
        )
    } else {
        (
            reference_run,
            reference_profile,
            candidate_run,
            candidate_profile,
        )
    };

    let fixture_asset_root = asset_root.join(&source.fixture_id);
    fs::create_dir_all(&fixture_asset_root).map_err(|error| {
        format!(
            "failed to create pair asset directory {}: {error}",
            fixture_asset_root.display()
        )
    })?;
    let a_destination = fixture_asset_root.join("a.gif");
    let b_destination = fixture_asset_root.join("b.gif");
    copy_blind_output(a_run, &a_destination)?;
    copy_blind_output(b_run, &b_destination)?;
    let a_src = format!("{asset_dir_name}/{}/a.gif", source.fixture_id);
    let b_src = format!("{asset_dir_name}/{}/b.gif", source.fixture_id);
    let candidate_a = blind_candidate(a_run, a_profile, a_src)?;
    let candidate_b = blind_candidate(b_run, b_profile, b_src)?;
    let size_delta_percent =
        symmetric_size_delta_percent(candidate_a.size_bytes, candidate_b.size_bytes);
    let formal_vote_eligible = formal_blind_pair_eligible(
        size_delta_percent,
        formal_max_size_delta_percent,
        candidate_a.correctness_passed,
        candidate_b.correctness_passed,
        report.git_commit.as_deref(),
        report.git_dirty,
    );

    Ok(BlindPair {
        fixture_id: source.fixture_id.clone(),
        category: source.category.clone(),
        tags: source.tags.clone(),
        size_delta_percent,
        formal_vote_eligible,
        candidate_a,
        candidate_b,
    })
}

fn formal_blind_pair_eligible(
    size_delta_percent: f64,
    formal_max_size_delta_percent: f64,
    candidate_a_correct: bool,
    candidate_b_correct: bool,
    git_commit: Option<&str>,
    git_dirty: Option<bool>,
) -> bool {
    size_delta_percent <= formal_max_size_delta_percent
        && candidate_a_correct
        && candidate_b_correct
        && git_dirty == Some(false)
        && git_commit.is_some_and(|value| !value.is_empty())
}

fn validate_blind_run(run: &QualityRunRecord) -> Result<(), String> {
    if run.result.is_none() {
        return Err(format!("{} has no encoded output", run.profile_id));
    }
    let metrics = run
        .metrics
        .as_ref()
        .ok_or_else(|| format!("{} has no measured output", run.profile_id))?;
    if metrics.objective.is_none() {
        return Err(format!("{} has no objective metrics", run.profile_id));
    }
    Ok(())
}

fn copy_blind_output(run: &QualityRunRecord, destination: &Path) -> Result<(), String> {
    let source = run
        .result
        .as_ref()
        .map(|result| Path::new(&result.output_path))
        .ok_or_else(|| format!("{} has no output path", run.profile_id))?;
    let expected_sha256 = run
        .output_sha256
        .as_deref()
        .ok_or_else(|| format!("{} has no verified output SHA", run.profile_id))?;
    verify_file_sha256(source, expected_sha256, "blind source")?;
    let source_len = fs::metadata(source)
        .map_err(|error| {
            format!(
                "Failed to inspect blind source {}: {error}",
                source.display()
            )
        })?
        .len();
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Blind asset destination {} has no parent",
            destination.display()
        )
    })?;
    let (staged, staged_file) = reserve_quality_staging_file(parent, "gif")?;
    drop(staged_file);
    let result = (|| {
        let copied = fs::copy(source, &staged).map_err(|error| {
            format!(
                "failed to stage {} output from {} to {}: {error}",
                run.profile_id,
                source.display(),
                staged.display()
            )
        })?;
        if copied != source_len {
            return Err(format!(
                "blind asset copy for {} wrote {copied} bytes; expected {source_len}",
                run.profile_id
            ));
        }
        verify_file_sha256(&staged, expected_sha256, "staged blind asset")?;
        if destination.is_file() {
            return verify_file_sha256(destination, expected_sha256, "blind asset");
        }
        let publish_error = publish_file_atomically(&staged, destination, false)
            .err()
            .map(|error| error.to_string());
        match verify_file_sha256(destination, expected_sha256, "blind asset") {
            Ok(()) => Ok(()),
            Err(verify_error) => Err(match publish_error {
                Some(publish_error) => format!(
                    "failed to publish {} blind asset to {}: {publish_error}; {verify_error}",
                    run.profile_id,
                    destination.display()
                ),
                None => verify_error,
            }),
        }
    })();
    let _ = fs::remove_file(&staged);
    result
}

fn blind_candidate(
    run: &QualityRunRecord,
    profile: &ProfileSpec,
    image_src: String,
) -> Result<BlindCandidate, String> {
    let metrics = run
        .metrics
        .as_ref()
        .ok_or_else(|| format!("{} has no metrics", run.profile_id))?;
    let objective = metrics
        .objective
        .as_ref()
        .ok_or_else(|| format!("{} has no objective metrics", run.profile_id))?;
    let result = run
        .result
        .as_ref()
        .ok_or_else(|| format!("{} has no conversion result", run.profile_id))?;
    Ok(BlindCandidate {
        profile_id: run.profile_id.clone(),
        generation_mode: profile.generation_mode.clone(),
        image_src,
        correctness_passed: run
            .correctness
            .as_ref()
            .is_some_and(|correctness| correctness.all_passed),
        size_bytes: metrics.size_bytes,
        frame_count: metrics.frame_count,
        duration_seconds: metrics.duration_seconds,
        encode_elapsed_ms: metrics.encode_elapsed_ms,
        encoder_used: result.encoder_used.clone(),
        backend_id: result.backend_id.clone(),
        palette_strategy: result.palette_strategy.clone(),
        target_size_bytes: result.target_size_bytes,
        target_deviation_percent: result.target_deviation_percent,
        target_attempts: result.attempts,
        target_fit_status: result.status.clone(),
        vmaf_neg_mean: objective.vmaf_neg_mean,
        vmaf_neg_p05: objective.vmaf_neg_p05,
        ssim_mean: objective.ssim_mean,
        ms_ssim_mean: objective.ms_ssim_mean,
        ms_ssim_valid_ratio: objective.ms_ssim_valid_ratio,
        ciede2000_mean: objective.ciede2000_mean,
        ciede2000_valid_ratio: objective.ciede2000_valid_ratio,
        cambi_mean: objective.cambi_mean,
        mean_oklab_error: objective.mean_oklab_error,
        static_region_temporal_residual: objective.static_region_temporal_residual,
        edge_preservation: objective.edge_preservation,
        alpha_coverage_error: objective.alpha_coverage_error,
        loop_seam_excess_oklab: objective.loop_seam_excess_oklab,
    })
}

fn symmetric_size_delta_percent(first: u64, second: u64) -> f64 {
    if first == 0 && second == 0 {
        return 0.0;
    }
    let first = first as f64;
    let second = second as f64;
    (first - second).abs() / ((first + second) / 2.0) * 100.0
}

fn write_text_artifact(path: &Path, text: &str, label: &str) -> Result<(), String> {
    let path = absolute_path(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create {label} directory {}: {error}",
                parent.display()
            )
        })?;
    }
    write_bytes_atomically(&path, text.as_bytes(), label)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Failed to hash {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn command_version(command: &Path) -> Option<String> {
    let output = Command::new(command).arg("-version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn capture_toolchain_snapshot(
    loaded: &LoadedManifest,
    ffmpeg: &Path,
    ffprobe: &Path,
    repository_root: Option<&Path>,
) -> Result<ToolchainSnapshot, String> {
    let ffmpeg_sha256 = sha256_file(ffmpeg)?;
    let ffprobe_sha256 = sha256_file(ffprobe)?;
    let fallback_root = loaded
        .path
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."));
    let requested_root = repository_root.unwrap_or(fallback_root);
    let trusted_root =
        fs::canonicalize(requested_root).unwrap_or_else(|_| requested_root.to_path_buf());
    let requested_runtime_manifest = trusted_root.join(
        &loaded
            .manifest
            .canonical_fixture_identity
            .reviewed_runtime_manifest_path,
    );
    let reviewed_runtime_manifest_path = canonical_path_within(
        &trusted_root,
        &requested_runtime_manifest,
        "reviewed runtime manifest",
    )
    .ok();
    let reviewed_runtime_manifest_sha256 = reviewed_runtime_manifest_path
        .as_deref()
        .and_then(|path| sha256_file(path).ok());
    let identity = &loaded.manifest.canonical_fixture_identity;
    let canonical_generator_identity_passed = ffmpeg_sha256 == identity.generator_ffmpeg_sha256
        && ffprobe_sha256 == identity.generator_ffprobe_sha256
        && reviewed_runtime_manifest_sha256.as_deref()
            == Some(identity.reviewed_runtime_manifest_sha256.as_str());
    Ok(ToolchainSnapshot {
        gifp_version: env!("CARGO_PKG_VERSION").to_string(),
        build_profile: build_profile().to_string(),
        ffmpeg_path: ffmpeg.to_string_lossy().to_string(),
        ffmpeg_version: command_version(ffmpeg),
        ffmpeg_sha256,
        ffprobe_path: ffprobe.to_string_lossy().to_string(),
        ffprobe_version: command_version(ffprobe),
        ffprobe_sha256,
        reviewed_runtime_manifest_path: reviewed_runtime_manifest_path
            .unwrap_or(requested_runtime_manifest)
            .to_string_lossy()
            .to_string(),
        reviewed_runtime_manifest_sha256,
        canonical_generator_identity_passed,
    })
}

fn require_canonical_generator_identity(
    manifest: &CorpusManifest,
    toolchain: &ToolchainSnapshot,
) -> Result<(), String> {
    if toolchain.canonical_generator_identity_passed {
        return Ok(());
    }
    let identity = &manifest.canonical_fixture_identity;
    let mut violations = Vec::new();
    if toolchain.ffmpeg_sha256 != identity.generator_ffmpeg_sha256 {
        violations.push(format!(
            "FFmpeg SHA-256 expected {}, got {}",
            identity.generator_ffmpeg_sha256, toolchain.ffmpeg_sha256
        ));
    }
    if toolchain.ffprobe_sha256 != identity.generator_ffprobe_sha256 {
        violations.push(format!(
            "FFprobe SHA-256 expected {}, got {}",
            identity.generator_ffprobe_sha256, toolchain.ffprobe_sha256
        ));
    }
    if toolchain.reviewed_runtime_manifest_sha256.as_deref()
        != Some(identity.reviewed_runtime_manifest_sha256.as_str())
    {
        violations.push(format!(
            "reviewed runtime manifest SHA-256 expected {}, got {}",
            identity.reviewed_runtime_manifest_sha256,
            toolchain
                .reviewed_runtime_manifest_sha256
                .as_deref()
                .unwrap_or("unavailable")
        ));
    }
    Err(format!(
        "Canonical generator identity mismatch before fixture preparation: {}",
        violations.join("; ")
    ))
}

fn git_repository_root(path: &Path) -> Option<PathBuf> {
    git_stdout(path, &["rev-parse", "--show-toplevel"]).map(PathBuf::from)
}

fn capture_runtime_git_snapshot(repository_root: Option<&Path>) -> GitSnapshot {
    let commit = repository_root.and_then(|root| git_stdout(root, &["rev-parse", "HEAD"]));
    let tracked_tree = repository_root
        .zip(commit.as_deref())
        .and_then(|(root, commit)| tracked_tree_snapshot(root, commit));
    let status_dirty = repository_root.and_then(git_worktree_dirty);
    GitSnapshot {
        commit,
        dirty: status_dirty
            .map(|dirty| dirty || !tracked_tree.as_ref().is_some_and(|(_, clean)| *clean)),
        tree_hash: tracked_tree.map(|(hash, _)| hash),
    }
}

fn git_worktree_dirty(path: &Path) -> Option<bool> {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| !output.stdout.is_empty())
}

fn git_stdout(path: &Path, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(arguments)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| format!("Failed to resolve {}: {error}", path.display()))
    }
}

fn resolve_executable(path: PathBuf) -> PathBuf {
    if path.is_absolute() || path.components().count() > 1 {
        return path;
    }
    let Some(search_path) = env::var_os("PATH") else {
        return path;
    };
    for directory in env::split_paths(&search_path) {
        let candidate = directory.join(&path);
        if candidate.is_file() {
            return fs::canonicalize(&candidate).unwrap_or(candidate);
        }
    }
    path
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> CorpusManifest {
        CorpusManifest {
            schema: None,
            schema_version: CORPUS_MANIFEST_SCHEMA_VERSION,
            corpus_id: "bootstrap-v1".to_string(),
            description: String::new(),
            fixture_root: "generated".to_string(),
            canonical_fixture_identity: CanonicalFixtureIdentitySpec {
                contract_id: "gifp.canonical_fixture_identity.v1".to_string(),
                status: "incomplete".to_string(),
                generator_ffmpeg_sha256: "1".repeat(64),
                generator_ffprobe_sha256: "2".repeat(64),
                reviewed_runtime_manifest_path: "compliance/ffmpeg-windows-x64-gpl-shared.json"
                    .to_string(),
                reviewed_runtime_manifest_sha256: "3".repeat(64),
            },
            performance_budget: None,
            coverage: None,
            fixtures: vec![FixtureSpec {
                id: "ui-blink".to_string(),
                category: "ui".to_string(),
                file: "ui-blink.mkv".to_string(),
                expected_source_sha256: None,
                duration_seconds: 3.0,
                tags: vec!["flat-color".to_string()],
                generator: FixtureGenerator {
                    kind: "lavfi".to_string(),
                    input: "color=black:s=64x64:r=10:d=3".to_string(),
                    source_sha256: None,
                    authorization: None,
                    video_filter: None,
                    pixel_format: default_fixture_pixel_format(),
                },
            }],
            profiles: vec![ProfileSpec {
                id: "fast-baseline".to_string(),
                generation_mode: "fast_gif".to_string(),
                match_target_profile_id: None,
                target_constraint: None,
                target_size_scale: None,
                encoder: "ffmpeg_fast".to_string(),
                width: 320,
                fps: 12,
                colors: 96,
                dither: "sierra2_4a".to_string(),
                optimize_level: 3,
                lossy: 20,
                bayer_scale: 2,
                alpha_threshold: 128,
                filter_style: "original".to_string(),
                perceptual_focus: "auto".to_string(),
                allow_experimental: false,
            }],
        }
    }

    fn toolchain_snapshot(identity_passed: bool) -> ToolchainSnapshot {
        ToolchainSnapshot {
            gifp_version: "test".to_string(),
            build_profile: "release".to_string(),
            ffmpeg_path: "ffmpeg".to_string(),
            ffmpeg_version: Some("ffmpeg test".to_string()),
            ffmpeg_sha256: "1".repeat(64),
            ffprobe_path: "ffprobe".to_string(),
            ffprobe_version: Some("ffprobe test".to_string()),
            ffprobe_sha256: "2".repeat(64),
            reviewed_runtime_manifest_path: "compliance/ffmpeg-windows-x64-gpl-shared.json"
                .to_string(),
            reviewed_runtime_manifest_sha256: Some("3".repeat(64)),
            canonical_generator_identity_passed: identity_passed,
        }
    }

    fn identity_source(expected_source_sha256: Option<String>) -> SourceSnapshot {
        let sha256 = "0".repeat(64);
        SourceSnapshot {
            fixture_id: "ui-blink".to_string(),
            category: "ui".to_string(),
            tags: vec![],
            path: "ui-blink.mkv".to_string(),
            canonical_identity_passed: expected_source_sha256.as_deref() == Some(sha256.as_str()),
            expected_source_sha256,
            sha256,
            inspection: MediaInspection {
                codec: "ffv1".to_string(),
                width: 64,
                height: 64,
                duration: 3.0,
                frame_count: 30,
                animated: true,
                has_alpha: false,
            },
        }
    }

    fn performance_budget(required_build_profile: &str) -> PerformanceBudgetSpec {
        PerformanceBudgetSpec {
            profile_scope: "stable_profiles".to_string(),
            required_build_profile: required_build_profile.to_string(),
            minimum_memory_coverage: 0.75,
            p95_encode_wall_elapsed_ms: 200,
            max_encode_wall_elapsed_ms: 300,
            p95_peak_tree_rss_bytes: 128 * 1024 * 1024,
            max_peak_tree_rss_bytes: 192 * 1024 * 1024,
        }
    }

    fn passing_performance_slice() -> PerformanceBaselineSlice {
        build_performance_baseline_slice(
            "all".to_string(),
            PerformanceBaselineAccumulator {
                run_count: 4,
                encode_wall_elapsed_ms: vec![100, 120, 140, 160],
                peak_tree_rss_bytes: vec![64, 72, 80, 96]
                    .into_iter()
                    .map(|mebibytes| mebibytes * 1024 * 1024)
                    .collect(),
                peak_incremental_tree_rss_bytes: vec![32, 40, 48, 56]
                    .into_iter()
                    .map(|mebibytes| mebibytes * 1024 * 1024)
                    .collect(),
            },
        )
    }

    fn performance_run(profile_id: &str, encode_wall_elapsed_ms: u64) -> QualityRunRecord {
        QualityRunRecord {
            fixture_id: "ui-blink".to_string(),
            profile_id: profile_id.to_string(),
            status: "ok".to_string(),
            source_sha256: "0".repeat(64),
            request_sha256: "1".repeat(64),
            request: json!({}),
            output_sha256: Some("2".repeat(64)),
            metrics: Some(QualityMetrics {
                size_bytes: 1,
                frame_count: 1,
                duration_seconds: 1.0,
                encode_elapsed_ms: encode_wall_elapsed_ms,
                encode_wall_elapsed_ms,
                encode_memory: Some(ProcessTreeMemoryMetrics {
                    sampler_id: PROCESS_MEMORY_SAMPLER_ID.to_string(),
                    metric: "summed_resident_set_bytes".to_string(),
                    includes_root: true,
                    includes_descendants: true,
                    sample_interval_ms: PROCESS_MEMORY_SAMPLE_INTERVAL_MS,
                    sample_count: 1,
                    baseline_tree_rss_bytes: 32 * 1024 * 1024,
                    peak_tree_rss_bytes: 64 * 1024 * 1024,
                    peak_incremental_tree_rss_bytes: 32 * 1024 * 1024,
                    max_process_count: 2,
                    peak_processes: vec![ProcessMemoryBreakdown {
                        pid: 42,
                        parent_pid: None,
                        name: "gifp_quality_lab".to_string(),
                        start_time_unix_seconds: 1,
                        rss_bytes: 64 * 1024 * 1024,
                        is_root: true,
                    }],
                }),
                metric_elapsed_ms: 0,
                total_wall_elapsed_ms: encode_wall_elapsed_ms,
                objective: None,
            }),
            correctness: None,
            output_inspection: None,
            result: None,
            error: None,
        }
    }

    fn best_quality_contract_profiles() -> (ProfileSpec, ProfileSpec) {
        let candidate = ProfileSpec {
            id: "best-current".to_string(),
            generation_mode: "best_gif".to_string(),
            match_target_profile_id: None,
            target_constraint: None,
            target_size_scale: None,
            encoder: "rust_perceptual".to_string(),
            width: 320,
            fps: 30,
            colors: 256,
            dither: "sierra2_4a".to_string(),
            optimize_level: 3,
            lossy: 0,
            bayer_scale: 2,
            alpha_threshold: 128,
            filter_style: "original".to_string(),
            perceptual_focus: "auto".to_string(),
            allow_experimental: false,
        };
        let reference = ProfileSpec {
            id: "ffmpeg-size-match".to_string(),
            generation_mode: "target_size".to_string(),
            match_target_profile_id: Some(candidate.id.clone()),
            target_constraint: Some("symmetric_match".to_string()),
            target_size_scale: Some(1.0),
            encoder: "ffmpeg_fast".to_string(),
            width: 320,
            fps: 30,
            colors: 256,
            dither: "sierra2_4a".to_string(),
            optimize_level: 3,
            lossy: 0,
            bayer_scale: 2,
            alpha_threshold: 128,
            filter_style: "original".to_string(),
            perceptual_focus: "auto".to_string(),
            allow_experimental: false,
        };
        (candidate, reference)
    }

    fn best_quality_contract_source() -> SourceSnapshot {
        SourceSnapshot {
            fixture_id: "quality-contract".to_string(),
            category: "transparent-loop".to_string(),
            tags: vec!["transparent".to_string(), "seamless-loop".to_string()],
            path: "quality-contract.mov".to_string(),
            sha256: "a".repeat(64),
            expected_source_sha256: Some("a".repeat(64)),
            canonical_identity_passed: true,
            inspection: MediaInspection {
                codec: "qtrle".to_string(),
                width: 320,
                height: 240,
                duration: 3.0,
                frame_count: 90,
                animated: true,
                has_alpha: true,
            },
        }
    }

    fn best_quality_contract_objective(candidate: bool) -> ObjectiveQualityMetrics {
        ObjectiveQualityMetrics {
            status: "full".to_string(),
            analysis_fps: 30,
            compared_frames: 90,
            presentation_width: 320,
            presentation_height: 240,
            sample_width: 96,
            sample_height: 72,
            alpha_sample_width: 320,
            alpha_sample_height: 240,
            raw_vmaf_log_path: if candidate {
                "candidate-vmaf.json"
            } else {
                "reference-vmaf.json"
            }
            .to_string(),
            vmaf_neg_mean: if candidate { 76.0 } else { 75.0 },
            vmaf_neg_p05: if candidate { 66.0 } else { 65.0 },
            vmaf_neg_min: if candidate { 58.0 } else { 57.0 },
            psnr_y_mean_db: Some(if candidate { 36.0 } else { 35.0 }),
            ssim_mean: if candidate { 0.96 } else { 0.95 },
            ssim_min: if candidate { 0.91 } else { 0.90 },
            ms_ssim_mean: Some(if candidate { 0.94 } else { 0.93 }),
            ms_ssim_min: Some(if candidate { 0.88 } else { 0.87 }),
            ms_ssim_valid_ratio: 1.0,
            ciede2000_mean: Some(if candidate { 0.99 } else { 0.98 }),
            ciede2000_p95: Some(if candidate { 0.995 } else { 0.99 }),
            ciede2000_valid_ratio: 1.0,
            cambi_mean: if candidate { 0.90 } else { 1.0 },
            cambi_p95: if candidate { 1.20 } else { 1.30 },
            mean_oklab_error: if candidate { 0.010 } else { 0.011 },
            static_region_oklab_error: if candidate { 0.008 } else { 0.009 },
            static_region_temporal_residual: if candidate { 0.0008 } else { 0.0009 },
            static_pixel_ratio: 0.50,
            edge_error: if candidate { 0.008 } else { 0.009 },
            edge_preservation: if candidate { 0.95 } else { 0.94 },
            edge_pixel_ratio: 0.25,
            alpha_mean_absolute_error: if candidate { 0.005 } else { 0.006 },
            alpha_coverage_error: if candidate { 0.004 } else { 0.005 },
            reference_loop_seam_oklab: 0.002,
            output_loop_seam_oklab: if candidate { 0.004 } else { 0.005 },
            loop_seam_excess_oklab: if candidate { 0.002 } else { 0.003 },
        }
    }

    fn best_quality_contract_correctness() -> CorrectnessReport {
        CorrectnessReport {
            duration_error_ms: 0.0,
            duration_passed: true,
            frame_count_passed: true,
            alpha_required: true,
            alpha_coverage_tolerance: ALPHA_COVERAGE_TOLERANCE,
            alpha_passed: true,
            seamless_loop_required: true,
            seamless_loop_passed: true,
            all_passed: true,
            violations: Vec::new(),
        }
    }

    fn best_quality_contract_target_report(
        size_bytes: u64,
        timeline: &str,
        timeline_verified: bool,
    ) -> TargetOptimizerReport {
        use crate::commands::TargetRouteObservationReport;

        TargetOptimizerReport {
            optimizer_id: "synthetic-target-optimizer".to_string(),
            optimizer_version: "1".to_string(),
            selection_policy: "symmetric_match_closest_real_bytes_plus_route_probe_v1".to_string(),
            constraint: "symmetric_match".to_string(),
            preference: "clarity".to_string(),
            target_bytes: size_bytes,
            tolerance_percent: BEST_QUALITY_MAX_SIZE_DELTA_PERCENT,
            max_attempts: 8,
            numeric_attempt_count: 1,
            route_attempt_count: 1,
            selected_attempt: 1,
            route_probe_id: "synthetic-route-probe".to_string(),
            selected_route_id: "ffmpeg-cfr".to_string(),
            observations: Vec::new(),
            recommendations: Vec::new(),
            route_observations: vec![TargetRouteObservationReport {
                route_id: "ffmpeg-cfr".to_string(),
                timeline: timeline.to_string(),
                width: 320,
                fps: 30,
                colors: 256,
                dither: "sierra2_4a".to_string(),
                palette_stats_mode: "full".to_string(),
                size_bytes: Some(size_bytes),
                symmetric_deviation_percent: Some(0.0),
                under_target: true,
                within_tolerance: true,
                selected: true,
                kept_frame_count: Some(90),
                dropped_frame_count: Some(0),
                timeline_verified,
                prediction: None,
                status: "encoded".to_string(),
                failure_reason: None,
            }],
        }
    }

    fn best_quality_contract_result(
        size_bytes: u64,
        reference: bool,
        timeline: &str,
        timeline_verified: bool,
    ) -> GifResult {
        GifResult {
            gif_cleanup_report: None,
            advanced_compression_report: None,
            structure_optimization_report: None,
            index_compression_report: None,
            postprocess_report: None,
            pipeline_profile: None,
            input_path: "quality-contract.mov".to_string(),
            output_path: if reference {
                "ffmpeg-size-match.gif"
            } else {
                "best-current.gif"
            }
            .to_string(),
            size_bytes,
            encoder_used: if reference {
                "ffmpeg_fast"
            } else {
                "rust_perceptual"
            }
            .to_string(),
            status: if reference { "target_exact" } else { "success" }.to_string(),
            backend_id: if reference {
                "ffmpeg.animation"
            } else {
                "gifp.rust.indexed"
            }
            .to_string(),
            backend_version: Some("synthetic-1".to_string()),
            ffmpeg_engine_version: Some("synthetic-ffmpeg".to_string()),
            fallback_reason: None,
            palette_strategy: "global".to_string(),
            attempts: 1,
            elapsed_ms: 10,
            output_width: 320,
            output_fps: 30,
            effective_output_fps: Some(30.0),
            output_frame_count: 90,
            output_colors: 256,
            output_format: "gif".to_string(),
            output_codec: "gif".to_string(),
            output_has_alpha: true,
            target_size_bytes: reference.then_some(size_bytes),
            target_deviation_percent: reference.then_some(0.0),
            warnings: Vec::new(),
            perceptual_report: None,
            palette_report: None,
            region_dither_report: None,
            indexed_gif_writer_report: None,
            motion_delivery_selection_report: None,
            palette_reservation_selection_report: None,
            target_optimizer_report: reference.then(|| {
                best_quality_contract_target_report(size_bytes, timeline, timeline_verified)
            }),
            live_photo: None,
        }
    }

    fn best_quality_contract_run(
        profile_id: &str,
        size_bytes: u64,
        reference: bool,
        timeline: &str,
        timeline_verified: bool,
    ) -> QualityRunRecord {
        QualityRunRecord {
            fixture_id: "quality-contract".to_string(),
            profile_id: profile_id.to_string(),
            status: "ok".to_string(),
            source_sha256: "a".repeat(64),
            request_sha256: if reference {
                "b".repeat(64)
            } else {
                "c".repeat(64)
            },
            request: if reference {
                json!({
                    "generation_mode": "target_size",
                    "target_constraint": "symmetric_match"
                })
            } else {
                json!({"generation_mode": "best_gif"})
            },
            output_sha256: Some(if reference {
                "d".repeat(64)
            } else {
                "e".repeat(64)
            }),
            metrics: Some(QualityMetrics {
                size_bytes,
                frame_count: 90,
                duration_seconds: 3.0,
                encode_elapsed_ms: 10,
                encode_wall_elapsed_ms: 10,
                encode_memory: None,
                metric_elapsed_ms: 5,
                total_wall_elapsed_ms: 15,
                objective: Some(best_quality_contract_objective(!reference)),
            }),
            correctness: Some(best_quality_contract_correctness()),
            output_inspection: Some(MediaInspection {
                codec: "gif".to_string(),
                width: 320,
                height: 240,
                duration: 3.0,
                frame_count: 90,
                animated: true,
                has_alpha: true,
            }),
            result: Some(best_quality_contract_result(
                size_bytes,
                reference,
                timeline,
                timeline_verified,
            )),
            error: None,
        }
    }

    fn synthetic_best_quality_pair(
        index: usize,
        gains: &HashMap<&str, f64>,
    ) -> BestQualityPairObservation {
        let reference_value = |metric_id: &str| match metric_id {
            "vmaf_neg_mean" => 70.0,
            "vmaf_neg_p05" => 60.0,
            "cambi_mean" => 1.0,
            "mean_oklab_error" => 0.02,
            "edge_error" => 0.01,
            "static_region_temporal_residual" => 0.001,
            "alpha_coverage_error" | "alpha_mean_absolute_error" => 0.01,
            "loop_seam_excess_oklab" => 0.005,
            _ => unreachable!("known metric"),
        };
        let metrics = BEST_QUALITY_METRIC_SPECS
            .iter()
            .copied()
            .map(|spec| {
                let reference = reference_value(spec.metric_id);
                let gain = gains.get(spec.metric_id).copied().unwrap_or_else(|| {
                    if spec.metric_id == "vmaf_neg_mean" {
                        1.0
                    } else {
                        0.0
                    }
                });
                let candidate = match spec.direction {
                    BestQualityMetricDirection::HigherIsBetter => reference + gain,
                    BestQualityMetricDirection::LowerIsBetter => reference - gain,
                };
                compare_best_quality_metric(spec, candidate, reference)
            })
            .collect();
        BestQualityPairObservation {
            fixture_id: format!("fixture-{index:02}"),
            category: format!("category-{}", index / 4),
            candidate_size_bytes: 100_000,
            reference_size_bytes: 100_000,
            size_delta_percent: 0.0,
            candidate_output_sha256: "c".repeat(64),
            reference_output_sha256: "d".repeat(64),
            metrics,
        }
    }

    fn synthetic_best_quality_pairs() -> Vec<BestQualityPairObservation> {
        (0..28)
            .map(|index| synthetic_best_quality_pair(index, &HashMap::new()))
            .collect()
    }

    #[test]
    fn best_quality_pair_accepts_complete_verified_synthetic_contract() {
        let source = best_quality_contract_source();
        let (candidate_profile, reference_profile) = best_quality_contract_profiles();
        let runs = vec![
            best_quality_contract_run(&candidate_profile.id, 100_000, false, "cfr", true),
            best_quality_contract_run(&reference_profile.id, 100_000, true, "cfr", true),
        ];

        let pair = build_best_quality_pair(&source, &candidate_profile, &reference_profile, &runs)
            .expect("complete verified same-size candidate/reference contract");

        assert_eq!(pair.fixture_id, source.fixture_id);
        assert_eq!(pair.category, source.category);
        assert_eq!(
            (pair.candidate_size_bytes, pair.reference_size_bytes),
            (100_000, 100_000)
        );
        assert_eq!(pair.size_delta_percent, 0.0);
        assert_eq!(pair.candidate_output_sha256, "e".repeat(64));
        assert_eq!(pair.reference_output_sha256, "d".repeat(64));
        assert_eq!(pair.metrics.len(), BEST_QUALITY_METRIC_SPECS.len());
        assert!(pair
            .metrics
            .iter()
            .all(|metric| metric.outcome != "loss" && !metric.severe_regression));
        assert_eq!(
            pair.metrics
                .iter()
                .find(|metric| metric.metric_id == "vmaf_neg_mean")
                .map(|metric| metric.outcome.as_str()),
            Some("win")
        );
    }

    #[test]
    fn best_quality_pair_fails_closed_on_duplicate_profile_run() {
        let source = best_quality_contract_source();
        let (candidate_profile, reference_profile) = best_quality_contract_profiles();
        let runs = vec![
            best_quality_contract_run(&candidate_profile.id, 100_000, false, "cfr", true),
            best_quality_contract_run(&reference_profile.id, 100_000, true, "cfr", true),
            best_quality_contract_run(&candidate_profile.id, 100_000, false, "cfr", true),
        ];

        let error = build_best_quality_pair(&source, &candidate_profile, &reference_profile, &runs)
            .expect_err("duplicate candidate run must fail closed");
        assert!(
            error.contains("duplicate run for profile best-current"),
            "{error}"
        );
    }

    #[test]
    fn best_quality_pair_fails_closed_on_unverified_or_non_cfr_reference() {
        let source = best_quality_contract_source();
        let (candidate_profile, reference_profile) = best_quality_contract_profiles();

        for (timeline, timeline_verified) in [("perceptual_drop_hold", true), ("cfr", false)] {
            let runs = vec![
                best_quality_contract_run(&candidate_profile.id, 100_000, false, "cfr", true),
                best_quality_contract_run(
                    &reference_profile.id,
                    100_000,
                    true,
                    timeline,
                    timeline_verified,
                ),
            ];
            let error =
                build_best_quality_pair(&source, &candidate_profile, &reference_profile, &runs)
                    .expect_err("reference must be independently verified CFR");
            assert!(
                error.contains("selected route is not a verified CFR reference"),
                "timeline={timeline}, timeline_verified={timeline_verified}: {error}"
            );
        }
    }

    #[test]
    fn best_quality_pair_fails_closed_above_symmetric_size_tolerance() {
        let source = best_quality_contract_source();
        let (candidate_profile, reference_profile) = best_quality_contract_profiles();
        let runs = vec![
            best_quality_contract_run(&candidate_profile.id, 106_000, false, "cfr", true),
            best_quality_contract_run(&reference_profile.id, 100_000, true, "cfr", true),
        ];

        let error = build_best_quality_pair(&source, &candidate_profile, &reference_profile, &runs)
            .expect_err("more than five percent symmetric size delta must fail closed");
        assert!(
            error.contains("symmetric size delta") && error.contains("exceeds 5.00%"),
            "{error}"
        );
    }

    #[test]
    fn best_quality_metric_comparison_respects_direction_ties_and_severe_boundary() {
        let vmaf = BEST_QUALITY_METRIC_SPECS
            .iter()
            .copied()
            .find(|spec| spec.metric_id == "vmaf_neg_mean")
            .expect("VMAF metric spec");
        let tie = compare_best_quality_metric(vmaf, 70.25, 70.0);
        assert_eq!(tie.outcome, "tie");
        assert!(!tie.severe_regression);
        let win = compare_best_quality_metric(vmaf, 70.250_001, 70.0);
        assert_eq!(win.outcome, "win");
        let severe = compare_best_quality_metric(vmaf, 68.0, 70.0);
        assert_eq!(severe.outcome, "loss");
        assert!(severe.severe_regression);

        let cambi = BEST_QUALITY_METRIC_SPECS
            .iter()
            .copied()
            .find(|spec| spec.metric_id == "cambi_mean")
            .expect("CAMBI metric spec");
        let lower_is_better = compare_best_quality_metric(cambi, 0.5, 1.0);
        assert_eq!(lower_is_better.outcome, "win");
        assert!(lower_is_better.quality_improvement > 0.0);
    }

    #[test]
    fn best_quality_slice_requires_vmaf_lead_and_guard_nonregression() {
        let mut pairs = synthetic_best_quality_pairs();
        let pair_refs = pairs.iter().collect::<Vec<_>>();
        let passing =
            build_best_quality_acceptance_slice("all".to_string(), pairs.len(), &pair_refs, true);
        assert!(passing.passed, "{:#?}", passing.metrics);
        let vmaf = passing
            .metrics
            .iter()
            .find(|metric| metric.metric_id == "vmaf_neg_mean")
            .expect("VMAF summary");
        assert_eq!(vmaf.win_count, 28);
        assert_eq!(vmaf.minimum_quality_improvement, Some(1.0));
        assert_eq!(vmaf.p95_quality_improvement, Some(1.0));

        let cambi = BEST_QUALITY_METRIC_SPECS
            .iter()
            .copied()
            .find(|spec| spec.metric_id == "cambi_mean")
            .expect("CAMBI spec");
        for pair in pairs.iter_mut().take(20) {
            let metric = pair
                .metrics
                .iter_mut()
                .find(|metric| metric.metric_id == "cambi_mean")
                .expect("CAMBI comparison");
            *metric = compare_best_quality_metric(cambi, 1.05, 1.0);
        }
        let pair_refs = pairs.iter().collect::<Vec<_>>();
        let failing =
            build_best_quality_acceptance_slice("all".to_string(), pairs.len(), &pair_refs, true);
        let cambi = failing
            .metrics
            .iter()
            .find(|metric| metric.metric_id == "cambi_mean")
            .expect("CAMBI summary");
        assert_eq!(
            (cambi.win_count, cambi.loss_count, cambi.tie_count),
            (0, 20, 8)
        );
        assert_eq!(cambi.severe_regression_count, 0);
        assert!(!cambi.passed);
        assert!(!failing.passed);
    }

    #[test]
    fn best_quality_slice_rejects_temporal_loss_rate_category_regression_and_all_ties() {
        let temporal = BEST_QUALITY_METRIC_SPECS
            .iter()
            .copied()
            .find(|spec| spec.metric_id == "static_region_temporal_residual")
            .expect("temporal spec");
        let mut pairs = synthetic_best_quality_pairs();
        for pair in pairs.iter_mut().take(13) {
            let metric = pair
                .metrics
                .iter_mut()
                .find(|metric| metric.metric_id == temporal.metric_id)
                .expect("temporal comparison");
            *metric = compare_best_quality_metric(temporal, 0.0011, 0.001);
        }
        let refs = pairs.iter().collect::<Vec<_>>();
        let overall = build_best_quality_acceptance_slice("all".to_string(), 28, &refs, true);
        let temporal_summary = overall
            .metrics
            .iter()
            .find(|metric| metric.metric_id == temporal.metric_id)
            .expect("temporal summary");
        assert_eq!(temporal_summary.loss_count, 13);
        assert!(!temporal_summary.passed);

        let vmaf = BEST_QUALITY_METRIC_SPECS[0];
        let mut category_pairs = synthetic_best_quality_pairs()
            .into_iter()
            .take(4)
            .collect::<Vec<_>>();
        for pair in category_pairs.iter_mut().take(2) {
            let metric = pair
                .metrics
                .iter_mut()
                .find(|metric| metric.metric_id == vmaf.metric_id)
                .expect("VMAF comparison");
            *metric = compare_best_quality_metric(vmaf, 69.0, 70.0);
        }
        let refs = category_pairs.iter().collect::<Vec<_>>();
        let category =
            build_best_quality_acceptance_slice("category-0".to_string(), 4, &refs, false);
        assert!(!category.passed);

        for pair in &mut category_pairs {
            let metric = pair
                .metrics
                .iter_mut()
                .find(|metric| metric.metric_id == vmaf.metric_id)
                .expect("VMAF comparison");
            *metric = compare_best_quality_metric(vmaf, 70.0, 70.0);
        }
        let refs = category_pairs.iter().collect::<Vec<_>>();
        let all_ties = build_best_quality_acceptance_slice("all".to_string(), 4, &refs, true);
        assert!(
            !all_ties.passed,
            "VMAF ties must not claim overall leadership"
        );
    }

    #[test]
    fn best_quality_overall_requires_every_declared_guard_to_be_exercised() {
        let mut pairs = synthetic_best_quality_pairs();
        for pair in &mut pairs {
            pair.metrics
                .retain(|metric| metric.metric_id != "loop_seam_excess_oklab");
        }
        let refs = pairs.iter().collect::<Vec<_>>();

        let overall = build_best_quality_acceptance_slice("all".to_string(), 28, &refs, true);
        let loop_guard = overall
            .metrics
            .iter()
            .find(|metric| metric.metric_id == "loop_seam_excess_oklab")
            .expect("loop guard summary");
        assert_eq!(loop_guard.applicable_pair_count, 0);
        assert!(!loop_guard.passed);
        assert!(!overall.passed);

        let category =
            build_best_quality_acceptance_slice("no-loop-category".to_string(), 28, &refs, false);
        let category_loop_guard = category
            .metrics
            .iter()
            .find(|metric| metric.metric_id == "loop_seam_excess_oklab")
            .expect("category loop guard summary");
        assert!(category_loop_guard.passed);
        assert!(category.passed);
    }

    #[test]
    fn best_quality_acceptance_fails_closed_without_profiles_coverage_or_provenance() {
        let source = SourceSnapshot {
            fixture_id: "ui-blink".to_string(),
            category: "ui".to_string(),
            tags: vec![],
            path: "ui-blink.mkv".to_string(),
            sha256: "0".repeat(64),
            expected_source_sha256: None,
            canonical_identity_passed: false,
            inspection: MediaInspection {
                codec: "ffv1".to_string(),
                width: 64,
                height: 64,
                duration: 3.0,
                frame_count: 30,
                animated: true,
                has_alpha: false,
            },
        };
        let report = build_best_quality_acceptance(
            &manifest(),
            &"0".repeat(64),
            &[source],
            &[],
            None,
            Some(true),
            false,
            &toolchain_snapshot(false),
        );
        assert!(!report.applicable);
        assert!(!report.provenance_passed);
        assert!(!report.canonical_corpus_passed);
        assert_eq!(report.expected_pair_count, 1);
        assert_eq!(report.eligible_pair_count, 0);
        assert_eq!(report.omitted_pair_count, 1);
        assert!(!report.passed);
        assert!(report
            .violations
            .iter()
            .any(|violation| violation.contains("no stable best_gif")));
        assert!(report
            .violations
            .iter()
            .any(|violation| violation.contains("clean worktree")));
    }

    #[test]
    fn valid_bootstrap_manifest_passes_validation() {
        validate_manifest(&manifest()).expect("valid manifest");
    }

    #[test]
    fn fixture_preparation_requires_the_reviewed_generator_identity() {
        let manifest = manifest();
        require_canonical_generator_identity(&manifest, &toolchain_snapshot(true))
            .expect("matching generator identity");

        let mut mismatched = toolchain_snapshot(false);
        mismatched.ffmpeg_sha256 = "f".repeat(64);
        mismatched.reviewed_runtime_manifest_sha256 = None;
        let error = require_canonical_generator_identity(&manifest, &mismatched)
            .expect_err("unreviewed generator must fail before fixture preparation");
        assert!(error.contains("before fixture preparation"), "{error}");
        assert!(error.contains("FFmpeg SHA-256"), "{error}");
        assert!(error.contains("reviewed runtime manifest"), "{error}");
    }

    #[test]
    fn complete_fixture_identity_rejects_unknown_or_invalid_hashes() {
        let mut unknown = manifest();
        unknown.canonical_fixture_identity.status = "complete".to_string();
        let error = validate_manifest(&unknown).expect_err("complete identity with null hash");
        assert!(error.contains("cannot be complete"), "{error}");

        let mut invalid = manifest();
        invalid.fixtures[0].expected_source_sha256 = Some("NOT-A-SHA".to_string());
        let error = validate_manifest(&invalid).expect_err("invalid fixture identity hash");
        assert!(error.contains("expected_source_sha256"), "{error}");
    }

    #[test]
    fn first_tier_fixture_identity_requires_complete_sources_and_reviewed_tools() {
        let mut complete = manifest();
        complete.canonical_fixture_identity.status = "complete".to_string();
        complete.fixtures[0].expected_source_sha256 = Some("0".repeat(64));
        validate_manifest(&complete).expect("complete fixed identity manifest");
        let source = identity_source(Some("0".repeat(64)));
        let report = build_best_quality_acceptance(
            &complete,
            &"0".repeat(64),
            &[source],
            &[],
            None,
            Some(false),
            false,
            &toolchain_snapshot(true),
        );
        assert!(report.canonical_fixture_identity_passed);

        complete.canonical_fixture_identity.status = "incomplete".to_string();
        let source = identity_source(Some("0".repeat(64)));
        let report = build_best_quality_acceptance(
            &complete,
            &"0".repeat(64),
            &[source],
            &[],
            None,
            Some(false),
            false,
            &toolchain_snapshot(true),
        );
        assert!(!report.canonical_fixture_identity_passed);
        assert!(report
            .violations
            .iter()
            .any(|violation| violation.contains("fixed identity")));
    }

    #[test]
    fn valid_performance_budget_manifest_passes_validation() {
        let mut manifest = manifest();
        manifest.performance_budget = Some(performance_budget("release"));

        validate_manifest(&manifest).expect("valid release performance budget");
    }

    #[test]
    fn invalid_performance_budget_manifests_are_rejected() {
        let validate_budget = |budget: PerformanceBudgetSpec| {
            let mut manifest = manifest();
            manifest.performance_budget = Some(budget);
            validate_manifest(&manifest).expect_err("invalid performance budget")
        };

        let mut budget = performance_budget("release");
        budget.profile_scope = "all_profiles".to_string();
        let error = validate_budget(budget);
        assert!(
            error.contains("profile_scope must be 'stable_profiles'"),
            "{error}"
        );

        let error = validate_budget(performance_budget("debug"));
        assert!(
            error.contains("required_build_profile must be 'release'"),
            "{error}"
        );

        let mut budget = performance_budget("release");
        budget.minimum_memory_coverage = f64::NAN;
        let error = validate_budget(budget);
        assert!(error.contains("must be between 0 and 1"), "{error}");

        let mut budget = performance_budget("release");
        budget.p95_encode_wall_elapsed_ms = 0;
        let error = validate_budget(budget);
        assert!(error.contains("positive P95 limit"), "{error}");

        let mut budget = performance_budget("release");
        budget.max_encode_wall_elapsed_ms = budget.p95_encode_wall_elapsed_ms - 1;
        let error = validate_budget(budget);
        assert!(error.contains("at least its positive P95 limit"), "{error}");

        let mut budget = performance_budget("release");
        budget.p95_peak_tree_rss_bytes = 0;
        let error = validate_budget(budget);
        assert!(error.contains("positive P95 limit"), "{error}");

        let mut budget = performance_budget("release");
        budget.max_peak_tree_rss_bytes = budget.p95_peak_tree_rss_bytes - 1;
        let error = validate_budget(budget);
        assert!(error.contains("at least its positive P95 limit"), "{error}");
    }

    #[test]
    fn stable_performance_budget_requires_a_non_experimental_profile() {
        let mut manifest = manifest();
        manifest.profiles[0].allow_experimental = true;
        manifest.performance_budget = Some(performance_budget("release"));

        let error = validate_manifest(&manifest).expect_err("stable scope needs a stable profile");
        assert!(error.contains("requires at least one non-experimental profile"));
    }

    #[test]
    fn performance_budget_evaluation_passes_when_all_limits_are_met() {
        let evaluation = evaluate_performance_budget(
            &performance_budget(build_profile()),
            &passing_performance_slice(),
            vec!["fast-baseline".to_string()],
            4,
        );

        assert!(evaluation.build_profile_passed);
        assert!(evaluation.memory_coverage_passed);
        assert!(evaluation.p95_encode_wall_elapsed_passed);
        assert!(evaluation.max_encode_wall_elapsed_passed);
        assert!(evaluation.p95_peak_tree_rss_passed);
        assert!(evaluation.max_peak_tree_rss_passed);
        assert!(evaluation.passed);
        assert!(evaluation.violations.is_empty());
        assert_eq!(evaluation.profile_scope, "stable_profiles");
        assert_eq!(evaluation.profile_ids, vec!["fast-baseline".to_string()]);
        assert_eq!(evaluation.evaluated_run_count, 4);
        assert_eq!(evaluation.excluded_run_count, 0);
        assert_eq!(evaluation.actual.run_count, 4);
    }

    #[test]
    fn performance_budget_reports_build_profile_violation() {
        let required_profile = if build_profile() == "debug" {
            "release"
        } else {
            "debug"
        };
        let evaluation = evaluate_performance_budget(
            &performance_budget(required_profile),
            &passing_performance_slice(),
            vec!["fast-baseline".to_string()],
            4,
        );

        assert!(!evaluation.build_profile_passed);
        assert!(!evaluation.passed);
        assert_eq!(evaluation.violations.len(), 1);
        assert!(evaluation.violations[0].contains("build profile"));
    }

    #[test]
    fn performance_budget_reports_memory_coverage_violation() {
        let mut overall = passing_performance_slice();
        overall.memory_coverage = Some(0.5);
        let evaluation = evaluate_performance_budget(
            &performance_budget(build_profile()),
            &overall,
            vec!["fast-baseline".to_string()],
            4,
        );

        assert!(!evaluation.memory_coverage_passed);
        assert!(!evaluation.passed);
        assert_eq!(evaluation.violations.len(), 1);
        assert!(evaluation.violations[0].contains("memory coverage"));
    }

    #[test]
    fn performance_budget_reports_encode_time_violations() {
        let mut overall = passing_performance_slice();
        overall.p95_encode_wall_elapsed_ms = Some(201);
        overall.max_encode_wall_elapsed_ms = Some(301);
        let evaluation = evaluate_performance_budget(
            &performance_budget(build_profile()),
            &overall,
            vec!["fast-baseline".to_string()],
            4,
        );

        assert!(!evaluation.p95_encode_wall_elapsed_passed);
        assert!(!evaluation.max_encode_wall_elapsed_passed);
        assert!(!evaluation.passed);
        assert_eq!(evaluation.violations.len(), 2);
        assert!(evaluation
            .violations
            .iter()
            .any(|violation| violation.contains("P95 encode time")));
        assert!(evaluation
            .violations
            .iter()
            .any(|violation| violation.contains("max encode time")));
    }

    #[test]
    fn performance_budget_reports_tree_rss_violations() {
        let mut overall = passing_performance_slice();
        overall.p95_peak_tree_rss_bytes = Some(128 * 1024 * 1024 + 1);
        overall.max_peak_tree_rss_bytes = Some(192 * 1024 * 1024 + 1);
        let evaluation = evaluate_performance_budget(
            &performance_budget(build_profile()),
            &overall,
            vec!["fast-baseline".to_string()],
            4,
        );

        assert!(!evaluation.p95_peak_tree_rss_passed);
        assert!(!evaluation.max_peak_tree_rss_passed);
        assert!(!evaluation.passed);
        assert_eq!(evaluation.violations.len(), 2);
        assert!(evaluation
            .violations
            .iter()
            .any(|violation| violation.contains("P95 tree RSS")));
        assert!(evaluation
            .violations
            .iter()
            .any(|violation| violation.contains("max tree RSS")));
    }

    #[test]
    fn performance_baseline_without_budget_keeps_evaluation_absent() {
        let report = build_performance_baseline(&manifest(), &[], &[]);

        assert!(report.budget_evaluation.is_none());
    }

    #[test]
    fn performance_budget_excludes_experimental_profiles_but_overall_keeps_them() {
        let mut manifest = manifest();
        let mut experimental = manifest.profiles[0].clone();
        experimental.id = "regional-experimental".to_string();
        experimental.allow_experimental = true;
        manifest.profiles.push(experimental);
        manifest.performance_budget = Some(performance_budget(build_profile()));
        let runs = [
            performance_run("fast-baseline", 100),
            performance_run("regional-experimental", 99_999),
        ];

        let report = build_performance_baseline(&manifest, &[], &runs);
        assert_eq!(report.overall.run_count, 2);
        assert_eq!(report.overall.max_encode_wall_elapsed_ms, Some(99_999));

        let evaluation = report.budget_evaluation.expect("budget evaluation");
        assert_eq!(evaluation.profile_scope, "stable_profiles");
        assert_eq!(evaluation.profile_ids, vec!["fast-baseline".to_string()]);
        assert_eq!(evaluation.evaluated_run_count, 1);
        assert_eq!(evaluation.excluded_run_count, 1);
        assert_eq!(evaluation.actual.run_count, 1);
        assert_eq!(evaluation.actual.max_encode_wall_elapsed_ms, Some(100));
        assert!(evaluation.passed, "{:?}", evaluation.violations);
    }

    #[test]
    fn external_fixture_requires_safe_path_sha_and_authorization() {
        let mut manifest = manifest();
        manifest.fixtures[0].generator.kind = "external".to_string();
        manifest.fixtures[0].generator.input = "clip.mp4".to_string();

        let missing_sha = validate_manifest(&manifest).expect_err("SHA should be required");
        assert!(missing_sha.contains("source_sha256"), "{missing_sha}");

        manifest.fixtures[0].generator.source_sha256 = Some("0".repeat(64));
        let missing_authorization =
            validate_manifest(&manifest).expect_err("authorization should be required");
        assert!(
            missing_authorization.contains("authorization"),
            "{missing_authorization}"
        );

        manifest.fixtures[0].generator.authorization =
            Some("user-supplied local evaluation only".to_string());
        validate_manifest(&manifest).expect("pinned local fixture should validate");

        manifest.fixtures[0].generator.input = "../clip.mp4".to_string();
        let traversal = validate_manifest(&manifest).expect_err("traversal should be rejected");
        assert!(
            traversal.contains("without parent traversal"),
            "{traversal}"
        );
    }

    #[test]
    fn matched_baseline_expands_only_the_color_ceiling_needed_to_spend_budget() {
        assert_eq!(expanded_match_color_ceiling(96, 100_000, 100_000), 96);
        assert_eq!(expanded_match_color_ceiling(96, 367_577, 289_467), 160);
        assert_eq!(expanded_match_color_ceiling(96, 839_540, 515_871), 256);
        assert_eq!(expanded_match_color_ceiling(96, 4_000_000, 500_000), 256);
        assert_eq!(expanded_match_fps_ceiling(12, 160, 15.0), 12);
        assert_eq!(expanded_match_fps_ceiling(12, 256, 15.0), 15);
    }

    #[test]
    fn reinvestment_calibration_reports_coverage_tail_error_and_correction_yield() {
        let slice = build_target_reinvestment_calibration_slice(
            "all".to_string(),
            TargetReinvestmentCalibrationAccumulator {
                target_profile_run_count: 4,
                sample_ratios: vec![0.90, 1.00, 1.21],
                initial_under_target_count: 2,
                correction_attempt_count: 2,
                correction_success_count: 1,
            },
        );
        assert_eq!(slice.sample_count, 3);
        assert_eq!(slice.sample_rate, Some(0.75));
        assert_eq!(slice.initial_under_target_rate, Some(2.0 / 3.0));
        assert_eq!(slice.correction_success_rate, Some(0.5));
        assert_eq!(slice.p95_actual_to_predicted_ratio, Some(1.21));
        let recommended = slice
            .recommended_spatial_safety_factor
            .expect("three samples produce a calibration recommendation");
        assert!((recommended - (0.96 / 1.21_f64.sqrt())).abs() < 1e-9);
    }

    #[test]
    fn reinvestment_calibration_does_not_invent_rates_without_samples() {
        let slice = build_target_reinvestment_calibration_slice(
            "transparent".to_string(),
            TargetReinvestmentCalibrationAccumulator {
                target_profile_run_count: 2,
                ..TargetReinvestmentCalibrationAccumulator::default()
            },
        );
        assert_eq!(slice.sample_rate, Some(0.0));
        assert_eq!(slice.initial_under_target_rate, None);
        assert_eq!(slice.correction_success_rate, None);
        assert_eq!(slice.mean_actual_to_predicted_ratio, None);
        assert_eq!(slice.recommended_spatial_safety_factor, None);
    }

    #[test]
    fn hard_cap_acceptance_requires_ninety_percent_known_feasible_hits() {
        let mut accumulator = HardCapAcceptanceAccumulator::default();
        for _ in 0..9 {
            accumulator.observe(true, Some(100_000), Some(97_500), true);
        }
        accumulator.observe(true, Some(100_000), Some(94_000), true);
        let slice = build_hard_cap_acceptance_slice("all".to_string(), accumulator.clone());
        assert_eq!(slice.known_feasible_count, 10);
        assert_eq!(slice.accepted_hit_count, 9);
        assert_eq!(slice.undershoot_count, 1);
        assert_eq!(slice.hit_rate, Some(0.9));
        assert!(slice.passed);

        accumulator.observe(true, Some(100_000), Some(100_001), true);
        let overshoot = build_hard_cap_acceptance_slice("all".to_string(), accumulator);
        assert_eq!(overshoot.overshoot_count, 1);
        assert!(!overshoot.all_measurable_outputs_under_cap);
        assert!(!overshoot.passed);
    }

    #[test]
    fn hard_cap_profile_can_use_an_earlier_fast_witness() {
        let mut manifest = manifest();
        let mut target = manifest.profiles[0].clone();
        target.id = "target-hard-cap-known-feasible".to_string();
        target.generation_mode = "target_size".to_string();
        target.match_target_profile_id = Some("fast-baseline".to_string());
        target.target_constraint = Some("hard_cap".to_string());
        target.target_size_scale = Some(1.025);
        manifest.profiles.push(target);
        validate_manifest(&manifest).expect("hard-cap witness profile should validate");
    }

    #[test]
    fn symmetric_match_rejects_scaled_targets() {
        let mut manifest = manifest();
        let mut best = manifest.profiles[0].clone();
        best.id = "best-current".to_string();
        best.generation_mode = "best_gif".to_string();
        manifest.profiles.push(best);

        let mut target = manifest.profiles[0].clone();
        target.id = "ffmpeg-size-match".to_string();
        target.generation_mode = "target_size".to_string();
        target.match_target_profile_id = Some("best-current".to_string());
        target.target_constraint = Some("symmetric_match".to_string());
        target.target_size_scale = Some(1.025);
        manifest.profiles.push(target);
        let error = validate_manifest(&manifest).expect_err("scaled symmetric target should fail");
        assert!(error.contains("target_size_scale 1.0"), "{error}");
    }

    #[test]
    fn reinvestment_calibration_extracts_verified_correction_from_optimizer_routes() {
        use crate::commands::{TargetRouteObservationReport, TargetRoutePredictionReport};

        let route = |route_id: &str, under_target: bool, correction_pass: u8| {
            TargetRouteObservationReport {
                route_id: route_id.to_string(),
                timeline: "perceptual_drop_hold".to_string(),
                width: if correction_pass == 0 { 480 } else { 420 },
                fps: 12,
                colors: 96,
                dither: "bayer".to_string(),
                palette_stats_mode: "diff".to_string(),
                size_bytes: Some(if under_target { 980_000 } else { 1_080_000 }),
                symmetric_deviation_percent: Some(2.0),
                under_target,
                within_tolerance: under_target,
                selected: under_target,
                kept_frame_count: Some(24),
                dropped_frame_count: Some(12),
                timeline_verified: true,
                prediction: Some(TargetRoutePredictionReport {
                    model_id: if correction_pass == 0 {
                        "spatial_area_color_v1"
                    } else {
                        "measured_bracket_v1"
                    }
                    .to_string(),
                    source_route_id: "perceptual_timeline".to_string(),
                    source_size_bytes: 700_000,
                    predicted_size_bytes: 900_000,
                    actual_to_predicted_ratio: Some(if correction_pass == 0 { 1.2 } else { 1.08 }),
                    correction_pass,
                }),
                status: "encoded".to_string(),
                failure_reason: None,
            }
        };
        let report = TargetOptimizerReport {
            optimizer_id: "test".to_string(),
            optimizer_version: "test".to_string(),
            selection_policy: "test".to_string(),
            constraint: "hard_cap".to_string(),
            preference: "clarity".to_string(),
            target_bytes: 1_000_000,
            tolerance_percent: 5.0,
            max_attempts: 8,
            numeric_attempt_count: 4,
            route_attempt_count: 5,
            selected_attempt: 4,
            route_probe_id: "test".to_string(),
            selected_route_id: "perceptual_reinvest_corrected".to_string(),
            observations: Vec::new(),
            recommendations: Vec::new(),
            route_observations: vec![
                route("perceptual_reinvest", false, 0),
                route("perceptual_reinvest_corrected", true, 1),
            ],
        };
        let mut accumulator = TargetReinvestmentCalibrationAccumulator::default();
        accumulator.observe(Some(&report));
        assert_eq!(accumulator.target_profile_run_count, 1);
        assert_eq!(accumulator.sample_ratios, vec![1.2]);
        assert_eq!(accumulator.initial_under_target_count, 0);
        assert_eq!(accumulator.correction_attempt_count, 1);
        assert_eq!(accumulator.correction_success_count, 1);
    }

    #[test]
    fn checked_in_manifest_loads_and_matches_the_runtime_schema() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root");
        let path = workspace.join("bench/corpus-manifest.json");
        let loaded = load_manifest(&path).expect("checked-in manifest");
        assert_eq!(loaded.manifest.corpus_id, BEST_QUALITY_CANONICAL_CORPUS_ID);
        assert_eq!(loaded.sha256, BEST_QUALITY_CANONICAL_MANIFEST_SHA256);
        assert_eq!(loaded.manifest.fixtures.len(), 28);
        assert_eq!(loaded.manifest.profiles.len(), 8);
        assert_eq!(
            loaded.manifest.profiles[3].id,
            "target-hard-cap-known-feasible"
        );
        assert_eq!(
            loaded.manifest.profiles[3].effective_target_constraint(),
            TargetConstraint::HardCap
        );
        assert_eq!(loaded.manifest.profiles[3].target_size_scale, Some(1.025));
        assert_eq!(loaded.manifest.profiles[4].id, "fast-compressed-witness");
        assert_eq!(loaded.manifest.profiles[4].width, 240);
        assert_eq!(loaded.manifest.profiles[5].id, "target-hard-cap-compressed");
        assert_eq!(
            loaded.manifest.profiles[5].effective_target_constraint(),
            TargetConstraint::HardCap
        );
        assert_eq!(loaded.manifest.profiles[6].id, "regional-experimental");
        assert!(loaded.manifest.profiles[6].allow_experimental);
        assert_eq!(loaded.manifest.profiles[7].id, "ffmpeg-regional-size-match");
        assert_eq!(
            loaded.manifest.profiles[7].effective_target_constraint(),
            TargetConstraint::SymmetricMatch
        );
        let blind_pairs = blind_profile_pairs(&loaded.manifest).expect("blind profile pairs");
        assert_eq!(blind_pairs.len(), 2);
        assert_eq!(blind_pairs[0].0.id, "ffmpeg-size-match");
        assert_eq!(blind_pairs[0].1.id, "best-current");
        assert_eq!(blind_pairs[1].0.id, "ffmpeg-regional-size-match");
        assert_eq!(blind_pairs[1].1.id, "regional-experimental");
        assert!(loaded.manifest.coverage.is_some());
        assert_eq!(
            loaded
                .manifest
                .performance_budget
                .as_ref()
                .map(|budget| budget.profile_scope.as_str()),
            Some("stable_profiles")
        );

        for schema in [
            "bench/corpus-manifest.schema.json",
            "bench/quality-report.schema.json",
        ] {
            let bytes = fs::read(workspace.join(schema)).expect("read schema");
            let value: Value = serde_json::from_slice(&bytes).expect("valid schema JSON");
            assert_eq!(
                value["$schema"],
                "https://json-schema.org/draft/2020-12/schema"
            );
        }
        let report_schema: Value = serde_json::from_slice(
            &fs::read(workspace.join("bench/quality-report.schema.json"))
                .expect("read report schema"),
        )
        .expect("valid report schema");
        assert_eq!(report_schema["properties"]["schema_version"]["const"], 9);
        let mut schema_properties = report_schema["properties"]
            .as_object()
            .expect("report schema properties")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        schema_properties.sort_unstable();
        let mut runtime_properties = vec![
            "artifact_bundle",
            "best_quality_acceptance",
            "failed_runs",
            "generated_at_unix_ms",
            "git_commit",
            "git_dirty",
            "host",
            "manifest",
            "manifest_path",
            "manifest_sha256",
            "performance_baseline",
            "run_id",
            "runs",
            "schema_version",
            "sources",
            "successful_runs",
            "target_hard_cap_acceptance",
            "target_reinvestment_calibration",
            "toolchain",
        ];
        runtime_properties.sort_unstable();
        assert_eq!(schema_properties, runtime_properties);
        assert_eq!(
            report_schema["properties"]["best_quality_acceptance"]["$ref"],
            "#/$defs/bestQualityAcceptance"
        );
        let best_quality = &report_schema["$defs"]["bestQualityAcceptance"];
        assert_eq!(best_quality["additionalProperties"], false);
        assert_eq!(
            best_quality["properties"]["acceptance_id"]["const"],
            "gifp.best_same_size.first_tier.v1"
        );
        for field in [
            "acceptance_id",
            "corpus_id",
            "corpus_manifest_sha256",
            "canonical_corpus_passed",
            "canonical_fixture_identity_passed",
            "applicable",
            "candidate_profile_id",
            "reference_profile_id",
            "maximum_size_delta_percent",
            "minimum_pair_count",
            "minimum_category_count",
            "required_pair_coverage",
            "required_vmaf_win_rate",
            "provenance_passed",
            "expected_pair_count",
            "eligible_pair_count",
            "omitted_pair_count",
            "pair_coverage",
            "overall",
            "categories",
            "pairs",
            "omissions",
            "passed",
            "violations",
        ] {
            assert!(best_quality["required"]
                .as_array()
                .is_some_and(|required| required.iter().any(|item| item == field)));
        }
        assert_eq!(
            best_quality["properties"]["maximum_size_delta_percent"]["const"],
            BEST_QUALITY_MAX_SIZE_DELTA_PERCENT
        );
        assert_eq!(
            best_quality["properties"]["minimum_pair_count"]["const"],
            BEST_QUALITY_MINIMUM_PAIR_COUNT
        );
        assert_eq!(
            best_quality["properties"]["minimum_category_count"]["const"],
            BEST_QUALITY_MINIMUM_CATEGORY_COUNT
        );
        assert_eq!(
            best_quality["properties"]["required_pair_coverage"]["const"],
            BEST_QUALITY_REQUIRED_PAIR_COVERAGE
        );
        assert_eq!(
            best_quality["properties"]["required_vmaf_win_rate"]["const"],
            BEST_QUALITY_REQUIRED_VMAF_WIN_RATE
        );
        assert!(report_schema["required"]
            .as_array()
            .is_some_and(|required| required
                .iter()
                .any(|item| item == "best_quality_acceptance")));
        let metric_summary = &report_schema["$defs"]["bestQualityMetricSummary"];
        assert_eq!(metric_summary["additionalProperties"], false);
        assert_eq!(
            metric_summary["properties"]["direction"]["enum"],
            json!(["higher_is_better", "lower_is_better"])
        );
        let metric_comparison = &report_schema["$defs"]["bestQualityMetricComparison"];
        assert_eq!(metric_comparison["additionalProperties"], false);
        assert_eq!(
            metric_comparison["properties"]["outcome"]["enum"],
            json!(["win", "tie", "loss"])
        );
        assert_eq!(
            report_schema["properties"]["artifact_bundle"]["$ref"],
            "#/$defs/artifactBundle"
        );
        let artifact_bundle = &report_schema["$defs"]["artifactBundle"];
        assert_eq!(artifact_bundle["additionalProperties"], false);
        for field in [
            "schema_version",
            "run_id",
            "root_path",
            "manifest_path",
            "manifest_sha256",
            "artifacts",
        ] {
            assert!(artifact_bundle["required"]
                .as_array()
                .is_some_and(|required| required.iter().any(|item| item == field)));
        }
        let bundle_entry = &report_schema["$defs"]["artifactBundleEntry"];
        assert_eq!(bundle_entry["additionalProperties"], false);
        for field in ["role", "relative_path", "sha256", "size_bytes"] {
            assert!(bundle_entry["required"]
                .as_array()
                .is_some_and(|required| required.iter().any(|item| item == field)));
        }
        assert!(
            report_schema["$defs"]["performanceBudgetEvaluation"]["required"]
                .as_array()
                .is_some_and(|required| required.iter().any(|item| item == "profile_scope"))
        );
        assert!(
            report_schema["$defs"]["performanceBudgetEvaluation"]["required"]
                .as_array()
                .is_some_and(|required| required.iter().any(|item| item == "actual"))
        );
        assert!(report_schema["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|item| item == "performance_baseline")));
        assert!(report_schema["$defs"]["metrics"]["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|item| item == "encode_memory")));
        assert!(report_schema["$defs"]["processTreeMemory"]["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|item| item == "peak_processes")));
        assert_eq!(
            report_schema["$defs"]["processTreeMemory"]["properties"]["peak_processes"]["items"]
                ["$ref"],
            "#/$defs/processMemoryBreakdown"
        );
    }

    #[test]
    fn duplicate_fixture_ids_are_rejected() {
        let mut manifest = manifest();
        manifest.fixtures.push(manifest.fixtures[0].clone());
        let error = validate_manifest(&manifest).expect_err("duplicate should fail");
        assert!(error.contains("Duplicate fixture id"), "{error}");
    }

    #[test]
    fn target_size_profile_requires_an_earlier_best_profile() {
        let mut manifest = manifest();
        let mut target = manifest.profiles[0].clone();
        target.id = "ffmpeg-size-match".to_string();
        target.generation_mode = "target_size".to_string();
        target.match_target_profile_id = None;
        manifest.profiles.push(target.clone());
        let missing = validate_manifest(&manifest).expect_err("missing target should fail");
        assert!(
            missing.contains("must declare match_target_profile_id"),
            "{missing}"
        );

        target.match_target_profile_id = Some("fast-baseline".to_string());
        manifest.profiles[1] = target;
        let wrong_mode = validate_manifest(&manifest).expect_err("fast target should fail");
        assert!(
            wrong_mode.contains("must match a best_gif profile"),
            "{wrong_mode}"
        );
    }

    #[test]
    fn declared_coverage_rejects_an_incomplete_corpus() {
        let mut manifest = manifest();
        manifest.coverage = Some(CoverageSpec {
            minimum_total: 28,
            minimum_per_category: 4,
            required_categories: vec!["ui".to_string()],
            required_tags: vec!["transparent".to_string()],
        });
        let error = validate_manifest(&manifest).expect_err("coverage should fail");
        assert!(error.contains("at least 28 fixtures"), "{error}");
    }

    #[test]
    fn fixture_parent_traversal_is_rejected() {
        let mut manifest = manifest();
        manifest.fixtures[0].file = "../outside.mkv".to_string();
        let error = validate_manifest(&manifest).expect_err("traversal should fail");
        assert!(error.contains("without parent traversal"), "{error}");
    }

    #[test]
    fn cli_defaults_to_run_and_supports_prepare() {
        let run = parse_cli_options(Vec::<String>::new())
            .expect("parse run")
            .expect("run options");
        assert_eq!(run.command, LabCommand::Run);
        let prepare = parse_cli_options(["prepare", "--manifest", "custom.json"])
            .expect("parse prepare")
            .expect("prepare options");
        assert_eq!(prepare.command, LabCommand::Prepare);
        assert_eq!(prepare.manifest_path, PathBuf::from("custom.json"));
        assert!(prepare.fixture_ids.is_none());

        let focused = parse_cli_options(["run", "--fixtures", "ui-blink,flat-wave"])
            .expect("parse focused run")
            .expect("focused options");
        assert_eq!(
            focused.fixture_ids,
            Some(vec!["ui-blink".to_string(), "flat-wave".to_string()])
        );
    }

    #[test]
    fn request_fingerprint_ignores_machine_specific_paths() {
        let first = json!({
            "input_path": "C:/first/input.mkv",
            "output_dir": "C:/first/run",
            "width": 320,
        });
        let second = json!({
            "input_path": "/other/input.mkv",
            "output_dir": "/other/run",
            "width": 320,
        });
        assert_eq!(
            request_fingerprint(&first, "source-a").expect("first fingerprint"),
            request_fingerprint(&second, "source-a").expect("second fingerprint")
        );
        assert_ne!(
            request_fingerprint(&first, "source-a").expect("source a"),
            request_fingerprint(&first, "source-b").expect("source b")
        );
    }

    #[test]
    fn report_siblings_preserve_the_requested_stem() {
        let report = Path::new("tmp/quality lab/latest.json");
        assert_eq!(
            sibling_artifact_path(report, "", "csv").expect("CSV path"),
            PathBuf::from("tmp/quality lab/latest.csv")
        );
        assert_eq!(
            sibling_artifact_path(report, "-blind", "html").expect("HTML path"),
            PathBuf::from("tmp/quality lab/latest-blind.html")
        );
    }

    #[test]
    fn formal_blind_pairs_require_size_correctness_and_a_clean_commit() {
        assert!(formal_blind_pair_eligible(
            5.0,
            5.0,
            true,
            true,
            Some("0123456789abcdef"),
            Some(false),
        ));
        assert!(!formal_blind_pair_eligible(
            5.01,
            5.0,
            true,
            true,
            Some("0123456789abcdef"),
            Some(false),
        ));
        assert!(!formal_blind_pair_eligible(
            4.0,
            5.0,
            false,
            true,
            Some("0123456789abcdef"),
            Some(false),
        ));
        assert!(!formal_blind_pair_eligible(
            4.0,
            5.0,
            true,
            true,
            Some("0123456789abcdef"),
            Some(true),
        ));
        assert!(!formal_blind_pair_eligible(
            4.0,
            5.0,
            true,
            true,
            None,
            Some(false),
        ));
    }

    #[test]
    fn csv_rows_escape_commas_quotes_and_newlines() {
        let mut output = String::new();
        append_csv_row(
            &mut output,
            vec![
                "plain".to_string(),
                "comma,value".to_string(),
                "say \"hello\"\nnext".to_string(),
            ],
        );
        assert_eq!(
            output,
            "plain,\"comma,value\",\"say \"\"hello\"\"\nnext\"\n"
        );
    }

    #[test]
    fn symmetric_size_delta_is_order_independent() {
        assert_eq!(symmetric_size_delta_percent(0, 0), 0.0);
        let first = symmetric_size_delta_percent(95, 100);
        let second = symmetric_size_delta_percent(100, 95);
        assert!((first - second).abs() < f64::EPSILON);
        assert!((first - 5.128_205_128).abs() < 1e-6);
    }

    #[test]
    fn process_tree_membership_includes_transitive_children_but_not_siblings() {
        let root = Pid::from_u32(10);
        let nodes = vec![
            (root, None, 100),
            (Pid::from_u32(11), Some(root), 100),
            (Pid::from_u32(12), Some(Pid::from_u32(11)), 100),
            (Pid::from_u32(20), Some(Pid::from_u32(1)), 100),
            (Pid::from_u32(21), Some(Pid::from_u32(20)), 101),
        ];
        let included = descendant_process_ids(root, &nodes);
        assert_eq!(included.len(), 3);
        assert!(included.contains(&root));
        assert!(included.contains(&Pid::from_u32(11)));
        assert!(included.contains(&Pid::from_u32(12)));
        assert!(!included.contains(&Pid::from_u32(20)));
        assert!(!included.contains(&Pid::from_u32(21)));
    }

    #[test]
    fn process_tree_membership_rejects_pid_reuse_older_than_parent() {
        let root = Pid::from_u32(10);
        let ffmpeg = Pid::from_u32(11);
        let reused_git = Pid::from_u32(12);
        let nodes = vec![
            (root, None, 100),
            (ffmpeg, Some(root), 200),
            (reused_git, Some(ffmpeg), 111),
            (Pid::from_u32(13), Some(ffmpeg), 201),
            (Pid::from_u32(14), Some(reused_git), 220),
            (Pid::from_u32(15), Some(ffmpeg), 0),
        ];
        let included = descendant_process_ids(root, &nodes);
        assert_eq!(included.len(), 3);
        assert!(included.contains(&root));
        assert!(included.contains(&ffmpeg));
        assert!(included.contains(&Pid::from_u32(13)));
        assert!(!included.contains(&reused_git));
        assert!(!included.contains(&Pid::from_u32(14)));
        assert!(!included.contains(&Pid::from_u32(15)));
    }

    #[test]
    fn peak_process_breakdown_requires_exact_unique_single_root_sum() {
        let root = ProcessMemoryBreakdown {
            pid: 10,
            parent_pid: Some(1),
            name: "gifp_quality_lab".to_string(),
            start_time_unix_seconds: 100,
            rss_bytes: 8,
            is_root: true,
        };
        let child = ProcessMemoryBreakdown {
            pid: 11,
            parent_pid: Some(10),
            name: "ffmpeg.exe".to_string(),
            start_time_unix_seconds: 101,
            rss_bytes: 92,
            is_root: false,
        };
        assert!(valid_peak_process_breakdown(
            &[root.clone(), child.clone()],
            100
        ));
        assert!(!valid_peak_process_breakdown(
            &[root.clone(), child.clone()],
            99
        ));

        let mut duplicate_pid = child.clone();
        duplicate_pid.pid = root.pid;
        assert!(!valid_peak_process_breakdown(
            &[root.clone(), duplicate_pid],
            100
        ));

        let mut reused_pid = child.clone();
        reused_pid.start_time_unix_seconds = 99;
        assert!(!valid_peak_process_breakdown(
            &[root.clone(), reused_pid],
            100
        ));

        let mut unknown_start = child.clone();
        unknown_start.start_time_unix_seconds = 0;
        assert!(!valid_peak_process_breakdown(
            &[root.clone(), unknown_start],
            100
        ));

        let mut root_cycle = root.clone();
        root_cycle.parent_pid = Some(child.pid);
        assert!(!valid_peak_process_breakdown(
            &[root_cycle, child.clone()],
            100
        ));

        let mut orphan = child.clone();
        orphan.parent_pid = Some(99);
        assert!(!valid_peak_process_breakdown(&[root.clone(), orphan], 100));

        let mut cycle_first = child.clone();
        cycle_first.parent_pid = Some(12);
        cycle_first.rss_bytes = 46;
        let cycle_second = ProcessMemoryBreakdown {
            pid: 12,
            parent_pid: Some(11),
            name: "git.exe".to_string(),
            start_time_unix_seconds: 102,
            rss_bytes: 46,
            is_root: false,
        };
        assert!(!valid_peak_process_breakdown(
            &[root.clone(), cycle_first, cycle_second],
            100
        ));

        let mut second_root = child;
        second_root.is_root = true;
        assert!(!valid_peak_process_breakdown(&[root, second_root], 100));
    }

    #[test]
    fn process_tree_peak_is_strict_and_breakdown_order_is_stable() {
        let process = |pid, rss_bytes, is_root| ProcessMemoryBreakdown {
            pid,
            parent_pid: None,
            name: format!("process-{pid}"),
            start_time_unix_seconds: 1,
            rss_bytes,
            is_root,
        };
        let mut peak = ProcessTreeMemorySnapshot {
            rss_bytes: 100,
            process_count: 1,
            processes: vec![process(10, 100, true)],
        };
        let equal = ProcessTreeMemorySnapshot {
            rss_bytes: 100,
            process_count: 1,
            processes: vec![process(20, 100, true)],
        };
        retain_strict_process_tree_peak(&mut peak, &equal);
        assert_eq!(
            peak.processes[0].pid, 10,
            "equal peaks keep the first snapshot"
        );

        let higher = ProcessTreeMemorySnapshot {
            rss_bytes: 101,
            process_count: 2,
            processes: vec![process(30, 60, true), process(31, 41, false)],
        };
        retain_strict_process_tree_peak(&mut peak, &higher);
        assert_eq!(peak, higher);

        let lower = ProcessTreeMemorySnapshot {
            rss_bytes: 99,
            process_count: 1,
            processes: vec![process(40, 99, true)],
        };
        retain_strict_process_tree_peak(&mut peak, &lower);
        assert_eq!(peak, higher);

        let mut unsorted = vec![
            process(12, 5, false),
            process(13, 9, false),
            process(11, 9, true),
        ];
        sort_process_breakdown(&mut unsorted);
        assert_eq!(
            unsorted.iter().map(|entry| entry.pid).collect::<Vec<_>>(),
            vec![11, 13, 12]
        );
    }

    #[test]
    fn performance_baseline_uses_nearest_rank_and_reports_memory_coverage() {
        let slice = build_performance_baseline_slice(
            "all".to_string(),
            PerformanceBaselineAccumulator {
                run_count: 4,
                encode_wall_elapsed_ms: vec![400, 100, 300, 200],
                peak_tree_rss_bytes: vec![40, 20, 30],
                peak_incremental_tree_rss_bytes: vec![14, 12, 13],
            },
        );
        assert_eq!(slice.timed_run_count, 4);
        assert_eq!(slice.memory_measured_run_count, 3);
        assert_eq!(slice.memory_coverage, Some(0.75));
        assert_eq!(slice.p50_encode_wall_elapsed_ms, Some(200));
        assert_eq!(slice.p95_encode_wall_elapsed_ms, Some(400));
        assert_eq!(slice.p50_peak_tree_rss_bytes, Some(30));
        assert_eq!(slice.p95_peak_tree_rss_bytes, Some(40));
        assert_eq!(slice.p50_peak_incremental_tree_rss_bytes, Some(13));
        assert_eq!(slice.max_peak_incremental_tree_rss_bytes, Some(14));
    }

    #[test]
    fn semi_transparent_fixtures_have_an_explicit_binary_alpha_tolerance() {
        assert_eq!(alpha_coverage_tolerance(&[]), 0.02);
        assert_eq!(
            alpha_coverage_tolerance(&["semi-transparent".to_string()]),
            0.04
        );
    }

    fn isolated_quality_test_dir(label: &str) -> PathBuf {
        env::temp_dir().join(format!("{label}-{}", unique_quality_token()))
    }

    #[test]
    fn quality_git_dirty_detection_includes_untracked_files() {
        let root = isolated_quality_test_dir("gifp-quality-git-dirty");
        fs::create_dir_all(&root).expect("create isolated Git repository");
        let run_git = |arguments: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(arguments)
                .output()
                .expect("execute Git for dirty-state fixture");
            assert!(
                output.status.success(),
                "git {} failed: {}",
                arguments.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(&["init", "--quiet"]);
        run_git(&["config", "user.email", "quality-lab@example.invalid"]);
        run_git(&["config", "user.name", "GIFP Quality Lab"]);
        run_git(&["config", "commit.gpgsign", "false"]);
        fs::write(root.join("tracked.txt"), b"tracked\n").expect("write tracked Git fixture");
        run_git(&["add", "tracked.txt"]);
        run_git(&["commit", "--quiet", "-m", "quality fixture"]);
        assert_eq!(git_worktree_dirty(&root), Some(false));

        fs::write(root.join("untracked.txt"), b"untracked\n").expect("write untracked Git fixture");
        assert_eq!(git_worktree_dirty(&root), Some(true));
        fs::remove_dir_all(&root).expect("remove isolated Git repository");
    }

    fn assert_no_quality_transaction_files(root: &Path) {
        for entry in fs::read_dir(root).expect("read quality transaction directory") {
            let entry = entry.expect("quality transaction entry");
            let path = entry.path();
            if path.is_dir() {
                assert_no_quality_transaction_files(&path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(
                !name.ends_with(".part") && !name.ends_with(".stage") && !name.ends_with(".lock"),
                "leftover Quality Lab transaction file: {}",
                path.display()
            );
        }
    }

    #[test]
    fn fixture_filtering_happens_before_preparation() {
        let mut manifest = manifest();
        let mut second = manifest.fixtures[0].clone();
        second.id = "flat-wave".to_string();
        second.file = "flat-wave.mkv".to_string();
        manifest.fixtures.push(second);

        let selected = select_fixture_specs(&manifest.fixtures, Some(&["flat-wave".to_string()]))
            .expect("select one fixture before preparation");
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "flat-wave");
        let error =
            select_fixture_specs(&manifest.fixtures, Some(&["missing-fixture".to_string()]))
                .expect_err("unknown focused fixture must fail before generation");
        assert!(error.contains("Unknown fixture id"), "{error}");
    }

    #[test]
    fn fixture_staging_extension_follows_the_manifest_file() {
        let mut fixture = manifest().fixtures.remove(0);
        fixture.file = "nested/fixture.webm".to_string();
        assert_eq!(fixture_file_extension(&fixture).unwrap(), "webm");
        fixture.file = "fixture-without-extension".to_string();
        assert!(fixture_file_extension(&fixture).is_err());
    }

    #[test]
    fn external_fixture_snapshot_stays_pinned_after_source_replacement() {
        let root = isolated_quality_test_dir("gifp-quality-external-snapshot");
        fs::create_dir_all(&root).expect("create external snapshot directory");
        let root = fs::canonicalize(&root).expect("canonicalize external snapshot directory");
        let original = b"authorized external fixture bytes";
        let source = root.join("source.mp4");
        fs::write(&source, original).expect("write external fixture source");
        let mut fixture = manifest().fixtures.remove(0);
        fixture.generator.kind = "external".to_string();
        fixture.generator.input = "source.mp4".to_string();
        fixture.generator.source_sha256 = Some(sha256_bytes(original));
        let snapshot = snapshot_external_fixture(&root, &fixture, &root)
            .expect("create pinned external fixture snapshot");
        fs::write(&source, b"replacement bytes").expect("replace original source");
        assert_eq!(
            fs::read(&snapshot).expect("read immutable snapshot"),
            original
        );
        let _ = fs::remove_file(snapshot);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn canonical_containment_rejects_paths_outside_the_trusted_root() {
        let root = isolated_quality_test_dir("gifp-quality-contained-root");
        let trusted = root.join("trusted");
        let outside = root.join("outside");
        fs::create_dir_all(&trusted).expect("create trusted root");
        fs::create_dir_all(&outside).expect("create outside directory");
        let trusted = fs::canonicalize(&trusted).expect("canonicalize trusted root");
        let error = canonical_path_within(&trusted, &outside, "test escape")
            .expect_err("outside path must be rejected");
        assert!(error.contains("outside trusted root"), "{error}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exclusive_run_roots_are_unique_for_the_same_clock_tick() {
        let root = isolated_quality_test_dir("gifp-quality-run-root");
        fs::create_dir_all(&root).expect("create run-root test directory");
        let (first_id, first) =
            create_exclusive_run_root(&root, "same-revision", 42).expect("first run root");
        let (second_id, second) =
            create_exclusive_run_root(&root, "same-revision", 42).expect("second run root");
        assert_ne!(first_id, second_id);
        assert!(first.is_dir());
        assert!(second.is_dir());
        assert!(first_id.contains(&process::id().to_string()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn atomic_artifact_write_replaces_the_previous_complete_file() {
        let root = isolated_quality_test_dir("gifp-quality-atomic-artifact");
        fs::create_dir_all(&root).expect("create atomic artifact directory");
        let report = root.join("latest.json");
        fs::write(&report, br#"{"owner":"old"}"#).expect("write old report");
        write_bytes_atomically(&report, br#"{"owner":"new"}"#, "test report")
            .expect("atomically replace report");
        let parsed: Value = serde_json::from_slice(&fs::read(&report).expect("read new report"))
            .expect("new report stays valid JSON");
        assert_eq!(parsed["owner"], "new");
        assert_no_quality_transaction_files(&root);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn artifact_bundle_inventory_records_role_path_size_and_sha() {
        let root = isolated_quality_test_dir("gifp-quality-bundle-inventory");
        let assets = root.join("gifp-blind-assets-run").join("fixture");
        fs::create_dir_all(&assets).expect("create bundle asset directory");
        fs::write(root.join("report.json"), b"{}\n").expect("write bundled JSON");
        fs::write(root.join("report.csv"), b"run_id\nrun\n").expect("write bundled CSV");
        fs::write(root.join("blind.html"), b"<html></html>\n").expect("write bundled HTML");
        fs::write(assets.join("a.gif"), b"GIF89a fixture").expect("write bundled GIF");

        let entries = collect_artifact_bundle_entries(&root).expect("inventory bundle");
        let report = entries
            .iter()
            .find(|entry| entry.relative_path == "report.json")
            .expect("report entry");
        assert_eq!(report.role, "report_json");
        assert_eq!(report.size_bytes, 3);
        assert_eq!(report.sha256, sha256_bytes(b"{}\n"));
        let asset = entries
            .iter()
            .find(|entry| entry.relative_path.ends_with("fixture/a.gif"))
            .expect("blind asset entry");
        assert_eq!(asset.role, "blind_asset");
        assert_eq!(asset.size_bytes, b"GIF89a fixture".len() as u64);
        assert_eq!(asset.sha256, sha256_bytes(b"GIF89a fixture"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn artifact_bundle_verification_rejects_link_escape() {
        let parent = isolated_quality_test_dir("gifp-quality-bundle-link-escape");
        let root = parent.join("bundle");
        fs::create_dir_all(&root).expect("create bundle root");
        fs::write(root.join("report.json"), b"{}\n").expect("write bundled JSON");
        fs::write(root.join("report.csv"), b"run_id\nrun\n").expect("write bundled CSV");
        fs::write(root.join("blind.html"), b"<html></html>\n").expect("write bundled HTML");
        fs::write(root.join("build-provenance.json"), b"{}\n").expect("write build provenance");
        let asset = root.join("asset.gif");
        fs::write(&asset, b"GIF89a fixture").expect("write bundled asset");
        let reference = finalize_artifact_bundle(&root, "link-escape-run")
            .expect("seal bundle before link replacement");
        let outside = parent.join("outside.gif");
        fs::write(&outside, b"GIF89a fixture").expect("write outside asset");
        fs::remove_file(&asset).expect("remove bundled asset");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &asset).expect("create escaping asset symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside, &asset).is_err() {
            // Some Windows installations disable unprivileged symlinks. The
            // canonical-containment unit test still exercises the rejection
            // rule; skip only this OS integration branch.
            let _ = fs::remove_dir_all(parent);
            return;
        }
        let error = verify_artifact_bundle(&reference)
            .expect_err("bundle verification must reject a link outside its root");
        assert!(error.contains("outside trusted root"), "{error}");
        let _ = fs::remove_file(asset);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn fixture_alias_publication_rejects_linked_leaf() {
        let root = isolated_quality_test_dir("gifp-quality-fixture-link-escape");
        fs::create_dir_all(&root).expect("create fixture link test root");
        let cache = root.join("cache.mkv");
        fs::write(&cache, b"authorized fixture").expect("write fixture cache entry");
        let outside = root.join("outside.mkv");
        fs::write(&outside, b"outside must stay unchanged").expect("write outside target");
        let alias = root.join("fixture.mkv");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &alias).expect("create fixture alias symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside, &alias).is_err() {
            let _ = fs::remove_dir_all(root);
            return;
        }
        let error = publish_fixture_alias(
            &cache,
            &alias,
            &sha256_bytes(b"authorized fixture"),
            "linked-fixture",
        )
        .expect_err("linked fixture alias must be rejected");
        assert!(error.contains("linked output"), "{error}");
        assert_eq!(
            fs::read(&outside).expect("read outside target"),
            b"outside must stay unchanged"
        );
        let _ = fs::remove_file(alias);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn commit_lock_waits_for_the_current_publisher() {
        let root = isolated_quality_test_dir("gifp-quality-commit-lock");
        fs::create_dir_all(&root).expect("create commit lock directory");
        let report = root.join("latest.json");
        let first = QualityCommitLock::acquire_with_timeout(&report, Duration::from_secs(1))
            .expect("acquire first commit lock");
        let (started_tx, started_rx) = mpsc::channel();
        let report_for_thread = report.clone();
        let waiter = thread::spawn(move || {
            started_tx.send(()).expect("signal lock waiter");
            let started = Instant::now();
            let lock =
                QualityCommitLock::acquire_with_timeout(&report_for_thread, Duration::from_secs(2))
                    .expect("waiter acquires released lock");
            let waited = started.elapsed();
            drop(lock);
            waited
        });
        started_rx.recv().expect("waiter started");
        thread::sleep(Duration::from_millis(75));
        assert!(!waiter.is_finished(), "second publisher bypassed the lock");
        drop(first);
        let waited = waiter.join().expect("join lock waiter");
        assert!(waited >= Duration::from_millis(50), "waited {waited:?}");
        assert_no_quality_transaction_files(&root);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quality_family_uses_a_canonical_parent_and_normalized_stem() {
        let root = isolated_quality_test_dir("gifp-quality-family");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create quality family directory");
        let canonical_json = nested.join("latest.json");
        let syntactic_json = nested.join(".").join("latest.JSON");
        let (_, canonical_digest) =
            quality_artifact_family_identity(&canonical_json).expect("canonical family");
        let (_, syntactic_digest) =
            quality_artifact_family_identity(&syntactic_json).expect("syntactic family");
        assert_eq!(canonical_digest, syntactic_digest);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quality_staging_names_record_creation_time_and_owner_pid() {
        let name = format!(".gifp-quality-42-{}-7.webp", process::id());
        assert_eq!(quality_staging_owner(&name), Some((42, process::id())));
        assert_eq!(quality_staging_owner(".gifp-quality-invalid.stage"), None);
    }

    fn write_synthetic_quality_bundle(
        run_root: &Path,
        run_id: &str,
        owner: &str,
    ) -> ArtifactBundleReference {
        let bundle_root = run_root.join("report-bundle");
        fs::create_dir(&bundle_root).expect("create synthetic immutable bundle");
        write_text_artifact(
            &bundle_root.join("report.json"),
            &json!({ "owner": owner, "run_id": run_id }).to_string(),
            "synthetic bundle JSON",
        )
        .expect("write synthetic bundle JSON");
        write_text_artifact(
            &bundle_root.join("report.csv"),
            &format!("run_id,owner\n{run_id},{owner}\n"),
            "synthetic bundle CSV",
        )
        .expect("write synthetic bundle CSV");
        write_text_artifact(
            &bundle_root.join("blind.html"),
            &format!("<html data-run-id=\"{run_id}\" data-owner=\"{owner}\"></html>"),
            "synthetic bundle HTML",
        )
        .expect("write synthetic bundle HTML");
        write_text_artifact(
            &bundle_root.join("build-provenance.json"),
            "{}\n",
            "synthetic build provenance",
        )
        .expect("write synthetic build provenance");
        finalize_artifact_bundle(&bundle_root, run_id).expect("seal synthetic immutable bundle")
    }

    fn assert_synthetic_quality_commit(commit: &Value) {
        let owner = commit["owner"].as_str().expect("committed owner");
        let run_id = commit["run_id"].as_str().expect("committed run id");
        let reference: ArtifactBundleReference =
            serde_json::from_value(commit["artifact_bundle"].clone())
                .expect("deserialize committed artifact bundle reference");
        assert_eq!(reference.run_id, run_id);
        verify_artifact_bundle(&reference).expect("verify committed immutable bundle");

        let root = Path::new(&reference.root_path);
        let artifact_path = |role: &str| {
            let entry = reference
                .artifacts
                .iter()
                .find(|entry| entry.role == role)
                .unwrap_or_else(|| panic!("bundle is missing {role}"));
            root.join(&entry.relative_path)
        };
        let bundled_report: Value = serde_json::from_slice(
            &fs::read(artifact_path("report_json")).expect("read bundled report JSON"),
        )
        .expect("parse bundled report JSON");
        assert_eq!(bundled_report["run_id"], run_id);
        assert_eq!(bundled_report["owner"], owner);
        let bundled_csv =
            fs::read_to_string(artifact_path("report_csv")).expect("read bundled report CSV");
        assert!(bundled_csv.contains(&format!("{run_id},{owner}")));
        let bundled_html =
            fs::read_to_string(artifact_path("blind_html")).expect("read bundled blind HTML");
        assert!(bundled_html.contains(run_id));
        assert!(bundled_html.contains(owner));
    }

    #[test]
    #[ignore = "helper invoked by the Quality Lab multi-process contract test"]
    fn multiprocess_quality_commit_child() {
        let Some(root) = env::var_os("GIFP_QUALITY_MULTIPROCESS_ROOT").map(PathBuf::from) else {
            return;
        };
        let owner = env::var("GIFP_QUALITY_MULTIPROCESS_OWNER").expect("Quality Lab child owner");
        fs::create_dir_all(&root).expect("create Quality Lab child root");
        let (run_id, run_root) =
            create_exclusive_run_root(&root, "same-revision", 42).expect("reserve child run root");

        let fixture_bytes = b"immutable fixture payload";
        let fixture_sha = sha256_bytes(fixture_bytes);
        let staged_fixture = root.join(format!(".fixture-{}.mkv", process::id()));
        fs::write(&staged_fixture, fixture_bytes).expect("write child fixture staging file");
        let cache_root = root.join("fixture-cache");
        fs::create_dir_all(&cache_root).expect("create child fixture cache");
        let cache_path = cache_root.join(format!("{fixture_sha}.mkv"));
        ensure_immutable_fixture_cache_entry(&staged_fixture, &cache_path, &fixture_sha)
            .expect("publish shared immutable fixture cache entry");
        let published_fixture = root.join("fixture.mkv");
        publish_fixture_alias(
            &cache_path,
            &published_fixture,
            &fixture_sha,
            "multiprocess-fixture",
        )
        .expect("publish shared fixture alias atomically");
        fs::remove_file(&staged_fixture).expect("remove child fixture staging file");
        let artifact_bundle = write_synthetic_quality_bundle(&run_root, &run_id, &owner);

        let ready = root.join(format!(".quality-ready-{}", process::id()));
        fs::write(&ready, owner.as_bytes()).expect("write child barrier marker");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let ready_count = fs::read_dir(&root)
                .expect("read child barrier directory")
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".quality-ready-")
                })
                .count();
            if ready_count >= 2 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "timed out at Quality Lab barrier"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let report = root.join("latest.json");
        let csv = root.join("latest.csv");
        let html = root.join("latest-blind.html");
        let _lock = QualityCommitLock::acquire_with_timeout(&report, Duration::from_secs(5))
            .expect("acquire child commit lock");
        let critical_marker = root.join(".quality-critical-section");
        let marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&critical_marker)
            .expect("commit lock must prevent overlapping critical sections");
        drop(marker);
        thread::sleep(Duration::from_millis(75));
        write_text_artifact(
            &csv,
            &format!("run_id,owner\n{run_id},{owner}\n"),
            "child CSV",
        )
        .expect("publish child CSV");
        thread::sleep(Duration::from_millis(50));
        write_text_artifact(
            &html,
            &format!("<html data-run-id=\"{run_id}\" data-owner=\"{owner}\"></html>"),
            "child HTML",
        )
        .expect("publish child HTML");
        thread::sleep(Duration::from_millis(50));
        write_text_artifact(
            &report,
            &json!({
                "owner": owner,
                "run_id": run_id,
                "artifact_bundle": artifact_bundle,
            })
            .to_string(),
            "child JSON commit point",
        )
        .expect("publish child JSON last");
        fs::remove_file(&critical_marker).expect("leave child critical section");
        println!("GIFP_QUALITY_CHILD_RUN_ID={run_id}");
    }

    #[test]
    #[ignore = "helper invoked by the Quality Lab abandoned-lock contract test"]
    fn abandoned_quality_commit_lock_child() {
        let Some(root) = env::var_os("GIFP_QUALITY_ABANDONED_LOCK_ROOT").map(PathBuf::from) else {
            return;
        };
        fs::create_dir_all(&root).expect("create abandoned-lock root");
        let report = root.join("latest.json");
        let _lock = QualityCommitLock::acquire_with_timeout(&report, Duration::from_secs(2))
            .expect("child acquires commit lock");
        fs::write(root.join("lock-acquired"), b"ready").expect("write lock marker");
        process::exit(23);
    }

    #[test]
    fn abandoned_process_commit_lock_is_recoverable() {
        let root = isolated_quality_test_dir("gifp-quality-abandoned-lock");
        fs::create_dir_all(&root).expect("create abandoned-lock test root");
        let output = Command::new(env::current_exe().expect("locate current Rust test binary"))
            .arg("--ignored")
            .arg("--exact")
            .arg("quality_lab::tests::abandoned_quality_commit_lock_child")
            .arg("--test-threads=1")
            .env("GIFP_QUALITY_ABANDONED_LOCK_ROOT", &root)
            .output()
            .expect("run abandoned-lock child");
        assert!(
            !output.status.success(),
            "child must exit without dropping lock"
        );
        assert!(root.join("lock-acquired").is_file());
        let report = root.join("latest.json");
        let recovered = QualityCommitLock::acquire_with_timeout(&report, Duration::from_secs(2))
            .expect("next process recovers abandoned commit lock");
        drop(recovered);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn two_os_processes_publish_coherent_quality_lab_commits() {
        let root = isolated_quality_test_dir("gifp-quality-multiprocess");
        fs::create_dir_all(&root).expect("create Quality Lab multi-process root");
        let (stop_reader_tx, stop_reader_rx) = mpsc::channel();
        let reader_root = root.clone();
        let reader = thread::spawn(move || {
            let latest = reader_root.join("latest.json");
            let mut complete_commits_seen = 0usize;
            loop {
                match fs::read(&latest) {
                    Ok(bytes) => {
                        let value: Value = serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                            panic!(
                                "concurrent reader observed a torn Quality Lab commit {}: {error}",
                                String::from_utf8_lossy(&bytes)
                            )
                        });
                        assert_synthetic_quality_commit(&value);
                        complete_commits_seen += 1;
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::NotFound
                            || error.raw_os_error() == Some(32) =>
                    {
                        // Windows can briefly report ERROR_SHARING_VIOLATION
                        // while ReplaceFileW swaps the complete commit point.
                        // A reader retries; it must never accept partial bytes.
                    }
                    Err(error) => panic!("concurrent reader failed to read latest.json: {error}"),
                }
                if stop_reader_rx.try_recv().is_ok() {
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
            complete_commits_seen
        });
        let test_binary = env::current_exe().expect("locate current Rust test binary");
        let spawn_child = |owner: &str| {
            Command::new(&test_binary)
                .arg("--ignored")
                .arg("--exact")
                .arg("quality_lab::tests::multiprocess_quality_commit_child")
                .arg("--nocapture")
                .arg("--test-threads=1")
                .env("GIFP_QUALITY_MULTIPROCESS_ROOT", &root)
                .env("GIFP_QUALITY_MULTIPROCESS_OWNER", owner)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("spawn Quality Lab child")
        };
        let first = spawn_child("first");
        let second = spawn_child("second");
        let first = first
            .wait_with_output()
            .expect("wait for first Quality Lab child");
        let second = second
            .wait_with_output()
            .expect("wait for second Quality Lab child");
        for output in [&first, &second] {
            assert!(
                output.status.success(),
                "child stdout:\n{}\nchild stderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        stop_reader_tx.send(()).expect("stop concurrent reader");
        assert!(
            reader.join().expect("join concurrent reader") > 0,
            "concurrent reader never observed a complete Quality Lab commit"
        );

        let report: Value = serde_json::from_slice(
            &fs::read(root.join("latest.json")).expect("read committed Quality Lab JSON"),
        )
        .expect("committed Quality Lab JSON is complete");
        assert_synthetic_quality_commit(&report);
        let owner = report["owner"].as_str().expect("committed owner");
        let run_id = report["run_id"].as_str().expect("committed run id");
        assert!(matches!(owner, "first" | "second"));
        let csv = fs::read_to_string(root.join("latest.csv")).expect("read flat CSV mirror");
        assert!(csv.contains(&format!("{run_id},{owner}")), "{csv}");
        let html =
            fs::read_to_string(root.join("latest-blind.html")).expect("read flat HTML mirror");
        assert!(html.contains(run_id), "{html}");
        assert!(html.contains(owner), "{html}");
        assert!(!root.join(".quality-critical-section").exists());
        assert_eq!(
            fs::read_dir(root.join("runs"))
                .expect("read exclusive run roots")
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .count(),
            2
        );
        assert_eq!(
            fs::read(root.join("fixture.mkv")).expect("read shared published fixture"),
            b"immutable fixture payload"
        );
        assert_no_quality_transaction_files(&root);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "manual fixture generation"]
    fn manual_prepare_quality_fixtures() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root");
        let manifest = workspace.join("bench/corpus-manifest.json");
        run_cli(vec![
            "prepare".to_string(),
            "--manifest".to_string(),
            manifest.to_string_lossy().to_string(),
        ])
        .expect("quality fixtures should prepare successfully");
    }

    #[test]
    #[ignore = "manual 224-encode quality run"]
    fn manual_full_quality_lab() {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root");
        let manifest = workspace.join("bench/corpus-manifest.json");
        let output = env::var_os("GIFP_QUALITY_OUTPUT")
            .map(PathBuf::from)
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    workspace.join(path)
                }
            })
            .unwrap_or_else(|| workspace.join("tmp/quality-lab/latest.json"));
        let mut args = vec![
            "run".to_string(),
            "--manifest".to_string(),
            manifest.to_string_lossy().to_string(),
            "--output".to_string(),
            output.to_string_lossy().to_string(),
        ];
        if let Some(fixtures) = env::var_os("GIFP_QUALITY_FIXTURES") {
            args.push("--fixtures".to_string());
            args.push(fixtures.to_string_lossy().to_string());
        }
        run_cli(args).expect("full quality lab should pass all correctness gates");
    }
}
