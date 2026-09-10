import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import { auditCanonicalFixtureIdentity } from "./audit-canonical-fixture-identity.mjs";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "gifp-fixture-identity-"));
  const bench = join(root, "bench");
  const generated = join(bench, "generated");
  const compliance = join(root, "compliance");
  mkdirSync(generated, { recursive: true });
  mkdirSync(compliance, { recursive: true });
  const ffmpegPath = join(root, "ffmpeg.bin");
  const ffprobePath = join(root, "ffprobe.bin");
  const runtimePath = join(compliance, "runtime.json");
  const fixturePath = join(generated, "fixture.mkv");
  writeFileSync(ffmpegPath, "reviewed ffmpeg");
  writeFileSync(ffprobePath, "reviewed ffprobe");
  writeFileSync(runtimePath, "reviewed runtime manifest");
  writeFileSync(fixturePath, "deterministic fixture");
  const manifest = {
    schema_version: 1,
    corpus_id: "test-corpus",
    fixture_root: "generated",
    canonical_fixture_identity: {
      contract_id: "gifp.canonical_fixture_identity.v1",
      status: "incomplete",
      generator_ffmpeg_sha256: sha256(ffmpegPath),
      generator_ffprobe_sha256: sha256(ffprobePath),
      reviewed_runtime_manifest_path: "compliance/runtime.json",
      reviewed_runtime_manifest_sha256: sha256(runtimePath),
    },
    fixtures: [{
      id: "fixture",
      category: "test",
      file: "fixture.mkv",
      expected_source_sha256: null,
    }],
  };
  const manifestPath = join(bench, "corpus-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifestPath, ffmpegPath, ffprobePath, fixturePath };
}

test("emits a complete review proposal without changing the baseline", () => {
  const workspace = fixtureWorkspace();
  try {
    const before = readFileSync(workspace.manifestPath);
    const audit = auditCanonicalFixtureIdentity({
      workspaceRoot: workspace.root,
      manifestPath: workspace.manifestPath,
      ffmpegPath: workspace.ffmpegPath,
      ffprobePath: workspace.ffprobePath,
    });
    assert.equal(audit.current_complete, false);
    assert.equal(audit.proposal_complete, true);
    assert.equal(audit.requires_manual_review, true);
    assert.equal(audit.fixtures[0].proposed_expected_source_sha256, sha256(workspace.fixturePath));
    assert.equal(audit.proposal.canonical_fixture_identity.status, "complete");
    assert.equal(audit.proposal_application_preconditions.independent_generation_runs_required, 2);
    assert.equal(audit.proposal_application_preconditions.automatically_satisfied_by_this_tool, false);
    assert.deepEqual(readFileSync(workspace.manifestPath), before);
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});

test("withholds fixture proposals when the generator identity mismatches", () => {
  const workspace = fixtureWorkspace();
  try {
    writeFileSync(workspace.ffmpegPath, "unreviewed ffmpeg");
    const audit = auditCanonicalFixtureIdentity({
      workspaceRoot: workspace.root,
      manifestPath: workspace.manifestPath,
      ffmpegPath: workspace.ffmpegPath,
      ffprobePath: workspace.ffprobePath,
    });
    assert.equal(audit.observed_generator.matches_reviewed_identity, false);
    assert.equal(audit.proposal_complete, false);
    assert.equal(audit.fixtures[0].proposal_eligible, false);
    assert.equal(audit.fixtures[0].proposed_expected_source_sha256, null);
    assert.equal(audit.proposal.canonical_fixture_identity.status, "incomplete");
  } finally {
    rmSync(workspace.root, { recursive: true, force: true });
  }
});
