import type { PerceptualReport } from "../tauri";

export type RoiProvider = "alpha_mask" | "motion_baseline" | "content_saliency" | "none";
export type RoiReadiness = "ready" | "not_needed" | "unsuitable" | "insufficient_evidence";

export type RoiAssessment = {
  contractVersion: 1;
  provider: RoiProvider;
  readiness: RoiReadiness;
  label: string;
  reason: string;
  foregroundWeight: number;
  backgroundWeight: number;
  samIncrementWorthTesting: boolean;
};

const INSUFFICIENT: RoiAssessment = {
  contractVersion: 1,
  provider: "none",
  readiness: "insufficient_evidence",
  label: "等待内容证据",
  reason: "完成一次感知 GIF 编码后，才能依据真实时序探测选择 ROI 基线。",
  foregroundWeight: 1,
  backgroundWeight: 1,
  samIncrementWorthTesting: false,
};

/**
 * 5.7 phase-one ROI contract. It deliberately prefers audited, no-model
 * evidence. SAM is only recommended as a later A/B increment when semantic
 * subject evidence exists and ordinary motion masks are likely too coarse.
 */
export function assessRoiReadiness({
  hasAlpha,
  report,
}: {
  hasAlpha?: boolean;
  report?: PerceptualReport | null;
}): RoiAssessment {
  if (hasAlpha) {
    return {
      contractVersion: 1,
      provider: "alpha_mask",
      readiness: "not_needed",
      label: "Alpha 已是精确 ROI",
      reason: "透明通道比语义分割更准确，直接作为前景权重，不需要 SAM。",
      foregroundWeight: 1.6,
      backgroundWeight: 0.72,
      samIncrementWorthTesting: false,
    };
  }
  if (!report || report.analysis_frame_count < 2) return INSUFFICIENT;

  const changedArea = Math.max(0, Math.min(1, report.mean_changed_area));
  const sceneCutRatio = report.analysis_frame_count <= 1
    ? 0
    : Math.max(0, Math.min(1, report.scene_boundary_count / (report.analysis_frame_count - 1)));
  const saliency = Math.max(0, Math.min(1, report.mean_subject_saliency));

  if (sceneCutRatio >= 0.28 || changedArea >= 0.72) {
    return {
      contractVersion: 1,
      provider: "none",
      readiness: "unsuitable",
      label: "ROI 分层收益低",
      reason: "镜头切换或全画面变化过多，优先依赖普通时序编码或现代视频格式。",
      foregroundWeight: 1,
      backgroundWeight: 1,
      samIncrementWorthTesting: false,
    };
  }

  if (changedArea <= 0.38) {
    return {
      contractVersion: 1,
      provider: "motion_baseline",
      readiness: "ready",
      label: "时序差分 ROI 可用",
      reason: "变化区域稳定且小于画面主体，先用无模型运动掩码验证体积与边缘闪烁。",
      foregroundWeight: 1.5,
      backgroundWeight: 0.78,
      samIncrementWorthTesting: saliency >= 0.58,
    };
  }

  return {
    contractVersion: 1,
    provider: "content_saliency",
    readiness: "ready",
    label: "内容显著性 ROI 可用",
    reason: "运动范围较大，使用现有主体、肤色与边缘证据生成软权重，SAM 仅做增量实验。",
    foregroundWeight: 1.35,
    backgroundWeight: 0.86,
    samIncrementWorthTesting: saliency >= 0.66,
  };
}

