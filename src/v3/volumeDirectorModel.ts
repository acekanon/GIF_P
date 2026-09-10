import type { PerceptualFocus, TargetPreference } from "../tauri";

export type VolumeDirectorPriority = "balanced" | "clarity" | "motion" | "text" | "smallest";
export type VolumeDirectorContentClass = "screen_ui" | "flat_art" | "photographic" | "high_motion" | "transparent_asset";
export type VolumeDirectorTimelinePolicy = "full_cfr" | "motion_protected_drop_hold" | "static_hold";

export type VolumeDirectorInput = {
  sourceWidth: number;
  sourceHeight: number;
  durationSeconds: number;
  sourceFps?: number;
  outputWidth: number;
  outputFps: number;
  colors: number;
  lossy: number;
  targetSizeMb: number;
  hasAlpha?: boolean;
  mediaKind?: "video" | "gif" | "webp" | "apng" | "image";
  perceptualFocus: PerceptualFocus;
  priority: VolumeDirectorPriority;
};

export type VolumeDirectorPlan = {
  planId: string;
  contentClass: VolumeDirectorContentClass;
  contentLabel: string;
  pressure: "low" | "medium" | "high" | "extreme";
  pressureScore: number;
  targetPreference: Exclude<TargetPreference, "auto">;
  perceptualFocus: PerceptualFocus;
  timelinePolicy: VolumeDirectorTimelinePolicy;
  timelineLabel: string;
  maxAttempts: number;
  suggestedWidth: number;
  suggestedFps: number;
  suggestedColors: number;
  suggestedLossy: number;
  dither: "bayer" | "sierra2_4a";
  estimatedSavingsPercent: [number, number];
  protectedSignals: string[];
  tradeoffs: string[];
  reasons: string[];
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function even(value: number) {
  const rounded = Math.max(96, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function classifyContent(input: VolumeDirectorInput): VolumeDirectorContentClass {
  if (input.hasAlpha) return "transparent_asset";
  if (input.perceptualFocus === "text_ui" || input.priority === "text") return "screen_ui";
  if (input.perceptualFocus === "flat_art") return "flat_art";
  if (input.perceptualFocus === "motion" || input.priority === "motion" || (input.sourceFps ?? 0) >= 48) return "high_motion";
  if (input.mediaKind === "video") return "photographic";
  return input.colors <= 128 ? "flat_art" : "photographic";
}

function preferenceFor(input: VolumeDirectorInput, contentClass: VolumeDirectorContentClass): Exclude<TargetPreference, "auto"> {
  if (input.priority === "clarity" || input.priority === "text") return "clarity";
  if (input.priority === "motion") return "smoothness";
  if (input.priority === "smallest") return "smallest";
  if (contentClass === "screen_ui" || contentClass === "transparent_asset") return "clarity";
  if (contentClass === "high_motion") return "smoothness";
  return "balanced";
}

function focusFor(input: VolumeDirectorInput, contentClass: VolumeDirectorContentClass): PerceptualFocus {
  if (input.priority === "text") return "text_ui";
  if (input.priority === "motion") return "motion";
  if (input.priority === "clarity" && input.perceptualFocus === "auto") return "subject";
  if (input.perceptualFocus !== "auto") return input.perceptualFocus;
  if (contentClass === "screen_ui") return "text_ui";
  if (contentClass === "flat_art" || contentClass === "transparent_asset") return "flat_art";
  if (contentClass === "high_motion") return "motion";
  return "subject";
}

export function planVolumeDirector(input: VolumeDirectorInput): VolumeDirectorPlan {
  const sourceWidth = clamp(Number.isFinite(input.sourceWidth) ? input.sourceWidth : input.outputWidth, 1, 32768);
  const sourceHeight = clamp(Number.isFinite(input.sourceHeight) ? input.sourceHeight : Math.round(sourceWidth * 9 / 16), 1, 32768);
  const duration = clamp(Number.isFinite(input.durationSeconds) ? input.durationSeconds : 1, 0.1, 3600);
  const targetBytes = clamp(input.targetSizeMb, 0.1, 512) * 1024 * 1024;
  const outputPixels = Math.max(1, Math.min(sourceWidth, input.outputWidth) * Math.min(sourceHeight, Math.round(input.outputWidth * sourceHeight / sourceWidth)));
  const alphaFactor = input.hasAlpha ? 1.28 : 1;
  const motionFactor = input.priority === "motion" || input.perceptualFocus === "motion" ? 1.24 : input.mediaKind === "video" ? 1.12 : 0.92;
  const colorFactor = 0.65 + clamp(input.colors, 3, 256) / 256 * 0.55;
  const rawComplexityBytes = outputPixels * clamp(input.outputFps, 1, 60) * duration * alphaFactor * motionFactor * colorFactor * 0.055;
  const pressureScore = clamp(rawComplexityBytes / targetBytes, 0.05, 20);
  const pressure = pressureScore < 0.7 ? "low" : pressureScore < 1.6 ? "medium" : pressureScore < 3.2 ? "high" : "extreme";
  const contentClass = classifyContent(input);
  const targetPreference = preferenceFor(input, contentClass);
  const perceptualFocus = focusFor(input, contentClass);
  const canHoldStaticFrames = !["high_motion", "transparent_asset"].includes(contentClass) && input.priority !== "motion";
  const timelinePolicy: VolumeDirectorTimelinePolicy = pressure === "low"
    ? "full_cfr"
    : canHoldStaticFrames
      ? pressure === "extreme" || contentClass === "screen_ui" ? "static_hold" : "motion_protected_drop_hold"
      : "motion_protected_drop_hold";

  let widthScale = 1;
  let fpsScale = 1;
  let colorScale = 1;
  let extraLossy = 0;
  if (pressure === "low") {
    // A comfortable budget must not trigger speculative degradation. The
    // backend still verifies the target with real candidate encodes.
  } else if (input.priority === "smallest") {
    widthScale = pressure === "extreme" ? 0.68 : 0.78;
    fpsScale = 0.68;
    colorScale = 0.72;
    extraLossy = 18;
  } else if (input.priority === "motion" || targetPreference === "smoothness") {
    widthScale = pressure === "extreme" ? 0.72 : pressure === "high" ? 0.84 : 1;
    colorScale = pressure === "extreme" ? 0.78 : 0.9;
    extraLossy = pressure === "extreme" ? 12 : 5;
  } else if (input.priority === "text" || contentClass === "screen_ui") {
    fpsScale = pressure === "extreme" ? 0.58 : pressure === "high" ? 0.72 : 0.88;
    widthScale = pressure === "extreme" ? 0.88 : 1;
    extraLossy = pressure === "extreme" ? 5 : 0;
  } else if (input.priority === "clarity" || targetPreference === "clarity") {
    fpsScale = pressure === "extreme" ? 0.66 : pressure === "high" ? 0.82 : 1;
    widthScale = pressure === "extreme" ? 0.88 : 1;
    colorScale = 1;
  } else if (pressure === "extreme") {
    widthScale = 0.78;
    fpsScale = 0.72;
    colorScale = 0.82;
    extraLossy = 10;
  } else if (pressure === "high") {
    widthScale = 0.9;
    fpsScale = 0.84;
    colorScale = 0.9;
    extraLossy = 5;
  }

  const suggestedWidth = even(clamp(input.outputWidth * widthScale, 96, input.outputWidth));
  const suggestedFps = Math.round(clamp(input.outputFps * fpsScale, contentClass === "high_motion" ? 10 : 5, input.outputFps));
  const minimumColors = Math.min(input.colors, contentClass === "screen_ui" || input.hasAlpha ? 128 : 48);
  const suggestedColors = Math.round(clamp(input.colors * colorScale, minimumColors, input.colors));
  const suggestedLossy = Math.round(clamp(input.lossy + extraLossy, 0, 100));
  const savingsBase = timelinePolicy === "static_hold" ? 24 : timelinePolicy === "motion_protected_drop_hold" ? 14 : 4;
  const spatialSaving = Math.round((1 - widthScale * widthScale) * 100);
  const fpsSaving = Math.round((1 - fpsScale) * 70);
  const estimated = clamp(savingsBase + spatialSaving + fpsSaving + extraLossy * 0.5, 3, 78);
  const protectedSignals = [
    contentClass === "screen_ui" ? "文字与细线" : contentClass === "high_motion" ? "动作连续性" : "主体边缘",
    input.hasAlpha ? "透明边缘" : "高对比边缘",
    perceptualFocus === "motion" ? "运动峰值" : perceptualFocus === "text_ui" ? "界面可读性" : "视觉主体",
  ];
  const tradeoffs: string[] = [];
  if (suggestedWidth < input.outputWidth) tradeoffs.push(`宽度上限 ${input.outputWidth}px → ${suggestedWidth}px`);
  if (suggestedFps < input.outputFps) tradeoffs.push(`帧率上限 ${input.outputFps} → ${suggestedFps} FPS`);
  if (suggestedColors < input.colors) tradeoffs.push(`颜色上限 ${input.colors} → ${suggestedColors}`);
  if (!tradeoffs.length) tradeoffs.push("保留当前尺寸、帧率与颜色上限");
  const contentLabels: Record<VolumeDirectorContentClass, string> = {
    screen_ui: "界面与文字",
    flat_art: "扁平插画",
    photographic: "实拍与渐变",
    high_motion: "高运动",
    transparent_asset: "透明动图",
  };
  const timelineLabels: Record<VolumeDirectorTimelinePolicy, string> = {
    full_cfr: "完整帧率",
    motion_protected_drop_hold: "运动保护型变帧",
    static_hold: "静止帧延时复用",
  };

  return {
    planId: `vd1-${contentClass}-${input.priority}-${pressure}`,
    contentClass,
    contentLabel: contentLabels[contentClass],
    pressure,
    pressureScore,
    targetPreference,
    perceptualFocus,
    timelinePolicy,
    timelineLabel: timelineLabels[timelinePolicy],
    maxAttempts: pressure === "extreme" ? 12 : pressure === "high" ? 10 : 8,
    suggestedWidth,
    suggestedFps,
    suggestedColors,
    suggestedLossy,
    dither: contentClass === "photographic" && pressure !== "extreme" ? "sierra2_4a" : "bayer",
    estimatedSavingsPercent: [Math.max(1, Math.round(estimated * 0.7)), Math.min(85, Math.round(estimated * 1.18))],
    protectedSignals,
    tradeoffs,
    reasons: [
      `${contentLabels[contentClass]}素材，体积压力为${pressure === "extreme" ? "极高" : pressure === "high" ? "高" : pressure === "medium" ? "中等" : "低"}`,
      `${timelineLabels[timelinePolicy]}优先把字节让给${protectedSignals[0]}`,
      `使用 ${targetPreference === "smoothness" ? "流畅度" : targetPreference === "clarity" ? "清晰度" : targetPreference === "smallest" ? "最小体积" : "均衡"} Pareto 选择策略`,
    ],
  };
}
