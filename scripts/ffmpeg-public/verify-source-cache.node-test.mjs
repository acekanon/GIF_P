import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  SourceCacheError,
  validateSourceLock,
  verifySourceCache,
} from "./verify-source-cache.mjs";

const COMMIT = "1".repeat(40);
const DIGEST = "2".repeat(64);
const BUILDER = `ghcr.io/btbn/ffmpeg-builds/base-win64@sha256:${DIGEST}`;

function baseSource(overrides = {}) {
  return {
    id: "fixture",
    role: "runtime-source",
    repository: "https://example.test/fixture",
    commit: COMMIT,
    archiveUrl: `https://example.test/fixture/${COMMIT}.tar.gz`,
    archiveFile: `fixture-${COMMIT}.tar.gz`,
    archiveRoot: `fixture-${COMMIT}`,
    sizeBytes: 1,
    sha256: "3".repeat(64),
    licenseExpression: "MIT",
    licenseFiles: ["LICENSE"],
    ...overrides,
  };
}

function baseLock(source = baseSource()) {
  return {
    schemaVersion: 1,
    profile: "gifp-windows-x64-lgpl-shared",
    target: "x86_64-w64-mingw32",
    builder: {
      image: BUILDER,
      manifestDigest: `sha256:${DIGEST}`,
      configDigest: `sha256:${"5".repeat(64)}`,
      networkPolicy: "release-build-must-run-with-network-none",
      buildRecipeCommit: "4".repeat(40),
    },
    licensePolicy: {
      runtimeExpression: "LGPL-2.1-or-later",
      requiredConfigureFlags: ["--disable-gpl"],
      forbiddenConfigureFlags: ["--enable-gpl"],
      forbiddenComponents: ["eq_filter"],
    },
    externalLibraries: [],
    sources: [source],
  };
}

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), "gifp-source-cache-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createLockedFixture(root) {
  const cache = join(root, "cache");
  const staging = join(root, "staging");
  const archiveRoot = `fixture-${COMMIT}`;
  mkdirSync(join(cache), { recursive: true });
  mkdirSync(join(staging, archiveRoot), { recursive: true });
  writeFileSync(join(staging, archiveRoot, "LICENSE"), "fixture license\n", "utf8");
  writeFileSync(join(staging, archiveRoot, "source.txt"), "locked source\n", "utf8");
  const archiveFile = `${archiveRoot}.tar.gz`;
  const archive = join(cache, archiveFile);
  const tar = spawnSync("tar", ["-czf", archive, "-C", staging, archiveRoot], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(tar.status, 0, tar.stderr);
  const source = baseSource({
    archiveFile,
    archiveRoot,
    sizeBytes: statSync(archive).size,
    sha256: sha256File(archive),
  });
  const lock = baseLock(source);
  const lockPath = join(root, "sources.lock.json");
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return { cache, lock, lockPath };
}

test("source-lock requires the exact profile and digest-pinned builder", () => {
  const wrongProfile = baseLock();
  wrongProfile.profile = "internal-gpl";
  assert.throws(() => validateSourceLock(wrongProfile), SourceCacheError);

  const floatingBuilder = baseLock();
  floatingBuilder.builder.image = "ghcr.io/btbn/ffmpeg-builds/base-win64:latest";
  assert.throws(() => validateSourceLock(floatingBuilder), /pinned by a full GHCR manifest digest/);
});

test("source-lock rejects archive and license path traversal", () => {
  assert.throws(
    () => validateSourceLock(baseLock(baseSource({ archiveRoot: ".." }))),
    /archive root is unsafe/,
  );
  assert.throws(
    () => validateSourceLock(baseLock(baseSource({ licenseFiles: ["../LICENSE"] }))),
    /license path is unsafe/,
  );
  assert.throws(
    () => validateSourceLock(baseLock(baseSource({ archiveFile: "../source.tar.gz" }))),
    /archive filename is unsafe/,
  );
});

test("source-lock binds a submodule archive to its exact parent gitlink", () => {
  const parentCommit = "5".repeat(40);
  const parent = baseSource({
    id: "parent",
    commit: parentCommit,
    archiveUrl: `https://example.test/parent/${parentCommit}.tar.gz`,
    archiveFile: `parent-${parentCommit}.tar.gz`,
    archiveRoot: `parent-${parentCommit}`,
  });
  const child = baseSource({
    id: "child",
    archiveUrl: `https://example.test/child/${COMMIT}.tar.gz`,
    archiveFile: `child-${COMMIT}.tar.gz`,
    archiveRoot: `child-${COMMIT}`,
    submodule: {
      parentSourceId: "parent",
      parentCommit,
      path: "subprojects/child",
      gitlinkCommit: COMMIT,
    },
  });
  const lock = baseLock();
  lock.sources = [parent, child];
  assert.equal(validateSourceLock(lock), lock);

  const wrongParent = structuredClone(lock);
  wrongParent.sources[1].submodule.parentCommit = "6".repeat(40);
  assert.throws(() => validateSourceLock(wrongParent), /parent commit is mismatched/);

  const wrongGitlink = structuredClone(lock);
  wrongGitlink.sources[1].submodule.gitlinkCommit = "7".repeat(40);
  assert.throws(() => validateSourceLock(wrongGitlink), /submodule commit is mismatched/);

  const unsafePath = structuredClone(lock);
  unsafePath.sources[1].submodule.path = "../child";
  assert.throws(() => validateSourceLock(unsafePath), /submodule path is unsafe/);
});

test("verified cache binds bytes, root and license inventory", () => {
  withTempDir((root) => {
    const fixture = createLockedFixture(root);
    const facts = verifySourceCache(fixture.lockPath, fixture.cache);
    assert.equal(facts.sourceCount, 1);
    assert.equal(facts.sources[0].sha256, fixture.lock.sources[0].sha256);

    const wrongSize = structuredClone(fixture.lock);
    wrongSize.sources[0].sizeBytes += 1;
    const wrongSizePath = join(root, "wrong-size.json");
    writeFileSync(wrongSizePath, JSON.stringify(wrongSize), "utf8");
    assert.throws(() => verifySourceCache(wrongSizePath, fixture.cache), /size mismatch/);

    const wrongHash = structuredClone(fixture.lock);
    wrongHash.sources[0].sha256 = "f".repeat(64);
    const wrongHashPath = join(root, "wrong-hash.json");
    writeFileSync(wrongHashPath, JSON.stringify(wrongHash), "utf8");
    assert.throws(() => verifySourceCache(wrongHashPath, fixture.cache), /SHA-256 mismatch/);

    const wrongRoot = structuredClone(fixture.lock);
    wrongRoot.sources[0].archiveRoot = `other-${COMMIT}`;
    const wrongRootPath = join(root, "wrong-root.json");
    writeFileSync(wrongRootPath, JSON.stringify(wrongRoot), "utf8");
    assert.throws(() => verifySourceCache(wrongRootPath, fixture.cache), /archive root is missing/);

    const missingLicense = structuredClone(fixture.lock);
    missingLicense.sources[0].licenseFiles = ["COPYING"];
    const missingLicensePath = join(root, "missing-license.json");
    writeFileSync(missingLicensePath, JSON.stringify(missingLicense), "utf8");
    assert.throws(() => verifySourceCache(missingLicensePath, fixture.cache), /license file is missing/);
  });
});
