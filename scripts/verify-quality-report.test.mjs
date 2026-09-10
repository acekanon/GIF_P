import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { verifyQualityReport } from "./verify-quality-report.mjs";

const roots = [];
const schemaPath = resolve("bench", "quality-report.schema.json");
const verifierPath = resolve("scripts", "verify-quality-report.mjs");
const canonicalManifestPath = resolve("bench", "corpus-manifest.json");
const canonicalManifestSha256 = sha256(canonicalManifestPath);
const canonicalManifest = JSON.parse(readFileSync(canonicalManifestPath, "utf8"));
const canonicalCorpusId = canonicalManifest.corpus_id;
const canonicalReportManifest = rustSerializedCorpusManifest(canonicalManifest);
const canonicalFixtures = canonicalManifest.fixtures.map(({
  id,
  category,
  tags,
  expected_source_sha256: expectedSourceSha256,
}) => ({ id, category, tags, expectedSourceSha256 }));
const metricIds = [
  "vmaf_neg_mean",
  "vmaf_neg_p05",
  "cambi_mean",
  "mean_oklab_error",
  "edge_error",
  "static_region_temporal_residual",
  "alpha_coverage_error",
  "alpha_mean_absolute_error",
  "loop_seam_excess_oklab",
];
const metricSpecs = new Map([
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

function rustSerializedCorpusManifest(manifest) {
  return {
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
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function metricDirection(metricId) {
  return metricSpecs.get(metricId).direction;
}

function metricSummary(metricId, count, passed = true) {
  const comparison = metricComparison(metricId, passed);
  const winCount = comparison.outcome === "win" ? count : 0;
  const tieCount = comparison.outcome === "tie" ? count : 0;
  const lossCount = comparison.outcome === "loss" ? count : 0;
  const decisiveCount = winCount + lossCount;
  return {
    metric_id: metricId,
    direction: metricDirection(metricId),
    applicable_pair_count: count,
    win_count: winCount,
    tie_count: tieCount,
    loss_count: lossCount,
    win_rate: count > 0 ? winCount / count : null,
    loss_rate: count > 0 ? lossCount / count : null,
    decisive_count: decisiveCount,
    decisive_win_rate: decisiveCount > 0 ? winCount / decisiveCount : null,
    mean_quality_improvement: count > 0 ? comparison.quality_improvement : null,
    mean_quality_improvement_in_tie_units: count > 0 ? comparison.quality_improvement_in_tie_units : null,
    minimum_quality_improvement: count > 0 ? comparison.quality_improvement : null,
    p05_quality_improvement: count > 0 ? comparison.quality_improvement : null,
    median_quality_improvement: count > 0 ? comparison.quality_improvement : null,
    p95_quality_improvement: count > 0 ? comparison.quality_improvement : null,
    maximum_quality_improvement: count > 0 ? comparison.quality_improvement : null,
    severe_regression_count: comparison.severe_regression ? count : 0,
    passed: passed || metricId !== "vmaf_neg_mean",
  };
}

function qualitySlice(category, count, passed = true) {
  return {
    category,
    expected_pair_count: count,
    eligible_pair_count: count,
    pair_coverage: 1,
    metrics: metricIds.map((metricId) => metricSummary(metricId, count, passed)),
    passed,
  };
}

function metricComparison(metricId, passed = true) {
  const spec = metricSpecs.get(metricId);
  const shouldFail = !passed && metricId === "vmaf_neg_mean";
  const referenceValue = spec.direction === "higher_is_better" ? 1 : 2;
  const candidateValue = shouldFail
    ? 0
    : spec.direction === "higher_is_better" ? 2 : 1;
  const qualityImprovement = spec.direction === "higher_is_better"
    ? candidateValue - referenceValue
    : referenceValue - candidateValue;
  const tieTolerance = spec.tieAbsolute + Math.abs(referenceValue) * spec.tieRelative;
  const severeTolerance = Math.max(
    tieTolerance,
    spec.severeAbsolute + Math.abs(referenceValue) * spec.severeRelative,
  );
  return {
    metric_id: metricId,
    direction: spec.direction,
    candidate_value: candidateValue,
    reference_value: referenceValue,
    quality_improvement: qualityImprovement,
    quality_improvement_in_tie_units: qualityImprovement / tieTolerance,
    tie_tolerance: tieTolerance,
    severe_regression_tolerance: severeTolerance,
    outcome: qualityImprovement > tieTolerance ? "win" : qualityImprovement < -tieTolerance ? "loss" : "tie",
    severe_regression: qualityImprovement <= -severeTolerance,
  };
}

function firstTierGate(options = {}) {
  const {
    applicable = true,
    provenancePassed = true,
    identityPassed = false,
    qualityPassed = options.passed ?? true,
    passed = identityPassed && qualityPassed,
    violations,
  } = options;
  const categories = [...new Set(canonicalFixtures.map(({ category }) => category))];
  const fixtureCountByCategory = new Map(categories.map((category) => [
    category,
    canonicalFixtures.filter((fixture) => fixture.category === category).length,
  ]));
  const resolvedViolations = violations ?? (passed ? [] : ["canonical fixture identity is incomplete"]);
  return {
    acceptance_id: "gifp.best_same_size.first_tier.v1",
    corpus_id: canonicalCorpusId,
    corpus_manifest_sha256: canonicalManifestSha256,
    canonical_corpus_passed: true,
    canonical_fixture_identity_passed: identityPassed,
    applicable,
    candidate_profile_id: applicable ? "best-current" : null,
    reference_profile_id: applicable ? "ffmpeg-size-match" : null,
    maximum_size_delta_percent: 5,
    minimum_pair_count: 28,
    minimum_category_count: 7,
    required_pair_coverage: 1,
    required_vmaf_win_rate: 0.6,
    provenance_passed: provenancePassed,
    expected_pair_count: canonicalFixtures.length,
    eligible_pair_count: canonicalFixtures.length,
    omitted_pair_count: 0,
    pair_coverage: 1,
    overall: qualitySlice("all", canonicalFixtures.length, qualityPassed),
    categories: categories.map((category) => qualitySlice(category, fixtureCountByCategory.get(category), qualityPassed)),
    pairs: canonicalFixtures.map((fixture) => ({
      fixture_id: fixture.id,
      category: fixture.category,
      candidate_size_bytes: 1000,
      reference_size_bytes: 1000,
      size_delta_percent: 0,
      candidate_output_sha256: "c".repeat(64),
      reference_output_sha256: "d".repeat(64),
      metrics: metricIds.map((metricId) => metricComparison(metricId, qualityPassed)),
    })),
    omissions: [],
    passed,
    violations: resolvedViolations,
  };
}

function gateWithOneOmission() {
  const gate = firstTierGate();
  const omittedPair = gate.pairs.pop();
  const expectedCount = gate.expected_pair_count;
  gate.eligible_pair_count = expectedCount - 1;
  gate.omitted_pair_count = 1;
  gate.pair_coverage = (expectedCount - 1) / expectedCount;
  gate.overall = qualitySlice("all", expectedCount - 1);
  gate.overall.expected_pair_count = expectedCount;
  gate.overall.pair_coverage = (expectedCount - 1) / expectedCount;
  gate.overall.passed = false;
  const category = gate.categories.find(({ category: id }) => id === omittedPair.category);
  const categoryExpected = category.expected_pair_count;
  Object.assign(category, qualitySlice(category.category, categoryExpected - 1), {
    expected_pair_count: categoryExpected,
    pair_coverage: (categoryExpected - 1) / categoryExpected,
    passed: false,
  });
  gate.omissions = [{
    fixture_id: omittedPair.fixture_id,
    category: omittedPair.category,
    reason: "missing valid pair",
  }];
  gate.passed = false;
  gate.violations = [`eligible same-size pair coverage is ${expectedCount - 1}/${expectedCount}; 100% is required`];
  return gate;
}

function minimalReport(runId, gate = firstTierGate(), overrides = {}) {
  return {
    schema_version: 9,
    run_id: runId,
    generated_at_unix_ms: 1,
    manifest_path: canonicalManifestPath,
    manifest_sha256: gate.corpus_manifest_sha256,
    git_commit: "b".repeat(40),
    git_dirty: false,
    host: {},
    toolchain: {
      gifp_version: "test",
      build_profile: "release",
      ffmpeg_path: "missing-test-ffmpeg",
      ffmpeg_version: null,
      ffmpeg_sha256: "0".repeat(64),
      ffprobe_path: "missing-test-ffprobe",
      ffprobe_version: null,
      ffprobe_sha256: "0".repeat(64),
      reviewed_runtime_manifest_path: "missing-test-runtime-manifest.json",
      reviewed_runtime_manifest_sha256: null,
      canonical_generator_identity_passed: false,
    },
    manifest: structuredClone(canonicalReportManifest),
    sources: canonicalFixtures.map((fixture) => ({
      fixture_id: fixture.id,
      category: fixture.category,
      tags: fixture.tags,
      path: `fixtures/${fixture.id}.mkv`,
      sha256: "a".repeat(64),
      expected_source_sha256: fixture.expectedSourceSha256,
      canonical_identity_passed: false,
      inspection: {},
    })),
    successful_runs: 1,
    failed_runs: 0,
    target_reinvestment_calibration: {},
    target_hard_cap_acceptance: {},
    best_quality_acceptance: gate,
    performance_baseline: {},
    runs: [{}],
    ...overrides,
  };
}

function buildProvenance(runId, report, provenancePassed) {
  const commit = report.git_commit;
  const treeHash = "b".repeat(40);
  const clean = provenancePassed === true;
  return {
    schema_version: 1,
    contract_id: "gifp.build_provenance.v1",
    run_id: runId,
    executor_start_sha256: "e".repeat(64),
    executor_end_sha256: "e".repeat(64),
    embedded_build: {
      git_commit: commit,
      git_dirty: clean ? false : true,
      git_tree_hash: treeHash,
    },
    runtime_start: {
      commit,
      dirty: report.git_dirty,
      tree_hash: treeHash,
    },
    runtime_end: {
      commit,
      dirty: report.git_dirty,
      tree_hash: treeHash,
    },
    passed: clean,
    violations: clean ? [] : ["synthetic provenance failure"],
  };
}

function createBundle({
  commitGate = firstTierGate(),
  bundleGate = commitGate,
  commitReportOverrides = {},
  bundleReportOverrides = {},
  mutateBuildProvenance = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gifp-report-verifier-"));
  roots.push(root);
  const bundleRoot = join(root, "report-bundle");
  mkdirSync(bundleRoot);
  const runId = "verified-run";
  const bundledReport = minimalReport(runId, bundleGate, bundleReportOverrides);
  const provenance = buildProvenance(runId, bundledReport, bundleGate.provenance_passed);
  if (mutateBuildProvenance) mutateBuildProvenance(provenance);
  const files = [
    ["report_json", "report.json", `${JSON.stringify(bundledReport)}\n`],
    ["report_csv", "report.csv", "run_id\nverified-run\n"],
    ["blind_html", "blind.html", "<html></html>\n"],
    ["build_provenance", "build-provenance.json", `${JSON.stringify(provenance)}\n`],
  ];
  const artifacts = files.map(([role, relativePath, contents]) => {
    const path = join(bundleRoot, relativePath);
    writeFileSync(path, contents);
    return {
      role,
      relative_path: relativePath,
      sha256: sha256(path),
      size_bytes: readFileSync(path).length,
    };
  });
  const manifestPath = join(bundleRoot, "bundle-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({ schema_version: 1, run_id: runId, artifacts })}\n`);
  const report = {
    ...minimalReport(runId, commitGate, commitReportOverrides),
    artifact_bundle: {
      schema_version: 1,
      run_id: runId,
      root_path: bundleRoot,
      manifest_path: manifestPath,
      manifest_sha256: sha256(manifestPath),
      artifacts,
    },
  };
  const reportPath = join(root, "latest.json");
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  return { reportPath, bundleRoot, manifestPath };
}

describe("Quality Report v9 verifier", () => {
  it("verifies the commit point, manifest, and immutable artifact hashes", () => {
    const { reportPath, manifestPath } = createBundle();
    expect(verifyQualityReport({ reportPath, schemaPath })).toMatchObject({
      run_id: "verified-run",
      schema_version: 9,
      artifact_count: 4,
      report_sha256: sha256(reportPath),
      corpus_manifest_sha256: canonicalManifestSha256,
      artifact_bundle_manifest_sha256: sha256(manifestPath),
      first_tier_quality_passed: false,
      first_tier_canonical_fixture_identity_passed: false,
    });
  });

  it("binds every commit-point field to the immutable bundled report snapshot", () => {
    const { reportPath: commitPath } = createBundle({
      commitReportOverrides: { git_commit: "c".repeat(40) },
    });
    expect(() => verifyQualityReport({ reportPath: commitPath, schemaPath }))
      .toThrow("Commit-point report differs from immutable bundled snapshot");

    const diagnosticGate = firstTierGate({
      provenancePassed: false,
      passed: false,
      violations: ["dirty diagnostic"],
    });
    const { reportPath: dirtyPath } = createBundle({
      commitGate: diagnosticGate,
      commitReportOverrides: { git_dirty: true },
      bundleReportOverrides: { git_dirty: null },
    });
    expect(() => verifyQualityReport({ reportPath: dirtyPath, schemaPath }))
      .toThrow("Commit-point report differs from immutable bundled snapshot");

    const { reportPath: timestampPath } = createBundle({
      commitReportOverrides: { generated_at_unix_ms: 2 },
    });
    expect(() => verifyQualityReport({ reportPath: timestampPath, schemaPath }))
      .toThrow("Commit-point report differs from immutable bundled snapshot");
  });

  it("recomputes clean Git provenance instead of trusting the sealed gate flag", () => {
    const { reportPath } = createBundle({
      commitReportOverrides: { git_dirty: true },
      bundleReportOverrides: { git_dirty: true },
    });
    expect(() => verifyQualityReport({ reportPath, schemaPath }))
      .toThrow(/sealed compile\/runtime facts|best_quality_acceptance\.provenance_passed/);
  });

  it("binds compile-time commit, runtime start/end, and executor hash", () => {
    for (const mutateBuildProvenance of [
      (value) => { value.embedded_build.git_commit = "c".repeat(40); },
      (value) => { value.runtime_end.commit = "d".repeat(40); },
      (value) => { value.runtime_end.dirty = true; },
      (value) => { value.executor_end_sha256 = "f".repeat(64); },
      (value) => { value.runtime_end.tree_hash = "1".repeat(40); },
    ]) {
      const { reportPath } = createBundle({ mutateBuildProvenance });
      expect(() => verifyQualityReport({ reportPath, schemaPath }))
        .toThrow(/sealed compile\/runtime facts/);
    }
  });

  it("allows a sealed dirty diagnostic but never accepts it in strict mode", () => {
    const gate = firstTierGate({
      provenancePassed: false,
      passed: false,
      violations: ["dirty diagnostic"],
    });
    const { reportPath } = createBundle({
      commitGate: gate,
      bundleGate: gate,
      commitReportOverrides: { git_dirty: true },
      bundleReportOverrides: { git_dirty: true },
    });
    expect(verifyQualityReport({ reportPath, schemaPath })).toMatchObject({
      first_tier_provenance_passed: false,
      first_tier_quality_passed: false,
    });
    expect(() => verifyQualityReport({ reportPath, schemaPath, requireFirstTierQuality: true }))
      .toThrow(/dirty worktree|inconsistent compile\/runtime provenance/);
  });

  it("rejects malformed top-level Git facts", () => {
    const gate = firstTierGate({
      provenancePassed: false,
      passed: false,
      violations: ["missing provenance"],
    });
    const { reportPath } = createBundle({
      commitGate: gate,
      commitReportOverrides: { git_commit: "NOT-A-COMMIT", git_dirty: null },
      bundleReportOverrides: { git_commit: "NOT-A-COMMIT", git_dirty: null },
    });
    expect(() => verifyQualityReport({ reportPath, schemaPath }))
      .toThrow(/git_commit is not null or a lowercase 40-character commit SHA/);
  });

  it("fails strict mode closed while the checked-in fixture identity baseline is incomplete", () => {
    const { reportPath } = createBundle();
    expect(() => verifyQualityReport({ reportPath, schemaPath, requireFirstTierQuality: true }))
      .toThrow(/complete reviewed identity/);
  });

  it("exits unsuccessfully for an incomplete identity in strict CLI mode", () => {
    const { reportPath } = createBundle();
    const result = spawnSync(process.execPath, [
      verifierPath,
      "--report",
      reportPath,
      "--schema",
      schemaPath,
      "--require-first-tier-quality",
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("complete reviewed identity");
  });

  it("allows a well-formed diagnostic failure in integrity mode but rejects it in strict mode", () => {
    const gate = firstTierGate({ passed: false, violations: ["CAMBI regressed"] });
    const { reportPath } = createBundle({ commitGate: gate });
    expect(verifyQualityReport({ reportPath, schemaPath })).toMatchObject({
      first_tier_quality_passed: false,
    });
    expect(() => verifyQualityReport({ reportPath, schemaPath, requireFirstTierQuality: true }))
      .toThrow(/complete reviewed identity/);
  });

  it("rejects a non-applicable report in strict mode", () => {
    const gate = firstTierGate({ applicable: false, passed: false, violations: ["missing pair"] });
    const { reportPath } = createBundle({ commitGate: gate });
    expect(() => verifyQualityReport({ reportPath, schemaPath, requireFirstTierQuality: true }))
      .toThrow("First-tier quality gate is not applicable");
  });

  it("rejects malformed nested acceptance data", () => {
    const { reportPath } = createBundle();
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.best_quality_acceptance = {};
    writeFileSync(reportPath, JSON.stringify(report));
    expect(() => verifyQualityReport({ reportPath, schemaPath })).toThrow(/unsupported acceptance_id/);
  });

  it("rejects unknown fields from every nested best-quality object type", () => {
    const cases = [
      ["acceptance", (gate) => { gate.unversioned = true; }],
      ["slice", (gate) => { gate.overall.unversioned = true; }],
      ["summary", (gate) => { gate.overall.metrics[0].unversioned = true; }],
      ["pair", (gate) => { gate.pairs[0].unversioned = true; }],
      ["comparison", (gate) => { gate.pairs[0].metrics[0].unversioned = true; }],
    ];
    for (const [kind, mutate] of cases) {
      const gate = firstTierGate();
      mutate(gate);
      const { reportPath } = createBundle({ commitGate: gate });
      expect(() => verifyQualityReport({ reportPath, schemaPath }), kind)
        .toThrow(/contains unknown field 'unversioned'/);
    }
    const omissionGate = gateWithOneOmission();
    omissionGate.omissions[0].unversioned = true;
    const { reportPath } = createBundle({ commitGate: omissionGate });
    expect(() => verifyQualityReport({ reportPath, schemaPath }))
      .toThrow(/omissions\[0\] contains unknown field 'unversioned'/);
  });

  it("recomputes every metric comparison instead of trusting sealed derived fields", () => {
    const cases = [
      ["direction", (metric) => { metric.direction = "lower_is_better"; }, /direction does not match metric_id/],
      ["improvement", (metric) => { metric.quality_improvement += 0.1; }, /quality_improvement is inconsistent/],
      ["tie units", (metric) => { metric.quality_improvement_in_tie_units += 0.1; }, /tie_units is inconsistent/],
      ["tie tolerance", (metric) => { metric.tie_tolerance += 0.1; }, /tie_tolerance does not match/],
      ["outcome", (metric) => { metric.outcome = "tie"; }, /outcome is inconsistent/],
      ["severe flag", (metric) => { metric.severe_regression = true; }, /severe_regression is inconsistent/],
    ];
    for (const [kind, mutate, message] of cases) {
      const gate = firstTierGate();
      mutate(gate.pairs[0].metrics[0]);
      const { reportPath } = createBundle({ commitGate: gate });
      expect(() => verifyQualityReport({ reportPath, schemaPath }), kind).toThrow(message);
    }
  });

  it("recomputes aggregate summaries and pair size deltas from sealed observations", () => {
    const countGate = firstTierGate();
    const countSummary = countGate.overall.metrics[0];
    countSummary.win_count = 27;
    countSummary.tie_count = 1;
    countSummary.win_rate = 27 / 28;
    countSummary.decisive_count = 27;
    countSummary.decisive_win_rate = 1;
    const { reportPath: countReportPath } = createBundle({ commitGate: countGate });
    expect(() => verifyQualityReport({ reportPath: countReportPath, schemaPath }))
      .toThrow(/differs from the paired comparisons/);

    const summaryGate = firstTierGate();
    const summary = summaryGate.overall.metrics[0];
    for (const field of [
      "mean_quality_improvement",
      "minimum_quality_improvement",
      "p05_quality_improvement",
      "median_quality_improvement",
      "p95_quality_improvement",
      "maximum_quality_improvement",
    ]) summary[field] = 0.75;
    const { reportPath: summaryReportPath } = createBundle({ commitGate: summaryGate });
    expect(() => verifyQualityReport({ reportPath: summaryReportPath, schemaPath }))
      .toThrow(/differs from the paired comparisons/);

    const sizeGate = firstTierGate();
    sizeGate.pairs[0].reference_size_bytes = 900;
    const { reportPath: sizeReportPath } = createBundle({ commitGate: sizeGate });
    expect(() => verifyQualityReport({ reportPath: sizeReportPath, schemaPath }))
      .toThrow(/size_delta_percent differs from its byte sizes/);
  });

  it("requires unique fixture ids and category slices that match the pair inventory", () => {
    const duplicateGate = firstTierGate();
    duplicateGate.pairs[1].fixture_id = duplicateGate.pairs[0].fixture_id;
    const { reportPath: duplicateReportPath } = createBundle({ commitGate: duplicateGate });
    expect(() => verifyQualityReport({ reportPath: duplicateReportPath, schemaPath }))
      .toThrow(/repeats fixture_id/);

    const categoryGate = firstTierGate();
    categoryGate.pairs[0].category = categoryGate.pairs[4].category;
    const { reportPath: categoryReportPath } = createBundle({ commitGate: categoryGate });
    expect(() => verifyQualityReport({ reportPath: categoryReportPath, schemaPath }))
      .toThrow(/(expected|eligible)_pair_count differs/);
  });

  it("rejects forged metric, slice, and final acceptance pass flags", () => {
    const metricGate = firstTierGate();
    metricGate.overall.metrics.find(({ metric_id }) => metric_id === "cambi_mean").passed = false;
    const { reportPath: metricReportPath } = createBundle({ commitGate: metricGate });
    expect(() => verifyQualityReport({ reportPath: metricReportPath, schemaPath }))
      .toThrow(/passed is inconsistent with the v1 acceptance policy/);

    const sliceGate = firstTierGate();
    sliceGate.overall.passed = false;
    const { reportPath: sliceReportPath } = createBundle({ commitGate: sliceGate });
    expect(() => verifyQualityReport({ reportPath: sliceReportPath, schemaPath }))
      .toThrow(/passed is inconsistent with its coverage and metric gates/);

    const finalGate = firstTierGate({ passed: false, violations: ["VMAF regression"] });
    finalGate.passed = true;
    const { reportPath: finalReportPath } = createBundle({ commitGate: finalGate });
    expect(() => verifyQualityReport({ reportPath: finalReportPath, schemaPath }))
      .toThrow(/passed is inconsistent with the v1 acceptance policy/);
  });

  it("allows internally bound non-canonical diagnostics but binds strict reports to the checked-in manifest", () => {
    const diagnosticGate = firstTierGate({ passed: false, violations: ["non-canonical diagnostic corpus"] });
    diagnosticGate.canonical_corpus_passed = false;
    diagnosticGate.corpus_manifest_sha256 = "e".repeat(64);
    const { reportPath } = createBundle({ commitGate: diagnosticGate });
    expect(verifyQualityReport({ reportPath, schemaPath })).toMatchObject({
      first_tier_quality_passed: false,
    });
    expect(() => verifyQualityReport({ reportPath, schemaPath, requireFirstTierQuality: true }))
      .toThrow(/did not use the canonical corpus/);
  });

  it("compares a claimed canonical embedded manifest with the checked-in Rust serialization", () => {
    const fixtureWithoutFilter = canonicalManifest.fixtures.find(
      ({ generator }) => !Object.hasOwn(generator, "video_filter"),
    );
    expect(fixtureWithoutFilter).toBeDefined();
    expect(
      canonicalReportManifest.fixtures.find(({ id }) => id === fixtureWithoutFilter.id).generator.video_filter,
    ).toBeNull();

    const { reportPath } = createBundle();
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.manifest.description = `${report.manifest.description} tampered`;
    writeFileSync(reportPath, JSON.stringify(report));
    expect(() => verifyQualityReport({ reportPath, schemaPath }))
      .toThrow(/Commit-point report embedded manifest differs from the Rust-serialized checked-in/);
  });

  it("binds report sources to manifest fixtures and the gate pair/omission inventory", () => {
    const { reportPath: categoryReportPath } = createBundle();
    const categoryReport = JSON.parse(readFileSync(categoryReportPath, "utf8"));
    categoryReport.sources[0].category = categoryReport.sources.find(
      ({ category }) => category !== categoryReport.sources[0].category,
    ).category;
    writeFileSync(categoryReportPath, JSON.stringify(categoryReport));
    expect(() => verifyQualityReport({ reportPath: categoryReportPath, schemaPath }))
      .toThrow(/sources category differs from manifest/);

    const { reportPath: missingReportPath } = createBundle();
    const missingReport = JSON.parse(readFileSync(missingReportPath, "utf8"));
    missingReport.sources.pop();
    writeFileSync(missingReportPath, JSON.stringify(missingReport));
    expect(() => verifyQualityReport({ reportPath: missingReportPath, schemaPath }))
      .toThrow(/gate\/source inventory fixture count differs/);
  });

  it("recomputes every source identity instead of trusting sealed flags", () => {
    const { reportPath: expectedPath } = createBundle();
    const expectedReport = JSON.parse(readFileSync(expectedPath, "utf8"));
    expectedReport.sources[0].expected_source_sha256 = "e".repeat(64);
    writeFileSync(expectedPath, JSON.stringify(expectedReport));
    expect(() => verifyQualityReport({ reportPath: expectedPath, schemaPath }))
      .toThrow(/expected_source_sha256 differs from the manifest/);

    const { reportPath: flagPath } = createBundle();
    const flagReport = JSON.parse(readFileSync(flagPath, "utf8"));
    flagReport.sources[0].canonical_identity_passed = true;
    writeFileSync(flagPath, JSON.stringify(flagReport));
    expect(() => verifyQualityReport({ reportPath: flagPath, schemaPath }))
      .toThrow(/canonical_identity_passed disagrees with its SHA-256/);
  });

  it("rejects a forged canonical fixture or generator identity pass", () => {
    const identityGate = firstTierGate({ identityPassed: true, passed: true });
    const { reportPath: identityPath } = createBundle({ commitGate: identityGate });
    expect(() => verifyQualityReport({ reportPath: identityPath, schemaPath }))
      .toThrow(/canonical_fixture_identity_passed disagrees/);

    const { reportPath: generatorPath } = createBundle();
    const generatorReport = JSON.parse(readFileSync(generatorPath, "utf8"));
    generatorReport.toolchain.canonical_generator_identity_passed = true;
    writeFileSync(generatorPath, JSON.stringify(generatorReport));
    expect(() => verifyQualityReport({ reportPath: generatorPath, schemaPath }))
      .toThrow(/canonical_generator_identity_passed disagrees/);
  });

  it("requires commit-point and sealed report manifest hashes to match", () => {
    const commitGate = firstTierGate({ passed: false, violations: ["non-canonical commit point"] });
    commitGate.canonical_corpus_passed = false;
    commitGate.corpus_manifest_sha256 = "e".repeat(64);
    const bundleGate = firstTierGate({ passed: false, violations: ["non-canonical snapshot"] });
    bundleGate.canonical_corpus_passed = false;
    bundleGate.corpus_manifest_sha256 = "f".repeat(64);
    const { reportPath } = createBundle({ commitGate, bundleGate });
    expect(() => verifyQualityReport({ reportPath, schemaPath }))
      .toThrow("Commit-point and bundled report manifest_sha256 differ");
  });

  it("rejects a commit-point gate that differs from the sealed report", () => {
    const commitGate = firstTierGate();
    const bundleGate = firstTierGate({ passed: false, violations: ["sealed failure"] });
    const { reportPath } = createBundle({ commitGate, bundleGate });
    expect(() => verifyQualityReport({ reportPath, schemaPath })).toThrow(
      "Commit-point and bundled best_quality_acceptance differ",
    );
  });

  it("wires the strict CLI flag to a failing process status", () => {
    const gate = firstTierGate({ passed: false, violations: ["temporal regression"] });
    const { reportPath } = createBundle({ commitGate: gate });
    const result = spawnSync(process.execPath, [
      verifierPath,
      "--report",
      reportPath,
      "--schema",
      schemaPath,
      "--require-first-tier-quality",
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("complete reviewed identity");
  });

  it("rejects a field excluded by the top-level JSON schema", () => {
    const { reportPath } = createBundle();
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.unversioned_field = true;
    writeFileSync(reportPath, JSON.stringify(report));
    expect(() => verifyQualityReport({ reportPath, schemaPath })).toThrow("unknown field 'unversioned_field'");
  });

  it("rejects a bundle artifact changed after the manifest was sealed", () => {
    const { reportPath, bundleRoot } = createBundle();
    writeFileSync(join(bundleRoot, "report.csv"), "tampered\n");
    expect(() => verifyQualityReport({ reportPath, schemaPath })).toThrow(/Artifact (size|SHA-256) mismatch/);
  });
});
