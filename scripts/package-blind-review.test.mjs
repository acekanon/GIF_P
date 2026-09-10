import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditDeterministicZip,
  buildBlindReviewDistribution,
  extractBlindData,
  sha256Bytes,
  verifyPacketDirectory,
} from "./package-blind-review.mjs";

const temporaryRoots = [];
const cleanPackager = {
  git_commit: "c".repeat(40),
  git_dirty: false,
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function swaps(runId, fixtureId) {
  const digest = createHash("sha256").update(`${runId}:${fixtureId}`).digest();
  return (digest[digest.length - 1] & 1) === 1;
}

function candidate(profileId, imageSrc, sizeBytes) {
  return {
    profile_id: profileId,
    generation_mode: profileId.includes("size-match") ? "target_size" : "best_gif",
    image_src: imageSrc,
    correctness_passed: true,
    size_bytes: sizeBytes,
    frame_count: 20,
    duration_seconds: 3,
    encode_elapsed_ms: 500,
    encoder_used: profileId,
    backend_id: profileId,
    palette_strategy: "full",
    target_size_bytes: sizeBytes,
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
  };
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "gifp-blind-package-test-"));
  temporaryRoots.push(root);
  const reportPath = join(root, "clean.json");
  const runId = "cleanrun-1234567890";
  const fixtureId = "fixture-one";
  const profilePairs = [
    {
      reference: "ffmpeg-size-match",
      candidate: "best-current",
      page: join(root, "clean-blind.html"),
      assetRoot: `gifp-blind-assets-${runId}`,
    },
    {
      reference: "ffmpeg-regional-size-match",
      candidate: "regional-experimental",
      page: join(
        root,
        "clean-blind-regional-experimental-vs-ffmpeg-regional-size-match.html",
      ),
      assetRoot: `gifp-blind-assets-${runId}-regional-experimental-vs-ffmpeg-regional-size-match`,
    },
  ];
  const profiles = [
    {
      id: "best-current",
      generation_mode: "best_gif",
    },
    {
      id: "ffmpeg-size-match",
      generation_mode: "target_size",
      match_target_profile_id: "best-current",
      target_constraint: "symmetric_match",
    },
    {
      id: "regional-experimental",
      generation_mode: "best_gif",
    },
    {
      id: "ffmpeg-regional-size-match",
      generation_mode: "target_size",
      match_target_profile_id: "regional-experimental",
      target_constraint: "symmetric_match",
    },
  ];
  const runs = [];

  for (const [pairIndex, pair] of profilePairs.entries()) {
    const referenceBytes = Buffer.from(`GIF89a-${pairIndex}-reference-000000000000`);
    const candidateBytes = Buffer.from(`GIF89a-${pairIndex}-candidate-000000000000`);
    expect(referenceBytes.length).toBe(candidateBytes.length);
    const swap = swaps(runId, fixtureId);
    const aProfile = swap ? pair.candidate : pair.reference;
    const bProfile = swap ? pair.reference : pair.candidate;
    const bytes = new Map([
      [pair.reference, referenceBytes],
      [pair.candidate, candidateBytes],
    ]);
    const sourceA = join(root, pair.assetRoot, fixtureId, "a.gif");
    const sourceB = join(root, pair.assetRoot, fixtureId, "b.gif");
    mkdirSync(dirname(sourceA), { recursive: true });
    writeFileSync(sourceA, bytes.get(aProfile));
    writeFileSync(sourceB, bytes.get(bProfile));

    for (const profileId of [pair.reference, pair.candidate]) {
      const content = bytes.get(profileId);
      runs.push({
        fixture_id: fixtureId,
        profile_id: profileId,
        status: "ok",
        output_sha256: sha256Bytes(content),
        metrics: { size_bytes: content.length },
        correctness: { all_passed: true },
      });
    }
    const data = {
      schema_version: 5,
      run_id: runId,
      generated_at_unix_ms: 1_700_000_000_000,
      corpus_id: "test-corpus",
      manifest_sha256: "a".repeat(64),
      git_commit: "b".repeat(40),
      git_dirty: false,
      reference_profile_id: pair.reference,
      candidate_profile_id: pair.candidate,
      formal_max_size_delta_percent: 5,
      expected_pairs: 1,
      available_pairs: 1,
      omitted_pairs: [],
      pairs: [
        {
          fixture_id: fixtureId,
          category: "test-category",
          tags: ["test"],
          size_delta_percent: 0,
          formal_vote_eligible: true,
          candidate_a: candidate(
            aProfile,
            `${pair.assetRoot}/${fixtureId}/a.gif`,
            bytes.get(aProfile).length,
          ),
          candidate_b: candidate(
            bProfile,
            `${pair.assetRoot}/${fixtureId}/b.gif`,
            bytes.get(bProfile).length,
          ),
        },
      ],
    };
    writeFileSync(
      pair.page,
      `<script id="gifp-blind-data" type="application/json">${JSON.stringify(data)}</script>`,
      "utf8",
    );
  }

  const report = {
    schema_version: 5,
    run_id: runId,
    generated_at_unix_ms: 1_700_000_000_000,
    manifest_sha256: "a".repeat(64),
    git_commit: "b".repeat(40),
    git_dirty: false,
    manifest: {
      corpus_id: "test-corpus",
      profiles,
    },
    sources: [{ fixture_id: fixtureId, category: "test-category" }],
    runs,
  };
  writeFileSync(reportPath, JSON.stringify(report), "utf8");
  return { root, reportPath, profilePairs };
}

describe("blind-review distribution builder", () => {
  it("keeps reviewer and coordinator manifest contracts separate", () => {
    const packetSchema = JSON.parse(
      readFileSync(resolve("bench/blind-review-packet.schema.json"), "utf8"),
    );
    const distributionSchema = JSON.parse(
      readFileSync(resolve("bench/blind-review-distribution.schema.json"), "utf8"),
    );
    expect(packetSchema.properties.packet_protocol.const).toBe(
      "gifp-blind-review-packet-v1",
    );
    expect(packetSchema.properties).not.toHaveProperty("reference_profile_id");
    expect(packetSchema.properties).not.toHaveProperty("candidate_profile_id");
    expect(distributionSchema.$defs.packet.properties).toHaveProperty(
      "reference_profile_id",
    );
    expect(distributionSchema.$defs.packet.properties).toHaveProperty(
      "candidate_profile_id",
    );
  });

  it("creates two opaque, isolated and checksummed packet folders with balanced orders", () => {
    const fixture = makeFixture();
    const outputRoot = join(fixture.root, "distribution");
    const result = buildBlindReviewDistribution({
      reportPath: fixture.reportPath,
      outputRoot,
      reviewerCount: 3,
      templatePath: resolve("bench/blind-report-template.html"),
      archive: false,
      packagerProvenance: cleanPackager,
    });

    expect(result.distribution.packets).toHaveLength(2);
    for (const packet of result.distribution.packets) {
      const packetRoot = join(outputRoot, packet.packet_directory);
      const manifestText = readFileSync(join(packetRoot, "PACKET.json"), "utf8");
      expect(manifestText).not.toContain(packet.reference_profile_id);
      expect(manifestText).not.toContain(packet.candidate_profile_id);
      expect(verifyPacketDirectory(packetRoot).formal_pair_count).toBe(1);
      const data = extractBlindData(readFileSync(join(packetRoot, "OPEN-REVIEW.html"), "utf8"));
      expect(data.pairs[0].candidate_a.image_src).toBe("assets/pair-001/a.gif");
      expect(data.pairs[0].candidate_b.image_src).toBe("assets/pair-001/b.gif");
    }

    expect(readFileSync(join(outputRoot, "reviewer-assignments.csv"), "utf8")).toBe(
      [
        "reviewer_label,first_packet,second_packet",
        "reviewer-01,packet-01,packet-02",
        "reviewer-02,packet-02,packet-01",
        "reviewer-03,packet-01,packet-02",
        "",
      ].join("\n"),
    );
    const coordinator = readFileSync(join(outputRoot, "COORDINATOR.md"), "utf8");
    expect(coordinator).toContain("ffmpeg-regional-size-match");
    expect(coordinator).toContain("regional-experimental");
  });

  it("detects packet tampering after packaging", () => {
    const fixture = makeFixture();
    const outputRoot = join(fixture.root, "distribution");
    const result = buildBlindReviewDistribution({
      reportPath: fixture.reportPath,
      outputRoot,
      templatePath: resolve("bench/blind-report-template.html"),
      archive: false,
      packagerProvenance: cleanPackager,
    });
    const packet = result.distribution.packets[0];
    const packetRoot = join(outputRoot, packet.packet_directory);
    writeFileSync(join(packetRoot, "assets", "pair-001", "a.gif"), "tampered");
    expect(() => verifyPacketDirectory(packetRoot)).toThrow("checksum mismatch");
  });

  it("writes byte-identical ZIPs and audits their stored entries", () => {
    const fixture = makeFixture();
    const first = buildBlindReviewDistribution({
      reportPath: fixture.reportPath,
      outputRoot: join(fixture.root, "distribution-a"),
      templatePath: resolve("bench/blind-report-template.html"),
      archive: true,
      packagerProvenance: cleanPackager,
    });
    const second = buildBlindReviewDistribution({
      reportPath: fixture.reportPath,
      outputRoot: join(fixture.root, "distribution-b"),
      templatePath: resolve("bench/blind-report-template.html"),
      archive: true,
      packagerProvenance: cleanPackager,
    });
    expect(first.distribution.packets.map((packet) => packet.archive_sha256)).toEqual(
      second.distribution.packets.map((packet) => packet.archive_sha256),
    );
    const packet = first.distribution.packets[0];
    const audit = auditDeterministicZip(
      join(first.distributionRoot, packet.packet_directory),
      join(first.distributionRoot, packet.archive_name),
    );
    expect(audit.entryCount).toBe(packet.checksummed_file_count + 1);
    expect(audit.archiveSha256).toBe(packet.archive_sha256);
  });

  it("rejects source assets that no longer match the quality report", () => {
    const fixture = makeFixture();
    writeFileSync(
      join(
        fixture.root,
        `gifp-blind-assets-cleanrun-1234567890`,
        "fixture-one",
        "a.gif",
      ),
      "tampered",
    );
    expect(() =>
      buildBlindReviewDistribution({
        reportPath: fixture.reportPath,
        outputRoot: join(fixture.root, "distribution"),
        templatePath: resolve("bench/blind-report-template.html"),
        archive: false,
        packagerProvenance: cleanPackager,
      }),
    ).toThrow("Asset bytes do not match the quality report");
  });
});
