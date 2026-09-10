import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const template = readFileSync(
  resolve(process.cwd(), "bench/blind-report-template.html"),
  "utf8",
);

const candidate = (profileId: string, imageSrc: string) => ({
  profile_id: profileId,
  generation_mode: profileId.includes("size-match") ? "target_size" : "best_gif",
  image_src: imageSrc,
  correctness_passed: true,
  size_bytes: 100_000,
  frame_count: 20,
  encode_elapsed_ms: 500,
  palette_strategy: "full",
  target_size_bytes: 100_000,
  target_deviation_percent: 0,
  target_attempts: 2,
  target_fit_status: "target_exact",
  vmaf_neg_mean: 90,
  vmaf_neg_p05: 88,
  ssim_mean: 0.95,
  ms_ssim_mean: 0.98,
  ms_ssim_valid_ratio: 1,
  ciede2000_mean: 45,
  ciede2000_valid_ratio: 1,
  cambi_mean: 0.2,
  mean_oklab_error: 0.01,
  static_region_temporal_residual: 0.001,
  edge_preservation: 0.98,
  alpha_coverage_error: 0,
  loop_seam_excess_oklab: 0,
  encoder_used: profileId,
  backend_id: profileId,
});

const reportData = {
  schema_version: 2,
  run_id: "clean-run-1",
  generated_at_unix_ms: 1,
  corpus_id: "quality-corpus-v1",
  manifest_sha256: "a".repeat(64),
  git_commit: "b".repeat(40),
  git_dirty: false,
  reference_profile_id: "ffmpeg-size-match",
  candidate_profile_id: "best-current",
  formal_max_size_delta_percent: 5,
  expected_pairs: 1,
  available_pairs: 1,
  omitted_pairs: [],
  pairs: [
    {
      fixture_id: "skin-flat-portrait",
      category: "portrait-skin",
      tags: ["skin"],
      size_delta_percent: 0,
      formal_vote_eligible: true,
      candidate_a: candidate("ffmpeg-size-match", "a.gif"),
      candidate_b: candidate("best-current", "b.gif"),
    },
  ],
};

const storageKey = (data = reportData) =>
  `gifp-blind-votes:${data.run_id}:${data.reference_profile_id}:${data.candidate_profile_id}`;

function bootTemplate(data = reportData) {
  const html = template.replace("__GIFP_BLIND_DATA__", JSON.stringify(data));
  const body = html.match(/<body>([\s\S]*?)<script>\s*\(\(\) =>/);
  const script = html.match(/<script>\s*(\(\(\) =>[\s\S]*?)<\/script>\s*<\/body>/);
  if (!body || !script) throw new Error("Blind report template structure changed");
  document.body.innerHTML = body[1];
  new Function(script[1])();
}

function button(label: string) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter((node) => node.textContent === label);
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("offline blind report protocol v2", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("renders clean-run provenance and the correct CIEDE score direction", () => {
    bootTemplate();
    expect(document.body).toHaveTextContent("Commit bbbbbbbbbbbb");
    expect(document.body).toHaveTextContent("正式配对 1");
    expect(document.getElementById("summary")).not.toHaveTextContent("ffmpeg-size-match");
    expect(button("导出投票 JSON")).toBeDisabled();
    expect(template).not.toContain("${data.candidate_profile_id}-vs-${data.reference_profile_id}");
    expect(document.body).toHaveTextContent("CIEDE2000 质量分 ↑");
    expect(document.getElementById("reviewerLabel")).toHaveAttribute(
      "placeholder",
      "例如 reviewer-01",
    );
  });

  it("keeps a blind first vote formal and invalidates a later change even after identity is hidden", () => {
    bootTemplate();
    button("A 更好").click();
    expect(button("导出投票 JSON")).toBeEnabled();
    expect(document.body).toHaveTextContent("已计入正式盲测票");
    expect(document.getElementById("summary")).toHaveTextContent("正式票 1/1");

    button("揭示身份与指标").click();
    button("隐藏身份与指标").click();
    button("B 更好").click();
    expect(document.body).toHaveTextContent("已记录为探索票（投票前或改票前已揭示）");
    expect(document.getElementById("summary")).toHaveTextContent("正式票 0/1");

    const saved = JSON.parse(localStorage.getItem(storageKey()) ?? "{}");
    expect(saved.voteMeta["skin-flat-portrait"]).toMatchObject({
      revision_count: 1,
      identity_revealed_before_or_during_vote: true,
    });
    expect(saved.revealHistory["skin-flat-portrait"]).toBe(true);
  });

  it("keeps identity-reveal contamination after resetting selections", () => {
    bootTemplate();
    button("揭示身份与指标").click();
    expect(confirm).toHaveBeenCalledOnce();
    button("隐藏身份与指标").click();
    button("接近").click();
    expect(document.body).toHaveTextContent("已记录为探索票（投票前或改票前已揭示）");

    button("重置本轮盲测").click();
    expect(document.getElementById("summary")).toHaveTextContent("已投票 0/1");
    const saved = JSON.parse(localStorage.getItem(storageKey()) ?? "{}");
    expect(saved.votes).toEqual({});
    expect(saved.voteMeta).toEqual({});
    expect(saved.revealed).toEqual({});
    expect(saved.revealHistory["skin-flat-portrait"]).toBe(true);

    button("A 更好").click();
    expect(document.body).toHaveTextContent("已记录为探索票（投票前或改票前已揭示）");
    expect(document.getElementById("summary")).toHaveTextContent("正式票 0/1");
  });

  it("starts a clean state only for an explicitly confirmed new reviewer session", () => {
    bootTemplate();
    button("揭示身份与指标").click();
    button("隐藏身份与指标").click();
    button("A 更好").click();
    const previous = JSON.parse(localStorage.getItem(storageKey()) ?? "{}");

    button("开始新评审会话").click();
    const next = JSON.parse(localStorage.getItem(storageKey()) ?? "{}");
    expect(next.reviewerId).not.toBe(previous.reviewerId);
    expect(next.votes).toEqual({});
    expect(next.voteMeta).toEqual({});
    expect(next.revealHistory).toEqual({});
    expect(document.getElementById("summary")).toHaveTextContent("已投票 0/1");
  });

  it("isolates votes for two profile pairs from the same quality run", () => {
    bootTemplate();
    button("A 更好").click();

    const regionalData = {
      ...reportData,
      reference_profile_id: "ffmpeg-regional-size-match",
      candidate_profile_id: "regional-experimental",
      pairs: [
        {
          ...reportData.pairs[0],
          candidate_a: candidate("ffmpeg-regional-size-match", "regional-a.gif"),
          candidate_b: candidate("regional-experimental", "regional-b.gif"),
        },
      ],
    };
    bootTemplate(regionalData);
    expect(document.getElementById("summary")).toHaveTextContent("已投票 0/1");
    button("B 更好").click();

    const defaultSaved = JSON.parse(localStorage.getItem(storageKey()) ?? "{}");
    const regionalSaved = JSON.parse(
      localStorage.getItem(storageKey(regionalData)) ?? "{}",
    );
    expect(defaultSaved.votes["skin-flat-portrait"]).toBe("A");
    expect(regionalSaved.votes["skin-flat-portrait"]).toBe("B");
  });
});
