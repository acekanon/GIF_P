// CLI entry point; invoke with Node.js.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_SCHEMA_VERSION = 1;
const LICENSE_TEXT_SCHEMA_VERSION = 1;
const GENERATOR_ID = "gifp-third-party-manifest";
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e(?:s)?|copying|notice|copyright|unlicense)(?:$|[._-].*)/i;
const LICENSE_DIRECTORY_PATTERN = /^(?:licen[cs]e(?:s)?|copying|notice)(?:$|[._-].*)/i;
const MAX_LICENSE_TEXT_BYTES = 4 * 1024 * 1024;

const HELP = `Generate a deterministic third-party dependency manifest.

Usage:
  node scripts/generate-third-party-manifest.mjs [options]

Options:
  --root <path>                    Project root (default: current directory)
  --package-lock <path>            npm lockfile (default: package-lock.json)
  --cargo-lock <path>              Cargo lockfile (default: src-tauri/Cargo.lock)
  --cargo-manifest <path>          Cargo manifest (default: src-tauri/Cargo.toml)
  --cargo-metadata-file <path>     Read saved cargo metadata instead of invoking cargo
  --cargo-filter-platform <triple> Pass --filter-platform to cargo metadata
  --include-npm-dev                Include npm packages marked as development-only
  --fail-on-missing-license        Exit 2 after output when any component lacks license data
  --licenses-output-dir <path>     Copy real license texts and write LICENSE-TEXTS.json
  --license-overlay-manifest <path> Add reviewed, hash-pinned upstream license texts
  --fail-on-missing-license-text   Exit 3 when a component has no collected license text
  --output <path>                  Write JSON to a file (default: stdout)
  --help                           Show this help

The JSON intentionally omits a generation timestamp, uses project-relative input
paths, removes machine-local Cargo paths, and sorts every component by identity.
`;

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizedSha256(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 64-character SHA-256 digest`);
  }
  return normalized;
}

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function inputPath(rootDir, path) {
  const candidate = portablePath(relative(rootDir, path));
  if (candidate === "") return ".";
  if (candidate === ".." || candidate.startsWith("../")) {
    return `external/${basename(path)}`;
  }
  return candidate;
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function normalizeLicense(value) {
  if (typeof value === "string") return normalizeOptionalText(value);
  if (Array.isArray(value)) {
    const licenses = value.map(normalizeLicense).filter(Boolean);
    return licenses.length === 0 ? null : licenses.join(" OR ");
  }
  if (value && typeof value === "object") {
    return normalizeLicense(value.type ?? value.name);
  }
  return null;
}

function npmNameFromInstallPath(installPath) {
  const marker = "node_modules/";
  const markerIndex = installPath.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const tail = installPath.slice(markerIndex + marker.length);
  if (!tail.startsWith("@")) return tail.split("/")[0] || null;
  const parts = tail.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

function normalizeNpmSource(rootDir, source, name, version) {
  const normalized = normalizeOptionalText(source);
  if (!normalized) return `npm:${name}@${version}`;
  if (!normalized.startsWith("file:")) return portablePath(normalized);

  const fileValue = normalized.slice("file:".length);
  if (!isAbsolute(fileValue)) return `file:${portablePath(fileValue)}`;
  return `file:${inputPath(rootDir, fileValue)}`;
}

function cargoLicenseFile(rootDir, packageMetadata) {
  const licenseFile = normalizeOptionalText(packageMetadata.license_file);
  if (!licenseFile) return null;
  if (!isAbsolute(licenseFile)) return portablePath(licenseFile);

  const manifestPath = normalizeOptionalText(packageMetadata.manifest_path);
  if (manifestPath) {
    const withinPackage = portablePath(relative(dirname(manifestPath), licenseFile));
    if (
      withinPackage !== ".." &&
      !withinPackage.startsWith("../") &&
      !isAbsolute(withinPackage)
    ) {
      return withinPackage;
    }
  }
  return inputPath(rootDir, licenseFile);
}

function cargoLocalSource(rootDir, packageMetadata) {
  const manifestPath = normalizeOptionalText(packageMetadata.manifest_path);
  if (!manifestPath) return null;
  return `path:${inputPath(rootDir, dirname(manifestPath))}`;
}

function parseTomlBasicString(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Unsupported Cargo.lock string ${raw}: ${error.message}`);
  }
}

function cargoLockString(block, key) {
  const expression = new RegExp(
    `^${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*$`,
    "m",
  );
  const match = expression.exec(block);
  return match ? parseTomlBasicString(match[1]) : null;
}

export function parseCargoLock(contents) {
  const versionMatch = /^version\s*=\s*(\d+)\s*$/m.exec(contents);
  const starts = [...contents.matchAll(/^\[\[package\]\]\s*$/gm)].map(
    (match) => match.index,
  );
  const packages = [];

  for (let index = 0; index < starts.length; index += 1) {
    const block = contents.slice(starts[index], starts[index + 1] ?? contents.length);
    const name = cargoLockString(block, "name");
    const version = cargoLockString(block, "version");
    if (!name || !version) continue;
    packages.push({
      name,
      version,
      source: cargoLockString(block, "source"),
      checksum: cargoLockString(block, "checksum"),
    });
  }

  return {
    version: versionMatch ? Number(versionMatch[1]) : null,
    packages,
  };
}

function cargoLockKey(name, version, source) {
  return `${name}\u0000${version}\u0000${source ?? ""}`;
}

function npmComponents(rootDir, packageLock, includeDevelopment) {
  if (!packageLock || typeof packageLock !== "object" || !packageLock.packages) {
    throw new Error("package-lock.json must contain a packages object");
  }

  const components = [];
  for (const [installPath, metadata] of Object.entries(packageLock.packages)) {
    if (installPath === "" || !metadata || typeof metadata !== "object") continue;
    if (!includeDevelopment && metadata.dev === true) continue;

    const name = normalizeOptionalText(metadata.name) ?? npmNameFromInstallPath(installPath);
    const version = normalizeOptionalText(metadata.version);
    if (!name || !version) {
      throw new Error(`npm package at '${installPath}' is missing name or version`);
    }
    const license = normalizeLicense(metadata.license);
    const source = normalizeNpmSource(rootDir, metadata.resolved, name, version);
    components.push({
      ecosystem: "npm",
      name,
      version,
      license,
      licenseFile: null,
      missingLicense: license === null,
      source,
      repository: null,
      integrity: normalizeOptionalText(metadata.integrity),
      scope: metadata.dev === true ? "development" : "runtime",
    });
  }
  return components;
}

function cargoComponents(rootDir, cargoMetadata, cargoLock) {
  if (!cargoMetadata || !Array.isArray(cargoMetadata.packages)) {
    throw new Error("cargo metadata must contain a packages array");
  }

  const workspaceIds = new Set(cargoMetadata.workspace_members ?? []);
  const resolvedIds = cargoMetadata.resolve?.nodes
    ? new Set(cargoMetadata.resolve.nodes.map((node) => node.id))
    : null;
  const lockPackages = new Map(
    cargoLock.packages.map((entry) => [
      cargoLockKey(entry.name, entry.version, entry.source),
      entry,
    ]),
  );
  const components = [];

  for (const metadata of cargoMetadata.packages) {
    if (workspaceIds.has(metadata.id)) continue;
    if (resolvedIds && !resolvedIds.has(metadata.id)) continue;

    const name = normalizeOptionalText(metadata.name);
    const version = normalizeOptionalText(metadata.version);
    if (!name || !version) {
      throw new Error(`cargo package '${metadata.id ?? "unknown"}' is missing name or version`);
    }
    const metadataSource = normalizeOptionalText(metadata.source);
    const lockEntry =
      lockPackages.get(cargoLockKey(name, version, metadataSource)) ??
      lockPackages.get(cargoLockKey(name, version, null));
    const source =
      metadataSource ??
      normalizeOptionalText(lockEntry?.source) ??
      cargoLocalSource(rootDir, metadata) ??
      `cargo:${name}@${version}`;
    const license = normalizeLicense(metadata.license);
    const licenseFile = cargoLicenseFile(rootDir, metadata);
    components.push({
      ecosystem: "cargo",
      name,
      version,
      license,
      licenseFile,
      missingLicense: license === null && licenseFile === null,
      source: portablePath(source),
      repository: normalizeOptionalText(metadata.repository),
      integrity: normalizeOptionalText(lockEntry?.checksum),
      scope: "resolved",
    });
  }
  return components;
}

function componentIdentity(component) {
  return [
    component.ecosystem,
    component.name,
    component.version,
    component.source,
  ].join("\u0000");
}

function compareComponents(left, right) {
  return compareText(componentIdentity(left), componentIdentity(right));
}

function uniqueSortedComponents(components) {
  const sorted = [...components].sort(compareComponents);
  const unique = [];
  for (const component of sorted) {
    const previous = unique.at(-1);
    if (!previous || componentIdentity(previous) !== componentIdentity(component)) {
      unique.push(component);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(component)) {
      throw new Error(
        `Conflicting metadata for ${component.ecosystem}:${component.name}@${component.version}`,
      );
    }
  }
  return unique;
}

function ecosystemSummary(components, ecosystem) {
  const selected = components.filter((component) => component.ecosystem === ecosystem);
  return {
    componentCount: selected.length,
    missingLicenseCount: selected.filter((component) => component.missingLicense).length,
  };
}

export function buildThirdPartyManifest({
  rootDir = process.cwd(),
  packageLockPath = resolve(rootDir, "package-lock.json"),
  cargoLockPath = resolve(rootDir, "src-tauri", "Cargo.lock"),
  cargoMetadata,
  cargoMetadataDescriptor = { mode: "provided" },
  includeNpmDev = false,
  cargoFilterPlatform = null,
}) {
  const resolvedRoot = resolve(rootDir);
  const resolvedPackageLock = resolve(packageLockPath);
  const resolvedCargoLock = resolve(cargoLockPath);
  const packageLock = readJson(resolvedPackageLock);
  const cargoLockContents = readFileSync(resolvedCargoLock, "utf8").replace(/^\uFEFF/, "");
  const cargoLock = parseCargoLock(cargoLockContents);
  const components = uniqueSortedComponents([
    ...cargoComponents(resolvedRoot, cargoMetadata, cargoLock),
    ...npmComponents(resolvedRoot, packageLock, includeNpmDev),
  ]);
  const missingLicenseCount = components.filter(
    (component) => component.missingLicense,
  ).length;

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generator: {
      id: GENERATOR_ID,
      deterministic: true,
    },
    inputs: {
      npmLock: {
        path: inputPath(resolvedRoot, resolvedPackageLock),
        sha256: sha256File(resolvedPackageLock),
        lockfileVersion: packageLock.lockfileVersion ?? null,
        includeDevelopment: includeNpmDev,
      },
      cargoLock: {
        path: inputPath(resolvedRoot, resolvedCargoLock),
        sha256: sha256File(resolvedCargoLock),
        lockfileVersion: cargoLock.version,
        filterPlatform: cargoFilterPlatform,
        metadata: cargoMetadataDescriptor,
      },
    },
    summary: {
      componentCount: components.length,
      missingLicenseCount,
      byEcosystem: {
        cargo: ecosystemSummary(components, "cargo"),
        npm: ecosystemSummary(components, "npm"),
      },
    },
    components,
  };
}

export function serializeThirdPartyManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function isWithinDirectory(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(relativePath)
  );
}

function classifyLicenseCandidate(sourceName, explicitLicense = false) {
  if (explicitLicense) return "license";
  const segments = portablePath(sourceName).split("/");
  const first = segments[0] ?? "";
  if (/^(?:notice|copyright)(?:$|[._-].*)/i.test(first)) return "notice";
  return "license";
}

function candidateSourceName(packageRoot, candidatePath) {
  const sourceName = portablePath(relative(packageRoot, candidatePath));
  if (
    sourceName === "" ||
    sourceName === ".." ||
    sourceName.startsWith("../") ||
    isAbsolute(sourceName)
  ) {
    return null;
  }
  return sourceName;
}

function collectDirectoryFiles(directory, relativePrefix, kind, results, depth = 0) {
  if (depth > 6) {
    results.rejected.push({
      sourceName: portablePath(relativePrefix),
      reason: "directory-depth-limit",
    });
    return;
  }
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const sourceName = portablePath(join(relativePrefix, entry.name));
    if (entry.isFile()) {
      results.candidates.push({ path, sourceName, kind });
    } else if (entry.isDirectory()) {
      collectDirectoryFiles(path, sourceName, kind, results, depth + 1);
    }
  }
}

function addExplicitCandidate(packageRoot, path, results) {
  const candidatePath = isAbsolute(path) ? resolve(path) : resolve(packageRoot, path);
  const sourceName = candidateSourceName(packageRoot, candidatePath);
  if (!sourceName) {
    results.rejected.push({
      sourceName: basename(candidatePath),
      reason: "outside-package-root",
    });
    return;
  }
  if (!existsSync(candidatePath)) {
    results.rejected.push({ sourceName, reason: "missing-explicit-license-file" });
    return;
  }
  const stat = statSync(candidatePath);
  if (!stat.isFile()) {
    results.rejected.push({ sourceName, reason: "explicit-license-is-not-file" });
    return;
  }
  results.candidates.push({
    path: candidatePath,
    sourceName,
    kind: "license",
  });
}

function npmExplicitLicenseFile(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const packageJson = readJson(packageJsonPath);
    const license = normalizeLicense(packageJson.license);
    const match = /^SEE LICENSE IN\s+(.+)$/i.exec(license ?? "");
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

function collectPackageLicenseCandidates(packageRoot, explicitFiles = []) {
  const results = {
    sourceAvailable: false,
    candidates: [],
    rejected: [],
  };
  if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) return results;
  results.sourceAvailable = true;

  const entries = readdirSync(packageRoot, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name),
  );
  for (const entry of entries) {
    if (!LICENSE_FILE_PATTERN.test(entry.name)) continue;
    const path = join(packageRoot, entry.name);
    if (entry.isFile()) {
      results.candidates.push({
        path,
        sourceName: entry.name,
        kind: classifyLicenseCandidate(entry.name),
      });
    } else if (entry.isDirectory() && LICENSE_DIRECTORY_PATTERN.test(entry.name)) {
      collectDirectoryFiles(
        path,
        entry.name,
        classifyLicenseCandidate(entry.name),
        results,
      );
    }
  }

  for (const explicitFile of explicitFiles.filter(Boolean)) {
    addExplicitCandidate(packageRoot, explicitFile, results);
  }
  return results;
}

function validatedLicenseText(candidate) {
  const bytes = readFileSync(candidate.path);
  if (bytes.length === 0) {
    return { rejected: { sourceName: candidate.sourceName, reason: "empty-file" } };
  }
  if (bytes.length > MAX_LICENSE_TEXT_BYTES) {
    return { rejected: { sourceName: candidate.sourceName, reason: "file-too-large" } };
  }
  if (bytes.includes(0)) {
    return { rejected: { sourceName: candidate.sourceName, reason: "binary-content" } };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (candidate.expectedSha256 && sha256 !== candidate.expectedSha256) {
    throw new Error(`License overlay changed after review: ${candidate.sourceName}`);
  }
  return {
    text: {
      bytes,
      sha256,
      sizeBytes: bytes.length,
      sourceName: portablePath(candidate.sourceName),
      kind: candidate.kind,
      provenanceUrl: candidate.provenanceUrl ?? null,
      vcsCommit: candidate.vcsCommit ?? null,
      vcsUrl: candidate.vcsUrl ?? null,
      sourceType: candidate.sourceType ?? null,
    },
  };
}

function addComponentSource(sourceMap, component, packageRoot, explicitFiles = []) {
  const key = componentIdentity(component);
  const sources = sourceMap.get(key) ?? [];
  sources.push({ packageRoot: resolve(packageRoot), explicitFiles });
  sourceMap.set(key, sources);
}

function matchingComponent(manifest, ecosystem, name, version, source) {
  return manifest.components.find(
    (component) =>
      component.ecosystem === ecosystem &&
      component.name === name &&
      component.version === version &&
      (!source || component.source === source),
  );
}

function reviewedOverlaySourceUrl(value, label, { sourceType, repository, vcsCommit, license }) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be an HTTPS URL without credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain a query or fragment`);
  }
  if (sourceType === "repository-revision") {
    let repositoryUrl;
    try {
      repositoryUrl = new URL(repository);
    } catch {
      throw new Error(`${label} component repository is invalid`);
    }
    const repositoryParts = repositoryUrl.pathname.replace(/(?:\.git)?\/$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
    const sourceParts = parsed.pathname.split("/").filter(Boolean);
    if (
      repositoryUrl.hostname.toLowerCase() !== "github.com" ||
      parsed.hostname.toLowerCase() !== "raw.githubusercontent.com" ||
      repositoryParts.length !== 2 ||
      sourceParts.length < 4 ||
      sourceParts[0].toLowerCase() !== repositoryParts[0].toLowerCase() ||
      sourceParts[1].toLowerCase() !== repositoryParts[1].toLowerCase() ||
      sourceParts[2].toLowerCase() !== vcsCommit.toLowerCase()
    ) {
      throw new Error(`${label} must use the reviewed repository commit`);
    }
    return value;
  }
  if (sourceType === "canonical-license") {
    const isMozillaMpl =
      license === "MPL-2.0" &&
      ["mozilla.org", "www.mozilla.org"].includes(parsed.hostname.toLowerCase()) &&
      /(?:^|[^a-f0-9])[a-f0-9]{12,64}(?:[^a-f0-9]|$)/i.test(parsed.pathname);
    if (!isMozillaMpl) {
      throw new Error(`${label} is not an approved canonical license source`);
    }
    return value;
  }
  throw new Error(`${label} has an unsupported source type`);
}

function immutableVcsUrl(value, label, repository, vcsCommit) {
  let parsed;
  let repositoryUrl;
  try {
    parsed = new URL(value);
    repositoryUrl = new URL(repository);
  } catch {
    throw new Error(`${label} and component repository must be valid URLs`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.search ||
    parsed.hash ||
    repositoryUrl.protocol !== "https:" ||
    parsed.origin.toLowerCase() !== repositoryUrl.origin.toLowerCase()
  ) {
    throw new Error(`${label} must use the component repository origin over HTTPS`);
  }
  const repositoryPath = repositoryUrl.pathname.replace(/(?:\.git)?\/$/, "").replace(/\.git$/, "");
  const expectedPath = `${repositoryPath}/commit/${vcsCommit}`.toLowerCase();
  if (parsed.pathname.replace(/\/$/, "").toLowerCase() !== expectedPath) {
    throw new Error(`${label} must identify the reviewed component repository commit`);
  }
  return value;
}

export function loadLicenseOverlayManifest({ rootDir, manifest, overlayManifestPath }) {
  if (!overlayManifestPath) {
    return { candidates: new Map(), descriptor: null };
  }
  const resolvedRoot = resolve(rootDir);
  const resolvedManifest = resolve(overlayManifestPath);
  if (!isWithinDirectory(resolvedRoot, resolvedManifest)) {
    throw new Error("License overlay manifest must be a child of the project root");
  }
  const overlay = readJson(resolvedManifest);
  if (overlay.schemaVersion !== 1 || !Array.isArray(overlay.entries) || overlay.entries.length === 0) {
    throw new Error("Unsupported license overlay manifest schema");
  }
  const candidates = new Map();
  const seenComponents = new Set();
  for (const entry of overlay.entries) {
    if (typeof entry.source !== "string" || entry.source === "" || entry.source.trim() !== entry.source) {
      throw new Error(`License overlay source is required for ${entry.name}@${entry.version}`);
    }
    const component = matchingComponent(
      manifest,
      entry.ecosystem,
      entry.name,
      entry.version,
      entry.source,
    );
    if (!component) {
      throw new Error(`License overlay has no matching component: ${entry.ecosystem}:${entry.name}@${entry.version}`);
    }
    const identity = componentIdentity(component);
    if (seenComponents.has(identity)) {
      throw new Error(`Duplicate license overlay component: ${entry.ecosystem}:${entry.name}@${entry.version}`);
    }
    seenComponents.add(identity);
    if (component.integrity !== entry.integrity) {
      throw new Error(`License overlay integrity does not match ${entry.name}@${entry.version}`);
    }
    if (component.license !== entry.license) {
      throw new Error(`License overlay expression does not match ${entry.name}@${entry.version}`);
    }
    if (!/^[a-f0-9]{40}$/.test(String(entry.vcsCommit ?? ""))) {
      throw new Error(`License overlay VCS commit is invalid for ${entry.name}@${entry.version}`);
    }
    if (typeof component.repository !== "string" || component.repository === "") {
      throw new Error(`License overlay component repository is missing for ${entry.name}@${entry.version}`);
    }
    const vcsUrl = immutableVcsUrl(
      entry.vcsUrl,
      `License overlay VCS URL for ${entry.name}@${entry.version}`,
      component.repository,
      entry.vcsCommit.toLowerCase(),
    );
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(`License overlay has no text files for ${entry.name}@${entry.version}`);
    }
    const componentCandidates = [];
    for (const file of entry.files) {
      if (typeof file.path !== "string" || isAbsolute(file.path)) {
        throw new Error(`License overlay path is invalid for ${entry.name}@${entry.version}`);
      }
      const path = resolve(resolvedRoot, file.path);
      if (!isWithinDirectory(resolvedRoot, path) || !existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`License overlay text is missing or outside the project: ${file.path}`);
      }
      const expectedSha256 = normalizedSha256(file.sha256, `License overlay hash for ${file.path}`);
      const actualSha256 = sha256File(path);
      if (actualSha256 !== expectedSha256) {
        throw new Error(`License overlay hash mismatch for ${file.path}`);
      }
      const kind = file.kind === "notice" ? "notice" : file.kind === "license" ? "license" : null;
      if (!kind) throw new Error(`License overlay kind is invalid for ${file.path}`);
      componentCandidates.push({
        path,
        sourceName: `overlay:${portablePath(file.path)}`,
        kind,
        expectedSha256,
        sourceType: file.sourceType,
        provenanceUrl: reviewedOverlaySourceUrl(
          file.sourceUrl,
          `License overlay source URL for ${file.path}`,
          {
            sourceType: file.sourceType,
            repository: component.repository,
            vcsCommit: entry.vcsCommit,
            license: entry.license,
          },
        ),
        vcsCommit: entry.vcsCommit.toLowerCase(),
        vcsUrl,
      });
    }
    candidates.set(identity, componentCandidates);
  }
  return {
    candidates,
    descriptor: {
      path: inputPath(resolvedRoot, resolvedManifest),
      bundlePath: "LICENSE-OVERLAYS.json",
      sizeBytes: statSync(resolvedManifest).size,
      sha256: sha256File(resolvedManifest),
      entryCount: overlay.entries.length,
    },
  };
}

function componentSourceMap({
  rootDir,
  manifest,
  packageLock,
  cargoMetadata,
  includeNpmDev,
}) {
  const sourceMap = new Map();
  const workspaceIds = new Set(cargoMetadata.workspace_members ?? []);
  const resolvedIds = cargoMetadata.resolve?.nodes
    ? new Set(cargoMetadata.resolve.nodes.map((node) => node.id))
    : null;

  for (const metadata of cargoMetadata.packages ?? []) {
    if (workspaceIds.has(metadata.id)) continue;
    if (resolvedIds && !resolvedIds.has(metadata.id)) continue;
    const name = normalizeOptionalText(metadata.name);
    const version = normalizeOptionalText(metadata.version);
    const manifestPath = normalizeOptionalText(metadata.manifest_path);
    if (!name || !version || !manifestPath) continue;
    const source = portablePath(
      normalizeOptionalText(metadata.source) ??
        cargoLocalSource(rootDir, metadata) ??
        `cargo:${name}@${version}`,
    );
    const component = matchingComponent(manifest, "cargo", name, version, source);
    if (!component) continue;
    addComponentSource(
      sourceMap,
      component,
      dirname(manifestPath),
      [normalizeOptionalText(metadata.license_file)],
    );
  }

  for (const [installPath, metadata] of Object.entries(packageLock.packages ?? {})) {
    if (installPath === "" || !metadata || typeof metadata !== "object") continue;
    if (!includeNpmDev && metadata.dev === true) continue;
    const name = normalizeOptionalText(metadata.name) ?? npmNameFromInstallPath(installPath);
    const version = normalizeOptionalText(metadata.version);
    if (!name || !version) continue;
    const source = normalizeNpmSource(rootDir, metadata.resolved, name, version);
    const component = matchingComponent(manifest, "npm", name, version, source);
    if (!component) continue;
    const packageRoot = resolve(rootDir, installPath);
    addComponentSource(
      sourceMap,
      component,
      packageRoot,
      [npmExplicitLicenseFile(packageRoot)],
    );
  }
  return sourceMap;
}

function uniqueRejectedFiles(rejected) {
  const values = new Map();
  for (const item of rejected) {
    values.set(`${item.sourceName}\u0000${item.reason}`, item);
  }
  return [...values.values()].sort((left, right) =>
    compareText(
      `${left.sourceName}\u0000${left.reason}`,
      `${right.sourceName}\u0000${right.reason}`,
    ),
  );
}

export function buildLicenseTextBundle({
  rootDir = process.cwd(),
  manifest,
  packageLockPath = resolve(rootDir, "package-lock.json"),
  cargoMetadata,
  includeNpmDev = false,
  licenseOverlayCandidates = new Map(),
  licenseOverlayDescriptor = null,
}) {
  const resolvedRoot = resolve(rootDir);
  const packageLock = readJson(resolve(packageLockPath));
  const sourceMap = componentSourceMap({
    rootDir: resolvedRoot,
    manifest,
    packageLock,
    cargoMetadata,
    includeNpmDev,
  });
  const textContents = new Map();
  const componentMappings = [];

  for (const component of manifest.components) {
    const perComponent = new Map();
    const rejected = [];
    let sourceAvailable = false;
    let overlayApplied = false;
    const collections = [];
    for (const source of sourceMap.get(componentIdentity(component)) ?? []) {
      const collection = collectPackageLicenseCandidates(
        source.packageRoot,
        source.explicitFiles,
      );
      sourceAvailable ||= collection.sourceAvailable;
      collections.push(collection);
    }
    const overlayCandidates = licenseOverlayCandidates.get(componentIdentity(component)) ?? [];
    if (overlayCandidates.length > 0) {
      overlayApplied = true;
      collections.push({ candidates: overlayCandidates, rejected: [] });
    }
    for (const collection of collections) {
      rejected.push(...collection.rejected);
      const seenCandidatePaths = new Set();
      for (const candidate of collection.candidates) {
        const candidateKey = resolve(candidate.path).toLowerCase();
        if (seenCandidatePaths.has(candidateKey)) continue;
        seenCandidatePaths.add(candidateKey);
        const validated = validatedLicenseText(candidate);
        if (validated.rejected) {
          rejected.push(validated.rejected);
          continue;
        }
        const text = validated.text;
        textContents.set(text.sha256, text.bytes);
        const mapping = perComponent.get(text.sha256) ?? {
          sha256: text.sha256,
          path: `texts/${text.sha256}.txt`,
          sizeBytes: text.sizeBytes,
          kinds: new Set(),
          sourceNames: new Set(),
          provenanceUrls: new Set(),
          vcsCommits: new Set(),
          vcsUrls: new Set(),
          sourceTypes: new Set(),
        };
        mapping.kinds.add(text.kind);
        mapping.sourceNames.add(text.sourceName);
        if (text.provenanceUrl) mapping.provenanceUrls.add(text.provenanceUrl);
        if (text.vcsCommit) mapping.vcsCommits.add(text.vcsCommit);
        if (text.vcsUrl) mapping.vcsUrls.add(text.vcsUrl);
        if (text.sourceType) mapping.sourceTypes.add(text.sourceType);
        perComponent.set(text.sha256, mapping);
      }
    }
    const licenseTexts = [...perComponent.values()]
      .map((mapping) => ({
        sha256: mapping.sha256,
        path: mapping.path,
        sizeBytes: mapping.sizeBytes,
        kinds: [...mapping.kinds].sort(compareText),
        sourceNames: [...mapping.sourceNames].sort(compareText),
        provenanceUrls: [...mapping.provenanceUrls].sort(compareText),
        vcsCommits: [...mapping.vcsCommits].sort(compareText),
        vcsUrls: [...mapping.vcsUrls].sort(compareText),
        sourceTypes: [...mapping.sourceTypes].sort(compareText),
      }))
      .sort((left, right) => compareText(left.sha256, right.sha256));
    const hasLicenseText = licenseTexts.some((text) => text.kinds.includes("license"));
    componentMappings.push({
      ecosystem: component.ecosystem,
      name: component.name,
      version: component.version,
      source: component.source,
      license: component.license,
      licenseFile: component.licenseFile,
      missingLicense: component.missingLicense,
      sourceAvailable,
      overlayApplied,
      missingLicenseText: !hasLicenseText,
      licenseMetadataWithoutText: !component.missingLicense && !hasLicenseText,
      licenseTexts,
      rejectedLicenseFiles: uniqueRejectedFiles(rejected),
    });
  }

  const texts = [...textContents.entries()]
    .map(([sha256, bytes]) => ({
      sha256,
      path: `texts/${sha256}.txt`,
      sizeBytes: bytes.length,
    }))
    .sort((left, right) => compareText(left.sha256, right.sha256));
  const missingLicenseTextCount = componentMappings.filter(
    (component) => component.missingLicenseText,
  ).length;
  const licenseMetadataWithoutTextCount = componentMappings.filter(
    (component) => component.licenseMetadataWithoutText,
  ).length;
  const missingLicenseMetadataWithTextCount = componentMappings.filter(
    (component) =>
      component.missingLicense &&
      component.licenseTexts.some((text) => text.kinds.includes("license")),
  ).length;

  return {
    manifest: {
      schemaVersion: LICENSE_TEXT_SCHEMA_VERSION,
      generator: {
        id: GENERATOR_ID,
        deterministic: true,
      },
      sourceManifest: {
        sha256: createHash("sha256")
          .update(serializeThirdPartyManifest(manifest))
          .digest("hex"),
      },
      licenseOverlayManifest: licenseOverlayDescriptor,
      summary: {
        componentCount: componentMappings.length,
        componentsWithLicenseTextCount:
          componentMappings.length - missingLicenseTextCount,
        missingLicenseTextCount,
        licenseMetadataWithoutTextCount,
        missingLicenseMetadataWithTextCount,
        uniqueLicenseTextCount: texts.length,
      },
      components: componentMappings,
      texts,
    },
    textContents,
  };
}

export function serializeLicenseTextManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function writeLicenseTextBundle({
  rootDir,
  outputDir,
  bundle,
  overlayManifestPath = null,
}) {
  const resolvedRoot = resolve(rootDir);
  const resolvedOutput = resolve(outputDir);
  if (!isWithinDirectory(resolvedRoot, resolvedOutput)) {
    throw new Error("License output directory must be a child of the project root");
  }
  let overlayBytes = null;
  const overlayDescriptor = bundle.manifest.licenseOverlayManifest;
  if (overlayDescriptor) {
    if (!overlayManifestPath) {
      throw new Error("License overlay descriptor requires its source manifest");
    }
    const resolvedOverlay = resolve(overlayManifestPath);
    if (!isWithinDirectory(resolvedRoot, resolvedOverlay)) {
      throw new Error("License overlay manifest moved outside the project before bundle write");
    }
    overlayBytes = readFileSync(resolvedOverlay);
    const overlaySha256 = createHash("sha256").update(overlayBytes).digest("hex");
    if (
      overlaySha256 !== overlayDescriptor.sha256 ||
      overlayBytes.length !== overlayDescriptor.sizeBytes
    ) {
      throw new Error("License overlay manifest changed before bundle write");
    }
  }
  if (existsSync(resolvedOutput)) {
    rmSync(resolvedOutput, { recursive: true, force: true });
  }
  mkdirSync(join(resolvedOutput, "texts"), { recursive: true });
  for (const text of bundle.manifest.texts) {
    const bytes = bundle.textContents.get(text.sha256);
    if (!bytes) throw new Error(`Missing collected bytes for ${text.sha256}`);
    writeFileSync(join(resolvedOutput, text.path), bytes);
  }
  writeFileSync(
    join(resolvedOutput, "LICENSE-TEXTS.json"),
    serializeLicenseTextManifest(bundle.manifest),
    "utf8",
  );
  if (overlayDescriptor) {
    writeFileSync(
      join(resolvedOutput, overlayDescriptor.bundlePath),
      overlayBytes,
    );
  }
  return bundle.manifest;
}

function consumeValue(argumentsList, index, option) {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseArguments(argumentsList) {
  const options = {
    rootDir: process.cwd(),
    packageLockPath: null,
    cargoLockPath: null,
    cargoManifestPath: null,
    cargoMetadataPath: null,
    cargoFilterPlatform: null,
    includeNpmDev: false,
    failOnMissingLicense: false,
    licensesOutputDir: null,
    licenseOverlayManifestPath: null,
    failOnMissingLicenseText: false,
    outputPath: null,
    help: false,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    switch (argument) {
      case "--root":
        options.rootDir = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--package-lock":
        options.packageLockPath = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--cargo-lock":
        options.cargoLockPath = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--cargo-manifest":
        options.cargoManifestPath = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--cargo-metadata-file":
        options.cargoMetadataPath = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--cargo-filter-platform":
        options.cargoFilterPlatform = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--include-npm-dev":
        options.includeNpmDev = true;
        break;
      case "--fail-on-missing-license":
        options.failOnMissingLicense = true;
        break;
      case "--licenses-output-dir":
        options.licensesOutputDir = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--license-overlay-manifest":
        options.licenseOverlayManifestPath = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--fail-on-missing-license-text":
        options.failOnMissingLicenseText = true;
        break;
      case "--output":
        options.outputPath = consumeValue(argumentsList, index, argument);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option '${argument}'`);
    }
  }
  return options;
}

function resolveFromRoot(rootDir, path, fallback) {
  const candidate = path ?? fallback;
  return isAbsolute(candidate) ? candidate : resolve(rootDir, candidate);
}

function loadCargoMetadata({
  rootDir,
  cargoManifestPath,
  cargoMetadataPath,
  cargoFilterPlatform,
}) {
  if (cargoMetadataPath) {
    const metadataPath = resolveFromRoot(rootDir, cargoMetadataPath, cargoMetadataPath);
    return {
      value: readJson(metadataPath),
      descriptor: {
        mode: "file",
        path: inputPath(rootDir, metadataPath),
        sha256: sha256File(metadataPath),
      },
    };
  }

  const cargoArguments = [
    "metadata",
    "--format-version",
    "1",
    "--locked",
    "--manifest-path",
    cargoManifestPath,
  ];
  if (cargoFilterPlatform) {
    cargoArguments.push("--filter-platform", cargoFilterPlatform);
  }
  const result = spawnSync(process.env.CARGO || "cargo", cargoArguments, {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Failed to start cargo metadata: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown cargo error").trim();
    throw new Error(`cargo metadata failed (${result.status}): ${detail}`);
  }
  return {
    value: JSON.parse(result.stdout),
    descriptor: {
      mode: "cargo-metadata",
      command: [
        "cargo",
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--manifest-path",
        inputPath(rootDir, cargoManifestPath),
        ...(cargoFilterPlatform
          ? ["--filter-platform", cargoFilterPlatform]
          : []),
      ],
    },
  };
}

export function runCli(argumentsList, streams = process) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    streams.stdout.write(HELP);
    return 0;
  }
  if (options.failOnMissingLicenseText && !options.licensesOutputDir) {
    throw new Error(
      "--fail-on-missing-license-text requires --licenses-output-dir",
    );
  }
  if (options.licenseOverlayManifestPath && !options.licensesOutputDir) {
    throw new Error("--license-overlay-manifest requires --licenses-output-dir");
  }

  const rootDir = resolve(options.rootDir);
  const packageLockPath = resolveFromRoot(
    rootDir,
    options.packageLockPath,
    "package-lock.json",
  );
  const cargoLockPath = resolveFromRoot(
    rootDir,
    options.cargoLockPath,
    "src-tauri/Cargo.lock",
  );
  const cargoManifestPath = resolveFromRoot(
    rootDir,
    options.cargoManifestPath,
    "src-tauri/Cargo.toml",
  );
  const cargoMetadata = loadCargoMetadata({
    rootDir,
    cargoManifestPath,
    cargoMetadataPath: options.cargoMetadataPath,
    cargoFilterPlatform: options.cargoFilterPlatform,
  });
  const manifest = buildThirdPartyManifest({
    rootDir,
    packageLockPath,
    cargoLockPath,
    cargoMetadata: cargoMetadata.value,
    cargoMetadataDescriptor: cargoMetadata.descriptor,
    includeNpmDev: options.includeNpmDev,
    cargoFilterPlatform: options.cargoFilterPlatform,
  });
  const serialized = serializeThirdPartyManifest(manifest);
  let licenseTextManifest = null;
  const resolvedLicenseOverlayManifestPath = options.licenseOverlayManifestPath
    ? resolveFromRoot(rootDir, options.licenseOverlayManifestPath, options.licenseOverlayManifestPath)
    : null;
  const licenseOverlay = loadLicenseOverlayManifest({
    rootDir,
    manifest,
    overlayManifestPath: resolvedLicenseOverlayManifestPath,
  });

  if (options.outputPath) {
    const outputPath = resolveFromRoot(rootDir, options.outputPath, options.outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, "utf8");
  } else {
    streams.stdout.write(serialized);
  }

  if (options.licensesOutputDir) {
    const bundle = buildLicenseTextBundle({
      rootDir,
      manifest,
      packageLockPath,
      cargoMetadata: cargoMetadata.value,
      includeNpmDev: options.includeNpmDev,
      licenseOverlayCandidates: licenseOverlay.candidates,
      licenseOverlayDescriptor: licenseOverlay.descriptor,
    });
    const licensesOutputDir = resolveFromRoot(
      rootDir,
      options.licensesOutputDir,
      options.licensesOutputDir,
    );
    licenseTextManifest = writeLicenseTextBundle({
      rootDir,
      outputDir: licensesOutputDir,
      bundle,
      overlayManifestPath: resolvedLicenseOverlayManifestPath,
    });
  }

  if (options.failOnMissingLicense && manifest.summary.missingLicenseCount > 0) {
    streams.stderr.write(
      `Third-party manifest has ${manifest.summary.missingLicenseCount} component(s) without license metadata.\n`,
    );
    return 2;
  }
  if (
    options.failOnMissingLicenseText &&
    licenseTextManifest.summary.missingLicenseTextCount > 0
  ) {
    streams.stderr.write(
      `Third-party license bundle has ${licenseTextManifest.summary.missingLicenseTextCount} component(s) without collected license text.\n`,
    );
    return 3;
  }
  return 0;
}

function isMainModule() {
  return Boolean(
    process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url,
  );
}

if (isMainModule()) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
