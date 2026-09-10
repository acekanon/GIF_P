import { describe, expect, it } from "vitest";
import type { PlatformPolicy } from "./platformPolicy";
import {
  assessPlatformDeliveryEvidence,
  assessPlatformOutputEnvelope,
  type PlatformDeliveryEvidence,
} from "./platformDeliveryEvidence";

const policy: PlatformPolicy = {
  id: "wechat_sticker",
  revision: "3",
  label: "微信收藏表情",
  surface: "test",
  acceptedFormats: ["gif"],
  verification: "unverified",
  source: { kind: "client_test", label: "test" },
  testedClients: [],
  fallbackFormat: "gif",
  guidance: { maxWidth: 240, maxFps: 12, maxDurationSeconds: 3, targetSizeMb: 0.48, aspect: 1 },
};

function validEvidence(): PlatformDeliveryEvidence {
  return {
    policyId: "wechat_sticker",
    policyRevision: "3",
    testedAt: "2026-07-20T08:00:00.000Z",
    client: "WeChat Windows 4.0.5",
    artifactSha256: "a".repeat(64),
    output: { format: "gif", width: 240, height: 240, fps: 12, durationSeconds: 3, sizeBytes: 490_000 },
    lifecycle: { send: true, receiverPlayback: true, forward: true, download: true, reopen: true },
  };
}

describe("platform delivery evidence", () => {
  it("only grants device_verified to current, complete full-lifecycle evidence", () => {
    const result = assessPlatformDeliveryEvidence(policy, validEvidence(), {
      now: new Date("2026-07-29T08:00:00.000Z"),
    });
    expect(result.state).toBe("device_verified");
    expect(result.reasons).toEqual([]);
    expect(result.envelope.within).toBe(true);
    expect(result.ageDays).toBe(9);
  });

  it("uses rule_inferred when no device evidence exists", () => {
    expect(assessPlatformDeliveryEvidence(policy).state).toBe("rule_inferred");
  });

  it("expires otherwise valid evidence after the configured freshness window", () => {
    const result = assessPlatformDeliveryEvidence(policy, validEvidence(), {
      now: new Date("2027-01-17T08:00:01.000Z"),
      maxAgeDays: 180,
    });
    expect(result.state).toBe("evidence_expired");
    expect(result.reasons).toEqual(["evidence_too_old"]);
  });

  it.each([
    ["policy revision", (value: PlatformDeliveryEvidence) => (value.policyRevision = "2"), "policy_revision_mismatch"],
    ["client", (value: PlatformDeliveryEvidence) => (value.client = "  "), "client_missing"],
    ["sha256", (value: PlatformDeliveryEvidence) => (value.artifactSha256 = "abc"), "artifact_sha256_invalid"],
    ["date", (value: PlatformDeliveryEvidence) => (value.testedAt = "29/07/2026"), "tested_at_invalid"],
  ])("rejects invalid %s evidence", (_label, mutate, reason) => {
    const evidence = validEvidence();
    mutate(evidence);
    const result = assessPlatformDeliveryEvidence(policy, evidence, {
      now: new Date("2026-07-29T08:00:00.000Z"),
    });
    expect(result.state).toBe("invalid");
    expect(result.reasons).toContain(reason);
  });

  it("requires send, receiver playback, forward, download and reopen", () => {
    const evidence = validEvidence();
    evidence.lifecycle.receiverPlayback = false;
    evidence.lifecycle.reopen = false;
    const result = assessPlatformDeliveryEvidence(policy, evidence, {
      now: new Date("2026-07-29T08:00:00.000Z"),
    });
    expect(result.state).toBe("invalid");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["lifecycle_receiverPlayback_incomplete", "lifecycle_reopen_incomplete"]),
    );
  });

  it("checks format, dimensions, fps, duration, size and aspect against the policy envelope", () => {
    const envelope = assessPlatformOutputEnvelope(policy, {
      format: "webp",
      width: 480,
      height: 240,
      fps: 24,
      durationSeconds: 4,
      sizeBytes: 600_000,
    });
    expect(envelope.within).toBe(false);
    expect(envelope.violations).toEqual([
      "format_not_accepted",
      "width_exceeds_policy",
      "fps_exceeds_policy",
      "duration_exceeds_policy",
      "size_exceeds_policy",
      "aspect_outside_policy",
    ]);
  });

  it("does not let stale evidence hide an invalid output contract", () => {
    const evidence = validEvidence();
    evidence.output.sizeBytes = 0;
    const result = assessPlatformDeliveryEvidence(policy, evidence, {
      now: new Date("2027-07-29T08:00:00.000Z"),
    });
    expect(result.state).toBe("invalid");
    expect(result.reasons).toContain("invalid_size");
  });

  it("turns a malformed persisted record into invalid instead of throwing", () => {
    const malformed = { ...validEvidence(), output: undefined } as unknown as PlatformDeliveryEvidence;
    expect(assessPlatformDeliveryEvidence(policy, malformed).state).toBe("invalid");
    expect(assessPlatformDeliveryEvidence(policy, malformed).reasons).toContain("output_contract_missing");
  });
});
