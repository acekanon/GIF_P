import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyPlatformDeliveryEvidence } from "./verify-platform-delivery-evidence.mjs";

const NOW = new Date("2026-07-29T08:00:00.000Z");

function record(overrides = {}) {
  return {
    evidenceId: "wechat-sticker-win-20260720",
    policyId: "wechat_sticker",
    policyRevision: "1",
    testedAt: "2026-07-20T08:00:00.000Z",
    client: { name: "WeChat", version: "4.0.5", platform: "windows", osVersion: "Windows 11 24H2 build 26100" },
    artifactSha256: "a".repeat(64),
    output: { format: "gif", width: 240, height: 240, fps: 12, durationSeconds: 3, sizeBytes: 490000 },
    lifecycle: { send: true, receiverPlayback: true, forward: true, download: true, reopen: true },
    ...overrides,
  };
}

function bundle(evidence = [record()]) {
  return { schemaVersion: 1, policySetVersion: "2026.07.27", evidence };
}

test("accepts a current complete record and emits auditable counts", () => {
  const result = verifyPlatformDeliveryEvidence(bundle(), { now: NOW });
  assert.equal(result.valid, true);
  assert.equal(result.recordCount, 1);
  assert.equal(result.deviceVerifiedCount, 1);
  assert.deepEqual(result.errors, []);
});

test("an empty registry never claims a device verification", () => {
  const result = verifyPlatformDeliveryEvidence(bundle([]), { now: NOW });
  assert.equal(result.valid, true);
  assert.equal(result.deviceVerifiedCount, 0);
});

test("rejects unknown fields at root, record and nested levels", () => {
  for (const value of [
    { ...bundle(), claim: "verified" },
    bundle([{ ...record(), notes: "trust me" }]),
    bundle([{ ...record(), client: { ...record().client, account: "secret" } }]),
    bundle([{ ...record(), output: { ...record().output, quality: 100 } }]),
    bundle([{ ...record(), lifecycle: { ...record().lifecycle, upload: true } }]),
  ]) {
    const result = verifyPlatformDeliveryEvidence(value, { now: NOW });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === "unknown_field"));
  }
});

test("rejects duplicate evidence IDs", () => {
  const result = verifyPlatformDeliveryEvidence(bundle([record(), record()]), { now: NOW });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "duplicate_evidence_id"));
  assert.equal(result.deviceVerifiedCount, 0);
});

test("rejects unknown policy IDs and revision mismatches", () => {
  for (const item of [record({ policyId: "made_up" }), record({ policyRevision: "2" })]) {
    const result = verifyPlatformDeliveryEvidence(bundle([item]), { now: NOW });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => ["unknown_policy_id", "policy_revision_mismatch"].includes(error.code)));
  }
});

test("requires strict dates and rejects future or expired evidence", () => {
  const cases = [
    ["2026-02-30T08:00:00.000Z", "invalid_iso_date"],
    ["2026-07-30T08:00:00.000Z", "future_date"],
    ["2026-01-01T08:00:00.000Z", "evidence_expired"],
    ["2026-07-20", "invalid_iso_date"],
  ];
  for (const [testedAt, code] of cases) {
    const result = verifyPlatformDeliveryEvidence(bundle([record({ testedAt })]), { now: NOW });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === code), `${testedAt} should report ${code}`);
  }
});

test("requires structured client, lowercase hash, positive output and all lifecycle steps", () => {
  const invalid = record({
    client: { name: "", version: "4", platform: "windows", osVersion: "11" },
    artifactSha256: "A".repeat(64),
    output: { format: "gif", width: 0, height: 240, fps: 0, durationSeconds: 3, sizeBytes: -1 },
    lifecycle: { send: true, receiverPlayback: false, forward: true, download: true, reopen: true },
  });
  const result = verifyPlatformDeliveryEvidence(bundle([invalid]), { now: NOW });
  assert.equal(result.valid, false);
  assert.deepEqual(new Set(result.errors.map((error) => error.code)), new Set([
    "invalid_string", "invalid_sha256", "invalid_positive_integer", "invalid_positive_number", "lifecycle_incomplete",
  ]));
});

test("rejects output outside the selected policy envelope", () => {
  const invalid = record({
    output: { format: "webp", width: 480, height: 240, fps: 24, durationSeconds: 4, sizeBytes: 600000 },
  });
  const result = verifyPlatformDeliveryEvidence(bundle([invalid]), { now: NOW });
  assert.equal(result.valid, false);
  assert.deepEqual(
    new Set(result.errors.map((error) => error.code)),
    new Set(["format_outside_policy", "width_exceeds_policy", "fps_exceeds_policy", "duration_exceeds_policy", "size_exceeds_policy", "aspect_outside_policy"]),
  );
});

test("CLI emits one machine-readable summary and fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "gifp-evidence-"));
  const validPath = join(directory, "valid.json");
  const invalidPath = join(directory, "invalid.json");
  writeFileSync(validPath, JSON.stringify(bundle()), "utf8");
  writeFileSync(invalidPath, "{not-json", "utf8");

  const verifierPath = fileURLToPath(new URL("./verify-platform-delivery-evidence.mjs", import.meta.url));
  const stdout = execFileSync(process.execPath, [verifierPath, validPath, "--now", NOW.toISOString()], { encoding: "utf8" });
  assert.equal(JSON.parse(stdout).valid, true);

  const failed = spawnSync(process.execPath, [verifierPath, invalidPath], { encoding: "utf8" });
  assert.equal(failed.status, 2);
  assert.equal(JSON.parse(failed.stdout).valid, false);
  assert.equal(JSON.parse(failed.stdout).fatal, true);
});
