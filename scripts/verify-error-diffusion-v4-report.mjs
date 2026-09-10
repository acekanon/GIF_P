import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyQualityReport } from "./verify-quality-report.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = resolve(
  workspaceRoot,
  "test",
  "private-real-error-diffusion-v4-focused-manifest.json",
);
const expectedCorpusId = "private-real-error-diffusion-v4-focused-20260718";
const expectedManifestSha256 = "a391c58633bfe4c61b76fac316b6b58e68b63d3285a3f2b16354df4059136649";
const expectedProfileId = "rust-writer-subject";
const expectedKernelId = "oklab_hybrid_edge_aware_serpentine_fs_temporal_v4";
const expectedSelectorId = "rust.oklab.cell_error_diffusion_triple_candidate.v3";
const expectedGateId = "error_diffusion_vfr_loop_banding_pareto_v2";
const selectedRouteId = "error_diffusion_temporal";

const expectedFixtureIds = [
  "real-gacha-flat-mixed",
  "real-avatar-skin-subtle",
  "real-dance-high-motion",
  "real-cat-greenscreen-hard-edge",
  "real-drama-subtitle-skin",
];
const gradientOrSkinFixtureIds = new Set([
  "real-gacha-flat-mixed",
  "real-avatar-skin-subtle",
]);
const hardEdgeOrSubtitleFixtureIds = new Set([
  "real-cat-greenscreen-hard-edge",
  "real-drama-subtitle-skin",
]);
const highMotionFixtureId = "real-dance-high-motion";

// These are the unchanged v2 material-banding ceilings derived from the
// previously frozen FFmpeg baselines: candidate + 0.0001 < baseline * 0.92.
// A selected v4 route must beat both its report baselines and this independent
// corpus ceiling, so moving a baseline cannot manufacture a promotion.
const fixedSelectedBandingCeilings = new Map([
  ["real-gacha-flat-mixed", 0.006055134799537724],
  ["real-avatar-skin-subtle", 0.00012714571660160797],
  ["real-cat-greenscreen-hard-edge", 0.0008560221316154169],
  ["real-drama-subtitle-skin", 0.04278471613922857],
]);

const HELP = `GIFP v4 focused real-media report verifier

Usage:
  node scripts/verify-error-diffusion-v4-report.mjs --report PATH [--manifest PATH] [--schema PATH]

The verifier first validates the immutable Quality Lab artifact bundle, then
requires a clean Release run of the five-fixture v4 focused corpus. It checks
correctness, the frozen hybrid-v4 kernel/input contract, exact fallback
preservation, residual accounting, the unchanged production v2 dual-baseline
gate, two distinct real-media promotions, and the high-motion rejection.
`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read ${label} ${path}: ${error.message}`);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function object(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  return value;
}

function finiteNumber(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value), `${label} is not a finite number`);
  return value;
}

function nonnegativeCount(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} is not a non-negative safe integer`);
  return value;
}

function positiveCount(value, label) {
  nonnegativeCount(value, label);
  invariant(value > 0, `${label} must be greater than zero`);
  return value;
}

function sha256(value, label) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${label} is not a SHA-256`);
  return value;
}

function metric(metrics, name, label) {
  return finiteNumber(object(metrics, label)[name], `${label}.${name}`);
}

function hasMaterialQualityGain(candidate, baseline, label) {
  return (
    metric(candidate, "mean_oklab_error", label) + 0.0005 <
      metric(baseline, "mean_oklab_error", `${label} baseline`) * 0.97 ||
    metric(candidate, "multiscale_low_frequency_oklab_error", label) + 0.0004 <
      metric(baseline, "multiscale_low_frequency_oklab_error", `${label} baseline`) * 0.96 ||
    metric(candidate, "multiscale_banding_score", label) + 0.0005 <
      metric(baseline, "multiscale_banding_score", `${label} baseline`) * 0.98 ||
    metric(candidate, "static_temporal_residual", label) + 0.0002 <
      metric(baseline, "static_temporal_residual", `${label} baseline`) * 0.95 ||
    metric(candidate, "multiscale_static_temporal_residual", label) + 0.00015 <
      metric(baseline, "multiscale_static_temporal_residual", `${label} baseline`) * 0.95
  );
}

function regionalGateFailures(candidate, baseline, candidateBytes, baselineBytes, label) {
  const failures = [];
  const checks = [
    ["mean_oklab_error", 1.06, 0.001],
    ["p95_oklab_error", 1.08, 0.002],
    ["edge_weighted_mean_oklab_error", 1.05, 0.001],
    ["multiscale_low_frequency_oklab_error", 1.04, 0.00075],
    ["multiscale_banding_score", 1.02, 0.0005],
    ["edge_gradient_error", 1.05, 0.002],
    ["static_temporal_residual", 1.02, 0.0005],
    ["multiscale_static_temporal_residual", 1.02, 0.0004],
  ];
  for (const [name, factor, allowance] of checks) {
    if (metric(candidate, name, label) > metric(baseline, name, `${label} baseline`) * factor + allowance) {
      failures.push(`regional:${name}`);
    }
  }
  const byteCeiling = Math.ceil((baselineBytes * 105) / 100);
  if (candidateBytes > byteCeiling && !hasMaterialQualityGain(candidate, baseline, label)) {
    failures.push("regional:serialized_bytes");
  }
  return failures;
}

function nullableMetric(timing, name, label) {
  const value = object(timing, label)[name];
  if (value === null) return null;
  return finiteNumber(value, `${label}.${name}`);
}

function timingGateFailures(candidate, baseline, label) {
  const failures = [];
  const candidateTiming = object(candidate, label);
  const baselineTiming = object(baseline, `${label} baseline`);
  const countNames = [
    "sampled_static_transition_count",
    "sampled_multiscale_static_transition_count",
  ];
  for (const name of countNames) {
    const candidateCount = nonnegativeCount(candidateTiming[name], `${label}.${name}`);
    const baselineCount = nonnegativeCount(baselineTiming[name], `${label} baseline.${name}`);
    if (candidateCount !== baselineCount) failures.push(`timing:${name}`);
  }
  const weightedNames = [
    "weighted_static_temporal_residual",
    "weighted_multiscale_static_temporal_residual",
  ];
  for (const name of weightedNames) {
    if (
      finiteNumber(candidateTiming[name], `${label}.${name}`) >
      finiteNumber(baselineTiming[name], `${label} baseline.${name}`) * 1.005 + 0.0000001
    ) {
      failures.push(`timing:${name}`);
    }
  }
  const seamNames = [
    "loop_seam_static_temporal_residual",
    "loop_seam_multiscale_static_temporal_residual",
  ];
  for (const name of seamNames) {
    const candidateValue = nullableMetric(candidateTiming, name, label);
    const baselineValue = nullableMetric(baselineTiming, name, `${label} baseline`);
    if ((candidateValue === null) !== (baselineValue === null)) {
      failures.push(`timing:${name}:contract`);
    } else if (
      candidateValue !== null &&
      candidateValue > baselineValue * 1.005 + 0.0000001
    ) {
      failures.push(`timing:${name}`);
    }
  }
  return failures;
}

function errorDiffusionGateFailures({
  candidate,
  baseline,
  candidateTiming,
  baselineTiming,
  candidateBytes,
  baselineBytes,
  eligiblePixels,
  diffusedPixels,
  label,
}) {
  const failures = regionalGateFailures(candidate, baseline, candidateBytes, baselineBytes, label);
  if (eligiblePixels === 0 || diffusedPixels === 0) failures.push("diffusion:no_material_work");
  const checks = [
    ["mean_oklab_error", 1.01, 0.0001],
    ["p95_oklab_error", 1.01, 0.0002],
    ["edge_weighted_mean_oklab_error", 1.01, 0.0001],
    ["multiscale_low_frequency_oklab_error", 1.01, 0.0001],
    ["multiscale_banding_score", 1.01, 0.0001],
    ["edge_gradient_error", 1.01, 0.0002],
    ["static_temporal_residual", 1.005, 0.000005],
    ["multiscale_static_temporal_residual", 1.005, 0.000005],
  ];
  for (const [name, factor, allowance] of checks) {
    if (metric(candidate, name, label) > metric(baseline, name, `${label} baseline`) * factor + allowance) {
      failures.push(`diffusion:${name}`);
    }
  }
  if (candidateBytes > Math.ceil((baselineBytes * 105) / 100)) {
    failures.push("diffusion:serialized_bytes");
  }
  failures.push(...timingGateFailures(candidateTiming, baselineTiming, `${label} timing`));
  const baselineBanding = metric(baseline, "multiscale_banding_score", `${label} baseline`);
  const candidateBanding = metric(candidate, "multiscale_banding_score", label);
  if (!(baselineBanding > 0.0001 && candidateBanding + 0.0001 < baselineBanding * 0.92)) {
    failures.push("diffusion:material_banding_gain");
  }
  return failures;
}

function verifyCandidateDiagnostics(candidate, selection, run, label) {
  invariant(candidate.spatial_kernel_id === expectedKernelId, `${label} candidate kernel is not frozen v4`);
  invariant(selection.spatial_kernel_id === expectedKernelId, `${label} selection kernel is not frozen v4`);
  sha256(candidate.kernel_config_sha256, `${label} candidate.kernel_config_sha256`);
  invariant(
    candidate.kernel_config_sha256 === selection.kernel_config_sha256,
    `${label} candidate/selection kernel config hashes differ`,
  );
  for (const name of [
    "source_rgb24_sha256",
    "palette_sha256",
    "region_dither_sha256",
    "frame_delays_sha256",
    "input_contract_sha256",
    "fallback_indices_sha256",
  ]) {
    sha256(selection[name], `${label} selection.${name}`);
  }
  sha256(candidate.fallback_indices_sha256, `${label} candidate.fallback_indices_sha256`);
  invariant(
    candidate.fallback_indices_sha256 === selection.fallback_indices_sha256,
    `${label} fallback hashes differ`,
  );
  invariant(
    candidate.fallback_route_id === selection.fallback_route_id &&
      selection.fallback_route_id === selection.comparison_route_id,
    `${label} fallback route is not the audited comparison route`,
  );
  for (const name of [
    "indices_sha256",
    "reconstructed_rgb24_sha256",
    "artifact_sha256",
    "indexed_timeline_sha256",
    "serialized_gif_sha256",
  ]) {
    sha256(candidate[name], `${label} candidate.${name}`);
  }

  const eligiblePixels = positiveCount(
    candidate.gradient_eligible_pixel_count,
    `${label} candidate.gradient_eligible_pixel_count`,
  );
  const diffusedPixels = positiveCount(candidate.diffused_pixel_count, `${label} candidate.diffused_pixel_count`);
  const eligibleChanges = positiveCount(
    candidate.eligible_index_change_count,
    `${label} candidate.eligible_index_change_count`,
  );
  const fallbackPreserved = positiveCount(
    candidate.fallback_preserved_pixel_count,
    `${label} candidate.fallback_preserved_pixel_count`,
  );
  invariant(
    candidate.ineligible_index_change_count === 0,
    `${label} changed an ineligible fallback index`,
  );
  invariant(diffusedPixels === eligibleChanges, `${label} diffusion/index-change accounting differs`);
  invariant(eligibleChanges <= eligiblePixels, `${label} changed more eligible indices than it classified`);
  invariant(
    Array.isArray(candidate.diffused_pixel_by_class) &&
      candidate.diffused_pixel_by_class.length === 4 &&
      candidate.diffused_pixel_by_class.reduce(
        (sum, count, index) => sum + nonnegativeCount(count, `${label} diffused_pixel_by_class[${index}]`),
        0,
      ) === diffusedPixels,
    `${label} per-class diffusion accounting does not close`,
  );
  const eligibleRate = finiteNumber(
    candidate.eligible_index_change_rate,
    `${label} candidate.eligible_index_change_rate`,
  );
  invariant(
    Math.abs(eligibleRate - eligibleChanges / eligiblePixels) <= Number.EPSILON * 8,
    `${label} eligible index-change rate disagrees with its counts`,
  );
  const inspection = object(run.output_inspection, `${label} output_inspection`);
  const fullTimelinePixels =
    positiveCount(inspection.width, `${label} output width`) *
    positiveCount(inspection.height, `${label} output height`) *
    positiveCount(inspection.frame_count, `${label} output frame_count`);
  invariant(Number.isSafeInteger(fullTimelinePixels), `${label} full timeline pixel count overflowed`);
  invariant(
    fallbackPreserved + eligibleChanges + candidate.ineligible_index_change_count === fullTimelinePixels,
    `${label} fallback/change pixel accounting does not cover the timeline`,
  );
  invariant(candidate.cell_reset_count === 0, `${label} retained artificial cell error-buffer resets`);
  const frameResets = positiveCount(
    candidate.frame_error_buffer_reset_count,
    `${label} candidate.frame_error_buffer_reset_count`,
  );
  invariant(
    frameResets === run.result.indexed_gif_writer_report.frame_count,
    `${label} did not reset the full-frame buffer exactly once per frame`,
  );

  const residualCandidates = positiveCount(
    candidate.residual_link_candidate_count,
    `${label} candidate.residual_link_candidate_count`,
  );
  const residualClosure =
    nonnegativeCount(
      candidate.full_conductance_residual_link_count,
      `${label} candidate.full_conductance_residual_link_count`,
    ) +
    nonnegativeCount(
      candidate.attenuated_residual_link_count,
      `${label} candidate.attenuated_residual_link_count`,
    ) +
    nonnegativeCount(candidate.blocked_residual_link_count, `${label} candidate.blocked_residual_link_count`);
  invariant(residualCandidates === residualClosure, `${label} residual-link accounting does not close`);

  const crossCellCandidates = positiveCount(
    candidate.cross_cell_candidate_link_count,
    `${label} candidate.cross_cell_candidate_link_count`,
  );
  const crossCellClosure =
    nonnegativeCount(
      candidate.cross_cell_propagated_link_count,
      `${label} candidate.cross_cell_propagated_link_count`,
    ) +
    nonnegativeCount(
      candidate.cross_cell_rejected_class_count,
      `${label} candidate.cross_cell_rejected_class_count`,
    ) +
    nonnegativeCount(
      candidate.cross_cell_rejected_eligibility_count,
      `${label} candidate.cross_cell_rejected_eligibility_count`,
    ) +
    nonnegativeCount(
      candidate.cross_cell_blocked_hard_edge_count,
      `${label} candidate.cross_cell_blocked_hard_edge_count`,
    );
  invariant(crossCellCandidates === crossCellClosure, `${label} cross-cell accounting does not close`);
  const crossCellPropagated = nonnegativeCount(
    candidate.cross_cell_propagated_link_count,
    `${label} candidate.cross_cell_propagated_link_count`,
  );

  return { eligiblePixels, diffusedPixels, crossCellPropagated };
}

function expectedSelectionStatus(qualityPassed, selectionPassed) {
  if (selectionPassed) return "candidate_selected";
  if (qualityPassed) return "selection_gate_rejected";
  return "quality_gate_rejected";
}

function verifyRun(run, fixtureId) {
  const label = `${fixtureId}/${expectedProfileId}`;
  object(run, label);
  invariant(run.fixture_id === fixtureId, `${label} fixture_id mismatch`);
  invariant(run.profile_id === expectedProfileId, `${label} profile_id mismatch`);
  invariant(run.status === "ok", `${label} run status is not ok`);
  sha256(run.source_sha256, `${label} source_sha256`);
  sha256(run.request_sha256, `${label} request_sha256`);
  sha256(run.output_sha256, `${label} output_sha256`);

  const correctness = object(run.correctness, `${label} correctness`);
  invariant(correctness.all_passed === true, `${label} correctness did not pass`);
  invariant(
    correctness.duration_passed === true &&
      correctness.frame_count_passed === true &&
      correctness.alpha_passed === true &&
      correctness.seamless_loop_passed === true,
    `${label} has a failed correctness component`,
  );
  invariant(Array.isArray(correctness.violations) && correctness.violations.length === 0, `${label} has violations`);

  const inspection = object(run.output_inspection, `${label} output_inspection`);
  invariant(inspection.codec === "gif" && inspection.animated === true, `${label} is not an animated GIF`);
  positiveCount(inspection.frame_count, `${label} output frame_count`);
  finiteNumber(inspection.duration, `${label} output duration`);

  const result = object(run.result, `${label} result`);
  invariant(result.status === "done", `${label} result status is not done`);
  invariant(result.backend_id === "rust.indexed_gif.experimental", `${label} did not execute the Rust writer`);
  invariant(typeof result.encoder_used === "string" && result.encoder_used.startsWith("rust_indexed_gif_"), `${label} did not retain a Rust writer output`);
  invariant(result.output_format === "gif" && result.output_codec === "gif", `${label} result is not GIF`);
  invariant(Array.isArray(result.warnings) && result.warnings.length === 0, `${label} emitted warnings`);

  const writer = object(result.indexed_gif_writer_report, `${label} indexed writer report`);
  invariant(writer.status === "encoded_experimental", `${label} writer status is not encoded_experimental`);
  invariant(writer.decoded_pixel_parity_verified === true, `${label} decoded pixel parity failed`);
  invariant(writer.disposal_simulation_verified === true, `${label} disposal simulation failed`);
  invariant(writer.frame_count === inspection.frame_count, `${label} writer/output frame counts differ`);

  const regional = object(writer.regional_quantizer_report, `${label} regional quantizer report`);
  const selection = object(regional.error_diffusion_selection, `${label} error diffusion selection`);
  invariant(selection.selector_id === expectedSelectorId, `${label} selector identity changed`);
  invariant(selection.gate_id === expectedGateId, `${label} production quality gate identity changed`);
  invariant(!Object.hasOwn(selection, "gate_overrides"), `${label} exposes gate overrides in a release report`);
  const candidate = object(selection.candidate, `${label} candidate`);
  const { eligiblePixels, diffusedPixels, crossCellPropagated } = verifyCandidateDiagnostics(
    candidate,
    selection,
    run,
    label,
  );

  const candidateBytes = positiveCount(candidate.serialized_bytes, `${label} candidate.serialized_bytes`);
  const ffmpegBytes = positiveCount(
    selection.ffmpeg_baseline_serialized_bytes,
    `${label} selection.ffmpeg_baseline_serialized_bytes`,
  );
  const comparisonBytes = positiveCount(
    selection.comparison_serialized_bytes,
    `${label} selection.comparison_serialized_bytes`,
  );
  const ffmpegFailures = errorDiffusionGateFailures({
    candidate: candidate.metrics,
    baseline: selection.ffmpeg_baseline_metrics,
    candidateTiming: candidate.timing_metrics,
    baselineTiming: selection.ffmpeg_baseline_timing_metrics,
    candidateBytes,
    baselineBytes: ffmpegBytes,
    eligiblePixels,
    diffusedPixels,
    label: `${label} vs FFmpeg`,
  });
  const comparisonFailures = errorDiffusionGateFailures({
    candidate: candidate.metrics,
    baseline: selection.comparison_metrics,
    candidateTiming: candidate.timing_metrics,
    baselineTiming: selection.comparison_timing_metrics,
    candidateBytes,
    baselineBytes: comparisonBytes,
    eligiblePixels,
    diffusedPixels,
    label: `${label} vs comparison`,
  });
  const recomputedQualityPassed = ffmpegFailures.length === 0;
  const recomputedSelectionPassed = recomputedQualityPassed && comparisonFailures.length === 0;
  invariant(
    selection.quality_gate_passed === recomputedQualityPassed,
    `${label} quality_gate_passed disagrees with the frozen v2 gate: ${ffmpegFailures.join(", ")}`,
  );
  invariant(
    selection.selection_gate_passed === recomputedSelectionPassed,
    `${label} selection_gate_passed disagrees with the frozen dual gate: ${comparisonFailures.join(", ")}`,
  );
  invariant(
    selection.status === expectedSelectionStatus(recomputedQualityPassed, recomputedSelectionPassed),
    `${label} selection status disagrees with the recomputed gate`,
  );

  if (recomputedSelectionPassed) {
    invariant(regional.selected_route_id === selectedRouteId, `${label} passed but was not selected`);
    invariant(selection.fallback_reason === null, `${label} selected candidate has a fallback reason`);
    invariant(
      writer.indexed_timeline_sha256 === candidate.indexed_timeline_sha256,
      `${label} selected candidate is not the writer timeline`,
    );
    invariant(run.output_sha256 === candidate.serialized_gif_sha256, `${label} selected candidate is not the published GIF`);
    const fixedCeiling = fixedSelectedBandingCeilings.get(fixtureId);
    invariant(fixedCeiling !== undefined, `${label} has no fixed corpus banding ceiling`);
    invariant(
      metric(candidate.metrics, "multiscale_banding_score", `${label} candidate metrics`) < fixedCeiling,
      `${label} was selected without beating the frozen corpus banding ceiling`,
    );
  } else {
    invariant(regional.selected_route_id !== selectedRouteId, `${label} failed the gate but was selected`);
    invariant(
      typeof selection.fallback_reason === "string" && selection.fallback_reason.length > 0,
      `${label} rejected candidate has no fallback reason`,
    );
  }

  return {
    fixtureId,
    selected: recomputedSelectionPassed,
    ffmpegFailures,
    comparisonFailures,
    baselineBanding: metric(
      selection.ffmpeg_baseline_metrics,
      "multiscale_banding_score",
      `${label} FFmpeg baseline`,
    ),
    crossCellPropagated,
    fallbackReason: selection.fallback_reason,
  };
}

export function verifyErrorDiffusionV4Report({ reportPath, manifestPath = defaultManifestPath, schemaPath }) {
  const reportAbsolute = resolve(reportPath);
  const manifestAbsolute = resolve(manifestPath);
  const immutableBundle = verifyQualityReport({ reportPath: reportAbsolute, schemaPath });
  const report = readJson(reportAbsolute, "v4 quality report");
  const manifest = readJson(manifestAbsolute, "v4 focused manifest");

  invariant(report.schema_version >= 9, `Unsupported Quality Lab schema ${report.schema_version}`);
  invariant(report.git_dirty === false, "Report was not produced from a clean Git worktree");
  invariant(
    typeof report.git_commit === "string" && /^[0-9a-f]{40}$/.test(report.git_commit),
    "Report has no full Git commit identity",
  );
  invariant(
    typeof report.run_id === "string" && report.run_id.startsWith(`${report.git_commit.slice(0, 12)}-`),
    "Report run_id is not anchored to its Git commit",
  );
  invariant(report.toolchain?.build_profile === "release", "Quality Lab did not run a Release binary");
  invariant(report.performance_baseline?.build_profile === "release", "Performance evidence is not Release-built");

  invariant(manifest.corpus_id === expectedCorpusId, "Local focused manifest corpus_id changed");
  invariant(report.manifest?.corpus_id === expectedCorpusId, "Report did not embed the v4 focused corpus");
  const manifestSha256 = sha256File(manifestAbsolute);
  invariant(manifestSha256 === expectedManifestSha256, "Local focused manifest bytes changed");
  invariant(report.manifest_sha256 === manifestSha256, "Report manifest SHA-256 does not match the focused manifest");
  invariant(
    canonicalJson(report.manifest) === canonicalJson(manifest),
    "Report embedded manifest differs from the focused manifest",
  );
  invariant(Array.isArray(manifest.profiles) && manifest.profiles.length === 2, "Focused manifest must contain the blind-reference pair");
  const subjectProfile = manifest.profiles.find((profile) => profile.id === expectedProfileId);
  const referenceProfile = manifest.profiles.find((profile) => profile.id === "fast-baseline");
  invariant(subjectProfile?.allow_experimental === true, "Focused manifest did not enable the candidate route");
  invariant(referenceProfile?.allow_experimental === false, "Focused manifest reference route changed");

  invariant(report.successful_runs === 10 && report.failed_runs === 0, "Focused blind-pair run is not 10/10 successful");
  invariant(Array.isArray(report.runs) && report.runs.length === 10, "Focused report must contain exactly ten runs");
  invariant(Array.isArray(report.sources) && report.sources.length === 5, "Focused report must contain exactly five sources");
  const sourceIds = report.sources.map((source) => source.fixture_id).sort();
  invariant(
    JSON.stringify(sourceIds) === JSON.stringify([...expectedFixtureIds].sort()),
    "Focused report source set changed",
  );

  const runsByFixture = new Map();
  for (const run of report.runs.filter((candidate) => candidate.profile_id === expectedProfileId)) {
    invariant(!runsByFixture.has(run.fixture_id), `Duplicate run for ${run.fixture_id}`);
    runsByFixture.set(run.fixture_id, run);
  }
  const summaries = expectedFixtureIds.map((fixtureId) => {
    invariant(runsByFixture.has(fixtureId), `Missing focused run ${fixtureId}`);
    return verifyRun(runsByFixture.get(fixtureId), fixtureId);
  });

  const selected = summaries.filter((summary) => summary.selected);
  invariant(
    summaries.reduce((sum, summary) => sum + summary.crossCellPropagated, 0) > 0,
    "Focused corpus never exercised compatible cross-cell residual propagation",
  );
  invariant(
    selected.some((summary) => gradientOrSkinFixtureIds.has(summary.fixtureId)),
    "No gradient/skin real fixture promoted the v4 candidate",
  );
  invariant(
    selected.some((summary) => hardEdgeOrSubtitleFixtureIds.has(summary.fixtureId)),
    "No hard-edge/subtitle real fixture promoted the v4 candidate",
  );
  const highMotion = summaries.find((summary) => summary.fixtureId === highMotionFixtureId);
  invariant(highMotion && !highMotion.selected, "High-motion fixture must retain its protected fallback");
  invariant(
    highMotion.baselineBanding <= 0.0001,
    "High-motion rejection is not protected by the v2 material-banding floor",
  );
  invariant(
    highMotion.ffmpegFailures.includes("diffusion:material_banding_gain"),
    "High-motion candidate was not independently rejected by the material-gain gate",
  );

  return {
    report_path: reportAbsolute,
    run_id: report.run_id,
    git_commit: report.git_commit,
    kernel_id: expectedKernelId,
    fixture_count: summaries.length,
    selected_fixture_ids: selected.map((summary) => summary.fixtureId),
    rejected_fixture_ids: summaries.filter((summary) => !summary.selected).map((summary) => summary.fixtureId),
    artifact_count: immutableBundle.artifact_count,
    manifest_sha256: report.manifest_sha256,
  };
}

function parseArgs(args) {
  const options = { reportPath: null, manifestPath: defaultManifestPath, schemaPath: undefined };
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
      case "--manifest":
        options.manifestPath = value();
        break;
      case "--schema":
        options.schemaPath = value();
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
      const verified = verifyErrorDiffusionV4Report(options);
      console.log(
        `GIFP v4 focused report verified: ${verified.fixture_count}/5 correct, ${verified.selected_fixture_ids.length} promoted`,
      );
      console.log(`Promoted: ${verified.selected_fixture_ids.join(", ")}`);
      console.log(`Protected fallback: ${verified.rejected_fixture_ids.join(", ")}`);
      console.log(`Release commit: ${verified.git_commit}`);
      console.log(`Manifest SHA-256: ${verified.manifest_sha256}`);
    }
  } catch (error) {
    console.error(`GIFP v4 focused verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
