import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSchemaPath = resolve(workspaceRoot, "bench", "quality-report.schema.json");

const HELP = `GIFP Quality Report verifier

Usage:
  node scripts/verify-quality-report.mjs --report PATH [--schema PATH] [--require-first-tier-quality]

Checks the report's top-level v9 schema contract, first-tier quality structure,
immutable bundle manifest,
  run identity, Git provenance, canonical fixture/toolchain identity, file sizes, SHA-256 hashes,
and full commit-point binding to the non-circular bundled report snapshot. The
optional strict flag additionally requires the sealed same-size Best quality
gate to pass.
`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readJsonSnapshot(path, label) {
  try {
    const bytes = readFileSync(path);
    return {
      value: JSON.parse(bytes.toString("utf8")),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length,
    };
  } catch (error) {
    throw new Error(`Failed to read ${label} ${path}: ${error.message}`);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function nodeNativePath(path) {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

function assertTopLevelSchemaContract(report, schema, label) {
  invariant(report && typeof report === "object" && !Array.isArray(report), `${label} is not an object`);
  const properties = schema?.properties;
  invariant(properties && typeof properties === "object", "Quality report schema has no properties object");
  const expectedVersion = properties.schema_version?.const;
  invariant(Number.isInteger(expectedVersion), "Quality report schema has no integer version const");
  invariant(
    report.schema_version === expectedVersion,
    `${label} schema_version ${report.schema_version} does not match schema v${expectedVersion}`,
  );
  for (const field of schema.required ?? []) {
    invariant(Object.hasOwn(report, field), `${label} is missing required field '${field}'`);
  }
  if (schema.additionalProperties === false) {
    for (const field of Object.keys(report)) {
      invariant(Object.hasOwn(properties, field), `${label} contains unknown field '${field}'`);
    }
  }
}

function assertGitProvenance(report, label) {
  invariant(
    report.git_commit === null || (typeof report.git_commit === "string" && /^[0-9a-f]{40}$/.test(report.git_commit)),
    `${label}.git_commit is not null or a lowercase 40-character commit SHA`,
  );
  invariant(
    report.git_dirty === null || typeof report.git_dirty === "boolean",
    `${label}.git_dirty is not null or boolean`,
  );
}

function assertBuildProvenanceSnapshot(snapshot, label) {
  invariant(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot), `${label} is not an object`);
  assertNoUnknownKeys(snapshot, new Set(["commit", "dirty", "tree_hash"]), label);
  invariant(
    snapshot.commit === null || (typeof snapshot.commit === "string" && /^[0-9a-f]{40}$/.test(snapshot.commit)),
    `${label}.commit is not null or a lowercase 40-character commit SHA`,
  );
  invariant(snapshot.dirty === null || typeof snapshot.dirty === "boolean", `${label}.dirty is not null or boolean`);
  invariant(
    snapshot.tree_hash === null || (typeof snapshot.tree_hash === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(snapshot.tree_hash)),
    `${label}.tree_hash is not null or a full Git object hash`,
  );
}

function assertBuildProvenance(evidence, report, label) {
  invariant(evidence && typeof evidence === "object" && !Array.isArray(evidence), `${label} is not an object`);
  assertNoUnknownKeys(evidence, new Set([
    "schema_version",
    "contract_id",
    "run_id",
    "executor_start_sha256",
    "executor_end_sha256",
    "embedded_build",
    "runtime_start",
    "runtime_end",
    "passed",
    "violations",
  ]), label);
  invariant(evidence.schema_version === 1, `${label}.schema_version is unsupported`);
  invariant(evidence.contract_id === "gifp.build_provenance.v1", `${label}.contract_id is unsupported`);
  invariant(evidence.run_id === report.run_id, `${label}.run_id does not match the report`);
  invariant(/^[0-9a-f]{64}$/.test(evidence.executor_start_sha256), `${label}.executor_start_sha256 is invalid`);
  invariant(/^[0-9a-f]{64}$/.test(evidence.executor_end_sha256), `${label}.executor_end_sha256 is invalid`);
  invariant(
    evidence.embedded_build && typeof evidence.embedded_build === "object" && !Array.isArray(evidence.embedded_build),
    `${label}.embedded_build is not an object`,
  );
  assertNoUnknownKeys(evidence.embedded_build, new Set(["git_commit", "git_dirty", "git_tree_hash"]), `${label}.embedded_build`);
  invariant(
    evidence.embedded_build.git_commit === null
      || (typeof evidence.embedded_build.git_commit === "string" && /^[0-9a-f]{40}$/.test(evidence.embedded_build.git_commit)),
    `${label}.embedded_build.git_commit is invalid`,
  );
  invariant(
    evidence.embedded_build.git_dirty === null || typeof evidence.embedded_build.git_dirty === "boolean",
    `${label}.embedded_build.git_dirty is invalid`,
  );
  invariant(
    evidence.embedded_build.git_tree_hash === null
      || (typeof evidence.embedded_build.git_tree_hash === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(evidence.embedded_build.git_tree_hash)),
    `${label}.embedded_build.git_tree_hash is invalid`,
  );
  assertBuildProvenanceSnapshot(evidence.runtime_start, `${label}.runtime_start`);
  assertBuildProvenanceSnapshot(evidence.runtime_end, `${label}.runtime_end`);
  invariant(typeof evidence.passed === "boolean", `${label}.passed is not boolean`);
  invariant(
    Array.isArray(evidence.violations) && evidence.violations.every((value) => typeof value === "string" && value.length > 0),
    `${label}.violations is invalid`,
  );
  invariant(
    evidence.passed === (evidence.violations.length === 0),
    `${label}.passed disagrees with violations`,
  );

  const expectedPassed = evidence.executor_start_sha256 === evidence.executor_end_sha256
    && evidence.embedded_build.git_dirty === false
    && evidence.runtime_start.dirty === false
    && evidence.runtime_end.dirty === false
    && typeof evidence.embedded_build.git_commit === "string"
    && evidence.embedded_build.git_commit === evidence.runtime_start.commit
    && evidence.embedded_build.git_commit === evidence.runtime_end.commit
    && evidence.embedded_build.git_commit === report.git_commit
    && typeof evidence.embedded_build.git_tree_hash === "string"
    && evidence.embedded_build.git_tree_hash === evidence.runtime_start.tree_hash
    && evidence.embedded_build.git_tree_hash === evidence.runtime_end.tree_hash
    && report.git_dirty === false;
  invariant(evidence.passed === expectedPassed, `${label}.passed disagrees with sealed compile/runtime facts`);
  invariant(
    report.best_quality_acceptance?.provenance_passed === expectedPassed,
    `${label} disagrees with best_quality_acceptance.provenance_passed`,
  );
  return {
    schema_version: evidence.schema_version,
    contract_id: evidence.contract_id,
    executor_start_sha256: evidence.executor_start_sha256,
    executor_end_sha256: evidence.executor_end_sha256,
    embedded_git_commit: evidence.embedded_build.git_commit,
    embedded_git_dirty: evidence.embedded_build.git_dirty,
    embedded_git_tree_hash: evidence.embedded_build.git_tree_hash,
    runtime_start_commit: evidence.runtime_start.commit,
    runtime_start_dirty: evidence.runtime_start.dirty,
    runtime_start_tree_hash: evidence.runtime_start.tree_hash,
    runtime_end_commit: evidence.runtime_end.commit,
    runtime_end_dirty: evidence.runtime_end.dirty,
    runtime_end_tree_hash: evidence.runtime_end.tree_hash,
    passed: expectedPassed,
    violations: evidence.violations,
  };
}

const canonicalCorpusManifestPath = resolve(workspaceRoot, "bench", "corpus-manifest.json");

function rustSerializedCorpusManifest(manifest) {
  const result = {
    ...(manifest.$schema == null ? {} : { $schema: manifest.$schema }),
    schema_version: manifest.schema_version,
    corpus_id: manifest.corpus_id,
    description: manifest.description ?? "",
    fixture_root: manifest.fixture_root,
    canonical_fixture_identity: {
      contract_id: manifest.canonical_fixture_identity.contract_id,
      status: manifest.canonical_fixture_identity.status,
      generator_ffmpeg_sha256: manifest.canonical_fixture_identity.generator_ffmpeg_sha256,
      generator_ffprobe_sha256: manifest.canonical_fixture_identity.generator_ffprobe_sha256,
      reviewed_runtime_manifest_path: manifest.canonical_fixture_identity.reviewed_runtime_manifest_path,
      reviewed_runtime_manifest_sha256: manifest.canonical_fixture_identity.reviewed_runtime_manifest_sha256,
    },
    ...(manifest.coverage == null ? {} : {
      coverage: {
        minimum_total: manifest.coverage.minimum_total,
        minimum_per_category: manifest.coverage.minimum_per_category,
        required_categories: manifest.coverage.required_categories,
        required_tags: manifest.coverage.required_tags ?? [],
      },
    }),
    ...(manifest.performance_budget == null ? {} : {
      performance_budget: {
        profile_scope: manifest.performance_budget.profile_scope,
        required_build_profile: manifest.performance_budget.required_build_profile,
        minimum_memory_coverage: manifest.performance_budget.minimum_memory_coverage,
        p95_encode_wall_elapsed_ms: manifest.performance_budget.p95_encode_wall_elapsed_ms,
        max_encode_wall_elapsed_ms: manifest.performance_budget.max_encode_wall_elapsed_ms,
        p95_peak_tree_rss_bytes: manifest.performance_budget.p95_peak_tree_rss_bytes,
        max_peak_tree_rss_bytes: manifest.performance_budget.max_peak_tree_rss_bytes,
      },
    }),
    fixtures: manifest.fixtures.map((fixture) => ({
      id: fixture.id,
      category: fixture.category,
      file: fixture.file,
      expected_source_sha256: fixture.expected_source_sha256 ?? null,
      duration_seconds: fixture.duration_seconds,
      tags: fixture.tags ?? [],
      generator: {
        kind: fixture.generator.kind,
        input: fixture.generator.input,
        ...(fixture.generator.source_sha256 == null ? {} : { source_sha256: fixture.generator.source_sha256 }),
        ...(fixture.generator.authorization == null ? {} : { authorization: fixture.generator.authorization }),
        video_filter: fixture.generator.video_filter ?? null,
        pixel_format: fixture.generator.pixel_format ?? "yuv444p",
      },
    })),
    profiles: manifest.profiles.map((profile) => ({
      id: profile.id,
      generation_mode: profile.generation_mode,
      ...(profile.match_target_profile_id == null ? {} : { match_target_profile_id: profile.match_target_profile_id }),
      ...(profile.target_constraint == null ? {} : { target_constraint: profile.target_constraint }),
      ...(profile.target_size_scale == null ? {} : { target_size_scale: profile.target_size_scale }),
      encoder: profile.encoder,
      width: profile.width,
      fps: profile.fps,
      colors: profile.colors,
      dither: profile.dither,
      optimize_level: profile.optimize_level,
      lossy: profile.lossy,
      bayer_scale: profile.bayer_scale,
      alpha_threshold: profile.alpha_threshold,
      filter_style: profile.filter_style,
      perceptual_focus: profile.perceptual_focus,
      allow_experimental: profile.allow_experimental ?? false,
    })),
  };
  return result;
}

const bestMetricSpecs = new Map([
  ["vmaf_neg_mean", { direction: "higher_is_better", tieAbsolute: 0.25, tieRelative: 0, severeAbsolute: 2, severeRelative: 0 }],
  ["vmaf_neg_p05", { direction: "higher_is_better", tieAbsolute: 0.5, tieRelative: 0, severeAbsolute: 3, severeRelative: 0 }],
  ["cambi_mean", { direction: "lower_is_better", tieAbsolute: 0.02, tieRelative: 0, severeAbsolute: 0.1, severeRelative: 0 }],
  ["mean_oklab_error", { direction: "lower_is_better", tieAbsolute: 0.0005, tieRelative: 0, severeAbsolute: 0.003, severeRelative: 0 }],
  ["edge_error", { direction: "lower_is_better", tieAbsolute: 0.0002, tieRelative: 0.02, severeAbsolute: 0.005, severeRelative: 0.1 }],
  ["static_region_temporal_residual", { direction: "lower_is_better", tieAbsolute: 0.00005, tieRelative: 0, severeAbsolute: 0.0002, severeRelative: 0 }],
  ["alpha_coverage_error", { direction: "lower_is_better", tieAbsolute: 0.001, tieRelative: 0, severeAbsolute: 0.01, severeRelative: 0 }],
  ["alpha_mean_absolute_error", { direction: "lower_is_better", tieAbsolute: 0.001, tieRelative: 0, severeAbsolute: 0.01, severeRelative: 0 }],
  ["loop_seam_excess_oklab", { direction: "lower_is_better", tieAbsolute: 0.001, tieRelative: 0, severeAbsolute: 0.005, severeRelative: 0 }],
]);
const bestMetricIds = new Set(bestMetricSpecs.keys());

const bestQualityKeys = Object.freeze({
  acceptance: new Set([
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
  ]),
  slice: new Set([
    "category",
    "expected_pair_count",
    "eligible_pair_count",
    "pair_coverage",
    "metrics",
    "passed",
  ]),
  summary: new Set([
    "metric_id",
    "direction",
    "applicable_pair_count",
    "win_count",
    "tie_count",
    "loss_count",
    "win_rate",
    "loss_rate",
    "decisive_count",
    "decisive_win_rate",
    "mean_quality_improvement",
    "mean_quality_improvement_in_tie_units",
    "minimum_quality_improvement",
    "p05_quality_improvement",
    "median_quality_improvement",
    "p95_quality_improvement",
    "maximum_quality_improvement",
    "severe_regression_count",
    "passed",
  ]),
  pair: new Set([
    "fixture_id",
    "category",
    "candidate_size_bytes",
    "reference_size_bytes",
    "size_delta_percent",
    "candidate_output_sha256",
    "reference_output_sha256",
    "metrics",
  ]),
  comparison: new Set([
    "metric_id",
    "direction",
    "candidate_value",
    "reference_value",
    "quality_improvement",
    "quality_improvement_in_tie_units",
    "tie_tolerance",
    "severe_regression_tolerance",
    "outcome",
    "severe_regression",
  ]),
  omission: new Set(["fixture_id", "category", "reason"]),
});

function assertNoUnknownKeys(object, allowedKeys, label) {
  for (const field of Object.keys(object)) {
    invariant(allowedKeys.has(field), `${label} contains unknown field '${field}'`);
  }
}

function nearlyEqual(actual, expected) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= 1e-12 + 1e-10 * scale;
}

function assertRateEquals(actual, numerator, denominator, label) {
  if (denominator === 0) {
    invariant(actual === null, `${label} must be null when its denominator is zero`);
  } else {
    invariant(finiteNumber(actual) && nearlyEqual(actual, numerator / denominator), `${label} is inconsistent with its counts`);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nullableRate(value) {
  return value === null || (finiteNumber(value) && value >= 0 && value <= 1);
}

function expectedBestMetricSummaryPass(metric, overallGate) {
  if (metric.applicable_pair_count === 0) return !overallGate;
  if (metric.severe_regression_count > 0) return false;
  if (overallGate) {
    switch (metric.metric_id) {
      case "vmaf_neg_mean":
        return metric.win_rate >= 0.6
          && metric.loss_rate <= 0.1
          && metric.mean_quality_improvement >= 0.5;
      case "vmaf_neg_p05":
        return metric.loss_rate <= 0.25
          && metric.mean_quality_improvement >= -0.5;
      default:
        return metric.loss_rate <= 0.25
          && metric.mean_quality_improvement_in_tie_units >= 0;
    }
  }
  switch (metric.metric_id) {
    case "vmaf_neg_mean":
      return metric.loss_rate <= 0.25
        && metric.mean_quality_improvement >= -0.25;
    case "vmaf_neg_p05":
      return metric.loss_rate <= 0.25;
    default:
      return metric.loss_rate <= 0.25
        && metric.mean_quality_improvement_in_tie_units >= -0.5;
  }
}

function assertBestMetricSummary(metric, label, overallGate) {
  invariant(metric && typeof metric === "object" && !Array.isArray(metric), `${label} is not an object`);
  assertNoUnknownKeys(metric, bestQualityKeys.summary, label);
  invariant(bestMetricIds.has(metric.metric_id), `${label} has unknown metric_id '${metric.metric_id}'`);
  invariant(metric.direction === bestMetricSpecs.get(metric.metric_id).direction, `${label}.direction does not match metric_id`);
  for (const field of [
    "applicable_pair_count",
    "win_count",
    "tie_count",
    "loss_count",
    "decisive_count",
    "severe_regression_count",
  ]) {
    invariant(nonnegativeInteger(metric[field]), `${label}.${field} is not a nonnegative integer`);
  }
  invariant(
    metric.win_count + metric.tie_count + metric.loss_count === metric.applicable_pair_count,
    `${label} outcome counts do not equal applicable_pair_count`,
  );
  invariant(metric.win_count + metric.loss_count === metric.decisive_count, `${label} decisive_count is inconsistent`);
  invariant(metric.severe_regression_count <= metric.loss_count, `${label} severe regressions exceed losses`);
  for (const field of ["win_rate", "loss_rate", "decisive_win_rate"]) {
    invariant(nullableRate(metric[field]), `${label}.${field} is not a nullable rate`);
  }
  assertRateEquals(metric.win_rate, metric.win_count, metric.applicable_pair_count, `${label}.win_rate`);
  assertRateEquals(metric.loss_rate, metric.loss_count, metric.applicable_pair_count, `${label}.loss_rate`);
  assertRateEquals(metric.decisive_win_rate, metric.win_count, metric.decisive_count, `${label}.decisive_win_rate`);
  for (const field of [
    "mean_quality_improvement",
    "mean_quality_improvement_in_tie_units",
    "minimum_quality_improvement",
    "p05_quality_improvement",
    "median_quality_improvement",
    "p95_quality_improvement",
    "maximum_quality_improvement",
  ]) {
    invariant(metric[field] === null || finiteNumber(metric[field]), `${label}.${field} is not nullable finite`);
  }
  const distribution = [
    metric.minimum_quality_improvement,
    metric.p05_quality_improvement,
    metric.median_quality_improvement,
    metric.p95_quality_improvement,
    metric.maximum_quality_improvement,
  ];
  if (metric.applicable_pair_count === 0) {
    invariant(metric.mean_quality_improvement === null, `${label} has a mean without applicable pairs`);
    invariant(metric.mean_quality_improvement_in_tie_units === null, `${label} has a tie-unit mean without applicable pairs`);
    invariant(distribution.every((value) => value === null), `${label} has a distribution without applicable pairs`);
  } else {
    invariant(finiteNumber(metric.mean_quality_improvement), `${label} is missing mean_quality_improvement`);
    invariant(finiteNumber(metric.mean_quality_improvement_in_tie_units), `${label} is missing mean_quality_improvement_in_tie_units`);
    invariant(distribution.every(finiteNumber), `${label} is missing a quality distribution`);
    invariant(distribution.every((value, index) => index === 0 || distribution[index - 1] <= value), `${label} quality distribution is not ordered`);
    invariant(
      metric.mean_quality_improvement >= metric.minimum_quality_improvement
        && metric.mean_quality_improvement <= metric.maximum_quality_improvement,
      `${label} mean lies outside its distribution`,
    );
  }
  invariant(typeof metric.passed === "boolean", `${label}.passed is not boolean`);
  invariant(
    metric.passed === expectedBestMetricSummaryPass(metric, overallGate),
    `${label}.passed is inconsistent with the v1 acceptance policy`,
  );
}

function assertBestQualitySlice(slice, label, overallGate) {
  invariant(slice && typeof slice === "object" && !Array.isArray(slice), `${label} is not an object`);
  assertNoUnknownKeys(slice, bestQualityKeys.slice, label);
  invariant(typeof slice.category === "string" && slice.category.length > 0, `${label}.category is empty`);
  invariant(nonnegativeInteger(slice.expected_pair_count), `${label}.expected_pair_count is invalid`);
  invariant(nonnegativeInteger(slice.eligible_pair_count), `${label}.eligible_pair_count is invalid`);
  invariant(slice.eligible_pair_count <= slice.expected_pair_count, `${label} has more eligible than expected pairs`);
  invariant(nullableRate(slice.pair_coverage), `${label}.pair_coverage is not a nullable rate`);
  assertRateEquals(slice.pair_coverage, slice.eligible_pair_count, slice.expected_pair_count, `${label}.pair_coverage`);
  invariant(Array.isArray(slice.metrics) && slice.metrics.length === bestMetricIds.size, `${label} must contain all quality metrics`);
  const ids = new Set();
  for (const [index, metric] of slice.metrics.entries()) {
    assertBestMetricSummary(metric, `${label}.metrics[${index}]`, overallGate);
    invariant(!ids.has(metric.metric_id), `${label} repeats metric '${metric.metric_id}'`);
    ids.add(metric.metric_id);
  }
  invariant(typeof slice.passed === "boolean", `${label}.passed is not boolean`);
  const expectedPassed = slice.expected_pair_count > 0
    && slice.eligible_pair_count === slice.expected_pair_count
    && slice.metrics.every((metric) => metric.passed);
  invariant(slice.passed === expectedPassed, `${label}.passed is inconsistent with its coverage and metric gates`);
}

function assertBestMetricComparison(metric, label) {
  invariant(metric && typeof metric === "object" && !Array.isArray(metric), `${label} is not an object`);
  assertNoUnknownKeys(metric, bestQualityKeys.comparison, label);
  invariant(bestMetricIds.has(metric.metric_id), `${label} has unknown metric_id '${metric.metric_id}'`);
  const spec = bestMetricSpecs.get(metric.metric_id);
  invariant(metric.direction === spec.direction, `${label}.direction does not match metric_id`);
  for (const field of [
    "candidate_value",
    "reference_value",
    "quality_improvement",
    "quality_improvement_in_tie_units",
    "tie_tolerance",
    "severe_regression_tolerance",
  ]) {
    invariant(finiteNumber(metric[field]), `${label}.${field} is not finite`);
  }
  invariant(metric.tie_tolerance > 0, `${label}.tie_tolerance must be positive`);
  invariant(metric.severe_regression_tolerance >= metric.tie_tolerance, `${label} severe tolerance is below tie tolerance`);
  invariant(["win", "tie", "loss"].includes(metric.outcome), `${label} has invalid outcome`);
  invariant(typeof metric.severe_regression === "boolean", `${label}.severe_regression is not boolean`);
  const expectedTieTolerance = spec.tieAbsolute + Math.abs(metric.reference_value) * spec.tieRelative;
  const expectedSevereTolerance = Math.max(
    expectedTieTolerance,
    spec.severeAbsolute + Math.abs(metric.reference_value) * spec.severeRelative,
  );
  invariant(nearlyEqual(metric.tie_tolerance, expectedTieTolerance), `${label}.tie_tolerance does not match the v1 metric policy`);
  invariant(
    nearlyEqual(metric.severe_regression_tolerance, expectedSevereTolerance),
    `${label}.severe_regression_tolerance does not match the v1 metric policy`,
  );
  const expectedImprovement = metric.direction === "higher_is_better"
    ? metric.candidate_value - metric.reference_value
    : metric.reference_value - metric.candidate_value;
  invariant(
    nearlyEqual(metric.quality_improvement, expectedImprovement),
    `${label}.quality_improvement is inconsistent with direction and values`,
  );
  const expectedTieUnits = expectedImprovement / Math.max(expectedTieTolerance, Number.EPSILON);
  invariant(
    nearlyEqual(metric.quality_improvement_in_tie_units, expectedTieUnits),
    `${label}.quality_improvement_in_tie_units is inconsistent`,
  );
  const expectedOutcome = expectedImprovement > expectedTieTolerance
    ? "win"
    : expectedImprovement < -expectedTieTolerance
      ? "loss"
      : "tie";
  invariant(metric.outcome === expectedOutcome, `${label}.outcome is inconsistent with the tie tolerance`);
  const expectedSevereRegression = expectedImprovement <= -expectedSevereTolerance;
  invariant(
    metric.severe_regression === expectedSevereRegression,
    `${label}.severe_regression is inconsistent with the severe tolerance`,
  );
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function expectedMetricSummary(pairs, metricId) {
  const comparisons = pairs
    .map((pair) => pair.metrics.find((metric) => metric.metric_id === metricId))
    .filter((metric) => metric !== undefined);
  const improvements = comparisons.map((metric) => metric.quality_improvement);
  const winCount = comparisons.filter((metric) => metric.outcome === "win").length;
  const tieCount = comparisons.filter((metric) => metric.outcome === "tie").length;
  const lossCount = comparisons.filter((metric) => metric.outcome === "loss").length;
  const decisiveCount = winCount + lossCount;
  return {
    applicable_pair_count: comparisons.length,
    win_count: winCount,
    tie_count: tieCount,
    loss_count: lossCount,
    win_rate: comparisons.length > 0 ? winCount / comparisons.length : null,
    loss_rate: comparisons.length > 0 ? lossCount / comparisons.length : null,
    decisive_count: decisiveCount,
    decisive_win_rate: decisiveCount > 0 ? winCount / decisiveCount : null,
    mean_quality_improvement: mean(improvements),
    mean_quality_improvement_in_tie_units: mean(
      comparisons.map((metric) => metric.quality_improvement_in_tie_units),
    ),
    minimum_quality_improvement: improvements.length > 0 ? Math.min(...improvements) : null,
    p05_quality_improvement: nearestRank(improvements, 0.05),
    median_quality_improvement: nearestRank(improvements, 0.5),
    p95_quality_improvement: nearestRank(improvements, 0.95),
    maximum_quality_improvement: improvements.length > 0 ? Math.max(...improvements) : null,
    severe_regression_count: comparisons.filter((metric) => metric.severe_regression).length,
  };
}

function assertSummaryValue(actual, expected, label) {
  if (expected === null) {
    invariant(actual === null, `${label} differs from the paired comparisons`);
  } else if (Number.isInteger(expected) && Number.isInteger(actual)) {
    invariant(actual === expected, `${label} differs from the paired comparisons`);
  } else {
    invariant(finiteNumber(actual) && nearlyEqual(actual, expected), `${label} differs from the paired comparisons`);
  }
}

function assertSliceMatchesPairs(slice, pairs, label) {
  invariant(slice.eligible_pair_count === pairs.length, `${label}.eligible_pair_count differs from its pairs`);
  for (const metric of slice.metrics) {
    const expected = expectedMetricSummary(pairs, metric.metric_id);
    for (const field of Object.keys(expected)) {
      assertSummaryValue(metric[field], expected[field], `${label}.${metric.metric_id}.${field}`);
    }
  }
}

function assertBestQualityAcceptanceContract(gate, label) {
  invariant(gate && typeof gate === "object" && !Array.isArray(gate), `${label} is not an object`);
  assertNoUnknownKeys(gate, bestQualityKeys.acceptance, label);
  invariant(gate.acceptance_id === "gifp.best_same_size.first_tier.v1", `${label} has unsupported acceptance_id`);
  invariant(typeof gate.corpus_id === "string" && gate.corpus_id.length > 0, `${label}.corpus_id is empty`);
  invariant(/^[0-9a-f]{64}$/.test(gate.corpus_manifest_sha256), `${label}.corpus_manifest_sha256 is invalid`);
  invariant(typeof gate.canonical_corpus_passed === "boolean", `${label}.canonical_corpus_passed is not boolean`);
  invariant(
    typeof gate.canonical_fixture_identity_passed === "boolean",
    `${label}.canonical_fixture_identity_passed is not boolean`,
  );
  for (const field of ["applicable", "provenance_passed", "passed"]) {
    invariant(typeof gate[field] === "boolean", `${label}.${field} is not boolean`);
  }
  invariant(gate.candidate_profile_id === null || (typeof gate.candidate_profile_id === "string" && gate.candidate_profile_id.length > 0), `${label}.candidate_profile_id is invalid`);
  invariant(gate.reference_profile_id === null || (typeof gate.reference_profile_id === "string" && gate.reference_profile_id.length > 0), `${label}.reference_profile_id is invalid`);
  invariant(
    gate.applicable === (gate.candidate_profile_id !== null && gate.reference_profile_id !== null),
    `${label}.applicable is inconsistent with its profile pair`,
  );
  invariant(gate.maximum_size_delta_percent === 5, `${label}.maximum_size_delta_percent does not match v1`);
  invariant(gate.minimum_pair_count === 28, `${label}.minimum_pair_count does not match v1`);
  invariant(gate.minimum_category_count === 7, `${label}.minimum_category_count does not match v1`);
  invariant(gate.required_pair_coverage === 1, `${label}.required_pair_coverage does not match v1`);
  invariant(gate.required_vmaf_win_rate === 0.6, `${label}.required_vmaf_win_rate does not match v1`);
  for (const field of ["expected_pair_count", "eligible_pair_count", "omitted_pair_count"]) {
    invariant(nonnegativeInteger(gate[field]), `${label}.${field} is invalid`);
  }
  invariant(gate.eligible_pair_count + gate.omitted_pair_count === gate.expected_pair_count, `${label} pair counts are inconsistent`);
  invariant(nullableRate(gate.pair_coverage), `${label}.pair_coverage is not a nullable rate`);
  assertRateEquals(gate.pair_coverage, gate.eligible_pair_count, gate.expected_pair_count, `${label}.pair_coverage`);
  assertBestQualitySlice(gate.overall, `${label}.overall`, true);
  invariant(gate.overall.category === "all", `${label}.overall category is not 'all'`);
  invariant(gate.overall.expected_pair_count === gate.expected_pair_count, `${label}.overall expected count differs`);
  invariant(gate.overall.eligible_pair_count === gate.eligible_pair_count, `${label}.overall eligible count differs`);
  invariant(Array.isArray(gate.categories), `${label}.categories is not an array`);
  const categoryIds = new Set();
  for (const [index, category] of gate.categories.entries()) {
    assertBestQualitySlice(category, `${label}.categories[${index}]`, false);
    invariant(category.category !== "all", `${label}.categories[${index}] uses reserved category 'all'`);
    invariant(!categoryIds.has(category.category), `${label} repeats category '${category.category}'`);
    categoryIds.add(category.category);
  }
  invariant(gate.categories.reduce((sum, category) => sum + category.expected_pair_count, 0) === gate.expected_pair_count, `${label} category expected counts differ`);
  invariant(gate.categories.reduce((sum, category) => sum + category.eligible_pair_count, 0) === gate.eligible_pair_count, `${label} category eligible counts differ`);
  invariant(Array.isArray(gate.pairs) && gate.pairs.length === gate.eligible_pair_count, `${label}.pairs length is inconsistent`);
  const fixtureIds = new Set();
  for (const [index, pair] of gate.pairs.entries()) {
    const pairLabel = `${label}.pairs[${index}]`;
    invariant(pair && typeof pair === "object" && !Array.isArray(pair), `${pairLabel} is not an object`);
    assertNoUnknownKeys(pair, bestQualityKeys.pair, pairLabel);
    invariant(typeof pair.fixture_id === "string" && pair.fixture_id.length > 0, `${pairLabel}.fixture_id is empty`);
    invariant(typeof pair.category === "string" && pair.category.length > 0, `${pairLabel}.category is empty`);
    invariant(!fixtureIds.has(pair.fixture_id), `${label} repeats fixture_id '${pair.fixture_id}'`);
    fixtureIds.add(pair.fixture_id);
    invariant(categoryIds.has(pair.category), `${pairLabel}.category has no matching category slice`);
    invariant(Number.isSafeInteger(pair.candidate_size_bytes) && pair.candidate_size_bytes > 0, `${pairLabel}.candidate_size_bytes is invalid`);
    invariant(Number.isSafeInteger(pair.reference_size_bytes) && pair.reference_size_bytes > 0, `${pairLabel}.reference_size_bytes is invalid`);
    invariant(finiteNumber(pair.size_delta_percent) && pair.size_delta_percent >= 0 && pair.size_delta_percent <= gate.maximum_size_delta_percent, `${pairLabel}.size_delta_percent is invalid`);
    const expectedSizeDelta = Math.abs(pair.candidate_size_bytes - pair.reference_size_bytes)
      / ((pair.candidate_size_bytes + pair.reference_size_bytes) / 2) * 100;
    invariant(nearlyEqual(pair.size_delta_percent, expectedSizeDelta), `${pairLabel}.size_delta_percent differs from its byte sizes`);
    invariant(/^[0-9a-f]{64}$/.test(pair.candidate_output_sha256), `${pairLabel}.candidate_output_sha256 is invalid`);
    invariant(/^[0-9a-f]{64}$/.test(pair.reference_output_sha256), `${pairLabel}.reference_output_sha256 is invalid`);
    invariant(
      Array.isArray(pair.metrics) && pair.metrics.length >= 4 && pair.metrics.length <= bestMetricIds.size,
      `${pairLabel}.metrics is incomplete`,
    );
    const ids = new Set();
    for (const [metricIndex, metric] of pair.metrics.entries()) {
      assertBestMetricComparison(metric, `${pairLabel}.metrics[${metricIndex}]`);
      invariant(!ids.has(metric.metric_id), `${pairLabel} repeats metric '${metric.metric_id}'`);
      ids.add(metric.metric_id);
    }
  }
  invariant(Array.isArray(gate.omissions) && gate.omissions.length === gate.omitted_pair_count, `${label}.omissions length is inconsistent`);
  for (const [index, omission] of gate.omissions.entries()) {
    const omissionLabel = `${label}.omissions[${index}]`;
    invariant(omission && typeof omission === "object" && !Array.isArray(omission), `${omissionLabel} is not an object`);
    assertNoUnknownKeys(omission, bestQualityKeys.omission, omissionLabel);
    invariant(typeof omission.fixture_id === "string" && omission.fixture_id.length > 0, `${omissionLabel}.fixture_id is empty`);
    invariant(typeof omission.category === "string" && omission.category.length > 0, `${omissionLabel}.category is empty`);
    invariant(typeof omission.reason === "string" && omission.reason.length > 0, `${omissionLabel}.reason is empty`);
    invariant(!fixtureIds.has(omission.fixture_id), `${label} repeats fixture_id '${omission.fixture_id}'`);
    fixtureIds.add(omission.fixture_id);
    invariant(categoryIds.has(omission.category), `${omissionLabel}.category has no matching category slice`);
  }
  invariant(fixtureIds.size === gate.expected_pair_count, `${label} fixture inventory differs from expected_pair_count`);
  const expectedByCategory = new Map();
  const eligibleByCategory = new Map();
  for (const pair of gate.pairs) {
    expectedByCategory.set(pair.category, (expectedByCategory.get(pair.category) ?? 0) + 1);
    eligibleByCategory.set(pair.category, (eligibleByCategory.get(pair.category) ?? 0) + 1);
  }
  for (const omission of gate.omissions) {
    expectedByCategory.set(omission.category, (expectedByCategory.get(omission.category) ?? 0) + 1);
  }
  invariant(expectedByCategory.size === gate.categories.length, `${label} category inventory differs from its slices`);
  assertSliceMatchesPairs(gate.overall, gate.pairs, `${label}.overall`);
  for (const [index, category] of gate.categories.entries()) {
    invariant(
      category.expected_pair_count === (expectedByCategory.get(category.category) ?? 0),
      `${label}.categories[${index}].expected_pair_count differs from its fixtures`,
    );
    invariant(
      category.eligible_pair_count === (eligibleByCategory.get(category.category) ?? 0),
      `${label}.categories[${index}].eligible_pair_count differs from its pairs`,
    );
    assertSliceMatchesPairs(
      category,
      gate.pairs.filter((pair) => pair.category === category.category),
      `${label}.categories[${index}]`,
    );
  }
  invariant(Array.isArray(gate.violations) && gate.violations.every((value) => typeof value === "string" && value.length > 0), `${label}.violations is invalid`);
  const expectedPassed = gate.applicable
    && gate.provenance_passed
    && gate.canonical_corpus_passed
    && gate.canonical_fixture_identity_passed
    && gate.expected_pair_count >= gate.minimum_pair_count
    && gate.categories.length >= gate.minimum_category_count
    && gate.pair_coverage >= gate.required_pair_coverage
    && gate.overall.passed
    && gate.categories.every((category) => category.passed)
    && gate.violations.length === 0;
  invariant(gate.passed === expectedPassed, `${label}.passed is inconsistent with the v1 acceptance policy`);
  invariant(
    (gate.violations.length === 0) === expectedPassed,
    `${label}.violations are inconsistent with the v1 acceptance result`,
  );
  if (gate.passed) {
    invariant(
      gate.overall.metrics.every((metric) => metric.applicable_pair_count > 0),
      `${label} passed without exercising every overall metric`,
    );
  }
}

function assertReportCorpusBinding(report, label, canonicalCorpus) {
  invariant(/^[0-9a-f]{64}$/.test(report.manifest_sha256), `${label}.manifest_sha256 is invalid`);
  invariant(report.manifest && typeof report.manifest === "object" && !Array.isArray(report.manifest), `${label}.manifest is not an object`);
  invariant(typeof report.manifest.corpus_id === "string" && report.manifest.corpus_id.length > 0, `${label}.manifest.corpus_id is empty`);
  invariant(
    report.best_quality_acceptance.corpus_id === report.manifest.corpus_id,
    `${label} best-quality corpus_id differs from the report manifest`,
  );
  invariant(
    report.best_quality_acceptance.corpus_manifest_sha256 === report.manifest_sha256,
    `${label} best-quality corpus SHA-256 differs from manifest_sha256`,
  );
  const expectedCanonical = report.best_quality_acceptance.corpus_id === canonicalCorpus.corpus_id
    && report.manifest_sha256 === canonicalCorpus.manifest_sha256;
  invariant(
    report.best_quality_acceptance.canonical_corpus_passed === expectedCanonical,
    `${label} canonical_corpus_passed is inconsistent with checked-in bench/corpus-manifest.json`,
  );
  if (expectedCanonical) {
    invariant(
      isDeepStrictEqual(report.manifest, canonicalCorpus.serialized_manifest),
      `${label} embedded manifest differs from the Rust-serialized checked-in bench/corpus-manifest.json`,
    );
  }
}

const canonicalFixtureIdentityKeys = new Set([
  "contract_id",
  "status",
  "generator_ffmpeg_sha256",
  "generator_ffprobe_sha256",
  "reviewed_runtime_manifest_path",
  "reviewed_runtime_manifest_sha256",
]);

const toolchainKeys = new Set([
  "gifp_version",
  "build_profile",
  "ffmpeg_path",
  "ffmpeg_version",
  "ffmpeg_sha256",
  "ffprobe_path",
  "ffprobe_version",
  "ffprobe_sha256",
  "reviewed_runtime_manifest_path",
  "reviewed_runtime_manifest_sha256",
  "canonical_generator_identity_passed",
]);

function readableSha256(path) {
  try {
    return sha256File(nodeNativePath(path));
  } catch {
    return null;
  }
}

function assertCanonicalFixtureIdentity(report, label) {
  const identity = report.manifest?.canonical_fixture_identity;
  invariant(identity && typeof identity === "object" && !Array.isArray(identity), `${label}.manifest.canonical_fixture_identity is not an object`);
  assertNoUnknownKeys(identity, canonicalFixtureIdentityKeys, `${label}.manifest.canonical_fixture_identity`);
  invariant(identity.contract_id === "gifp.canonical_fixture_identity.v1", `${label} has unsupported canonical fixture identity contract`);
  invariant(identity.status === "complete" || identity.status === "incomplete", `${label} canonical fixture identity status is invalid`);
  for (const field of [
    "generator_ffmpeg_sha256",
    "generator_ffprobe_sha256",
    "reviewed_runtime_manifest_sha256",
  ]) {
    invariant(/^[0-9a-f]{64}$/.test(identity[field]), `${label}.manifest.canonical_fixture_identity.${field} is invalid`);
  }
  const runtimeRelativePath = identity.reviewed_runtime_manifest_path;
  invariant(
    typeof runtimeRelativePath === "string"
      && runtimeRelativePath.length > 0
      && !isAbsolute(runtimeRelativePath)
      && !runtimeRelativePath.split(/[\\/]+/u).includes(".."),
    `${label} reviewed runtime manifest path is not a safe workspace-relative path`,
  );

  invariant(Array.isArray(report.manifest.fixtures), `${label}.manifest.fixtures is not an array`);
  const manifestFixtures = new Map();
  for (const [index, fixture] of report.manifest.fixtures.entries()) {
    invariant(fixture && typeof fixture === "object" && !Array.isArray(fixture), `${label}.manifest.fixtures[${index}] is not an object`);
    invariant(typeof fixture.id === "string" && fixture.id.length > 0, `${label}.manifest.fixtures[${index}].id is empty`);
    invariant(!manifestFixtures.has(fixture.id), `${label}.manifest.fixtures repeats fixture '${fixture.id}'`);
    invariant(Object.hasOwn(fixture, "expected_source_sha256"), `${label}.manifest fixture '${fixture.id}' omits expected_source_sha256`);
    invariant(
      fixture.expected_source_sha256 === null || /^[0-9a-f]{64}$/.test(fixture.expected_source_sha256),
      `${label}.manifest fixture '${fixture.id}' has invalid expected_source_sha256`,
    );
    manifestFixtures.set(fixture.id, fixture);
  }
  if (identity.status === "complete") {
    invariant(
      [...manifestFixtures.values()].every((fixture) => fixture.expected_source_sha256 !== null),
      `${label} marks canonical fixture identity complete while an expected_source_sha256 is null`,
    );
  }

  invariant(Array.isArray(report.sources), `${label}.sources is not an array`);
  const seenSources = new Set();
  let everySourcePassed = report.sources.length === manifestFixtures.size;
  let everyLiveSourceVerified = report.sources.length === manifestFixtures.size;
  for (const [index, source] of report.sources.entries()) {
    const sourceLabel = `${label}.sources[${index}]`;
    invariant(source && typeof source === "object" && !Array.isArray(source), `${sourceLabel} is not an object`);
    invariant(typeof source.fixture_id === "string" && manifestFixtures.has(source.fixture_id), `${sourceLabel}.fixture_id is absent from the manifest`);
    invariant(!seenSources.has(source.fixture_id), `${label}.sources repeats fixture '${source.fixture_id}'`);
    seenSources.add(source.fixture_id);
    invariant(/^[0-9a-f]{64}$/.test(source.sha256), `${sourceLabel}.sha256 is invalid`);
    invariant(Object.hasOwn(source, "expected_source_sha256"), `${sourceLabel} omits expected_source_sha256`);
    invariant(typeof source.canonical_identity_passed === "boolean", `${sourceLabel}.canonical_identity_passed is not boolean`);
    const expected = manifestFixtures.get(source.fixture_id).expected_source_sha256;
    invariant(source.expected_source_sha256 === expected, `${sourceLabel}.expected_source_sha256 differs from the manifest`);
    const expectedPassed = expected !== null && source.sha256 === expected;
    invariant(source.canonical_identity_passed === expectedPassed, `${sourceLabel}.canonical_identity_passed disagrees with its SHA-256`);
    everySourcePassed &&= expectedPassed;
    everyLiveSourceVerified &&= expectedPassed && readableSha256(source.path) === source.sha256;
  }

  const toolchain = report.toolchain;
  invariant(toolchain && typeof toolchain === "object" && !Array.isArray(toolchain), `${label}.toolchain is not an object`);
  assertNoUnknownKeys(toolchain, toolchainKeys, `${label}.toolchain`);
  for (const field of ["ffmpeg_sha256", "ffprobe_sha256"]) {
    invariant(/^[0-9a-f]{64}$/.test(toolchain[field]), `${label}.toolchain.${field} is invalid`);
  }
  invariant(
    toolchain.reviewed_runtime_manifest_sha256 === null
      || /^[0-9a-f]{64}$/.test(toolchain.reviewed_runtime_manifest_sha256),
    `${label}.toolchain.reviewed_runtime_manifest_sha256 is invalid`,
  );
  invariant(typeof toolchain.ffmpeg_path === "string" && toolchain.ffmpeg_path.length > 0, `${label}.toolchain.ffmpeg_path is empty`);
  invariant(typeof toolchain.ffprobe_path === "string" && toolchain.ffprobe_path.length > 0, `${label}.toolchain.ffprobe_path is empty`);
  invariant(
    typeof toolchain.reviewed_runtime_manifest_path === "string" && toolchain.reviewed_runtime_manifest_path.length > 0,
    `${label}.toolchain.reviewed_runtime_manifest_path is empty`,
  );
  invariant(
    typeof toolchain.canonical_generator_identity_passed === "boolean",
    `${label}.toolchain.canonical_generator_identity_passed is not boolean`,
  );

  const checkedInRuntimePath = resolve(workspaceRoot, runtimeRelativePath);
  const checkedInRuntimeFromRoot = relative(workspaceRoot, checkedInRuntimePath);
  const checkedInRuntimeSafe = checkedInRuntimeFromRoot.length > 0
    && checkedInRuntimeFromRoot !== ".."
    && !checkedInRuntimeFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(checkedInRuntimeFromRoot);
  const checkedInRuntimeSha256 = checkedInRuntimeSafe ? readableSha256(checkedInRuntimePath) : null;
  const recordedGeneratorMatches = toolchain.ffmpeg_sha256 === identity.generator_ffmpeg_sha256
    && toolchain.ffprobe_sha256 === identity.generator_ffprobe_sha256
    && toolchain.reviewed_runtime_manifest_sha256 === identity.reviewed_runtime_manifest_sha256
    && checkedInRuntimeSha256 === identity.reviewed_runtime_manifest_sha256;
  const liveGeneratorVerified = recordedGeneratorMatches
    && readableSha256(toolchain.ffmpeg_path) === toolchain.ffmpeg_sha256
    && readableSha256(toolchain.ffprobe_path) === toolchain.ffprobe_sha256
    && readableSha256(toolchain.reviewed_runtime_manifest_path) === toolchain.reviewed_runtime_manifest_sha256;
  invariant(
    toolchain.canonical_generator_identity_passed === recordedGeneratorMatches,
    `${label}.toolchain.canonical_generator_identity_passed disagrees with the reviewed toolchain identity`,
  );

  const expectedPassed = identity.status === "complete"
    && everySourcePassed
    && toolchain.canonical_generator_identity_passed;
  invariant(
    report.best_quality_acceptance.canonical_fixture_identity_passed === expectedPassed,
    `${label} canonical_fixture_identity_passed disagrees with fixed fixture/toolchain identity`,
  );
  return {
    status: identity.status,
    passed: expectedPassed,
    live_passed: expectedPassed && everyLiveSourceVerified && liveGeneratorVerified,
    generator_identity_passed: toolchain.canonical_generator_identity_passed,
    live_generator_verified: liveGeneratorVerified,
    source_identity_passed: everySourcePassed,
    live_source_identity_verified: everyLiveSourceVerified,
  };
}

function fixtureInventory(entries, idField, label) {
  invariant(Array.isArray(entries), `${label} is not an array`);
  const inventory = new Map();
  for (const [index, entry] of entries.entries()) {
    const entryLabel = `${label}[${index}]`;
    invariant(entry && typeof entry === "object" && !Array.isArray(entry), `${entryLabel} is not an object`);
    const fixtureId = entry[idField];
    invariant(typeof fixtureId === "string" && fixtureId.length > 0, `${entryLabel}.${idField} is empty`);
    invariant(typeof entry.category === "string" && entry.category.length > 0, `${entryLabel}.category is empty`);
    invariant(!inventory.has(fixtureId), `${label} repeats fixture '${fixtureId}'`);
    inventory.set(fixtureId, entry.category);
  }
  return inventory;
}

function assertSameFixtureInventory(actual, expected, label) {
  invariant(actual.size === expected.size, `${label} fixture count differs`);
  for (const [fixtureId, category] of expected) {
    invariant(actual.has(fixtureId), `${label} is missing fixture '${fixtureId}'`);
    invariant(actual.get(fixtureId) === category, `${label} category differs for fixture '${fixtureId}'`);
  }
}

function assertReportFixtureInventory(report, label) {
  invariant(Array.isArray(report.manifest.fixtures), `${label}.manifest.fixtures is not an array`);
  const manifestInventory = fixtureInventory(report.manifest.fixtures, "id", `${label}.manifest.fixtures`);
  const sourceInventory = fixtureInventory(report.sources, "fixture_id", `${label}.sources`);
  for (const [fixtureId, category] of sourceInventory) {
    invariant(manifestInventory.has(fixtureId), `${label}.sources contains fixture '${fixtureId}' absent from manifest`);
    invariant(
      manifestInventory.get(fixtureId) === category,
      `${label}.sources category differs from manifest for fixture '${fixtureId}'`,
    );
  }
  const gateInventory = fixtureInventory(
    [...report.best_quality_acceptance.pairs, ...report.best_quality_acceptance.omissions],
    "fixture_id",
    `${label}.best_quality_acceptance fixture inventory`,
  );
  assertSameFixtureInventory(gateInventory, sourceInventory, `${label} gate/source inventory`);
  invariant(
    report.best_quality_acceptance.expected_pair_count === sourceInventory.size,
    `${label} best-quality expected_pair_count differs from sources`,
  );
  return { manifestInventory, sourceInventory };
}

function safeBundleEntryPath(realRoot, relativePath) {
  invariant(typeof relativePath === "string" && relativePath.length > 0, "Bundle entry path is empty");
  invariant(!isAbsolute(relativePath), `Bundle entry path is absolute: ${relativePath}`);
  const path = resolve(realRoot, relativePath);
  const fromRoot = relative(realRoot, path);
  invariant(
    fromRoot.length > 0 && fromRoot !== ".." && !fromRoot.startsWith(`..\\`) && !fromRoot.startsWith("../") && !isAbsolute(fromRoot),
    `Bundle entry escapes its root: ${relativePath}`,
  );
  const metadata = lstatSync(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `Bundle entry is not a regular file: ${relativePath}`);
  const realPath = realpathSync(path);
  const realFromRoot = relative(realRoot, realPath);
  invariant(
    realFromRoot.length > 0 && realFromRoot !== ".." && !realFromRoot.startsWith(`..\\`) && !realFromRoot.startsWith("../") && !isAbsolute(realFromRoot),
    `Bundle entry resolves outside its root: ${relativePath}`,
  );
  return realPath;
}

export function verifyQualityReport({ reportPath, schemaPath = defaultSchemaPath, requireFirstTierQuality = false }) {
  const reportAbsolute = resolve(reportPath);
  const schemaAbsolute = resolve(schemaPath);
  const schemaSnapshot = readJsonSnapshot(schemaAbsolute, "quality report schema");
  const schema = schemaSnapshot.value;
  const canonicalManifestSnapshot = readJsonSnapshot(
    canonicalCorpusManifestPath,
    "checked-in canonical corpus manifest",
  );
  const canonicalManifest = canonicalManifestSnapshot.value;
  const canonicalCorpus = {
    corpus_id: canonicalManifest.corpus_id,
    manifest_sha256: canonicalManifestSnapshot.sha256,
    serialized_manifest: rustSerializedCorpusManifest(canonicalManifest),
  };
  const reportSnapshot = readJsonSnapshot(reportAbsolute, "quality report");
  const report = reportSnapshot.value;
  assertTopLevelSchemaContract(report, schema, "Commit-point report");
  assertBestQualityAcceptanceContract(report.best_quality_acceptance, "Commit-point best_quality_acceptance");
  assertGitProvenance(report, "Commit-point report");
  assertReportCorpusBinding(report, "Commit-point report", canonicalCorpus);
  const commitInventory = assertReportFixtureInventory(report, "Commit-point report");
  const commitFixtureIdentity = assertCanonicalFixtureIdentity(report, "Commit-point report");

  const bundle = report.artifact_bundle;
  invariant(bundle && typeof bundle === "object", "Commit-point report is missing artifact_bundle");
  invariant(bundle.schema_version === 1, `Unsupported artifact bundle schema ${bundle.schema_version}`);
  invariant(bundle.run_id === report.run_id, "Artifact bundle run_id does not match the report");
  invariant(Array.isArray(bundle.artifacts) && bundle.artifacts.length >= 3, "Artifact bundle has fewer than three artifacts");

  const rootPath = nodeNativePath(bundle.root_path);
  const manifestPath = nodeNativePath(bundle.manifest_path);
  const rootMetadata = lstatSync(rootPath);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Artifact bundle root is not a regular directory");
  const realRoot = realpathSync(rootPath);
  const realManifest = realpathSync(manifestPath);
  invariant(dirname(realManifest) === realRoot, "Artifact bundle manifest is outside the bundle root");
  const manifestSnapshot = readJsonSnapshot(realManifest, "artifact bundle manifest");
  invariant(manifestSnapshot.sha256 === bundle.manifest_sha256, "Artifact bundle manifest SHA-256 mismatch");

  const manifest = manifestSnapshot.value;
  invariant(manifest.schema_version === bundle.schema_version, "Bundle manifest schema does not match its reference");
  invariant(manifest.run_id === bundle.run_id, "Bundle manifest run_id does not match its reference");
  invariant(
    JSON.stringify(manifest.artifacts) === JSON.stringify(bundle.artifacts),
    "Bundle manifest inventory does not match its report reference",
  );

  const paths = new Set();
  const roles = new Map();
  const verifiedArtifacts = [];
  for (const artifact of manifest.artifacts) {
    invariant(artifact && typeof artifact === "object", "Bundle artifact entry is not an object");
    invariant(typeof artifact.role === "string" && artifact.role.length > 0, "Bundle artifact role is empty");
    invariant(/^[0-9a-f]{64}$/.test(artifact.sha256), `Invalid artifact SHA-256: ${artifact.relative_path}`);
    invariant(Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes >= 0, `Invalid artifact size: ${artifact.relative_path}`);
    invariant(!paths.has(artifact.relative_path), `Duplicate bundle artifact path: ${artifact.relative_path}`);
    paths.add(artifact.relative_path);
    const path = safeBundleEntryPath(realRoot, artifact.relative_path);
    invariant(statSync(path).size === artifact.size_bytes, `Artifact size mismatch: ${artifact.relative_path}`);
    invariant(sha256File(path) === artifact.sha256, `Artifact SHA-256 mismatch: ${artifact.relative_path}`);
    const entries = roles.get(artifact.role) ?? [];
    entries.push({ artifact, path });
    roles.set(artifact.role, entries);
    verifiedArtifacts.push({ ...artifact, source_path: path });
  }

  for (const role of ["report_json", "report_csv", "blind_html", "build_provenance"]) {
    invariant(roles.has(role), `Artifact bundle is missing required role '${role}'`);
  }
  invariant(roles.get("report_json").length === 1, "Artifact bundle must contain exactly one report_json");
  invariant(roles.get("build_provenance").length === 1, "Artifact bundle must contain exactly one build_provenance");
  const bundledReportEntry = roles.get("report_json")[0];
  invariant(bundledReportEntry.artifact.relative_path === "report.json", "report_json must be stored at report.json");
  const bundledReportSnapshot = readJsonSnapshot(bundledReportEntry.path, "bundled report snapshot");
  invariant(
    bundledReportSnapshot.size_bytes === bundledReportEntry.artifact.size_bytes,
    "Bundled report snapshot size changed during verification",
  );
  invariant(
    bundledReportSnapshot.sha256 === bundledReportEntry.artifact.sha256,
    "Bundled report snapshot SHA-256 changed during verification",
  );
  const bundledReport = bundledReportSnapshot.value;
  assertTopLevelSchemaContract(bundledReport, schema, "Bundled report snapshot");
  assertBestQualityAcceptanceContract(bundledReport.best_quality_acceptance, "Bundled best_quality_acceptance");
  assertGitProvenance(bundledReport, "Bundled report snapshot");
  assertReportCorpusBinding(bundledReport, "Bundled report snapshot", canonicalCorpus);
  const bundledInventory = assertReportFixtureInventory(bundledReport, "Bundled report snapshot");
  const bundledFixtureIdentity = assertCanonicalFixtureIdentity(
    bundledReport,
    "Bundled report snapshot",
  );
  invariant(bundledReport.run_id === report.run_id, "Bundled report run_id does not match the commit point");
  invariant(
    bundledReport.manifest_sha256 === report.manifest_sha256,
    "Commit-point and bundled report manifest_sha256 differ",
  );
  invariant(!Object.hasOwn(bundledReport, "artifact_bundle"), "Bundled report contains a circular artifact_bundle reference");
  invariant(
    isDeepStrictEqual(report.best_quality_acceptance, bundledReport.best_quality_acceptance),
    "Commit-point and bundled best_quality_acceptance differ",
  );
  const { artifact_bundle: ignoredArtifactBundle, ...commitPointSnapshot } = report;
  void ignoredArtifactBundle;
  invariant(
    isDeepStrictEqual(commitPointSnapshot, bundledReport),
    "Commit-point report differs from immutable bundled snapshot",
  );
  const buildProvenanceEntry = roles.get("build_provenance")[0];
  invariant(
    buildProvenanceEntry.artifact.relative_path === "build-provenance.json",
    "build_provenance must be stored at build-provenance.json",
  );
  const buildProvenanceSnapshot = readJsonSnapshot(
    buildProvenanceEntry.path,
    "sealed build provenance",
  );
  invariant(
    buildProvenanceSnapshot.size_bytes === buildProvenanceEntry.artifact.size_bytes,
    "Build provenance size changed during verification",
  );
  invariant(
    buildProvenanceSnapshot.sha256 === buildProvenanceEntry.artifact.sha256,
    "Build provenance SHA-256 changed during verification",
  );
  const buildProvenance = assertBuildProvenance(
    buildProvenanceSnapshot.value,
    bundledReport,
    "Sealed build provenance",
  );
  if (requireFirstTierQuality) {
    const gate = bundledReport.best_quality_acceptance;
    invariant(gate.applicable, "First-tier quality gate is not applicable to this report");
    invariant(
      typeof bundledReport.git_commit === "string" && /^[0-9a-f]{40}$/.test(bundledReport.git_commit),
      "First-tier quality gate has no full Git commit provenance",
    );
    invariant(bundledReport.git_dirty === false, "First-tier quality gate was captured from a dirty worktree");
    invariant(buildProvenance.passed, "First-tier quality gate has inconsistent compile/runtime provenance");
    invariant(gate.provenance_passed, "First-tier quality gate has no clean-commit provenance");
    invariant(gate.canonical_corpus_passed, "First-tier quality gate did not use the canonical corpus");
    invariant(
      gate.canonical_fixture_identity_passed
        && commitFixtureIdentity.passed
        && bundledFixtureIdentity.passed
        && commitFixtureIdentity.live_passed
        && bundledFixtureIdentity.live_passed,
      "First-tier quality gate does not have a complete reviewed identity for all canonical fixtures and generator tools",
    );
    invariant(
      report.manifest_sha256 === canonicalCorpus.manifest_sha256
        && bundledReport.manifest_sha256 === canonicalCorpus.manifest_sha256
        && gate.corpus_manifest_sha256 === canonicalCorpus.manifest_sha256,
      "First-tier quality gate manifest SHA-256 does not match checked-in bench/corpus-manifest.json",
    );
    invariant(
      gate.corpus_id === canonicalManifest.corpus_id,
      "First-tier quality gate corpus_id does not match checked-in bench/corpus-manifest.json",
    );
    invariant(
      commitInventory.sourceInventory.size === commitInventory.manifestInventory.size
        && bundledInventory.sourceInventory.size === bundledInventory.manifestInventory.size,
      "First-tier quality gate does not cover every checked-in manifest fixture",
    );
    invariant(gate.passed, `First-tier quality gate failed: ${gate.violations.join("; ") || "unspecified violation"}`);
  }

  const gate = bundledReport.best_quality_acceptance;
  return {
    report_path: reportAbsolute,
    report_sha256: reportSnapshot.sha256,
    report_size_bytes: reportSnapshot.size_bytes,
    run_id: report.run_id,
    schema_version: report.schema_version,
    schema_path: schemaAbsolute,
    schema_sha256: schemaSnapshot.sha256,
    schema_size_bytes: schemaSnapshot.size_bytes,
    git_commit: bundledReport.git_commit,
    git_dirty: bundledReport.git_dirty,
    build_provenance: buildProvenance,
    build_provenance_path: buildProvenanceEntry.path,
    build_provenance_sha256: buildProvenanceSnapshot.sha256,
    build_provenance_size_bytes: buildProvenanceSnapshot.size_bytes,
    acceptance_id: gate.acceptance_id,
    first_tier_applicable: gate.applicable,
    first_tier_provenance_passed: gate.provenance_passed,
    first_tier_canonical_corpus_passed: gate.canonical_corpus_passed,
    first_tier_canonical_fixture_identity_passed: gate.canonical_fixture_identity_passed,
    canonical_fixture_identity: bundledFixtureIdentity,
    corpus_id: gate.corpus_id,
    corpus_manifest_path: canonicalCorpusManifestPath,
    corpus_manifest_sha256: canonicalCorpus.manifest_sha256,
    corpus_manifest_size_bytes: canonicalManifestSnapshot.size_bytes,
    artifact_bundle_schema_version: bundle.schema_version,
    artifact_bundle_root_path: realRoot,
    artifact_bundle_manifest_path: realManifest,
    artifact_bundle_manifest_sha256: bundle.manifest_sha256,
    artifact_bundle_manifest_size_bytes: manifestSnapshot.size_bytes,
    artifact_count: manifest.artifacts.length,
    artifact_size_bytes: manifest.artifacts.reduce((sum, artifact) => sum + artifact.size_bytes, 0),
    artifacts: verifiedArtifacts,
    // Backward-compatible alias. This is the artifact-bundle manifest digest,
    // not the canonical corpus manifest digest.
    manifest_sha256: bundle.manifest_sha256,
    first_tier_quality_passed: gate.passed,
  };
}

function parseArgs(args) {
  const options = { reportPath: null, schemaPath: defaultSchemaPath, requireFirstTierQuality: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      index += 1;
      if (index >= args.length) throw new Error(`${argument} requires a value`);
      return args[index];
    };
    switch (argument) {
      case "--report":
        options.reportPath = value();
        break;
      case "--schema":
        options.schemaPath = value();
        break;
      case "--require-first-tier-quality":
        options.requireFirstTierQuality = true;
        break;
      case "--help":
      case "-h":
        return null;
      default:
        throw new Error(`Unknown option: ${argument}\n\n${HELP}`);
    }
  }
  if (!options.reportPath) throw new Error(`--report is required\n\n${HELP}`);
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
      process.stdout.write(HELP);
    } else {
      const verified = verifyQualityReport(options);
      console.log(
        `Quality report verified: schema v${verified.schema_version}, run ${verified.run_id}, ${verified.artifact_count} immutable artifacts`,
      );
      console.log(`Corpus manifest SHA-256: ${verified.corpus_manifest_sha256}`);
      console.log(`Artifact bundle manifest SHA-256: ${verified.artifact_bundle_manifest_sha256}`);
      console.log(`First-tier quality gate: ${verified.first_tier_quality_passed ? "passed" : "not passed"}`);
    }
  } catch (error) {
    console.error(`GIFP Quality Report verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
