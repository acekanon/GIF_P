import type { OutputFormat } from "../tauri";
import type { PlatformPolicy } from "./platformPolicy";

export type PlatformDeliveryEvidenceState =
  | "device_verified"
  | "rule_inferred"
  | "evidence_expired"
  | "invalid";

export type PlatformOutputContract = {
  format: OutputFormat;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  sizeBytes: number;
};

export type PlatformDeliveryLifecycle = {
  send: boolean;
  receiverPlayback: boolean;
  forward: boolean;
  download: boolean;
  reopen: boolean;
};

export type PlatformDeliveryEvidence = {
  policyId: PlatformPolicy["id"];
  policyRevision: string;
  testedAt: string;
  client: string;
  artifactSha256: string;
  output: PlatformOutputContract;
  lifecycle: PlatformDeliveryLifecycle;
};

export type PlatformDeliveryEnvelope = {
  within: boolean;
  violations: string[];
};

export type PlatformDeliveryEvidenceAssessment = {
  state: PlatformDeliveryEvidenceState;
  reasons: string[];
  envelope: PlatformDeliveryEnvelope;
  ageDays?: number;
};

/**
 * Audited client evidence is intentionally empty until a real external client
 * lifecycle has been executed and its immutable artifact is checked in.
 */
export const PLATFORM_DELIVERY_EVIDENCE: readonly PlatformDeliveryEvidence[] = [];

const SHA256_PATTERN = /^[a-f\d]{64}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

function isPositiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}

export function assessPlatformOutputEnvelope(
  policy: PlatformPolicy,
  output: PlatformOutputContract,
): PlatformDeliveryEnvelope {
  const violations: string[] = [];

  if (!policy.acceptedFormats.includes(output.format)) violations.push("format_not_accepted");
  if (!isPositiveFinite(output.width) || !isPositiveFinite(output.height)) {
    violations.push("invalid_dimensions");
  }
  if (!isPositiveFinite(output.fps)) violations.push("invalid_fps");
  if (!isPositiveFinite(output.durationSeconds)) violations.push("invalid_duration");
  if (!Number.isFinite(output.sizeBytes) || output.sizeBytes <= 0) violations.push("invalid_size");

  const { guidance } = policy;
  if (guidance.maxWidth !== undefined && output.width > guidance.maxWidth) violations.push("width_exceeds_policy");
  if (guidance.maxFps !== undefined && output.fps > guidance.maxFps) violations.push("fps_exceeds_policy");
  if (
    guidance.maxDurationSeconds !== undefined &&
    output.durationSeconds > guidance.maxDurationSeconds
  ) {
    violations.push("duration_exceeds_policy");
  }
  if (
    guidance.targetSizeMb !== undefined &&
    output.sizeBytes > guidance.targetSizeMb * 1024 * 1024
  ) {
    violations.push("size_exceeds_policy");
  }
  if (guidance.aspect !== undefined && isPositiveFinite(output.width) && isPositiveFinite(output.height)) {
    const actualAspect = output.width / output.height;
    if (Math.abs(actualAspect - guidance.aspect) / guidance.aspect > 0.01) {
      violations.push("aspect_outside_policy");
    }
  }

  return { within: violations.length === 0, violations };
}

export function assessPlatformDeliveryEvidence(
  policy: PlatformPolicy,
  evidence?: PlatformDeliveryEvidence | null,
  options: { now?: Date; maxAgeDays?: number } = {},
): PlatformDeliveryEvidenceAssessment {
  if (!evidence) {
    return {
      state: "rule_inferred",
      reasons: ["no_device_evidence"],
      envelope: { within: false, violations: ["output_contract_missing"] },
    };
  }

  if (!evidence.output || typeof evidence.output !== "object") {
    return {
      state: "invalid",
      reasons: ["output_contract_missing"],
      envelope: { within: false, violations: ["output_contract_missing"] },
    };
  }

  const envelope = assessPlatformOutputEnvelope(policy, evidence.output);
  const reasons: string[] = [];
  if (evidence.policyId !== policy.id) reasons.push("policy_id_mismatch");
  if (evidence.policyRevision !== policy.revision) reasons.push("policy_revision_mismatch");
  if (typeof evidence.client !== "string" || !evidence.client.trim()) reasons.push("client_missing");
  if (!SHA256_PATTERN.test(evidence.artifactSha256)) reasons.push("artifact_sha256_invalid");

  const testedAtMs = typeof evidence.testedAt === "string" ? Date.parse(evidence.testedAt) : Number.NaN;
  const now = options.now ?? new Date();
  if (
    !Number.isFinite(testedAtMs) ||
    typeof evidence.testedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(evidence.testedAt)
  ) {
    reasons.push("tested_at_invalid");
  } else if (testedAtMs > now.getTime()) {
    reasons.push("tested_at_in_future");
  }

  if (!envelope.within) reasons.push(...envelope.violations);
  for (const stage of ["send", "receiverPlayback", "forward", "download", "reopen"] as const) {
    if (!evidence.lifecycle || evidence.lifecycle[stage] !== true) {
      reasons.push(`lifecycle_${stage}_incomplete`);
    }
  }

  if (reasons.length > 0) return { state: "invalid", reasons, envelope };

  const ageDays = (now.getTime() - testedAtMs) / DAY_MS;
  const maxAgeDays = options.maxAgeDays ?? 180;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    return { state: "invalid", reasons: ["max_age_invalid"], envelope, ageDays };
  }
  if (ageDays > maxAgeDays) {
    return { state: "evidence_expired", reasons: ["evidence_too_old"], envelope, ageDays };
  }

  return { state: "device_verified", reasons: [], envelope, ageDays };
}
