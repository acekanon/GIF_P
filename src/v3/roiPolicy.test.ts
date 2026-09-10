import { describe, expect, it } from "vitest";
import type { PerceptualReport } from "../tauri";
import { assessRoiReadiness } from "./roiPolicy";

function report(overrides: Partial<PerceptualReport> = {}): PerceptualReport {
  return {
    analysis_frame_count: 24,
    kept_frame_count: 20,
    dropped_frame_count: 4,
    kept_ratio: 0.83,
    variable_delay_frames: 4,
    source_duration_ms: 3000,
    output_duration_ms: 3000,
    scene_boundary_count: 0,
    mean_motion: 0.08,
    mean_changed_area: 0.2,
    mean_edge_text: 0.1,
    mean_noise: 0.1,
    mean_smooth_gradient_ratio: 0.2,
    mean_subject_saliency: 0.7,
    mean_skin_ratio: 0.1,
    focus: "subject",
    filter_strategy: "neutral",
    effective_dither: "bayer",
    truncated: false,
    aggregate_timeline_verified: true,
    ...overrides,
  };
}

describe("GIFP 5.7 ROI readiness contract", () => {
  it("uses source alpha instead of asking SAM to rediscover the foreground", () => {
    expect(assessRoiReadiness({ hasAlpha: true })).toMatchObject({
      provider: "alpha_mask",
      readiness: "not_needed",
      samIncrementWorthTesting: false,
    });
  });

  it("selects the no-model motion baseline for a stable small changed area", () => {
    expect(assessRoiReadiness({ report: report() })).toMatchObject({
      contractVersion: 1,
      provider: "motion_baseline",
      readiness: "ready",
      samIncrementWorthTesting: true,
    });
  });

  it("rejects ROI layering for scene cuts or full-frame motion", () => {
    expect(assessRoiReadiness({ report: report({ mean_changed_area: 0.8 }) })).toMatchObject({
      provider: "none",
      readiness: "unsuitable",
    });
    expect(assessRoiReadiness({ report: report({ scene_boundary_count: 8 }) })).toMatchObject({
      provider: "none",
      readiness: "unsuitable",
    });
  });

  it("keeps SAM as an evidence-gated increment, not a default provider", () => {
    const assessment = assessRoiReadiness({
      report: report({ mean_changed_area: 0.5, mean_subject_saliency: 0.4 }),
    });
    expect(assessment).toMatchObject({
      provider: "content_saliency",
      readiness: "ready",
      samIncrementWorthTesting: false,
    });
  });
});
