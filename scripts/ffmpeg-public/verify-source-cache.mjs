import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export class SourceCacheError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceCacheError";
  }
}

function requireValue(condition, message) {
  if (!condition) throw new SourceCacheError(message);
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SourceCacheError(`${label} is not valid JSON: ${error.message}`);
  }
}

export function validateSourceLock(lock) {
  requireValue(lock?.schemaVersion === 1, "Unsupported FFmpeg source-lock schema");
  requireValue(lock?.profile === "gifp-windows-x64-lgpl-shared", "Unexpected FFmpeg source-lock profile");
  requireValue(lock?.target === "x86_64-w64-mingw32", "Unexpected FFmpeg source-lock target");
  requireValue(
    /^ghcr\.io\/btbn\/ffmpeg-builds\/base-win64@sha256:[a-f0-9]{64}$/.test(lock?.builder?.image ?? ""),
    "Builder image must be pinned by a full GHCR manifest digest",
  );
  requireValue(
    lock.builder.image.endsWith(lock.builder.manifestDigest),
    "Builder image and manifest digest disagree",
  );
  requireValue(
    /^sha256:[a-f0-9]{64}$/.test(lock?.builder?.configDigest ?? ""),
    "Builder config digest must be a full SHA-256 image ID",
  );
  requireValue(lock.builder.networkPolicy === "release-build-must-run-with-network-none", "Offline build policy is missing");
  requireValue(Array.isArray(lock.sources) && lock.sources.length > 0, "Source-lock inventory is empty");

  const ids = new Set();
  const files = new Set();
  const sourcesById = new Map();
  for (const source of lock.sources) {
    requireValue(typeof source.id === "string" && /^[a-z0-9-]+$/.test(source.id), "Source id is invalid");
    requireValue(!ids.has(source.id), `Duplicate source id: ${source.id}`);
    ids.add(source.id);
    sourcesById.set(source.id, source);
    requireValue(/^[a-f0-9]{40}$/.test(source.commit), `Source commit is not a full SHA-1: ${source.id}`);
    requireValue(
      typeof source.archiveUrl === "string" && source.archiveUrl.startsWith("https://") && !/\blatest\b/i.test(source.archiveUrl),
      `Source URL is not fixed HTTPS: ${source.id}`,
    );
    requireValue(
      typeof source.archiveFile === "string" && basename(source.archiveFile) === source.archiveFile,
      `Source archive filename is unsafe: ${source.id}`,
    );
    requireValue(!files.has(source.archiveFile.toLowerCase()), `Duplicate source archive filename: ${source.archiveFile}`);
    files.add(source.archiveFile.toLowerCase());
    requireValue(
      typeof source.archiveRoot === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(source.archiveRoot) &&
        source.archiveRoot !== "." &&
        source.archiveRoot !== "..",
      `Source archive root is unsafe: ${source.id}`,
    );
    requireValue(Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > 0, `Source size is invalid: ${source.id}`);
    requireValue(/^[a-f0-9]{64}$/.test(source.sha256), `Source SHA-256 is invalid: ${source.id}`);
    requireValue(Array.isArray(source.licenseFiles) && source.licenseFiles.length > 0, `Source license inventory is empty: ${source.id}`);
    for (const license of source.licenseFiles) {
      requireValue(
        typeof license === "string" &&
          license !== "" &&
          !license.startsWith("/") &&
          !license.includes("\\") &&
          license.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
        `Source license path is unsafe: ${source.id}`,
      );
    }
  }
  for (const source of lock.sources) {
    if (source.submodule === undefined) continue;
    const submodule = source.submodule;
    requireValue(
      submodule && typeof submodule === "object" && !Array.isArray(submodule),
      `Locked submodule metadata is invalid: ${source.id}`,
    );
    requireValue(
      typeof submodule.parentSourceId === "string" && /^[a-z0-9-]+$/.test(submodule.parentSourceId),
      `Locked submodule parent id is invalid: ${source.id}`,
    );
    requireValue(submodule.parentSourceId !== source.id, `Locked submodule cannot be its own parent: ${source.id}`);
    requireValue(
      /^[a-f0-9]{40}$/.test(submodule.parentCommit ?? ""),
      `Locked submodule parent commit is invalid: ${source.id}`,
    );
    requireValue(
      /^[a-f0-9]{40}$/.test(submodule.gitlinkCommit ?? ""),
      `Locked submodule gitlink commit is invalid: ${source.id}`,
    );
    requireValue(
      typeof submodule.path === "string" &&
        submodule.path !== "" &&
        !submodule.path.startsWith("/") &&
        !submodule.path.includes("\\") &&
        submodule.path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      `Locked submodule path is unsafe: ${source.id}`,
    );
    requireValue(source.commit === submodule.gitlinkCommit, `Locked submodule commit is mismatched: ${source.id}`);
    const parent = sourcesById.get(submodule.parentSourceId);
    requireValue(parent, `Locked submodule parent source is missing: ${source.id}`);
    requireValue(
      parent.commit === submodule.parentCommit,
      `Locked submodule parent commit is mismatched: ${source.id}`,
    );
  }
  return lock;
}

function listArchive(path) {
  const result = spawnSync("tar", ["-tf", path], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  requireValue(result.status === 0, `Unable to list source archive ${basename(path)}: ${result.stderr || result.error?.message || "unknown error"}`);
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\/$/, "")));
}

export function verifySourceCache(lockPath, cachePath) {
  const lock = validateSourceLock(readJson(resolve(lockPath), "FFmpeg source lock"));
  const cache = resolve(cachePath);
  requireValue(existsSync(cache) && statSync(cache).isDirectory(), `FFmpeg source cache does not exist: ${cache}`);
  const sources = [];
  for (const source of lock.sources) {
    const path = resolve(cache, source.archiveFile);
    requireValue(existsSync(path) && statSync(path).isFile(), `Locked source archive is missing: ${source.archiveFile}`);
    const sizeBytes = statSync(path).size;
    requireValue(sizeBytes === source.sizeBytes, `Source size mismatch for ${source.archiveFile}: expected ${source.sizeBytes}, got ${sizeBytes}`);
    const sha256 = sha256File(path);
    requireValue(sha256 === source.sha256, `Source SHA-256 mismatch for ${source.archiveFile}: expected ${source.sha256}, got ${sha256}`);
    const entries = listArchive(path);
    requireValue(entries.has(source.archiveRoot), `Source archive root is missing for ${source.id}: ${source.archiveRoot}`);
    for (const license of source.licenseFiles) {
      requireValue(
        entries.has(`${source.archiveRoot}/${license}`),
        `Locked license file is missing from ${source.archiveFile}: ${license}`,
      );
    }
    const facts = {
      id: source.id,
      role: source.role,
      archiveFile: source.archiveFile,
      sizeBytes,
      sha256,
      commit: source.commit,
      licenseExpression: source.licenseExpression,
      licenseFiles: source.licenseFiles,
    };
    if (source.submodule !== undefined) facts.submodule = source.submodule;
    sources.push(facts);
  }
  return {
    schemaVersion: 1,
    profile: lock.profile,
    target: lock.target,
    builderImage: lock.builder.image,
    builderImageId: lock.builder.configDigest,
    sourceCount: sources.length,
    sources,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new SourceCacheError(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new SourceCacheError(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const facts = verifySourceCache(options.lock, options.cache);
    const json = `${JSON.stringify(facts, null, 2)}\n`;
    if (options.output) writeFileSync(resolve(options.output), json, "utf8");
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error.name ?? "Error"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
