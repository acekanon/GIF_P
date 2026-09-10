import type {
  FilterStyle,
  GifEncoder,
  GifGenerationMode,
  GifRequest,
  OutputFormat,
  PerceptualFocus,
  TargetPreference,
} from "../tauri";

export type CropInsets = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Point = { x: number; y: number };

export type CompressionPresetId =
  | "tiny"
  | "perceptual"
  | "clean_noise"
  | "clean"
  | "meme"
  | "vertical"
  | "wechat"
  | "qq"
  | "bili"
  | "custom";

export type CompressionPreset = {
  id: CompressionPresetId;
  label: string;
  description: string;
  route: string;
  width: number;
  fps: number;
  colors: number;
  dither: DitherId;
  lossy: number;
  optimizeLevel: number;
  encoder: GifEncoder;
  filter: FilterStyle;
  estimateFactor: number;
  preview: string;
  still: string;
};

export type DitherId = "sierra2_4a" | "floyd_steinberg" | "bayer" | "none";

export const GENERATION_MODE_OPTIONS: Array<{ value: GifGenerationMode; label: string; description: string }> = [
  { value: "fast_gif", label: "快速 GIF", description: "优先生成速度，适合快速分享" },
  { value: "best_gif", label: "最佳 GIF", description: "优先画面质量，适合正式输出" },
  { value: "target_size", label: "精确体积", description: "设置文件大小上限" },
];

export const GIF_ENCODER_OPTIONS: Array<{ value: GifEncoder; label: string; note: string }> = [
  { value: "ffmpeg_fast", label: "保持原貌", note: "不额外启用色彩增强与降噪；仍会进行 GIF 调色" },
  { value: "pngquant_opt", label: "色彩增强", note: "调整色彩并轻度降噪；可能改变原有颜色" },
  { value: "hybrid", label: "自动选择", note: "根据当前帧率和颜色上限选择处理偏好" },
  { value: "clean_opt", label: "降噪平滑", note: "减轻颗粒与色带；可能损失细小纹理" },
];

export const FILTER_OPTIONS: Array<{ value: FilterStyle; label: string }> = [
  { value: "none", label: "原味" },
  { value: "vivid", label: "鲜亮抗灰" },
  { value: "warm_skin", label: "暖肤柔光" },
  { value: "cool_tone", label: "清冷蓝调" },
  { value: "mono_contrast", label: "高反差黑白" },
  { value: "vintage_film", label: "复古胶片" },
  { value: "soft_matte", label: "柔和哑光" },
  { value: "comic_ink", label: "漫画锐线" },
  { value: "gb", label: "GB 绿屏" },
  { value: "gba_lcd", label: "GBA LCD" },
  { value: "crt", label: "CRT 扫描线" },
  { value: "pixel", label: "像素海报" },
];

export const DITHER_OPTIONS: Array<{ value: DitherId; label: string }> = [
  { value: "sierra2_4a", label: "Sierra 高质量" },
  { value: "floyd_steinberg", label: "Floyd 细节" },
  { value: "bayer", label: "Bayer 小体积" },
  { value: "none", label: "无抖动" },
];

export const COMPRESSION_PRESETS: CompressionPreset[] = [
  {
    id: "tiny",
    label: "极小包",
    description: "聊天秒发，体积压到底",
    route: "快速矩形差分 / 低色强压",
    width: 280,
    fps: 8,
    colors: 24,
    dither: "bayer",
    lossy: 86,
    optimizeLevel: 3,
    encoder: "ffmpeg_fast",
    filter: "pixel",
    estimateFactor: 0.28,
    preview: "/preset-previews/tiny.gif",
    still: "/preset-previews/tiny.jpg",
  },
  {
    id: "perceptual",
    label: "观感优先",
    description: "色彩更亮，少灰雾",
    route: "全局调色 / Sierra 抖动",
    width: 420,
    fps: 15,
    colors: 256,
    dither: "sierra2_4a",
    lossy: 28,
    optimizeLevel: 3,
    encoder: "pngquant_opt",
    filter: "vivid",
    estimateFactor: 1,
    preview: "/preset-previews/perceptual.gif",
    still: "/preset-previews/perceptual.jpg",
  },
  {
    id: "clean_noise",
    label: "低噪干净",
    description: "少颗粒，适合纯色和皮肤",
    route: "全局调色 / 无抖动 / 轻降噪",
    width: 420,
    fps: 12,
    colors: 256,
    dither: "none",
    lossy: 18,
    optimizeLevel: 3,
    encoder: "clean_opt",
    filter: "none",
    estimateFactor: 0.83,
    preview: "/preset-previews/clean_noise.gif",
    still: "/preset-previews/clean_noise.jpg",
  },
  {
    id: "clean",
    label: "字幕保真",
    description: "界面录屏、字幕与细线条",
    route: "混合策略 / Floyd 细节保护",
    width: 560,
    fps: 18,
    colors: 256,
    dither: "floyd_steinberg",
    lossy: 10,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "none",
    estimateFactor: 1.41,
    preview: "/preset-previews/clean.gif",
    still: "/preset-previews/clean.jpg",
  },
  {
    id: "meme",
    label: "表情包",
    description: "动作优先，轮廓更硬",
    route: "低帧高损 / 轮廓鲜明",
    width: 360,
    fps: 8,
    colors: 32,
    dither: "bayer",
    lossy: 78,
    optimizeLevel: 3,
    encoder: "ffmpeg_fast",
    filter: "vivid",
    estimateFactor: 0.38,
    preview: "/preset-previews/meme.gif",
    still: "/preset-previews/meme.jpg",
  },
  {
    id: "vertical",
    label: "竖屏短视频",
    description: "9:16 预览和导出更顺手",
    route: "竖屏友好 / 保持原比例",
    width: 360,
    fps: 15,
    colors: 192,
    dither: "sierra2_4a",
    lossy: 34,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "vivid",
    estimateFactor: 0.98,
    preview: "/preset-previews/vertical.gif",
    still: "/preset-previews/vertical.jpg",
  },
  {
    id: "wechat",
    label: "微信表情",
    description: "小尺寸、平台友好",
    route: "平台预设 / 小图低色",
    width: 240,
    fps: 8,
    colors: 32,
    dither: "sierra2_4a",
    lossy: 72,
    optimizeLevel: 3,
    encoder: "ffmpeg_fast",
    filter: "vivid",
    estimateFactor: 0.31,
    preview: "/preset-previews/wechat.gif",
    still: "/preset-previews/wechat.jpg",
  },
  {
    id: "qq",
    label: "QQ 聊天",
    description: "清晰度和体积折中",
    route: "智能混合 / 中色中帧",
    width: 360,
    fps: 12,
    colors: 64,
    dither: "sierra2_4a",
    lossy: 46,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "vivid",
    estimateFactor: 0.71,
    preview: "/preset-previews/qq.gif",
    still: "/preset-previews/qq.jpg",
  },
  {
    id: "bili",
    label: "B 站移动",
    description: "移动端预览更饱满",
    route: "全局调色 / 高色平台图",
    width: 480,
    fps: 15,
    colors: 256,
    dither: "sierra2_4a",
    lossy: 24,
    optimizeLevel: 3,
    encoder: "pngquant_opt",
    filter: "vivid",
    estimateFactor: 1.17,
    preview: "/preset-previews/bili.gif",
    still: "/preset-previews/bili.jpg",
  },
  {
    id: "custom",
    label: "自定义",
    description: "使用已保存的精细参数",
    route: "完整参数手动控制",
    width: 420,
    fps: 15,
    colors: 256,
    dither: "sierra2_4a",
    lossy: 28,
    optimizeLevel: 3,
    encoder: "hybrid",
    filter: "vivid",
    estimateFactor: 1,
    preview: "/preset-previews/perceptual.gif",
    still: "/preset-previews/perceptual.jpg",
  },
];

export const CANDIDATE_PRESET_IDS: CompressionPresetId[] = ["clean", "perceptual", "tiny"];

export type FormatPresetSource = {
  width?: number;
  fps?: number;
};

const MODERN_PRESET_BASELINES: Record<Exclude<CompressionPresetId, "custom">, { width: number; fps: number; webpLossy: number; avifLossy: number }> = {
  tiny: { width: 480, fps: 12, webpLossy: 46, avifLossy: 90 },
  perceptual: { width: 720, fps: 24, webpLossy: 14, avifLossy: 50 },
  clean_noise: { width: 720, fps: 20, webpLossy: 8, avifLossy: 40 },
  clean: { width: 960, fps: 24, webpLossy: 4, avifLossy: 30 },
  meme: { width: 480, fps: 15, webpLossy: 28, avifLossy: 70 },
  vertical: { width: 720, fps: 24, webpLossy: 16, avifLossy: 50 },
  wechat: { width: 320, fps: 12, webpLossy: 30, avifLossy: 80 },
  qq: { width: 480, fps: 15, webpLossy: 22, avifLossy: 70 },
  bili: { width: 720, fps: 24, webpLossy: 14, avifLossy: 50 },
};

/**
 * GIF presets are intentionally palette/size constrained. Modern delivery
 * formats need their own spatial, temporal, and color defaults instead of
 * inheriting those GIF ceilings.
 */
export function presetForOutputFormat(
  preset: CompressionPreset,
  format: OutputFormat,
  source: FormatPresetSource = {},
): CompressionPreset {
  if ((format !== "webp" && format !== "avif" && format !== "apng") || preset.id === "custom") return preset;
  const modern = MODERN_PRESET_BASELINES[preset.id];
  const sourceWidth = Number.isFinite(source.width) && (source.width ?? 0) > 0
    ? Math.max(96, Math.floor(source.width! / 2) * 2)
    : null;
  const sourceFps = Number.isFinite(source.fps) && (source.fps ?? 0) > 0
    ? clamp(Math.floor(source.fps!), 1, 60)
    : null;
  const requestedWidth = modern.width;
  const requestedFps = modern.fps;
  return {
    ...preset,
    width: sourceWidth === null ? requestedWidth : Math.min(requestedWidth, sourceWidth),
    fps: sourceFps === null ? requestedFps : Math.min(requestedFps, sourceFps),
    lossy: format === "apng" ? 0 : format === "avif" ? modern.avifLossy : modern.webpLossy,
    route: format === "webp"
      ? "真彩高分辨率 / WebP 质量编码"
      : format === "avif"
        ? "AV1 图像序列 / AVIF 体积优先编码"
      : format === "apng"
        ? "RGBA 真彩 / APNG 无损编码"
        : preset.route,
  };
}

export type TargetPortfolioRole = "clearest" | "smoothest" | "smallest";

export type TargetPortfolioProfile = {
  role: TargetPortfolioRole;
  label: string;
  presetId: CompressionPresetId;
  targetPreference: Exclude<TargetPreference, "auto">;
  width: number;
  fps: number;
  colors: number;
  targetSizeBytes: number;
  budgetRatio: number;
};

export type TargetPortfolioInput = {
  width: number;
  fps: number;
  colors: number;
  targetSizeBytes: number;
  sourceFps?: number;
};

const evenDimension = (value: number) => Math.max(96, Math.round(value / 2) * 2);

export function buildTargetPortfolioProfiles(input: TargetPortfolioInput): TargetPortfolioProfile[] {
  const width = evenDimension(clamp(Math.round(input.width), 96, 1920));
  const fps = clamp(Math.round(input.fps), 1, 60);
  const colors = clamp(Math.round(input.colors), 3, 256);
  const targetSizeBytes = Math.max(64 * 1024, Math.round(input.targetSizeBytes));
  const sourceFps = Number.isFinite(input.sourceFps) && (input.sourceFps ?? 0) > 0
    ? clamp(Math.floor(input.sourceFps!), 1, 60)
    : 60;
  const smoothFps = Math.max(fps, Math.min(sourceFps, clamp(Math.ceil(fps * 1.35), 1, 60)));

  return [
    {
      role: "clearest",
      label: "最清晰",
      presetId: "clean",
      targetPreference: "clarity",
      width,
      fps: Math.max(4, Math.round(fps * 0.72)),
      colors,
      targetSizeBytes,
      budgetRatio: 1,
    },
    {
      role: "smoothest",
      label: "最流畅",
      presetId: "perceptual",
      targetPreference: "smoothness",
      width: evenDimension(width * 0.78),
      fps: smoothFps,
      colors: clamp(Math.round(colors * 0.78), 3, 256),
      targetSizeBytes,
      budgetRatio: 1,
    },
    {
      role: "smallest",
      label: "最小体积",
      presetId: "tiny",
      targetPreference: "smallest",
      width: evenDimension(width * 0.65),
      fps: Math.max(3, Math.round(fps * 0.6)),
      colors: clamp(Math.round(colors * 0.55), 3, 256),
      targetSizeBytes: Math.max(64 * 1024, Math.round(targetSizeBytes * 0.72)),
      budgetRatio: 0.72,
    },
  ];
}

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const round = (value: number) => Number(value.toFixed(4));
const MIN_CROP_SIZE = 4;

function normalizeCropAxis(startValue: number, endValue: number): [number, number] {
  let start = clamp(startValue, 0, 100 - MIN_CROP_SIZE);
  let end = clamp(endValue, 0, 100 - MIN_CROP_SIZE);
  const totalInsets = start + end;
  if (totalInsets > 100 - MIN_CROP_SIZE) {
    const scale = (100 - MIN_CROP_SIZE) / totalInsets;
    start = round(start * scale);
    end = round(100 - MIN_CROP_SIZE - start);
  }
  return [start, end];
}

export function rectFromDrag(start: Point, current: Point): CropRect {
  const x1 = clamp(start.x);
  const y1 = clamp(start.y);
  const x2 = clamp(current.x);
  const y2 = clamp(current.y);
  return {
    x: round(Math.min(x1, x2)),
    y: round(Math.min(y1, y2)),
    width: round(Math.abs(x2 - x1)),
    height: round(Math.abs(y2 - y1)),
  };
}

export function insetsToRect(insets: CropInsets): CropRect {
  const left = clamp(insets.left);
  const top = clamp(insets.top);
  const right = clamp(insets.right, 0, 100 - left);
  const bottom = clamp(insets.bottom, 0, 100 - top);
  return {
    x: round(left),
    y: round(top),
    width: round(100 - left - right),
    height: round(100 - top - bottom),
  };
}

export function rectToInsets(rect: CropRect): CropInsets {
  const x = clamp(rect.x);
  const y = clamp(rect.y);
  const width = clamp(rect.width, 0, 100 - x);
  const height = clamp(rect.height, 0, 100 - y);
  return {
    left: round(x),
    top: round(y),
    right: round(100 - x - width),
    bottom: round(100 - y - height),
  };
}

export function outputFrameIndexForSourceTime(
  sourceTime: number,
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  fps: number,
): number | null {
  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
  const speed = Number.isFinite(playbackSpeed) ? clamp(playbackSpeed, 1, 3) : 1;
  const outputFps = Number.isFinite(fps) ? clamp(Math.round(fps), 1, 60) : 1;
  const outputTime = (sourceTime - start) / speed;
  if (!Number.isFinite(outputTime) || outputTime < 0) return null;
  let frameCount: number | null = null;
  if (Number.isFinite(endSeconds) && endSeconds > start) {
    const endLimit = (endSeconds - start) / speed;
    if (outputTime >= endLimit) return null;
    frameCount = Math.round(endLimit * outputFps);
    if (frameCount < 1) return null;
  }
  const index = Math.round(outputTime * outputFps);
  return frameCount === null ? index : Math.min(index, frameCount - 1);
}

export function normalizeDeletedFrameTimes(
  sourceTimes: number[],
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  fps: number,
): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const sourceTime of sourceTimes) {
    const index = outputFrameIndexForSourceTime(
      sourceTime,
      startSeconds,
      endSeconds,
      playbackSpeed,
      fps,
    );
    if (index === null || seen.has(index)) continue;
    seen.add(index);
    normalized.push(sourceTime);
  }
  return normalized;
}

export type DeletedTimelineRange = {
  start_seconds: number;
  end_seconds: number;
};

export type FrameTimingMode = "compact" | "preserve";

export type EditableOutputFrame = {
  index: number;
  sourceTime: number;
  outputTime: number;
};

export type TimelineFrameDot = {
  firstIndex: number;
  lastIndex: number;
  representativeIndex: number;
  representativeOutputIndex: number;
  removed: boolean;
  partiallyRemoved: boolean;
};

export function timelineFrameDots(
  frameCount: number,
  deletedIndices: number[],
  timingMode: FrameTimingMode,
  maxDots = 180,
): TimelineFrameDot[] {
  const total = Math.max(0, Math.floor(frameCount));
  if (!total) return [];
  const deleted = new Set(deletedIndices.filter((index) => (
    Number.isInteger(index) && index >= 0 && index < total
  )));
  const visibleIndices = Array.from({ length: total }, (_, index) => index)
    .filter((index) => timingMode === "preserve" || !deleted.has(index));
  if (!visibleIndices.length) return [];
  const dotLimit = clamp(Math.floor(maxDots), 1, 600);
  const dotCount = Math.min(dotLimit, visibleIndices.length);
  return Array.from({ length: dotCount }, (_, dotIndex) => {
    const firstPosition = Math.floor((dotIndex * visibleIndices.length) / dotCount);
    const nextPosition = Math.floor(((dotIndex + 1) * visibleIndices.length) / dotCount);
    const lastPosition = Math.max(firstPosition, nextPosition - 1);
    const representativePosition = Math.floor((firstPosition + lastPosition) / 2);
    const bucket = visibleIndices.slice(firstPosition, lastPosition + 1);
    const removedCount = bucket.filter((index) => deleted.has(index)).length;
    return {
      firstIndex: bucket[0],
      lastIndex: bucket[bucket.length - 1],
      representativeIndex: visibleIndices[representativePosition],
      representativeOutputIndex: timingMode === "preserve"
        ? visibleIndices[representativePosition]
        : representativePosition,
      removed: removedCount === bucket.length,
      partiallyRemoved: removedCount > 0 && removedCount < bucket.length,
    };
  });
}

export function outputFrameCountForTimeline(
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  fps: number,
) {
  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
  const end = Number.isFinite(endSeconds) && endSeconds > start ? endSeconds : start;
  const speed = Number.isFinite(playbackSpeed) ? clamp(playbackSpeed, 1, 3) : 1;
  const outputFps = Number.isFinite(fps) ? clamp(Math.round(fps), 1, 60) : 1;
  return Math.max(0, Math.round(((end - start) / speed) * outputFps));
}

export function sourceTimeForOutputFrameIndex(
  index: number,
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  fps: number,
): number | null {
  const frameCount = outputFrameCountForTimeline(
    startSeconds,
    endSeconds,
    playbackSpeed,
    fps,
  );
  if (!Number.isInteger(index) || index < 0 || index >= frameCount) return null;
  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
  const speed = Number.isFinite(playbackSpeed) ? clamp(playbackSpeed, 1, 3) : 1;
  const outputFps = Number.isFinite(fps) ? clamp(Math.round(fps), 1, 60) : 1;
  return Number((start + (index * speed) / outputFps).toFixed(6));
}

export function editableOutputFramePage(
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  fps: number,
  pageStart: number,
  pageSize: number,
): EditableOutputFrame[] {
  const frameCount = outputFrameCountForTimeline(
    startSeconds,
    endSeconds,
    playbackSpeed,
    fps,
  );
  const first = clamp(Math.floor(pageStart), 0, frameCount);
  const count = clamp(Math.floor(pageSize), 0, 120);
  const last = Math.min(frameCount, first + count);
  const outputFps = Number.isFinite(fps) ? clamp(Math.round(fps), 1, 60) : 1;
  return Array.from({ length: Math.max(0, last - first) }, (_, offset) => {
    const index = first + offset;
    return {
      index,
      sourceTime: sourceTimeForOutputFrameIndex(
        index,
        startSeconds,
        endSeconds,
        playbackSpeed,
        outputFps,
      ) ?? 0,
      outputTime: Number((index / outputFps).toFixed(6)),
    };
  });
}

export function outputFrameIndicesForSourceTimes(
  sourceTimes: number[],
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  fps: number,
) {
  return [...new Set(sourceTimes.flatMap((time) => {
    const index = outputFrameIndexForSourceTime(
      time,
      startSeconds,
      endSeconds,
      playbackSpeed,
      fps,
    );
    return index === null ? [] : [index];
  }))].sort((left, right) => left - right);
}

export function deletedFrameSourceRanges(
  sourceTimes: number[],
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  fps: number,
): DeletedTimelineRange[] {
  const indices = outputFrameIndicesForSourceTimes(
    sourceTimes,
    startSeconds,
    endSeconds,
    playbackSpeed,
    fps,
  );
  if (!indices.length) return [];
  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
  const end = Number.isFinite(endSeconds) && endSeconds > start ? endSeconds : start;
  const speed = Number.isFinite(playbackSpeed) ? clamp(playbackSpeed, 1, 3) : 1;
  const outputFps = Number.isFinite(fps) ? clamp(Math.round(fps), 1, 60) : 1;
  const ranges: Array<[number, number]> = [];
  for (const index of indices) {
    const previous = ranges[ranges.length - 1];
    if (previous && index === previous[1] + 1) previous[1] = index;
    else ranges.push([index, index]);
  }
  return ranges.map(([first, last]) => ({
    start_seconds: Number((start + (first * speed) / outputFps).toFixed(6)),
    end_seconds: Number(Math.min(end, start + ((last + 1) * speed) / outputFps).toFixed(6)),
  })).filter((range) => range.end_seconds > range.start_seconds);
}

export function manualSampleDeletedFrameIndices(
  frameCount: number,
  keepEvery: number,
  scopeIndices?: number[],
) {
  const total = Math.max(0, Math.floor(frameCount));
  const stride = clamp(Math.floor(keepEvery), 2, 60);
  const scope = [...new Set((scopeIndices?.length
    ? scopeIndices
    : Array.from({ length: total }, (_, index) => index))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < total))]
    .sort((left, right) => left - right);
  if (scope.length <= 1) return [];
  const lastScopePosition = scope.length - 1;
  return scope.filter((index, position) => (
    position % stride !== 0
    && position !== lastScopePosition
    && index !== 0
    && index !== total - 1
  ));
}

export function compactedOutputTimeForSourceTime(
  sourceTime: number,
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  deletedRanges: DeletedTimelineRange[],
): number | null {
  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
  const end = Number.isFinite(endSeconds) && endSeconds > start ? endSeconds : start;
  if (!Number.isFinite(sourceTime) || sourceTime < start || sourceTime > end) return null;
  const clampedSource = Math.min(sourceTime, end);
  const removedBefore = deletedRanges.reduce((total, range) => {
    const overlapStart = Math.max(start, range.start_seconds);
    const overlapEnd = Math.min(clampedSource, end, range.end_seconds);
    return total + Math.max(0, overlapEnd - overlapStart);
  }, 0);
  const speed = Number.isFinite(playbackSpeed) ? clamp(playbackSpeed, 1, 3) : 1;
  return round(Math.max(0, clampedSource - start - removedBefore) / speed);
}

export function normalizeTimelineSampleTimes(
  times: number[],
  startSeconds: number,
  endSeconds: number,
) {
  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
  const end = Number.isFinite(endSeconds) && endSeconds > start ? endSeconds : start;
  return times.filter((time, index, items) =>
    Number.isFinite(time)
    && time >= start
    && time < end
    && items.findIndex((candidate) => Math.abs(candidate - time) < 0.001) === index
  );
}

export function deletedTimelineRanges(
  deletedSampleTimes: number[],
  timelineSampleTimes: number[],
  startSeconds: number,
  endSeconds: number,
): DeletedTimelineRange[] {
  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
  const end = Number.isFinite(endSeconds) && endSeconds > start ? endSeconds : start;
  if (end <= start) return [];
  const samples = [...new Set(timelineSampleTimes.filter(Number.isFinite))].sort((left, right) => left - right);
  const deleted = new Set(deletedSampleTimes.filter(Number.isFinite).map((time) => samples.findIndex((sample) => Math.abs(sample - time) < 0.001)).filter((index) => index >= 0));
  const ranges = [...deleted].map((index) => {
    const sample = samples[index];
    const previous = samples[index - 1];
    const next = samples[index + 1];
    const rangeStart = previous == null ? start : (previous + sample) / 2;
    const rangeEnd = next == null ? end : (sample + next) / 2;
    return {
      start_seconds: Math.max(start, Math.min(end, rangeStart)),
      end_seconds: Math.max(start, Math.min(end, rangeEnd)),
    };
  }).filter((range) => range.end_seconds - range.start_seconds > 0.0001)
    .sort((left, right) => left.start_seconds - right.start_seconds);
  const merged: DeletedTimelineRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start_seconds <= previous.end_seconds + 0.0001) {
      previous.end_seconds = Math.max(previous.end_seconds, range.end_seconds);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function nextPlayableSourceTime(
  sourceTime: number,
  ranges: DeletedTimelineRange[],
  startSeconds: number,
  endSeconds: number,
) {
  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
  const end = Number.isFinite(endSeconds) && endSeconds > start ? endSeconds : start;
  if (end <= start) return null;
  let candidate = Math.max(start, Number.isFinite(sourceTime) ? sourceTime : start);
  for (const range of ranges) {
    const rangeStart = Math.max(start, range.start_seconds);
    const rangeEnd = Math.min(end, range.end_seconds);
    if (rangeEnd <= rangeStart || candidate < rangeStart - 0.001) continue;
    if (candidate < rangeEnd - 0.001) candidate = rangeEnd;
  }
  return candidate < end - 0.001 ? candidate : null;
}

export function outputFrameIndicesForDeletedRanges(
  ranges: DeletedTimelineRange[],
  startSeconds: number,
  endSeconds: number,
  playbackSpeed: number,
  fps: number,
) {
  const start = Math.max(0, startSeconds);
  const end = endSeconds > start ? endSeconds : start;
  const speed = Math.max(1, playbackSpeed);
  const outputFps = Math.max(1, fps);
  const frameCount = Math.max(0, Math.round(((end - start) / speed) * outputFps));
  const indices = new Set<number>();
  for (const range of ranges) {
    const rangeStart = Math.max(start, range.start_seconds);
    const rangeEnd = Math.min(end, range.end_seconds);
    if (rangeEnd <= rangeStart) continue;
    const first = Math.ceil(((rangeStart - start) / speed) * outputFps);
    const endExclusive = Math.ceil(((rangeEnd - start) / speed) * outputFps);
    for (let index = first; index < Math.min(frameCount, endExclusive); index += 1) indices.add(index);
  }
  return [...indices].sort((left, right) => left - right);
}

export type BuildGifRequestInput = {
  smartLossless?: boolean;
  smallerGif?: boolean;
  indexCompression?: boolean;
  gentleIndex?: boolean;
  mergeGifFrames?: boolean;
  compactGifPalette?: boolean;
  inputPath: string;
  outputDir: string;
  presetId: CompressionPresetId;
  playbackSpeed: number;
  loopOutput: boolean;
  crop: CropInsets;
  startSeconds: number;
  endSeconds: number;
  deletedFrames: number[];
  deletedRanges?: DeletedTimelineRange[];
  frameTimingMode?: FrameTimingMode;
  generationMode?: GifGenerationMode;
  targetSizeBytes?: number | null;
  targetTolerancePercent?: number;
  targetMaxAttempts?: number;
  targetPreference?: TargetPreference;
  bayerScale?: number;
  alphaThreshold?: number;
  allowExperimental?: boolean;
  perceptualFocus?: PerceptualFocus;
  outputFormat?: OutputFormat;
  memeOverlay?: GifRequest["meme_overlay"];
  backgroundRemoval?: GifRequest["background_removal"];
  trackedEffects?: GifRequest["tracked_effects"];
  overrides?: Partial<Pick<GifRequest, "width" | "fps" | "colors" | "dither" | "lossy" | "encoder" | "filter_style" | "optimize_level">>;
};

export function buildGifRequest(input: BuildGifRequestInput): GifRequest {
  const preset = COMPRESSION_PRESETS.find((item) => item.id === input.presetId) ?? COMPRESSION_PRESETS[1];
  const requestFps = input.overrides?.fps ?? preset.fps;
  const [left, right] = normalizeCropAxis(input.crop.left, input.crop.right);
  const [top, bottom] = normalizeCropAxis(input.crop.top, input.crop.bottom);
  const crop = {
    left,
    top,
    right,
    bottom,
  };
  const cropEnabled = Object.values(crop).some((value) => value > 0.01);

  return {
    ...(input.smallerGif && (input.outputFormat ?? "gif") === "gif" ? { smaller_gif: true } : {}),
    ...(input.smartLossless && (input.outputFormat ?? "gif") === "gif" ? { smart_lossless: true } : {}),
    ...(input.indexCompression && (input.outputFormat ?? "gif") === "gif" ? { index_compression: true } : {}),
    ...(input.indexCompression && input.gentleIndex && (input.outputFormat ?? "gif") === "gif" ? { index_compression_gentle: true } : {}),
    ...(input.mergeGifFrames && (input.outputFormat ?? "gif") === "gif" ? { gif_merge_frames: true } : {}),
    ...(input.compactGifPalette && (input.outputFormat ?? "gif") === "gif" ? { gif_compact_palette: true } : {}),
    schema_version: 1,
    input_path: input.inputPath,
    output_dir: input.outputDir,
    width: input.overrides?.width ?? preset.width,
    fps: requestFps,
    colors: clamp(input.overrides?.colors ?? preset.colors, 3, 256),
    dither: input.overrides?.dither ?? preset.dither,
    optimize_level: input.overrides?.optimize_level ?? preset.optimizeLevel,
    lossy: input.overrides?.lossy ?? preset.lossy,
    start_seconds: Math.max(0, input.startSeconds),
    end_seconds: Math.max(0, input.endSeconds),
    encoder: input.overrides?.encoder ?? preset.encoder,
    filter_style: input.overrides?.filter_style ?? preset.filter,
    loop_output: input.loopOutput,
    crop_enabled: cropEnabled,
    crop_left: crop.left,
    crop_top: crop.top,
    crop_right: crop.right,
    crop_bottom: crop.bottom,
    deleted_frames: normalizeDeletedFrameTimes(
      input.deletedFrames,
      input.startSeconds,
      input.endSeconds,
      input.playbackSpeed,
      requestFps,
    ),
    deleted_ranges: input.deletedRanges ?? [],
    frame_timing_mode: input.frameTimingMode ?? "compact",
    playback_speed: input.playbackSpeed,
    output_format: input.outputFormat ?? "gif",
    generation_mode: input.generationMode ?? (preset.encoder === "ffmpeg_fast" ? "fast_gif" : "best_gif"),
    target_size_bytes: input.targetSizeBytes == null ? null : Math.max(64 * 1024, Math.round(input.targetSizeBytes)),
    target_tolerance_percent: clamp(input.targetTolerancePercent ?? 5, 1, 25),
    target_max_attempts: clamp(Math.round(input.targetMaxAttempts ?? 8), 1, 12),
    target_preference: input.targetPreference ?? "auto",
    target_constraint: "hard_cap",
    bayer_scale: clamp(Math.round(input.bayerScale ?? 2), 0, 5),
    alpha_threshold: clamp(Math.round(input.alphaThreshold ?? 128), 0, 255),
    allow_experimental: input.allowExperimental ?? false,
    perceptual_focus: input.perceptualFocus ?? "auto",
    meme_overlay: input.memeOverlay ?? null,
    background_removal: input.backgroundRemoval ?? null,
    tracked_effects: input.trackedEffects ?? [],
  };
}
