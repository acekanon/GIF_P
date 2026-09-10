import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = resolve(dirname(scriptPath), "..");
const defaultManifestPath = resolve(defaultWorkspaceRoot, "bench", "corpus-manifest.json");

const HELP = `GIFP canonical fixture identity audit/proposal tool

Usage:
  node scripts/audit-canonical-fixture-identity.mjs [--manifest PATH]
    [--ffmpeg PATH] [--ffprobe PATH] [--output PROPOSAL.json]
    [--require-complete]

The tool is read-only with respect to the corpus manifest. It reports observed
fixture/tool hashes and emits a review proposal; it never applies that proposal.
`;

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshot(path) {
  if (!path || !existsSync(path)) return { path: path ?? null, sha256: null, size_bytes: null };
  const bytes = readFileSync(path);
  return {
    path: realpathSync(path),
    sha256: sha256Bytes(bytes),
    size_bytes: bytes.length,
  };
}

function safeWorkspacePath(workspaceRoot, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty workspace-relative path`);
  }
  const parts = relativePath.split(/[\\/]+/u);
  if (parts.includes("..")) throw new Error(`${label} may not contain parent traversal`);
  const path = resolve(workspaceRoot, relativePath);
  const fromRoot = relative(workspaceRoot, path);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the workspace root`);
  }
  return path;
}

function resolveToolPath(explicitPath, directory, executable) {
  if (explicitPath) return resolve(explicitPath);
  if (!directory) return null;
  const direct = resolve(directory, executable);
  if (existsSync(direct)) return direct;
  return resolve(directory, "bin", executable);
}

export function auditCanonicalFixtureIdentity({
  manifestPath = defaultManifestPath,
  workspaceRoot = defaultWorkspaceRoot,
  ffmpegPath = null,
  ffprobePath = null,
  ffmpegDirectory = process.env.GIFP_FFMPEG_DIR ?? null,
} = {}) {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const absoluteManifestPath = resolve(manifestPath);
  const manifestBytes = readFileSync(absoluteManifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const identity = manifest.canonical_fixture_identity;
  if (!identity || identity.contract_id !== "gifp.canonical_fixture_identity.v1") {
    throw new Error("Manifest has no supported canonical fixture identity contract");
  }
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    throw new Error("Manifest has no fixtures");
  }

  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const ffmpeg = snapshot(resolveToolPath(ffmpegPath, ffmpegDirectory, `ffmpeg${executableSuffix}`));
  const ffprobe = snapshot(resolveToolPath(ffprobePath, ffmpegDirectory, `ffprobe${executableSuffix}`));
  const reviewedRuntimeManifestPath = safeWorkspacePath(
    absoluteWorkspaceRoot,
    identity.reviewed_runtime_manifest_path,
    "reviewed_runtime_manifest_path",
  );
  const reviewedRuntimeManifest = snapshot(reviewedRuntimeManifestPath);
  const generatorMatchesReviewedIdentity = ffmpeg.sha256 === identity.generator_ffmpeg_sha256
    && ffprobe.sha256 === identity.generator_ffprobe_sha256
    && reviewedRuntimeManifest.sha256 === identity.reviewed_runtime_manifest_sha256;

  const fixtureRoot = resolve(dirname(absoluteManifestPath), manifest.fixture_root);
  const fixtures = manifest.fixtures.map((fixture) => {
    const observed = snapshot(resolve(fixtureRoot, fixture.file));
    const expected = fixture.expected_source_sha256 ?? null;
    const currentMatches = expected !== null && observed.sha256 === expected;
    return {
      fixture_id: fixture.id,
      category: fixture.category,
      path: observed.path ?? resolve(fixtureRoot, fixture.file),
      expected_source_sha256: expected,
      observed_source_sha256: observed.sha256,
      size_bytes: observed.size_bytes,
      current_matches: currentMatches,
      proposal_eligible: generatorMatchesReviewedIdentity && observed.sha256 !== null,
      proposed_expected_source_sha256:
        generatorMatchesReviewedIdentity && observed.sha256 !== null ? observed.sha256 : null,
    };
  });
  const allFixturesObserved = fixtures.every((fixture) => fixture.observed_source_sha256 !== null);
  const allCurrentFixtureIdentitiesPass = fixtures.every((fixture) => fixture.current_matches);
  const currentComplete = identity.status === "complete"
    && generatorMatchesReviewedIdentity
    && allCurrentFixtureIdentitiesPass;
  const proposalComplete = generatorMatchesReviewedIdentity && allFixturesObserved;

  return {
    contract_id: "gifp.canonical_fixture_identity.audit.v1",
    manifest: {
      path: absoluteManifestPath,
      sha256: sha256Bytes(manifestBytes),
      corpus_id: manifest.corpus_id,
      fixture_count: manifest.fixtures.length,
    },
    reviewed_identity: identity,
    observed_generator: {
      ffmpeg,
      ffprobe,
      reviewed_runtime_manifest: reviewedRuntimeManifest,
      matches_reviewed_identity: generatorMatchesReviewedIdentity,
    },
    fixtures,
    current_complete: currentComplete,
    proposal_complete: proposalComplete,
    requires_manual_review: true,
    proposal_application_preconditions: {
      independent_generation_runs_required: 2,
      independent_generation_outputs_must_match: true,
      tool_identity_must_match: true,
      automatically_satisfied_by_this_tool: false,
    },
    proposal: {
      canonical_fixture_identity: {
        ...identity,
        status: proposalComplete ? "complete" : "incomplete",
      },
      fixtures: fixtures.map((fixture) => ({
        id: fixture.fixture_id,
        expected_source_sha256: fixture.proposed_expected_source_sha256,
      })),
    },
    notes: [
      "Observed hashes are a proposal only; this tool never changes the manifest.",
      "Do not apply proposed hashes until two independent generated source trees match fixture-for-fixture.",
      "Review generator provenance and all 28 outputs before applying any proposed hash.",
      ...(generatorMatchesReviewedIdentity
        ? []
        : ["Fixture hashes are not proposal-eligible because generator/runtime identity is missing or mismatched."]),
    ],
  };
}

function parseArgs(args) {
  const options = {
    manifestPath: defaultManifestPath,
    ffmpegPath: null,
    ffprobePath: null,
    outputPath: null,
    requireComplete: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return null;
    if (argument === "--require-complete") {
      options.requireComplete = true;
      continue;
    }
    const field = new Map([
      ["--manifest", "manifestPath"],
      ["--ffmpeg", "ffmpegPath"],
      ["--ffprobe", "ffprobePath"],
      ["--output", "outputPath"],
    ]).get(argument);
    if (!field) throw new Error(`Unknown option '${argument}'`);
    const value = args[index + 1];
    if (!value) throw new Error(`${argument} requires a path`);
    options[field] = value;
    index += 1;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(HELP);
    return;
  }
  const audit = auditCanonicalFixtureIdentity(options);
  const output = `${JSON.stringify(audit, null, 2)}\n`;
  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    if (outputPath === resolve(options.manifestPath)) {
      throw new Error("Refusing to overwrite the corpus manifest; choose a separate proposal path");
    }
    writeFileSync(outputPath, output, { flag: "wx" });
    process.stdout.write(`Wrote review proposal: ${outputPath}\n`);
  } else {
    process.stdout.write(output);
  }
  if (options.requireComplete && !audit.current_complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Canonical fixture identity audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
