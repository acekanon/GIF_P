import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPublicManifestReady,
  ComplianceError,
  evaluateDistributionPolicy,
  evaluateQualityReleaseBinding,
  materializeQualityEvidence,
  parseStrictBoolean,
  sha256File,
  validateManifestForChannel,
  validatePinnedManifest,
  verifyDependencyManifest,
  verifyBinaryAsset,
  verifyFfmpegComponentPolicy,
  verifyFfmpegLicense,
  verifyLicenseTextBundle,
  verifyPublicReviewRecords,
  verifyPublicSourceLock,
  verifyReleaseQualityEvidence,
  verifyFfmpegVersion,
  verifyRuntimeFiles,
} from "./verify-release-compliance.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("GIFP release metadata stays aligned with the package version", () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"));
  const tauriConfig = JSON.parse(readFileSync(join(repositoryRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const cargoToml = readFileSync(join(repositoryRoot, "src-tauri", "Cargo.toml"), "utf8");
  const portableScript = readFileSync(join(repositoryRoot, "scripts", "package-portable.ps1"), "utf8");
  const about = readFileSync(join(repositoryRoot, "ABOUT.md"), "utf8");
  const license = readFileSync(join(repositoryRoot, "LICENSE.txt"), "utf8");
  const notices = readFileSync(join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, "product version must be a stable numeric triplet");
  assert.equal(packageJson.author, "acekanon");
  assert.equal(packageJson.license, "LicenseRef-GIFP-Freeware-1.0");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(tauriConfig.version, packageJson.version);
  assert.equal(tauriConfig.productName, `GIFP ${packageJson.version}`);
  assert.match(cargoToml, new RegExp(`^version = "${packageJson.version.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(cargoToml, /^authors = \["acekanon"\]$/m);
  assert.match(portableScript, /\$productVersion = \[string\]\$packageManifest\.version/);
  assert.match(portableScript, /package\.json, Tauri and Cargo product versions must agree/);
  assert.match(portableScript, /FFmpeg-SOURCE-INFO\.txt/);
  assert.match(portableScript, /GIFP_FFMPEG_RUNTIME_PROFILE=public-lgpl/);
  assert.match(portableScript, /ffmpeg-windows-x64-lgpl-shared-public\.json/);
  assert.match(portableScript, /"binary-asset" = \$temporaryBinaryAsset/);
  assert.match(about, /作者：acekanon/);
  assert.match(about, /LGPL shared build/);
  assert.match(about, /免费软件/);
  assert.match(license, /GIFP FREEWARE LICENSE 1\.0/);
  assert.match(license, /LGPL-2\.1-or-later/);
  assert.match(notices, /9\.0-full_build-www\.gyan\.dev/);
  assert.match(notices, /GPL-3\.0-or-later/);
  assert.match(notices, /LGPL-2\.1-or-later/);
  assert.match(notices, new RegExp(`^# GIFP ${packageJson.version.replaceAll(".", "\\.")} third-party notices$`, "m"));
});

function fixtureManifest(runtimeFiles = []) {
  return {
    schemaVersion: 1,
    component: "FFmpeg",
    platform: "windows-x86_64",
    variant: "win64-gpl-shared",
    licenseExpression: "GPL-3.0-or-later",
    distributionPolicy: {
      internalAllowed: true,
      publicAlphaAllowed: true,
      publicBlockers: [],
    },
    binaryAsset: {
      name: "ffmpeg.zip",
      url: "https://example.test/releases/download/build-2026-07-11/ffmpeg.zip",
      sizeBytes: 12,
      sha256: "a".repeat(64),
    },
    version: {
      marker: "N-1-g123-20260711",
      ffmpegCommit: "1".repeat(40),
      buildRecipeCommit: "2".repeat(40),
    },
    sourceProvenance: {
      ffmpegCommitUrl: `https://example.test/ffmpeg/commit/${"1".repeat(40)}`,
      ffmpegArchiveUrl: `https://example.test/ffmpeg/archive/${"1".repeat(40)}.tar.gz`,
      buildRecipeCommitUrl: `https://example.test/build/commit/${"2".repeat(40)}`,
    },
    configuration: {
      requiredFlags: ["--enable-gpl", "--enable-shared"],
      forbiddenFlags: ["--enable-nonfree"],
    },
    licenseFile: {
      name: "LICENSE.txt",
      sizeBytes: 7,
      sha256: "d".repeat(64),
    },
    runtimeFiles,
  };
}

function publicFixtureManifest(runtimeFiles = []) {
  const manifest = fixtureManifest(runtimeFiles);
  manifest.releaseProfile = "gifp-windows-x64-lgpl-shared-public-v1";
  manifest.variant = "gifp-win64-lgpl-shared";
  manifest.licenseExpression = "LGPL-2.1-or-later";
  manifest.configuration = {
    requiredFlags: [
      "--disable-version3",
      "--enable-shared",
      "--disable-static",
      "--disable-gpl",
      "--disable-nonfree",
      "--disable-autodetect",
      "--disable-network",
      "--enable-parser=av1,gif,h264,hevc,mpeg4video,mpegvideo,vp8,vp9",
    ],
    forbiddenFlags: [
      "--enable-gpl",
      "--enable-version3",
      "--enable-nonfree",
      "--enable-libx264",
      "--enable-filter=eq",
      "--enable-filter=hqdn3d",
    ],
  };
  manifest.componentPolicy = {
    requiredComponents: {
      protocols: ["file", "pipe"],
      devices: ["gdigrab", "lavfi"],
      demuxers: [
        "mov", "matroska", "gif", "apng", "image2", "image2pipe", "webp_anim",
        "webp_pipe", "png_pipe", "jpeg_pipe", "gif_pipe", "nut", "rawvideo",
      ],
      decoders: [
        "h264", "hevc", "av1", "vp8", "vp9", "mpeg4", "gif", "png", "apng",
        "webp", "webp_anim", "mjpeg", "rawvideo", "wrapped_avframe", "bmp",
        "libvpx-vp9", "prores", "dnxhd", "mpeg2video", "vc1",
      ],
      encoders: [
        "gif", "png", "mjpeg", "apng", "rawvideo", "wrapped_avframe",
        "libwebp_anim", "libvpx-vp9", "h264_mf",
      ],
      muxers: ["gif", "webp", "apng", "mp4", "webm", "image2", "nut", "rawvideo", "null"],
      filters: [
        "alphaextract", "ass", "atadenoise", "bilateral", "color", "colorbalance",
        "concat", "crop", "curves", "ddagrab", "drawgrid", "format", "fps", "gradfun",
        "hflip", "hue", "hwdownload", "lutyuv", "metadata", "pad", "palettegen",
        "paletteuse", "rotate", "scale", "select", "setpts", "setsar", "signalstats",
        "split", "transpose", "trim", "unsharp", "vflip", "vignette",
      ],
      hwaccels: ["d3d11va"],
    },
    forbiddenFilters: ["eq", "hqdn3d"],
    forbiddenEncoders: ["libx264", "libx264rgb"],
  };
  manifest.publicReleaseProfile = {
    id: "gifp-windows-x64-lgpl-shared-public-v1",
    reviewedBuildCommit: "4".repeat(40),
    sourceLock: {
      path: "ffmpeg-public/sources.lock.json",
      sizeBytes: 1,
      sha256: "e".repeat(64),
    },
    buildRecipeLock: {
      path: "ffmpeg-public/build-recipe.lock.json",
      sizeBytes: 1,
      sha256: "f".repeat(64),
    },
    readiness: {
      runtimeBuiltAndPinned: true,
      runtimeCapabilitiesReviewed: true,
      correspondingSourceArchived: true,
      immutableBuildInputsVerified: true,
    },
    reviewEvidence: {
      reproducibilityReview: { path: "ffmpeg-public/reviews/repro.json", sizeBytes: 1, sha256: "1".repeat(64) },
      windowsRuntimeReview: { path: "ffmpeg-public/reviews/windows.json", sizeBytes: 1, sha256: "2".repeat(64) },
      correspondingSourceReview: { path: "ffmpeg-public/reviews/source.json", sizeBytes: 1, sha256: "3".repeat(64) },
    },
  };
  return manifest;
}

function publicInventoryTexts(manifest, overrides = {}) {
  const required = manifest.componentPolicy.requiredComponents;
  const table = (values, flags = "D") => values.map((value) => ` ${flags} ${value} fixture`).join("\n");
  return {
    protocolsText: required.protocols.join("\n"),
    devicesText: table(required.devices),
    demuxersText: table(required.demuxers),
    decodersText: table(required.decoders, "V....."),
    encodersText: table(required.encoders, "V....D"),
    muxersText: table(required.muxers, "E"),
    filtersText: table(required.filters, "TSC"),
    hwaccelsText: required.hwaccels.join("\n"),
    ...overrides,
  };
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "gifp-compliance-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function qualityEvidenceFixture(dir, overrides = {}) {
  const sourceRoot = join(dir, "quality-source");
  const bundleRoot = join(sourceRoot, "report-bundle");
  mkdirSync(bundleRoot, { recursive: true });
  const reportPath = join(sourceRoot, "latest.json");
  const schemaPath = join(sourceRoot, "quality-report.schema.json");
  const corpusPath = join(sourceRoot, "corpus-manifest.json");
  const bundleManifestPath = join(bundleRoot, "bundle-manifest.json");
  const reportArtifactPath = join(bundleRoot, "report.json");
  const blindArtifactPath = join(bundleRoot, "blind.html");
  const provenanceArtifactPath = join(bundleRoot, "build-provenance.json");
  writeFileSync(reportPath, "quality commit point\n");
  writeFileSync(schemaPath, "quality schema\n");
  writeFileSync(corpusPath, "canonical corpus\n");
  writeFileSync(reportArtifactPath, "sealed report\n");
  writeFileSync(blindArtifactPath, "<html><a href=\"https://example.test/review\">blind</a></html>\n");
  writeFileSync(provenanceArtifactPath, "{\"contract_id\":\"gifp.build_provenance.v1\"}\n");
  const artifacts = [
    {
      role: "report_json",
      relative_path: "report.json",
      source_path: reportArtifactPath,
      sha256: sha256File(reportArtifactPath),
      size_bytes: statSync(reportArtifactPath).size,
    },
    {
      role: "blind_html",
      relative_path: "blind.html",
      source_path: blindArtifactPath,
      sha256: sha256File(blindArtifactPath),
      size_bytes: statSync(blindArtifactPath).size,
    },
    {
      role: "build_provenance",
      relative_path: "build-provenance.json",
      source_path: provenanceArtifactPath,
      sha256: sha256File(provenanceArtifactPath),
      size_bytes: statSync(provenanceArtifactPath).size,
    },
  ];
  writeFileSync(bundleManifestPath, `${JSON.stringify({
    schema_version: 1,
    run_id: "quality-run",
    artifacts: artifacts.map(({ source_path: ignored, ...artifact }) => artifact),
  })}\n`);
  return {
    report_path: reportPath,
    report_sha256: sha256File(reportPath),
    report_size_bytes: statSync(reportPath).size,
    run_id: "quality-run",
    schema_version: 9,
    schema_path: schemaPath,
    schema_sha256: sha256File(schemaPath),
    schema_size_bytes: statSync(schemaPath).size,
    git_commit: "a".repeat(40),
    git_dirty: false,
    build_provenance: {
      schema_version: 1,
      contract_id: "gifp.build_provenance.v1",
      executor_start_sha256: "e".repeat(64),
      executor_end_sha256: "e".repeat(64),
      embedded_git_commit: "a".repeat(40),
      embedded_git_dirty: false,
      embedded_git_tree_hash: "b".repeat(40),
      runtime_start_commit: "a".repeat(40),
      runtime_start_dirty: false,
      runtime_start_tree_hash: "b".repeat(40),
      runtime_end_commit: "a".repeat(40),
      runtime_end_dirty: false,
      runtime_end_tree_hash: "b".repeat(40),
      passed: true,
      violations: [],
    },
    acceptance_id: "gifp.best_same_size.first_tier.v1",
    first_tier_applicable: true,
    first_tier_provenance_passed: true,
    first_tier_canonical_corpus_passed: true,
    first_tier_canonical_fixture_identity_passed: true,
    canonical_fixture_identity: {
      status: "complete",
      passed: true,
      live_passed: true,
      generator_identity_passed: true,
      live_generator_verified: true,
      source_identity_passed: true,
      live_source_identity_verified: true,
    },
    first_tier_quality_passed: true,
    corpus_id: "gifp-first-tier-corpus-v1",
    corpus_manifest_path: corpusPath,
    corpus_manifest_sha256: sha256File(corpusPath),
    corpus_manifest_size_bytes: statSync(corpusPath).size,
    artifact_bundle_schema_version: 1,
    artifact_bundle_manifest_path: bundleManifestPath,
    artifact_bundle_manifest_sha256: sha256File(bundleManifestPath),
    artifact_bundle_manifest_size_bytes: statSync(bundleManifestPath).size,
    artifact_count: artifacts.length,
    artifact_size_bytes: artifacts.reduce((sum, artifact) => sum + artifact.size_bytes, 0),
    artifacts,
    ...overrides,
  };
}

test("pinned runtime inventory accepts exact files and rejects mutation", () => {
  withTempDir((dir) => {
    const ffmpeg = join(dir, "ffmpeg.exe");
    const ffprobe = join(dir, "ffprobe.exe");
    writeFileSync(ffmpeg, "ffmpeg-pinned");
    writeFileSync(ffprobe, "ffprobe-pinned");
    const manifest = fixtureManifest([
      { name: "ffmpeg.exe", sizeBytes: 13, sha256: sha256File(ffmpeg) },
      { name: "ffprobe.exe", sizeBytes: 14, sha256: sha256File(ffprobe) },
    ]);

    assert.equal(verifyRuntimeFiles(manifest, dir).length, 2);
    writeFileSync(ffprobe, "tampered");
    assert.throws(() => verifyRuntimeFiles(manifest, dir), ComplianceError);
  });
});

test("manifest rejects mutable latest provenance", () => {
  const manifest = fixtureManifest([
    { name: "ffmpeg.exe", sizeBytes: 1, sha256: "b".repeat(64) },
    { name: "ffprobe.exe", sizeBytes: 1, sha256: "c".repeat(64) },
  ]);
  manifest.binaryAsset.url = "https://example.test/releases/latest/ffmpeg.zip";
  assert.throws(() => validatePinnedManifest(manifest), /mutable latest URL/);
});

test("FFmpeg version gate enforces required and forbidden flags", () => {
  const manifest = fixtureManifest([
    { name: "ffmpeg.exe", sizeBytes: 1, sha256: "b".repeat(64) },
    { name: "ffprobe.exe", sizeBytes: 1, sha256: "c".repeat(64) },
  ]);
  const valid = "ffmpeg version N-1-g123-20260711\nconfiguration: --enable-gpl --enable-shared\n";
  assert.match(verifyFfmpegVersion(manifest, valid).configurationLine, /enable-shared/);
  assert.throws(
    () => verifyFfmpegVersion(manifest, `${valid.trim()} --enable-nonfree\n`),
    /forbidden flag/,
  );
  assert.throws(
    () => verifyFfmpegVersion(manifest, "ffmpeg version N-1-g123-20260711\nconfiguration: --enable-gpl\n"),
    /missing required flag/,
  );
});

test("public binary asset is bound to filename, size and content hash", () => {
  withTempDir((dir) => {
    const archive = join(dir, "ffmpeg.zip");
    writeFileSync(archive, "runtime-zip");
    const manifest = publicFixtureManifest([
      { name: "ffmpeg.exe", sizeBytes: 1, sha256: "b".repeat(64) },
      { name: "ffprobe.exe", sizeBytes: 1, sha256: "c".repeat(64) },
    ]);
    manifest.binaryAsset.sizeBytes = statSync(archive).size;
    manifest.binaryAsset.sha256 = sha256File(archive);
    assert.equal(verifyBinaryAsset(manifest, archive).sha256, manifest.binaryAsset.sha256);
    writeFileSync(archive, "tampered-runtime-zip");
    assert.throws(() => verifyBinaryAsset(manifest, archive), /binary asset size mismatch|binary asset SHA-256 mismatch/);
  });
});

test("internal channel keeps accepting the default pinned GPL manifest", () => {
  const manifest = fixtureManifest();
  assert.equal(validateManifestForChannel(manifest, "internal"), manifest);
});

test("public-alpha rejects the internal manifest even when publicAlphaAllowed is forged true", () => {
  const manifest = fixtureManifest();
  manifest.distributionPolicy.publicAlphaAllowed = true;
  assert.throws(
    () => validateManifestForChannel(manifest, "public-alpha"),
    /requires the explicit gifp-windows-x64-lgpl-shared-public-v1 manifest/,
  );
});

test("public-alpha profile rejects GPL, version3, libx264, eq and hqdn3d enablement", () => {
  for (const forbidden of [
    "--enable-gpl",
    "--enable-version3",
    "--enable-nonfree",
    "--enable-libx264",
    "--enable-filter=eq",
    "--enable-filter=hqdn3d",
  ]) {
    const manifest = publicFixtureManifest();
    manifest.configuration.requiredFlags.push(forbidden);
    assert.throws(
      () => validateManifestForChannel(manifest, "public-alpha"),
      new RegExp(`forbidden flag ${forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  }
});

test("public-alpha actual FFmpeg tables reject GPL-only filters and libx264 encoders", () => {
  const manifest = publicFixtureManifest();
  const inventories = publicInventoryTexts(manifest);
  assert.doesNotThrow(() => verifyFfmpegComponentPolicy(manifest, inventories));
  assert.throws(
    () => verifyFfmpegComponentPolicy(manifest, publicInventoryTexts(manifest, {
      filtersText: `${inventories.filtersText}\n T.. eq V->V\n`,
    })),
    /forbidden FFmpeg filter eq/,
  );
  assert.throws(
    () => verifyFfmpegComponentPolicy(manifest, publicInventoryTexts(manifest, {
      encodersText: `${inventories.encodersText}\n V....D libx264 H.264\n`,
    })),
    /forbidden FFmpeg encoder libx264/,
  );
});

test("public-alpha actual FFmpeg tables require the complete production closure", () => {
  const manifest = publicFixtureManifest();
  const inventories = publicInventoryTexts(manifest, {
    demuxersText: " D mov fixture\n",
  });
  assert.throws(
    () => verifyFfmpegComponentPolicy(manifest, inventories),
    /missing required FFmpeg components.*matroska/,
  );
});

test("public-alpha parses real FFmpeg alias rows and device markers", () => {
  const manifest = publicFixtureManifest();
  const requiredDemuxers = manifest.componentPolicy.requiredComponents.demuxers;
  const individual = requiredDemuxers.filter((name) => !["mov", "matroska"].includes(name));
  const demuxersText = [
    "Formats:",
    " D.. = Demuxing supported",
    " ..d = Is a device",
    " D d gdigrab GDI API Windows frame grabber",
    " D d lavfi Libavfilter virtual input device",
    " D   matroska,webm Matroska / WebM",
    " D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV",
    ...individual.map((name) => ` D   ${name} fixture`),
  ].join("\n");

  assert.doesNotThrow(() => verifyFfmpegComponentPolicy(
    manifest,
    publicInventoryTexts(manifest, { demuxersText }),
  ));
});

test("public-alpha runtime readiness stays fail-closed with a clear blocker", () => {
  const manifest = publicFixtureManifest();
  manifest.distributionPolicy.publicAlphaAllowed = false;
  manifest.distributionPolicy.publicBlockers = ["PUBLIC_LGPL_RUNTIME_NOT_BUILT"];
  manifest.publicReleaseProfile.readiness.runtimeBuiltAndPinned = false;
  assert.throws(
    () => assertPublicManifestReady(manifest),
    /Public LGPL runtime profile is fail-closed: PUBLIC_LGPL_RUNTIME_NOT_BUILT/,
  );
});

test("public-alpha readiness booleans cannot bypass hash-bound review evidence", () => {
  const manifest = publicFixtureManifest();
  manifest.publicReleaseProfile.reviewEvidence.windowsRuntimeReview = null;
  assert.throws(
    () => assertPublicManifestReady(manifest),
    /windowsRuntimeReview descriptor is missing/,
  );
});

test("public-alpha review records separate the reviewed build from the clean release commit", () => {
  withTempDir((dir) => {
    const manifest = publicFixtureManifest([
      { name: "ffmpeg.exe", sizeBytes: 1, sha256: "b".repeat(64) },
      { name: "ffprobe.exe", sizeBytes: 1, sha256: "c".repeat(64) },
    ]);
    const reviewedBuildCommit = "4".repeat(40);
    const releaseCommit = "5".repeat(40);
    manifest.publicReleaseProfile.reviewedBuildCommit = reviewedBuildCommit;
    manifest.binaryAsset.sizeBytes = 123;
    manifest.binaryAsset.sha256 = "a".repeat(64);
    const identity = {
      gitCommit: reviewedBuildCommit,
      ffmpegCommit: manifest.version.ffmpegCommit,
      buildRecipeCommit: manifest.version.buildRecipeCommit,
      sourceLockSha256: manifest.publicReleaseProfile.sourceLock.sha256,
      buildRecipeLockSha256: manifest.publicReleaseProfile.buildRecipeLock.sha256,
      binaryAssetSha256: manifest.binaryAsset.sha256,
    };
    const buildIdentity = {
      sourceLockSha256: identity.sourceLockSha256,
      buildRecipeLockSha256: identity.buildRecipeLockSha256,
    };
    const runtimeArchive = { sizeBytes: manifest.binaryAsset.sizeBytes, sha256: manifest.binaryAsset.sha256 };
    const runtimeInputSha256 = ["1", "2", "3", "4", "5"].map((value) => value.repeat(64));
    const runtimeEvidence = [
      "public-release-revalidation",
      "animated-format-matrix",
      "independent-animated-validation",
      "video-and-ass-matrix",
      "interactive-screen-capture-diagnosis",
      "h264-media-foundation-fallback",
    ].map((name, index) => ({
      name,
      fileName: `${name}.json`,
      sizeBytes: index + 1,
      sha256: String(index + 1).repeat(64),
    }));
    const runtimeEvidenceBundlePath = join(dir, "ffmpeg-public", "reviews", `windows-runtime-evidence-${reviewedBuildCommit.slice(0, 7)}.json`);
    mkdirSync(join(dir, "ffmpeg-public", "reviews"), { recursive: true });
    writeFileSync(runtimeEvidenceBundlePath, `${JSON.stringify({
      schemaVersion: 1,
      type: "gifp-public-ffmpeg-windows-runtime-evidence",
      gitCommit: reviewedBuildCommit,
      inputSha256: runtimeInputSha256,
      evidence: runtimeEvidence,
    }, null, 2)}\n`);
    const runtimeEvidenceBundle = {
      path: `ffmpeg-public/reviews/windows-runtime-evidence-${reviewedBuildCommit.slice(0, 7)}.json`,
      sizeBytes: statSync(runtimeEvidenceBundlePath).size,
      sha256: sha256File(runtimeEvidenceBundlePath),
    };
    const records = {
      reproducibilityReview: {
        schemaVersion: 1,
        type: "gifp-public-ffmpeg-reproducibility",
        status: "pass",
        reproducible: true,
        gitCommit: reviewedBuildCommit,
        baseline: { buildIdentity, artifacts: { runtimeArchive } },
        replay: { buildIdentity, artifacts: { runtimeArchive } },
        checks: [{ id: "runtime", ok: true }],
        errors: [],
      },
      windowsRuntimeReview: {
        schemaVersion: 1,
        type: "gifp-public-ffmpeg-windows-runtime-review",
        completeWindowsRuntimeReview: true,
        status: "pass",
        reviewer: "Independent Windows reviewer",
        reviewedAt: "2026-07-17T00:00:00.000Z",
        ...identity,
        evidenceBundle: runtimeEvidenceBundle,
        checks: Object.fromEntries([
          "isolatedRuntime", "h264MfSoftware", "h264MfFallback", "gif", "animatedWebp",
          "apng", "mp4", "webm", "assText", "screenCapture", "realMedia",
        ].map((name) => [name, true])),
        matrix: {
          inputCount: 5,
          totalRoutes: 30,
          passed: 30,
          failed: 0,
          timeouts: 0,
          inputSha256: runtimeInputSha256,
        },
        screenCapture: {
          backend: "gdigrab",
          pass: true,
          capturedWidth: 1920,
          capturedHeight: 1080,
          frameCount: 1,
          encodedGifWidth: 320,
          encodedGifHeight: 180,
          experimentalDdagrab: { enabledAsFallback: false, status: "first-frame-timeout" },
        },
        h264MediaFoundation: {
          software: true,
          hardwareAvailable: false,
          hardwareFailure: "MF_E_UNSUPPORTED_D3D_TYPE",
          fallback: "software",
          fallbackPass: true,
        },
        evidence: runtimeEvidence,
        warnings: [],
        errors: [],
      },
      correspondingSourceReview: {
        schemaVersion: 1,
        type: "gifp-public-ffmpeg-corresponding-source-review",
        completeCorrespondingSourceReviewed: true,
        ...identity,
      },
    };
    for (const [key, record] of Object.entries(records)) {
      const path = join(dir, "ffmpeg-public", "reviews", `${key}.json`);
      mkdirSync(join(dir, "ffmpeg-public", "reviews"), { recursive: true });
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      manifest.publicReleaseProfile.reviewEvidence[key] = {
        path: `ffmpeg-public/reviews/${key}.json`,
        sizeBytes: statSync(path).size,
        sha256: sha256File(path),
      };
    }
    const manifestPath = join(dir, "public.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const verified = verifyPublicReviewRecords(manifest, manifestPath, releaseCommit);
    assert.equal(verified.windowsRuntimeReview.sha256, manifest.publicReleaseProfile.reviewEvidence.windowsRuntimeReview.sha256);
    assert.equal(verified.reviewedBuildCommit, reviewedBuildCommit);
    assert.equal(verified.releaseCommit, releaseCommit);

    const windowsRecordPath = join(dir, "ffmpeg-public", "reviews", "windowsRuntimeReview.json");
    const originalWindowsRecord = JSON.parse(JSON.stringify(records.windowsRuntimeReview));
    const writeWindowsMutation = (mutate) => {
      const candidate = JSON.parse(JSON.stringify(originalWindowsRecord));
      mutate(candidate);
      writeFileSync(windowsRecordPath, `${JSON.stringify(candidate, null, 2)}\n`);
      manifest.publicReleaseProfile.reviewEvidence.windowsRuntimeReview = {
        path: "ffmpeg-public/reviews/windowsRuntimeReview.json",
        sizeBytes: statSync(windowsRecordPath).size,
        sha256: sha256File(windowsRecordPath),
      };
    };

    writeWindowsMutation((record) => { record.matrix.inputSha256[0] = "f".repeat(64); });
    assert.throws(
      () => verifyPublicReviewRecords(manifest, manifestPath, releaseCommit),
      /input hashes do not match the evidence bundle/,
    );
    writeWindowsMutation((record) => { record.evidence[0].sha256 = "e".repeat(64); });
    assert.throws(
      () => verifyPublicReviewRecords(manifest, manifestPath, releaseCommit),
      /evidence does not match the evidence bundle/,
    );
    writeWindowsMutation((record) => { record.evidence[0].fileName = "substitute.json"; });
    assert.throws(
      () => verifyPublicReviewRecords(manifest, manifestPath, releaseCommit),
      /evidence does not match the evidence bundle/,
    );
    writeWindowsMutation(() => {});

    manifest.publicReleaseProfile.reviewedBuildCommit = "6".repeat(40);
    assert.throws(
      () => verifyPublicReviewRecords(manifest, manifestPath, releaseCommit),
      /does not match the reviewed build commit/,
    );
    manifest.publicReleaseProfile.reviewedBuildCommit = reviewedBuildCommit;

    writeFileSync(windowsRecordPath, "{}\n");
    assert.throws(() => verifyPublicReviewRecords(manifest, manifestPath, releaseCommit), /windowsRuntimeReview size mismatch|windowsRuntimeReview SHA-256 mismatch/);
  });
});

test("tracked public-alpha source and build-recipe locks bind every build input", () => {
  const manifestPath = join(process.cwd(), "compliance", "ffmpeg-windows-x64-lgpl-shared-public.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const facts = verifyPublicSourceLock(manifest, manifestPath);
  assert.equal(facts.sourceCount, 11);
  assert.equal(facts.buildRecipeLock.inputs.length, 8);
  assert.equal(facts.buildRecipeLock.sha256, manifest.publicReleaseProfile.buildRecipeLock.sha256);
});

test("tracked public manifest records the pending n9.0 rebuild and remains fail-closed", () => {
  const manifestPath = join(process.cwd(), "compliance", "ffmpeg-windows-x64-lgpl-shared-public.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifestForChannel(manifest, "public-alpha");

  assert.equal(manifest.distributionPolicy.publicAlphaAllowed, false);
  assert.equal(manifest.publicReleaseProfile.readiness.immutableBuildInputsVerified, false);
  assert.equal(manifest.publicReleaseProfile.readiness.runtimeCapabilitiesReviewed, false);
  assert.equal(manifest.publicReleaseProfile.reviewedBuildCommit, null);
  assert.equal(manifest.runtimeFiles.length, 0);
  assert.equal(manifest.binaryAsset.status, "pending-build");
  assert.equal(manifest.binaryAsset.sha256, null);
  assert.deepEqual(manifest.distributionPolicy.publicBlockers, [
    "PUBLIC_LGPL_RUNTIME_NOT_BUILT",
    "PUBLIC_LGPL_RUNTIME_IMMUTABLE_URL_NOT_SET",
    "PUBLIC_LGPL_CAPABILITY_REVIEW_NOT_COMPLETE",
    "PUBLIC_LGPL_REPRODUCIBILITY_REVIEW_NOT_COMPLETE",
    "PUBLIC_LGPL_CORRESPONDING_SOURCE_NOT_ARCHIVED",
  ]);

  assert.equal(manifest.publicReleaseProfile.reviewEvidence.reproducibilityReview, null);
  assert.equal(manifest.publicReleaseProfile.reviewEvidence.windowsRuntimeReview, null);

  assert.throws(() => assertPublicManifestReady(manifest), (error) => {
    assert.match(error.message, /PUBLIC_LGPL_RUNTIME_NOT_BUILT/);
    assert.match(error.message, /PUBLIC_LGPL_RUNTIME_IMMUTABLE_URL_NOT_SET/);
    assert.match(error.message, /PUBLIC_LGPL_CAPABILITY_REVIEW_NOT_COMPLETE/);
    assert.match(error.message, /PUBLIC_LGPL_REPRODUCIBILITY_REVIEW_NOT_COMPLETE/);
    assert.match(error.message, /PUBLIC_LGPL_CORRESPONDING_SOURCE_NOT_ARCHIVED/);
    assert.match(error.message, /READINESS_runtimeBuiltAndPinned/);
    assert.match(error.message, /READINESS_runtimeCapabilitiesReviewed/);
    assert.match(error.message, /READINESS_correspondingSourceArchived/);
    assert.match(error.message, /READINESS_immutableBuildInputsVerified/);
    return true;
  });
});

test("public-alpha version gate requires LGPL flags and forbids version3", () => {
  const manifest = publicFixtureManifest([
    { name: "ffmpeg.exe", sizeBytes: 1, sha256: "b".repeat(64) },
    { name: "ffprobe.exe", sizeBytes: 1, sha256: "c".repeat(64) },
  ]);
  const valid = [
    "ffmpeg version N-1-g123-20260711",
    "configuration: --disable-version3 --enable-shared --disable-static --disable-gpl --disable-nonfree --disable-autodetect --disable-network --enable-parser='av1,gif,h264,hevc,mpeg4video,mpegvideo,vp8,vp9'",
    "",
  ].join("\n");
  assert.match(verifyFfmpegVersion(manifest, valid).configurationLine, /--disable-gpl/);
  assert.throws(
    () => verifyFfmpegVersion(manifest, valid.replace("av1,gif,h264", "av1,h264")),
    /missing required flag --enable-parser=/,
  );
  assert.throws(
    () => verifyFfmpegVersion(manifest, `${valid.trim()} --enable-version3\n`),
    /forbidden flag --enable-version3/,
  );
});

test("internal channel stays explicitly non-redistributable", () => {
  const result = evaluateDistributionPolicy(fixtureManifest(), {
    channel: "internal",
    signatureStatus: "NotSigned",
  });
  assert.equal(result.redistributable, false);
  assert.equal(result.status, "INTERNAL DEVELOPMENT PACKAGE - DO NOT REDISTRIBUTE");
  assert.equal(result.unsigned, true);
});

test("internal preview records the verified GIFP freeware license", () => {
  withTempDir((dir) => {
    const license = join(dir, "LICENSE.txt");
    writeFileSync(license, "GIFP FREEWARE LICENSE 1.0\n");
    const result = evaluateDistributionPolicy(fixtureManifest(), {
      channel: "internal",
      signatureStatus: "NotSigned",
      projectLicenseId: "LicenseRef-GIFP-Freeware-1.0",
      projectLicenseFile: license,
      projectLicenseSha256: sha256File(license),
    });
    assert.equal(result.redistributable, false);
    assert.equal(result.projectLicense.id, "LicenseRef-GIFP-Freeware-1.0");
    assert.equal(result.projectLicense.sha256, sha256File(license));
    assert.match(result.warnings.join(" "), /Corresponding Source/);
  });
});

test("invalid signature state is never accepted", () => {
  assert.throws(
    () => evaluateDistributionPolicy(fixtureManifest(), {
      channel: "internal",
      signatureStatus: "HashMismatch",
    }),
    /Unsafe executable signature status/,
  );
});

test("FFmpeg license is pinned like executable code", () => {
  withTempDir((dir) => {
    const license = join(dir, "LICENSE.txt");
    writeFileSync(license, "license");
    const manifest = fixtureManifest([
      { name: "ffmpeg.exe", sizeBytes: 1, sha256: "b".repeat(64) },
      { name: "ffprobe.exe", sizeBytes: 1, sha256: "c".repeat(64) },
    ]);
    manifest.licenseFile = {
      name: "LICENSE.txt",
      sizeBytes: 7,
      sha256: sha256File(license),
    };
    assert.equal(verifyFfmpegLicense(manifest, license).sizeBytes, 7);
    writeFileSync(license, "changed");
    assert.throws(() => verifyFfmpegLicense(manifest, license), /mismatch/);
  });
});

test("dependency manifest blocks unresolved licenses", () => {
  withTempDir((dir) => {
    const path = join(dir, "THIRD_PARTY-MANIFEST.json");
    const manifest = {
      schemaVersion: 1,
      generator: { deterministic: true },
      summary: {
        componentCount: 1,
        missingLicenseCount: 0,
        byEcosystem: { cargo: { componentCount: 1, missingLicenseCount: 0 } },
      },
      components: [{
        ecosystem: "cargo",
        name: "demo",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        license: "MIT",
        missingLicense: false,
      }],
    };
    writeFileSync(path, JSON.stringify(manifest));
    assert.equal(verifyDependencyManifest(path).componentCount, 1);
    manifest.summary.missingLicenseCount = 1;
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => verifyDependencyManifest(path), /count is inconsistent/);
    manifest.components[0].license = null;
    manifest.components[0].missingLicense = true;
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => verifyDependencyManifest(path), /unresolved license/);
  });
});

test("license-text bundle is tied to the dependency manifest and real text bytes", () => {
  withTempDir((dir) => {
    const dependencyPath = join(dir, "THIRD_PARTY-MANIFEST.json");
    const textDir = join(dir, "texts");
    const licensePath = join(textDir, `${"a".repeat(64)}.txt`);
    mkdirSync(textDir);
    writeFileSync(licensePath, "license bytes");
    const actualTextSha = sha256File(licensePath);
    const renamedLicensePath = join(textDir, `${actualTextSha}.txt`);
    renameSync(licensePath, renamedLicensePath);
    const dependency = {
      schemaVersion: 1,
      generator: { deterministic: true },
      summary: { componentCount: 1, missingLicenseCount: 0, byEcosystem: {} },
      components: [{
        ecosystem: "cargo",
        name: "demo",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        license: "MIT",
        missingLicense: false,
      }],
    };
    writeFileSync(dependencyPath, JSON.stringify(dependency));
    const dependencyFacts = verifyDependencyManifest(dependencyPath);
    const bundlePath = join(dir, "LICENSE-TEXTS.json");
    const bundle = {
      schemaVersion: 1,
      generator: { deterministic: true },
      sourceManifest: { sha256: dependencyFacts.sha256 },
      licenseOverlayManifest: null,
      summary: {
        componentCount: 1,
        componentsWithLicenseTextCount: 1,
        missingLicenseTextCount: 0,
        uniqueLicenseTextCount: 1,
      },
      components: [{
        ecosystem: "cargo",
        name: "demo",
        version: "1.0.0",
        source: "registry+https://github.com/rust-lang/crates.io-index",
        license: "MIT",
        missingLicense: false,
        overlayApplied: false,
        missingLicenseText: false,
        licenseTexts: [{
          sha256: actualTextSha,
          path: `texts/${actualTextSha}.txt`,
          sizeBytes: 13,
          kinds: ["license"],
          sourceNames: ["LICENSE"],
          provenanceUrls: [],
          vcsCommits: [],
          vcsUrls: [],
          sourceTypes: [],
        }],
      }],
      texts: [{
        sha256: actualTextSha,
        path: `texts/${actualTextSha}.txt`,
        sizeBytes: 13,
      }],
    };
    writeFileSync(bundlePath, JSON.stringify(bundle));
    assert.equal(verifyLicenseTextBundle(bundlePath, dependencyFacts).uniqueLicenseTextCount, 1);
    bundle.components[0].licenseTexts = [];
    bundle.components[0].missingLicenseText = true;
    writeFileSync(bundlePath, JSON.stringify(bundle));
    assert.throws(() => verifyLicenseTextBundle(bundlePath, dependencyFacts), /covered-component count is inconsistent/);
    bundle.components[0].licenseTexts = [{
      sha256: actualTextSha,
      path: `texts/${actualTextSha}.txt`,
      sizeBytes: 13,
      kinds: ["license"],
      sourceNames: ["LICENSE"],
      provenanceUrls: [],
      vcsCommits: [],
      vcsUrls: [],
      sourceTypes: [],
    }];
    bundle.components[0].missingLicenseText = false;
    writeFileSync(bundlePath, JSON.stringify(bundle));
    writeFileSync(renamedLicensePath, "tampered");
    assert.throws(() => verifyLicenseTextBundle(bundlePath, dependencyFacts), /mismatch/);
  });
});

test("packaged license overlays are hash-bound to the exact dependency component", () => {
  withTempDir((dir) => {
    const source = "registry+https://github.com/rust-lang/crates.io-index";
    const commit = "1".repeat(40);
    const repository = "https://github.com/example/project";
    const vcsUrl = `${repository}/commit/${commit}`;
    const sourceUrl = `https://raw.githubusercontent.com/example/project/${commit}/LICENSE`;
    const dependencyPath = join(dir, "THIRD_PARTY-MANIFEST.json");
    const dependency = {
      schemaVersion: 1,
      generator: { deterministic: true },
      summary: { componentCount: 1, missingLicenseCount: 0, byEcosystem: {} },
      components: [{
        ecosystem: "cargo",
        name: "demo",
        version: "1.0.0",
        source,
        integrity: "integrity-demo",
        repository,
        license: "MIT",
        missingLicense: false,
      }],
    };
    writeFileSync(dependencyPath, JSON.stringify(dependency));
    const dependencyFacts = verifyDependencyManifest(dependencyPath);
    const textDir = join(dir, "texts");
    mkdirSync(textDir);
    const temporaryText = join(textDir, "temporary.txt");
    writeFileSync(temporaryText, "reviewed license\n");
    const textSha = sha256File(temporaryText);
    const textPath = join(textDir, `${textSha}.txt`);
    renameSync(temporaryText, textPath);
    const overlay = {
      schemaVersion: 1,
      entries: [{
        ecosystem: "cargo",
        name: "demo",
        version: "1.0.0",
        source,
        integrity: "integrity-demo",
        license: "MIT",
        vcsCommit: commit,
        vcsUrl,
        files: [{
          path: "compliance/license-texts/demo-MIT.txt",
          sha256: textSha,
          kind: "license",
          sourceType: "repository-revision",
          sourceUrl,
        }],
      }],
    };
    const overlayPath = join(dir, "LICENSE-OVERLAYS.json");
    writeFileSync(overlayPath, JSON.stringify(overlay));
    const bundlePath = join(dir, "LICENSE-TEXTS.json");
    const bundle = {
      schemaVersion: 1,
      generator: { deterministic: true },
      sourceManifest: { sha256: dependencyFacts.sha256 },
      licenseOverlayManifest: {
        path: "compliance/license-text-overlays.json",
        bundlePath: "LICENSE-OVERLAYS.json",
        sizeBytes: statSync(overlayPath).size,
        sha256: sha256File(overlayPath),
        entryCount: 1,
      },
      summary: {
        componentCount: 1,
        componentsWithLicenseTextCount: 1,
        missingLicenseTextCount: 0,
        uniqueLicenseTextCount: 1,
      },
      components: [{
        ecosystem: "cargo",
        name: "demo",
        version: "1.0.0",
        source,
        license: "MIT",
        missingLicense: false,
        overlayApplied: true,
        missingLicenseText: false,
        licenseTexts: [{
          sha256: textSha,
          path: `texts/${textSha}.txt`,
          sizeBytes: 17,
          kinds: ["license"],
          sourceNames: ["overlay:compliance/license-texts/demo-MIT.txt"],
          provenanceUrls: [sourceUrl],
          vcsCommits: [commit],
          vcsUrls: [vcsUrl],
          sourceTypes: ["repository-revision"],
        }],
      }],
      texts: [{
        sha256: textSha,
        path: `texts/${textSha}.txt`,
        sizeBytes: 17,
      }],
    };
    writeFileSync(bundlePath, JSON.stringify(bundle));
    assert.equal(verifyLicenseTextBundle(bundlePath, dependencyFacts).missingLicenseTextCount, 0);

    bundle.components[0].name = "fiction";
    writeFileSync(bundlePath, JSON.stringify(bundle));
    assert.throws(() => verifyLicenseTextBundle(bundlePath, dependencyFacts), /not in the dependency closure/);
    bundle.components[0].name = "demo";
    writeFileSync(bundlePath, JSON.stringify(bundle));
    writeFileSync(overlayPath, "{}\n");
    assert.throws(() => verifyLicenseTextBundle(bundlePath, dependencyFacts), /size mismatch|SHA-256 mismatch/);
  });
});

test("public-alpha requires license, clean commit and reviewed source", () => {
  assert.throws(
    () => evaluateDistributionPolicy(publicFixtureManifest(), {
      channel: "public-alpha",
      signatureStatus: "NotSigned",
    }),
    /40-character Git commit/,
  );
});

test("--git-dirty accepts only the four explicit boolean spellings", () => {
  assert.equal(parseStrictBoolean("true", "--git-dirty"), true);
  assert.equal(parseStrictBoolean("false", "--git-dirty"), false);
  assert.equal(parseStrictBoolean("1", "--git-dirty"), true);
  assert.equal(parseStrictBoolean("0", "--git-dirty"), false);
  for (const value of ["yes", "TRUE", "False", "", 1, 0, null, undefined]) {
    assert.throws(() => parseStrictBoolean(value, "--git-dirty"), /must be exactly/);
  }
  assert.throws(
    () => evaluateDistributionPolicy(fixtureManifest(), {
      channel: "internal",
      signatureStatus: "NotSigned",
      gitDirty: "TRUE",
    }),
    /must be exactly/,
  );
});

test("public-alpha requires a Quality Lab commit point while internal stays compatible without one", () => {
  assert.equal(verifyReleaseQualityEvidence({ channel: "internal" }), null);
  assert.throws(
    () => verifyReleaseQualityEvidence({ channel: "public-alpha" }),
    /public-alpha requires GIFP_QUALITY_REPORT/,
  );
});

test("public-alpha binds strict Quality evidence and materializes a versioned portable projection", () => {
  withTempDir((dir) => {
    const verified = qualityEvidenceFixture(dir);
    writeFileSync(join(dir, "quality-source", "report-bundle", "unlisted.txt"), "must not ship\n");
    assert.throws(
      () => verifyReleaseQualityEvidence({
        channel: "public-alpha",
        gitCommit: "a".repeat(40),
        gitTreeHash: "b".repeat(40),
        gitDirty: false,
        qualityReport: verified.report_path,
      }, () => verified),
      /requires a Quality evidence materialization directory/,
    );
    const outputDir = join(dir, "QUALITY_EVIDENCE");
    let verifierOptions = null;
    const summary = verifyReleaseQualityEvidence({
      channel: "public-alpha",
      gitCommit: "a".repeat(40),
      gitTreeHash: "b".repeat(40),
      gitDirty: false,
      qualityReport: verified.report_path,
      qualityEvidenceDir: outputDir,
    }, (options) => {
      verifierOptions = options;
      return verified;
    });

    assert.equal(verifierOptions.requireFirstTierQuality, true);
    assert.equal(summary.qualifiedForFirstTierRelease, true);
    assert.equal(summary.binding.commitMatchesPackage, true);
    const escapedSourceRoot = JSON.stringify(dir).slice(1, -1);
    assert.equal(JSON.stringify(summary).includes(escapedSourceRoot), false);
    for (const path of [
      "QUALITY-EVIDENCE.json",
      "PORTABLE-PROJECTION.json",
      "quality-report.json",
      "bench/quality-report.schema.json",
      "bench/corpus-manifest.json",
      "artifact-bundle/bundle-manifest.json",
      "artifact-bundle/report.json",
      "artifact-bundle/blind.html",
      "artifact-bundle/build-provenance.json",
    ]) {
      assert.equal(existsSync(join(outputDir, path)), true, `missing materialized ${path}`);
    }
    assert.deepEqual(
      JSON.parse(readFileSync(join(outputDir, "QUALITY-EVIDENCE.json"), "utf8")),
      summary,
    );
    const projection = JSON.parse(readFileSync(join(outputDir, "PORTABLE-PROJECTION.json"), "utf8"));
    assert.equal(projection.contractId, "gifp.quality-evidence-portable-projection.v1");
    assert.equal(projection.source.report.sha256, verified.report_sha256);
    assert.equal(projection.source.artifactBundleManifest.sha256, verified.artifact_bundle_manifest_sha256);
    assert.equal(summary.report.sourceSha256, verified.report_sha256);
    assert.equal(summary.artifactBundle.sourceManifestSha256, verified.artifact_bundle_manifest_sha256);
    assert.equal(summary.portableProjection.recordSha256, sha256File(join(outputDir, "PORTABLE-PROJECTION.json")));
    assert.equal(sha256File(join(outputDir, "quality-report.json")), summary.report.sha256);
    assert.equal(
      sha256File(join(outputDir, "artifact-bundle", "bundle-manifest.json")),
      summary.artifactBundle.manifestSha256,
    );
    const projectedManifest = JSON.parse(readFileSync(join(outputDir, "artifact-bundle", "bundle-manifest.json"), "utf8"));
    for (const artifact of projectedManifest.artifacts) {
      const artifactPath = join(outputDir, "artifact-bundle", artifact.relative_path);
      assert.equal(statSync(artifactPath).size, artifact.size_bytes);
      assert.equal(sha256File(artifactPath), artifact.sha256);
    }
    assert.equal(existsSync(join(outputDir, "artifact-bundle", "unlisted.txt")), false);
  });
});

test("public-alpha rejects stale, dirty, or unqualified Quality evidence", () => {
  withTempDir((dir) => {
    const verified = qualityEvidenceFixture(dir);
    assert.throws(
      () => evaluateQualityReleaseBinding(verified, {
        channel: "public-alpha",
        gitCommit: "b".repeat(40),
        gitTreeHash: "b".repeat(40),
        gitDirty: false,
      }),
      /does not match package commit/,
    );
    assert.throws(
      () => evaluateQualityReleaseBinding({ ...verified, git_dirty: true }, {
        channel: "public-alpha",
        gitCommit: "a".repeat(40),
        gitTreeHash: "b".repeat(40),
        gitDirty: false,
      }),
      /captured from a dirty worktree/,
    );
    assert.throws(
      () => evaluateQualityReleaseBinding(verified, {
        channel: "public-alpha",
        gitCommit: "a".repeat(40),
        gitTreeHash: "b".repeat(40),
        gitDirty: true,
      }),
      /package worktree is dirty/,
    );
    assert.throws(
      () => evaluateQualityReleaseBinding({
        ...verified,
        first_tier_quality_passed: false,
      }, {
        channel: "public-alpha",
        gitCommit: "a".repeat(40),
        gitTreeHash: "b".repeat(40),
        gitDirty: false,
      }),
      /requires a passing first-tier quality gate/,
    );
    assert.throws(
      () => evaluateQualityReleaseBinding({
        ...verified,
        canonical_fixture_identity: {
          ...verified.canonical_fixture_identity,
          live_source_identity_verified: false,
        },
      }, {
        channel: "public-alpha",
        gitCommit: "a".repeat(40),
        gitTreeHash: "b".repeat(40),
        gitDirty: false,
      }),
      /does not have a live, fixed identity/,
    );
    assert.throws(
      () => evaluateQualityReleaseBinding(verified, {
        channel: "public-alpha",
        gitCommit: "a".repeat(40),
        gitTreeHash: "c".repeat(40),
        gitDirty: false,
      }),
      /tracked tree does not match/,
    );
  });
});

test("public evidence projects machine-local paths while preserving HTTPS URLs and source hashes", () => {
  withTempDir((dir) => {
    const verified = qualityEvidenceFixture(dir);
    writeFileSync(verified.report_path, `${JSON.stringify({
      manifest_path: "F:\\Users\\kanon\\private.json",
      extended_path: "\\\\?\\D:\\private\\fixture.mkv",
      unc_path: "\\\\lab-host\\share\\fixture.mkv",
      forward_unc_path: "//lab-host/share/fixture.mkv",
      file_url: "file:///E:/private/fixture.mkv",
    })}\n`);
    verified.report_sha256 = sha256File(verified.report_path);
    verified.report_size_bytes = statSync(verified.report_path).size;
    const originalReportSha256 = verified.report_sha256;
    writeFileSync(
      verified.artifacts[1].source_path,
      '<html><a href="https://example.test/review">review</a><span>C:\\\\Users\\\\kanon\\\\blind</span></html>\n',
    );
    verified.artifacts[1].sha256 = sha256File(verified.artifacts[1].source_path);
    verified.artifacts[1].size_bytes = statSync(verified.artifacts[1].source_path).size;
    const sourceBundleManifest = JSON.parse(readFileSync(verified.artifact_bundle_manifest_path, "utf8"));
    sourceBundleManifest.artifacts = verified.artifacts.map(({ source_path: ignored, ...artifact }) => artifact);
    writeFileSync(verified.artifact_bundle_manifest_path, `${JSON.stringify(sourceBundleManifest)}\n`);
    verified.artifact_bundle_manifest_sha256 = sha256File(verified.artifact_bundle_manifest_path);
    verified.artifact_bundle_manifest_size_bytes = statSync(verified.artifact_bundle_manifest_path).size;
    const outputDir = join(dir, "portable-evidence");
    const summary = verifyReleaseQualityEvidence({
      channel: "public-alpha",
      gitCommit: "a".repeat(40),
      gitTreeHash: "b".repeat(40),
      gitDirty: false,
      qualityReport: verified.report_path,
      qualityEvidenceDir: outputDir,
    }, () => verified);
    const projectedReport = readFileSync(join(outputDir, "quality-report.json"), "utf8");
    const projectedHtml = readFileSync(join(outputDir, "artifact-bundle", "blind.html"), "utf8");
    assert.doesNotMatch(projectedReport, /F:\\\\Users/i);
    assert.doesNotMatch(projectedReport, /lab-host[\\/]+share/i);
    assert.doesNotMatch(projectedReport, /\\\\\?\\D:/i);
    assert.doesNotMatch(projectedReport, /file:\/{2,3}E:/i);
    assert.doesNotMatch(projectedHtml, /C:\\\\Users/i);
    assert.match(projectedReport, /portable:\/\/local\//);
    assert.match(projectedHtml, /portable:\/\/local\//);
    assert.match(projectedHtml, /https:\/\/example\.test\/review/);
    assert.equal(summary.report.sourceSha256, originalReportSha256);
    const projection = JSON.parse(readFileSync(join(outputDir, "PORTABLE-PROJECTION.json"), "utf8"));
    assert.equal(projection.source.report.sha256, originalReportSha256);
    assert.ok(projection.transformations.machinePathPrefixesReplaced >= 6);
  });
});

test("internal records valid stale Quality evidence without claiming first-tier qualification", () => {
  withTempDir((dir) => {
    const verified = qualityEvidenceFixture(dir, {
      first_tier_quality_passed: false,
    });
    const outputDir = join(dir, "internal-evidence");
    const summary = verifyReleaseQualityEvidence({
      channel: "internal",
      gitCommit: "b".repeat(40),
      qualityReport: verified.report_path,
      qualityEvidenceDir: outputDir,
    }, () => verified);
    assert.equal(summary.qualifiedForFirstTierRelease, false);
    assert.equal(summary.binding.commitMatchesPackage, false);
    assert.equal(existsSync(join(outputDir, "QUALITY-EVIDENCE.json")), true);
  });
});

test("an explicitly supplied malformed internal Quality report fails closed", () => {
  withTempDir((dir) => {
    const report = join(dir, "broken.json");
    writeFileSync(report, "{}\n");
    assert.throws(
      () => verifyReleaseQualityEvidence({
        channel: "internal",
        qualityReport: report,
      }),
      /Quality evidence verification failed:/,
    );
  });
});

test("Quality evidence materialization refuses pre-existing output and source mutation", () => {
  withTempDir((dir) => {
    const verified = qualityEvidenceFixture(dir);
    const summary = evaluateQualityReleaseBinding(verified, {
      channel: "internal",
      gitCommit: "a".repeat(40),
    });
    const existing = join(dir, "existing");
    mkdirSync(existing);
    assert.throws(
      () => materializeQualityEvidence(verified, existing, summary),
      /output directory already exists/,
    );

    writeFileSync(verified.artifacts[0].source_path, "tampered after verification\n");
    assert.throws(
      () => materializeQualityEvidence(verified, join(dir, "mutated"), summary),
      /source (size|SHA-256) changed after verification/,
    );
  });
});

test("Quality evidence materialization rejects an unsafe manifest-relative output path", () => {
  withTempDir((dir) => {
    const verified = qualityEvidenceFixture(dir);
    verified.artifacts[0].relative_path = "../escape.json";
    const summary = evaluateQualityReleaseBinding(verified, {
      channel: "internal",
      gitCommit: "a".repeat(40),
    });
    assert.throws(
      () => materializeQualityEvidence(verified, join(dir, "unsafe"), summary),
      /Quality bundle artifact path is unsafe/,
    );
    assert.equal(existsSync(join(dir, "escape.json")), false);
  });
});

test("Quality evidence materialization rejects junction or symlink output parents", () => {
  withTempDir((dir) => {
    const verified = qualityEvidenceFixture(dir);
    const summary = evaluateQualityReleaseBinding(verified, {
      channel: "internal",
      gitCommit: "a".repeat(40),
      gitDirty: false,
    });
    const realParent = join(dir, "real-parent");
    const linkedParent = join(dir, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => materializeQualityEvidence(
        verified,
        join(linkedParent, "QUALITY_EVIDENCE"),
        summary,
        { allowedParentDir: linkedParent },
      ),
      /reparse point|regular directory/,
    );
  });
});

test("public-alpha accepts reviewed source and makes unsigned override explicit", () => {
  withTempDir((dir) => {
    const manifest = publicFixtureManifest();
    const license = join(dir, "LICENSE.txt");
    const source = join(dir, "ffmpeg-corresponding-source.tar.zst");
    const record = join(dir, "SOURCE-REVIEW.json");
    writeFileSync(license, "Example project license");
    writeFileSync(source, "complete reviewed source fixture");
    const sourceHash = sha256File(source);
    writeFileSync(record, JSON.stringify({
      schemaVersion: 1,
      completeCorrespondingSourceReviewed: true,
      ffmpegCommit: manifest.version.ffmpegCommit,
      buildRecipeCommit: manifest.version.buildRecipeCommit,
      sourceLockSha256: manifest.publicReleaseProfile.sourceLock.sha256,
      buildRecipeLockSha256: manifest.publicReleaseProfile.buildRecipeLock.sha256,
      binaryAssetSha256: manifest.binaryAsset.sha256,
      archiveSha256: sourceHash,
      reviewer: "QA",
      reviewedAt: "2026-07-17T00:00:00Z",
      distributionUrl: "https://example.test/sources/build-2026-07-11/source.tar.zst",
    }));
    const options = {
      channel: "public-alpha",
      gitCommit: "3".repeat(40),
      gitDirty: false,
      artifactName: "GIFP-5.1.0-alpha",
      projectLicenseId: "LicenseRef-GIFP-Test",
      projectLicenseFile: license,
      projectLicenseSha256: sha256File(license),
      sourceBundle: source,
      sourceBundleSha256: sourceHash,
      sourceBundleRecord: record,
      signatureStatus: "NotSigned",
    };

    assert.throws(
      () => evaluateDistributionPolicy(manifest, options),
      /GIFP_ALLOW_UNSIGNED_ALPHA=1/,
    );
    const result = evaluateDistributionPolicy(manifest, {
      ...options,
      allowUnsignedAlpha: true,
    });
    assert.equal(result.redistributable, true);
    assert.equal(result.unsigned, true);
    assert.equal(result.correspondingSource.sha256, sourceHash);
    assert.equal(result.correspondingSource.recordSha256, sha256File(record));
    assert.equal(result.correspondingSource.recordSizeBytes, statSync(record).size);
    assert.equal(result.projectLicense.id, "LicenseRef-GIFP-Test");
  });
});

test("public is fail-closed to a Valid allowlisted Authenticode signer", () => {
  withTempDir((dir) => {
    const manifest = publicFixtureManifest();
    const license = join(dir, "LICENSE.txt");
    const source = join(dir, "ffmpeg-corresponding-source.tar.zst");
    const record = join(dir, "SOURCE-REVIEW.json");
    writeFileSync(license, "Example project license");
    writeFileSync(source, "complete reviewed source fixture");
    const sourceHash = sha256File(source);
    writeFileSync(record, JSON.stringify({
      schemaVersion: 1,
      completeCorrespondingSourceReviewed: true,
      ffmpegCommit: manifest.version.ffmpegCommit,
      buildRecipeCommit: manifest.version.buildRecipeCommit,
      sourceLockSha256: manifest.publicReleaseProfile.sourceLock.sha256,
      buildRecipeLockSha256: manifest.publicReleaseProfile.buildRecipeLock.sha256,
      binaryAssetSha256: manifest.binaryAsset.sha256,
      archiveSha256: sourceHash,
      reviewer: "QA",
      reviewedAt: "2026-07-17T00:00:00Z",
      distributionUrl: "https://example.test/sources/build-2026-07-11/source.tar.zst",
    }));
    const thumbprint = "a".repeat(40);
    const options = {
      channel: "public",
      gitCommit: "3".repeat(40),
      gitDirty: false,
      artifactName: "GIFP-5.7.18",
      projectLicenseId: "LicenseRef-GIFP-Test",
      projectLicenseFile: license,
      projectLicenseSha256: sha256File(license),
      sourceBundle: source,
      sourceBundleSha256: sourceHash,
      sourceBundleRecord: record,
      signatureStatus: "NotSigned",
      allowUnsignedAlpha: true,
      signerThumbprint: "",
      allowedSignerThumbprint: thumbprint,
    };

    assert.throws(
      () => evaluateDistributionPolicy(manifest, options),
      /public requires a Valid Authenticode signature; unsigned override is forbidden/,
    );
    assert.throws(
      () => evaluateDistributionPolicy(manifest, {
        ...options,
        signatureStatus: "Valid",
        signerThumbprint: "b".repeat(40),
      }),
      /not allowlisted/,
    );
    const result = evaluateDistributionPolicy(manifest, {
      ...options,
      signatureStatus: "Valid",
      signerThumbprint: thumbprint.toUpperCase(),
    });
    assert.equal(result.channel, "public");
    assert.equal(result.redistributable, true);
    assert.equal(result.unsigned, false);
    assert.equal(result.status, "PUBLIC RELEASE - AUTHENTICODE SIGNED");
    assert.equal(result.signer.thumbprint, thumbprint);
  });
});

test("public requires a non-Alpha artifact identity", () => {
  const manifest = publicFixtureManifest();
  assert.throws(
    () => evaluateDistributionPolicy(manifest, {
      channel: "public",
      gitCommit: "3".repeat(40),
      gitDirty: false,
      artifactName: "GIFP-5.7.18-alpha",
      signatureStatus: "Valid",
    }),
    /must not contain alpha/,
  );
});
