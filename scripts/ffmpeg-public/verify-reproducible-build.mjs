#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORD_TYPE = 'gifp-public-ffmpeg-reproducibility';
const RUNTIME_ARCHIVE = 'GIFP-FFmpeg-Windows-x64-LGPL-shared.zip';
const SOURCE_ARCHIVE = 'GIFP-FFmpeg-Corresponding-Source.tar';
const LICENSE_BUNDLE = 'RUNTIME-LICENSES.txt';

const REQUIRED_MANIFESTS = [
  'runtime.sha256',
  'runtime-licenses.sha256',
  'corresponding-source-archive.sha256',
  'corresponding-sources.sha256',
  'recipe.sha256',
  'build-inputs.sha256',
];

const REQUIRED_EVIDENCE = [
  'build-metadata.json',
  'build-recipe-verification.json',
  'source-cache-verification.json',
  'runtime-inventory-verification.json',
  'host-driver.json',
  'build-status.json',
  'docker-image-inspect.json',
];

const INVENTORY_CATEGORIES = [
  'protocols',
  'devices',
  'demuxers',
  'decoders',
  'encoders',
  'muxers',
  'filters',
  'hwaccels',
];

const REQUIRED_INPUT_MOUNTS = [
  '/sources:read-only',
  '/recipe:read-only',
  '/lock:read-only',
];

const REQUIRED_OUTPUT_MOUNTS = [
  '/work:fresh Linux-native Docker volume',
  '/out:read-write',
];

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = createReadStream(filename);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  const serialized = JSON.stringify(canonicalize(value));
  return serialized === undefined ? 'undefined' : serialized;
}

function jsonDigest(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function relativeRecordPath(value) {
  return value.split(path.sep).join('/');
}

function addIssue(state, code, message, relativePath) {
  const issue = { side: state.side, code, message };
  if (relativePath) {
    issue.path = relativeRecordPath(relativePath);
  }
  state.errors.push(issue);
}

async function pathKind(filename) {
  try {
    const stats = await fs.lstat(filename);
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    if (stats.isSymbolicLink()) return 'symlink';
    return 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function inspectRegularFile(state, relativePath, { required = true } = {}) {
  const filename = path.join(state.root, relativePath);
  let kind;
  try {
    kind = await pathKind(filename);
  } catch (error) {
    addIssue(state, 'FILE_STAT_FAILED', error.message, relativePath);
    return null;
  }

  if (kind === 'missing' && !required) return null;
  if (kind === 'missing') {
    addIssue(state, 'REQUIRED_FILE_MISSING', 'Required file is missing.', relativePath);
    return null;
  }
  if (kind !== 'file') {
    addIssue(state, 'NOT_A_REGULAR_FILE', `Expected a regular file, found ${kind}.`, relativePath);
    return null;
  }

  try {
    const stats = await fs.stat(filename);
    const sha256 = await sha256File(filename);
    if (stats.size === 0) {
      addIssue(state, 'EMPTY_FILE', 'Required build output is empty.', relativePath);
    }
    return { path: relativeRecordPath(relativePath), sizeBytes: stats.size, sha256 };
  } catch (error) {
    addIssue(state, 'FILE_READ_FAILED', error.message, relativePath);
    return null;
  }
}

async function readRequiredText(state, relativePath) {
  const inspected = await inspectRegularFile(state, relativePath);
  if (!inspected) return null;
  try {
    return {
      inspected,
      text: await fs.readFile(path.join(state.root, relativePath), 'utf8'),
    };
  } catch (error) {
    addIssue(state, 'TEXT_READ_FAILED', error.message, relativePath);
    return null;
  }
}

async function readRequiredJson(state, relativePath) {
  const loaded = await readRequiredText(state, relativePath);
  if (!loaded) return null;
  try {
    return JSON.parse(loaded.text);
  } catch (error) {
    addIssue(state, 'INVALID_JSON', error.message, relativePath);
    return null;
  }
}

function parseHashManifest(state, filename, text) {
  const entries = new Map();
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) {
    addIssue(state, 'EMPTY_HASH_MANIFEST', 'Hash manifest has no entries.', `evidence/${filename}`);
    return entries;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/);
    if (!match || match[2] !== match[2].trim()) {
      addIssue(
        state,
        'INVALID_HASH_MANIFEST_LINE',
        `Invalid sha256sum line ${index + 1}.`,
        `evidence/${filename}`,
      );
      continue;
    }
    const entryPath = match[2].replaceAll('\\', '/');
    if (entries.has(entryPath)) {
      addIssue(
        state,
        'DUPLICATE_HASH_MANIFEST_PATH',
        `Duplicate hash entry: ${entryPath}`,
        `evidence/${filename}`,
      );
      continue;
    }
    entries.set(entryPath, match[1].toLowerCase());
  }
  return entries;
}

async function inspectManifest(state, filename, { required = true } = {}) {
  const relativePath = `evidence/${filename}`;
  const kind = await pathKind(path.join(state.root, relativePath));
  if (kind === 'missing' && !required) return null;
  const loaded = await readRequiredText(state, relativePath);
  if (!loaded) return null;
  return {
    path: relativePath,
    sizeBytes: loaded.inspected.sizeBytes,
    sha256: loaded.inspected.sha256,
    entries: parseHashManifest(state, filename, loaded.text),
  };
}

function stripDotSlash(value) {
  return value.startsWith('./') ? value.slice(2) : value;
}

function safeRelativeManifestPath(state, manifestName, value) {
  const normalized = stripDotSlash(value).replaceAll('\\', '/');
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    addIssue(
      state,
      'UNSAFE_HASH_MANIFEST_PATH',
      `Unsafe hash manifest path: ${value}`,
      `evidence/${manifestName}`,
    );
    return null;
  }
  return normalized;
}

async function walkRegularFiles(state, relativeRoot) {
  const root = path.join(state.root, relativeRoot);
  const result = [];
  let rootKind;
  try {
    rootKind = await pathKind(root);
  } catch (error) {
    addIssue(state, 'DIRECTORY_STAT_FAILED', error.message, relativeRoot);
    return result;
  }
  if (rootKind === 'missing') {
    addIssue(state, 'REQUIRED_DIRECTORY_MISSING', 'Required directory is missing.', relativeRoot);
    return result;
  }
  if (rootKind !== 'directory') {
    addIssue(state, 'NOT_A_DIRECTORY', `Expected a directory, found ${rootKind}.`, relativeRoot);
    return result;
  }

  async function visit(absoluteDirectory, relativeDirectory) {
    let entries;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      addIssue(state, 'DIRECTORY_READ_FAILED', error.message, relativeDirectory);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const childAbsolute = path.join(absoluteDirectory, entry.name);
      const childRelative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(childAbsolute, childRelative);
      } else if (entry.isFile()) {
        const inspected = await inspectRegularFile(state, childRelative);
        if (inspected) result.push(inspected);
      } else {
        addIssue(state, 'UNSUPPORTED_DIRECTORY_ENTRY', 'Symlinks and special files are not allowed.', childRelative);
      }
    }
  }

  await visit(root, relativeRoot);
  result.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (result.length === 0) {
    addIssue(state, 'EMPTY_DIRECTORY', 'Required directory contains no files.', relativeRoot);
  }
  return result;
}

function fileMap(files, prefix) {
  return new Map(
    files.map((file) => {
      const name = prefix ? file.path.slice(prefix.length).replace(/^\//, '') : file.path;
      return [name, file];
    }),
  );
}

function compareStringSets(left, right) {
  const leftOnly = [...left].filter((item) => !right.has(item)).sort();
  const rightOnly = [...right].filter((item) => !left.has(item)).sort();
  return { equal: leftOnly.length === 0 && rightOnly.length === 0, leftOnly, rightOnly };
}

function validateManifestFileSet(state, manifestName, manifest, files, prefix) {
  if (!manifest) return;
  const expected = fileMap(files, prefix);
  const normalizedEntries = new Map();
  for (const [entryPath, sha256] of manifest.entries) {
    const normalized = safeRelativeManifestPath(state, manifestName, entryPath);
    if (normalized) normalizedEntries.set(normalized, sha256);
  }
  const setResult = compareStringSets(new Set(expected.keys()), new Set(normalizedEntries.keys()));
  if (!setResult.equal) {
    addIssue(
      state,
      'HASH_MANIFEST_FILE_SET_MISMATCH',
      `Manifest/file set mismatch (missing: ${setResult.leftOnly.join(', ') || 'none'}; unexpected: ${setResult.rightOnly.join(', ') || 'none'}).`,
      `evidence/${manifestName}`,
    );
  }
  for (const [name, expectedFile] of expected) {
    const declared = normalizedEntries.get(name);
    if (declared && declared !== expectedFile.sha256) {
      addIssue(
        state,
        'HASH_MANIFEST_DIGEST_MISMATCH',
        `Declared hash for ${name} does not match the file.`,
        `evidence/${manifestName}`,
      );
    }
  }
}

function validateSingleArtifactManifest(state, manifestName, manifest, artifact) {
  if (!manifest || !artifact) return;
  const entries = [...manifest.entries.entries()];
  const expectedName = path.posix.basename(artifact.path);
  if (entries.length !== 1 || stripDotSlash(entries[0][0]) !== expectedName) {
    addIssue(
      state,
      'HASH_MANIFEST_FILE_SET_MISMATCH',
      `Manifest must contain exactly ${expectedName}.`,
      `evidence/${manifestName}`,
    );
    return;
  }
  if (entries[0][1] !== artifact.sha256) {
    addIssue(
      state,
      'HASH_MANIFEST_DIGEST_MISMATCH',
      `Declared hash for ${expectedName} does not match the file.`,
      `evidence/${manifestName}`,
    );
  }
}

async function validateBuildInputsManifest(state, manifest, recipeManifest) {
  if (!manifest) return;
  const mapped = new Map();
  for (const [entryPath, expectedSha] of manifest.entries) {
    let relativePath;
    if (entryPath === '/lock/sources.lock.json') {
      relativePath = 'corresponding-source/sources.lock.json';
    } else if (entryPath === '/lock/build-recipe.lock.json') {
      relativePath = 'corresponding-source/build-recipe.lock.json';
    } else if (entryPath.startsWith('/recipe/')) {
      const suffix = safeRelativeManifestPath(state, 'build-inputs.sha256', entryPath.slice('/recipe/'.length));
      if (suffix) relativePath = `corresponding-source/recipe/${suffix}`;
    } else {
      addIssue(
        state,
        'UNKNOWN_BUILD_INPUT_PATH',
        `Build input is outside the locked /lock and /recipe roots: ${entryPath}`,
        'evidence/build-inputs.sha256',
      );
    }
    if (!relativePath) continue;
    const inspected = await inspectRegularFile(state, relativePath);
    if (inspected) {
      mapped.set(entryPath, inspected);
      if (expectedSha !== inspected.sha256) {
        addIssue(
          state,
          'HASH_MANIFEST_DIGEST_MISMATCH',
          `Declared hash for ${entryPath} does not match the archived input.`,
          'evidence/build-inputs.sha256',
        );
      }
    }
  }

  if (recipeManifest) {
    const expectedPaths = new Set([
      '/lock/sources.lock.json',
      '/lock/build-recipe.lock.json',
      ...[...recipeManifest.entries.keys()].map((name) => `/recipe/${stripDotSlash(name)}`),
    ]);
    const setResult = compareStringSets(expectedPaths, new Set(manifest.entries.keys()));
    if (!setResult.equal) {
      addIssue(
        state,
        'BUILD_INPUT_FILE_SET_MISMATCH',
        `Build input set mismatch (missing: ${setResult.leftOnly.join(', ') || 'none'}; unexpected: ${setResult.rightOnly.join(', ') || 'none'}).`,
        'evidence/build-inputs.sha256',
      );
    }
  }
  state.buildInputFiles = mapped;
}

function requireObject(state, value, relativePath, label) {
  if (!isPlainObject(value)) {
    addIssue(state, 'INVALID_EVIDENCE_SHAPE', `${label} must be a JSON object.`, relativePath);
    return false;
  }
  return true;
}

function requireNonEmptyString(state, value, relativePath, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    addIssue(state, 'INVALID_EVIDENCE_FIELD', `${field} must be a non-empty string.`, relativePath);
    return false;
  }
  return true;
}

function requirePositiveInteger(state, value, relativePath, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    addIssue(state, 'INVALID_EVIDENCE_FIELD', `${field} must be a positive integer.`, relativePath);
    return false;
  }
  return true;
}

function validateOfflineText(state, value, relativePath, field, { requirePullNever = false } = {}) {
  if (!requireNonEmptyString(state, value, relativePath, field)) return;
  if (!/(?:^|\s)--network=none(?:\s|;|$)/.test(value)) {
    addIssue(state, 'NETWORK_IS_NOT_OFFLINE', `${field} must prove --network=none.`, relativePath);
  }
  if (requirePullNever && !/(?:^|\s)--pull=never(?:\s|;|$)/.test(value)) {
    addIssue(state, 'BUILDER_PULL_IS_NOT_DISABLED', `${field} must prove --pull=never.`, relativePath);
  }
}

function validateBuildMetadata(state, metadata) {
  const relativePath = 'evidence/build-metadata.json';
  if (!requireObject(state, metadata, relativePath, 'build metadata')) return;
  if (metadata.schemaVersion !== 1) {
    addIssue(state, 'UNSUPPORTED_SCHEMA_VERSION', 'build-metadata schemaVersion must be 1.', relativePath);
  }
  for (const field of ['profile', 'target', 'runtimeLinkage']) {
    requireNonEmptyString(state, metadata[field], relativePath, field);
  }
  if (!/^.+@sha256:[0-9a-f]{64}$/i.test(metadata.builderImage ?? '')) {
    addIssue(state, 'UNPINNED_BUILDER_IMAGE', 'builderImage must be pinned by sha256 digest.', relativePath);
  }
  requirePositiveInteger(state, metadata.sourceDateEpoch, relativePath, 'sourceDateEpoch');
  for (const field of ['sourceLockSha256', 'buildRecipeLockSha256']) {
    if (!isSha256(metadata[field])) {
      addIssue(state, 'INVALID_EVIDENCE_FIELD', `${field} must be a SHA-256 digest.`, relativePath);
    }
  }
  validateOfflineText(state, metadata.networkPolicy, relativePath, 'networkPolicy');
  if (typeof metadata.networkPolicy === 'string' && !/read-only/i.test(metadata.networkPolicy)) {
    addIssue(state, 'INPUT_MOUNTS_NOT_READ_ONLY', 'networkPolicy must also record read-only inputs.', relativePath);
  }
}

function validateRecipeVerification(state, verification) {
  const relativePath = 'evidence/build-recipe-verification.json';
  if (!requireObject(state, verification, relativePath, 'build recipe verification')) return;
  if (verification.schemaVersion !== 1) {
    addIssue(state, 'UNSUPPORTED_SCHEMA_VERSION', 'build-recipe-verification schemaVersion must be 1.', relativePath);
  }
  for (const field of ['profile', 'builderImage']) {
    requireNonEmptyString(state, verification[field], relativePath, field);
  }
  requirePositiveInteger(state, verification.sourceDateEpoch, relativePath, 'sourceDateEpoch');
  if (!isPlainObject(verification.sourceLock) || !isSha256(verification.sourceLock.sha256)) {
    addIssue(state, 'INVALID_LOCK_VERIFICATION', 'sourceLock must contain a SHA-256 digest.', relativePath);
  }
  if (!Array.isArray(verification.inputs) || verification.inputs.length === 0) {
    addIssue(state, 'INVALID_LOCK_VERIFICATION', 'inputs must be a non-empty array.', relativePath);
  } else {
    for (const input of verification.inputs) {
      if (
        !isPlainObject(input)
        || typeof input.path !== 'string'
        || !Number.isSafeInteger(input.sizeBytes)
        || input.sizeBytes <= 0
        || !isSha256(input.sha256)
      ) {
        addIssue(state, 'INVALID_LOCK_VERIFICATION', 'Every recipe input needs path, sizeBytes, and sha256.', relativePath);
        break;
      }
    }
  }
}

function validateSourceVerification(state, verification) {
  const relativePath = 'evidence/source-cache-verification.json';
  if (!requireObject(state, verification, relativePath, 'source cache verification')) return;
  if (verification.schemaVersion !== 1) {
    addIssue(state, 'UNSUPPORTED_SCHEMA_VERSION', 'source-cache-verification schemaVersion must be 1.', relativePath);
  }
  for (const field of ['profile', 'target', 'builderImage']) {
    requireNonEmptyString(state, verification[field], relativePath, field);
  }
  if (
    !Number.isSafeInteger(verification.sourceCount)
    || verification.sourceCount <= 0
    || !Array.isArray(verification.sources)
    || verification.sourceCount !== verification.sources.length
  ) {
    addIssue(state, 'INVALID_LOCK_VERIFICATION', 'sourceCount must match a non-empty sources array.', relativePath);
    return;
  }
  for (const source of verification.sources) {
    if (
      !isPlainObject(source)
      || !requireNonEmptyString(state, source.id, relativePath, 'sources[].id')
      || !requireNonEmptyString(state, source.archiveFile, relativePath, 'sources[].archiveFile')
      || !Number.isSafeInteger(source.sizeBytes)
      || source.sizeBytes <= 0
      || !isSha256(source.sha256)
    ) {
      addIssue(state, 'INVALID_LOCK_VERIFICATION', 'Every locked source needs identity, archive, size, and sha256.', relativePath);
      break;
    }
  }
}

function validateRuntimeInventory(state, inventory) {
  const relativePath = 'evidence/runtime-inventory-verification.json';
  if (!requireObject(state, inventory, relativePath, 'runtime inventory verification')) return;
  if (inventory.schemaVersion !== 1) {
    addIssue(state, 'UNSUPPORTED_SCHEMA_VERSION', 'runtime inventory schemaVersion must be 1.', relativePath);
  }
  for (const field of ['actual', 'expected', 'missing', 'forbidden']) {
    if (!isPlainObject(inventory[field])) {
      addIssue(state, 'INVALID_RUNTIME_INVENTORY', `${field} must be an object.`, relativePath);
    }
  }
  if (!isPlainObject(inventory.actual) || !isPlainObject(inventory.expected)) return;
  for (const category of INVENTORY_CATEGORIES) {
    const actual = inventory.actual[category];
    const expected = inventory.expected[category];
    if (
      !Array.isArray(actual)
      || !Array.isArray(expected)
      || actual.some((item) => typeof item !== 'string')
      || expected.some((item) => typeof item !== 'string')
    ) {
      addIssue(state, 'INVALID_RUNTIME_INVENTORY', `${category} must contain string arrays.`, relativePath);
      continue;
    }
    const actualSet = new Set(actual);
    const missing = expected.filter((item) => !actualSet.has(item));
    if (missing.length > 0) {
      addIssue(state, 'RUNTIME_CAPABILITY_MISSING', `${category} is missing: ${missing.join(', ')}`, relativePath);
    }
  }
  if (isPlainObject(inventory.missing) && Object.keys(inventory.missing).length > 0) {
    addIssue(state, 'RUNTIME_INVENTORY_REPORTS_MISSING', 'missing must be empty for a successful build.', relativePath);
  }
  if (isPlainObject(inventory.forbidden) && Object.keys(inventory.forbidden).length > 0) {
    addIssue(state, 'RUNTIME_INVENTORY_REPORTS_FORBIDDEN', 'forbidden must be empty for a successful build.', relativePath);
  }
}

function normalizedHostFacts(hostDriver) {
  if (!isPlainObject(hostDriver)) return null;
  return {
    schemaVersion: hostDriver.schemaVersion,
    builderImage: hostDriver.builderImage,
    builderImageId: hostDriver.builderImageId,
    builderAcquisition: hostDriver.builderAcquisition,
    builderRunReference: hostDriver.builderRunReference,
    sourceDateEpoch: hostDriver.sourceDateEpoch,
    networkPolicy: hostDriver.networkPolicy,
    platform: hostDriver.platform,
    inputSnapshot: hostDriver.inputSnapshot,
    inputMountPolicy: Array.isArray(hostDriver.inputMountPolicy)
      ? [...hostDriver.inputMountPolicy].sort()
      : hostDriver.inputMountPolicy,
    outputMountPolicy: Array.isArray(hostDriver.outputMountPolicy)
      ? [...hostDriver.outputMountPolicy].sort()
      : hostDriver.outputMountPolicy,
    workVolumeStatus: hostDriver.workVolumeStatus,
    dockerExitCode: hostDriver.dockerExitCode,
    dockerInvocationError: hostDriver.dockerInvocationError,
  };
}

function validateHostDriver(state, hostDriver) {
  const relativePath = 'evidence/host-driver.json';
  if (!requireObject(state, hostDriver, relativePath, 'host driver evidence')) return;
  if (hostDriver.schemaVersion !== 1) {
    addIssue(state, 'UNSUPPORTED_SCHEMA_VERSION', 'host-driver schemaVersion must be 1.', relativePath);
  }
  if (!/^.+@sha256:[0-9a-f]{64}$/i.test(hostDriver.builderImage ?? '')) {
    addIssue(state, 'UNPINNED_BUILDER_IMAGE', 'builderImage must be pinned by sha256 digest.', relativePath);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(hostDriver.builderImageId ?? '')) {
    addIssue(state, 'INVALID_BUILDER_IMAGE_ID', 'builderImageId must be a SHA-256 image ID.', relativePath);
  }
  if (!['registry-digest', 'offline-import-config-digest'].includes(hostDriver.builderAcquisition)) {
    addIssue(state, 'INVALID_BUILDER_ACQUISITION', 'builderAcquisition must identify a reviewed registry or offline-import path.', relativePath);
  }
  if (typeof hostDriver.builderRunReference !== 'string' || hostDriver.builderRunReference.length === 0) {
    addIssue(state, 'INVALID_BUILDER_RUN_REFERENCE', 'builderRunReference must identify the exact local image used for Docker run.', relativePath);
  }
  requirePositiveInteger(state, hostDriver.sourceDateEpoch, relativePath, 'sourceDateEpoch');
  validateOfflineText(state, hostDriver.networkPolicy, relativePath, 'networkPolicy', { requirePullNever: true });
  const inputMounts = new Set(Array.isArray(hostDriver.inputMountPolicy) ? hostDriver.inputMountPolicy : []);
  const outputMounts = new Set(Array.isArray(hostDriver.outputMountPolicy) ? hostDriver.outputMountPolicy : []);
  if (REQUIRED_INPUT_MOUNTS.some((mount) => !inputMounts.has(mount))) {
    addIssue(state, 'INPUT_MOUNTS_NOT_READ_ONLY', 'All locked inputs must be mounted read-only.', relativePath);
  }
  if (REQUIRED_OUTPUT_MOUNTS.some((mount) => !outputMounts.has(mount))) {
    addIssue(state, 'OUTPUT_MOUNT_POLICY_INVALID', 'Build output policies must use a fresh volume and /out read-write.', relativePath);
  }
  if (hostDriver.workVolumeStatus !== 'removed-after-success') {
    addIssue(state, 'WORK_VOLUME_NOT_CLEANED', 'workVolumeStatus must be removed-after-success.', relativePath);
  }
  const started = Date.parse(hostDriver.startedUtc);
  const finished = Date.parse(hostDriver.finishedUtc);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    addIssue(state, 'INVALID_BUILD_TIMESTAMPS', 'Build start/finish timestamps are missing, invalid, or reversed.', relativePath);
  }
  if (typeof hostDriver.workVolume !== 'string' || hostDriver.workVolume.length === 0) {
    addIssue(state, 'INVALID_WORK_VOLUME', 'workVolume must identify the fresh Docker build volume.', relativePath);
  }
  if (hostDriver.dockerExitCode !== 0 || hostDriver.dockerInvocationError !== null) {
    addIssue(state, 'BUILDER_DID_NOT_SUCCEED', 'Docker build must finish with exit code 0 and no invocation error.', relativePath);
  }
}

function validateBuildStatus(state, status) {
  const relativePath = 'evidence/build-status.json';
  if (!requireObject(state, status, relativePath, 'build status')) return;
  if (status.schemaVersion !== 1 || status.exitCode !== 0) {
    addIssue(state, 'BUILD_STATUS_NOT_SUCCESSFUL', 'build-status must use schema 1 and exitCode 0.', relativePath);
  }
}

function normalizedBuilderInspect(inspect, hostDriver) {
  if (!Array.isArray(inspect) || !isPlainObject(hostDriver)) return null;
  const image = inspect.find((entry) => isPlainObject(entry) && entry.Id === hostDriver.builderImageId);
  if (!image) return null;
  return {
    id: image.Id,
    repoDigests: Array.isArray(image.RepoDigests) ? [...image.RepoDigests].sort() : image.RepoDigests,
    repoTags: Array.isArray(image.RepoTags) ? [...image.RepoTags].sort() : image.RepoTags,
    architecture: image.Architecture,
    os: image.Os,
  };
}

function validateBuilderInspect(state, inspect, hostDriver) {
  const relativePath = 'evidence/docker-image-inspect.json';
  if (!Array.isArray(inspect) || inspect.length === 0) {
    addIssue(state, 'INVALID_BUILDER_INSPECT', 'docker-image-inspect must be a non-empty array.', relativePath);
    return;
  }
  const normalized = normalizedBuilderInspect(inspect, hostDriver);
  if (!normalized) {
    addIssue(state, 'BUILDER_IMAGE_ID_MISMATCH', 'Inspected image ID does not match host-driver evidence.', relativePath);
    return;
  }
  if (hostDriver.builderAcquisition === 'registry-digest') {
    if (!Array.isArray(normalized.repoDigests) || !normalized.repoDigests.includes(hostDriver.builderImage)) {
      addIssue(state, 'BUILDER_IMAGE_DIGEST_MISMATCH', 'Inspected RepoDigests does not contain the locked builder.', relativePath);
    }
  } else if (!Array.isArray(normalized.repoTags) || !normalized.repoTags.includes(hostDriver.builderRunReference)) {
    addIssue(state, 'BUILDER_OFFLINE_TAG_MISMATCH', 'Inspected RepoTags does not contain the audited offline-import reference.', relativePath);
  }
  if (normalized.architecture !== 'amd64' || normalized.os !== 'linux') {
    addIssue(state, 'BUILDER_PLATFORM_MISMATCH', 'Builder image must be linux/amd64.', relativePath);
  }
}

function validateEvidenceCrossLinks(state) {
  const metadata = state.evidence['build-metadata.json'];
  const recipe = state.evidence['build-recipe-verification.json'];
  const sources = state.evidence['source-cache-verification.json'];
  const host = state.evidence['host-driver.json'];
  if (![metadata, recipe, sources, host].every(isPlainObject)) return;
  const relationships = [
    ['profile', metadata.profile, recipe.profile],
    ['profile', metadata.profile, sources.profile],
    ['target', metadata.target, sources.target],
    ['builderImage', metadata.builderImage, recipe.builderImage],
    ['builderImage', metadata.builderImage, sources.builderImage],
    ['builderImage', metadata.builderImage, host.builderImage],
    ['sourceDateEpoch', metadata.sourceDateEpoch, recipe.sourceDateEpoch],
    ['sourceDateEpoch', metadata.sourceDateEpoch, host.sourceDateEpoch],
    ['sourceLockSha256', metadata.sourceLockSha256, recipe.sourceLock?.sha256],
  ];
  for (const [field, left, right] of relationships) {
    if (left !== right) {
      addIssue(state, 'EVIDENCE_CROSS_LINK_MISMATCH', `${field} disagrees between evidence records.`, 'evidence');
    }
  }

  const sourceLock = state.buildInputFiles?.get('/lock/sources.lock.json');
  const recipeLock = state.buildInputFiles?.get('/lock/build-recipe.lock.json');
  if (sourceLock && metadata.sourceLockSha256 !== sourceLock.sha256) {
    addIssue(state, 'SOURCE_LOCK_HASH_MISMATCH', 'build metadata does not match archived sources.lock.json.', 'evidence/build-metadata.json');
  }
  if (recipeLock && metadata.buildRecipeLockSha256 !== recipeLock.sha256) {
    addIssue(state, 'RECIPE_LOCK_HASH_MISMATCH', 'build metadata does not match archived build-recipe.lock.json.', 'evidence/build-metadata.json');
  }
}

async function inspectBuild(root, side) {
  const state = {
    side,
    root: path.resolve(root),
    errors: [],
    runtime: [],
    artifacts: {},
    manifests: {},
    evidence: {},
    buildInputFiles: new Map(),
  };

  const rootKind = await pathKind(state.root);
  if (rootKind !== 'directory') {
    addIssue(state, 'BUILD_ROOT_NOT_DIRECTORY', `Build root must be a directory, found ${rootKind}.`);
    return state;
  }

  state.runtime = await walkRegularFiles(state, 'runtime');
  const runtimeNames = new Set(state.runtime.map((file) => path.posix.basename(file.path)));
  for (const requiredName of ['ffmpeg.exe', 'ffprobe.exe']) {
    if (!runtimeNames.has(requiredName)) {
      addIssue(state, 'RUNTIME_EXECUTABLE_MISSING', `${requiredName} is missing from runtime/.`, 'runtime');
    }
  }
  if (![...runtimeNames].some((name) => name.toLowerCase().endsWith('.dll'))) {
    addIssue(state, 'RUNTIME_DLL_CLOSURE_MISSING', 'Shared runtime must contain at least one DLL.', 'runtime');
  }

  state.artifacts.runtimeLicenses = await inspectRegularFile(state, LICENSE_BUNDLE);
  state.artifacts.correspondingSource = await inspectRegularFile(state, SOURCE_ARCHIVE);

  const archiveKind = await pathKind(path.join(state.root, RUNTIME_ARCHIVE));
  const archiveManifestKind = await pathKind(path.join(state.root, 'evidence/runtime-archive.sha256'));
  if ((archiveKind === 'missing') !== (archiveManifestKind === 'missing')) {
    addIssue(
      state,
      'OPTIONAL_ARCHIVE_MANIFEST_PAIR_MISMATCH',
      'Runtime ZIP and runtime-archive.sha256 must either both exist or both be absent.',
      RUNTIME_ARCHIVE,
    );
  }
  if (archiveKind !== 'missing') {
    state.artifacts.runtimeArchive = await inspectRegularFile(state, RUNTIME_ARCHIVE);
  } else {
    state.artifacts.runtimeArchive = null;
  }

  for (const manifestName of REQUIRED_MANIFESTS) {
    state.manifests[manifestName] = await inspectManifest(state, manifestName);
  }
  state.manifests['runtime-archive.sha256'] = archiveManifestKind === 'missing'
    ? null
    : await inspectManifest(state, 'runtime-archive.sha256');

  validateManifestFileSet(
    state,
    'runtime.sha256',
    state.manifests['runtime.sha256'],
    state.runtime,
    'runtime/',
  );
  validateSingleArtifactManifest(
    state,
    'runtime-licenses.sha256',
    state.manifests['runtime-licenses.sha256'],
    state.artifacts.runtimeLicenses,
  );
  validateSingleArtifactManifest(
    state,
    'corresponding-source-archive.sha256',
    state.manifests['corresponding-source-archive.sha256'],
    state.artifacts.correspondingSource,
  );
  validateSingleArtifactManifest(
    state,
    'runtime-archive.sha256',
    state.manifests['runtime-archive.sha256'],
    state.artifacts.runtimeArchive,
  );

  const sourceFiles = await walkRegularFiles(state, 'corresponding-source/sources');
  const recipeFiles = await walkRegularFiles(state, 'corresponding-source/recipe');
  validateManifestFileSet(
    state,
    'corresponding-sources.sha256',
    state.manifests['corresponding-sources.sha256'],
    sourceFiles,
    'corresponding-source/sources/',
  );
  validateManifestFileSet(
    state,
    'recipe.sha256',
    state.manifests['recipe.sha256'],
    recipeFiles,
    'corresponding-source/recipe/',
  );
  await validateBuildInputsManifest(
    state,
    state.manifests['build-inputs.sha256'],
    state.manifests['recipe.sha256'],
  );

  for (const evidenceName of REQUIRED_EVIDENCE) {
    state.evidence[evidenceName] = await readRequiredJson(state, `evidence/${evidenceName}`);
  }
  validateBuildMetadata(state, state.evidence['build-metadata.json']);
  validateRecipeVerification(state, state.evidence['build-recipe-verification.json']);
  validateSourceVerification(state, state.evidence['source-cache-verification.json']);
  validateRuntimeInventory(state, state.evidence['runtime-inventory-verification.json']);
  validateHostDriver(state, state.evidence['host-driver.json']);
  validateBuildStatus(state, state.evidence['build-status.json']);
  validateBuilderInspect(
    state,
    state.evidence['docker-image-inspect.json'],
    state.evidence['host-driver.json'],
  );
  validateEvidenceCrossLinks(state);

  return state;
}

function summarizeBuild(state) {
  const metadata = state.evidence['build-metadata.json'];
  return {
    rootLabel: path.basename(state.root),
    buildIdentity: metadata ? {
      profile: metadata.profile,
      target: metadata.target,
      builderImage: metadata.builderImage,
      sourceDateEpoch: metadata.sourceDateEpoch,
      sourceLockSha256: metadata.sourceLockSha256,
      buildRecipeLockSha256: metadata.buildRecipeLockSha256,
    } : null,
    runtime: state.runtime.map(({ path: filePath, sizeBytes, sha256 }) => ({
      path: filePath.slice('runtime/'.length),
      sizeBytes,
      sha256,
    })),
    artifacts: Object.fromEntries(
      Object.entries(state.artifacts).map(([name, artifact]) => [name, artifact && {
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      }]),
    ),
    manifests: Object.fromEntries(
      Object.entries(state.manifests).map(([name, manifest]) => [name, manifest && {
        sizeBytes: manifest.sizeBytes,
        sha256: manifest.sha256,
        entryCount: manifest.entries.size,
      }]),
    ),
    evidence: Object.fromEntries(
      REQUIRED_EVIDENCE.map((name) => [name, state.evidence[name] ? jsonDigest(state.evidence[name]) : null]),
    ),
    hostFacts: normalizedHostFacts(state.evidence['host-driver.json']),
    builderImageFacts: normalizedBuilderInspect(
      state.evidence['docker-image-inspect.json'],
      state.evidence['host-driver.json'],
    ),
  };
}

function addComparison(record, id, baselineValue, replayValue, message) {
  const baselineDigest = jsonDigest(baselineValue);
  const replayDigest = jsonDigest(replayValue);
  const ok = canonicalJson(baselineValue) === canonicalJson(replayValue);
  record.checks.push({ id, ok, baselineSha256: baselineDigest, replaySha256: replayDigest });
  if (!ok) {
    record.errors.push({
      side: 'comparison',
      code: 'REPRODUCIBILITY_MISMATCH',
      path: id,
      message,
    });
  }
}

function runtimeComparisonValue(state) {
  return state.runtime.map(({ path: filePath, sizeBytes, sha256 }) => ({
    path: filePath.slice('runtime/'.length),
    sizeBytes,
    sha256,
  }));
}

function artifactComparisonValue(state, name) {
  const artifact = state.artifacts[name];
  return artifact ? { sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 } : null;
}

function manifestComparisonValue(state, name) {
  const manifest = state.manifests[name];
  return manifest ? {
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
    entries: Object.fromEntries([...manifest.entries.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))),
  } : null;
}

export async function verifyReproducibleBuilds({ baselineRoot, replayRoot, gitCommit = null }) {
  if (typeof baselineRoot !== 'string' || baselineRoot.trim() === '') {
    throw new TypeError('baselineRoot must be a non-empty path string.');
  }
  if (typeof replayRoot !== 'string' || replayRoot.trim() === '') {
    throw new TypeError('replayRoot must be a non-empty path string.');
  }
  if (path.resolve(baselineRoot) === path.resolve(replayRoot)) {
    throw new TypeError('baselineRoot and replayRoot must be distinct build outputs.');
  }
  if (gitCommit !== null && !/^[0-9a-f]{40}$/i.test(gitCommit)) {
    throw new TypeError('gitCommit must be a full 40-character Git commit.');
  }

  const [baseline, replay] = await Promise.all([
    inspectBuild(baselineRoot, 'baseline'),
    inspectBuild(replayRoot, 'replay'),
  ]);
  const record = {
    schemaVersion: 1,
    type: RECORD_TYPE,
    gitCommit: gitCommit?.toLowerCase() ?? null,
    status: 'fail',
    reproducible: false,
    baseline: summarizeBuild(baseline),
    replay: summarizeBuild(replay),
    checks: [],
    errors: [...baseline.errors, ...replay.errors],
  };
  const baselineHost = baseline.evidence['host-driver.json'];
  const replayHost = replay.evidence['host-driver.json'];
  const independentReplay = Boolean(
    baselineHost
      && replayHost
      && typeof baselineHost.workVolume === 'string'
      && typeof replayHost.workVolume === 'string'
      && baselineHost.workVolume.length > 0
      && replayHost.workVolume.length > 0
      && baselineHost.workVolume !== replayHost.workVolume
      && typeof baselineHost.startedUtc === 'string'
      && typeof replayHost.startedUtc === 'string'
      && baselineHost.startedUtc !== replayHost.startedUtc,
  );
  record.checks.push({ id: 'build.independent-invocations', ok: independentReplay });
  if (!independentReplay) {
    record.errors.push({
      side: 'comparison',
      code: 'INDEPENDENT_REPLAY_NOT_PROVEN',
      path: 'build.independent-invocations',
      message: 'The two outputs do not identify distinct Docker work volumes and build start times.',
    });
  }

  addComparison(
    record,
    'runtime.file-set-size-sha256',
    runtimeComparisonValue(baseline),
    runtimeComparisonValue(replay),
    'Runtime file set, sizes, or hashes differ.',
  );
  for (const name of ['runtimeLicenses', 'runtimeArchive', 'correspondingSource']) {
    addComparison(
      record,
      `artifact.${name}`,
      artifactComparisonValue(baseline, name),
      artifactComparisonValue(replay, name),
      `${name} size or hash differs.`,
    );
  }

  const manifestNames = [...REQUIRED_MANIFESTS, 'runtime-archive.sha256'];
  for (const name of manifestNames) {
    addComparison(
      record,
      `manifest.${name}`,
      manifestComparisonValue(baseline, name),
      manifestComparisonValue(replay, name),
      `${name} differs.`,
    );
  }

  for (const name of [
    'build-metadata.json',
    'build-recipe-verification.json',
    'source-cache-verification.json',
    'runtime-inventory-verification.json',
    'build-status.json',
  ]) {
    addComparison(
      record,
      `evidence.${name}`,
      baseline.evidence[name],
      replay.evidence[name],
      `${name} facts differ.`,
    );
  }
  addComparison(
    record,
    'evidence.host-driver.builder-offline-facts',
    normalizedHostFacts(baseline.evidence['host-driver.json']),
    normalizedHostFacts(replay.evidence['host-driver.json']),
    'Pinned builder or offline host-driver facts differ.',
  );
  addComparison(
    record,
    'evidence.docker-image.builder-facts',
    normalizedBuilderInspect(
      baseline.evidence['docker-image-inspect.json'],
      baseline.evidence['host-driver.json'],
    ),
    normalizedBuilderInspect(
      replay.evidence['docker-image-inspect.json'],
      replay.evidence['host-driver.json'],
    ),
    'Inspected builder image facts differ.',
  );

  record.reproducible = record.errors.length === 0 && record.checks.every((check) => check.ok);
  record.status = record.reproducible ? 'pass' : 'fail';
  return record;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/ffmpeg-public/verify-reproducible-build.mjs',
    '    --baseline <first-build-output> --replay <second-build-output>',
    '    --git-commit <40-character-commit> [--output <record.json>]',
  ].join('\n');
}

function parseCliArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    const key = {
      '--baseline': 'baselineRoot',
      '--replay': 'replayRoot',
      '--git-commit': 'gitCommit',
      '--output': 'output',
    }[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    result[key] = value;
    index += 1;
  }
  if (!result.help && (!result.baselineRoot || !result.replayRoot)) {
    throw new Error('--baseline and --replay are required.');
  }
  return result;
}

export async function runCli(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCliArguments(argv);
  } catch (error) {
    const record = {
      schemaVersion: 1,
      type: RECORD_TYPE,
      status: 'error',
      reproducible: false,
      checks: [],
      errors: [{ side: 'cli', code: 'INVALID_ARGUMENTS', message: error.message }],
    };
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let record;
  try {
    record = await verifyReproducibleBuilds(args);
  } catch (error) {
    record = {
      schemaVersion: 1,
      type: RECORD_TYPE,
      status: 'error',
      reproducible: false,
      checks: [],
      errors: [{ side: 'tool', code: 'VERIFIER_ERROR', message: error.message }],
    };
  }

  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (args.output) {
    try {
      const outputPath = path.resolve(args.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, serialized, 'utf8');
    } catch (error) {
      record.status = 'error';
      record.reproducible = false;
      record.errors.push({ side: 'cli', code: 'OUTPUT_WRITE_FAILED', message: error.message });
    }
  }
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return record.reproducible ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
