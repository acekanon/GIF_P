import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;
const POLICY_SET_VERSION = "2026.07.27";
const DEFAULT_MAX_AGE_DAYS = 180;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const POLICIES = Object.freeze({
  qq_chat: { revision: "1", formats: ["gif"], maxWidth: 560, maxFps: 18, maxSizeBytes: 1.9 * 1024 * 1024 },
  wechat_chat: { revision: "1", formats: ["gif"], maxWidth: 420, maxFps: 15, maxSizeBytes: 1.9 * 1024 * 1024 },
  wechat_sticker: { revision: "1", formats: ["gif"], maxWidth: 240, maxFps: 12, maxDurationSeconds: 3, maxSizeBytes: 0.48 * 1024 * 1024, aspect: 1 },
  feishu_chat: { revision: "1", formats: ["gif"], maxWidth: 560, maxFps: 18 },
  xiaohongshu_live: { revision: "1", formats: ["live_photo"], maxWidth: 1080, maxFps: 30, maxDurationSeconds: 3, aspect: 3 / 4 },
  douyin_live: { revision: "1", formats: ["live_photo"], maxWidth: 1080, maxFps: 30, maxDurationSeconds: 3, aspect: 9 / 16 },
  web_animation: { revision: "1", formats: ["webp", "gif"], maxWidth: 960, maxFps: 24 },
  web_transparent_ui: { revision: "1", formats: ["apng", "webp"], maxWidth: 960, maxFps: 30 },
});
const FORMATS = new Set(["gif", "webp", "apng", "mp4", "live_photo"]);
const PLATFORMS = new Set(["windows", "macos", "ios", "android", "web"]);
const LIFECYCLE = ["send", "receiverPlayback", "forward", "download", "reopen"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function add(errors, code, path, message) {
  errors.push({ code, path, message });
}

function closedObject(value, allowed, required, path, errors) {
  if (!isObject(value)) {
    add(errors, "type", path, "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) add(errors, "unknown_field", `${path}.${key}`, "field is not allowed");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) add(errors, "missing_field", `${path}.${key}`, "field is required");
  }
  return true;
}

function nonEmptyString(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    add(errors, "invalid_string", path, "must be a non-empty string");
    return false;
  }
  return true;
}

function positiveNumber(value, path, errors, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    add(errors, integer ? "invalid_positive_integer" : "invalid_positive_number", path, "must be a positive finite number");
  }
}

function validateClient(client, path, errors) {
  const keys = ["name", "version", "platform", "osVersion"];
  if (!closedObject(client, keys, keys, path, errors)) return;
  nonEmptyString(client.name, `${path}.name`, errors);
  nonEmptyString(client.version, `${path}.version`, errors);
  nonEmptyString(client.osVersion, `${path}.osVersion`, errors);
  if (!PLATFORMS.has(client.platform)) add(errors, "invalid_platform", `${path}.platform`, "platform is not supported");
}

function validateOutput(output, policy, path, errors) {
  const keys = ["format", "width", "height", "fps", "durationSeconds", "sizeBytes"];
  if (!closedObject(output, keys, keys, path, errors)) return;
  if (!FORMATS.has(output.format)) add(errors, "invalid_format", `${path}.format`, "format is not supported");
  positiveNumber(output.width, `${path}.width`, errors, true);
  positiveNumber(output.height, `${path}.height`, errors, true);
  positiveNumber(output.fps, `${path}.fps`, errors);
  positiveNumber(output.durationSeconds, `${path}.durationSeconds`, errors);
  positiveNumber(output.sizeBytes, `${path}.sizeBytes`, errors, true);
  if (!policy || !isObject(output)) return;
  if (!policy.formats.includes(output.format)) add(errors, "format_outside_policy", `${path}.format`, "format is not accepted by this policy");
  if (typeof output.width === "number" && output.width > policy.maxWidth) add(errors, "width_exceeds_policy", `${path}.width`, "width exceeds the tested policy envelope");
  if (typeof output.fps === "number" && output.fps > policy.maxFps) add(errors, "fps_exceeds_policy", `${path}.fps`, "fps exceeds the tested policy envelope");
  if (policy.maxDurationSeconds !== undefined && typeof output.durationSeconds === "number" && output.durationSeconds > policy.maxDurationSeconds) {
    add(errors, "duration_exceeds_policy", `${path}.durationSeconds`, "duration exceeds the tested policy envelope");
  }
  if (policy.maxSizeBytes !== undefined && typeof output.sizeBytes === "number" && output.sizeBytes > policy.maxSizeBytes) {
    add(errors, "size_exceeds_policy", `${path}.sizeBytes`, "size exceeds the tested policy envelope");
  }
  if (policy.aspect !== undefined && output.width > 0 && output.height > 0) {
    const ratio = output.width / output.height;
    if (Math.abs(ratio - policy.aspect) / policy.aspect > 0.01) {
      add(errors, "aspect_outside_policy", path, "aspect ratio exceeds the tested policy envelope");
    }
  }
}

function validateLifecycle(lifecycle, path, errors) {
  if (!closedObject(lifecycle, LIFECYCLE, LIFECYCLE, path, errors)) return;
  for (const step of LIFECYCLE) {
    if (lifecycle[step] !== true) add(errors, "lifecycle_incomplete", `${path}.${step}`, "must be true");
  }
}

function strictInstant(value, path, nowMs, errors) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    add(errors, "invalid_iso_date", path, "must be a UTC ISO-8601 instant");
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    add(errors, "invalid_iso_date", path, "date does not exist");
    return undefined;
  }
  const canonical = new Date(parsed).toISOString();
  if (value !== canonical && value !== canonical.replace(".000Z", "Z")) {
    add(errors, "invalid_iso_date", path, "must be a canonical UTC ISO-8601 instant");
    return undefined;
  }
  if (parsed > nowMs) add(errors, "future_date", path, "must not be in the future");
  return parsed;
}

function validateRecord(record, index, nowMs, maxAgeDays, seen, errors) {
  const path = `$.evidence[${index}]`;
  const keys = ["evidenceId", "policyId", "policyRevision", "testedAt", "client", "artifactSha256", "output", "lifecycle"];
  if (!closedObject(record, keys, keys, path, errors)) return;

  if (typeof record.evidenceId !== "string" || !EVIDENCE_ID.test(record.evidenceId)) {
    add(errors, "invalid_evidence_id", `${path}.evidenceId`, "must match the stable evidence ID pattern");
  } else if (seen.has(record.evidenceId)) {
    add(errors, "duplicate_evidence_id", `${path}.evidenceId`, "must be unique within the bundle");
  } else {
    seen.add(record.evidenceId);
  }

  const policy = POLICIES[record.policyId];
  if (policy === undefined) {
    add(errors, "unknown_policy_id", `${path}.policyId`, "policy is not in the current policy set");
  }
  if (typeof record.policyRevision !== "string" || record.policyRevision !== policy?.revision) {
    add(errors, "policy_revision_mismatch", `${path}.policyRevision`, "revision does not match the current policy");
  }

  const testedAtMs = strictInstant(record.testedAt, `${path}.testedAt`, nowMs, errors);
  if (testedAtMs !== undefined && testedAtMs <= nowMs && (nowMs - testedAtMs) / DAY_MS > maxAgeDays) {
    add(errors, "evidence_expired", `${path}.testedAt`, `evidence is older than ${maxAgeDays} days`);
  }
  validateClient(record.client, `${path}.client`, errors);
  if (typeof record.artifactSha256 !== "string" || !SHA256.test(record.artifactSha256)) {
    add(errors, "invalid_sha256", `${path}.artifactSha256`, "must be a lowercase 64-character SHA-256 digest");
  }
  validateOutput(record.output, policy, `${path}.output`, errors);
  validateLifecycle(record.lifecycle, `${path}.lifecycle`, errors);
}

export function verifyPlatformDeliveryEvidence(bundle, options = {}) {
  const now = options.now ?? new Date();
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid Date");
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw new TypeError("maxAgeDays must be non-negative");

  const errors = [];
  const rootKeys = ["schemaVersion", "policySetVersion", "evidence"];
  if (closedObject(bundle, rootKeys, rootKeys, "$", errors)) {
    if (bundle.schemaVersion !== 1) add(errors, "schema_version_mismatch", "$.schemaVersion", "must equal 1");
    if (bundle.policySetVersion !== POLICY_SET_VERSION) {
      add(errors, "policy_set_version_mismatch", "$.policySetVersion", `must equal ${POLICY_SET_VERSION}`);
    }
    if (!Array.isArray(bundle.evidence)) {
      add(errors, "type", "$.evidence", "must be an array");
    } else {
      const seen = new Set();
      bundle.evidence.forEach((record, index) => validateRecord(record, index, nowMs, maxAgeDays, seen, errors));
    }
  }

  const recordCount = Array.isArray(bundle?.evidence) ? bundle.evidence.length : 0;
  return {
    schemaVersion: 1,
    valid: errors.length === 0,
    policySetVersion: POLICY_SET_VERSION,
    checkedAt: new Date(nowMs).toISOString(),
    maxAgeDays,
    recordCount,
    deviceVerifiedCount: errors.length === 0 ? recordCount : 0,
    errors,
  };
}

function parseCli(argv) {
  let inputPath;
  let now = new Date();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--now") {
      const value = argv[++index];
      if (!value || !ISO_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("--now requires a UTC ISO-8601 instant");
      now = new Date(value);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (inputPath === undefined) {
      inputPath = arg;
    } else {
      throw new Error("exactly one evidence JSON path is required");
    }
  }
  if (!inputPath) throw new Error("usage: node scripts/verify-platform-delivery-evidence.mjs <evidence.json> [--now <ISO instant>]");
  return { inputPath, now };
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    const { inputPath, now } = parseCli(argv);
    const bundle = JSON.parse(readFileSync(inputPath, "utf8"));
    const summary = verifyPlatformDeliveryEvidence(bundle, { now });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary.valid ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, valid: false, fatal: true, errors: [{ code: "input_error", path: "$", message: error.message }] })}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
