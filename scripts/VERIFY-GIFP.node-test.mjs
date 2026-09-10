import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const templatePath = resolve("scripts/VERIFY-GIFP.ps1");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gifp-verify-package-"));
  const exe = join(root, "GIFP-test.exe");
  const distribution = join(root, "DISTRIBUTION.json");
  const verifier = join(root, "VERIFY-GIFP.ps1");
  writeFileSync(exe, "not a PE; Authenticode reports NotSigned");
  writeFileSync(distribution, JSON.stringify({
    product: { version: "test", channel: "internal" },
    application: {
      fileName: "GIFP-test.exe",
      sha256: sha256(exe),
      signatureStatus: "UnknownError",
      signerThumbprint: null,
    },
    distribution: { redistributable: false },
  }));
  const rendered = readFileSync(templatePath, "utf8")
    .replaceAll("__GIFP_VERSION__", "test")
    .replaceAll("__GIFP_CHANNEL__", "internal")
    .replaceAll("__GIFP_REDISTRIBUTABLE__", "False")
    .replaceAll("__GIFP_ALLOWED_SIGNER_THUMBPRINT__", "");
  writeFileSync(verifier, rendered);
  const manifest = ["DISTRIBUTION.json", "GIFP-test.exe", "VERIFY-GIFP.ps1"]
    .map((name) => `${sha256(join(root, name))}  ${name}`)
    .join("\n");
  writeFileSync(join(root, "FILES-SHA256.txt"), `${manifest}\n`);
  return root;
}

function runVerifier(root) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(root, "VERIFY-GIFP.ps1"),
    "-PackageRoot", root,
  ], { encoding: "utf8" });
}

test("packaged verifier reports explicit PASS for inventory, distribution and Authenticode", () => {
  const root = fixture();
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[PASS\] FILES-SHA256/);
    assert.match(result.stdout, /\[PASS\] DISTRIBUTION/);
    assert.match(result.stdout, /\[PASS\] Authenticode: UnknownError/);
    assert.match(result.stdout, /verification completed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged verifier fails closed when a payload byte changes", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "GIFP-test.exe"), "tampered");
    const result = runVerifier(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[FAIL\] SHA-256 mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
