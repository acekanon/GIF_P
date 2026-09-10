import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyQualityReport } from "./verify-quality-report.mjs";

export class ComplianceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ComplianceError";
  }
}

function requireValue(condition, message) {
  if (!condition) throw new ComplianceError(message);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ComplianceError(`${label} is not valid JSON: ${error.message}`);
  }
}

export function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function normalizeSha256(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  requireValue(/^[a-f0-9]{64}$/.test(normalized), `${label} must be a 64-character SHA-256 digest`);
  return normalized;
}

function isTruthy(value) {
  return value === true || value === "1" || String(value).toLowerCase() === "true";
}

function isPublicReleaseChannel(channel) {
  return channel === "public-alpha" || channel === "public";
}

export function parseStrictBoolean(value, label = "boolean option") {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new ComplianceError(`${label} must be exactly true, false, 1, or 0`);
}

function assertImmutableUrl(value, label) {
  requireValue(typeof value === "string" && value.startsWith("https://"), `${label} must be an HTTPS URL`);
  requireValue(!/(?:\/|\b)latest(?:\/|\b)/i.test(value), `${label} must not use a mutable latest URL`);
}

const PUBLIC_LGPL_PROFILE_ID = "gifp-windows-x64-lgpl-shared-public-v1";
const PUBLIC_LGPL_VARIANT = "gifp-win64-lgpl-shared";
const PUBLIC_LGPL_LICENSE = "LGPL-2.1-or-later";
const PUBLIC_REQUIRED_FLAGS = Object.freeze([
  "--disable-version3",
  "--enable-shared",
  "--disable-static",
  "--disable-gpl",
  "--disable-nonfree",
  "--disable-autodetect",
  "--disable-network",
  "--enable-parser=av1,gif,h264,hevc,mpeg4video,mpegvideo,vp8,vp9",
]);
const PUBLIC_FORBIDDEN_FLAGS = Object.freeze([
  "--enable-gpl",
  "--enable-version3",
  "--enable-nonfree",
  "--enable-libx264",
  "--enable-filter=eq",
  "--enable-filter=hqdn3d",
]);
const PUBLIC_FORBIDDEN_FILTERS = Object.freeze(["eq", "hqdn3d"]);
const PUBLIC_FORBIDDEN_ENCODERS = Object.freeze(["libx264", "libx264rgb"]);
const PUBLIC_REQUIRED_COMPONENTS = Object.freeze({
  protocols: Object.freeze(["file", "pipe"]),
  devices: Object.freeze(["gdigrab", "lavfi"]),
  demuxers: Object.freeze([
    "mov", "matroska", "gif", "apng", "image2", "image2pipe", "webp_anim",
    "webp_pipe", "png_pipe", "jpeg_pipe", "gif_pipe", "nut", "rawvideo",
  ]),
  decoders: Object.freeze([
    "h264", "hevc", "av1", "vp8", "vp9", "mpeg4", "gif", "png", "apng",
    "webp", "webp_anim", "mjpeg", "rawvideo", "wrapped_avframe", "bmp",
    "libvpx-vp9", "prores", "dnxhd", "mpeg2video", "vc1",
  ]),
  encoders: Object.freeze([
    "gif", "png", "mjpeg", "apng", "rawvideo", "wrapped_avframe",
    "libwebp_anim", "libvpx-vp9", "h264_mf",
  ]),
  muxers: Object.freeze(["gif", "webp", "apng", "mp4", "webm", "image2", "nut", "rawvideo", "null"]),
  filters: Object.freeze([
    "alphaextract", "ass", "atadenoise", "bilateral", "color", "colorbalance",
    "concat", "crop", "curves", "ddagrab", "drawgrid", "format", "fps", "gradfun",
    "hflip", "hue", "hwdownload", "lutyuv", "metadata", "pad", "palettegen",
    "paletteuse", "rotate", "scale", "select", "setpts", "setsar", "signalstats",
    "split", "transpose", "trim", "unsharp", "vflip", "vignette",
  ]),
  hwaccels: Object.freeze(["d3d11va"]),
});
const PUBLIC_RECIPE_INPUTS = Object.freeze([
  "scripts/ffmpeg-public/README.md",
  "scripts/ffmpeg-public/build-offline.sh",
  "scripts/ffmpeg-public/build-public-runtime.ps1",
  "scripts/ffmpeg-public/fetch-sources.ps1",
  "scripts/ffmpeg-public/ffmpeg-configure.args",
  "scripts/ffmpeg-public/ffmpeg-metadata-filter-avformat.patch",
  "scripts/ffmpeg-public/prepare_sources.py",
  "scripts/ffmpeg-public/verify-source-cache.mjs",
]);
const PUBLIC_READINESS_KEYS = Object.freeze([
  "runtimeBuiltAndPinned",
  "runtimeCapabilitiesReviewed",
  "correspondingSourceArchived",
  "immutableBuildInputsVerified",
]);
const PUBLIC_REVIEW_EVIDENCE = Object.freeze({
  reproducibilityReview: "immutableBuildInputsVerified",
  windowsRuntimeReview: "runtimeCapabilitiesReviewed",
  correspondingSourceReview: "correspondingSourceArchived",
});
const WINDOWS_RUNTIME_CHECKS = Object.freeze([
  "isolatedRuntime",
  "h264MfSoftware",
  "h264MfFallback",
  "gif",
  "animatedWebp",
  "apng",
  "mp4",
  "webm",
  "assText",
  "screenCapture",
  "realMedia",
]);
const WINDOWS_RUNTIME_EVIDENCE = Object.freeze([
  "public-release-revalidation",
  "animated-format-matrix",
  "independent-animated-validation",
  "video-and-ass-matrix",
  "interactive-screen-capture-diagnosis",
  "h264-media-foundation-fallback",
]);

function validateReviewEvidenceDescriptor(value, label, required = false) {
  if (value === null && !required) return null;
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} descriptor is missing`);
  requireValue(typeof value.path === "string" && value.path.length > 0, `${label} path is missing`);
  requireValue(!isAbsolute(value.path) && !value.path.split(/[\\/]+/).includes(".."), `${label} path must stay inside compliance/`);
  requireValue(/^ffmpeg-public\/reviews\/[A-Za-z0-9._-]+\.json$/.test(value.path), `${label} path must use ffmpeg-public/reviews/*.json`);
  requireValue(Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0, `${label} size is invalid`);
  normalizeSha256(value.sha256, `${label} hash`);
  return value;
}

function requireStringArray(value, label) {
  requireValue(Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0), `${label} must be a string array`);
  return value;
}

function requireArrayMembers(value, required, label) {
  const entries = requireStringArray(value, label);
  for (const item of required) {
    requireValue(entries.includes(item), `${label} is missing ${item}`);
  }
  return entries;
}

export function validateManifestForChannel(manifest, requestedChannel = "internal") {
  const channel = String(requestedChannel ?? "internal").trim().toLowerCase();
  requireValue(channel === "internal" || isPublicReleaseChannel(channel), `Unknown distribution channel: ${channel}`);
  if (channel === "internal") return manifest;

  requireValue(manifest?.schemaVersion === 1, "Unsupported FFmpeg compliance manifest schema");
  requireValue(manifest?.component === "FFmpeg", "Public compliance manifest component must be FFmpeg");
  requireValue(manifest?.platform === "windows-x86_64", "Public LGPL FFmpeg platform must be windows-x86_64");
  requireValue(manifest?.releaseProfile === PUBLIC_LGPL_PROFILE_ID, `public-alpha requires the explicit ${PUBLIC_LGPL_PROFILE_ID} manifest`);
  requireValue(manifest?.variant === PUBLIC_LGPL_VARIANT, `public-alpha FFmpeg variant must be ${PUBLIC_LGPL_VARIANT}`);
  requireValue(manifest?.licenseExpression === PUBLIC_LGPL_LICENSE, `public-alpha FFmpeg license must be ${PUBLIC_LGPL_LICENSE}`);
  requireValue(manifest?.publicReleaseProfile?.id === PUBLIC_LGPL_PROFILE_ID, "Public LGPL release profile metadata is missing or mismatched");
  requireValue(typeof manifest?.distributionPolicy?.publicAlphaAllowed === "boolean", "Public LGPL distribution approval state is missing");
  requireValue(Array.isArray(manifest?.distributionPolicy?.publicBlockers), "Public LGPL blocker list is missing");

  const requiredFlags = requireArrayMembers(manifest?.configuration?.requiredFlags, PUBLIC_REQUIRED_FLAGS, "Public LGPL required configure flags");
  const forbiddenFlags = requireArrayMembers(manifest?.configuration?.forbiddenFlags, PUBLIC_FORBIDDEN_FLAGS, "Public LGPL forbidden configure flags");
  for (const flag of PUBLIC_FORBIDDEN_FLAGS) {
    requireValue(!requiredFlags.includes(flag), `Public LGPL required configure flags contain forbidden flag ${flag}`);
  }
  for (const flag of PUBLIC_REQUIRED_FLAGS) {
    requireValue(!forbiddenFlags.includes(flag), `Public LGPL forbidden configure flags contain required flag ${flag}`);
  }
  requireArrayMembers(manifest?.componentPolicy?.forbiddenFilters, PUBLIC_FORBIDDEN_FILTERS, "Public LGPL forbidden filters");
  requireArrayMembers(manifest?.componentPolicy?.forbiddenEncoders, PUBLIC_FORBIDDEN_ENCODERS, "Public LGPL forbidden encoders");
  const requiredComponents = manifest?.componentPolicy?.requiredComponents;
  requireValue(
    requiredComponents && typeof requiredComponents === "object" && !Array.isArray(requiredComponents),
    "Public LGPL required component inventory is missing",
  );
  const componentCategories = Object.keys(requiredComponents);
  requireValue(
    componentCategories.length === Object.keys(PUBLIC_REQUIRED_COMPONENTS).length &&
      componentCategories.every((category) => Object.hasOwn(PUBLIC_REQUIRED_COMPONENTS, category)),
    "Public LGPL required component categories are incomplete or unreviewed",
  );
  for (const [category, required] of Object.entries(PUBLIC_REQUIRED_COMPONENTS)) {
    requireArrayMembers(
      manifest?.componentPolicy?.requiredComponents?.[category],
      required,
      `Public LGPL required ${category}`,
    );
  }

  const sourceLock = manifest.publicReleaseProfile.sourceLock;
  requireValue(typeof sourceLock?.path === "string" && sourceLock.path.length > 0, "Public LGPL source-lock path is missing");
  requireValue(!isAbsolute(sourceLock.path) && !sourceLock.path.split(/[\\/]+/).includes(".."), "Public LGPL source-lock path must stay inside compliance/");
  requireValue(Number.isSafeInteger(sourceLock.sizeBytes) && sourceLock.sizeBytes > 0, "Public LGPL source-lock size is invalid");
  normalizeSha256(sourceLock.sha256, "Public LGPL source-lock hash");
  const recipeLock = manifest.publicReleaseProfile.buildRecipeLock;
  requireValue(typeof recipeLock?.path === "string" && recipeLock.path.length > 0, "Public LGPL build-recipe lock path is missing");
  requireValue(!isAbsolute(recipeLock.path) && !recipeLock.path.split(/[\\/]+/).includes(".."), "Public LGPL build-recipe lock path must stay inside compliance/");
  requireValue(Number.isSafeInteger(recipeLock.sizeBytes) && recipeLock.sizeBytes > 0, "Public LGPL build-recipe lock size is invalid");
  normalizeSha256(recipeLock.sha256, "Public LGPL build-recipe lock hash");

  const readiness = manifest.publicReleaseProfile.readiness;
  for (const key of PUBLIC_READINESS_KEYS) {
    requireValue(typeof readiness?.[key] === "boolean", `Public LGPL readiness flag ${key} is missing`);
  }
  const reviewedBuildCommit = String(manifest.publicReleaseProfile.reviewedBuildCommit ?? "").trim().toLowerCase();
  const reviewedRuntimeExists = readiness.runtimeBuiltAndPinned === true
    || readiness.runtimeCapabilitiesReviewed === true
    || readiness.correspondingSourceArchived === true;
  requireValue(
    (!reviewedRuntimeExists && reviewedBuildCommit === "") || /^[a-f0-9]{40}$/.test(reviewedBuildCommit),
    "Public LGPL reviewed-build commit must be null before review or a full 40-character Git commit",
  );
  const reviewEvidence = manifest.publicReleaseProfile.reviewEvidence;
  requireValue(reviewEvidence && typeof reviewEvidence === "object" && !Array.isArray(reviewEvidence), "Public LGPL review-evidence map is missing");
  for (const [key, readinessKey] of Object.entries(PUBLIC_REVIEW_EVIDENCE)) {
    requireValue(Object.hasOwn(reviewEvidence, key), `Public LGPL review-evidence descriptor ${key} is missing`);
    validateReviewEvidenceDescriptor(reviewEvidence[key], `Public LGPL ${key}`, readiness[readinessKey] === true);
  }
  return manifest;
}

export function assertPublicManifestReady(manifest) {
  validateManifestForChannel(manifest, "public-alpha");
  const readiness = manifest.publicReleaseProfile.readiness;
  const incomplete = PUBLIC_READINESS_KEYS.filter((key) => readiness[key] !== true);
  const blockers = Array.isArray(manifest?.distributionPolicy?.publicBlockers)
    ? manifest.distributionPolicy.publicBlockers.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
  const details = [...blockers, ...incomplete.map((key) => `READINESS_${key}`)];
  requireValue(
    manifest?.distributionPolicy?.publicAlphaAllowed === true && details.length === 0,
    `Public LGPL runtime profile is fail-closed: ${details.join(", ") || "PUBLIC_ALPHA_NOT_APPROVED"}`,
  );
  for (const key of Object.keys(PUBLIC_REVIEW_EVIDENCE)) {
    validateReviewEvidenceDescriptor(manifest.publicReleaseProfile.reviewEvidence[key], `Public LGPL ${key}`, true);
  }
  return manifest;
}

function verifyBoundReviewRecord(manifest, manifestDirectory, descriptor, key) {
  const path = resolve(manifestDirectory, descriptor.path);
  requireValue(path.startsWith(`${manifestDirectory}${sep}`), `Public LGPL ${key} path escapes compliance/`);
  requireValue(existsSync(path) && statSync(path).isFile(), `Public LGPL ${key} record does not exist: ${path}`);
  requireValue(statSync(path).size === descriptor.sizeBytes, `Public LGPL ${key} size mismatch`);
  const sha256 = sha256File(path);
  requireValue(sha256 === descriptor.sha256, `Public LGPL ${key} SHA-256 mismatch`);
  const record = readJson(path, `Public LGPL ${key} record`);
  requireValue(record.schemaVersion === 1, `Unsupported Public LGPL ${key} schema`);
  return { path, fileName: basename(path), sizeBytes: descriptor.sizeBytes, sha256, record };
}

function verifyReviewIdentity(manifest, record, label, expectedGitCommit) {
  requireValue(record.gitCommit === expectedGitCommit, `${label} Git commit does not match the reviewed build commit`);
  requireValue(record.ffmpegCommit === manifest.version.ffmpegCommit, `${label} FFmpeg commit mismatch`);
  requireValue(record.buildRecipeCommit === manifest.version.buildRecipeCommit, `${label} build-recipe commit mismatch`);
  requireValue(normalizeSha256(record.sourceLockSha256, `${label} source-lock hash`) === manifest.publicReleaseProfile.sourceLock.sha256, `${label} source-lock hash mismatch`);
  requireValue(normalizeSha256(record.buildRecipeLockSha256, `${label} build-recipe-lock hash`) === manifest.publicReleaseProfile.buildRecipeLock.sha256, `${label} build-recipe-lock hash mismatch`);
  requireValue(normalizeSha256(record.binaryAssetSha256, `${label} binary-asset hash`) === manifest.binaryAsset.sha256, `${label} binary-asset hash mismatch`);
}

function normalizeWindowsRuntimeEvidence(entries, label) {
  requireValue(Array.isArray(entries) && entries.length === WINDOWS_RUNTIME_EVIDENCE.length, `${label} evidence is incomplete`);
  const evidenceByName = new Map();
  for (const evidence of entries) {
    requireValue(typeof evidence?.name === "string" && evidence.name.length > 0, `${label} evidence name is invalid`);
    requireValue(typeof evidence?.fileName === "string" && basename(evidence.fileName) === evidence.fileName, `${label} evidence file is invalid for ${evidence.name}`);
    requireValue(Number.isSafeInteger(evidence?.sizeBytes) && evidence.sizeBytes > 0, `${label} evidence size is invalid for ${evidence.name}`);
    const normalized = {
      fileName: evidence.fileName,
      sizeBytes: evidence.sizeBytes,
      sha256: normalizeSha256(evidence?.sha256, `${label} evidence hash for ${evidence.name}`),
    };
    requireValue(!evidenceByName.has(evidence.name), `${label} evidence name is duplicated: ${evidence.name}`);
    evidenceByName.set(evidence.name, normalized);
  }
  for (const name of WINDOWS_RUNTIME_EVIDENCE) {
    requireValue(evidenceByName.has(name), `${label} evidence is missing: ${name}`);
  }
  return evidenceByName;
}

function verifyWindowsRuntimeReview(manifest, manifestDirectory, record, expectedGitCommit) {
  requireValue(record.status === "pass", "Windows runtime review status is not pass");
  requireValue(typeof record.reviewer === "string" && record.reviewer.trim().length >= 2, "Windows runtime review must identify a reviewer");
  requireValue(!Number.isNaN(Date.parse(record.reviewedAt)), "Windows runtime review must contain a valid reviewedAt timestamp");
  requireValue(Array.isArray(record.errors) && record.errors.length === 0, "Windows runtime review contains errors");
  requireValue(Array.isArray(record.warnings), "Windows runtime review warnings are missing");

  const matrix = record.matrix;
  requireValue(matrix?.inputCount === 5, "Windows runtime review must bind five real-media inputs");
  requireValue(matrix?.totalRoutes === 30, "Windows runtime review must bind thirty format routes");
  requireValue(matrix?.passed === matrix.totalRoutes && matrix?.failed === 0, "Windows runtime review matrix is not fully passing");
  requireValue(matrix?.timeouts === 0, "Windows runtime review matrix contains timeouts");
  requireValue(Array.isArray(matrix?.inputSha256) && matrix.inputSha256.length === matrix.inputCount, "Windows runtime review input hashes are incomplete");
  const inputHashes = matrix.inputSha256.map((value, index) => normalizeSha256(value, `Windows runtime review input hash ${index + 1}`));
  requireValue(new Set(inputHashes).size === inputHashes.length, "Windows runtime review input hashes must be unique");

  validateReviewEvidenceDescriptor(record.evidenceBundle, "Windows runtime evidence bundle", true);
  const expectedBundlePath = `ffmpeg-public/reviews/windows-runtime-evidence-${expectedGitCommit.slice(0, 7)}.json`;
  requireValue(record.evidenceBundle.path === expectedBundlePath, "Windows runtime evidence bundle path does not match the reviewed build commit");
  const bundle = verifyBoundReviewRecord(manifest, manifestDirectory, record.evidenceBundle, "windowsRuntimeEvidenceBundle");
  requireValue(bundle.record.type === "gifp-public-ffmpeg-windows-runtime-evidence", "Windows runtime evidence bundle type is invalid");
  requireValue(bundle.record.gitCommit === expectedGitCommit, "Windows runtime evidence bundle Git commit mismatch");
  requireValue(Array.isArray(bundle.record.inputSha256) && bundle.record.inputSha256.length === inputHashes.length, "Windows runtime evidence bundle input hashes are incomplete");
  const bundleInputHashes = bundle.record.inputSha256.map((value, index) => normalizeSha256(value, `Windows runtime evidence bundle input hash ${index + 1}`));
  requireValue(new Set(bundleInputHashes).size === bundleInputHashes.length, "Windows runtime evidence bundle input hashes must be unique");
  requireValue(inputHashes.every((value, index) => value === bundleInputHashes[index]), "Windows runtime review input hashes do not match the evidence bundle");

  const screen = record.screenCapture;
  requireValue(screen?.backend === "gdigrab" && screen?.pass === true, "Windows runtime review screen capture is not approved");
  for (const [key, value] of Object.entries({
    capturedWidth: screen?.capturedWidth,
    capturedHeight: screen?.capturedHeight,
    frameCount: screen?.frameCount,
    encodedGifWidth: screen?.encodedGifWidth,
    encodedGifHeight: screen?.encodedGifHeight,
  })) {
    requireValue(Number.isSafeInteger(value) && value > 0, `Windows runtime review screen-capture ${key} is invalid`);
  }
  requireValue(screen?.experimentalDdagrab?.enabledAsFallback === false, "Windows runtime review must not enable experimental ddagrab fallback");
  requireValue(typeof screen?.experimentalDdagrab?.status === "string" && screen.experimentalDdagrab.status.length > 0, "Windows runtime review ddagrab status is missing");

  const h264 = record.h264MediaFoundation;
  requireValue(h264?.software === true, "Windows runtime review h264_mf software path is incomplete");
  requireValue(typeof h264?.hardwareAvailable === "boolean", "Windows runtime review h264_mf hardware availability is missing");
  if (!h264.hardwareAvailable) {
    requireValue(typeof h264.hardwareFailure === "string" && h264.hardwareFailure.length > 0, "Windows runtime review h264_mf hardware failure is missing");
  }
  requireValue(h264?.fallback === "software" && h264?.fallbackPass === true, "Windows runtime review h264_mf software fallback is incomplete");

  const reviewEvidence = normalizeWindowsRuntimeEvidence(record.evidence, "Windows runtime review");
  const bundleEvidence = normalizeWindowsRuntimeEvidence(bundle.record.evidence, "Windows runtime evidence bundle");
  for (const name of WINDOWS_RUNTIME_EVIDENCE) {
    const reviewed = reviewEvidence.get(name);
    const expected = bundleEvidence.get(name);
    requireValue(
      reviewed.fileName === expected.fileName
        && reviewed.sizeBytes === expected.sizeBytes
        && reviewed.sha256 === expected.sha256,
      `Windows runtime review evidence does not match the evidence bundle: ${name}`,
    );
  }
}

export function verifyPublicReviewRecords(manifest, manifestPath, expectedGitCommit) {
  validateManifestForChannel(manifest, "public-alpha");
  assertPublicManifestReady(manifest);
  const releaseCommit = String(expectedGitCommit ?? "").toLowerCase();
  requireValue(/^[a-f0-9]{40}$/.test(releaseCommit), "Public release requires the clean 40-character Git commit");
  const reviewedBuildCommit = String(manifest.publicReleaseProfile.reviewedBuildCommit).toLowerCase();
  const manifestDirectory = dirname(resolve(manifestPath));
  const descriptors = manifest.publicReleaseProfile.reviewEvidence;
  requireValue(new Set(Object.values(descriptors).map((descriptor) => descriptor.path)).size === Object.keys(PUBLIC_REVIEW_EVIDENCE).length, "Public LGPL review records must use distinct paths");
  const reproducibility = verifyBoundReviewRecord(manifest, manifestDirectory, descriptors.reproducibilityReview, "reproducibilityReview");
  const windows = verifyBoundReviewRecord(manifest, manifestDirectory, descriptors.windowsRuntimeReview, "windowsRuntimeReview");
  const source = verifyBoundReviewRecord(manifest, manifestDirectory, descriptors.correspondingSourceReview, "correspondingSourceReview");

  requireValue(reproducibility.record.type === "gifp-public-ffmpeg-reproducibility", "Reproducibility review type is invalid");
  requireValue(reproducibility.record.status === "pass" && reproducibility.record.reproducible === true, "Reproducibility review is not approved");
  requireValue(Array.isArray(reproducibility.record.errors) && reproducibility.record.errors.length === 0, "Reproducibility review contains errors");
  requireValue(Array.isArray(reproducibility.record.checks) && reproducibility.record.checks.length > 0 && reproducibility.record.checks.every((check) => check?.ok === true), "Reproducibility review checks are incomplete");
  const baselineIdentity = reproducibility.record.baseline?.buildIdentity;
  const replayIdentity = reproducibility.record.replay?.buildIdentity;
  for (const identity of [baselineIdentity, replayIdentity]) {
    requireValue(identity?.sourceLockSha256 === manifest.publicReleaseProfile.sourceLock.sha256, "Reproducibility review source-lock identity mismatch");
    requireValue(identity?.buildRecipeLockSha256 === manifest.publicReleaseProfile.buildRecipeLock.sha256, "Reproducibility review build-recipe identity mismatch");
  }
  const baselineArchive = reproducibility.record.baseline?.artifacts?.runtimeArchive;
  const replayArchive = reproducibility.record.replay?.artifacts?.runtimeArchive;
  for (const archive of [baselineArchive, replayArchive]) {
    requireValue(archive?.sizeBytes === manifest.binaryAsset.sizeBytes, "Reproducibility review runtime-archive size mismatch");
    requireValue(archive?.sha256 === manifest.binaryAsset.sha256, "Reproducibility review runtime-archive hash mismatch");
  }
  requireValue(
    reproducibility.record.gitCommit === reviewedBuildCommit,
    "Reproducibility review Git commit does not match the reviewed build commit",
  );

  requireValue(windows.record.type === "gifp-public-ffmpeg-windows-runtime-review", "Windows runtime review type is invalid");
  requireValue(windows.record.completeWindowsRuntimeReview === true, "Windows runtime review is not approved");
  verifyReviewIdentity(manifest, windows.record, "Windows runtime review", reviewedBuildCommit);
  for (const check of WINDOWS_RUNTIME_CHECKS) {
    requireValue(windows.record.checks?.[check] === true, `Windows runtime review check ${check} is incomplete`);
  }
  verifyWindowsRuntimeReview(manifest, manifestDirectory, windows.record, reviewedBuildCommit);

  requireValue(source.record.type === "gifp-public-ffmpeg-corresponding-source-review", "Corresponding Source review type is invalid");
  requireValue(source.record.completeCorrespondingSourceReviewed === true, "Corresponding Source review is not approved");
  verifyReviewIdentity(manifest, source.record, "Corresponding Source review", reviewedBuildCommit);
  return {
    reviewedBuildCommit,
    releaseCommit,
    reproducibilityReview: { fileName: reproducibility.fileName, sizeBytes: reproducibility.sizeBytes, sha256: reproducibility.sha256 },
    windowsRuntimeReview: { fileName: windows.fileName, sizeBytes: windows.sizeBytes, sha256: windows.sha256 },
    correspondingSourceReview: { fileName: source.fileName, sizeBytes: source.sizeBytes, sha256: source.sha256 },
  };
}

export function verifyPublicSourceLock(manifest, manifestPath) {
  validateManifestForChannel(manifest, "public-alpha");
  const manifestDirectory = dirname(resolve(manifestPath));
  const sourceLock = manifest.publicReleaseProfile.sourceLock;
  const lockPath = resolve(manifestDirectory, sourceLock.path);
  requireValue(lockPath.startsWith(`${manifestDirectory}${sep}`), "Public LGPL source-lock path escapes compliance/");
  requireValue(existsSync(lockPath) && statSync(lockPath).isFile(), `Public LGPL source lock is missing: ${lockPath}`);
  requireValue(statSync(lockPath).size === sourceLock.sizeBytes, `Public LGPL source-lock size mismatch: expected ${sourceLock.sizeBytes}, got ${statSync(lockPath).size}`);
  const actualSha256 = sha256File(lockPath);
  requireValue(actualSha256 === sourceLock.sha256, `Public LGPL source-lock SHA-256 mismatch: expected ${sourceLock.sha256}, got ${actualSha256}`);

  const lock = readJson(lockPath, "Public LGPL source lock");
  requireValue(lock.schemaVersion === 1, "Unsupported Public LGPL source-lock schema");
  requireValue(lock.profile === "gifp-windows-x64-lgpl-shared", "Public LGPL source-lock profile is mismatched");
  requireValue(lock.licensePolicy?.runtimeExpression === PUBLIC_LGPL_LICENSE, "Public LGPL source-lock license policy is mismatched");
  requireArrayMembers(lock.licensePolicy?.requiredConfigureFlags, PUBLIC_REQUIRED_FLAGS, "Source-lock required configure flags");
  requireArrayMembers(lock.licensePolicy?.forbiddenConfigureFlags, PUBLIC_FORBIDDEN_FLAGS, "Source-lock forbidden configure flags");
  requireArrayMembers(
    lock.licensePolicy?.forbiddenComponents,
    ["eq_filter", "hqdn3d_filter", "libx264_encoder", "libx264rgb_encoder"],
    "Source-lock forbidden components",
  );
  requireValue(/^.+@sha256:[a-f0-9]{64}$/i.test(String(lock.builder?.image ?? "")), "Public LGPL builder image is not digest-pinned");
  requireValue(lock.builder?.manifestDigest === lock.builder.image.slice(lock.builder.image.lastIndexOf("@") + 1), "Public LGPL builder digest does not match its image reference");
  requireValue(lock.builder?.buildRecipeCommit === manifest.version?.buildRecipeCommit, "Public LGPL source lock build-recipe commit does not match the runtime manifest");
  requireValue(Array.isArray(lock.sources) && lock.sources.length > 0, "Public LGPL source lock is empty");
  const sourcesById = new Map();
  for (const source of lock.sources) {
    requireValue(typeof source.id === "string" && /^[a-z0-9-]+$/.test(source.id), "Source-lock id is invalid");
    requireValue(!sourcesById.has(source.id), `Source-lock id is duplicated: ${source.id}`);
    sourcesById.set(source.id, source);
    requireValue(/^[a-f0-9]{40}$/i.test(String(source.commit ?? "")), `Source-lock commit is not immutable for ${source.id}`);
    assertImmutableUrl(source.archiveUrl, `Source-lock archive URL for ${source.id}`);
    requireValue(source.archiveUrl.includes(source.commit), `Source-lock archive URL is not commit-bound for ${source.id}`);
    requireValue(Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > 0, `Source-lock size is invalid for ${source.id}`);
    normalizeSha256(source.sha256, `Source-lock hash for ${source.id}`);
  }
  for (const source of lock.sources) {
    if (source.submodule === undefined) continue;
    const submodule = source.submodule;
    requireValue(submodule && typeof submodule === "object" && !Array.isArray(submodule), `Source-lock submodule metadata is invalid for ${source.id}`);
    requireValue(/^[a-z0-9-]+$/.test(String(submodule.parentSourceId ?? "")), `Source-lock submodule parent id is invalid for ${source.id}`);
    requireValue(submodule.parentSourceId !== source.id, `Source-lock submodule cannot be its own parent for ${source.id}`);
    requireValue(/^[a-f0-9]{40}$/i.test(String(submodule.parentCommit ?? "")), `Source-lock submodule parent commit is invalid for ${source.id}`);
    requireValue(/^[a-f0-9]{40}$/i.test(String(submodule.gitlinkCommit ?? "")), `Source-lock submodule gitlink commit is invalid for ${source.id}`);
    requireValue(
      typeof submodule.path === "string" &&
        submodule.path !== "" &&
        !submodule.path.startsWith("/") &&
        !submodule.path.includes("\\") &&
        submodule.path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      `Source-lock submodule path is unsafe for ${source.id}`,
    );
    requireValue(source.commit === submodule.gitlinkCommit, `Source-lock submodule commit is mismatched for ${source.id}`);
    const parent = sourcesById.get(submodule.parentSourceId);
    requireValue(parent, `Source-lock submodule parent is missing for ${source.id}`);
    requireValue(parent.commit === submodule.parentCommit, `Source-lock submodule parent commit is mismatched for ${source.id}`);
  }

  const recipeDescriptor = manifest.publicReleaseProfile.buildRecipeLock;
  const recipeLockPath = resolve(manifestDirectory, recipeDescriptor.path);
  requireValue(recipeLockPath.startsWith(`${manifestDirectory}${sep}`), "Public LGPL build-recipe lock path escapes compliance/");
  requireValue(existsSync(recipeLockPath) && statSync(recipeLockPath).isFile(), `Public LGPL build-recipe lock is missing: ${recipeLockPath}`);
  requireValue(
    statSync(recipeLockPath).size === recipeDescriptor.sizeBytes,
    `Public LGPL build-recipe lock size mismatch: expected ${recipeDescriptor.sizeBytes}, got ${statSync(recipeLockPath).size}`,
  );
  const actualRecipeLockSha256 = sha256File(recipeLockPath);
  requireValue(
    actualRecipeLockSha256 === recipeDescriptor.sha256,
    `Public LGPL build-recipe lock SHA-256 mismatch: expected ${recipeDescriptor.sha256}, got ${actualRecipeLockSha256}`,
  );
  const recipeLock = readJson(recipeLockPath, "Public LGPL build-recipe lock");
  requireValue(recipeLock.schemaVersion === 1, "Unsupported Public LGPL build-recipe lock schema");
  requireValue(recipeLock.profile === lock.profile, "Public LGPL build-recipe lock profile is mismatched");
  requireValue(recipeLock.builderImage === lock.builder.image, "Public LGPL build-recipe lock builder is mismatched");
  requireValue(recipeLock.sourceDateEpoch === 1785786727, "Public LGPL build-recipe lock SOURCE_DATE_EPOCH is mismatched");
  requireValue(
    recipeLock.sourceLock?.path === "compliance/ffmpeg-public/sources.lock.json" &&
      recipeLock.sourceLock?.sizeBytes === sourceLock.sizeBytes &&
      recipeLock.sourceLock?.sha256 === sourceLock.sha256,
    "Public LGPL build-recipe lock does not bind the selected source lock",
  );
  requireValue(Array.isArray(recipeLock.inputs), "Public LGPL build-recipe input inventory is missing");
  const recipePaths = recipeLock.inputs.map((entry) => entry?.path);
  requireValue(
    recipePaths.length === PUBLIC_RECIPE_INPUTS.length &&
      new Set(recipePaths).size === PUBLIC_RECIPE_INPUTS.length &&
      PUBLIC_RECIPE_INPUTS.every((path) => recipePaths.includes(path)),
    "Public LGPL build-recipe input set is incomplete or unreviewed",
  );
  const repositoryRoot = resolve(manifestDirectory, "..");
  const repositoryPrefix = `${repositoryRoot}${sep}`;
  const recipeInputs = recipeLock.inputs.map((entry) => {
    requireValue(
      typeof entry.path === "string" &&
        !isAbsolute(entry.path) &&
        !entry.path.split(/[\\/]+/).includes(".."),
      `Unsafe Public LGPL build-recipe input path: ${entry.path}`,
    );
    const path = resolve(repositoryRoot, entry.path);
    requireValue(path.startsWith(repositoryPrefix), `Public LGPL build-recipe input escapes the repository: ${entry.path}`);
    requireValue(existsSync(path) && statSync(path).isFile(), `Public LGPL build-recipe input is missing: ${entry.path}`);
    requireValue(Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes === statSync(path).size, `Public LGPL build-recipe input size mismatch: ${entry.path}`);
    const sha256 = normalizeSha256(entry.sha256, `Public LGPL build-recipe hash for ${entry.path}`);
    requireValue(sha256File(path) === sha256, `Public LGPL build-recipe input hash mismatch: ${entry.path}`);
    return { path: entry.path, sizeBytes: entry.sizeBytes, sha256 };
  });
  return {
    fileName: basename(lockPath),
    sizeBytes: statSync(lockPath).size,
    sha256: actualSha256,
    sourceCount: lock.sources.length,
    builderImage: lock.builder.image,
    buildRecipeLock: {
      fileName: basename(recipeLockPath),
      sizeBytes: statSync(recipeLockPath).size,
      sha256: actualRecipeLockSha256,
      inputs: recipeInputs,
    },
  };
}

export function validatePinnedManifest(manifest) {
  requireValue(manifest?.schemaVersion === 1, "Unsupported FFmpeg compliance manifest schema");
  requireValue(manifest?.component === "FFmpeg", "Compliance manifest component must be FFmpeg");
  requireValue(manifest?.distributionPolicy?.internalAllowed === true, "Pinned FFmpeg runtime is not approved for internal packaging");
  requireValue(typeof manifest?.distributionPolicy?.publicAlphaAllowed === "boolean", "Pinned FFmpeg distribution policy is incomplete");
  requireValue(Array.isArray(manifest?.distributionPolicy?.publicBlockers), "Pinned FFmpeg public blocker list is missing");
  requireValue(Array.isArray(manifest.runtimeFiles) && manifest.runtimeFiles.length > 0, "FFmpeg runtime file inventory is empty");
  requireValue(
    typeof manifest.binaryAsset?.name === "string" && basename(manifest.binaryAsset.name) === manifest.binaryAsset.name,
    "Pinned FFmpeg binary asset filename is invalid",
  );
  requireValue(Number.isSafeInteger(manifest.binaryAsset?.sizeBytes) && manifest.binaryAsset.sizeBytes > 0, "Pinned FFmpeg binary asset size is invalid");
  assertImmutableUrl(manifest.binaryAsset?.url, "Pinned FFmpeg binary URL");
  normalizeSha256(manifest.binaryAsset?.sha256, "Pinned FFmpeg binary asset hash");
  assertImmutableUrl(manifest.sourceProvenance?.ffmpegCommitUrl, "FFmpeg commit URL");
  assertImmutableUrl(manifest.sourceProvenance?.ffmpegArchiveUrl, "FFmpeg source archive URL");
  assertImmutableUrl(manifest.sourceProvenance?.buildRecipeCommitUrl, "Build recipe commit URL");
  requireValue(typeof manifest.licenseFile?.name === "string" && basename(manifest.licenseFile.name) === manifest.licenseFile.name, "Pinned FFmpeg license filename is invalid");
  requireValue(Number.isSafeInteger(manifest.licenseFile?.sizeBytes) && manifest.licenseFile.sizeBytes > 0, "Pinned FFmpeg license size is invalid");
  normalizeSha256(manifest.licenseFile?.sha256, "Pinned FFmpeg license hash");

  const names = new Set();
  for (const entry of manifest.runtimeFiles) {
    requireValue(typeof entry.name === "string" && basename(entry.name) === entry.name, `Unsafe runtime filename: ${entry.name}`);
    requireValue(!names.has(entry.name.toLowerCase()), `Duplicate runtime filename: ${entry.name}`);
    names.add(entry.name.toLowerCase());
    requireValue(Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes > 0, `Invalid size for ${entry.name}`);
    normalizeSha256(entry.sha256, `Pinned hash for ${entry.name}`);
  }
  requireValue(names.has("ffmpeg.exe") && names.has("ffprobe.exe"), "Runtime inventory must contain ffmpeg.exe and ffprobe.exe");
  return manifest;
}

export function verifyRuntimeFiles(manifest, runtimeDir) {
  validatePinnedManifest(manifest);
  requireValue(existsSync(runtimeDir) && statSync(runtimeDir).isDirectory(), `FFmpeg runtime directory does not exist: ${runtimeDir}`);

  const expectedNames = new Set(manifest.runtimeFiles.map((entry) => entry.name.toLowerCase()));
  const actualNames = readdirSync(runtimeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith(".dll") || ["ffmpeg.exe", "ffprobe.exe"].includes(name.toLowerCase()));
  const unexpected = actualNames.filter((name) => !expectedNames.has(name.toLowerCase()));
  requireValue(unexpected.length === 0, `Unreviewed FFmpeg runtime files are present: ${unexpected.join(", ")}`);

  return manifest.runtimeFiles.map((entry) => {
    const path = resolve(runtimeDir, entry.name);
    requireValue(existsSync(path) && statSync(path).isFile(), `Pinned FFmpeg runtime file is missing: ${entry.name}`);
    const sizeBytes = statSync(path).size;
    requireValue(sizeBytes === entry.sizeBytes, `Size mismatch for ${entry.name}: expected ${entry.sizeBytes}, got ${sizeBytes}`);
    const sha256 = sha256File(path);
    requireValue(sha256 === entry.sha256.toLowerCase(), `SHA-256 mismatch for ${entry.name}: expected ${entry.sha256}, got ${sha256}`);
    return { name: entry.name, sizeBytes, sha256 };
  });
}

export function verifyFfmpegLicense(manifest, licensePath) {
  validatePinnedManifest(manifest);
  const path = licensePath ? resolve(licensePath) : "";
  requireValue(path && existsSync(path) && statSync(path).isFile(), "Pinned FFmpeg license file is required");
  const sizeBytes = statSync(path).size;
  requireValue(sizeBytes === manifest.licenseFile.sizeBytes, `FFmpeg license size mismatch: expected ${manifest.licenseFile.sizeBytes}, got ${sizeBytes}`);
  const sha256 = sha256File(path);
  requireValue(sha256 === manifest.licenseFile.sha256, `FFmpeg license SHA-256 mismatch: expected ${manifest.licenseFile.sha256}, got ${sha256}`);
  return { fileName: basename(path), sizeBytes, sha256 };
}

export function verifyDependencyManifest(manifestPath) {
  const path = manifestPath ? resolve(manifestPath) : "";
  requireValue(path && existsSync(path) && statSync(path).isFile(), "Generated third-party dependency manifest is required");
  const manifest = readJson(path, "Third-party dependency manifest");
  requireValue(manifest.schemaVersion === 1, "Unsupported third-party dependency manifest schema");
  requireValue(manifest.generator?.deterministic === true, "Third-party dependency manifest is not deterministic");
  requireValue(Number.isSafeInteger(manifest.summary?.componentCount) && manifest.summary.componentCount > 0, "Third-party dependency manifest is empty");
  requireValue(Array.isArray(manifest.components) && manifest.components.length === manifest.summary.componentCount, "Third-party dependency manifest component count is inconsistent");
  const identities = new Set();
  let actualMissingLicenseCount = 0;
  for (const component of manifest.components) {
    const identity = componentIdentity(component);
    requireValue(!identities.has(identity), `Duplicate third-party dependency component: ${component.name}`);
    identities.add(identity);
    const missingLicense = typeof component.license !== "string" || component.license.trim() === "";
    requireValue(component.missingLicense === missingLicense, `Third-party dependency missing-license state is inconsistent for ${component.name}`);
    if (missingLicense) actualMissingLicenseCount += 1;
  }
  requireValue(manifest.summary?.missingLicenseCount === actualMissingLicenseCount, "Third-party dependency missing-license count is inconsistent");
  requireValue(actualMissingLicenseCount === 0, `Third-party dependency manifest contains ${actualMissingLicenseCount} unresolved license entries`);
  const facts = {
    fileName: basename(path),
    sha256: sha256File(path),
    componentCount: manifest.summary.componentCount,
    missingLicenseCount: manifest.summary.missingLicenseCount,
    byEcosystem: manifest.summary.byEcosystem,
  };
  Object.defineProperty(facts, "components", {
    value: manifest.components,
    enumerable: false,
  });
  return facts;
}

function componentIdentity(component) {
  for (const field of ["ecosystem", "name", "version", "source"]) {
    requireValue(
      typeof component?.[field] === "string" && component[field].trim() !== "",
      `Third-party component ${field} is invalid`,
    );
  }
  return [component.ecosystem, component.name, component.version, component.source].join("\u0000");
}

function safeRelativeBundlePath(value, label) {
  requireValue(
    typeof value === "string" &&
      value !== "" &&
      !isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").includes(".."),
    `${label} is unsafe`,
  );
  return value;
}

function verifyOverlayVcsUrl(value, repository, commit, label) {
  let parsed;
  let repositoryUrl;
  try {
    parsed = new URL(value);
    repositoryUrl = new URL(repository);
  } catch {
    throw new ComplianceError(`${label} is not a valid repository URL`);
  }
  const repositoryPath = repositoryUrl.pathname.replace(/(?:\.git)?\/$/, "").replace(/\.git$/, "");
  requireValue(
    parsed.protocol === "https:" &&
      !parsed.search &&
      !parsed.hash &&
      parsed.origin.toLowerCase() === repositoryUrl.origin.toLowerCase() &&
      parsed.pathname.replace(/\/$/, "").toLowerCase() ===
        `${repositoryPath}/commit/${commit}`.toLowerCase(),
    `${label} does not identify the reviewed component repository commit`,
  );
}

function verifyOverlaySourceUrl(value, sourceType, component, commit, label) {
  let parsed;
  let repositoryUrl;
  try {
    parsed = new URL(value);
    repositoryUrl = new URL(component.repository);
  } catch {
    throw new ComplianceError(`${label} is not a valid source URL`);
  }
  requireValue(parsed.protocol === "https:" && !parsed.search && !parsed.hash, `${label} must be a fixed HTTPS URL`);
  if (sourceType === "repository-revision") {
    const repositoryParts = repositoryUrl.pathname.replace(/(?:\.git)?\/$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
    const sourceParts = parsed.pathname.split("/").filter(Boolean);
    requireValue(
      repositoryUrl.hostname.toLowerCase() === "github.com" &&
        parsed.hostname.toLowerCase() === "raw.githubusercontent.com" &&
        repositoryParts.length === 2 &&
        sourceParts.length >= 4 &&
        sourceParts[0].toLowerCase() === repositoryParts[0].toLowerCase() &&
        sourceParts[1].toLowerCase() === repositoryParts[1].toLowerCase() &&
        sourceParts[2].toLowerCase() === commit.toLowerCase(),
      `${label} does not use the reviewed repository commit`,
    );
    return;
  }
  if (sourceType === "canonical-license") {
    requireValue(
      component.license === "MPL-2.0" &&
        ["mozilla.org", "www.mozilla.org"].includes(parsed.hostname.toLowerCase()) &&
        /(?:^|[^a-f0-9])[a-f0-9]{12,64}(?:[^a-f0-9]|$)/i.test(parsed.pathname),
      `${label} is not an approved canonical license source`,
    );
    return;
  }
  throw new ComplianceError(`${label} has an unsupported source type`);
}

export function verifyLicenseTextBundle(manifestPath, dependencyManifest) {
  const path = manifestPath ? resolve(manifestPath) : "";
  requireValue(path && existsSync(path) && statSync(path).isFile(), "Generated third-party license-text manifest is required");
  const manifest = readJson(path, "Third-party license-text manifest");
  requireValue(manifest.schemaVersion === 1, "Unsupported third-party license-text manifest schema");
  requireValue(manifest.generator?.deterministic === true, "Third-party license-text manifest is not deterministic");
  requireValue(manifest.sourceManifest?.sha256 === dependencyManifest.sha256, "License-text bundle does not match the dependency manifest");
  requireValue(manifest.summary?.componentCount === dependencyManifest.componentCount, "License-text bundle component count does not match the dependency manifest");
  requireValue(Number.isSafeInteger(manifest.summary?.missingLicenseTextCount) && manifest.summary.missingLicenseTextCount >= 0, "License-text bundle has an invalid missing-text count");
  requireValue(Array.isArray(manifest.components) && manifest.components.length === manifest.summary.componentCount, "License-text bundle component mapping is inconsistent");
  requireValue(Array.isArray(manifest.texts), "License-text bundle text inventory is missing");

  const baseDir = dirname(path);
  const basePrefix = `${resolve(baseDir)}${sep}`.toLowerCase();
  const knownTexts = new Set();
  const knownTextEntries = new Map();
  for (const entry of manifest.texts) {
    const expectedSha256 = normalizeSha256(entry.sha256, "License text hash");
    requireValue(entry.path === `texts/${expectedSha256}.txt`, `Unsafe license text path: ${entry.path}`);
    const textPath = resolve(baseDir, entry.path);
    requireValue(textPath.toLowerCase().startsWith(basePrefix), `License text escapes its bundle: ${entry.path}`);
    requireValue(existsSync(textPath) && statSync(textPath).isFile(), `License text is missing: ${entry.path}`);
    requireValue(statSync(textPath).size === entry.sizeBytes, `License text size mismatch: ${entry.path}`);
    requireValue(sha256File(textPath) === expectedSha256, `License text SHA-256 mismatch: ${entry.path}`);
    requireValue(!knownTexts.has(expectedSha256), `Duplicate license text entry: ${expectedSha256}`);
    knownTexts.add(expectedSha256);
    knownTextEntries.set(expectedSha256, entry);
  }

  const dependencyComponents = new Map(
    (dependencyManifest.components ?? []).map((component) => [componentIdentity(component), component]),
  );
  requireValue(dependencyComponents.size === dependencyManifest.componentCount, "Dependency component evidence is unavailable for license texts");
  const componentMappings = new Map();
  let actualComponentsWithLicenseTextCount = 0;
  for (const component of manifest.components) {
    const identity = componentIdentity(component);
    requireValue(!componentMappings.has(identity), `Duplicate license component mapping: ${component.name}`);
    componentMappings.set(identity, component);
    const dependencyComponent = dependencyComponents.get(identity);
    requireValue(dependencyComponent, `License component is not in the dependency closure: ${component.name}`);
    requireValue(component.license === dependencyComponent.license, `License expression differs from dependency evidence for ${component.name}`);
    requireValue(component.missingLicense === dependencyComponent.missingLicense, `Missing-license state differs from dependency evidence for ${component.name}`);
    requireValue(Array.isArray(component.licenseTexts), `License text mapping is invalid for ${component.name}`);
    const componentTextHashes = new Set();
    let hasLicenseText = false;
    for (const text of component.licenseTexts) {
      const sha256 = normalizeSha256(text.sha256, `Component ${component.name} license text hash`);
      const knownText = knownTextEntries.get(sha256);
      requireValue(knownText, `Component ${component.name} references an unknown license text`);
      requireValue(!componentTextHashes.has(sha256), `Component ${component.name} repeats a license text`);
      componentTextHashes.add(sha256);
      requireValue(text.path === knownText.path, `Component ${component.name} has a mismatched license text path`);
      requireValue(text.sizeBytes === knownText.sizeBytes, `Component ${component.name} has a mismatched license text size`);
      requireValue(Array.isArray(text.kinds), `Component ${component.name} license text kinds are invalid`);
      requireValue(Array.isArray(text.sourceNames), `Component ${component.name} license text sources are invalid`);
      requireValue(Array.isArray(text.provenanceUrls), `Component ${component.name} provenance URLs are invalid`);
      requireValue(Array.isArray(text.vcsCommits), `Component ${component.name} VCS commits are invalid`);
      requireValue(Array.isArray(text.vcsUrls), `Component ${component.name} VCS URLs are invalid`);
      requireValue(Array.isArray(text.sourceTypes), `Component ${component.name} source types are invalid`);
      hasLicenseText ||= text.kinds.includes("license");
    }
    requireValue(component.missingLicenseText === !hasLicenseText, `Component ${component.name} missing-text state is inconsistent`);
    if (hasLicenseText) actualComponentsWithLicenseTextCount += 1;
  }

  const actualMissingLicenseTextCount = manifest.components.length - actualComponentsWithLicenseTextCount;
  requireValue(componentMappings.size === dependencyComponents.size, "License-text and dependency component sets differ");
  requireValue(
    manifest.summary.componentsWithLicenseTextCount === actualComponentsWithLicenseTextCount,
    "License-text bundle covered-component count is inconsistent",
  );
  requireValue(
    manifest.summary.missingLicenseTextCount === actualMissingLicenseTextCount,
    "License-text bundle missing-text count is inconsistent",
  );
  requireValue(
    manifest.summary.uniqueLicenseTextCount === knownTexts.size,
    "License-text bundle unique-text count is inconsistent",
  );

  const overlayDescriptor = manifest.licenseOverlayManifest;
  if (overlayDescriptor) {
    const bundlePath = safeRelativeBundlePath(overlayDescriptor.bundlePath, "License overlay bundle path");
    safeRelativeBundlePath(overlayDescriptor.path, "License overlay source path");
    requireValue(Number.isSafeInteger(overlayDescriptor.sizeBytes) && overlayDescriptor.sizeBytes > 0, "License overlay manifest size is invalid");
    requireValue(Number.isSafeInteger(overlayDescriptor.entryCount) && overlayDescriptor.entryCount > 0, "License overlay entry count is invalid");
    const overlayPath = resolve(baseDir, bundlePath);
    requireValue(overlayPath.toLowerCase().startsWith(basePrefix), "License overlay manifest escapes its bundle");
    requireValue(existsSync(overlayPath) && statSync(overlayPath).isFile(), "Packaged license overlay manifest is missing");
    requireValue(statSync(overlayPath).size === overlayDescriptor.sizeBytes, "License overlay manifest size mismatch");
    requireValue(
      sha256File(overlayPath) === normalizeSha256(overlayDescriptor.sha256, "License overlay manifest hash"),
      "License overlay manifest SHA-256 mismatch",
    );
    const overlay = readJson(overlayPath, "License overlay manifest");
    requireValue(overlay.schemaVersion === 1 && Array.isArray(overlay.entries), "Unsupported license overlay manifest schema");
    requireValue(overlay.entries.length === overlayDescriptor.entryCount, "License overlay entry count is inconsistent");
    const overlayComponents = new Set();
    for (const entry of overlay.entries) {
      const identity = componentIdentity(entry);
      requireValue(!overlayComponents.has(identity), `Duplicate packaged license overlay: ${entry.name}`);
      overlayComponents.add(identity);
      const dependencyComponent = dependencyComponents.get(identity);
      const mappedComponent = componentMappings.get(identity);
      requireValue(dependencyComponent && mappedComponent?.overlayApplied === true, `License overlay component is not in the dependency closure: ${entry.name}`);
      requireValue(dependencyComponent.integrity === entry.integrity, `License overlay integrity mismatch for ${entry.name}`);
      requireValue(dependencyComponent.license === entry.license, `License overlay expression mismatch for ${entry.name}`);
      requireValue(/^[a-f0-9]{40}$/.test(entry.vcsCommit), `License overlay VCS commit is invalid for ${entry.name}`);
      verifyOverlayVcsUrl(entry.vcsUrl, dependencyComponent.repository, entry.vcsCommit, `License overlay VCS URL for ${entry.name}`);
      requireValue(Array.isArray(entry.files) && entry.files.length > 0, `License overlay files are missing for ${entry.name}`);
      const overlayTextHashes = new Set();
      for (const file of entry.files) {
        safeRelativeBundlePath(file.path, `License overlay text path for ${entry.name}`);
        requireValue(file.kind === "license" || file.kind === "notice", `License overlay text kind is invalid for ${entry.name}`);
        const sha256 = normalizeSha256(file.sha256, `License overlay text hash for ${entry.name}`);
        requireValue(!overlayTextHashes.has(sha256), `License overlay repeats a text for ${entry.name}`);
        overlayTextHashes.add(sha256);
        verifyOverlaySourceUrl(file.sourceUrl, file.sourceType, dependencyComponent, entry.vcsCommit, `License overlay source URL for ${entry.name}`);
        const mapping = mappedComponent.licenseTexts.find((text) => text.sha256 === sha256);
        requireValue(mapping && mapping.kinds.includes(file.kind), `License overlay text is not mapped for ${entry.name}`);
        requireValue(mapping.provenanceUrls.includes(file.sourceUrl), `License overlay provenance URL is not mapped for ${entry.name}`);
        requireValue(mapping.vcsCommits.includes(entry.vcsCommit), `License overlay commit is not mapped for ${entry.name}`);
        requireValue(mapping.vcsUrls.includes(entry.vcsUrl), `License overlay VCS URL is not mapped for ${entry.name}`);
        requireValue(mapping.sourceTypes.includes(file.sourceType), `License overlay source type is not mapped for ${entry.name}`);
      }
    }
    const appliedComponents = manifest.components.filter((component) => component.overlayApplied === true).length;
    requireValue(appliedComponents === overlayComponents.size, "License overlay applied-component count is inconsistent");
  } else {
    requireValue(
      manifest.components.every((component) => component.overlayApplied !== true),
      "License overlay component exists without a packaged overlay manifest",
    );
  }

  return {
    fileName: basename(path),
    sha256: sha256File(path),
    componentCount: manifest.summary.componentCount,
    componentsWithLicenseTextCount: manifest.summary.componentsWithLicenseTextCount,
    missingLicenseTextCount: manifest.summary.missingLicenseTextCount,
    uniqueLicenseTextCount: manifest.summary.uniqueLicenseTextCount,
  };
}

export function verifyFfmpegVersion(manifest, versionText) {
  validatePinnedManifest(manifest);
  requireValue(versionText.includes(`ffmpeg version ${manifest.version.marker}`), `FFmpeg version does not match pinned marker ${manifest.version.marker}`);
  const configurationLine = versionText.split(/\r?\n/).find((line) => line.startsWith("configuration:"));
  requireValue(configurationLine, "FFmpeg version output does not contain a configuration line");
  const normalizedConfigurationLine = configurationLine.replace(/=(["'])([^"']*)\1/g, "=$2");
  for (const flag of manifest.configuration.requiredFlags) {
    requireValue(normalizedConfigurationLine.includes(flag), `Pinned FFmpeg configuration is missing required flag ${flag}`);
  }
  for (const flag of manifest.configuration.forbiddenFlags) {
    requireValue(!normalizedConfigurationLine.includes(flag), `Pinned FFmpeg configuration contains forbidden flag ${flag}`);
  }
  return {
    versionLine: versionText.split(/\r?\n/)[0],
    configurationLine,
  };
}

export function verifyBinaryAsset(manifest, assetPath) {
  validatePinnedManifest(manifest);
  const path = assetPath ? resolve(assetPath) : "";
  requireValue(path && existsSync(path) && statSync(path).isFile(), "Pinned FFmpeg binary asset archive is required");
  requireValue(basename(path) === manifest.binaryAsset.name, `FFmpeg binary asset filename mismatch: expected ${manifest.binaryAsset.name}, got ${basename(path)}`);
  const sizeBytes = statSync(path).size;
  requireValue(sizeBytes === manifest.binaryAsset.sizeBytes, `FFmpeg binary asset size mismatch: expected ${manifest.binaryAsset.sizeBytes}, got ${sizeBytes}`);
  const sha256 = sha256File(path);
  requireValue(sha256 === manifest.binaryAsset.sha256, `FFmpeg binary asset SHA-256 mismatch: expected ${manifest.binaryAsset.sha256}, got ${sha256}`);
  return { fileName: basename(path), sizeBytes, sha256 };
}

function ffmpegTableNames(output) {
  const names = new Set();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = /^([A-Z.]{1,6})\s+(?:d\s+)?([a-z0-9_.-]+(?:,[a-z0-9_.-]+)*)\b/.exec(line.trim());
    if (!match) continue;
    for (const name of match[2].split(",")) names.add(name);
  }
  return names;
}

function ffmpegPlainNames(output) {
  const names = new Set();
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const value = line.trim();
    if (/^[a-z0-9_-]+$/.test(value)) names.add(value);
  }
  return names;
}

export function verifyFfmpegComponentPolicy(manifest, inventories) {
  validateManifestForChannel(manifest, "public-alpha");
  const actual = {
    protocols: ffmpegPlainNames(inventories.protocolsText),
    devices: ffmpegTableNames(inventories.devicesText),
    demuxers: ffmpegTableNames(inventories.demuxersText),
    decoders: ffmpegTableNames(inventories.decodersText),
    encoders: ffmpegTableNames(inventories.encodersText),
    muxers: ffmpegTableNames(inventories.muxersText),
    filters: ffmpegTableNames(inventories.filtersText),
    hwaccels: ffmpegPlainNames(inventories.hwaccelsText),
  };
  const missing = {};
  for (const [category, required] of Object.entries(manifest.componentPolicy.requiredComponents)) {
    const absent = required.filter((component) => !actual[category].has(component));
    if (absent.length > 0) missing[category] = absent;
  }
  requireValue(
    Object.keys(missing).length === 0,
    `Public LGPL runtime is missing required FFmpeg components: ${JSON.stringify(missing)}`,
  );
  const filters = actual.filters;
  const encoders = actual.encoders;
  for (const filter of manifest.componentPolicy.forbiddenFilters) {
    requireValue(!filters.has(filter), `Public LGPL runtime contains forbidden FFmpeg filter ${filter}`);
  }
  for (const encoder of manifest.componentPolicy.forbiddenEncoders) {
    requireValue(!encoders.has(encoder), `Public LGPL runtime contains forbidden FFmpeg encoder ${encoder}`);
  }
  return {
    requiredComponentsPresent: Object.fromEntries(
      Object.entries(manifest.componentPolicy.requiredComponents).map(([category, values]) => [category, [...values]]),
    ),
    forbiddenFiltersAbsent: [...manifest.componentPolicy.forbiddenFilters],
    forbiddenEncodersAbsent: [...manifest.componentPolicy.forbiddenEncoders],
  };
}

function verifyProjectLicense(options) {
  const id = String(options.projectLicenseId ?? "").trim();
  const path = options.projectLicenseFile ? resolve(options.projectLicenseFile) : "";
  requireValue(id && !/^(?:unknown|unlicensed|none)$/i.test(id), "Release evidence requires an explicit GIFP project-license identifier");
  requireValue(path && existsSync(path) && statSync(path).isFile(), "Release evidence requires an existing GIFP project-license file");
  requireValue(statSync(path).size > 0, "GIFP project-license file is empty");
  const expectedSha256 = normalizeSha256(options.projectLicenseSha256, "GIFP project-license hash");
  const actualSha256 = sha256File(path);
  requireValue(actualSha256 === expectedSha256, `GIFP project-license SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  return { id, fileName: basename(path), sizeBytes: statSync(path).size, sha256: actualSha256 };
}

function verifyCorrespondingSource(manifest, options) {
  const archive = options.sourceBundle ? resolve(options.sourceBundle) : "";
  const recordPath = options.sourceBundleRecord ? resolve(options.sourceBundleRecord) : "";
  requireValue(archive && existsSync(archive) && statSync(archive).isFile(), "public-alpha requires a reviewed FFmpeg Corresponding Source archive");
  requireValue(statSync(archive).size > 0, "FFmpeg Corresponding Source archive is empty");
  const expectedArchiveSha256 = normalizeSha256(options.sourceBundleSha256, "Corresponding Source archive hash");
  const actualArchiveSha256 = sha256File(archive);
  requireValue(actualArchiveSha256 === expectedArchiveSha256, `Corresponding Source archive SHA-256 mismatch: expected ${expectedArchiveSha256}, got ${actualArchiveSha256}`);
  requireValue(recordPath && existsSync(recordPath) && statSync(recordPath).isFile(), "public-alpha requires a Corresponding Source review record");

  const record = readJson(recordPath, "Corresponding Source review record");
  requireValue(record.schemaVersion === 1, "Unsupported Corresponding Source review record schema");
  requireValue(record.completeCorrespondingSourceReviewed === true, "Corresponding Source review record is not approved");
  requireValue(record.ffmpegCommit === manifest.version.ffmpegCommit, "Corresponding Source record FFmpeg commit does not match the pinned runtime");
  requireValue(record.buildRecipeCommit === manifest.version.buildRecipeCommit, "Corresponding Source record build-recipe commit does not match the pinned runtime");
  requireValue(
    normalizeSha256(record.sourceLockSha256, "Review record source-lock hash") === manifest.publicReleaseProfile.sourceLock.sha256,
    "Corresponding Source record source-lock hash does not match the pinned runtime",
  );
  requireValue(
    normalizeSha256(record.buildRecipeLockSha256, "Review record build-recipe lock hash") === manifest.publicReleaseProfile.buildRecipeLock.sha256,
    "Corresponding Source record build-recipe lock hash does not match the pinned runtime",
  );
  requireValue(normalizeSha256(record.binaryAssetSha256, "Review record binary asset hash") === manifest.binaryAsset.sha256, "Corresponding Source record binary asset hash does not match the pinned runtime");
  requireValue(normalizeSha256(record.archiveSha256, "Review record archive hash") === actualArchiveSha256, "Corresponding Source record archive hash does not match the supplied archive");
  requireValue(typeof record.reviewer === "string" && record.reviewer.trim().length >= 2, "Corresponding Source review record must identify a reviewer");
  requireValue(!Number.isNaN(Date.parse(record.reviewedAt)), "Corresponding Source review record must contain a valid reviewedAt timestamp");
  assertImmutableUrl(record.distributionUrl, "Corresponding Source distribution URL");

  return {
    fileName: basename(archive),
    sizeBytes: statSync(archive).size,
    sha256: actualArchiveSha256,
    recordFileName: basename(recordPath),
    recordSizeBytes: statSync(recordPath).size,
    recordSha256: sha256File(recordPath),
    distributionUrl: record.distributionUrl,
    reviewer: record.reviewer.trim(),
    reviewedAt: record.reviewedAt,
  };
}

export function evaluateDistributionPolicy(manifest, options) {
  const channel = String(options.channel ?? "internal").trim().toLowerCase();
  requireValue(channel === "internal" || isPublicReleaseChannel(channel), `Unknown distribution channel: ${channel}`);
  const gitDirty = options.gitDirty === undefined
    ? null
    : parseStrictBoolean(options.gitDirty, "--git-dirty");
  const signatureStatus = String(options.signatureStatus ?? "UnknownError");
  requireValue(signatureStatus === "Valid" || signatureStatus === "NotSigned", `Unsafe executable signature status: ${signatureStatus}`);

  if (channel === "internal") {
    const projectLicense = options.projectLicenseFile ? verifyProjectLicense(options) : null;
    return {
      channel,
      redistributable: false,
      unsigned: signatureStatus !== "Valid",
      status: "INTERNAL DEVELOPMENT PACKAGE - DO NOT REDISTRIBUTE",
      warnings: ["Reviewed complete Corresponding Source is not present; this preview is not public-release evidence."],
      projectLicense,
    };
  }

  assertPublicManifestReady(manifest);
  requireValue(/^[a-f0-9]{40}$/i.test(String(options.gitCommit ?? "")), "public-alpha requires a full 40-character Git commit");
  requireValue(gitDirty !== null, "public-alpha requires --git-dirty");
  requireValue(!gitDirty, "public-alpha requires a clean Git worktree");
  if (channel === "public-alpha") {
    requireValue(/alpha/i.test(String(options.artifactName ?? "")), "public-alpha artifact name must contain alpha");
  } else {
    requireValue(!/alpha/i.test(String(options.artifactName ?? "")), "public artifact name must not contain alpha");
  }
  const projectLicense = verifyProjectLicense(options);
  const correspondingSource = verifyCorrespondingSource(manifest, options);
  const unsigned = signatureStatus !== "Valid";
  if (channel === "public") {
    requireValue(!unsigned, `public requires a Valid Authenticode signature; unsigned override is forbidden`);
  } else {
    requireValue(!unsigned || isTruthy(options.allowUnsignedAlpha), `Executable signature status is ${signatureStatus}; set GIFP_ALLOW_UNSIGNED_ALPHA=1 only for an explicitly labelled unsigned Alpha`);
  }
  let signer = null;
  if (!unsigned) {
    const actualThumbprint = String(options.signerThumbprint ?? "").replace(/\s/g, "").toLowerCase();
    const allowedThumbprint = String(options.allowedSignerThumbprint ?? "").replace(/\s/g, "").toLowerCase();
    requireValue(/^[a-f0-9]{40,64}$/.test(actualThumbprint), `Signed ${channel} executable has no usable signer thumbprint`);
    requireValue(/^[a-f0-9]{40,64}$/.test(allowedThumbprint), `Signed ${channel} requires an allowed signer thumbprint`);
    requireValue(actualThumbprint === allowedThumbprint, "Authenticode signer is not allowlisted for GIFP releases");
    signer = { thumbprint: actualThumbprint };
  }

  return {
    channel,
    redistributable: true,
    unsigned,
    status: channel === "public"
      ? "PUBLIC RELEASE - AUTHENTICODE SIGNED"
      : (unsigned ? "PUBLIC ALPHA - UNSIGNED" : "PUBLIC ALPHA - AUTHENTICODE SIGNED"),
    warnings: unsigned ? ["Windows may show a SmartScreen warning because the publisher is not authenticated."] : [],
    projectLicense,
    correspondingSource,
    signer,
  };
}

function normalizedReleaseCommit(value) {
  const commit = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

function normalizedGitObjectHash(value) {
  const hash = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(hash) ? hash : null;
}

export function evaluateQualityReleaseBinding(verified, options) {
  const channel = String(options.channel ?? "internal").trim().toLowerCase();
  requireValue(channel === "internal" || isPublicReleaseChannel(channel), `Unknown distribution channel: ${channel}`);
  const packageGitCommit = normalizedReleaseCommit(options.gitCommit);
  const packageGitTreeHash = normalizedGitObjectHash(options.gitTreeHash);
  const reportGitCommit = normalizedReleaseCommit(verified?.git_commit);
  const commitMatchesPackage = packageGitCommit !== null && reportGitCommit === packageGitCommit;
  const reportClean = verified?.git_dirty === false;
  const packageGitDirty = options.gitDirty === undefined
    ? null
    : parseStrictBoolean(options.gitDirty, "--git-dirty");
  const packageWorktreeClean = packageGitDirty === false;
  const buildProvenance = verified?.build_provenance;
  const buildCommitMatchesPackage = packageGitCommit !== null
    && buildProvenance?.embedded_git_commit === packageGitCommit
    && buildProvenance?.runtime_start_commit === packageGitCommit
    && buildProvenance?.runtime_end_commit === packageGitCommit;
  const buildProvenancePassed = buildProvenance?.passed === true
    && buildProvenance?.embedded_git_dirty === false
    && buildProvenance?.runtime_start_dirty === false
    && buildProvenance?.runtime_end_dirty === false
    && buildProvenance?.executor_start_sha256 === buildProvenance?.executor_end_sha256;
  const buildTreeMatchesPackage = packageGitTreeHash !== null
    && buildProvenance?.embedded_git_tree_hash === packageGitTreeHash
    && buildProvenance?.runtime_start_tree_hash === packageGitTreeHash
    && buildProvenance?.runtime_end_tree_hash === packageGitTreeHash;
  const gatePassed = verified?.first_tier_quality_passed === true;
  const canonicalFixtureIdentityPassed = verified?.first_tier_canonical_fixture_identity_passed === true
    && verified?.canonical_fixture_identity?.passed === true
    && verified?.canonical_fixture_identity?.live_passed === true
    && verified?.canonical_fixture_identity?.generator_identity_passed === true
    && verified?.canonical_fixture_identity?.live_generator_verified === true
    && verified?.canonical_fixture_identity?.source_identity_passed === true
    && verified?.canonical_fixture_identity?.live_source_identity_verified === true;
  const qualifiedForFirstTierRelease = commitMatchesPackage
    && reportClean
    && packageWorktreeClean
    && buildCommitMatchesPackage
    && buildTreeMatchesPackage
    && buildProvenancePassed
    && verified?.first_tier_applicable === true
    && verified?.first_tier_provenance_passed === true
    && verified?.first_tier_canonical_corpus_passed === true
    && canonicalFixtureIdentityPassed
    && gatePassed;

  if (isPublicReleaseChannel(channel)) {
    requireValue(reportGitCommit !== null, "public-alpha Quality Lab report has no full Git commit");
    requireValue(reportClean, "public-alpha Quality Lab report was captured from a dirty worktree");
    requireValue(packageWorktreeClean, "public-alpha package worktree is dirty");
    requireValue(commitMatchesPackage, `Quality evidence commit ${reportGitCommit} does not match package commit ${packageGitCommit ?? "invalid"}`);
    requireValue(buildProvenancePassed, "public-alpha Quality evidence has no passing compile/runtime build provenance");
    requireValue(buildCommitMatchesPackage, "public-alpha Quality executor build/runtime commits do not match the package commit");
    requireValue(buildTreeMatchesPackage, "public-alpha Quality executor tracked tree does not match the frozen package build inputs");
    requireValue(verified.first_tier_applicable === true, "public-alpha requires an applicable first-tier quality gate");
    requireValue(verified.first_tier_provenance_passed === true, "public-alpha quality evidence has no clean-commit provenance");
    requireValue(verified.first_tier_canonical_corpus_passed === true, "public-alpha quality evidence did not use the canonical corpus");
    requireValue(canonicalFixtureIdentityPassed, "public-alpha quality evidence does not have a live, fixed identity for every canonical fixture and generator tool");
    requireValue(gatePassed, "public-alpha requires a passing first-tier quality gate");
  }

  return {
    schemaVersion: 1,
    requiredForChannel: isPublicReleaseChannel(channel),
    qualifiedForFirstTierRelease,
    report: {
      packagedPath: "QUALITY_EVIDENCE/quality-report.json",
      sha256: verified.report_sha256,
      sizeBytes: verified.report_size_bytes,
      schemaVersion: verified.schema_version,
      schemaPackagedPath: "QUALITY_EVIDENCE/bench/quality-report.schema.json",
      schemaSha256: verified.schema_sha256,
      runId: verified.run_id,
      gitCommit: reportGitCommit,
      gitDirty: verified.git_dirty,
      buildProvenancePackagedPath: "QUALITY_EVIDENCE/artifact-bundle/build-provenance.json",
      executorSha256: buildProvenance?.executor_start_sha256 ?? null,
      executorTrackedTreeHash: buildProvenance?.embedded_git_tree_hash ?? null,
    },
    gate: {
      acceptanceId: verified.acceptance_id,
      applicable: verified.first_tier_applicable,
      provenancePassed: verified.first_tier_provenance_passed,
      canonicalCorpusPassed: verified.first_tier_canonical_corpus_passed,
      canonicalFixtureIdentityPassed,
      passed: gatePassed,
    },
    corpus: {
      id: verified.corpus_id,
      manifestPackagedPath: "QUALITY_EVIDENCE/bench/corpus-manifest.json",
      manifestSha256: verified.corpus_manifest_sha256,
    },
    artifactBundle: {
      schemaVersion: verified.artifact_bundle_schema_version,
      packagedRoot: "QUALITY_EVIDENCE/artifact-bundle",
      manifestPackagedPath: "QUALITY_EVIDENCE/artifact-bundle/bundle-manifest.json",
      manifestSha256: verified.artifact_bundle_manifest_sha256,
      artifactCount: verified.artifact_count,
      artifactSizeBytes: verified.artifact_size_bytes,
    },
    binding: {
      packageGitCommit,
      packageGitTreeHash,
      commitMatchesPackage,
      reportClean,
      packageWorktreeClean,
      buildCommitMatchesPackage,
      buildTreeMatchesPackage,
      buildProvenancePassed,
    },
  };
}

function safeEvidenceOutputPath(root, relativePath, label) {
  requireValue(
    typeof relativePath === "string"
      && relativePath.length > 0
      && !isAbsolute(relativePath)
      && !relativePath.includes("\\")
      && relativePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    `${label} is unsafe`,
  );
  const output = resolve(root, relativePath);
  const fromRoot = relative(root, output);
  requireValue(fromRoot.length > 0 && !fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot), `${label} escapes the evidence root`);
  return output;
}

function normalizedFilesystemPath(value) {
  let normalized = resolve(value);
  if (process.platform === "win32") {
    if (normalized.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
    else if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
    normalized = normalized.toLowerCase();
  }
  return normalized.replace(/[\\/]+$/, "");
}

function assertRegularDirectoryNoReparse(path, label) {
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  requireValue(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} is not a regular directory`);
  requireValue(
    normalizedFilesystemPath(realpathSync.native(absolute)) === normalizedFilesystemPath(absolute),
    `${label} resolves through a reparse point or link`,
  );
  return absolute;
}

function assertNoReparseTree(root, label) {
  const absoluteRoot = assertRegularDirectoryNoReparse(root, label);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      const metadata = lstatSync(entryPath);
      requireValue(!metadata.isSymbolicLink(), `${label} contains a reparse point or link: ${entryPath}`);
      if (metadata.isDirectory()) visit(entryPath);
      else requireValue(metadata.isFile(), `${label} contains a non-regular entry: ${entryPath}`);
    }
  };
  visit(absoluteRoot);
  return absoluteRoot;
}

function assertEvidenceDestination(root, destinationPath, label) {
  const absoluteRoot = assertRegularDirectoryNoReparse(root, "Quality evidence root");
  const parent = dirname(destinationPath);
  const relativeParent = relative(absoluteRoot, parent);
  requireValue(
    relativeParent === "" || (!relativeParent.startsWith(`..${sep}`) && relativeParent !== ".." && !isAbsolute(relativeParent)),
    `${label} parent escapes the evidence root`,
  );
  assertRegularDirectoryNoReparse(parent, `${label} parent`);
}

function assertPortableEvidenceText(root) {
  // Require a token boundary before a drive/UNC prefix so ordinary URLs such
  // as `https://...` do not become the false-positive drive path `s:/...`.
  // The backslash ranges accept both plain CSV/HTML and JSON-escaped paths.
  const forbiddenWindowsPath = /(?:^|[^\w+.:\x2f\\-])(?:[a-zA-Z]:(?:\\{1,2}|\/)|\\{2,4}\?\\{1,2}[a-zA-Z]:(?:\\{1,2}|\/)|\\{2,4}(?:\?\\{1,2})?[a-zA-Z0-9._$-]+\\{1,2}|\/{2}(?:\?\/)?[a-zA-Z0-9._$-]+\/)/m;
  const forbiddenLocalFileUrl = /file:(?:\/{2,3}|\\{2,3})[a-zA-Z]:(?:\\{1,2}|\/)/i;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      const metadata = lstatSync(entryPath);
      requireValue(!metadata.isSymbolicLink(), `Portable Quality evidence contains a link: ${entryPath}`);
      if (metadata.isDirectory()) {
        visit(entryPath);
        continue;
      }
      requireValue(metadata.isFile(), `Portable Quality evidence contains a non-file: ${entryPath}`);
      if (!/\.(?:json|csv|html)$/i.test(entry.name)) continue;
      const text = readFileSync(entryPath, "utf8");
      requireValue(
        !forbiddenWindowsPath.test(text) && !forbiddenLocalFileUrl.test(text),
        `Portable Quality evidence leaks an absolute drive, UNC, or user path in ${relative(root, entryPath)}`,
      );
    }
  };
  visit(root);
}

const portableProjectionContractId = "gifp.quality-evidence-portable-projection.v1";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVerifiedEvidenceBytes(sourcePath, expectedSize, expectedSha256, label) {
  const source = resolve(sourcePath);
  const metadata = lstatSync(source);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink(), `${label} source is not a regular file`);
  requireValue(metadata.size === expectedSize, `${label} source size changed after verification`);
  const bytes = readFileSync(source);
  requireValue(bytes.length === expectedSize, `${label} source size changed while snapshotting`);
  requireValue(sha256Bytes(bytes) === expectedSha256, `${label} source SHA-256 changed after verification`);
  return bytes;
}

function writeEvidenceBytes(root, destinationPath, bytes, label) {
  mkdirSync(dirname(destinationPath), { recursive: true });
  assertEvidenceDestination(root, destinationPath, label);
  writeFileSync(destinationPath, bytes, { flag: "wx" });
  const written = lstatSync(destinationPath);
  requireValue(written.isFile() && !written.isSymbolicLink(), `${label} destination is not a regular file`);
  requireValue(written.size === bytes.length, `${label} copied size mismatch`);
  requireValue(sha256File(destinationPath) === sha256Bytes(bytes), `${label} copied SHA-256 mismatch`);
}

function replaceMachineLocalPathPrefixes(value) {
  let replacements = 0;
  // Consume only the machine-specific prefix. The remaining path is useful to
  // reviewers, while the portable:// token cannot be mistaken for a host path.
  const withoutFileUrls = value.replace(
    /file:(?:\/{2,3}|\\{2,3})[a-zA-Z]:(?:\\+|\/)/gi,
    () => {
      replacements += 1;
      return "portable://local/";
    },
  );
  const projected = withoutFileUrls.replace(
    /(^|[^\w+.:\x2f\\-])(?:[a-zA-Z]:(?:\\+|\/)|\\{2,4}\?\\+[a-zA-Z]:(?:\\+|\/)|\\{2,4}(?:\?\\+)?[a-zA-Z0-9._$-]+\\+|\/{2}(?:\?\/)?[a-zA-Z0-9._$-]+\/)/gm,
    (match, boundary) => {
      replacements += 1;
      return `${boundary}portable://local/`;
    },
  );
  return { value: projected, replacements };
}

function projectJsonValue(value, metrics) {
  if (typeof value === "string") {
    const projected = replaceMachineLocalPathPrefixes(value);
    metrics.replacements += projected.replacements;
    return projected.value;
  }
  if (Array.isArray(value)) return value.map((entry) => projectJsonValue(entry, metrics));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, projectJsonValue(entry, metrics)]),
    );
  }
  return value;
}

function projectPortableText(bytes, relativePath, metrics) {
  if (!/\.(?:json|csv|html)$/i.test(relativePath)) return bytes;
  const originalText = bytes.toString("utf8");
  let projectedText;
  if (/\.json$/i.test(relativePath)) {
    try {
      const parsed = JSON.parse(originalText);
      projectedText = `${JSON.stringify(projectJsonValue(parsed, metrics), null, 2)}\n`;
    } catch {
      const projected = replaceMachineLocalPathPrefixes(originalText);
      metrics.replacements += projected.replacements;
      projectedText = projected.value;
    }
  } else {
    const projected = replaceMachineLocalPathPrefixes(originalText);
    metrics.replacements += projected.replacements;
    projectedText = projected.value;
  }
  return Buffer.from(projectedText, "utf8");
}

function projectedArtifactEntry(artifact, bytes) {
  return {
    role: artifact.role,
    relative_path: artifact.relative_path,
    sha256: sha256Bytes(bytes),
    size_bytes: bytes.length,
  };
}

function materializePortableQualityEvidence(root, verified, summary) {
  const metrics = { replacements: 0, filesChanged: 0 };
  const projectedArtifacts = [];
  const sourceArtifacts = [];
  const copiedPaths = new Set();

  requireValue(Array.isArray(verified.artifacts), "Verified quality artifact inventory is missing");
  requireValue(verified.artifacts.length === verified.artifact_count, "Verified quality artifact count is inconsistent");
  for (const artifact of verified.artifacts) {
    const relativePath = safeRelativeBundlePath(artifact.relative_path, "Quality bundle artifact path");
    requireValue(relativePath.toLowerCase() !== "bundle-manifest.json", "Quality bundle inventory includes its own manifest");
    const collisionKey = relativePath.toLowerCase();
    requireValue(!copiedPaths.has(collisionKey), `Duplicate quality artifact output path: ${relativePath}`);
    copiedPaths.add(collisionKey);
    const sourceBytes = readVerifiedEvidenceBytes(
      artifact.source_path,
      artifact.size_bytes,
      artifact.sha256,
      `Quality artifact ${relativePath}`,
    );
    const replacementsBefore = metrics.replacements;
    const projectedBytes = projectPortableText(sourceBytes, relativePath, metrics);
    const projected = projectedArtifactEntry(artifact, projectedBytes);
    if (projected.sha256 !== artifact.sha256) metrics.filesChanged += 1;
    writeEvidenceBytes(
      root,
      safeEvidenceOutputPath(root, `artifact-bundle/${relativePath}`, "Quality artifact output path"),
      projectedBytes,
      `Projected quality artifact ${relativePath}`,
    );
    sourceArtifacts.push({
      role: artifact.role,
      relativePath,
      sha256: artifact.sha256,
      sizeBytes: artifact.size_bytes,
    });
    projectedArtifacts.push({
      ...projected,
      pathReplacements: metrics.replacements - replacementsBefore,
    });
  }

  const sourceBundleManifestBytes = readVerifiedEvidenceBytes(
    verified.artifact_bundle_manifest_path,
    verified.artifact_bundle_manifest_size_bytes,
    verified.artifact_bundle_manifest_sha256,
    "Artifact bundle manifest",
  );
  let sourceBundleManifest;
  try {
    sourceBundleManifest = JSON.parse(sourceBundleManifestBytes.toString("utf8"));
  } catch (error) {
    throw new ComplianceError(`Artifact bundle manifest is not valid JSON during projection: ${error.message}`);
  }
  const projectedBundleManifest = projectJsonValue(sourceBundleManifest, metrics);
  projectedBundleManifest.schema_version = verified.artifact_bundle_schema_version;
  projectedBundleManifest.run_id = verified.run_id;
  projectedBundleManifest.artifacts = projectedArtifacts.map(({ pathReplacements: ignored, ...artifact }) => artifact);
  const projectedBundleManifestBytes = Buffer.from(`${JSON.stringify(projectedBundleManifest, null, 2)}\n`, "utf8");
  const projectedBundleManifestSha256 = sha256Bytes(projectedBundleManifestBytes);
  if (projectedBundleManifestSha256 !== verified.artifact_bundle_manifest_sha256) metrics.filesChanged += 1;
  writeEvidenceBytes(
    root,
    safeEvidenceOutputPath(root, "artifact-bundle/bundle-manifest.json", "Bundle manifest output path"),
    projectedBundleManifestBytes,
    "Projected artifact bundle manifest",
  );

  const sourceReportBytes = readVerifiedEvidenceBytes(
    verified.report_path,
    verified.report_size_bytes,
    verified.report_sha256,
    "Quality report",
  );
  let projectedReportBytes;
  try {
    const projectedReport = projectJsonValue(JSON.parse(sourceReportBytes.toString("utf8")), metrics);
    if (projectedReport.artifact_bundle && typeof projectedReport.artifact_bundle === "object") {
      projectedReport.artifact_bundle = {
        schema_version: verified.artifact_bundle_schema_version,
        run_id: verified.run_id,
        root_path: "artifact-bundle",
        manifest_path: "artifact-bundle/bundle-manifest.json",
        manifest_sha256: projectedBundleManifestSha256,
        artifacts: projectedBundleManifest.artifacts,
      };
    }
    projectedReportBytes = Buffer.from(`${JSON.stringify(projectedReport, null, 2)}\n`, "utf8");
  } catch {
    projectedReportBytes = projectPortableText(sourceReportBytes, "quality-report.json", metrics);
  }
  const projectedReportSha256 = sha256Bytes(projectedReportBytes);
  if (projectedReportSha256 !== verified.report_sha256) metrics.filesChanged += 1;
  writeEvidenceBytes(
    root,
    safeEvidenceOutputPath(root, "quality-report.json", "Quality report output path"),
    projectedReportBytes,
    "Projected quality report",
  );

  // Schema and canonical corpus are reviewed, content-addressed inputs. They
  // must already be portable and are copied byte-for-byte, never rewritten.
  copyVerifiedEvidenceFile(
    root,
    verified.schema_path,
    safeEvidenceOutputPath(root, "bench/quality-report.schema.json", "Quality schema output path"),
    verified.schema_size_bytes,
    verified.schema_sha256,
    "Quality report schema",
  );
  copyVerifiedEvidenceFile(
    root,
    verified.corpus_manifest_path,
    safeEvidenceOutputPath(root, "bench/corpus-manifest.json", "Canonical corpus output path"),
    verified.corpus_manifest_size_bytes,
    verified.corpus_manifest_sha256,
    "Canonical corpus manifest",
  );

  const projection = {
    schemaVersion: 1,
    contractId: portableProjectionContractId,
    source: {
      report: { sha256: verified.report_sha256, sizeBytes: verified.report_size_bytes },
      artifactBundleManifest: {
        sha256: verified.artifact_bundle_manifest_sha256,
        sizeBytes: verified.artifact_bundle_manifest_size_bytes,
      },
      artifacts: sourceArtifacts,
    },
    projected: {
      report: { path: "quality-report.json", sha256: projectedReportSha256, sizeBytes: projectedReportBytes.length },
      artifactBundleManifest: {
        path: "artifact-bundle/bundle-manifest.json",
        sha256: projectedBundleManifestSha256,
        sizeBytes: projectedBundleManifestBytes.length,
      },
      artifacts: projectedArtifacts.map(({ pathReplacements, ...artifact }) => ({
        role: artifact.role,
        relativePath: artifact.relative_path,
        sha256: artifact.sha256,
        sizeBytes: artifact.size_bytes,
        pathReplacements,
      })),
    },
    transformations: {
      machinePathPrefixesReplaced: metrics.replacements,
      filesChanged: metrics.filesChanged,
    },
  };
  const projectionBytes = Buffer.from(`${JSON.stringify(projection, null, 2)}\n`, "utf8");
  const projectionSha256 = sha256Bytes(projectionBytes);
  writeEvidenceBytes(
    root,
    safeEvidenceOutputPath(root, "PORTABLE-PROJECTION.json", "Portable projection record output path"),
    projectionBytes,
    "Portable projection record",
  );

  const projectedSummary = structuredClone(summary);
  projectedSummary.report.sourceSha256 = projectedSummary.report.sha256;
  projectedSummary.report.sourceSizeBytes = projectedSummary.report.sizeBytes;
  projectedSummary.report.sha256 = projectedReportSha256;
  projectedSummary.report.sizeBytes = projectedReportBytes.length;
  projectedSummary.artifactBundle.sourceManifestSha256 = projectedSummary.artifactBundle.manifestSha256;
  projectedSummary.artifactBundle.manifestSha256 = projectedBundleManifestSha256;
  projectedSummary.artifactBundle.artifactSizeBytes = projectedBundleManifest.artifacts
    .reduce((sum, artifact) => sum + artifact.size_bytes, 0);
  projectedSummary.portableProjection = {
    schemaVersion: 1,
    contractId: portableProjectionContractId,
    recordPackagedPath: "QUALITY_EVIDENCE/PORTABLE-PROJECTION.json",
    recordSha256: projectionSha256,
    machinePathPrefixesReplaced: metrics.replacements,
    filesChanged: metrics.filesChanged,
  };
  return projectedSummary;
}

function copyVerifiedEvidenceFile(root, sourcePath, destinationPath, expectedSize, expectedSha256, label) {
  const source = resolve(sourcePath);
  const metadata = lstatSync(source);
  requireValue(metadata.isFile() && !metadata.isSymbolicLink(), `${label} source is not a regular file`);
  requireValue(metadata.size === expectedSize, `${label} source size changed after verification`);
  requireValue(sha256File(source) === expectedSha256, `${label} source SHA-256 changed after verification`);
  mkdirSync(dirname(destinationPath), { recursive: true });
  assertEvidenceDestination(root, destinationPath, label);
  copyFileSync(source, destinationPath, fsConstants.COPYFILE_EXCL);
  const copied = lstatSync(destinationPath);
  requireValue(copied.isFile() && !copied.isSymbolicLink(), `${label} destination is not a regular file`);
  requireValue(copied.size === expectedSize, `${label} copied size mismatch`);
  requireValue(sha256File(destinationPath) === expectedSha256, `${label} copied SHA-256 mismatch`);
}

export function materializeQualityEvidence(verified, outputDir, summary, options = {}) {
  const root = resolve(outputDir);
  requireValue(!existsSync(root), `Quality evidence output directory already exists: ${root}`);
  const allowedParent = assertNoReparseTree(
    options.allowedParentDir ?? dirname(root),
    "Quality evidence parent",
  );
  requireValue(
    normalizedFilesystemPath(dirname(root)) === normalizedFilesystemPath(allowedParent),
    "Quality evidence output must be a direct child of its reviewed parent",
  );
  try {
    mkdirSync(root);
    assertRegularDirectoryNoReparse(root, "Quality evidence root");
    let materializedSummary = summary;
    if (options.portableProjection === true) {
      materializedSummary = materializePortableQualityEvidence(root, verified, summary);
    } else {
      copyVerifiedEvidenceFile(
        root,
        verified.report_path,
        safeEvidenceOutputPath(root, "quality-report.json", "Quality report output path"),
        verified.report_size_bytes,
        verified.report_sha256,
        "Quality report",
      );
      copyVerifiedEvidenceFile(
        root,
        verified.schema_path,
        safeEvidenceOutputPath(root, "bench/quality-report.schema.json", "Quality schema output path"),
        verified.schema_size_bytes,
        verified.schema_sha256,
        "Quality report schema",
      );
      copyVerifiedEvidenceFile(
        root,
        verified.corpus_manifest_path,
        safeEvidenceOutputPath(root, "bench/corpus-manifest.json", "Canonical corpus output path"),
        verified.corpus_manifest_size_bytes,
        verified.corpus_manifest_sha256,
        "Canonical corpus manifest",
      );
      copyVerifiedEvidenceFile(
        root,
        verified.artifact_bundle_manifest_path,
        safeEvidenceOutputPath(root, "artifact-bundle/bundle-manifest.json", "Bundle manifest output path"),
        verified.artifact_bundle_manifest_size_bytes,
        verified.artifact_bundle_manifest_sha256,
        "Artifact bundle manifest",
      );

      requireValue(Array.isArray(verified.artifacts), "Verified quality artifact inventory is missing");
      requireValue(verified.artifacts.length === verified.artifact_count, "Verified quality artifact count is inconsistent");
      const copiedPaths = new Set();
      for (const artifact of verified.artifacts) {
        const relativePath = safeRelativeBundlePath(artifact.relative_path, "Quality bundle artifact path");
        requireValue(relativePath.toLowerCase() !== "bundle-manifest.json", "Quality bundle inventory includes its own manifest");
        const collisionKey = relativePath.toLowerCase();
        requireValue(!copiedPaths.has(collisionKey), `Duplicate quality artifact output path: ${relativePath}`);
        copiedPaths.add(collisionKey);
        copyVerifiedEvidenceFile(
          root,
          artifact.source_path,
          safeEvidenceOutputPath(root, `artifact-bundle/${relativePath}`, "Quality artifact output path"),
          artifact.size_bytes,
          artifact.sha256,
          `Quality artifact ${relativePath}`,
        );
      }
    }

    writeFileSync(
      safeEvidenceOutputPath(root, "QUALITY-EVIDENCE.json", "Quality evidence summary output path"),
      `${JSON.stringify(materializedSummary, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    assertNoReparseTree(root, "Quality evidence output");
    if (options.requirePortableText === true) assertPortableEvidenceText(root);
    return { root, summary: materializedSummary };
  } catch (error) {
    if (existsSync(root)) {
      try {
        assertNoReparseTree(root, "Quality evidence cleanup root");
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Fail closed and preserve a suspicious tree for manual review.
      }
    }
    if (error instanceof ComplianceError) throw error;
    throw new ComplianceError(`Unable to materialize Quality evidence: ${error.message}`);
  }
}

export function verifyReleaseQualityEvidence(options, verifier = verifyQualityReport) {
  const channel = String(options.channel ?? "internal").trim().toLowerCase();
  requireValue(channel === "internal" || isPublicReleaseChannel(channel), `Unknown distribution channel: ${channel}`);
  const reportInput = String(options.qualityReport ?? "").trim();
  if (!reportInput) {
    requireValue(!isPublicReleaseChannel(channel), `${channel} requires GIFP_QUALITY_REPORT`);
    return null;
  }
  const reportPath = resolve(reportInput);
  requireValue(existsSync(reportPath) && statSync(reportPath).isFile(), `Quality Lab report does not exist: ${reportPath}`);

  let verified;
  try {
    verified = verifier({
      reportPath,
      requireFirstTierQuality: isPublicReleaseChannel(channel),
    });
  } catch (error) {
    throw new ComplianceError(`Quality evidence verification failed: ${error.message}`);
  }
  let summary = evaluateQualityReleaseBinding(verified, options);
  if (isPublicReleaseChannel(channel)) {
    requireValue(options.qualityEvidenceDir, `${channel} requires a Quality evidence materialization directory`);
  }
  if (options.qualityEvidenceDir) {
    const materialized = materializeQualityEvidence(verified, options.qualityEvidenceDir, summary, {
      allowedParentDir: options.qualityEvidenceRoot ?? dirname(resolve(options.qualityEvidenceDir)),
      requirePortableText: isPublicReleaseChannel(channel),
      portableProjection: isPublicReleaseChannel(channel),
    });
    summary = materialized.summary;
  }
  return summary;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    requireValue(token.startsWith("--"), `Unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    requireValue(value !== undefined && !value.startsWith("--"), `Missing value for ${token}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

export function verifyReleaseInputs(options) {
  const channel = String(options.channel ?? "internal").trim().toLowerCase();
  const manifestPath = resolve(options.manifest);
  const runtimeDir = resolve(options.runtimeDir);
  const rawManifest = readJson(manifestPath, "FFmpeg compliance manifest");
  validateManifestForChannel(rawManifest, channel);
  let publicSourceLock = null;
  let publicReviewRecords = null;
  if (isPublicReleaseChannel(channel)) {
    publicSourceLock = verifyPublicSourceLock(rawManifest, manifestPath);
    assertPublicManifestReady(rawManifest);
    publicReviewRecords = verifyPublicReviewRecords(rawManifest, manifestPath, String(options.gitCommit ?? "").toLowerCase());
    const suppliedSourceRecord = options.sourceBundleRecord ? resolve(options.sourceBundleRecord) : "";
    requireValue(suppliedSourceRecord && existsSync(suppliedSourceRecord) && statSync(suppliedSourceRecord).isFile(), "public-alpha requires the hash-bound Corresponding Source review record");
    requireValue(
      sha256File(suppliedSourceRecord) === publicReviewRecords.correspondingSourceReview.sha256,
      "Supplied Corresponding Source review record does not match the manifest-bound review evidence",
    );
  }
  const manifest = validatePinnedManifest(rawManifest);
  const binaryAssetFile = isPublicReleaseChannel(channel) ? verifyBinaryAsset(manifest, options.binaryAsset) : null;
  const runtimeFiles = verifyRuntimeFiles(manifest, runtimeDir);
  const ffmpegLicense = verifyFfmpegLicense(manifest, options.ffmpegLicense);
  const dependencyManifest = verifyDependencyManifest(options.dependencyManifest);
  const licenseTextBundle = verifyLicenseTextBundle(options.licenseTextManifest, dependencyManifest);
  if (isPublicReleaseChannel(channel)) {
    requireValue(licenseTextBundle.missingLicenseTextCount === 0, `public-alpha requires complete third-party license texts; ${licenseTextBundle.missingLicenseTextCount} component(s) are unresolved`);
  }
  const ffmpegPath = resolve(runtimeDir, "ffmpeg.exe");
  let versionText;
  try {
    versionText = execFileSync(ffmpegPath, ["-version"], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new ComplianceError(`Unable to execute pinned ffmpeg.exe: ${error.message}`);
  }
  const ffmpeg = verifyFfmpegVersion(manifest, versionText);
  let ffmpegComponentPolicy = null;
  if (isPublicReleaseChannel(channel)) {
    const inventoryCommands = {
      protocolsText: ["-protocols"],
      devicesText: ["-devices"],
      demuxersText: ["-demuxers"],
      decodersText: ["-decoders"],
      encodersText: ["-encoders"],
      muxersText: ["-muxers"],
      filtersText: ["-filters"],
      hwaccelsText: ["-hwaccels"],
    };
    const inventories = {};
    try {
      for (const [key, args] of Object.entries(inventoryCommands)) {
        inventories[key] = execFileSync(ffmpegPath, ["-hide_banner", ...args], {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        });
      }
    } catch (error) {
      throw new ComplianceError(`Unable to inspect Public LGPL FFmpeg components: ${error.message}`);
    }
    ffmpegComponentPolicy = verifyFfmpegComponentPolicy(manifest, inventories);
  }
  const distribution = evaluateDistributionPolicy(manifest, options);
  const qualityEvidence = verifyReleaseQualityEvidence(options);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    manifestFile: basename(manifestPath),
    component: manifest.component,
    platform: manifest.platform,
    variant: manifest.variant,
    licenseExpression: manifest.licenseExpression,
    distributionPolicy: manifest.distributionPolicy,
    binaryAsset: manifest.binaryAsset,
    binaryAssetFile,
    sourceProvenance: manifest.sourceProvenance,
    version: manifest.version,
    ffmpeg,
    ffmpegComponentPolicy,
    publicSourceLock,
    publicReviewRecords,
    runtimeFiles,
    ffmpegLicense,
    dependencyManifest,
    licenseTextBundle,
    distribution,
    qualityEvidence,
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    requireValue(options.manifest, "--manifest is required");
    requireValue(options.runtimeDir, "--runtime-dir is required");
    const report = verifyReleaseInputs(options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) writeFileSync(resolve(options.output), json, "utf8");
    process.stdout.write(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Release compliance verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
