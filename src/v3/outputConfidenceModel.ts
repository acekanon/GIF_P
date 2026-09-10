export type OutputConfidenceLevel = "ready" | "check" | "adjust" | "assessing";
export type OutputConfidenceAction = "clearer" | "smaller" | "smoother" | "regenerate";

export type OutputConfidenceInput = {
  status?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  fps?: number | null;
  frameCount?: number | null;
  hasAlpha?: boolean | null;
  targetSizeBytes?: number | null;
  targetDeviationPercent?: number | null;
  warnings?: string[] | null;
  fallbackReason?: string | null;
  quality?: {
    status: "measured" | "unavailable";
    vmafMean?: number | null;
    ssimMean?: number | null;
    message?: string | null;
  } | null;
  platformAssessment?: {
    status: "device_verified" | "rule_inferred" | "evidence_expired" | "invalid";
    label: string;
  } | null;
};

export type OutputConfidence = {
  level: OutputConfidenceLevel;
  label: "放心交付" | "文件已就绪" | "建议检查" | "需要调整" | "正在评估";
  summary: string;
  qualityLabel: string;
  qualityMeasured: boolean;
  risks: string[];
  recommendedAction: OutputConfidenceAction;
};

function measuredQuality(input: OutputConfidenceInput) {
  if (input.quality?.status !== "measured") return null;
  const vmaf = input.quality.vmafMean;
  if (vmaf != null && Number.isFinite(vmaf)) {
    return { score: vmaf >= 90 ? 3 : vmaf >= 80 ? 2 : vmaf >= 70 ? 1 : 0, label: `VMAF ${vmaf.toFixed(1)}` };
  }
  const ssim = input.quality.ssimMean;
  if (ssim != null && Number.isFinite(ssim)) {
    return { score: ssim >= 0.98 ? 3 : ssim >= 0.95 ? 2 : ssim >= 0.9 ? 1 : 0, label: `SSIM ${ssim.toFixed(3)}` };
  }
  return null;
}

export function assessOutputConfidence(input?: OutputConfidenceInput | null): OutputConfidence {
  if (!input) {
    return {
      level: "assessing",
      label: "正在评估",
      summary: "生成成品后，这里会给出可交付结论。",
      qualityLabel: "等待成品",
      qualityMeasured: false,
      risks: [],
      recommendedAction: "regenerate",
    };
  }

  const risks: string[] = [];
  const quality = measuredQuality(input);
  const warnings = (input.warnings ?? []).filter(Boolean);
  const targetMissed = input.targetSizeBytes != null && (
    input.status === "target_over"
    || input.status === "target_unreachable"
    || (input.targetDeviationPercent ?? 0) > 5
  );
  if (targetMissed) risks.push("未命中目标体积");
  if (input.fallbackReason) risks.push("编码发生降级");
  if (warnings.length) risks.push(warnings[0]);
  if (!quality) risks.push("质量评分暂不可用，请在对比视图检查细节");
  if (quality && quality.score === 0) risks.push("画质损失明显");
  if (input.hasAlpha === false && warnings.some((item) => /alpha|透明/i.test(item))) risks.push("透明效果可能未保留");
  const platformStatus = input.platformAssessment?.status;
  if (platformStatus === "rule_inferred") risks.push(`建议确认目标平台限制：${input.platformAssessment?.label}`);
  if (platformStatus === "evidence_expired") risks.push(`平台规格建议已更新，请复核：${input.platformAssessment?.label}`);
  if (platformStatus === "invalid") risks.push(`平台规格信息不完整：${input.platformAssessment?.label}`);

  if (targetMissed) {
    return { level: "adjust", label: "需要调整", summary: "当前结果超出体积目标，建议先向更小方向重生成。", qualityLabel: quality?.label ?? "画质未实测", qualityMeasured: Boolean(quality), risks, recommendedAction: "smaller" };
  }
  if (quality && quality.score === 0) {
    return { level: "adjust", label: "需要调整", summary: "实测画质损失较明显，建议提高画面参数后重生成。", qualityLabel: quality.label, qualityMeasured: true, risks, recommendedAction: "clearer" };
  }
  if (input.fallbackReason || warnings.length || !quality || quality.score === 1 || (platformStatus != null && platformStatus !== "device_verified")) {
    return { level: "check", label: "建议检查", summary: "成品已生成，请在对比视图检查细节和播放节奏。", qualityLabel: quality?.label ?? "暂无评分", qualityMeasured: Boolean(quality), risks, recommendedAction: quality?.score === 1 ? "clearer" : "regenerate" };
  }
  if (platformStatus === "device_verified") {
    return { level: "ready", label: "放心交付", summary: `质量、编码和 ${input.platformAssessment?.label} 适配检查均已通过。`, qualityLabel: quality.label, qualityMeasured: true, risks, recommendedAction: "regenerate" };
  }
  return { level: "ready", label: "文件已就绪", summary: "文件检查已通过，可以导出使用。", qualityLabel: quality.label, qualityMeasured: true, risks, recommendedAction: "regenerate" };
}
