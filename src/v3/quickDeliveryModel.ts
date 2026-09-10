import type { FilterStyle, GifEncoder, OutputFormat, PerceptualFocus } from "../tauri";
import type { CompressionPresetId, DitherId } from "./editorModel";
import {
  platformPolicyById,
  platformPolicyVerificationLabel,
  type PlatformPolicyId,
  type PlatformPolicyVerification,
} from "./platformPolicy";
import {
  PLATFORM_DELIVERY_EVIDENCE,
  assessPlatformDeliveryEvidence,
  assessPlatformOutputEnvelope,
  type PlatformDeliveryEvidence,
  type PlatformDeliveryEvidenceState,
} from "./platformDeliveryEvidence";

export type QuickUseCaseId = "chat" | "social_live" | "web" | "manual";

export type QuickDeliveryScenarioId = PlatformPolicyId;

export type QuickDeliveryScenario = {
  id: QuickDeliveryScenarioId;
  useCase: Exclude<QuickUseCaseId, "manual">;
  label: string;
  note: string;
  format: OutputFormat;
  presetId: CompressionPresetId;
  width: number;
  fps: number;
  colors: number;
  dither: DitherId;
  lossy: number;
  optimizeLevel: number;
  encoder: GifEncoder;
  filter: FilterStyle;
  perceptualFocus: PerceptualFocus;
  targetSizeMb?: number;
  targetLabel: string;
  aspect?: number;
  aspectLabel: string;
  maxDuration?: number;
  durationLabel: string;
  loopOutput: boolean;
  policyLabel: string;
};

export type QuickSourceProfile = {
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
};

export type QuickStartRecommendation = {
  scalePercent: number;
  width: number;
  fps: number;
  reason: string;
};

export type QuickSizeEstimate = {
  likelyBytes: number;
  lowerBytes: number;
  upperBytes: number;
  baselineBytes: number;
  savingPercent: number;
};

export type QuickFormatSizeEstimate = QuickSizeEstimate & {
  format: OutputFormat;
  relativeToGifPercent: number;
};

export const QUICK_FORMAT_RELATIVE_TO_GIF: Record<OutputFormat, number> = {
  gif: 1,
  webp: 0.4,
  avif: 0.1,
  apng: 2.8,
  mp4: 0.1,
  webm: 0.1,
  live_photo: 0.2,
};

// Five diverse local clips, encoded at 480 px / 12 FPS / 3 s with the 5.7
// delivery settings. GIF is the 128-color palette baseline. These ranges are
// evidence labels, not hard bounds: source complexity can move them further.
export const QUICK_FORMAT_MEASURED_RANGE_TO_GIF: Partial<Record<OutputFormat, readonly [number, number]>> = {
  gif: [1, 1],
  webp: [0.32, 0.57],
  avif: [0.04, 0.22],
  apng: [2.36, 3.08],
  mp4: [0.05, 0.23],
  webm: [0.05, 0.29],
};

export type QuickPlatformHint = {
  id: QuickDeliveryScenarioId;
  label: string;
  fit: "ready" | "unverified" | "expired" | "adjust";
  note: string;
  verification: PlatformPolicyVerification;
  verificationLabel: string;
  policyVersion: string;
  sourceLabel: string;
  evidenceState: PlatformDeliveryEvidenceState;
};

export const QUICK_SCALE_MIN = 5;
export const QUICK_SCALE_STEPS = [QUICK_SCALE_MIN, 10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 85, 100] as const;
export const QUICK_FPS_MIN = 6;
export const QUICK_FPS_MAX = 30;

export const QUICK_USE_CASE_OPTIONS: Array<{ value: QuickUseCaseId; label: string; note: string }> = [
  { value: "chat", label: "聊天与表情", note: "QQ、微信、飞书聊天和收藏表情" },
  { value: "social_live", label: "社交 Live 图", note: "小红书、抖音原生实况照片" },
  { value: "web", label: "网页动效", note: "轻量 WebP 或透明无损 APNG" },
  { value: "manual", label: "我自己选格式", note: "保留 GIF、WebP、APNG、视频等手动入口" },
];

export const QUICK_DELIVERY_SCENARIOS: QuickDeliveryScenario[] = [
  {
    id: "qq_chat",
    useCase: "chat",
    label: "QQ 聊天动图",
    note: "兼容性优先，适合聊天发送",
    format: "gif",
    presetId: "clean",
    width: 560,
    fps: 18,
    colors: 224,
    dither: "floyd_steinberg",
    lossy: 12,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "none",
    perceptualFocus: "auto",
    targetSizeMb: 1.9,
    targetLabel: "保守建议 1.9 MB（非平台上限）",
    aspectLabel: "保持原画幅",
    durationLabel: "完整片段",
    loopOutput: true,
    policyLabel: "聊天兼容保守档",
  },
  {
    id: "wechat_chat",
    useCase: "chat",
    label: "微信聊天动图",
    note: "聊天发送，兼容性优先",
    format: "gif",
    presetId: "perceptual",
    width: 420,
    fps: 15,
    colors: 160,
    dither: "sierra2_4a",
    lossy: 24,
    optimizeLevel: 3,
    encoder: "pngquant_opt",
    filter: "vivid",
    perceptualFocus: "auto",
    targetSizeMb: 1.9,
    targetLabel: "保守建议 1.9 MB（非平台上限）",
    aspectLabel: "保持原画幅",
    durationLabel: "完整片段",
    loopOutput: true,
    policyLabel: "聊天兼容保守档",
  },
  {
    id: "wechat_sticker",
    useCase: "chat",
    label: "微信收藏表情",
    note: "收藏表情，方形小尺寸",
    format: "gif",
    presetId: "wechat",
    width: 240,
    fps: 12,
    colors: 96,
    dither: "sierra2_4a",
    lossy: 56,
    optimizeLevel: 4,
    encoder: "hybrid",
    filter: "vivid",
    perceptualFocus: "text_ui",
    targetSizeMb: 0.48,
    targetLabel: "保守建议 0.48 MB（非平台上限）",
    aspect: 1,
    aspectLabel: "自动居中 1:1",
    maxDuration: 3,
    durationLabel: "最长 3 秒",
    loopOutput: true,
    policyLabel: "微信表情保守模板",
  },
  {
    id: "feishu_chat",
    useCase: "chat",
    label: "飞书聊天动图",
    note: "聊天发送，GIF 兼容优先",
    format: "gif",
    presetId: "clean",
    width: 560,
    fps: 18,
    colors: 192,
    dither: "floyd_steinberg",
    lossy: 16,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "none",
    perceptualFocus: "auto",
    targetLabel: "平台建议上限",
    aspectLabel: "保持原画幅",
    durationLabel: "完整片段",
    loopOutput: true,
    policyLabel: "飞书聊天模板",
  },
  {
    id: "xiaohongshu_live",
    useCase: "social_live",
    label: "小红书 Live 图",
    note: "小红书发布，竖图 Live",
    format: "live_photo",
    presetId: "clean",
    width: 1080,
    fps: 30,
    colors: 256,
    dither: "none",
    lossy: 8,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "none",
    perceptualFocus: "auto",
    targetLabel: "画质优先",
    aspect: 3 / 4,
    aspectLabel: "自动居中 3:4",
    maxDuration: 3,
    durationLabel: "3 秒实况",
    loopOutput: false,
    policyLabel: "社交竖图建议档",
  },
  {
    id: "douyin_live",
    useCase: "social_live",
    label: "抖音 Live 图",
    note: "抖音发布，竖屏 Live",
    format: "live_photo",
    presetId: "clean",
    width: 1080,
    fps: 30,
    colors: 256,
    dither: "none",
    lossy: 8,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "none",
    perceptualFocus: "auto",
    targetLabel: "画质优先",
    aspect: 9 / 16,
    aspectLabel: "自动居中 9:16",
    maxDuration: 3,
    durationLabel: "3 秒实况",
    loopOutput: false,
    policyLabel: "社交竖屏建议档",
  },
  {
    id: "web_animation",
    useCase: "web",
    label: "网页轻量动图",
    note: "照片与常规网页动画",
    format: "webp",
    presetId: "clean",
    width: 960,
    fps: 24,
    colors: 256,
    dither: "none",
    lossy: 14,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "none",
    perceptualFocus: "auto",
    targetLabel: "WebP Q93",
    aspectLabel: "保持原画幅",
    durationLabel: "短循环最佳",
    loopOutput: true,
    policyLabel: "现代浏览器性能档",
  },
  {
    id: "web_transparent_ui",
    useCase: "web",
    label: "网页透明 UI 动效",
    note: "透明 UI、文字与图标",
    format: "apng",
    presetId: "clean",
    width: 960,
    fps: 30,
    colors: 256,
    dither: "none",
    lossy: 0,
    optimizeLevel: 4,
    encoder: "hybrid",
    filter: "none",
    perceptualFocus: "text_ui",
    targetLabel: "RGBA 无损",
    aspectLabel: "保持原画幅",
    durationLabel: "短 UI 动效",
    loopOutput: true,
    policyLabel: "透明边缘保真档",
  },
];

export function quickScenarioById(id: QuickDeliveryScenarioId | null | undefined) {
  return QUICK_DELIVERY_SCENARIOS.find((scenario) => scenario.id === id);
}

export function quickScenariosFor(useCase: Exclude<QuickUseCaseId, "manual">) {
  return QUICK_DELIVERY_SCENARIOS.filter((scenario) => scenario.useCase === useCase);
}

export function resolveQuickScenarioForSource(
  scenario: QuickDeliveryScenario,
  source: { width?: number; height?: number; fps?: number } = {},
) {
  const sourceWidth = Number.isFinite(source.width) && (source.width ?? 0) > 0
    ? Math.max(96, Math.floor(source.width! / 2) * 2)
    : null;
  const sourceHeight = Number.isFinite(source.height) && (source.height ?? 0) > 0
    ? Math.max(96, Math.floor(source.height! / 2) * 2)
    : null;
  const sourceFps = Number.isFinite(source.fps) && (source.fps ?? 0) > 0
    ? Math.max(1, Math.min(60, Math.floor(source.fps!)))
    : null;
  const cropSafeWidth = sourceWidth !== null && sourceHeight !== null && scenario.aspect
    ? Math.max(96, Math.floor(Math.min(sourceWidth, sourceHeight * scenario.aspect) / 2) * 2)
    : sourceWidth;
  return {
    ...scenario,
    width: cropSafeWidth === null ? scenario.width : Math.min(scenario.width, cropSafeWidth),
    fps: sourceFps === null ? scenario.fps : Math.min(scenario.fps, sourceFps),
  };
}

function finitePositive(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Number(value) : fallback;
}

function even(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function quickWidthForScale(sourceWidth: number | undefined, scalePercent: number) {
  const safeSourceWidth = finitePositive(sourceWidth, 420);
  const safeScale = Math.max(QUICK_SCALE_MIN, Math.min(100, Math.round(scalePercent)));
  const backendSafeMinimum = Math.min(16, safeSourceWidth);
  return even(Math.min(safeSourceWidth, Math.max(backendSafeMinimum, safeSourceWidth * safeScale / 100)));
}

export function quickScalePercentForWidth(sourceWidth: number | undefined, width: number) {
  const safeSourceWidth = finitePositive(sourceWidth, width || 420);
  return Math.max(
    QUICK_SCALE_MIN,
    Math.min(100, Math.round((finitePositive(width, safeSourceWidth) / safeSourceWidth) * 100)),
  );
}

export function estimateQuickOutputSize({
  sourceWidth,
  sourceHeight,
  sourceFps,
  duration,
  width,
  fps,
  format,
  colors = 64,
  lossy = 46,
}: {
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFps?: number;
  duration?: number;
  width: number;
  fps: number;
  format: OutputFormat;
  colors?: number;
  lossy?: number;
}): QuickSizeEstimate {
  const safeSourceWidth = finitePositive(sourceWidth, Math.max(2, width));
  const safeSourceHeight = finitePositive(sourceHeight, safeSourceWidth * 9 / 16);
  const safeWidth = Math.max(2, Math.min(safeSourceWidth, finitePositive(width, safeSourceWidth)));
  const safeHeight = even(safeSourceHeight * safeWidth / safeSourceWidth);
  const safeDuration = Math.max(0.5, finitePositive(duration, 3));
  const safeFps = Math.max(1, finitePositive(fps, 12));
  const safeSourceFps = Math.max(safeFps, Math.min(60, finitePositive(sourceFps, safeFps)));
  // Calibrated from the 121.MP4 5.1.3 matrix. GIF bytes are primarily
  // driven by output pixels × frames; palette size and lossy level adjust
  // the content-complexity coefficient. Other formats use conservative
  // relative factors until enough cross-format fixtures are available.
  const gifBytesPerPixelFrame = Math.max(
    0.24,
    Math.min(0.62, 0.32 + Math.max(3, Math.min(256, colors)) / 1000 - Math.max(0, Math.min(100, lossy)) / 1500),
  );
  const referenceBytesPerPixelFrame = 0.32 + 64 / 1000 - 46 / 1500;
  const bytesPerPixelFrame = format === "gif" ? gifBytesPerPixelFrame : referenceBytesPerPixelFrame;
  const likelyBytes = Math.max(
    16 * 1024,
    Math.round(safeWidth * safeHeight * safeFps * safeDuration * bytesPerPixelFrame * QUICK_FORMAT_RELATIVE_TO_GIF[format]),
  );
  const baselineBytes = Math.max(
    likelyBytes,
    Math.round(safeSourceWidth * safeSourceHeight * safeSourceFps * safeDuration * bytesPerPixelFrame * QUICK_FORMAT_RELATIVE_TO_GIF[format]),
  );
  return {
    likelyBytes,
    lowerBytes: Math.round(likelyBytes * 0.78),
    upperBytes: Math.round(likelyBytes * 1.3),
    baselineBytes,
    savingPercent: Math.max(0, Math.min(99, Math.round((1 - likelyBytes / baselineBytes) * 100))),
  };
}

export function estimateQuickFormatSizes({
  formats,
  sourceWidth,
  sourceHeight,
  sourceFps,
  duration,
  width,
  fps,
  colors = 64,
  lossy = 46,
}: {
  formats: readonly OutputFormat[];
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFps?: number;
  duration?: number;
  width: number;
  fps: number;
  colors?: number;
  lossy?: number;
}): QuickFormatSizeEstimate[] {
  const estimates = formats.map((format) => ({
    format,
    ...estimateQuickOutputSize({
      sourceWidth,
      sourceHeight,
      sourceFps,
      duration,
      width,
      fps,
      format,
      colors,
      lossy,
    }),
  }));
  const gifLikelyBytes = estimates.find((item) => item.format === "gif")?.likelyBytes
    ?? estimateQuickOutputSize({
      sourceWidth,
      sourceHeight,
      sourceFps,
      duration,
      width,
      fps,
      format: "gif",
      colors,
      lossy,
    }).likelyBytes;
  return estimates.map((estimate) => ({
    ...estimate,
    relativeToGifPercent: Math.max(1, Math.round(estimate.likelyBytes / gifLikelyBytes * 100)),
  }));
}

export function recommendQuickStart(
  source: QuickSourceProfile,
  format: OutputFormat = "gif",
): QuickStartRecommendation {
  const sourceWidth = finitePositive(source.width, 420);
  const sourceFps = Math.max(QUICK_FPS_MIN, Math.min(QUICK_FPS_MAX, Math.floor(finitePositive(source.fps, 15))));
  const duration = finitePositive(source.duration, 3);
  const preferredFps = Math.min(
    sourceFps,
    duration >= 12 ? 8 : duration >= 6 ? 10 : duration >= 3 ? 12 : 15,
  );
  const targetBytes = format === "gif" ? 1.9 * 1024 * 1024 : 3.5 * 1024 * 1024;
  const descendingScales = [...QUICK_SCALE_STEPS].reverse();
  const selectedScale = descendingScales.find((candidate) => {
    const candidateWidth = quickWidthForScale(sourceWidth, candidate);
    return estimateQuickOutputSize({
      sourceWidth,
      sourceHeight: source.height,
      sourceFps,
      duration,
      width: candidateWidth,
      fps: preferredFps,
      format,
    }).likelyBytes <= targetBytes;
  }) ?? QUICK_SCALE_MIN;
  const width = quickWidthForScale(sourceWidth, selectedScale);
  const scalePercent = quickScalePercentForWidth(sourceWidth, width);
  const durationLabel = duration >= 10 ? "长片段" : duration >= 4 ? "中等时长" : "短片段";
  return {
    scalePercent,
    width,
    fps: preferredFps,
    reason: `${durationLabel}建议使用 ${scalePercent}% 尺寸和 ${preferredFps} FPS`,
  };
}

export function quickDesiredTargetSizeMb(
  estimate: Pick<QuickSizeEstimate, "likelyBytes">,
) {
  const predictedWithMargin = estimate.likelyBytes * 1.08 / 1024 / 1024;
  return Math.ceil(Math.max(0.07, Math.min(512, predictedWithMargin)) * 100) / 100;
}

export function quickPlatformHints({
  format,
  width,
  fps,
  duration,
  estimatedBytes,
  evidenceRecords = PLATFORM_DELIVERY_EVIDENCE,
  now,
}: {
  format: OutputFormat;
  width: number;
  fps: number;
  duration: number;
  estimatedBytes?: number;
  evidenceRecords?: readonly PlatformDeliveryEvidence[];
  now?: Date;
}): QuickPlatformHint[] {
  const matches = QUICK_DELIVERY_SCENARIOS
    .filter((scenario) => scenario.format === format)
    .map((scenario) => {
      const policy = platformPolicyById(scenario.id);
      if (!policy) return null;
      const evidence = evidenceRecords.find((record) => record.policyId === policy.id);
      const evidenceAssessment = assessPlatformDeliveryEvidence(policy, evidence, { now });
      const adjustments: string[] = [];
      if (width > scenario.width) adjustments.push(`缩到 ${scenario.width}px`);
      if (fps > scenario.fps) adjustments.push(`降到 ${scenario.fps} FPS`);
      if (scenario.maxDuration && duration > scenario.maxDuration) adjustments.push(`裁到 ${scenario.maxDuration} 秒`);
      if (scenario.targetSizeMb && estimatedBytes != null && estimatedBytes > scenario.targetSizeMb * 1024 * 1024) {
        adjustments.push(`文件不超过 ${scenario.targetSizeMb} MB`);
      }
      if (evidence && evidenceAssessment.state === "device_verified" && estimatedBytes != null) {
        const outputHeight = scenario.aspect ? width / scenario.aspect : Math.max(1, width);
        const currentEnvelope = assessPlatformOutputEnvelope(policy, {
          format,
          width,
          height: outputHeight,
          fps,
          durationSeconds: duration,
          sizeBytes: estimatedBytes,
        });
        if (!currentEnvelope.within) adjustments.push("超出平台建议规格");
      }
      const verification: PlatformPolicyVerification = evidenceAssessment.state === "device_verified"
        ? "verified"
        : policy.verification;
      const verificationLabel = evidenceAssessment.state === "device_verified"
        ? `已实机验证 · ${evidence?.client}`
        : evidenceAssessment.state === "evidence_expired"
          ? `实机证据已过期 · ${evidence?.client}`
          : platformPolicyVerificationLabel(policy.verification);
      const fit = adjustments.length
        ? "adjust" as const
        : evidenceAssessment.state === "device_verified"
          ? "ready" as const
          : evidenceAssessment.state === "evidence_expired"
            ? "expired" as const
            : "unverified" as const;
      return {
        id: scenario.id,
        label: scenario.label,
        fit,
        note: adjustments.length
          ? adjustments.join(" · ")
          : evidenceAssessment.state === "device_verified"
            ? "当前规格符合平台建议"
            : evidenceAssessment.state === "evidence_expired"
              ? "当前规格建议复核"
            : "当前规格符合建议",
        verification,
        verificationLabel,
        policyVersion: policy.revision,
        sourceLabel: policy.source.label,
        evidenceState: evidenceAssessment.state,
        distance: Math.abs(scenario.fps - fps) + Math.max(0, width - scenario.width) / 100,
      };
    })
    .filter((hint): hint is NonNullable<typeof hint> => hint !== null)
    .sort((left, right) => {
      const rank = { ready: 0, expired: 1, unverified: 2, adjust: 3 } as const;
      return rank[left.fit] - rank[right.fit] || left.distance - right.distance;
    });
  return matches.slice(0, 4).map(({ distance: _distance, ...hint }) => hint);
}
