import type { ReleaseTrustReport } from "../tauri";

export type ReleaseTrustPresentation = {
  label: string;
  summary: string;
  copyText: string;
};

const STATUS_LABELS: Record<ReleaseTrustReport["status"], string> = {
  verified: "已验证发行",
  blocked: "发行受阻",
  unverified: "尚未验证",
};

const STATUS_SUMMARIES: Record<ReleaseTrustReport["status"], string> = {
  verified: "程序、签名与媒体运行时的发行可信校验已完成。",
  blocked: "当前发行未通过可信校验，请先处理阻断项。",
  unverified: "当前发行尚无足够证据完成可信校验。",
};

const CONTEXT_LABELS: Record<ReleaseTrustReport["context"], string> = {
  development: "开发环境",
  packaged: "已打包环境",
};

const RUNTIME_LABELS: Record<ReleaseTrustReport["runtime_integrity_status"], string> = {
  verified: "完整性通过",
  failed: "完整性失败",
  unverified: "未校验",
};

const SAFE_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;
const SAFE_BLOCKER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function safeValue(value: string | null, fallback = "未报告") {
  const normalized = value?.trim();
  return normalized && SAFE_VALUE_PATTERN.test(normalized) ? normalized : fallback;
}

function matchLabel(value: boolean | null) {
  if (value === true) return "匹配";
  if (value === false) return "不匹配";
  return "未校验";
}

function trustedLabel(value: boolean | null) {
  if (value === true) return "可信";
  if (value === false) return "不可信";
  return "未校验";
}

function safeBlockerCodes(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter((value) => SAFE_BLOCKER_PATTERN.test(value)))];
}

/**
 * Produces a deliberately narrow, shareable view of a release trust report.
 * Local paths, executable identity, hashes, runtime failure details and raw
 * reasons are never projected into the result.
 */
export function buildReleaseTrustSummary(report: ReleaseTrustReport): ReleaseTrustPresentation {
  const label = STATUS_LABELS[report.status];
  const summary = STATUS_SUMMARIES[report.status];
  const version = safeValue(
    report.reported_product_version,
    safeValue(report.expected_product_version, "未报告"),
  );
  const channel = safeValue(report.channel, "未报告");
  const signatureStatus = safeValue(report.signature_status, "未报告");
  const blockerCodes = safeBlockerCodes(report.public_release_blockers);
  const runtimeFilesChecked = Number.isFinite(report.runtime_files_checked)
    ? Math.max(0, Math.trunc(report.runtime_files_checked))
    : 0;

  const copyText = [
    "GIFP 发行可信摘要",
    `版本：${version}`,
    `运行环境：${CONTEXT_LABELS[report.context]}`,
    `状态：${label}`,
    `发行渠道：${channel}`,
    `程序哈希：${matchLabel(report.executable_sha256_matches)}`,
    `发布者签名：${signatureStatus}（${trustedLabel(report.signature_trusted)}）`,
    `媒体运行时：${RUNTIME_LABELS[report.runtime_integrity_status]}；已校验 ${runtimeFilesChecked} 个文件`,
    `阻断代码：${blockerCodes.length > 0 ? blockerCodes.join("、") : "无"}`,
  ].join("\n");

  return { label, summary, copyText };
}
