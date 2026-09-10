import "@fontsource-variable/nunito";
import { PRODUCT_VERSION } from "../version";
import {
  ArrowDown,
  ArrowUp,
  ArrowsClockwise,
  Check,
  CheckCircle,
  Copy,
  Crop,
  FilmStrip,
  FloppyDisk,
  FolderOpen,
  GearSix,
  HandPointing,
  Images,
  MagicWand,
  MagnifyingGlassPlus,
  Monitor,
  Pause,
  Play,
  Plus,
  Scissors,
  SlidersHorizontal,
  Smiley,
  Sparkle,
  Stack,
  TextT,
  Trash,
  UploadSimple,
  VideoCamera,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelConversionTask,
  convertAnimation,
  evaluateOutputQuality,
  generateFramePage,
  generateMediaThumbnails,
  getRuntimeResourceSnapshot,
  inspectMedia,
  listEncoderCapabilities,
  mergeGif,
  openDirectory,
  selectOutputDir,
  selectScreenRegion,
  selectVideos,
  startScreenRecording,
  stopScreenRecording,
  trackMediaRegion,
  type FilterStyle,
  type BackendCapability,
  type BackgroundRemovalRequest,
  type DeliveryIntent,
  type GifEncoder,
  type GifGenerationMode,
  type GifRequest,
  type GifResult,
  type LivePhotoResult,
  type MediaInspection,
  type OutputFormat,
  type OutputQualityReport,
  type PerceptualFocus,
  type RuntimeResourceSnapshot,
  type TargetRouteObservationReport,
  type TargetPlatform,
  type TrackedEffectRequest,
} from "../tauri";
import { CompressionPresetSelect } from "./CompressionPresetSelect";
import { CropBox } from "./CropBox";
import { AnimatedSelect } from "./AnimatedSelect";
import { CollapsibleSection } from "./CollapsibleSection";
import { EnergyProgress } from "./EnergyProgress";
import { PlaybackSpeedControl } from "./PlaybackSpeedControl";
import { TrimRange } from "./TrimRange";
import { AnimatedMediaPlayer } from "./AnimatedMediaPlayer";
import { type MemeOverlaySettings } from "./MemeWorkspace";
import { MemeSetWorkspace } from "./MemeSetWorkspace";
import { createMemeCollection, invalidateMemeOutputs, memeExportItems, runMemeQueue, type MemeCollection } from "./memeCollectionModel";
import { OutputComparison } from "./OutputComparison";
import { IslandDrawer } from "./IslandDrawer";
import { IslandRadioGroup } from "./IslandRadioGroup";
import { QuickGenerationWizard } from "./QuickGenerationWizard";
import { GifCompressionOptions } from "./GifCompressionOptions";
import { CommittedNumberInput } from "./CommittedNumberInput";
import { exportHeartbeatForElapsed } from "./exportHeartbeat";
import {
  clearSessionDraft,
  readSessionDraft,
  sessionDraftFingerprint,
  writeSessionDraft,
  type SessionDraftData,
  type SessionDraftEnvelope,
} from "./sessionPersistence";
import {
  quickScalePercentForWidth,
  quickWidthForScale,
  recommendQuickStart,
} from "./quickDeliveryModel";
import {
  LivePhotoPreview,
  isLivePhotoCompatibilityVerified,
  livePhotoValidationLabel,
} from "./LivePhotoPreview";
import {
  ALL_DELIVERY_FORMATS,
  availableDeliveryFormats,
  DELIVERY_INTENT_OPTIONS,
  DELIVERY_FORMAT_OPTIONS,
  TARGET_PLATFORM_OPTIONS,
  recommendDelivery,
  resolveDeliveryFormat,
  type DeliveryFormatPreference,
} from "./deliveryModel";
import {
  CANDIDATE_PRESET_IDS,
  COMPRESSION_PRESETS,
  DITHER_OPTIONS,
  FILTER_OPTIONS,
  GENERATION_MODE_OPTIONS,
  GIF_ENCODER_OPTIONS,
  buildGifRequest,
  buildTargetPortfolioProfiles,
  compactedOutputTimeForSourceTime,
  deletedFrameSourceRanges,
  editableOutputFramePage,
  manualSampleDeletedFrameIndices,
  normalizeDeletedFrameTimes,
  nextPlayableSourceTime,
  outputFrameCountForTimeline,
  outputFrameIndexForSourceTime,
  outputFrameIndicesForDeletedRanges,
  outputFrameIndicesForSourceTimes,
  presetForOutputFormat,
  sourceTimeForOutputFrameIndex,
  timelineFrameDots,
  type CompressionPresetId,
  type CropInsets,
  type DitherId,
  type FrameTimingMode,
  type TargetPortfolioProfile,
  type TargetPortfolioRole,
} from "./editorModel";
import {
  ECONOMICS_FORMATS,
  buildFormatEconomicsRows,
  tightCapOutcome,
  type FormatEconomicsRow,
  type TightCapOutcome,
} from "./economicsModel";
import { assessRoiReadiness } from "./roiPolicy";
import { assessOutputConfidence, type OutputConfidenceAction } from "./outputConfidenceModel";
import type { PlatformPolicyId } from "./platformPolicy";
import {
  applyAssetReplacement,
  planAssetReplacement,
  replaceMergePaths,
} from "./assetRecoveryModel";
import {
  buildFailureDiagnostic,
  classifyDesktopFailure,
  type FailureRecovery,
} from "./failureRecoveryModel";
import {
  TaskRunGate,
  assessMaterialLoad,
  cancelBackendTasks,
  presentTaskStatus,
  taskControlPolicy,
  thumbnailSampleTimes,
  type MaterialLoadAssessment,
  type PresentedTaskStatus,
  type TaskRun,
  type TaskStatusKind,
} from "./taskControlModel";
import {
  planVolumeDirector,
  type VolumeDirectorPlan,
  type VolumeDirectorPriority,
} from "./volumeDirectorModel";
import {
  interpolateTrackedBox,
  normalizeTrackedBox,
  simplifyTrackedKeyframes,
  trackedEffectConfidenceLabel,
  transformTrackedBoxForCrop,
  type TrackedBox,
  type TrackedEffect,
  type TrackedEffectKind,
  type TrackedKeyframe,
} from "./trackedEffectsModel";
import "./gifp-v3.css";

type Theme = "bubble" | "animal" | "handheld" | "kid" | "midnight";
type Mode = "quick" | "editor" | "merge" | "record" | "meme";
type MediaKind = "gif" | "webp" | "apng" | "video" | "image";
type JobStatus = "等待" | "生成中" | "完成" | "失败";
type RecordBackend = "psgrab" | "gdigrab" | "ddagrab";
type RecordOperation = "idle" | "starting" | "stopping";
type PreviewMode = "source" | "compare" | "result";
type QueueConcurrencySetting = "auto" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
type OutputTuningDirection = Exclude<OutputConfidenceAction, "regenerate">;
type ActiveTaskState = {
  generation: number;
  label: string;
  kind: TaskStatusKind;
  total: number;
  completed: number;
};

type FailureIncident = {
  id: number;
  operation: string;
  occurredAt: Date;
  failure: FailureRecovery;
  retryLabel: string;
  retry?: () => void;
  contextAssetId?: string;
};

type Thumb = {
  time: number;
  url: string;
};

type ExactFrameThumb = Thumb & {
  index: number;
};

const EXACT_FRAME_PAGE_SIZE = 36;

type ExportComparisonSnapshot = {
  crop: CropInsets;
  sourceAspect?: number;
  outputAspect?: number;
  outputFormat: OutputFormat;
  startSeconds: number;
  endSeconds: number;
  playbackSpeed: number;
  outputFps: number;
  deletedFrameIndices: number[];
  frameTimingMode: FrameTimingMode;
};

type PresentedExport = Readonly<{
  url: string;
  format: OutputFormat;
  result?: GifResult;
  snapshot?: ExportComparisonSnapshot;
  label: string;
}>;

export type MediaAsset = {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  sourceUrl: string;
  thumbnailUrl?: string;
  duration?: number;
  dimensions?: string;
  frameCount?: number;
  animated?: boolean;
  hasAlpha?: boolean;
  codec?: string;
  aspect?: number;
  thumbs?: Thumb[];
  status: JobStatus;
  result?: GifResult;
  comparisonSnapshot?: ExportComparisonSnapshot;
  error?: string;
  timelineError?: string;
};

type Candidate = {
  id: string;
  sourceAssetId: string;
  presetId: CompressionPresetId;
  label: string;
  size: string;
  duration: number;
  previewUrl?: string;
  result?: GifResult;
  comparisonSnapshot?: ExportComparisonSnapshot;
  error?: string;
  role?: TargetPortfolioRole;
  profileSummary?: string;
  paretoFrontier?: boolean;
};

type CustomSettings = {
  width: number;
  fps: number;
  colors: number;
  dither: DitherId;
  lossy: number;
  optimizeLevel: number;
  filter: FilterStyle;
  bayerScale?: number;
  alphaThreshold?: number;
  encoder: GifEncoder;
};

type GifpDevWindow = Window & {
  __GIFP_V3_DEV__?: {
    addPaths: (paths: string[]) => void;
    snapshot: () => {
      mode: Mode;
      activePath: string;
      assetCount: number;
      assets: Array<Pick<MediaAsset, "path" | "kind" | "status" | "thumbnailUrl" | "duration" | "dimensions" | "frameCount" | "animated" | "hasAlpha"> & { outputPath?: string }>;
      candidates: Array<Pick<Candidate, "presetId" | "label" | "previewUrl" | "error">>;
      recording: boolean;
      playbackSpeed: number;
      crop: CropInsets;
      cropEnabled: boolean;
      outputFormat: OutputFormat;
      previewMode: PreviewMode;
      presentedExport?: Pick<PresentedExport, "url" | "format" | "label" | "snapshot"> & { outputPath?: string };
      status: string;
    };
  };
};

const LOGO_SRC = "/gifp-logo.jpg";
const EMPTY_CROP: CropInsets = { left: 0, top: 0, right: 0, bottom: 0 };
const MEDIA_RE = /\.(mp4|mov|mkv|webm|gif|webp|apng|png)$/i;
const IMAGE_RE = /\.(png|jpe?g)$/i;
const SUPPORTED_RE = /\.(mp4|mov|mkv|webm|gif|apng|png|jpe?g|webp)$/i;
const HISTORY_KEY = "gifp.history.v3";
const HISTORY_LIMIT = 12;
const HISTORY_VISIBLE_LIMIT = 6;

const PERCEPTUAL_FOCUS_OPTIONS: Array<{ value: PerceptualFocus; label: string; note: string }> = [
  { value: "auto", label: "自动识别", note: "平衡动作、场景、文字与主体" },
  { value: "subject", label: "人物主体", note: "提高中心主体和肤色区域权重" },
  { value: "motion", label: "动作节奏", note: "优先保留运动峰值" },
  { value: "text_ui", label: "文字 / UI", note: "优先保留边缘和字幕变化" },
  { value: "flat_art", label: "平面动画", note: "抑制噪声并保护干净色块" },
];

type OutputCodecProfile = {
  algorithm: string;
  detail: string;
  alphaMode: "preserve" | "reject" | "composite";
  alphaLabel: string;
};

function sourceProfile(asset?: MediaAsset) {
  const widthMatch = asset?.dimensions?.match(/^\s*(\d+)\s*[\u00d7x]\s*(\d+)/i);
  const sourceWidth = widthMatch ? Number(widthMatch[1]) : undefined;
  const sourceHeight = widthMatch ? Number(widthMatch[2]) : undefined;
  const sourceFps = asset?.frameCount && asset.duration && asset.duration > 0
    ? asset.frameCount / asset.duration
    : undefined;
  return { width: sourceWidth, height: sourceHeight, fps: sourceFps };
}

const CUSTOM_KEY = "gifp.custom-preset.v3";

function candidateDominates(left: Candidate, right: Candidate) {
  if (!left.result || !right.result) return false;
  const leftWidth = left.result.output_width;
  const leftFps = left.result.output_fps;
  const leftColors = left.result.output_colors;
  const rightWidth = right.result.output_width;
  const rightFps = right.result.output_fps;
  const rightColors = right.result.output_colors;
  if (leftWidth == null || leftFps == null || leftColors == null
    || rightWidth == null || rightFps == null || rightColors == null) {
    return false;
  }
  const noWorse = left.result.size_bytes <= right.result.size_bytes
    && leftWidth >= rightWidth
    && leftFps >= rightFps
    && leftColors >= rightColors;
  const strictlyBetter = left.result.size_bytes < right.result.size_bytes
    || leftWidth > rightWidth
    || leftFps > rightFps
    || leftColors > rightColors;
  return noWorse && strictlyBetter;
}

function markPortfolioFrontier(candidates: Candidate[]) {
  return candidates.map((candidate) => ({
    ...candidate,
    paretoFrontier: candidate.result
      ? !candidates.some((other) => other.id !== candidate.id && candidateDominates(other, candidate))
      : undefined,
  }));
}

const CROP_ASPECT_OPTIONS = [
  { value: "free", label: "自由" },
  { value: "original", label: "原始" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
] as const;

type CropAspectValue = (typeof CROP_ASPECT_OPTIONS)[number]["value"];

function cropDraftForAspect(sourceAspect: number, target: CropAspectValue, current: CropInsets): CropInsets {
  if (target === "free") return current;
  if (target === "original") return EMPTY_CROP;

  const [targetWidth, targetHeight] = target.split(":").map(Number);
  const targetAspect = targetWidth / targetHeight;
  const safeSourceAspect = Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : 16 / 9;
  const currentWidth = Math.max(0.01, 100 - current.left - current.right);
  const currentHeight = Math.max(0.01, 100 - current.top - current.bottom);
  const centerX = current.left + currentWidth / 2;
  const centerY = current.top + currentHeight / 2;
  const width = targetAspect < safeSourceAspect ? targetAspect / safeSourceAspect * 100 : 100;
  const height = targetAspect < safeSourceAspect ? 100 : safeSourceAspect / targetAspect * 100;
  const left = clamp(centerX - width / 2, 0, 100 - width);
  const top = clamp(centerY - height / 2, 0, 100 - height);

  return {
    left,
    top,
    right: Math.max(0, 100 - left - width),
    bottom: Math.max(0, 100 - top - height),
  };
}

function CropRatioPalette({ value, onChange, className = "", style }: {
  value: CropAspectValue;
  onChange: (value: CropAspectValue) => void;
  className?: string;
  style?: { left?: string; top?: string };
}) {
  return (
    <div className={`crop-ratio-palette ${className}`.trim()} role="toolbar" aria-label="裁剪比例" style={style}>
      {CROP_ASPECT_OPTIONS.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "selected" : ""}
          aria-pressed={value === option.value}
          aria-label={`裁剪比例：${option.label}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const CROP_RULER_SIZE = 30;

export function CropRulers({ width, height }: { width: number; height: number }) {
  const ticks = Array.from({ length: 21 }, (_, index) => index / 20);
  return <>
    <div className="crop-ruler-corner" aria-hidden="true">px</div>
    <div className="crop-ruler crop-ruler-horizontal" aria-label={`水平像素标尺，0 至 ${width} 像素`}>
      {ticks.map((ratio, index) => (
        <span key={ratio} className={index % 5 === 0 ? "major" : index % 2 === 0 ? "medium" : "minor"} style={{ left: `${ratio * 100}%` }}>
          {index % 5 === 0 && <b>{Math.round(width * ratio)}</b>}
        </span>
      ))}
    </div>
    <div className="crop-ruler crop-ruler-vertical" aria-label={`垂直像素标尺，0 至 ${height} 像素`}>
      {ticks.map((ratio, index) => (
        <span key={ratio} className={index % 5 === 0 ? "major" : index % 2 === 0 ? "medium" : "minor"} style={{ top: `${ratio * 100}%` }}>
          {index % 5 === 0 && <b>{Math.round(height * ratio)}</b>}
        </span>
      ))}
    </div>
  </>;
}

export function cropPixelRect(crop: CropInsets, width: number, height: number) {
  return {
    x: Math.round(width * crop.left / 100),
    y: Math.round(height * crop.top / 100),
    width: Math.max(1, Math.round(width * (100 - crop.left - crop.right) / 100)),
    height: Math.max(1, Math.round(height * (100 - crop.top - crop.bottom) / 100)),
  };
}

const THEME_OPTIONS: Array<{ id: Theme; label: string; note: string }> = [
  { id: "bubble", label: "泡泡手账", note: "柔和纸感" },
  { id: "animal", label: "岛屿薄荷", note: "清爽立体" },
  { id: "handheld", label: "掌机灰", note: "安静专业" },
  { id: "kid", label: "糖果岛", note: "明亮活泼" },
  { id: "midnight", label: "深夜护眼", note: "低亮纸感" },
];

function readThemePreference(): Theme {
  const stored = localStorage.getItem("gifp.theme.v3");
  return THEME_OPTIONS.some((option) => option.id === stored) ? stored as Theme : "bubble";
}

const DEMO_ASSETS: MediaAsset[] = [
  {
    id: "demo-gif",
    path: "demo://meme-loop.gif",
    name: "meme-loop.gif",
    kind: "gif",
    sourceUrl: "/preset-previews/perceptual.gif",
    thumbnailUrl: "/preset-previews/perceptual.jpg",
    duration: 5.8,
    dimensions: "260 × 462",
    aspect: 260 / 462,
    frameCount: 87,
    animated: true,
    thumbs: Array.from({ length: 12 }, (_, index) => ({
      time: Number((((index + 0.5) * 5.8) / 12).toFixed(3)),
      url: "/preset-previews/perceptual.jpg",
    })),
    status: "等待",
  },
  {
    id: "demo-video",
    path: "demo://clip-02.mp4",
    name: "clip-02.mp4",
    kind: "video",
    sourceUrl: "",
    thumbnailUrl: "/preset-previews/clean.jpg",
    duration: 12.4,
    dimensions: "1280 × 720",
    aspect: 16 / 9,
    status: "等待",
  },
];

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function basename(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(index + 1) : path;
}

function dirname(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(0, index) : "";
}

const RETRYABLE_RECORDING_MARKER = "GIFP_RETRYABLE_RECORDING:";

function desktopFailureMessage(error: unknown) {
  const raw = String(error).replace(RETRYABLE_RECORDING_MARKER, "").trim();
  if (/points to a file|not a folder/i.test(raw)) {
    return "输出路径指向了文件，请重新选择一个文件夹";
  }
  if (/no space|disk full|not enough space|quota/i.test(raw)) {
    return "磁盘空间不足，请释放空间或更换输出目录";
  }
  if (/cannot write|could not create|permission|access denied|read-only/i.test(raw)) {
    return "输出目录不可写，请检查权限或更换目录";
  }
  return raw;
}

function isRetryableRecordingFailure(error: unknown) {
  return String(error).includes(RETRYABLE_RECORDING_MARKER);
}

function sizeText(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function recommendedQueueConcurrency(logicalCpuCount: number) {
  return clamp(Math.floor(Math.max(1, logicalCpuCount) / 4), 1, 4);
}

async function runBoundedQueue<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldContinue: () => boolean = () => true,
) {
  let nextIndex = 0;
  const workerCount = clamp(Math.floor(concurrency), 1, Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      if (!shouldContinue()) return;
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }));
}

function readHistory(): GifResult[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function readCustomSettings(fallback: CustomSettings): CustomSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "null") as Partial<CustomSettings> | null;
    return parsed ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

export function mediaFromPath(path: string): MediaAsset {
  const kind: MediaKind = /\.gif$/i.test(path)
    ? "gif"
    : /\.apng$/i.test(path)
      ? "apng"
      : /\.webp$/i.test(path)
        ? "webp"
        : IMAGE_RE.test(path)
          ? "image"
          : "video";
  const sourceUrl = isTauriRuntime() ? convertFileSrc(path) : kind === "video" ? "" : "/preset-previews/perceptual.gif";
  return {
    id: `${path}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    path,
    name: basename(path),
    kind,
    sourceUrl,
    thumbnailUrl: kind === "video" ? undefined : sourceUrl,
    animated: kind === "gif" || kind === "apng",
    status: "等待",
  };
}

function isConvertibleAsset(asset: MediaAsset) {
  return asset.kind !== "image" || /\.png$/i.test(asset.path);
}

function mediaLabel(asset: MediaAsset) {
  if (asset.kind === "gif") return "GIF 动画";
  if (asset.kind === "webp") return asset.animated ? "WebP 动画" : "WebP 图片";
  if (asset.kind === "apng") return "APNG 动画";
  if (asset.kind === "image") return /\.png$/i.test(asset.path) ? "PNG 图片" : "图片";
  return "视频";
}

function kindFromInspection(asset: MediaAsset, inspection: MediaInspection): MediaKind {
  const codec = inspection.codec.toLowerCase();
  if (codec.includes("gif")) return "gif";
  if (codec.includes("webp")) return "webp";
  if (codec.includes("apng") || (codec.includes("png") && inspection.animated) || /\.apng$/i.test(asset.path)) return "apng";
  if (codec.includes("png") || codec.includes("jpeg") || codec.includes("mjpeg")) return "image";
  return asset.kind === "image" && !/\.png$/i.test(asset.path) ? "image" : "video";
}

function formatLabel(format: OutputFormat) {
  return format === "live_photo" ? "实况照片" : format.toUpperCase();
}

function outputCodecProfile(format: OutputFormat, lossy: number): OutputCodecProfile {
  switch (format) {
    case "webp":
      return {
        algorithm: "libwebp_anim",
        detail: lossy === 0
          ? "BGRA 可见像素无损 Animated WebP；透明度完整保留"
          : "有损 Animated WebP；压缩强度越高体积通常越小",
        alphaMode: "preserve",
        alphaLabel: "透明通道：可保留",
      };
    case "avif":
      return {
        algorithm: "libaom-av1",
        detail: "Animated AVIF；当前后端只接受不透明素材",
        alphaMode: "reject",
        alphaLabel: "透明通道：不接受",
      };
    case "apng":
      return {
        algorithm: "FFmpeg APNG",
        detail: "无损 RGBA 动画；压缩强度不会改变像素",
        alphaMode: "preserve",
        alphaLabel: "透明通道：完整保留",
      };
    case "mp4":
      return {
        algorithm: "libx264 · H.264",
        detail: "yuv420p MP4；透明像素会合成为不透明画面",
        alphaMode: "composite",
        alphaLabel: "透明通道：会合成",
      };
    case "webm":
      return {
        algorithm: "libvpx-vp9 · VP9",
        detail: "透明素材使用 yuva420p，不透明素材使用 yuv420p",
        alphaMode: "preserve",
        alphaLabel: "透明通道：可保留",
      };
    case "live_photo":
      return {
        algorithm: "JPEG + H.264 MOV",
        detail: "成对资源共享标识；透明像素会预乘到黑色背景",
        alphaMode: "composite",
        alphaLabel: "透明通道：会合成",
      };
    case "gif":
    default:
      return {
        algorithm: "FFmpeg GIF 调色板链",
        detail: "索引色动画；支持透明背景",
        alphaMode: "preserve",
        alphaLabel: "透明通道：可保留",
      };
  }
}

function formatFromPath(path: string): OutputFormat | undefined {
  if (/\.webp(?:$|[?#])/i.test(path)) return "webp";
  if (/\.avif(?:$|[?#])/i.test(path)) return "avif";
  if (/\.apng(?:$|[?#])/i.test(path)) return "apng";
  if (/\.mp4(?:$|[?#])/i.test(path)) return "mp4";
  if (/\.webm(?:$|[?#])/i.test(path)) return "webm";
  if (/\.gif(?:$|[?#])/i.test(path)) return "gif";
  return undefined;
}

function resultFormat(result: GifResult | undefined, fallback: OutputFormat, previewUrl = ""): OutputFormat {
  if (result?.output_format) return result.output_format;
  return formatFromPath(result?.output_path || "") ?? formatFromPath(previewUrl) ?? fallback;
}

function candidateLabel(candidate: Candidate, format: OutputFormat) {
  const base = candidate.label.replace(/\s*·\s*(?:GIF|WEBP|AVIF|APNG|MP4|WEBM|LIVE_PHOTO|实况照片)\s*$/i, "");
  return `${base} · ${formatLabel(format)}`;
}

function previewResourceUrl(path: string) {
  return isTauriRuntime() ? convertFileSrc(path) : path;
}

function resultPreviewPath(result: GifResult) {
  return result.live_photo?.still_path ?? result.output_path;
}

function snapshotWithAspect(snapshot: ExportComparisonSnapshot, sourceAspect: number): ExportComparisonSnapshot {
  if (!Number.isFinite(sourceAspect) || sourceAspect <= 0) return snapshot;
  const visibleWidth = Math.max(0.01, 1 - (snapshot.crop.left + snapshot.crop.right) / 100);
  const visibleHeight = Math.max(0.01, 1 - (snapshot.crop.top + snapshot.crop.bottom) / 100);
  return {
    ...snapshot,
    sourceAspect,
    outputAspect: sourceAspect * visibleWidth / visibleHeight,
  };
}

function snapshotWithMediaInfo(
  snapshot: ExportComparisonSnapshot,
  sourceAspect: number,
  sourceDuration: number,
): ExportComparisonSnapshot {
  const withAspect = Number.isFinite(sourceAspect) && sourceAspect > 0
    ? snapshotWithAspect(snapshot, sourceAspect)
    : snapshot;
  if (!Number.isFinite(sourceDuration)
    || sourceDuration <= withAspect.startSeconds
    || withAspect.endSeconds > withAspect.startSeconds) {
    return withAspect;
  }
  return {
    ...withAspect,
    endSeconds: sourceDuration,
  };
}

function OutputPreview({
  src,
  format,
  alt,
  livePhoto,
  interactive = false,
  stageOnly = false,
  reducedMotion = false,
}: {
  src: string;
  format: OutputFormat;
  alt: string;
  livePhoto?: LivePhotoResult | null;
  interactive?: boolean;
  stageOnly?: boolean;
  reducedMotion?: boolean;
}) {
  if (format === "live_photo") {
    if (!livePhoto?.still_path || !livePhoto.motion_path) {
      return (
        <div className="live-photo-preview-missing" role="status">
          <Images />
          <strong>等待实况照片成对资源</strong>
          <span>结果需包含静态关键帧、MOV 和后端兼容验证报告。</span>
        </div>
      );
    }
    if (!interactive) return <img src={src} alt={`${alt} 静态关键帧`} />;
    return (
      <LivePhotoPreview
        stillSrc={previewResourceUrl(livePhoto.still_path)}
        motionSrc={previewResourceUrl(livePhoto.motion_path)}
        alt={alt}
        livePhoto={livePhoto}
        stageOnly={stageOnly}
        reducedMotion={reducedMotion}
      />
    );
  }
  if (format === "mp4" || format === "webm") {
    return <video src={src} aria-label={alt} muted autoPlay={!reducedMotion} loop playsInline controls={!stageOnly} />;
  }
  if (interactive) {
    return <AnimatedMediaPlayer src={src} format={format} alt={alt} className="embedded-animation-player" stageOnly={stageOnly} reducedMotion={reducedMotion} />;
  }
  return <img src={src} alt={alt} />;
}

export function ActivityStatus({
  busy,
  recording,
  status,
  qualityScoring,
  qualityCancelPending,
  onCancelQualityScoring,
}: {
  busy: boolean;
  recording: boolean;
  status: string;
  qualityScoring: boolean;
  qualityCancelPending: boolean;
  onCancelQualityScoring: () => void;
}) {
  return (
    <div className={`activity-status${busy || recording ? " is-active" : ""}${qualityScoring ? " has-action" : ""}`} aria-live="polite" aria-atomic="true">
      <span className="activity-status__dot" aria-hidden="true" />
      <span>{busy || recording ? "处理中" : status === "准备就绪" ? "准备就绪" : "已更新"}</span>
      {status !== "准备就绪" && <strong>{status}</strong>}
      {qualityScoring && <small className="activity-status__quality">{qualityCancelPending ? "正在停止评分 · 成品可用" : "评分中 · 成品可用"}</small>}
      {qualityScoring && (
        <button type="button" onClick={onCancelQualityScoring} disabled={qualityCancelPending}>
          {qualityCancelPending ? "正在终止…" : "终止评分"}
        </button>
      )}
    </div>
  );
}

function losslessStageNotes(result?: GifResult): string | undefined {
  const notes: string[] = [];
  const cleanup = result?.gif_cleanup_report;
  if (cleanup) notes.push(cleanup.verified
    ? `无损整理已采用 · 合并 ${cleanup.merged_frames} 帧 · 减少 ${((1 - cleanup.after_bytes / Math.max(1, cleanup.before_bytes)) * 100).toFixed(1)}%`
    : "无损整理未采用");
  const structure = result?.structure_optimization_report;
  if (structure) notes.push(structure.adopted && structure.verified
    ? `智能无损阶段已采用 · 减少 ${((1 - structure.after_bytes / Math.max(1, structure.before_bytes)) * 100).toFixed(1)}%`
    : "智能无损阶段保留原结果");
  return notes.join("；") || undefined;
}

export default function GifpV3({ onOpenStudio }: { onOpenStudio?: () => void } = {}) {
  const tauri = isTauriRuntime();
  const [initialSessionRead] = useState(() => readSessionDraft(localStorage));
  const [recoverableSession, setRecoverableSession] = useState<SessionDraftEnvelope | null>(() =>
    initialSessionRead.status === "ready" && initialSessionRead.draft.data.assets.length
      ? initialSessionRead.draft
      : null
  );
  const [sessionAutosaveEnabled, setSessionAutosaveEnabled] = useState(() => !recoverableSession);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewHoldRef = useRef<{ start: number; end: number; startedAt: number } | null>(null);
  const captureTokens = useRef<Record<string, number>>({});
  const inspectTokens = useRef<Record<string, number>>({});
  const [mode, setMode] = useState<Mode>("editor");
  const [theme, setTheme] = useState<Theme>(readThemePreference);
  const [themeOpen, setThemeOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [assets, setAssets] = useState<MediaAsset[]>(() => (tauri ? [] : DEMO_ASSETS));
  const assetPathsRef = useRef(new Map<string, string>());
  const [activeId, setActiveId] = useState(() => (tauri ? "" : DEMO_ASSETS[0].id));
  const [mergeItems, setMergeItems] = useState<string[]>(() => (tauri ? [] : [DEMO_ASSETS[0].path]));
  const [mergeImageSeconds, setMergeImageSeconds] = useState(1.2);
  const [outputDir, setOutputDir] = useState("");
  const [presetId, setPresetId] = useState<CompressionPresetId>("perceptual");
  const [presetAdjusted, setPresetAdjusted] = useState(false);
  const [encoder, setEncoder] = useState<GifEncoder>("pngquant_opt");
  const [deliveryIntent, setDeliveryIntent] = useState<DeliveryIntent>("smart");
  const [deliveryFormatPreference, setDeliveryFormatPreference] = useState<DeliveryFormatPreference>("gif");
  const [targetPlatform, setTargetPlatform] = useState<TargetPlatform>("modern_web");
  const [platformPolicyId, setPlatformPolicyId] = useState<PlatformPolicyId | undefined>();
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [quickScalePercent, setQuickScalePercent] = useState(100);
  const [cropEnabled, setCropEnabled] = useState(false);
  const [crop, setCrop] = useState<CropInsets>(EMPTY_CROP);
  const [loopOutput, setLoopOutput] = useState(true);
  const [width, setWidth] = useState(420);
  const [fps, setFps] = useState(15);
  const [colors, setColors] = useState(112);
  const [dither, setDither] = useState<DitherId>("sierra2_4a");
  const [lossy, setLossy] = useState(28);
  const [optimizeLevel, setOptimizeLevel] = useState(3);
  const [generationMode, setGenerationMode] = useState<GifGenerationMode>("best_gif");
  const [targetSizeMb, setTargetSizeMb] = useState(2);
  const [volumeDirectorEnabled, setVolumeDirectorEnabled] = useState(true);
  const [volumeDirectorPriority, setVolumeDirectorPriority] = useState<VolumeDirectorPriority>("balanced");
  const [targetOutcome, setTargetOutcome] = useState<TightCapOutcome | null>(null);
  const [formatEconomics, setFormatEconomics] = useState<FormatEconomicsRow[]>([]);
  const [bayerScale, setBayerScale] = useState(2);
  const [alphaThreshold, setAlphaThreshold] = useState(128);
  const [backgroundRemoval, setBackgroundRemoval] = useState<BackgroundRemovalRequest | null>(null);
  const [perceptualFocus, setPerceptualFocus] = useState<PerceptualFocus>("auto");
  const [backendCapabilities, setBackendCapabilities] = useState<BackendCapability[]>([]);
  const [filter, setFilter] = useState<FilterStyle>("vivid");
  const [memeOverlay, setMemeOverlay] = useState<MemeOverlaySettings | null>(null);
  const [memeDraft, setMemeDraft] = useState<MemeOverlaySettings | null>(null);
  const [memeCollections, setMemeCollections] = useState<Record<string, MemeCollection>>({});
  const memeBatchOwner = useRef<string | null>(null);
  const [trackedEffects, setTrackedEffects] = useState<TrackedEffect[]>([]);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [selectedFrameTimes, setSelectedFrameTimes] = useState<number[]>([]);
  const [deletedFrames, setDeletedFrames] = useState<number[]>([]);
  const [lastDeletedBatch, setLastDeletedBatch] = useState<number[]>([]);
  const [frameTimingMode, setFrameTimingMode] = useState<FrameTimingMode>("compact");
  const [frameEditorOpen, setFrameEditorOpen] = useState(false);
  const [frameEditorPage, setFrameEditorPage] = useState(0);
  const [frameEditorThumbs, setFrameEditorThumbs] = useState<ExactFrameThumb[]>([]);
  const [frameEditorLoading, setFrameEditorLoading] = useState(false);
  const [frameEditorError, setFrameEditorError] = useState("");
  const [focusedFramePreview, setFocusedFramePreview] = useState<Thumb | null>(null);
  const [timelineHoverPreview, setTimelineHoverPreview] = useState<ExactFrameThumb | null>(null);
  const [frameAnnotationOpen, setFrameAnnotationOpen] = useState(false);
  const [trackedEffectOpen, setTrackedEffectOpen] = useState(false);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [quickWizardOpen, setQuickWizardOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const exportHeartbeatTimer = useRef<number | null>(null);
  const [activeQueueJobs, setActiveQueueJobs] = useState(0);
  const [queueConcurrencySetting, setQueueConcurrencySetting] = useState<QueueConcurrencySetting>("auto");
  const [resourceSnapshot, setResourceSnapshot] = useState<RuntimeResourceSnapshot | null>(null);
  const [resourceSamplingError, setResourceSamplingError] = useState("");
  const [status, setStatus] = useState("准备就绪");
  const [qualityScoringEnabled, setQualityScoringEnabled] = useState(true);
  const [indexCompression, setIndexCompression] = useState(false);
  const [smartLossless, setSmartLossless] = useState(false);
  const [gentleIndex, setGentleIndex] = useState(false);
  const [mergeGifFrames, setMergeGifFrames] = useState(false);
  const [compactGifPalette, setCompactGifPalette] = useState(false);
  const [smallerGif, setSmallerGif] = useState(false);
  const [qualityScoringTaskId, setQualityScoringTaskId] = useState<string | null>(null);
  const [qualityCancelPending, setQualityCancelPending] = useState(false);
  const [failureIncident, setFailureIncident] = useState<FailureIncident | null>(null);
  const [failureCopyStatus, setFailureCopyStatus] = useState("");
  const [failureTechnicalOpen, setFailureTechnicalOpen] = useState(false);
  const [history, setHistory] = useState<GifResult[]>(readHistory);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const [pendingOutputTuning, setPendingOutputTuning] = useState<{ direction: OutputTuningDirection; nonce: number } | null>(null);
  const [activeTask, setActiveTask] = useState<ActiveTaskState | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordOperation, setRecordOperation] = useState<RecordOperation>("idle");
  const [recordRegionPicking, setRecordRegionPicking] = useState(false);
  const [recordRegion, setRecordRegion] = useState({ enabled: false, x: 0, y: 0, width: 720, height: 480, screen_x: 0, screen_y: 0, screen_width: 1920, screen_height: 1080 });
  const [recordFps, setRecordFps] = useState(15);
  const [recordBackend, setRecordBackend] = useState<RecordBackend>("psgrab");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("source");
  const candidateRunRef = useRef(0);
  const taskGateRef = useRef(new TaskRunGate());
  const activeBackendTaskIdsRef = useRef(new Set<string>());
  const qualityScoringTaskIdRef = useRef<string | null>(null);
  const cancelledQualityTaskIdsRef = useRef(new Set<string>());
  const backendTaskSequenceRef = useRef(0);
  const timelineCacheRef = useRef(new Map<string, Thumb[]>());
  const exactFramePageCacheRef = useRef(new Map<string, ExactFrameThumb[]>());
  const exactFramePagePendingRef = useRef(new Map<string, Promise<ExactFrameThumb[]>>());
  const framePageTokenRef = useRef(0);
  const timelineHoverIndexRef = useRef<number | null>(null);
  const mediaInfoRef = useRef(new Map<string, { aspect?: number; duration?: number }>());
  const quickDefaultsAppliedRef = useRef(new Set<string>());
  const quickUserAdjustedRef = useRef(new Set<string>());
  const pendingSessionRestoreRef = useRef<SessionDraftData | null>(null);
  const sessionRestoreActiveIdRef = useRef<string | null>(null);
  const sessionFingerprintRef = useRef<string | null>(null);

  const active = assets.find((asset) => asset.id === activeId) ?? assets.find(isConvertibleAsset);
  assetPathsRef.current = new Map(assets.map((asset) => [asset.id, asset.path.toLowerCase()]));
  const activeIdRef = useRef(active?.id ?? "");
  activeIdRef.current = active?.id ?? "";
  const mediaAssets = assets.filter(isConvertibleAsset);
  const browserLogicalCpuCount = Math.max(1, Math.round(navigator.hardwareConcurrency || 4));
  const logicalCpuCount = Math.max(1, resourceSnapshot?.logical_cpu_count || browserLogicalCpuCount);
  const effectiveQueueConcurrency = queueConcurrencySetting === "auto"
    ? recommendedQueueConcurrency(logicalCpuCount)
    : clamp(Number(queueConcurrencySetting), 1, 8);
  const activeSourceProfile = sourceProfile(active);
  const activeMaterialLoad = assessMaterialLoad({
    durationSeconds: active?.duration,
    width: activeSourceProfile.width,
    height: activeSourceProfile.height,
    fps: activeSourceProfile.fps,
    frameCount: active?.frameCount,
  });
  const activeTaskPolicy = taskControlPolicy(activeMaterialLoad);
  const effectiveTaskConcurrency = Math.min(effectiveQueueConcurrency, activeTaskPolicy.maxConcurrency);
  const presentedTaskStatus = activeTask ? presentTaskStatus({
    kind: activeTask.kind,
    progress: progress / 100,
    currentStep: activeTask.label,
  }) : null;
  const mergeAssets = mergeItems.map((path) => assets.find((asset) => asset.path === path)).filter(Boolean) as MediaAsset[];
  const selectedPreset = COMPRESSION_PRESETS.find((preset) => preset.id === presetId) ?? COMPRESSION_PRESETS[1];
  const activeDuration = duration || active?.duration || 0;
  const trimEnd = end > start ? end : activeDuration;
  const displayDuration = Math.max(0, trimEnd - start) / playbackSpeed;
  const totalOutputFrameCount = useMemo(
    () => outputFrameCountForTimeline(start, trimEnd, playbackSpeed, fps),
    [fps, playbackSpeed, start, trimEnd],
  );
  const normalizedDeletedFrames = useMemo(
    () => normalizeDeletedFrameTimes(deletedFrames, start, trimEnd, playbackSpeed, fps),
    [deletedFrames, fps, playbackSpeed, start, trimEnd],
  );
  const validDeletedFrames = useMemo(() => {
    if (frameTimingMode !== "preserve" || totalOutputFrameCount <= 1) return normalizedDeletedFrames;
    return normalizedDeletedFrames.filter((time) => {
      const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
      return index !== 0 && index !== totalOutputFrameCount - 1;
    });
  }, [fps, frameTimingMode, normalizedDeletedFrames, playbackSpeed, start, totalOutputFrameCount, trimEnd]);
  const deletedFrameIndices = useMemo(
    () => outputFrameIndicesForSourceTimes(validDeletedFrames, start, trimEnd, playbackSpeed, fps),
    [fps, playbackSpeed, start, trimEnd, validDeletedFrames],
  );
  const selectedFrameIndices = useMemo(
    () => outputFrameIndicesForSourceTimes(selectedFrameTimes, start, trimEnd, playbackSpeed, fps),
    [fps, playbackSpeed, selectedFrameTimes, start, trimEnd],
  );
  const deletedRanges = useMemo(
    () => deletedFrameSourceRanges(
      validDeletedFrames,
      start,
      trimEnd,
      playbackSpeed,
      fps,
    ),
    [fps, playbackSpeed, start, trimEnd, validDeletedFrames],
  );
  const compactionRanges = frameTimingMode === "compact" ? deletedRanges : [];
  const exactFrameTimes = useMemo(
    () => Array.from({ length: totalOutputFrameCount }, (_, index) =>
      sourceTimeForOutputFrameIndex(index, start, trimEnd, playbackSpeed, fps)
    ).filter((time): time is number => time !== null),
    [fps, playbackSpeed, start, totalOutputFrameCount, trimEnd],
  );
  const validSelectedFrameTimes = useMemo(
    () => selectedFrameIndices.flatMap((index) => {
      const time = sourceTimeForOutputFrameIndex(index, start, trimEnd, playbackSpeed, fps);
      return time == null ? [] : [time];
    }),
    [fps, playbackSpeed, selectedFrameIndices, start, trimEnd],
  );
  const quantizedDisplayDuration = totalOutputFrameCount > 0
    ? totalOutputFrameCount / Math.max(1, fps)
    : displayDuration;
  const editedDisplayDuration = Math.max(
    1 / Math.max(1, fps),
    frameTimingMode === "preserve"
      ? quantizedDisplayDuration
      : Math.max(0, totalOutputFrameCount - deletedFrameIndices.length) / Math.max(1, fps),
  );
  const retainedTimelineRatio = totalOutputFrameCount > 0
    ? frameTimingMode === "preserve"
      ? 1
      : Math.max(0, Math.min(1, (totalOutputFrameCount - deletedFrameIndices.length) / totalOutputFrameCount))
    : 1;
  const rawDeliveryRecommendation = useMemo(() => recommendDelivery({
    intent: deliveryIntent,
    targetPlatform,
    duration: editedDisplayDuration,
    fps,
    hasAlpha: Boolean(active?.hasAlpha),
    focus: perceptualFocus,
    sourceKind: active?.kind,
  }), [active?.hasAlpha, active?.kind, deliveryIntent, editedDisplayDuration, fps, perceptualFocus, targetPlatform]);
  const requestedDeliveryRecommendation = useMemo(
    () => resolveDeliveryFormat(rawDeliveryRecommendation, deliveryFormatPreference),
    [deliveryFormatPreference, rawDeliveryRecommendation],
  );
  const discoveredFormats = backendCapabilities.find((backend) => backend.id === "ffmpeg.animation")?.formats;
  const deliveryRecommendation = useMemo(() => {
    if (deliveryFormatPreference !== "auto") return requestedDeliveryRecommendation;
    if (!Array.isArray(discoveredFormats) || discoveredFormats.includes(requestedDeliveryRecommendation.format)) {
      return requestedDeliveryRecommendation;
    }
    return {
      format: "gif" as const,
      reason: `${formatLabel(requestedDeliveryRecommendation.format)} 当前不可用，已改为 GIF`,
    };
  }, [deliveryFormatPreference, discoveredFormats, requestedDeliveryRecommendation]);
  const outputFormat: OutputFormat = deliveryRecommendation.format;
  const volumeDirectorPlan = useMemo(() => planVolumeDirector({
    sourceWidth: activeSourceProfile.width ?? width,
    sourceHeight: activeSourceProfile.height ?? Math.max(1, Math.round(width / (active?.aspect || 16 / 9))),
    durationSeconds: editedDisplayDuration || active?.duration || 1,
    sourceFps: activeSourceProfile.fps,
    outputWidth: width,
    outputFps: fps,
    colors,
    lossy,
    targetSizeMb,
    hasAlpha: active?.hasAlpha,
    mediaKind: active?.kind,
    perceptualFocus,
    priority: volumeDirectorPriority,
  }), [active?.aspect, active?.duration, active?.hasAlpha, active?.kind, activeSourceProfile.fps, activeSourceProfile.height, activeSourceProfile.width, colors, editedDisplayDuration, fps, lossy, perceptualFocus, targetSizeMb, volumeDirectorPriority, width]);
  const volumeDirectorActive = volumeDirectorEnabled && outputFormat === "gif" && generationMode === "target_size";
  const livePhotoBackend = backendCapabilities.find((backend) =>
    backend.id === "ffmpeg.animation"
    || (Array.isArray(backend.formats) && backend.formats.includes("live_photo"))
  );
  const livePhotoBackendReady = livePhotoBackend?.status.state === "available"
    && Array.isArray(livePhotoBackend.formats)
    && livePhotoBackend.formats.includes("live_photo");
  const outputBackendReady = outputFormat !== "live_photo" || livePhotoBackendReady;
  const optimizerReady = backendCapabilities.some((backend) => backend.id === "gif.optimizer.external" && backend.status.state === "available");
  const compressionTools = <GifCompressionOptions
    value={{ smartLossless, smallerGif, indexCompression, gentleIndex, mergeFrames: mergeGifFrames, compactPalette: compactGifPalette }}
    optimizerReady={optimizerReady} disabled={busy}
    onChange={(key, checked) => {
      if (key === "smartLossless") setSmartLossless(checked);
      else if (key === "smallerGif") setSmallerGif(checked);
      else if (key === "indexCompression") setIndexCompression(checked);
      else if (key === "gentleIndex") setGentleIndex(checked);
      else if (key === "mergeFrames") setMergeGifFrames(checked);
      else setCompactGifPalette(checked);
    }}
    onReset={() => { setSmartLossless(false); setSmallerGif(false); setIndexCompression(false); setGentleIndex(false); setMergeGifFrames(false); setCompactGifPalette(false); }}
  />;
  const postprocessControl = outputFormat === "gif" ? compressionTools : null;
  const doneCount = mediaAssets.filter((asset) => asset.status === "完成" || asset.status === "失败").length;
  const queueProgress = mediaAssets.length ? Math.round((doneCount / mediaAssets.length) * 100) : 0;
  const selectedCandidateItem = candidates.find((candidate) => candidate.id === selectedCandidate);
  const presentedExport = useMemo<PresentedExport | undefined>(() => {
    if (selectedCandidate) {
      if (!selectedCandidateItem
        || selectedCandidateItem.sourceAssetId !== active?.id
        || selectedCandidateItem.error
        || !selectedCandidateItem.previewUrl) return undefined;
      const format = resultFormat(
        selectedCandidateItem.result,
        selectedCandidateItem.comparisonSnapshot?.outputFormat ?? "gif",
        selectedCandidateItem.previewUrl,
      );
      const candidateSnapshot = selectedCandidateItem.comparisonSnapshot
        ? snapshotWithMediaInfo(
          selectedCandidateItem.comparisonSnapshot,
          Number(active?.aspect),
          Number(active?.duration),
        )
        : undefined;
      return {
        url: selectedCandidateItem.previewUrl,
        format,
        result: selectedCandidateItem.result,
        snapshot: candidateSnapshot
          ? { ...candidateSnapshot, outputFormat: format }
          : undefined,
        label: candidateLabel(selectedCandidateItem, format),
      };
    }
    if (!active?.result?.output_path && !active?.result?.live_photo?.still_path) return undefined;
    const format = resultFormat(active.result, active.comparisonSnapshot?.outputFormat ?? "gif");
    const activeSnapshot = active.comparisonSnapshot
      ? snapshotWithMediaInfo(
        active.comparisonSnapshot,
        Number(active.aspect),
        Number(active.duration),
      )
      : undefined;
    return {
      url: previewResourceUrl(resultPreviewPath(active.result)),
      format,
      result: active.result,
      snapshot: activeSnapshot
        ? { ...activeSnapshot, outputFormat: format }
        : undefined,
      label: `${formatLabel(format)} 成品`,
    };
  }, [active?.aspect, active?.comparisonSnapshot, active?.duration, active?.id, active?.result, selectedCandidate, selectedCandidateItem]);
  const currentSettings = useMemo<CustomSettings>(() => ({
    width,
    fps,
    colors,
    dither,
    lossy,
    optimizeLevel,
    filter,
    bayerScale,
    alphaThreshold,
    encoder,
  }), [alphaThreshold, bayerScale, colors, dither, encoder, filter, fps, lossy, optimizeLevel, width]);
  const sessionDraft = useMemo<SessionDraftData>(() => ({
    mode,
    assets: assets
      .filter((asset) => !asset.path.startsWith("demo://"))
      .map((asset) => ({
        id: asset.id,
        path: asset.path,
        name: asset.name,
        kind: asset.kind,
        duration: asset.duration,
        dimensions: asset.dimensions,
        frameCount: asset.frameCount,
        animated: asset.animated,
        hasAlpha: asset.hasAlpha,
        codec: asset.codec,
        pathAvailability: { state: "unchecked" as const },
      })),
    activeAssetId: active?.id ?? "",
    activeAssetPath: active?.path,
    mergePaths: mergeItems.filter((path) => !path.startsWith("demo://")),
    outputDir,
    editor: {
      presetId,
      encoder,
      deliveryIntent,
      deliveryFormatPreference,
      targetPlatform,
      platformPolicyId,
      playbackSpeed,
      cropEnabled,
      crop,
      loopOutput,
      width,
      fps,
      colors,
      dither,
      lossy,
      optimizeLevel,
      generationMode,
      targetSizeMb,
      bayerScale,
      alphaThreshold,
      perceptualFocus,
      filter,
      outputFormat,
      startSeconds: start,
      endSeconds: trimEnd,
      selectedFrameTimes: validSelectedFrameTimes,
      deletedFrameTimes: deletedFrames,
      frameTimingMode,
      memeOverlay,
      volumeDirectorEnabled,
      volumeDirectorPriority,
      trackedEffects,
    },
  }), [active?.id, active?.path, alphaThreshold, assets, bayerScale, colors, crop, cropEnabled,
    deletedFrames, deliveryFormatPreference, deliveryIntent, dither, encoder, filter, fps, frameTimingMode,
    generationMode, loopOutput, lossy, memeOverlay, mergeItems, mode, optimizeLevel, outputDir,
    outputFormat, perceptualFocus, playbackSpeed, presetId, start,
    platformPolicyId, targetPlatform, targetSizeMb, trackedEffects, trimEnd, volumeDirectorEnabled,
    validSelectedFrameTimes, volumeDirectorPriority, width]);

  useEffect(() => {
    if (!tauri || !sessionAutosaveEnabled || !sessionDraft.assets.length || recording) return undefined;
    const fingerprint = sessionDraftFingerprint(sessionDraft);
    if (sessionFingerprintRef.current === fingerprint) return undefined;
    const timer = window.setTimeout(() => {
      if (writeSessionDraft(localStorage, sessionDraft)) sessionFingerprintRef.current = fingerprint;
    }, 800);
    return () => window.clearTimeout(timer);
  }, [recording, sessionAutosaveEnabled, sessionDraft, tauri]);

  useEffect(() => {
    if (!tauri || !sessionAutosaveEnabled || !sessionDraft.assets.length) return undefined;
    const saveBeforeClose = () => { writeSessionDraft(localStorage, sessionDraft); };
    window.addEventListener("beforeunload", saveBeforeClose);
    return () => window.removeEventListener("beforeunload", saveBeforeClose);
  }, [sessionAutosaveEnabled, sessionDraft, tauri]);

  useEffect(() => {
    const pending = pendingSessionRestoreRef.current;
    if (!pending || !active || active.path.toLowerCase() !== pending.activeAssetPath?.toLowerCase()) return;
    if (active.kind !== "image" && active.duration == null && !active.error) return;
    const editor = pending.editor;
    quickDefaultsAppliedRef.current.add(active.id);
    setPresetId(editor.presetId);
    setPresetAdjusted(true);
    setEncoder(editor.encoder);
    setDeliveryIntent(editor.deliveryIntent);
    setDeliveryFormatPreference(editor.deliveryFormatPreference);
    setTargetPlatform(editor.targetPlatform);
    setPlatformPolicyId(editor.platformPolicyId);
    setPlaybackSpeed(editor.playbackSpeed);
    setCropEnabled(editor.cropEnabled);
    setCrop(editor.crop);
    setLoopOutput(editor.loopOutput);
    setWidth(editor.width);
    setFps(editor.fps);
    setColors(editor.colors);
    setDither(editor.dither);
    setLossy(editor.lossy);
    setOptimizeLevel(editor.optimizeLevel);
    setGenerationMode(editor.generationMode);
    setTargetSizeMb(editor.targetSizeMb);
    setBayerScale(editor.bayerScale);
    setAlphaThreshold(editor.alphaThreshold);
    setPerceptualFocus(editor.perceptualFocus);
    setFilter(editor.filter);
    const restoredEnd = Math.min(editor.endSeconds, active.duration || editor.endSeconds);
    setStart(Math.min(editor.startSeconds, restoredEnd));
    setEnd(restoredEnd);
    setSelectedFrameTimes(editor.selectedFrameTimes);
    setDeletedFrames(editor.deletedFrameTimes);
    setFrameTimingMode(editor.frameTimingMode ?? "compact");
    setMemeOverlay(editor.memeOverlay);
    setVolumeDirectorEnabled(editor.volumeDirectorEnabled ?? true);
    setVolumeDirectorPriority(editor.volumeDirectorPriority ?? "balanced");
    setTrackedEffects(editor.trackedEffects ?? []);
    pendingSessionRestoreRef.current = null;
    sessionFingerprintRef.current = null;
    setSessionAutosaveEnabled(true);
    setStatus(active.error
      ? `已恢复任务设置，但素材需要重新定位：${active.name}`
      : `已恢复上一次任务：${active.name}`);
  }, [active?.duration, active?.error, active?.id, active?.kind, active?.name, active?.path]);
  const quickSource = sourceProfile(active);
  const quickOutputSource = cropEnabled && quickSource.width && quickSource.height
    ? cropPixelRect(crop, quickSource.width, quickSource.height) : quickSource;
  useEffect(() => {
    if (mode !== "quick" || !active || quickDefaultsAppliedRef.current.has(active.id)) return;
    const profile = sourceProfile(active);
    if (!profile.width || !profile.height) return;
    quickDefaultsAppliedRef.current.add(active.id);
    const recommendation = recommendQuickStart({
      ...profile,
      duration: activeDuration || active.duration || 3,
    });
    const quickPreset = COMPRESSION_PRESETS.find((preset) => preset.id === "qq") ?? COMPRESSION_PRESETS[0];
    setDeliveryFormatPreference("gif");
    setPresetId(quickPreset.id);
    setPresetAdjusted(true);
    setQuickScalePercent(recommendation.scalePercent);
    setWidth(recommendation.width);
    setFps(recommendation.fps);
    setColors(256);
    setDither(quickPreset.dither);
    setLossy(quickPreset.lossy);
    setOptimizeLevel(quickPreset.optimizeLevel);
    setEncoder(quickPreset.encoder);
    setFilter(quickPreset.filter);
    setPerceptualFocus("auto");
    setGenerationMode("best_gif");
    setLoopOutput(true);
    setStart(0);
    setEnd(activeDuration);
    setDeletedFrames([]);
    setLastDeletedBatch([]);
    setCrop({ ...EMPTY_CROP });
    setCropEnabled(false);
    setBackgroundRemoval(null);
    setStatus(`快速建议：${recommendation.reason}`);
  }, [active, activeDuration, mode]);

  useEffect(() => {
    if (mode !== "quick" || !active || !quickUserAdjustedRef.current.has(active.id)) return;
    const profile = sourceProfile(active);
    if (!profile.width) return;
    const widthScale = quickScalePercentForWidth(profile.width, width);
    if (widthScale !== quickScalePercent) {
      const nextWidth = quickWidthForScale(profile.width, quickScalePercent);
      const normalizedScale = quickScalePercentForWidth(profile.width, nextWidth);
      if (nextWidth !== width) setWidth(nextWidth);
      if (normalizedScale !== quickScalePercent) setQuickScalePercent(normalizedScale);
    }
    if (profile.fps) {
      const sourceFpsCap = Math.max(1, Math.min(30, Math.floor(profile.fps)));
      if (fps > sourceFpsCap) setFps(sourceFpsCap);
    }
  }, [active, fps, mode, quickScalePercent, width]);

  useEffect(() => {
    if (mode === "quick") return;
    // The restoration effect above commits exact saved values in this render.
    // Do not let a stale preset closure overwrite them before state catches up.
    if (sessionRestoreActiveIdRef.current === active?.id) return;
    if (presetAdjusted || presetId === "custom") return;
    const preset = COMPRESSION_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const resolved = presetForOutputFormat(preset, outputFormat, sourceProfile(active));
    setWidth(resolved.width);
    setFps(resolved.fps);
    setColors(clamp(resolved.colors, 3, 256));
    setDither(resolved.dither);
    setLossy(resolved.lossy);
    setOptimizeLevel(resolved.optimizeLevel);
    setFilter(resolved.filter);
    setEncoder(resolved.encoder);
  }, [active?.dimensions, active?.duration, active?.frameCount, mode, outputFormat, presetAdjusted, presetId]);

  useEffect(() => {
    setDeletedFrames((items) => {
      const normalized = normalizeDeletedFrameTimes(items, start, trimEnd, playbackSpeed, fps);
      return normalized.length === items.length && normalized.every((time, index) => time === items[index])
        ? items
        : normalized;
    });
    setSelectedFrameTimes((items) => {
      const normalized = normalizeDeletedFrameTimes(items, start, trimEnd, playbackSpeed, fps);
      return normalized.length === items.length && normalized.every((time, index) => time === items[index])
        ? items
        : normalized;
    });
  }, [fps, playbackSpeed, start, trimEnd]);

  useEffect(() => {
    localStorage.setItem("gifp.theme.v3", theme);
  }, [theme]);

  useEffect(() => {
    if (!tauri) return;
    let disposed = false;
    listEncoderCapabilities()
      .then((capabilities) => {
        if (!disposed) setBackendCapabilities(capabilities);
      })
      .catch(() => {
        if (!disposed) setBackendCapabilities([]);
      });
    return () => {
      disposed = true;
    };
  }, [tauri]);

  useEffect(() => {
    if (!tauri) return;
    let disposed = false;
    let timer: number | undefined;
    const sample = async () => {
      try {
        const snapshot = await getRuntimeResourceSnapshot();
        if (!disposed) {
          setResourceSnapshot(snapshot);
          setResourceSamplingError("");
        }
      } catch (error) {
        if (!disposed) setResourceSamplingError(String(error));
      } finally {
        if (!disposed) timer = window.setTimeout(sample, busy ? 1_000 : 5_000);
      }
    };
    void sample();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [busy, tauri]);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
  }, [history]);

  useEffect(() => () => {
    if (previewTimer.current) window.clearInterval(previewTimer.current);
    previewHoldRef.current = null;
    taskGateRef.current.cancel();
    qualityScoringTaskIdRef.current = null;
    void cancelBackendTasks([...activeBackendTaskIdsRef.current], cancelConversionTask);
  }, []);

  useEffect(() => {
    if (!tauri) return;
    let disposed = false;
    let unlisten: undefined | (() => void);
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") addPaths(event.payload.paths);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [tauri]);

  useEffect(() => {
    if (!active) return;
    if (sessionRestoreActiveIdRef.current === active.id) {
      sessionRestoreActiveIdRef.current = null;
      return;
    }
    const nextDuration = active.duration || 0;
    setDuration(nextDuration);
    setStart(0);
    setEnd(nextDuration);
    setSelectedFrameTimes([]);
    setDeletedFrames([]);
    setLastDeletedBatch([]);
    setFrameTimingMode("compact");
    setFrameEditorOpen(false);
    setFrameEditorPage(0);
    setFrameEditorThumbs([]);
    setFrameEditorError("");
    setFocusedFramePreview(null);
    timelineHoverIndexRef.current = null;
    setTimelineHoverPreview(null);
    setFrameAnnotationOpen(false);
    setCrop(EMPTY_CROP);
    setCropEnabled(false);
    setPreviewZoom(1);
    setCandidates([]);
    setSelectedCandidate("");
    setPreviewMode("source");
    setProgress(active.result || active.status === "完成" ? 100 : 0);
  }, [active?.id]);

  function exactFrameCacheKey(pageStart: number) {
    if (!active) return "";
    return [
      active.path.toLowerCase(),
      start.toFixed(6),
      trimEnd.toFixed(6),
      playbackSpeed.toFixed(3),
      fps,
      pageStart,
    ].join("|");
  }

  function rememberExactFramePage(cacheKey: string, frames: ExactFrameThumb[]) {
    if (!exactFramePageCacheRef.current.has(cacheKey) && exactFramePageCacheRef.current.size >= 40) {
      const oldestKey = exactFramePageCacheRef.current.keys().next().value;
      if (oldestKey) exactFramePageCacheRef.current.delete(oldestKey);
    }
    exactFramePageCacheRef.current.set(cacheKey, frames);
  }

  function loadExactFramePage(pageStart: number): Promise<ExactFrameThumb[]> {
    if (!active || totalOutputFrameCount <= 0 || trimEnd <= start) return Promise.resolve([]);
    const safePageStart = clamp(Math.floor(pageStart), 0, Math.max(0, totalOutputFrameCount - 1));
    const cacheKey = exactFrameCacheKey(safePageStart);
    const cached = exactFramePageCacheRef.current.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const pending = exactFramePagePendingRef.current.get(cacheKey);
    if (pending) return pending;
    const descriptors = editableOutputFramePage(
      start,
      trimEnd,
      playbackSpeed,
      fps,
      safePageStart,
      EXACT_FRAME_PAGE_SIZE,
    );
    const request = !tauri || active.path.startsWith("demo://")
      ? Promise.resolve(descriptors.map((frame) => {
        const nearest = active.thumbs?.reduce<Thumb | undefined>((best, thumb) =>
          !best || Math.abs(thumb.time - frame.sourceTime) < Math.abs(best.time - frame.sourceTime)
            ? thumb
            : best
        , undefined);
        return {
          index: frame.index,
          time: frame.sourceTime,
          url: nearest?.url || active.thumbnailUrl || active.sourceUrl,
        };
      }))
      : generateFramePage({
        input_path: active.path,
        start_seconds: start,
        end_seconds: trimEnd,
        playback_speed: playbackSpeed,
        fps,
        page_start: safePageStart,
        page_size: EXACT_FRAME_PAGE_SIZE,
        max_width: 240,
      }).then((result) => result.frames.map((frame) => ({
        index: frame.index,
        time: frame.time,
        url: convertFileSrc(frame.path),
      })));
    const tracked = request.then((frames) => {
      rememberExactFramePage(cacheKey, frames);
      return frames;
    }).finally(() => {
      exactFramePagePendingRef.current.delete(cacheKey);
    });
    exactFramePagePendingRef.current.set(cacheKey, tracked);
    return tracked;
  }

  function hoverTimelineFrame(index: number | null) {
    timelineHoverIndexRef.current = index;
    if (index == null || !active) {
      setTimelineHoverPreview(null);
      return;
    }
    const time = sourceTimeForOutputFrameIndex(index, start, trimEnd, playbackSpeed, fps);
    if (time == null) {
      setTimelineHoverPreview(null);
      return;
    }
    const nearest = active.thumbs?.reduce<Thumb | undefined>((best, thumb) =>
      !best || Math.abs(thumb.time - time) < Math.abs(best.time - time) ? thumb : best
    , undefined);
    setTimelineHoverPreview({
      index,
      time,
      url: nearest?.url || active.thumbnailUrl || active.sourceUrl,
    });
    const assetId = active.id;
    const pageStart = Math.floor(index / EXACT_FRAME_PAGE_SIZE) * EXACT_FRAME_PAGE_SIZE;
    void loadExactFramePage(pageStart).then((frames) => {
      if (timelineHoverIndexRef.current !== index || activeIdRef.current !== assetId) return;
      const exact = frames.find((frame) => frame.index === index);
      if (exact) setTimelineHoverPreview(exact);
    }).catch(() => undefined);
  }

  useEffect(() => {
    if (!frameEditorOpen || !active || totalOutputFrameCount <= 0 || trimEnd <= start) return;
    const pageCount = Math.max(1, Math.ceil(totalOutputFrameCount / EXACT_FRAME_PAGE_SIZE));
    const safePage = clamp(frameEditorPage, 0, pageCount - 1);
    if (safePage !== frameEditorPage) {
      setFrameEditorPage(safePage);
      return;
    }
    const pageStart = safePage * EXACT_FRAME_PAGE_SIZE;
    const token = framePageTokenRef.current + 1;
    framePageTokenRef.current = token;
    setFrameEditorLoading(true);
    setFrameEditorError("");
    setFrameEditorThumbs([]);
    void loadExactFramePage(pageStart).then((frames) => {
      if (framePageTokenRef.current !== token) return;
      setFrameEditorThumbs(frames);
      setFrameEditorLoading(false);
      setFrameEditorError("");
    }).catch((error) => {
      if (framePageTokenRef.current !== token) return;
      setFrameEditorLoading(false);
      setFrameEditorThumbs([]);
      setFrameEditorError(`逐帧缩略图生成失败：${String(error)}`);
    });
  }, [active?.id, active?.path, fps, frameEditorOpen, frameEditorPage, playbackSpeed, start, tauri, totalOutputFrameCount, trimEnd]);

  useEffect(() => {
    if (mode === "quick") {
      setSettingsDrawerOpen(false);
      setQuickWizardOpen(Boolean(active));
    } else {
      setQuickWizardOpen(false);
      if (mode !== "editor") setSettingsDrawerOpen(false);
    }
  }, [mode, active?.id]);

  useEffect(() => () => {
    if (exportHeartbeatTimer.current !== null) {
      window.clearInterval(exportHeartbeatTimer.current);
      exportHeartbeatTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const devWindow = window as GifpDevWindow;
    devWindow.__GIFP_V3_DEV__ = {
      addPaths,
      snapshot: () => ({
        mode,
        activePath: active?.path || "",
        assetCount: assets.length,
        assets: assets.map(({ id, path, kind, status: assetStatus, thumbnailUrl, duration: assetDuration, dimensions, frameCount, animated, hasAlpha, error, timelineError, result }) => ({
          id,
          path,
          kind,
          status: assetStatus,
          thumbnailUrl,
          duration: assetDuration,
          dimensions,
          frameCount,
          animated,
          hasAlpha,
          error,
          timelineError,
          outputPath: result?.output_path,
        })),
        candidates: candidates.map(({ presetId: candidatePresetId, label, previewUrl, error }) => ({
          presetId: candidatePresetId,
          label,
          previewUrl,
          error,
        })),
        recording,
        playbackSpeed,
        crop,
        cropEnabled,
        outputFormat,
        previewMode,
        presentedExport: presentedExport ? {
          url: presentedExport.url,
          format: presentedExport.format,
          label: presentedExport.label,
          snapshot: presentedExport.snapshot,
          outputPath: presentedExport.result?.output_path,
        } : undefined,
        status,
      }),
    };
    return () => {
      delete devWindow.__GIFP_V3_DEV__;
    };
  }, [active?.path, assets, candidates, crop, cropEnabled, mode, outputFormat, playbackSpeed, presentedExport, previewMode, recording, status]);

  function restoreLastSessionDraft() {
    if (!recoverableSession) return;
    const draft = recoverableSession.data;
    pendingSessionRestoreRef.current = draft;
    setOutputDir(draft.outputDir);
    setMergeItems(draft.mergePaths);
    setRecoverableSession(null);
    const restoredAssets: MediaAsset[] = draft.assets.map((saved) => ({
      ...mediaFromPath(saved.path),
      id: saved.id,
      name: saved.name,
      kind: saved.kind,
      duration: saved.duration,
      dimensions: saved.dimensions,
      frameCount: saved.frameCount,
      animated: saved.animated,
      hasAlpha: saved.hasAlpha,
      codec: saved.codec,
    }));
    setAssets(restoredAssets);
    assetPathsRef.current = new Map(restoredAssets.map((asset) => [asset.id, asset.path.toLowerCase()]));
    const preferred = restoredAssets.find((asset) => asset.id === draft.activeAssetId)
      ?? restoredAssets.find((asset) => asset.path.toLowerCase() === draft.activeAssetPath?.toLowerCase())
      ?? restoredAssets.find(isConvertibleAsset);
    sessionRestoreActiveIdRef.current = preferred?.id ?? null;
    setActiveId(preferred?.id ?? "");
    setMode(draft.mode === "record" || draft.mode === "poster" ? "editor" : draft.mode);
    setStatus("正在重新连接上一次任务的素材…");
    if (tauri) void runBoundedQueue(restoredAssets, 2, async (asset) => inspectAddedAsset(asset));
  }

  function discardLastSessionDraft() {
    clearSessionDraft(localStorage);
    pendingSessionRestoreRef.current = null;
    sessionFingerprintRef.current = null;
    setRecoverableSession(null);
    setSessionAutosaveEnabled(true);
    setStatus("已放弃上一次任务，新任务会继续自动保存");
  }

  function addPaths(paths: string[], options?: { activePath?: string }) {
    const supported = paths.filter((path) => SUPPORTED_RE.test(path));
    if (!supported.length) {
      setStatus("支持 GIF、WebP、APNG、PNG、MP4、MOV、MKV、WEBM 和 JPG");
      return;
    }
    const incoming = supported.map(mediaFromPath);
    incoming.forEach((asset) => assetPathsRef.current.set(asset.id, asset.path.toLowerCase()));
    setAssets((current) => {
      const incomingPaths = new Set(incoming.map((item) => item.path.toLowerCase()));
      return [...incoming, ...current.filter((item) => !incomingPaths.has(item.path.toLowerCase()))];
    });
    const mergeable = incoming.filter((item) => item.kind !== "video");
    if (mergeable.length) {
      setMergeItems((current) => {
        const known = new Set(current.map((item) => item.toLowerCase()));
        return [...current, ...mergeable.map((item) => item.path).filter((path) => !known.has(path.toLowerCase()))];
      });
    }
    const preferred = options?.activePath
      ? incoming.find((item) => item.path.toLowerCase() === options.activePath?.toLowerCase())
      : undefined;
    const editable = preferred && isConvertibleAsset(preferred) ? preferred : incoming.find(isConvertibleAsset);
    if (mode === "meme") {
      setActiveId(incoming[0].id);
      setMode("meme");
    } else if (editable) {
      setActiveId(editable.id);
      setMode(mode === "quick" ? "quick" : "editor");
      if (mode === "quick") setQuickWizardOpen(true);
    } else {
      setMode("merge");
    }
    setOutputDir((current) => current || dirname(incoming[0].path));
    setStatus(`已加入 ${incoming.length} 个素材`);
    if (tauri) void runBoundedQueue(incoming, 2, async (asset) => inspectAddedAsset(asset));
  }

  async function inspectAddedAsset(asset: MediaAsset) {
    if (asset.path.startsWith("demo://")) return;
    const token = (inspectTokens.current[asset.id] || 0) + 1;
    inspectTokens.current[asset.id] = token;
    try {
      const inspection = await inspectMedia(asset.path);
      if (inspectTokens.current[asset.id] !== token) return;
      const kind = kindFromInspection(asset, inspection);
      const widthValue = Math.max(0, Number(inspection.width) || 0);
      const heightValue = Math.max(0, Number(inspection.height) || 0);
      const nextDuration = Math.max(0, Number(inspection.duration) || 0);
      const frameCount = Math.max(1, Math.round(Number(inspection.frame_count) || 1));
      updateAsset(asset.id, {
        kind,
        codec: inspection.codec,
        animated: Boolean(inspection.animated),
        hasAlpha: Boolean(inspection.has_alpha),
        frameCount,
        duration: nextDuration,
        dimensions: widthValue && heightValue ? `${widthValue} × ${heightValue}` : undefined,
        aspect: widthValue && heightValue ? widthValue / heightValue : undefined,
        error: undefined,
      }, asset.path);
      if (kind !== "video" && Boolean(inspection.animated) && nextDuration > 0) {
        void captureMediaTimeline(asset.id, asset.path, nextDuration, frameCount, widthValue, heightValue);
      }
    } catch (error) {
      if (inspectTokens.current[asset.id] !== token) return;
      updateAsset(asset.id, { error: `媒体信息读取失败：${String(error)}` }, asset.path);
    }
  }

  async function captureMediaTimeline(assetId: string, assetPath: string, mediaDuration: number, frameCount = 0, widthValue = 0, heightValue = 0) {
    if (!tauri || assetPath.startsWith("demo://") || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return;
    const token = (captureTokens.current[assetId] || 0) + 1;
    captureTokens.current[assetId] = token;
    const load = assessMaterialLoad({ durationSeconds: mediaDuration, width: widthValue, height: heightValue, frameCount });
    const sampleCount = taskControlPolicy(load).thumbnailBudget;
    const samples = thumbnailSampleTimes(mediaDuration, sampleCount);
    const cacheKey = `${assetPath.toLowerCase()}|${mediaDuration.toFixed(3)}|${sampleCount}`;
    const cached = timelineCacheRef.current.get(cacheKey);
    if (cached) {
      if (captureTokens.current[assetId] !== token) return;
      updateAsset(assetId, { thumbs: cached, thumbnailUrl: cached[0]?.url, timelineError: undefined }, assetPath);
      return;
    }
    try {
      const frames = await generateMediaThumbnails({ input_path: assetPath, times: samples });
      if (captureTokens.current[assetId] !== token) return;
      const thumbs = frames.map((frame) => ({ time: frame.time, url: convertFileSrc(frame.path) }));
      timelineCacheRef.current.set(cacheKey, thumbs);
      updateAsset(assetId, { thumbs, thumbnailUrl: thumbs[0]?.url, timelineError: undefined }, assetPath);
    } catch (error) {
      if (captureTokens.current[assetId] !== token) return;
      updateAsset(assetId, { thumbs: [], timelineError: `时间线取样失败：${String(error)}` }, assetPath);
      setStatus(`动画可播放，但时间线取样失败：${String(error)}`);
    }
  }

  async function chooseMedia() {
    if (!tauri) {
      setStatus("请将素材直接拖入窗口");
      return;
    }
    try {
      addPaths(await selectVideos());
    } catch (error) {
      setStatus(`选择失败：${String(error)}`);
    }
  }

  function retryAssetInspection(assetId: string) {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) return;
    setStatus(`正在重新读取素材：${asset.name}`);
    void inspectAddedAsset(asset);
  }

  function retryAssetTimeline(assetId: string) {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset?.duration) {
      setStatus("需要先成功读取素材信息，才能重新生成时间线");
      return;
    }
    const profile = sourceProfile(asset);
    setStatus(`正在重新生成时间线：${asset.name}`);
    void captureMediaTimeline(
      asset.id,
      asset.path,
      asset.duration,
      asset.frameCount,
      profile.width,
      profile.height,
    );
  }

  async function relinkAsset(assetId: string) {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset || !tauri) return;
    let selected: string[];
    try {
      selected = await selectVideos();
    } catch (error) {
      setStatus(`重新定位失败：${String(error)}`);
      return;
    }
    if (!selected.length) return;
    const planned = planAssetReplacement(asset, selected[0]);
    if (!planned.ok) {
      setStatus(planned.reason === "unsupported-format"
        ? "替代文件格式不受支持，请选择 GIF、WebP、APNG、PNG、JPG 或视频"
        : "没有选择有效的替代文件");
      return;
    }
    const fresh = mediaFromPath(planned.plan.newPath);
    const replacement = {
      ...applyAssetReplacement(asset, planned.plan),
      sourceUrl: fresh.sourceUrl,
      thumbnailUrl: fresh.thumbnailUrl,
    } as MediaAsset;
    inspectTokens.current[asset.id] = (inspectTokens.current[asset.id] || 0) + 1;
    captureTokens.current[asset.id] = (captureTokens.current[asset.id] || 0) + 1;
    mediaInfoRef.current.delete(asset.id);
    assetPathsRef.current.set(asset.id, replacement.path.toLowerCase());
    setAssets((items) => items.map((item) => item.id === asset.id ? replacement : item));
    setMergeItems((items) => replaceMergePaths(items, asset.path, replacement.path));
    setCandidates((items) => items.filter((candidate) => candidate.sourceAssetId !== asset.id));
    setSelectedCandidate("");
    setPreviewMode("source");
    setProgress(0);
    setStatus(`已重新定位为 ${replacement.name}，正在读取素材信息…`);
    void inspectAddedAsset(replacement);
  }

  async function chooseOutput() {
    if (!tauri) {
      const selected = "C:/GIFP/Exports";
      setOutputDir(selected);
      setStatus(`输出目录已设置：${selected}`);
      return;
    }
    try {
      const selected = await selectOutputDir();
      if (selected) {
        setOutputDir(selected);
        setStatus(`输出目录已设置：${selected}`);
      }
    } catch (error) {
      setStatus(`选择输出目录失败：${String(error)}`);
    }
  }

  async function openOutput(path?: string) {
    const target = path
      ? /\.pvt[\\/]?$/i.test(path) ? path.replace(/[\\/]+$/, "") : dirname(path)
      : outputDir || (active ? dirname(active.path) : "");
    if (!target) {
      setStatus("还没有可打开的输出目录");
      return;
    }
    if (!tauri) {
      setStatus(`输出目录：${target}`);
      return;
    }
    try {
      await openDirectory(target);
    } catch (error) {
      setStatus(`打开目录失败：${String(error)}`);
    }
  }

  function chooseQuickFormat(next: DeliveryFormatPreference) {
    // Re-selecting the current purpose must not reset an entered cap or tuning.
    if (next === deliveryFormatPreference) return;
    setDeliveryFormatPreference(next);
    const requestedFormat: OutputFormat = next === "all" || next === "auto" ? "gif" : next;
    const basePresetId: CompressionPresetId = requestedFormat === "gif" ? "qq" : "perceptual";
    const basePreset = COMPRESSION_PRESETS.find((preset) => preset.id === basePresetId);
    if (!basePreset) return;
    const profile = sourceProfile(active);
    const resolved = presetForOutputFormat(basePreset, requestedFormat, profile);
    const preserveManualQuickSpecs = mode === "meme" || Boolean(active && quickUserAdjustedRef.current.has(active.id));
    setPresetId(basePreset.id);
    setPresetAdjusted(true);
    if (!preserveManualQuickSpecs) {
      setWidth(resolved.width);
      setFps(resolved.fps);
      setQuickScalePercent(quickScalePercentForWidth(profile.width ?? resolved.width, resolved.width));
    }
    setColors(clamp(resolved.colors, 3, 256));
    setDither(resolved.dither);
    setLossy(resolved.lossy);
    setOptimizeLevel(resolved.optimizeLevel);
    setEncoder(resolved.encoder);
    setFilter(resolved.filter);
    setGenerationMode(requestedFormat === "gif" ? "best_gif" : "fast_gif");
  }

  function chooseDeliveryIntent(next: DeliveryIntent) {
    setDeliveryIntent(next);
    setDeliveryFormatPreference("auto");
  }

  function chooseTargetPlatform(next: TargetPlatform) {
    setTargetPlatform(next);
    setDeliveryFormatPreference("auto");
  }

  function chooseDeliveryFormat(next: DeliveryFormatPreference) {
    setDeliveryFormatPreference(next);
  }

  function choosePreset(next: CompressionPresetId) {
    setPresetId(next);
    setPresetAdjusted(false);
    if (next === "custom") {
      const saved = readCustomSettings(currentSettings);
      setWidth(saved.width);
      setFps(saved.fps);
      setColors(clamp(saved.colors, 3, 256));
      setDither(saved.dither);
      setLossy(saved.lossy);
      setOptimizeLevel(saved.optimizeLevel);
      setFilter(saved.filter);
      setBayerScale(saved.bayerScale ?? 2);
      setAlphaThreshold(saved.alphaThreshold ?? 128);
      setEncoder(saved.encoder);
      setStatus("已加载自定义参数");
      return;
    }
    const preset = COMPRESSION_PRESETS.find((item) => item.id === next);
    if (!preset) return;
    const resolved = presetForOutputFormat(preset, outputFormat, sourceProfile(active));
    setWidth(resolved.width);
    setFps(resolved.fps);
    setColors(clamp(resolved.colors, 3, 256));
    setDither(resolved.dither);
    setLossy(resolved.lossy);
    setOptimizeLevel(resolved.optimizeLevel);
    setFilter(resolved.filter);
    setEncoder(resolved.encoder);
    setStatus(`已套用「${preset.label}」${outputFormat === "gif" ? "" : ` · ${formatLabel(outputFormat)} 自适应`}`);
  }

  function tuneAndRegenerate(direction: OutputTuningDirection) {
    if (!active || busy) return;
    const source = sourceProfile(active);
    setPresetId("custom");
    setPresetAdjusted(true);
    if (direction === "clearer") {
      setWidth((value) => clamp(Math.round(Math.min(source.width ?? 1920, Math.max(value + 64, value * 1.18))), 96, 1920));
      setFps((value) => clamp(Math.round(Math.min(source.fps ?? 60, value + 4)), 1, 60));
      setColors((value) => clamp(Math.max(value + 32, Math.round(value * 1.2)), 3, 256));
      setLossy((value) => clamp(value - 15, 0, 100));
      setOptimizeLevel((value) => clamp(value + 1, 1, 4));
      setGenerationMode(outputFormat === "gif" ? "best_gif" : "fast_gif");
      setStatus("已提高尺寸、颜色和质量参数，准备重新生成");
    } else if (direction === "smaller") {
      setWidth((value) => clamp(Math.round(value * 0.82), 96, 1920));
      setFps((value) => clamp(Math.round(value * 0.82), 1, 60));
      setColors((value) => clamp(Math.round(value * 0.75), 3, 256));
      setLossy((value) => clamp(value + 15, 0, 100));
      setStatus("已降低尺寸、帧率和颜色预算，准备重新生成");
    } else {
      setFps((value) => clamp(Math.round(Math.min(source.fps ?? 60, Math.max(value + 5, value * 1.25))), 1, 60));
      setWidth((value) => clamp(Math.round(value * 0.92), 96, 1920));
      setStatus("已提高帧率并平衡画面尺寸，准备重新生成");
    }
    setPendingOutputTuning({ direction, nonce: Date.now() });
  }

  function markCustom() {
    setPresetAdjusted(true);
  }

  function saveCustomPreset() {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(currentSettings));
    setPresetId("custom");
    setPresetAdjusted(false);
    setStatus("自定义参数已保存");
  }

  function updateAsset(assetId: string, patch: Partial<MediaAsset>, expectedPath?: string) {
    if (expectedPath && assetPathsRef.current.get(assetId) !== expectedPath.toLowerCase()) return;
    const discoveredAspect = Number(patch.aspect);
    const discoveredDuration = Number(patch.duration);
    const knownMediaInfo = mediaInfoRef.current.get(assetId) ?? {};
    if (Number.isFinite(discoveredAspect) && discoveredAspect > 0) knownMediaInfo.aspect = discoveredAspect;
    if (Number.isFinite(discoveredDuration) && discoveredDuration > 0) knownMediaInfo.duration = discoveredDuration;
    mediaInfoRef.current.set(assetId, knownMediaInfo);
    setAssets((current) => current.map((item) => {
      if (item.id !== assetId || (expectedPath && item.path.toLowerCase() !== expectedPath.toLowerCase())) return item;
      const next = { ...item, ...patch };
      if (next.comparisonSnapshot) {
        next.comparisonSnapshot = snapshotWithMediaInfo(
          next.comparisonSnapshot,
          Number(next.aspect),
          Number(next.duration),
        );
      }
      return next;
    }));
    if ((Number.isFinite(discoveredAspect) && discoveredAspect > 0)
      || (Number.isFinite(discoveredDuration) && discoveredDuration > 0)) {
      setCandidates((current) => current.map((candidate) => candidate.sourceAssetId === assetId && candidate.comparisonSnapshot ? {
        ...candidate,
        comparisonSnapshot: snapshotWithMediaInfo(
          candidate.comparisonSnapshot,
          knownMediaInfo.aspect ?? discoveredAspect,
          knownMediaInfo.duration ?? discoveredDuration,
        ),
      } : candidate));
    }
  }

  function rememberResult(result: GifResult) {
    setHistory((items) => [result, ...items.filter((item) => item.output_path !== result.output_path)].slice(0, HISTORY_LIMIT));
  }

  function beginTask(label: string, total = 1): TaskRun {
    // A new export takes priority over the previous result's optional scoring.
    const scoringTaskId = qualityScoringTaskIdRef.current;
    if (scoringTaskId) {
      cancelledQualityTaskIdsRef.current.add(scoringTaskId);
      qualityScoringTaskIdRef.current = null;
      setQualityScoringTaskId(null);
      setQualityCancelPending(false);
      void cancelBackendTasks([scoringTaskId], cancelConversionTask);
    }
    const run = taskGateRef.current.start();
    setActiveTask({ generation: run.generation, label, kind: "generating", total, completed: 0 });
    return run;
  }

  function updateTask(run: TaskRun, patch: Partial<Pick<ActiveTaskState, "label" | "kind" | "completed">>) {
    if (!run.isCurrent()) return;
    setActiveTask((current) => current?.generation === run.generation ? { ...current, ...patch } : current);
  }

  function completeTask(run: TaskRun, kind: "completed" | "failed" = "completed") {
    if (!run.isCurrent()) return;
    setActiveTask((current) => current?.generation === run.generation ? { ...current, kind, completed: kind === "completed" ? current.total : current.completed } : current);
  }

  function settleCancelledTask(run: TaskRun) {
    setActiveTask((current) => current?.generation === run.generation ? { ...current, kind: "cancelled" } : current);
  }

  function requestCancelTask() {
    if (!activeTask || !taskGateRef.current.cancel()) return;
    const backendTaskIds = [...activeBackendTaskIdsRef.current];
    void cancelBackendTasks(backendTaskIds, cancelConversionTask).then(({ accepted, failed }) => {
      setStatus(accepted > 0
        ? `已终止 ${accepted} 个编码进程${failed > 0 ? `；另有 ${failed} 项停止请求失败` : ""}，正在确认临时输出清理…`
        : failed > 0
          ? `任务派发已停止，但 ${failed} 项后端停止请求失败；晚到结果仍不会覆盖当前任务`
          : "任务派发已停止；编码已结束或正在完成原子提交");
    });
    candidateRunRef.current += 1;
    stopExportHeartbeat();
    setActiveTask((current) => current ? { ...current, kind: activeQueueJobs > 0 ? "cancelling" : "cancelled" } : current);
    setAssets((items) => items.map((item) => item.status === "生成中" ? { ...item, status: "等待", error: "任务已停止，未覆盖上一次可用结果" } : item));
    setStatus(activeQueueJobs > 0
      ? `正在请求终止 ${backendTaskIds.length || activeQueueJobs} 个编码进程…`
      : "任务已停止，没有覆盖上一次可用结果");
  }

  function nextBackendTaskId() {
    backendTaskSequenceRef.current += 1;
    return `gifp-${Date.now().toString(36)}-${backendTaskSequenceRef.current.toString(36)}`;
  }

  async function runConversion(request: GifRequest) {
    const taskId = nextBackendTaskId();
    activeBackendTaskIdsRef.current.add(taskId);
    setActiveQueueJobs((count) => count + 1);
    try {
      return await convertAnimation({ ...request, task_id: taskId });
    } finally {
      activeBackendTaskIdsRef.current.delete(taskId);
      setActiveQueueJobs((count) => Math.max(0, count - 1));
    }
  }

  async function runQualityEvaluation(request: GifRequest, outputPath: string) {
    const taskId = nextBackendTaskId();
    activeBackendTaskIdsRef.current.add(taskId);
    qualityScoringTaskIdRef.current = taskId;
    setQualityScoringTaskId(taskId);
    setQualityCancelPending(false);
    try {
      const report = await evaluateOutputQuality({
        encode_request: { ...request, task_id: taskId },
        output_path: outputPath,
      });
      if (cancelledQualityTaskIdsRef.current.has(taskId)) {
        throw new Error("质量评分已由用户终止");
      }
      return report;
    } finally {
      activeBackendTaskIdsRef.current.delete(taskId);
      cancelledQualityTaskIdsRef.current.delete(taskId);
      if (qualityScoringTaskIdRef.current === taskId) {
        qualityScoringTaskIdRef.current = null;
        setQualityScoringTaskId(null);
        setQualityCancelPending(false);
      }
    }
  }

  function requestCancelQualityScoring() {
    const taskId = qualityScoringTaskIdRef.current;
    if (!taskId || qualityCancelPending) return;
    cancelledQualityTaskIdsRef.current.add(taskId);
    setQualityCancelPending(true);
    void cancelConversionTask(taskId).catch(() => {
      if (qualityScoringTaskIdRef.current !== taskId) return;
      cancelledQualityTaskIdsRef.current.delete(taskId);
      setStatus("已生成 · 评分停止请求失败，可以重试");
      setQualityCancelPending(false);
    });
  }

  async function scorePublishedResult(request: GifRequest, result: GifResult, assetId: string, taskRun: TaskRun) {
    let qualityReport: OutputQualityReport;
    try {
      qualityReport = await runQualityEvaluation(request, result.output_path);
    } catch (error) {
      qualityReport = {
        status: "unavailable",
        metric_model: "VMAF NEG v0.6.1 · float SSIM",
        sample_duration_seconds: 0,
        compared_frames: 0,
        vmaf_mean: null,
        vmaf_p05: null,
        ssim_mean: null,
        ms_ssim_mean: null,
        elapsed_ms: 0,
        message: String(error),
      };
    }
    if (!taskRun.isCurrent()) return;
    // Enrich this exact result without changing preview, edit state or history order.
    setAssets((items) => items.map((item) => item.id === assetId && item.result?.output_path === result.output_path
      ? { ...item, result: { ...item.result, quality_report: qualityReport } }
      : item));
    setHistory((items) => items.map((item) => item.output_path === result.output_path
      ? { ...item, quality_report: qualityReport }
      : item));
  }

  function reportRecoverableFailure(
    operation: string,
    error: unknown,
    retry?: () => void,
    retryLabel = "重试",
    contextAssetId?: string,
  ) {
    const failure = classifyDesktopFailure(error);
    if (failure.category === "cancelled") return;
    setFailureCopyStatus("");
    setFailureTechnicalOpen(false);
    setFailureIncident({
      id: Date.now(),
      operation,
      occurredAt: new Date(),
      failure,
      retry: failure.retryable ? retry : undefined,
      retryLabel,
      contextAssetId,
    });
  }

  function retryFailureIncident() {
    if (!failureIncident?.retry || busy) return;
    const retry = failureIncident.retry;
    setFailureIncident(null);
    setFailureCopyStatus("");
    setFailureTechnicalOpen(false);
    retry();
  }

  async function copyFailureDiagnostic() {
    if (!failureIncident) return;
    const ffmpeg = backendCapabilities.find((backend) => backend.id === "ffmpeg.animation");
    const diagnostic = buildFailureDiagnostic({
      version: PRODUCT_VERSION,
      operation: failureIncident.operation,
      occurredAt: failureIncident.occurredAt,
      failure: failureIncident.failure,
      backend: {
        ffmpegAvailable: ffmpeg?.status.state === "available",
        ffprobeAvailable: ffmpeg?.status.state === "available",
        gifEncoderAvailable: ffmpeg?.features.gif_encoding,
        hardwareAcceleration: resourceSnapshot?.gpu_backend ?? null,
      },
      resources: {
        memoryUsedBytes: resourceSnapshot?.used_memory_bytes,
        memoryTotalBytes: resourceSnapshot?.total_memory_bytes,
        activeTasks: resourceSnapshot?.active_conversion_jobs,
      },
    });
    try {
      await navigator.clipboard.writeText(diagnostic);
      setFailureCopyStatus("安全诊断已复制（仅含白名单字段）");
    } catch {
      const field = document.createElement("textarea");
      field.value = diagnostic;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const copied = typeof document.execCommand === "function" && document.execCommand("copy");
      field.remove();
      setFailureCopyStatus(copied ? "安全诊断已复制（仅含白名单字段）" : "复制失败，请稍后重试");
    }
  }

  function stopExportHeartbeat() {
    if (exportHeartbeatTimer.current === null) return;
    window.clearInterval(exportHeartbeatTimer.current);
    exportHeartbeatTimer.current = null;
  }

  function startExportHeartbeat(asset: MediaAsset, format: OutputFormat, targetSizeSearch: boolean) {
    stopExportHeartbeat();
    const startedAt = Date.now();
    const update = () => {
      const heartbeat = exportHeartbeatForElapsed(Date.now() - startedAt, targetSizeSearch);
      setProgress((current) => Math.max(current, heartbeat.progress));
      setStatus(`正在${heartbeat.stage}：${formatLabel(format)} · ${asset.name}（进度为估算，完成后核验文件）`);
    };
    update();
    exportHeartbeatTimer.current = window.setInterval(update, 800);
  }

  function applyMemeOverlay(settings: MemeOverlaySettings, destination: "editor" | "quick" = "editor") {
    if (!active || settings.sourceAssetId !== active.id) {
      setStatus("表情包素材已经切换，请重新确认文字预览");
      return;
    }
    setMemeDraft(settings);
    setMemeOverlay(settings);
    setPresetAdjusted(true);
    setPerceptualFocus("text_ui");
    setDeliveryIntent("compatibility");
    setDeliveryFormatPreference("gif");
    // Open the delivery card over the meme workspace so crop, timing, cutout
    // and tracked effects keep their editor export semantics.
    setMode(destination === "quick" ? "meme" : "editor");
    setQuickWizardOpen(destination === "quick");
    setStatus("表情包文字已应用，可以调整大小并生成");
  }

  function buildCurrentRequest(
    asset: MediaAsset,
    requestedPreset = presetId,
    useCurrentOverrides = true,
    targetProfile?: TargetPortfolioProfile,
    requestedOutputFormat: OutputFormat = outputFormat,
    overlayOverride?: MemeOverlaySettings | null,
  ) {
    const isActive = asset.id === active?.id;
    const effectiveGenerationMode: GifGenerationMode = requestedOutputFormat === "gif" ? generationMode : "fast_gif";
    const activeOverlay = overlayOverride !== undefined ? overlayOverride : isActive && memeOverlay?.sourceAssetId === asset.id ? memeOverlay : null;
    const overlayStart = activeOverlay?.startSeconds == null ? null : compactedOutputTimeForSourceTime(
      activeOverlay.startSeconds, start, trimEnd, playbackSpeed, compactionRanges,
    );
    const overlayEnd = activeOverlay?.endSeconds == null ? null : compactedOutputTimeForSourceTime(
      activeOverlay.endSeconds, start, trimEnd, playbackSpeed, compactionRanges,
    );
    const effectiveTrackedEffects: TrackedEffectRequest[] = isActive ? trackedEffects
      .filter((effect) => effect.sourceAssetId === asset.id)
      .flatMap((effect): TrackedEffectRequest[] => {
        const effectStart = compactedOutputTimeForSourceTime(effect.startSeconds, start, trimEnd, playbackSpeed, compactionRanges);
        const effectEnd = compactedOutputTimeForSourceTime(effect.endSeconds, start, trimEnd, playbackSpeed, compactionRanges);
        if (effectStart == null || effectEnd == null || effectEnd <= effectStart + 0.01) return [];
        const mappedKeyframes = effect.keyframes
          .filter((frame) => frame.timeSeconds >= start - 0.001 && frame.timeSeconds <= trimEnd + 0.001)
          .flatMap((frame): TrackedEffectRequest["keyframes"] => {
            const timeSeconds = compactedOutputTimeForSourceTime(frame.timeSeconds, start, trimEnd, playbackSpeed, compactionRanges);
            if (timeSeconds == null) return [];
            const box = cropEnabled ? transformTrackedBoxForCrop(frame, crop) : normalizeTrackedBox(frame);
            return [{
              time_seconds: timeSeconds,
              x_percent: box.x,
              y_percent: box.y,
              width_percent: box.width,
              height_percent: box.height,
              confidence: frame.confidence,
            }];
          })
          .sort((left, right) => left.time_seconds - right.time_seconds)
          .filter((frame, index, items) => index === 0 || Math.abs(frame.time_seconds - items[index - 1].time_seconds) > 0.001)
          .slice(0, 32);
        if (mappedKeyframes.length === 0) return [];
        return [{
          effect_id: effect.id,
          kind: effect.kind,
          label: effect.label,
          start_seconds: effectStart,
          end_seconds: effectEnd,
          keyframes: mappedKeyframes,
        }];
      })
      : [];
    const directorPlan = volumeDirectorActive ? volumeDirectorPlan : null;
    return buildGifRequest({
      smartLossless,
      smallerGif: smallerGif && optimizerReady,
      indexCompression,
      gentleIndex,
      mergeGifFrames,
      compactGifPalette,
      inputPath: asset.path,
      outputDir: outputDir || dirname(asset.path),
      presetId: requestedPreset,
      playbackSpeed,
      loopOutput,
      crop: isActive && cropEnabled ? crop : EMPTY_CROP,
      startSeconds: isActive ? start : 0,
      endSeconds: isActive && trimEnd > start ? trimEnd : 0,
      deletedFrames: isActive ? validDeletedFrames : [],
      deletedRanges: [],
      frameTimingMode,
      generationMode: effectiveGenerationMode,
      targetSizeBytes: requestedOutputFormat === "gif" && generationMode === "target_size"
        ? targetProfile?.targetSizeBytes ?? Math.round(targetSizeMb * 1024 * 1024)
        : null,
      targetTolerancePercent: 5,
      targetMaxAttempts: directorPlan?.maxAttempts ?? 8,
      targetPreference: targetProfile?.targetPreference ?? directorPlan?.targetPreference ?? "auto",
      bayerScale,
      alphaThreshold,
      allowExperimental: false,
      perceptualFocus: activeOverlay ? "text_ui" : directorPlan?.perceptualFocus ?? perceptualFocus,
      outputFormat: requestedOutputFormat,
      memeOverlay: activeOverlay ? {
        top_text: activeOverlay.topText,
        bottom_text: activeOverlay.bottomText,
        style: activeOverlay.style,
        font_size: activeOverlay.fontSize,
        text_align: activeOverlay.textAlign,
        position: activeOverlay.position,
        top_x: activeOverlay.topPosition.x,
        top_y: activeOverlay.topPosition.y,
        bottom_x: activeOverlay.bottomPosition.x,
        bottom_y: activeOverlay.bottomPosition.y,
        start_seconds: overlayStart,
        end_seconds: overlayEnd,
      } : null,
      backgroundRemoval: mode !== "quick" && ["gif", "webp", "apng", "webm"].includes(requestedOutputFormat)
        ? backgroundRemoval
        : null,
      trackedEffects: mode !== "quick" ? effectiveTrackedEffects : [],
      overrides: useCurrentOverrides ? {
        width: targetProfile?.width ?? directorPlan?.suggestedWidth ?? width,
        fps: targetProfile?.fps ?? directorPlan?.suggestedFps ?? fps,
        colors: targetProfile?.colors ?? directorPlan?.suggestedColors ?? clamp(colors, 3, 256),
        // The detailed UI locks fast and target-size modes to Bayer. Keep the
        // export contract identical to what the control shows even when the
        // volume director recommends another dither route.
        dither: effectiveGenerationMode === "best_gif" ? dither : "bayer",
        lossy: directorPlan?.suggestedLossy ?? lossy,
        optimize_level: optimizeLevel,
        encoder: requestedOutputFormat === "gif" && asset.hasAlpha ? "ffmpeg_fast" : encoder,
        filter_style: filter,
      } : undefined,
    });
  }

  const memeOutputKey = mode === "meme" && active ? JSON.stringify(buildCurrentRequest(active, presetId, true, undefined, "gif", null)) : "";
  const activeMemeCollection = active
    ? invalidateMemeOutputs(memeCollections[active.id] ?? createMemeCollection(active.id, memeOutputKey, memeDraft?.sourceAssetId === active.id ? memeDraft : undefined), memeOutputKey)
    : createMemeCollection("empty", "");

  useEffect(() => {
    if (mode !== "meme" || !active || busy) return;
    setMemeCollections(current => {
      const existing = current[active.id];
      if (existing?.outputKey === memeOutputKey) return current;
      return { ...current, [active.id]: existing ? invalidateMemeOutputs(existing, memeOutputKey) : activeMemeCollection };
    });
  }, [mode, active?.id, memeOutputKey, busy]);

  async function generateMemeSet(retry = false) {
    if (!active || busy || memeBatchOwner.current || !tauri || active.path.startsWith("demo://")) return;
    const owner = active.id;
    const collection = activeMemeCollection;
    const items = memeExportItems(collection, retry);
    if (!items.length || items.some(item => !item.settings.topText.trim() && !item.settings.bottomText.trim())) return;
    const jobs = items.map(item => ({ id: item.id, revision: item.revision, request: structuredClone(
      retry && item.request ? item.request : buildCurrentRequest(active, presetId, true, undefined, "gif", item.settings),
    ) }));
    memeBatchOwner.current = owner;
    const run = beginTask(`制作 ${items.length} 张表情`, items.length);
    setBusy(true);
    setProgress(0);
    setMemeCollections(current => ({ ...current, [owner]: { ...collection, items: collection.items.map(item => {
      const job = jobs.find(candidate => candidate.id === item.id);
      return job ? { ...item, request: job.request, status: "queued", result: undefined, error: undefined } : item;
    }) } }));
    let finished = 0;
    try {
      const outcome = await runMemeQueue(jobs, runConversion, run.isCurrent, (job, patch) => {
        setMemeCollections(current => {
          const deck = current[owner];
          if (!deck) return current;
          return { ...current, [owner]: { ...deck, items: deck.items.map(item => item.id === job.id && item.revision === job.revision ? { ...item, ...patch } : item) } };
        });
        if (patch.result) rememberResult(patch.result);
        if (patch.status === "completed" || patch.status === "failed") {
          finished++;
          setProgress(Math.round(finished / jobs.length * 100));
          updateTask(run, { completed: finished });
        }
        setStatus(patch.status === "running" ? `正在制作第 ${finished + 1} / ${jobs.length} 张表情` : `已处理 ${finished} / ${jobs.length} 张表情`);
      });
      if (run.isCurrent()) {
        completeTask(run, outcome.failed ? "failed" : "completed");
        setStatus(`表情组已生成 ${outcome.completed} 张${outcome.failed ? `，${outcome.failed} 张失败，可单独重试` : "，可打开文件夹使用"}`);
      }
    } finally {
      if (!run.isCurrent()) {
        setMemeCollections(current => {
          const deck = current[owner];
          if (!deck) return current;
          return { ...current, [owner]: { ...deck, items: deck.items.map(item =>
            jobs.some(job => job.id === item.id && job.revision === item.revision) && (item.status === "running" || item.status === "queued")
              ? { ...item, status: "cancelled" } : item) } };
        });
        settleCancelledTask(run);
      }
      memeBatchOwner.current = null;
      if (run.isCurrent() || !taskGateRef.current.active) setBusy(false);
    }
  }

  function createComparisonSnapshot(
    asset: MediaAsset,
    requestedFormat: OutputFormat,
    request: GifRequest,
    result?: GifResult,
  ): ExportComparisonSnapshot {
    const knownMediaInfo = mediaInfoRef.current.get(asset.id);
    const latestAspect = knownMediaInfo?.aspect ?? asset.aspect;
    const latestDuration = knownMediaInfo?.duration ?? asset.duration;
    const sourceAspect = Number.isFinite(latestAspect) && (latestAspect ?? 0) > 0 ? latestAspect : undefined;
    const appliedCrop = request.crop_enabled ? {
      left: request.crop_left,
      top: request.crop_top,
      right: request.crop_right,
      bottom: request.crop_bottom,
    } : { ...EMPTY_CROP };
    const visibleWidth = Math.max(0.01, 1 - (appliedCrop.left + appliedCrop.right) / 100);
    const visibleHeight = Math.max(0.01, 1 - (appliedCrop.top + appliedCrop.bottom) / 100);
    const startSeconds = request.start_seconds;
    const endSeconds = request.end_seconds > startSeconds ? request.end_seconds : latestDuration || 0;
    const outputFps = Number.isFinite(result?.output_fps) && (result?.output_fps ?? 0) > 0
      ? clamp(Math.round(result!.output_fps!), 1, 60)
      : request.fps;
    const deletedFrameIndices = [...new Set(request.deleted_frames.flatMap((time) => {
      const index = outputFrameIndexForSourceTime(
        time,
        startSeconds,
        endSeconds,
        request.playback_speed,
        outputFps,
      );
      return index === null ? [] : [index];
    }).concat(outputFrameIndicesForDeletedRanges(
      request.deleted_ranges ?? [],
      startSeconds,
      endSeconds,
      request.playback_speed,
      outputFps,
    )))].sort((left, right) => left - right);
    return {
      crop: appliedCrop,
      sourceAspect,
      outputAspect: sourceAspect == null ? undefined : sourceAspect * visibleWidth / visibleHeight,
      outputFormat: requestedFormat,
      startSeconds,
      endSeconds,
      playbackSpeed: request.playback_speed,
      outputFps,
      deletedFrameIndices,
      frameTimingMode: request.frame_timing_mode,
    };
  }

  async function generateAllFormats(
    asset: MediaAsset,
    requestedFormats?: OutputFormat[],
    preservedPrimary?: { result: GifResult; snapshot: ExportComparisonSnapshot },
  ) {
    const availableFormats = availableDeliveryFormats({
      sourceHasAlpha: asset.hasAlpha,
      livePhotoReady: !tauri || livePhotoBackendReady,
    });
    const formats = requestedFormats?.length ? requestedFormats : availableFormats;
    const skippedFormats = requestedFormats ? [] : ALL_DELIVERY_FORMATS.filter((format) => !formats.includes(format));
    const total = formats.length;
    const failures: string[] = [];
    const failedFormats: OutputFormat[] = [];
    let completed = 0;
    let primaryResult: GifResult | undefined = preservedPrimary?.result;
    let primarySnapshot: ExportComparisonSnapshot | undefined = preservedPrimary?.snapshot;
    const economicsResults: Partial<Record<(typeof ECONOMICS_FORMATS)[number], GifResult>> = {};
    const economicsFailures: Partial<Record<(typeof ECONOMICS_FORMATS)[number], string>> = {};
    const taskRun = beginTask(`生成 ${asset.name} 的全部格式`, total);

    setSelectedCandidate("");
    setBusy(true);
    setProgress(0);
    updateAsset(asset.id, { status: "生成中", error: undefined });

    try {
      await runBoundedQueue(formats, effectiveTaskConcurrency, async (requestedFormat) => {
        const formatName = DELIVERY_FORMAT_OPTIONS.find((option) => option.value === requestedFormat)?.label
          ?? formatLabel(requestedFormat);

        if (requestedFormat === "live_photo" && tauri && !livePhotoBackendReady) {
          failures.push(`${formatName}（后端未就绪）`);
          completed += 1;
          setProgress(Math.round((completed / total) * 100));
          return;
        }

        setStatus(`多格式并行生成：${completed}/${total} 已完成 · 正在处理 ${formatName}`);
        try {
          const request = buildCurrentRequest(asset, presetId, true, undefined, requestedFormat);
          const comparisonSnapshot = createComparisonSnapshot(asset, requestedFormat, request);
          if (!tauri || asset.path.startsWith("demo://")) {
            await delay(reduceMotion ? 30 : 180);
          } else {
            const result = await runConversion(request);
            if (!taskRun.isCurrent()) return;
            const encodedFormat = resultFormat(result, comparisonSnapshot.outputFormat);
            const completedSnapshot = createComparisonSnapshot(asset, encodedFormat, request, result);
            rememberResult(result);
            if (ECONOMICS_FORMATS.includes(encodedFormat as (typeof ECONOMICS_FORMATS)[number])) {
              economicsResults[encodedFormat as (typeof ECONOMICS_FORMATS)[number]] = result;
            }
            if (!primaryResult || encodedFormat === "gif") {
              primaryResult = result;
              primarySnapshot = completedSnapshot;
            }
          }
        } catch (error) {
          if (!taskRun.isCurrent()) return;
          failures.push(`${formatName}（${String(error)}）`);
          failedFormats.push(requestedFormat);
          if (ECONOMICS_FORMATS.includes(requestedFormat as (typeof ECONOMICS_FORMATS)[number])) {
            economicsFailures[requestedFormat as (typeof ECONOMICS_FORMATS)[number]] = String(error);
          }
        }
        if (!taskRun.isCurrent()) return;
        completed += 1;
        updateTask(taskRun, { completed, label: `全部格式 ${completed}/${total}` });
        setProgress(Math.round((completed / total) * 100));
      }, taskRun.isCurrent);

      if (!taskRun.isCurrent()) return;

      const successful = total - failures.length;
      const skippedLabel = skippedFormats.length === 0
        ? ""
        : ` · 已跳过 ${skippedFormats.map((format) => {
          if (format === "avif" && asset.hasAlpha) return "AVIF（透明素材不支持）";
          if (format === "live_photo") return "Live Photo（后端未就绪）";
          return formatLabel(format);
        }).join("、")}`;
      const finalStatus = successful === total
        ? `全部格式已生成：${successful}/${total}`
        : successful > 0
          ? `多格式导出完成：${successful}/${total}；未完成：${failures.join("、")}`
          : `全部格式导出失败：${failures.join("、")}`;

      if (primaryResult && primarySnapshot) {
        updateAsset(asset.id, {
          status: "完成",
          result: primaryResult,
          comparisonSnapshot: primarySnapshot,
          error: failures.length ? `未完成：${failures.join("、")}` : undefined,
        });
        setPreviewMode(primarySnapshot.outputFormat === "live_photo" ? "result" : "compare");
      } else {
        updateAsset(asset.id, {
          status: successful > 0 ? "完成" : "失败",
          error: failures.length ? failures.join("、") : undefined,
        });
      }
      setProgress(100);
      setFormatEconomics(buildFormatEconomicsRows(economicsResults, economicsFailures));
      setStatus(`${finalStatus}${skippedLabel}`);
      if (failedFormats.length > 0) {
        const preserved = primaryResult && primarySnapshot
          ? { result: primaryResult, snapshot: primarySnapshot }
          : undefined;
        reportRecoverableFailure(
          `全部格式生成（${failedFormats.length} 个失败）`,
          new Error(failures.join("；")),
          () => void generateAllFormats(asset, failedFormats, preserved),
          `重试 ${failedFormats.length} 个失败格式`,
          asset.id,
        );
        completeTask(taskRun, "failed");
      } else {
        completeTask(taskRun);
      }
    } finally {
      if (taskRun.isCurrent()) setBusy(false);
      else {
        settleCancelledTask(taskRun);
        if (!taskGateRef.current.active) setBusy(false);
      }
    }
  }

  async function generateCurrent() {
    const memeImage = Boolean(active && active.kind === "image" && memeOverlay?.sourceAssetId === active.id);
    if (!active || (!isConvertibleAsset(active) && !memeImage)) {
      setStatus("请先选择视频、GIF、WebP、APNG、PNG，或从表情包工作台应用图片素材");
      return;
    }
    if (deliveryFormatPreference === "all") {
      await generateAllFormats(active);
      return;
    }
    if (!outputBackendReady) {
      setStatus("Live Photo 当前不可用，请选择其他格式");
      return;
    }
    const taskRun = beginTask(`生成 ${active.name}`);
    const request = buildCurrentRequest(active);
    setTargetOutcome(null);
    setSelectedCandidate("");
    setBusy(true);
    setProgress(0);
    updateAsset(active.id, { status: "生成中", error: undefined });
    startExportHeartbeat(active, outputFormat, request.generation_mode === "target_size");
    try {
      if (request.generation_mode === "target_size") {
        setStatus(`正在生成不超过 ${targetSizeMb.toFixed(1)} MB 的文件`);
      }
      const comparisonSnapshot = createComparisonSnapshot(active, outputFormat, request);
      if (!tauri || active.path.startsWith("demo://")) {
        await delay(reduceMotion ? 40 : 720);
        if (!taskRun.isCurrent()) return;
        updateAsset(active.id, { status: "完成" });
        setProgress(100);
        setStatus(`${formatLabel(outputFormat)} 生成完成`);
        completeTask(taskRun);
        return;
      }
      const result = await runConversion(request);
      if (!taskRun.isCurrent()) return;
      stopExportHeartbeat();
      if (request.generation_mode === "target_size" && request.target_size_bytes != null) {
        setTargetOutcome(tightCapOutcome(request.target_size_bytes, result.size_bytes));
      }
      const encodedFormat = resultFormat(result, comparisonSnapshot.outputFormat);
      updateAsset(active.id, {
        status: "完成",
        result,
        comparisonSnapshot: createComparisonSnapshot(active, encodedFormat, request, result),
      });
      rememberResult(result);
      setPreviewMode(encodedFormat === "live_photo" ? "result" : "compare");
      setProgress(100);
      if (encodedFormat === "live_photo") {
        setStatus(`Live Photo 已生成 · ${sizeText(result.size_bytes)}`);
      } else {
        setStatus(`已生成 ${basename(result.output_path)} · ${sizeText(result.size_bytes)}`);
      }
      completeTask(taskRun);
      setBusy(false);

      // Release the export UI immediately; optional scoring has its own lifecycle.
      if (qualityScoringEnabled && encodedFormat !== "live_photo") {
        void scorePublishedResult(request, result, active.id, taskRun);
      }
    } catch (error) {
      if (!taskRun.isCurrent()) return;
      if (request.generation_mode === "target_size" && request.target_size_bytes != null) {
        setTargetOutcome(tightCapOutcome(request.target_size_bytes));
      }
      updateAsset(active.id, { status: "失败", error: String(error) });
      setStatus(`生成失败：${desktopFailureMessage(error)}`);
      reportRecoverableFailure("生成当前动画", error, () => void generateCurrent(), "按原参数重试", active.id);
      completeTask(taskRun, "failed");
    } finally {
      if (taskRun.isCurrent()) {
        stopExportHeartbeat();
        setBusy(false);
      } else {
        settleCancelledTask(taskRun);
        if (!taskGateRef.current.active) setBusy(false);
      }
    }
  }

  useEffect(() => {
    if (!pendingOutputTuning) return;
    setPendingOutputTuning(null);
    void generateCurrent();
  }, [pendingOutputTuning]);

  async function generateCandidates(
    requestedPresetIds?: CompressionPresetId[],
    preservedCandidates: Candidate[] = [],
  ) {
    if (!active || !isConvertibleAsset(active)) {
      setStatus("请先选择视频、GIF、WebP、APNG 或 PNG");
      return;
    }
    if (!outputBackendReady) {
      setStatus("Live Photo 当前不可用，请选择其他格式");
      return;
    }
    const runId = candidateRunRef.current + 1;
    candidateRunRef.current = runId;
    const sourceAssetId = active.id;
    setBusy(true);
    setProgress(4);
    setCandidates(preservedCandidates);
    setSelectedCandidate("");
    setStatus("正在生成 3 个真实候选…");
    const next: Candidate[] = [...preservedCandidates];
    const sourceFps = active.frameCount && active.duration
      ? active.frameCount / active.duration
      : undefined;
    const targetProfiles = outputFormat === "gif" && generationMode === "target_size"
      ? buildTargetPortfolioProfiles({
        width,
        fps,
        colors,
        targetSizeBytes: Math.round(targetSizeMb * 1024 * 1024),
        sourceFps,
      })
      : [];
    const allCandidateSpecs = targetProfiles.length
      ? targetProfiles.map((profile) => ({
        presetId: profile.presetId,
        preset: COMPRESSION_PRESETS.find((item) => item.id === profile.presetId)!,
        profile,
      }))
      : CANDIDATE_PRESET_IDS.map((candidatePresetId) => ({
        presetId: candidatePresetId,
        preset: COMPRESSION_PRESETS.find((item) => item.id === candidatePresetId)!,
        profile: undefined,
      }));
    const candidateSpecs = requestedPresetIds?.length
      ? allCandidateSpecs.filter((spec) => requestedPresetIds.includes(spec.presetId))
      : allCandidateSpecs;
    const taskRun = beginTask(`生成 ${active.name} 的候选`, candidateSpecs.length);
    try {
      for (let index = 0; index < candidateSpecs.length; index += 1) {
        if (!taskRun.isCurrent()) return;
        const { presetId: candidatePresetId, preset: candidatePreset, profile } = candidateSpecs[index];
        const candidateLabel = profile?.label ?? candidatePreset.label;
        const profileSummary = profile
          ? `${profile.width}px · ${profile.fps} FPS · ${profile.colors} 色 · ${Math.round(profile.budgetRatio * 100)}% 预算`
          : undefined;
        const request = buildCurrentRequest(
          active,
          candidatePresetId,
          generationMode === "target_size",
          profile,
        );
        const comparisonSnapshot = createComparisonSnapshot(active, outputFormat, request);
        if (!tauri || active.path.startsWith("demo://")) {
          await delay(reduceMotion ? 30 : 180);
          if (!taskRun.isCurrent() || candidateRunRef.current !== runId || activeIdRef.current !== sourceAssetId) return;
          const previewFormat = resultFormat(undefined, "gif", candidatePreset.preview);
          next.push({
            id: `${candidatePresetId}-${index}`,
            sourceAssetId: active.id,
            presetId: candidatePresetId,
            label: `${candidateLabel} · ${formatLabel(previewFormat)}`,
            size: profile
              ? `上限 ${(targetSizeMb * profile.budgetRatio).toFixed(1)} MB`
              : `约 ${(1.8 * candidatePreset.estimateFactor).toFixed(1)} MB`,
            duration: editedDisplayDuration || active.duration || 0,
            previewUrl: candidatePreset.preview,
            comparisonSnapshot: { ...comparisonSnapshot, outputFormat: previewFormat },
            role: profile?.role,
            profileSummary,
          });
        } else {
          try {
            const result = await runConversion(request);
            if (!taskRun.isCurrent() || candidateRunRef.current !== runId || activeIdRef.current !== sourceAssetId) return;
            rememberResult(result);
            const encodedFormat = resultFormat(result, comparisonSnapshot.outputFormat);
            next.push({
              id: `${candidatePresetId}-${result.output_path}`,
              sourceAssetId: active.id,
              presetId: candidatePresetId,
              label: `${candidateLabel} · ${formatLabel(encodedFormat)}`,
              size: sizeText(result.size_bytes),
              duration: editedDisplayDuration,
              previewUrl: previewResourceUrl(resultPreviewPath(result)),
              result,
              comparisonSnapshot: createComparisonSnapshot(active, encodedFormat, request, result),
              role: profile?.role,
              profileSummary,
            });
          } catch (error) {
            if (!taskRun.isCurrent()) return;
            next.push({
              id: `${candidatePresetId}-error`,
              sourceAssetId: active.id,
              presetId: candidatePresetId,
              label: `${candidateLabel} · ${formatLabel(outputFormat)}`,
              size: "生成失败",
              duration: editedDisplayDuration,
              error: String(error),
              role: profile?.role,
              profileSummary,
            });
          }
        }
        if (!taskRun.isCurrent() || candidateRunRef.current !== runId || activeIdRef.current !== sourceAssetId) return;
        setCandidates([...next]);
        setProgress(Math.round(((index + 1) / candidateSpecs.length) * 100));
        updateTask(taskRun, { completed: index + 1, label: `候选 ${index + 1}/${candidateSpecs.length}` });
      }
      const finalized = targetProfiles.length ? markPortfolioFrontier(next) : next;
      if (!taskRun.isCurrent() || candidateRunRef.current !== runId || activeIdRef.current !== sourceAssetId) return;
      setCandidates(finalized);
      const firstSuccessful = finalized.find((item) => !item.error && item.previewUrl);
      setSelectedCandidate(firstSuccessful?.id || "");
      if (firstSuccessful?.previewUrl) setPreviewMode("compare");
      const failedPresetIds = finalized
        .filter((item) => item.error && candidateSpecs.some((spec) => spec.presetId === item.presetId))
        .map((item) => item.presetId);
      if (!firstSuccessful) {
        setStatus("候选生成失败，请检查 FFmpeg 和输出目录");
      } else if (targetProfiles.length) {
        if (finalized.some((item) => item.result)) {
          setStatus("3 个大小方案已生成，可直接比较");
        } else {
          setStatus("3 个大小方案预览已生成");
        }
      } else {
        setStatus("3 个候选已生成，可对比清晰度、流畅度与体积");
      }
      if (failedPresetIds.length > 0) {
        const successfulCandidates = finalized.filter((item) => !failedPresetIds.includes(item.presetId));
        reportRecoverableFailure(
          `候选生成（${failedPresetIds.length} 个失败）`,
          new Error(`${failedPresetIds.length}/${candidateSpecs.length} candidate conversions failed`),
          () => void generateCandidates(failedPresetIds, successfulCandidates),
          `重试 ${failedPresetIds.length} 个失败候选`,
          active.id,
        );
        completeTask(taskRun, "failed");
      } else {
        completeTask(taskRun);
      }
    } finally {
      if (taskRun.isCurrent() && candidateRunRef.current === runId) setBusy(false);
      else {
        settleCancelledTask(taskRun);
        if (!taskGateRef.current.active) setBusy(false);
      }
    }
  }

  async function generateBatch(requestedAssets = mediaAssets) {
    if (!requestedAssets.length) {
      setStatus("转换队列里还没有可用素材");
      return;
    }
    if (!outputBackendReady) {
      setStatus("Live Photo 当前不可用，请选择其他格式");
      return;
    }
    setBusy(true);
    setProgress(0);
    let completed = 0;
    const failedAssets: MediaAsset[] = [];
    const loadConcurrency = requestedAssets.reduce((limit, asset) => {
      const profile = sourceProfile(asset);
      const policy = taskControlPolicy(assessMaterialLoad({
        durationSeconds: asset.duration,
        width: profile.width,
        height: profile.height,
        fps: profile.fps,
        frameCount: asset.frameCount,
      }));
      return Math.min(limit, policy.maxConcurrency);
    }, effectiveQueueConcurrency);
    const parallelJobs = Math.min(loadConcurrency, requestedAssets.length);
    const taskRun = beginTask(`批量生成 ${requestedAssets.length} 个素材`, requestedAssets.length);
    try {
      await runBoundedQueue(requestedAssets, parallelJobs, async (asset) => {
        if (!taskRun.isCurrent()) return;
        const request = buildCurrentRequest(asset);
        const comparisonSnapshot = createComparisonSnapshot(asset, outputFormat, request);
        updateAsset(asset.id, { status: "生成中", error: undefined });
        setStatus(`批量并行生成：${completed}/${requestedAssets.length} 已完成 · ${parallelJobs} 路队列`);
        try {
          if (!tauri || asset.path.startsWith("demo://")) {
            await delay(reduceMotion ? 30 : 160);
            updateAsset(asset.id, { status: "完成" });
          } else {
            const result = await runConversion(request);
            if (!taskRun.isCurrent()) return;
            const encodedFormat = resultFormat(result, comparisonSnapshot.outputFormat);
            updateAsset(asset.id, {
              status: "完成",
              result,
              comparisonSnapshot: createComparisonSnapshot(asset, encodedFormat, request, result),
            });
            rememberResult(result);
            if (asset.id === active?.id) setPreviewMode(encodedFormat === "live_photo" ? "result" : "compare");
          }
        } catch (error) {
          if (!taskRun.isCurrent()) return;
          failedAssets.push(asset);
          updateAsset(asset.id, { status: "失败", error: String(error) });
        } finally {
          if (!taskRun.isCurrent()) return;
          completed += 1;
          updateTask(taskRun, { completed, label: `批量任务 ${completed}/${mediaAssets.length}` });
          setProgress(Math.round((completed / requestedAssets.length) * 100));
        }
      }, taskRun.isCurrent);
      if (!taskRun.isCurrent()) return;
      const successful = completed - failedAssets.length;
      if (failedAssets.length > 0) {
        const error = new Error(`${failedAssets.length}/${completed} batch conversions failed`);
        setStatus(`批量任务完成：${successful} 个成功，${failedAssets.length} 个失败 · ${parallelJobs} 路并行`);
        reportRecoverableFailure(
          `批量生成（${failedAssets.length} 个失败）`,
          error,
          () => void generateBatch(failedAssets),
          `重试 ${failedAssets.length} 个失败素材`,
        );
        completeTask(taskRun, "failed");
      } else {
        setStatus(`批量任务完成：${completed} 个素材 · ${parallelJobs} 路并行`);
        completeTask(taskRun);
      }
    } finally {
      if (taskRun.isCurrent()) setBusy(false);
      else {
        settleCancelledTask(taskRun);
        if (!taskGateRef.current.active) setBusy(false);
      }
    }
  }

  async function runMerge() {
    if (mergeAssets.length < 2) {
      setStatus("合并至少需要 2 个 GIF 或图片素材");
      return;
    }
    setBusy(true);
    setProgress(10);
    setStatus(`正在合并 ${mergeAssets.length} 个素材…`);
    try {
      if (!tauri || mergeAssets.some((item) => item.path.startsWith("demo://"))) {
        await delay(reduceMotion ? 40 : 360);
        setProgress(100);
        setStatus("GIF 合并完成");
        return;
      }
      const result = await mergeGif({
        input_paths: mergeAssets.map((item) => item.path),
        output_dir: outputDir || dirname(mergeAssets[0].path),
        width,
        fps,
        colors: clamp(colors, 3, 256),
        image_seconds: mergeImageSeconds,
        loop_output: loopOutput,
      });
      rememberResult(result);
      setProgress(100);
      setStatus(`合并完成：${basename(result.output_path)}（${sizeText(result.size_bytes)}）`);
    } catch (error) {
      setStatus(`合并失败：${desktopFailureMessage(error)}`);
      reportRecoverableFailure("合并动画", error, () => void runMerge(), "重新合并");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecording() {
    if (!tauri) {
      if (!recording) {
        setRecordOperation("starting");
        setRecording(true);
        setRecordOperation("idle");
        setStatus("录制已开始");
      } else {
        setRecordOperation("stopping");
        setRecording(false);
        setRecordOperation("idle");
        setStatus("录制已停止");
        setMode("editor");
      }
      return;
    }
    if (recording) {
      setRecordOperation("stopping");
      try {
        const path = await stopScreenRecording();
        setRecording(false);
        addPaths([path]);
        setMode("editor");
        setStatus(`录制完成并已自动填入：${basename(path)}`);
      } catch (error) {
        const retryable = isRetryableRecordingFailure(error);
        setRecording(retryable);
        setStatus(retryable
          ? `录制内容已安全保留：${desktopFailureMessage(error)}；处理后再次点击停止即可重试保存`
          : `停止录制失败：${desktopFailureMessage(error)}`);
        if (retryable) {
          reportRecoverableFailure("保存屏幕录制", error, () => void toggleRecording(), "再次保存录制");
        }
      } finally {
        setRecordOperation("idle");
      }
      return;
    }

    const request = {
      output_dir: outputDir,
      fps: clamp(recordFps, 5, 30),
      region_enabled: recordRegion.enabled,
      x: Math.max(0, recordRegion.x),
      y: Math.max(0, recordRegion.y),
      width: Math.max(120, recordRegion.width),
      height: Math.max(120, recordRegion.height),
      capture_backend: recordBackend,
    };
    const fallbackBackend: RecordBackend = recordBackend === "psgrab" ? "ddagrab" : "psgrab";
    setRecordOperation("starting");
    try {
      try {
        await startScreenRecording(request);
      } catch {
        await startScreenRecording({ ...request, capture_backend: fallbackBackend });
        setRecordBackend(fallbackBackend);
        setStatus(`已切换为${fallbackBackend === "psgrab" ? "截图序列模式" : "显卡模式"}`);
      }
      setRecording(true);
      setStatus(recordRegion.enabled ? "正在录制指定区域" : "正在录制整个桌面");
    } catch (error) {
      setRecording(false);
      setStatus(`录屏失败：${desktopFailureMessage(error)}`);
      reportRecoverableFailure("开始屏幕录制", error, () => void toggleRecording(), "重新开始录制");
    } finally {
      setRecordOperation("idle");
    }
  }

  async function chooseRecordRegion() {
    if (recordRegionPicking) return;
    if (!tauri) {
      setRecordRegion({ enabled: true, x: 80, y: 80, width: 960, height: 540, screen_x: 0, screen_y: 0, screen_width: 1920, screen_height: 1080 });
      setStatus("已选择区域 960 × 540");
      return;
    }
    setRecordRegionPicking(true);
    setStatus("正在准备屏幕画面，请稍候…");
    try {
      // Let React paint the waiting state before desktop capture starts.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const region = await selectScreenRegion();
      if (region) {
        setRecordRegion((current) => ({
          enabled: true,
          ...region,
          screen_x: region.screen_x ?? current.screen_x,
          screen_y: region.screen_y ?? current.screen_y,
          screen_width: region.screen_width ?? current.screen_width,
          screen_height: region.screen_height ?? current.screen_height,
        }));
        setStatus(`已确认录制区域 ${region.width} × ${region.height} · X ${region.x} · Y ${region.y}`);
      } else {
        setStatus("已取消录制区域选择");
      }
    } catch (error) {
      setStatus(`无法打开区域选择：${desktopFailureMessage(error)}`);
    } finally {
      setRecordRegionPicking(false);
    }
  }

  function moveMergeItem(index: number, delta: number) {
    setMergeItems((items) => {
      const target = index + delta;
      if (target < 0 || target >= items.length) return items;
      const next = [...items];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeAsset(assetId: string) {
    if (memeBatchOwner.current === assetId) requestCancelTask();
    setMemeCollections(current => {
      const next = { ...current };
      delete next[assetId];
      return next;
    });
    const asset = assets.find((item) => item.id === assetId);
    inspectTokens.current[assetId] = (inspectTokens.current[assetId] || 0) + 1;
    captureTokens.current[assetId] = (captureTokens.current[assetId] || 0) + 1;
    assetPathsRef.current.delete(assetId);
    mediaInfoRef.current.delete(assetId);
    setAssets((items) => items.filter((item) => item.id !== assetId));
    if (asset) setMergeItems((items) => items.filter((path) => path !== asset.path));
    if (assetId === activeId) {
      const next = assets.find((item) => item.id !== assetId && isConvertibleAsset(item));
      setActiveId(next?.id || "");
    }
  }

  function waitForSeek(video: HTMLVideoElement, time: number) {
    return new Promise<void>((resolve) => {
      const target = Math.max(0, Math.min(time, video.duration || time));
      if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
        resolve();
        return;
      }
      let timeout = 0;
      const done = () => {
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", done);
        resolve();
      };
      timeout = window.setTimeout(done, 900);
      video.addEventListener("seeked", done, { once: true });
      video.currentTime = target;
    });
  }

  async function captureTimeline(video: HTMLVideoElement, assetId: string, assetPath: string, videoDuration: number) {
    if (!videoDuration || !Number.isFinite(videoDuration)) return;
    const token = (captureTokens.current[assetId] || 0) + 1;
    captureTokens.current[assetId] = token;
    const load = assessMaterialLoad({
      durationSeconds: videoDuration,
      width: video.videoWidth,
      height: video.videoHeight,
      frameCount: assets.find((item) => item.id === assetId)?.frameCount,
    });
    const count = Math.min(12, taskControlPolicy(load).thumbnailBudget);
    const samples = thumbnailSampleTimes(videoDuration, count);
    const cacheKey = `${assetPath.toLowerCase()}|${videoDuration.toFixed(3)}|${count}`;
    const cached = timelineCacheRef.current.get(cacheKey);
    if (cached) {
      if (captureTokens.current[assetId] !== token) return;
      updateAsset(assetId, { thumbs: cached, thumbnailUrl: cached[0]?.url, timelineError: undefined }, assetPath);
      return;
    }

    if (tauri && !assetPath.startsWith("demo://")) {
      try {
        const frames = await generateMediaThumbnails({ input_path: assetPath, times: samples });
        if (captureTokens.current[assetId] !== token) return;
        const thumbs = frames.map((frame) => ({ time: frame.time, url: convertFileSrc(frame.path) }));
        timelineCacheRef.current.set(cacheKey, thumbs);
        updateAsset(assetId, { thumbs, thumbnailUrl: thumbs[0]?.url, timelineError: undefined }, assetPath);
        return;
      } catch (error) {
        if (captureTokens.current[assetId] !== token) return;
        setStatus(`视频可播放，但关键帧生成失败：${String(error)}`);
      }
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    const thumbs: Thumb[] = [];
    const originalTime = video.currentTime || 0;
    const wasPaused = video.paused;
    try {
      video.pause();
      for (const time of samples) {
        await waitForSeek(video, time);
        if (captureTokens.current[assetId] !== token) return;
        const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
        canvas.width = 180;
        canvas.height = Math.max(90, Math.round(180 / ratio));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        thumbs.push({ time, url: canvas.toDataURL("image/jpeg", 0.78) });
      }
      if (captureTokens.current[assetId] !== token) return;
      updateAsset(assetId, { thumbs, thumbnailUrl: thumbs[0]?.url, timelineError: undefined }, assetPath);
      timelineCacheRef.current.set(cacheKey, thumbs);
      await waitForSeek(video, Math.min(originalTime, videoDuration));
      if (!wasPaused) void video.play();
    } catch (error) {
      if (captureTokens.current[assetId] !== token) return;
      updateAsset(assetId, { thumbs: [], timelineError: `时间线取样失败：${String(error)}` }, assetPath);
      setStatus("视频可播放，但时间线生成失败；可在素材卡中重试");
    }
  }

  function updateVideoMetadata(assetId: string, assetPath: string) {
    const video = videoRef.current;
    if (!video || assetPathsRef.current.get(assetId)?.toLowerCase() !== assetPath.toLowerCase()) return;
    const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
    const dimensions = video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : "视频";
    updateAsset(assetId, {
      duration: nextDuration,
      dimensions,
      aspect: video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9,
    }, assetPath);
    if (active?.id !== assetId || active.path.toLowerCase() !== assetPath.toLowerCase()) return;
    setDuration(nextDuration);
    setEnd(nextDuration);
    void captureTimeline(video, assetId, assetPath, nextDuration);
  }

  function updateImageMetadata(event: React.SyntheticEvent<HTMLImageElement>, assetId: string, assetPath: string) {
    if (assetPathsRef.current.get(assetId)?.toLowerCase() !== assetPath.toLowerCase()) return;
    const image = event.currentTarget;
    if (image.naturalWidth && image.naturalHeight) updateAsset(assetId, {
      dimensions: `${image.naturalWidth} × ${image.naturalHeight}`,
      aspect: image.naturalWidth / image.naturalHeight,
    }, assetPath);
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) {
      setStatus(active?.animated ? `${active ? mediaLabel(active) : "动画"} 会在预览区循环播放` : "当前为静态图片预览");
      return;
    }
    if (video.paused) {
      setFocusedFramePreview(null);
      const current = video.currentTime < start || video.currentTime >= trimEnd ? start : video.currentTime;
      const next = nextPlayableSourceTime(current, deletedRanges, start, trimEnd);
      if (next == null) {
        setStatus("当前时间范围已全部删除，没有可播放片段");
        return;
      }
      if (Math.abs(video.currentTime - next) > 0.001) video.currentTime = next;
      video.playbackRate = playbackSpeed;
      void video.play();
      startEditedPlaybackLoop(video);
    } else {
      video.pause();
      stopEditedPlaybackLoop();
    }
  }

  function stopEditedPlaybackLoop() {
    if (previewTimer.current) window.clearInterval(previewTimer.current);
    previewTimer.current = null;
    previewHoldRef.current = null;
  }

  function startEditedPlaybackLoop(video: HTMLVideoElement) {
    stopEditedPlaybackLoop();
    previewTimer.current = window.setInterval(() => {
      if (!syncEditedPlayback(video)) stopEditedPlaybackLoop();
    }, 40);
  }

  function syncEditedPlayback(video: HTMLVideoElement) {
    if (video.currentTime >= trimEnd - 0.001) {
      video.pause();
      return false;
    }
    if (frameTimingMode === "preserve" && deletedRanges.length) {
      const activeHold = previewHoldRef.current;
      if (activeHold) {
        const holdDurationMs = ((activeHold.end - activeHold.start) / playbackSpeed) * 1_000;
        if (performance.now() - activeHold.startedAt < holdDurationMs) {
          const holdTime = Math.max(start, activeHold.start - playbackSpeed / Math.max(1, fps));
          if (Math.abs(video.currentTime - holdTime) > 0.002) video.currentTime = holdTime;
          return true;
        }
        previewHoldRef.current = null;
        video.currentTime = activeHold.end;
        return activeHold.end < trimEnd - 0.001;
      }
      const deletedRange = deletedRanges.find((range) =>
        video.currentTime >= range.start_seconds - 0.001
        && video.currentTime < range.end_seconds - 0.001
      );
      if (deletedRange) {
        previewHoldRef.current = {
          start: deletedRange.start_seconds,
          end: deletedRange.end_seconds,
          startedAt: performance.now(),
        };
        const holdTime = Math.max(start, deletedRange.start_seconds - playbackSpeed / Math.max(1, fps));
        video.currentTime = holdTime;
        return true;
      }
      return true;
    }
    const next = nextPlayableSourceTime(video.currentTime, deletedRanges, start, trimEnd);
    if (next == null) {
      video.pause();
      return false;
    }
    if (next > video.currentTime + 0.001) video.currentTime = next;
    return true;
  }

  function handleVideoTimeUpdate() {
    const video = videoRef.current;
    if (!video || video.paused) return;
    syncEditedPlayback(video);
  }

  function previewRange() {
    const video = videoRef.current;
    if (!video || !activeDuration) {
      setStatus(active?.animated ? `${active ? mediaLabel(active) : "动画"} 当前为循环预览` : "当前素材不支持片段预览");
      return;
    }
    stopEditedPlaybackLoop();
    const firstPlayableTime = nextPlayableSourceTime(start, deletedRanges, start, trimEnd);
    if (firstPlayableTime == null) {
      setStatus("当前时间范围已全部删除，没有可预览片段");
      return;
    }
    setFocusedFramePreview(null);
    video.currentTime = firstPlayableTime;
    video.playbackRate = playbackSpeed;
    void video.play();
    startEditedPlaybackLoop(video);
  }

  function selectFrame(time: number, previewUrl?: string) {
    const frameIndex = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
    const exactTime = frameIndex == null
      ? null
      : sourceTimeForOutputFrameIndex(frameIndex, start, trimEnd, playbackSpeed, fps);
    if (frameIndex == null || exactTime == null) {
      if (videoRef.current && Number.isFinite(time)) videoRef.current.currentTime = time;
      setStatus(`${Number.isFinite(time) ? time.toFixed(2) : "当前"}s 位于输出时间范围外，不能选择`);
      return;
    }
    setSelectedFrameTimes((items) => {
      const existingIndex = items.findIndex((item) =>
        outputFrameIndexForSourceTime(item, start, trimEnd, playbackSpeed, fps) === frameIndex
      );
      if (existingIndex >= 0) {
        const next = items.filter((_, index) => index !== existingIndex);
        setStatus(`已取消第 ${frameIndex + 1} 帧；当前选择 ${next.length} 帧`);
        return next;
      }
      const next = [...items, exactTime];
      setStatus(`已选择第 ${frameIndex + 1} 帧；当前共 ${next.length} 帧`);
      return next;
    });
    if (previewUrl) setFocusedFramePreview({ time: exactTime, url: previewUrl });
    else setFocusedFramePreview(null);
    if (videoRef.current) videoRef.current.currentTime = exactTime;
  }

  function selectFrameRange(firstIndex: number, lastIndex: number, replaceSelection = false) {
    const from = Math.max(0, Math.min(firstIndex, lastIndex));
    const to = Math.min(totalOutputFrameCount - 1, Math.max(firstIndex, lastIndex));
    if (to < from) return;
    const rangeTimes = Array.from({ length: to - from + 1 }, (_, offset) =>
      sourceTimeForOutputFrameIndex(from + offset, start, trimEnd, playbackSpeed, fps)
    ).filter((time): time is number => time !== null);
    setSelectedFrameTimes((items) => normalizeDeletedFrameTimes(
      replaceSelection ? rangeTimes : [...items, ...rangeTimes],
      start,
      trimEnd,
      playbackSpeed,
      fps,
    ));
    setStatus(`${replaceSelection ? "已框选" : "已连续选择"}第 ${from + 1}–${to + 1} 帧，共 ${rangeTimes.length} 帧`);
  }

  function selectAllExactFrames() {
    setSelectedFrameTimes(exactFrameTimes);
    setStatus(`已选择全部 ${exactFrameTimes.length} 帧`);
  }

  function changeFrameTimingMode(nextMode: FrameTimingMode) {
    if (nextMode === frameTimingMode) return;
    if (nextMode === "preserve" && totalOutputFrameCount > 1) {
      setDeletedFrames((items) => items.filter((time) => {
        const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
        return index !== 0 && index !== totalOutputFrameCount - 1;
      }));
    }
    setFrameTimingMode(nextMode);
    setLastDeletedBatch([]);
    setStatus(nextMode === "preserve"
      ? "已切换为保持总时长；首尾帧会保留，删除区间由相邻画面停留补齐"
      : "已切换为收紧时间线；删除后后续帧会自动前移");
  }

  function deleteSelectedFrames() {
    let selected = normalizeDeletedFrameTimes(
      validSelectedFrameTimes,
      start,
      trimEnd,
      playbackSpeed,
      fps,
    );
    if (frameTimingMode === "preserve" && totalOutputFrameCount > 1) {
      selected = selected.filter((time) => {
        const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
        return index !== 0 && index !== totalOutputFrameCount - 1;
      });
    }
    if (!selected.length) {
      setStatus(frameTimingMode === "preserve"
        ? "保持总时长时首尾帧必须保留，请选择其他帧"
        : "请先选择一个或多个输出帧");
      return;
    }
    setDeletedFrames((items) => {
      const validItems = normalizeDeletedFrameTimes(items, start, trimEnd, playbackSpeed, fps);
      const existingIndices = new Set(outputFrameIndicesForSourceTimes(
        validItems,
        start,
        trimEnd,
        playbackSpeed,
        fps,
      ));
      const additions = selected.filter((time) => {
        const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
        return index != null && !existingIndices.has(index);
      });
      if (!additions.length) {
        setStatus("所选输出帧已全部删除");
        return validItems;
      }
      const next = normalizeDeletedFrameTimes(
        [...validItems, ...additions],
        start,
        trimEnd,
        playbackSpeed,
        fps,
      );
      const nextDeletedCount = outputFrameIndicesForSourceTimes(
        next,
        start,
        trimEnd,
        playbackSpeed,
        fps,
      ).length;
      if (nextDeletedCount >= totalOutputFrameCount) {
        setStatus("至少需要保留一个可播放输出帧，已取消本次删除");
        return validItems;
      }
      const nextDuration = frameTimingMode === "preserve"
        ? totalOutputFrameCount / Math.max(1, fps)
        : (totalOutputFrameCount - nextDeletedCount) / Math.max(1, fps);
      setStatus(frameTimingMode === "preserve"
        ? `已删除 ${nextDeletedCount} 帧；总时长保持 ${nextDuration.toFixed(2)}s`
        : `已删除 ${nextDeletedCount} 帧；导出时长变为 ${nextDuration.toFixed(2)}s，后续帧自动前移`);
      setLastDeletedBatch(additions);
      return next;
    });
    setSelectedFrameTimes([]);
  }

  function applyManualFrameSampling(keepEvery: number, preserveDuration: boolean) {
    const scopedIndices = selectedFrameIndices;
    const sampledIndices = manualSampleDeletedFrameIndices(
      totalOutputFrameCount,
      keepEvery,
      scopedIndices.length ? scopedIndices : undefined,
    );
    const sampledTimes = sampledIndices.flatMap((index) => {
      const time = sourceTimeForOutputFrameIndex(index, start, trimEnd, playbackSpeed, fps);
      return time == null ? [] : [time];
    });
    if (!sampledTimes.length) {
      setStatus("当前范围不足以继续抽帧；至少需要两个可编辑帧");
      return;
    }
    const nextMode: FrameTimingMode = preserveDuration ? "preserve" : "compact";
    setFrameTimingMode(nextMode);
    setDeletedFrames((items) => {
      const eligibleItems = nextMode === "preserve" && totalOutputFrameCount > 1
        ? items.filter((time) => {
          const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
          return index !== 0 && index !== totalOutputFrameCount - 1;
        })
        : items;
      const next = normalizeDeletedFrameTimes(
        [...eligibleItems, ...sampledTimes],
        start,
        trimEnd,
        playbackSpeed,
        fps,
      );
      const existingIndices = new Set(outputFrameIndicesForSourceTimes(
        eligibleItems,
        start,
        trimEnd,
        playbackSpeed,
        fps,
      ));
      const nextIndices = outputFrameIndicesForSourceTimes(
        next,
        start,
        trimEnd,
        playbackSpeed,
        fps,
      );
      const additions = sampledTimes.filter((time) => {
        const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
        return index != null && !existingIndices.has(index);
      });
      setLastDeletedBatch(additions);
      setStatus(`手动抽帧完成：每 ${Math.max(2, Math.round(keepEvery))} 帧保留 1 帧，当前移除 ${nextIndices.length} 帧；${preserveDuration ? "保持总时长" : "收紧时间线"}`);
      return next;
    });
    setSelectedFrameTimes([]);
  }

  function undoLastFrameDeletion() {
    if (!lastDeletedBatch.length) return;
    const lastIndices = new Set(outputFrameIndicesForSourceTimes(
      lastDeletedBatch,
      start,
      trimEnd,
      playbackSpeed,
      fps,
    ));
    setDeletedFrames((items) => items.filter((time) => {
      const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
      return index == null || !lastIndices.has(index);
    }));
    setStatus(`已撤销上一次操作，共恢复 ${lastIndices.size} 帧`);
    setLastDeletedBatch([]);
  }

  function restoreSelectedFrames() {
    const selectedIndices = new Set(selectedFrameIndices);
    if (!selectedIndices.size) return;
    const restored = deletedFrameIndices.filter((index) => selectedIndices.has(index));
    if (!restored.length) {
      setStatus("当前选择中没有已删除帧");
      return;
    }
    const restoredSet = new Set(restored);
    setDeletedFrames((items) => items.filter((time) => {
      const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
      return index == null || !restoredSet.has(index);
    }));
    setSelectedFrameTimes([]);
    setLastDeletedBatch([]);
    setStatus(`已恢复 ${restored.length} 帧，导出会重新包含这些画面`);
  }

  function applyFrameAnnotation(settings: MemeOverlaySettings) {
    if (!active) return;
    const linked = { ...settings, sourceAssetId: active.id, source: "frame_annotation" as const };
    setMemeDraft(linked);
    setMemeOverlay(linked);
    setPerceptualFocus("text_ui");
    setFrameAnnotationOpen(false);
    setStatus(`标注已应用到 ${settings.startSeconds == null ? "整个时间线" : `${settings.startSeconds.toFixed(2)}–${settings.endSeconds?.toFixed(2)}s`}，导出时会真正烧录`);
  }

  function applyTrackedEffect(effect: TrackedEffect) {
    if (!active || effect.sourceAssetId !== active.id) {
      setStatus("素材已经切换，请重新确认跟踪范围");
      return;
    }
    setTrackedEffects((items) => [...items.filter((item) => item.id !== effect.id), effect]);
    setTrackedEffectOpen(false);
    setPerceptualFocus(effect.kind === "label" || effect.kind === "highlight" ? "text_ui" : "subject");
    setStatus(`${effect.kind === "label" ? "跟踪标注" : effect.kind === "highlight" ? "跟踪高亮" : "隐私遮挡"}已应用 · ${trackedEffectConfidenceLabel(effect)} · 导出时按轨迹逐帧生效`);
  }

  function removeTrackedEffect(effectId: string) {
    setTrackedEffects((items) => items.filter((item) => item.id !== effectId));
    setStatus("已移除对象轨迹及其导出效果");
  }

  function removeFrameAnnotation() {
    setMemeOverlay(null);
    setMemeDraft(null);
    setFrameAnnotationOpen(false);
    setStatus("已移除当前素材的文字标注");
  }

  function resetEdit() {
    setStart(0);
    setEnd(activeDuration);
    setCrop(EMPTY_CROP);
    setCropEnabled(false);
    setBackgroundRemoval(null);
    setSelectedFrameTimes([]);
    setDeletedFrames([]);
    setLastDeletedBatch([]);
    setFrameTimingMode("compact");
    setFrameEditorPage(0);
    setFrameEditorThumbs([]);
    setFrameEditorError("");
    setFocusedFramePreview(null);
    setMemeOverlay((current) => current?.sourceAssetId === active?.id ? null : current);
    setMemeDraft((current) => current?.sourceAssetId === active?.id ? null : current);
    setTrackedEffects((items) => items.filter((effect) => effect.sourceAssetId !== active?.id));
    setPreviewZoom(1);
    setStatus("已重置当前编辑参数");
  }

  const settingsPanel = (
    <SettingsPanel
      postprocessControl={postprocessControl}
      detailed
      showCutout={mode === "editor"}
      presetId={presetId}
      presetAdjusted={presetAdjusted}
      playbackSpeed={playbackSpeed}
      outputFormat={outputFormat}
      encoder={encoder}
      sourceHasAlpha={active?.hasAlpha}
      deliveryFormatPreference={deliveryFormatPreference}
      deliveryIntent={deliveryIntent}
      targetPlatform={targetPlatform}
      livePhotoBackend={livePhotoBackend}
      outputBackendReady={outputBackendReady}
      generationMode={generationMode}
      targetSizeMb={targetSizeMb}
      volumeDirectorEnabled={volumeDirectorEnabled}
      volumeDirectorActive={volumeDirectorActive}
      volumeDirectorPriority={volumeDirectorPriority}
      volumeDirectorPlan={volumeDirectorPlan}
      targetOutcome={targetOutcome}
      bayerScale={bayerScale}
      alphaThreshold={alphaThreshold}
      backgroundRemoval={backgroundRemoval}
      perceptualFocus={perceptualFocus}
      backendCapabilities={backendCapabilities}
      width={width}
      fps={fps}
      colors={colors}
      dither={dither}
      lossy={lossy}
      optimizeLevel={optimizeLevel}
      filter={filter}
      memeOverlayActive={memeOverlay?.sourceAssetId === active?.id}
      loopOutput={loopOutput}
      outputDir={outputDir}
      progress={busy ? progress : progress === 100 ? 100 : 0}
      busy={busy}
      status={status}
      sourceLabel={active?.name || "等待投放素材"}
      presentedExport={presentedExport}
      mediaAssets={mediaAssets}
      history={history}
      queueProgress={queueProgress}
      resourceSnapshot={resourceSnapshot}
      resourceSamplingError={resourceSamplingError}
      logicalCpuCount={logicalCpuCount}
      queueConcurrencySetting={queueConcurrencySetting}
      effectiveQueueConcurrency={effectiveQueueConcurrency}
      activeQueueJobs={activeQueueJobs}
      materialLoad={activeMaterialLoad}
      taskStatus={presentedTaskStatus}
      taskConcurrency={effectiveTaskConcurrency}
      estimateFactor={selectedPreset.estimateFactor}
      onPreset={choosePreset}
      onSpeed={setPlaybackSpeed}
      onDeliveryIntent={chooseDeliveryIntent}
      onDeliveryFormatPreference={chooseDeliveryFormat}
      onTargetPlatform={chooseTargetPlatform}
      onEncoder={(value) => { setEncoder(value); markCustom(); }}
      onGenerationMode={setGenerationMode}
      onTargetSizeMb={setTargetSizeMb}
      onVolumeDirectorEnabled={(enabled) => {
        setVolumeDirectorEnabled(enabled);
        if (enabled && outputFormat === "gif") setGenerationMode("target_size");
      }}
      onVolumeDirectorPriority={setVolumeDirectorPriority}
      onBayerScale={(value) => { setBayerScale(value); markCustom(); }}
      onAlphaThreshold={(value) => { setAlphaThreshold(value); markCustom(); }}
      onBackgroundRemoval={setBackgroundRemoval}
      onPerceptualFocus={setPerceptualFocus}
      onWidth={(value) => { setWidth(value); markCustom(); }}
      onFps={(value) => { setFps(value); markCustom(); }}
      onColors={(value) => { setColors(value); markCustom(); }}
      onDither={(value) => { setDither(value); markCustom(); }}
      onLossy={(value) => { setLossy(value); markCustom(); }}
      onOptimize={(value) => { setOptimizeLevel(value); markCustom(); }}
      onFilter={(value) => { setFilter(value); markCustom(); }}
      onLoop={setLoopOutput}
      onChooseOutput={() => void chooseOutput()}
      onOpenOutput={() => void openOutput(presentedExport?.result?.output_path)}
      onSaveCustom={saveCustomPreset}
      onGenerateCurrent={() => void generateCurrent()}
      onTuneOutput={tuneAndRegenerate}
      onOpenHistory={(path) => void openOutput(path)}
      onQueueConcurrencySetting={setQueueConcurrencySetting}
      onCancelTask={requestCancelTask}
      advancedOpen={settingsDrawerOpen}
    />
  );

  const appClass = `gifp-v3 theme-${theme}${reduceMotion ? " reduce-motion" : ""}${settingsDrawerOpen && mode === "editor" ? " drawer-pushed" : ""}`;
  return (
    <div className={appClass}>
      <header className="app-header paper-panel">
        <button className="brand" type="button" disabled={recording} onClick={() => setMode("editor")} aria-label="返回精细编辑">
          <img src={LOGO_SRC} alt="" />
          <span><strong>GIFP</strong><b>{PRODUCT_VERSION}</b><em>acekanon</em></span>
        </button>
        <nav className="mode-tabs" aria-label="主要功能">
          <div className="mode-tabs__group mode-tabs__primary" aria-label="核心流程">
            <span className="mode-tabs__group-label" aria-hidden="true">核心流程</span>
            {onOpenStudio && <button type="button" disabled={recording} onClick={onOpenStudio}><FilmStrip /><span>剪辑工作台</span></button>}
            <button className={mode === "quick" ? "active" : ""} aria-current={mode === "quick" ? "page" : undefined} type="button" disabled={recording} onClick={() => { setBackgroundRemoval(null); setMode("quick"); }}><MagicWand /><span>快速生成</span></button>
            <button className={mode === "editor" ? "active" : ""} aria-current={mode === "editor" ? "page" : undefined} type="button" disabled={recording} onClick={() => setMode("editor")}><Scissors /><span>精细编辑</span></button>
          </div>
          <div className="mode-tabs__group mode-tabs__tools" aria-label="创作工具">
            <span className="mode-tabs__group-label" aria-hidden="true">创作工具</span>
            <button className={mode === "merge" ? "active" : ""} aria-label="合并制作" aria-current={mode === "merge" ? "page" : undefined} type="button" disabled={recording} onClick={() => setMode("merge")}><Stack /><span>合并</span></button>
            <button className={mode === "record" ? "active" : ""} aria-label="屏幕录制" aria-current={mode === "record" ? "page" : undefined} type="button" onClick={() => setMode("record")}><Monitor /><span>录屏</span></button>
            <button className={mode === "meme" ? "active" : ""} aria-label="GIF表情包制作" aria-current={mode === "meme" ? "page" : undefined} type="button" disabled={recording} onClick={() => setMode("meme")}><Smiley /><span>表情包</span></button>
          </div>
        </nav>
        <div className="header-actions">
          <label className="motion-toggle">
            <span className="visually-hidden">减少动态效果</span>
            <input type="checkbox" aria-label="减少动态效果" title="减少动态效果" checked={reduceMotion} onChange={(event) => setReduceMotion(event.target.checked)} />
          </label>
          <div className="theme-picker">
            <button type="button" className="icon-button" aria-label={`选择皮肤，当前 ${THEME_OPTIONS.find((item) => item.id === theme)?.label ?? "泡泡手账"}`} aria-expanded={themeOpen} onClick={() => setThemeOpen((value) => !value)}><GearSix /></button>
            {themeOpen && (
              <div className="theme-menu" role="menu" aria-label="皮肤">
                {THEME_OPTIONS.map((item) => (
                  <button type="button" role="menuitemradio" aria-checked={theme === item.id} key={item.id} onClick={() => { setTheme(item.id); setThemeOpen(false); }}>
                    <span className={`theme-swatch swatch-${item.id}`} />
                    <span><strong>{item.label}</strong><small>{item.note}</small></span>
                    {theme === item.id && <Check />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <ActivityStatus
        busy={busy}
        recording={recording}
        status={status}
        qualityScoring={Boolean(qualityScoringTaskId)}
        qualityCancelPending={qualityCancelPending}
        onCancelQualityScoring={requestCancelQualityScoring}
      />

      {recoverableSession && (
        <section className="session-recovery paper-panel" aria-label="恢复上一次任务" aria-live="polite">
          <span className="session-recovery__icon" aria-hidden="true"><FloppyDisk weight="fill" /></span>
          <div>
            <strong>发现上一次未完成的任务</strong>
            <p>
              {recoverableSession.data.assets.length} 个素材 · 保存于 {new Date(recoverableSession.savedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
          <div className="session-recovery__actions">
            <button type="button" className="session-recovery__discard" onClick={discardLastSessionDraft}>放弃恢复</button>
            <button type="button" className="session-recovery__restore" onClick={restoreLastSessionDraft}>恢复上次任务</button>
          </div>
        </section>
      )}

      {failureIncident && (
        <section
          className={`failure-recovery paper-panel${recoverableSession ? " with-session-recovery" : ""}`}
          aria-label="任务失败恢复"
          aria-live="assertive"
        >
          <span className="failure-recovery__icon" aria-hidden="true"><WarningCircle weight="fill" /></span>
          <div className="failure-recovery__body">
            <strong>{failureIncident.operation} · {failureIncident.failure.label}</strong>
            <p>{failureIncident.failure.message} {failureIncident.failure.suggestions[0]}</p>
            {failureCopyStatus && <small role="status">{failureCopyStatus}</small>}
            {failureTechnicalOpen && (
              <div className="failure-technical-preview" role="region" aria-label="本地技术详情预览">
                <strong>仅在本机查看 · 可能包含路径或文件名</strong>
                <pre>{failureIncident.failure.technicalDetails}</pre>
                <span>默认“复制诊断”不会包含这里的原始内容；分享前请自行确认。</span>
              </div>
            )}
          </div>
          <div className="failure-recovery__actions">
            <button type="button" onClick={() => void copyFailureDiagnostic()}><Copy />复制诊断</button>
            <button type="button" aria-expanded={failureTechnicalOpen} onClick={() => setFailureTechnicalOpen((value) => !value)}>{failureTechnicalOpen ? "隐藏本地详情" : "查看本地详情"}</button>
            {failureIncident.retry && (
              <button
                type="button"
                className="primary"
                disabled={busy || Boolean(failureIncident.contextAssetId && !assets.some((item) => item.id === failureIncident.contextAssetId))}
                onClick={retryFailureIncident}
              >
                <ArrowsClockwise />{failureIncident.retryLabel}
              </button>
            )}
            <button
              type="button"
              className="dismiss"
              aria-label="关闭失败恢复"
              onClick={() => { setFailureIncident(null); setFailureCopyStatus(""); setFailureTechnicalOpen(false); }}
            ><X /></button>
          </div>
        </section>
      )}

      {mode === "merge" ? (
        <MergeWorkspace
          assets={mergeAssets}
          imageSeconds={mergeImageSeconds}
          outputDir={outputDir}
          width={width}
          fps={fps}
          colors={colors}
          busy={busy}
          status={status}
          onAdd={() => void chooseMedia()}
          onMove={moveMergeItem}
          onRemove={(path) => setMergeItems((items) => items.filter((item) => item !== path))}
          onImageSeconds={setMergeImageSeconds}
          onOutput={() => void chooseOutput()}
          onWidth={(value) => { setWidth(value); markCustom(); }}
          onFps={(value) => { setFps(value); markCustom(); }}
          onColors={(value) => { setColors(value); markCustom(); }}
          onRun={() => void runMerge()}
        />
      ) : mode === "record" ? (
        <RecordWorkspace
          recording={recording}
          operation={recordOperation}
          regionPicking={recordRegionPicking}
          region={recordRegion}
          fps={recordFps}
          backend={recordBackend}
          outputDir={outputDir}
          status={status}
          onRegion={setRecordRegion}
          onFps={setRecordFps}
          onBackend={setRecordBackend}
          onPickRegion={() => void chooseRecordRegion()}
          onOutput={() => void chooseOutput()}
          onToggle={() => void toggleRecording()}
        />
      ) : mode === "meme" ? (
        <main className="meme-page-layout">
          <AssetPanel assets={assets} activeId={active?.id || ""} allowStatic onActivate={setActiveId} onAdd={() => void chooseMedia()} onRemove={removeAsset} onRelink={(id) => void relinkAsset(id)} onRetryInspect={retryAssetInspection} onRetryTimeline={retryAssetTimeline} />
          <MemeSetWorkspace
            key={active?.id ?? "empty"}
            asset={active}
            crop={cropEnabled ? crop : undefined}
            collection={busy && active && memeCollections[active.id] ? memeCollections[active.id] : activeMemeCollection}
            onChange={collection => {
              if (!active) return;
              setMemeCollections(current => ({ ...current, [active.id]: busy && current[active.id] ? { ...current[active.id], selectedId: collection.selectedId } : collection }));
            }}
            busy={busy}
            canExport={tauri && !!active && !active.path.startsWith("demo://")}
            onGenerate={retry => void generateMemeSet(retry)}
            onCancel={requestCancelTask}
            onOpen={path => void openOutput(path)}
            outputControls={<details className="meme-set-output"><summary>整组输出 · {width}px · {fps}fps{generationMode === "target_size" ? ` · ≤ ${targetSizeMb} MB` : ""}</summary>
              <div className="meme-set-output-fields">
                <label>宽度<CommittedNumberInput ariaLabel="整组输出宽度" value={width} min={64} max={1920} onCommit={setWidth} /></label>
                <label>帧率<CommittedNumberInput ariaLabel="整组输出帧率" value={fps} min={1} max={60} onCommit={setFps} /></label>
                <label>体积<select aria-label="整组体积策略" value={generationMode} onChange={event => setGenerationMode(event.target.value as GifGenerationMode)}><option value="best_gif">画质优先</option><option value="fast_gif">快速生成</option><option value="target_size">不超过指定 MB</option></select></label>
                {generationMode === "target_size" && <label>每张上限 MB<CommittedNumberInput ariaLabel="整组每张体积上限 MB" value={targetSizeMb} min={0.1} max={100} step={0.1} onCommit={setTargetSizeMb} /></label>}
              </div>
              <button type="button" title={outputDir || "素材所在目录"} onClick={() => void chooseOutput()}>输出目录 · {outputDir ? basename(outputDir) : "素材所在目录"}</button>
              <small>裁剪、时段与其他效果沿用当前素材设置；更改输出设置后需重新生成。</small>
              {compressionTools}
            </details>}
            reducedMotion={reduceMotion}
            onApply={applyMemeOverlay}
            onQuickExport={(settings) => applyMemeOverlay(settings, "quick")}
          />
        </main>
      ) : (
        <main className={`editor-layout ${mode === "quick" ? "quick-layout" : "detailed-layout"}`}>
          <AssetPanel assets={assets} activeId={active?.id || ""} onActivate={setActiveId} onAdd={() => void chooseMedia()} onRemove={removeAsset} onRelink={(id) => void relinkAsset(id)} onRetryInspect={retryAssetInspection} onRetryTimeline={retryAssetTimeline} />

          <section className="editor-center editor-center--single">
            {mode === "quick" ? (
              <QuickWorkspace
                active={active}
                outputFormat={outputFormat}
                presentedExport={presentedExport}
                previewMode={previewMode}
                reducedMotion={reduceMotion}
                onPreviewMode={setPreviewMode}
              />
            ) : (
              <DetailedWorkspace
                active={active}
                aspect={active?.aspect || 16 / 9}
                videoRef={videoRef}
                playing={playing}
                previewZoom={previewZoom}
                cropEnabled={cropEnabled}
                crop={crop}
                duration={activeDuration}
                start={start}
                end={trimEnd}
                selectedFrameTimes={validSelectedFrameTimes}
                selectedFrameIndices={selectedFrameIndices}
                deletedFrames={validDeletedFrames}
                deletedFrameIndices={deletedFrameIndices}
                frameTimes={exactFrameTimes}
                outputFps={fps}
                totalFrameCount={totalOutputFrameCount}
                frameTimingMode={frameTimingMode}
                focusedFramePreview={focusedFramePreview}
                timelineHoverPreview={timelineHoverPreview}
                exportDuration={editedDisplayDuration}
                retainedTimelineRatio={retainedTimelineRatio}
                onVideoMetadata={updateVideoMetadata}
                onImageMetadata={updateImageMetadata}
                onPlaying={(value) => {
                  setPlaying(value);
                  if (!value) stopEditedPlaybackLoop();
                }}
                onVideoTimeUpdate={handleVideoTimeUpdate}
                onPlay={togglePlay}
                onPreviewRange={previewRange}
                onZoom={(delta) => setPreviewZoom((value) => clamp(value + delta, 0.5, 4))}
                onCropEnabled={setCropEnabled}
                onCrop={setCrop}
                onCropApplied={(nextCrop, targetWidth) => {
                  setCrop(nextCrop);
                  setCropEnabled(true);
                  setWidth(clamp(targetWidth, 96, 1920));
                  setPresetId("custom");
                  setPresetAdjusted(true);
                  setStatus(`裁剪完成，输出尺寸已同步为 ${targetWidth} px 宽`);
                }}
                onStart={(value) => setStart(Math.min(value, Math.max(0, trimEnd - 0.1)))}
                onEnd={(value) => setEnd(Math.max(value, start + 0.1))}
                onSelectFrame={selectFrame}
                onSelectFrameRange={(firstIndex, lastIndex) => selectFrameRange(firstIndex, lastIndex, true)}
                onHoverFrame={hoverTimelineFrame}
                onDeleteFrame={deleteSelectedFrames}
                timelineFeedback={/至少需要保留一个可播放输出帧|位于输出时间范围外/.test(status) ? status : ""}
                onOpenFrames={() => {
                  const focusIndex = outputFrameIndicesForSourceTimes(
                    validSelectedFrameTimes.length ? validSelectedFrameTimes : validDeletedFrames,
                    start,
                    trimEnd,
                    playbackSpeed,
                    fps,
                  )[0] ?? 0;
                  setFrameEditorPage(Math.floor(focusIndex / EXACT_FRAME_PAGE_SIZE));
                  setFrameEditorOpen(true);
                }}
                onOpenAnnotation={() => setFrameAnnotationOpen(true)}
                annotation={memeOverlay?.sourceAssetId === active?.id ? memeOverlay : null}
                trackedEffects={trackedEffects.filter((effect) => effect.sourceAssetId === active?.id)}
                onOpenTracking={() => setTrackedEffectOpen(true)}
                onUndoFrame={undoLastFrameDeletion}
                canUndoFrame={lastDeletedBatch.length > 0}
                onClearFrames={() => { setDeletedFrames([]); setLastDeletedBatch([]); setStatus("已恢复全部删除帧"); }}
                onReset={resetEdit}
                outputFormat={outputFormat}
                presentedExport={presentedExport}
                previewMode={previewMode}
                reducedMotion={reduceMotion}
                onPreviewMode={setPreviewMode}
              />
            )}
          </section>

          {mode === "editor" && <SettingsPanel
      postprocessControl={postprocessControl}
            detailed={false}
            showCutout
            presetId={presetId}
            presetAdjusted={presetAdjusted}
            playbackSpeed={playbackSpeed}
            outputFormat={outputFormat}
            encoder={encoder}
            sourceHasAlpha={active?.hasAlpha}
            deliveryFormatPreference={deliveryFormatPreference}
            deliveryIntent={deliveryIntent}
            targetPlatform={targetPlatform}
            livePhotoBackend={livePhotoBackend}
            outputBackendReady={outputBackendReady}
            generationMode={generationMode}
            targetSizeMb={targetSizeMb}
            volumeDirectorEnabled={volumeDirectorEnabled}
            volumeDirectorActive={volumeDirectorActive}
            volumeDirectorPriority={volumeDirectorPriority}
            volumeDirectorPlan={volumeDirectorPlan}
            targetOutcome={targetOutcome}
            bayerScale={bayerScale}
            alphaThreshold={alphaThreshold}
            backgroundRemoval={backgroundRemoval}
            perceptualFocus={perceptualFocus}
            backendCapabilities={backendCapabilities}
            width={width}
            fps={fps}
            colors={colors}
            dither={dither}
            lossy={lossy}
            optimizeLevel={optimizeLevel}
            filter={filter}
            memeOverlayActive={memeOverlay?.sourceAssetId === active?.id}
            loopOutput={loopOutput}
            outputDir={outputDir}
            progress={busy ? progress : progress === 100 ? 100 : 0}
            busy={busy}
            status={status}
            sourceLabel={active?.name || "等待投放素材"}
            presentedExport={presentedExport}
            mediaAssets={mediaAssets}
            history={history}
            queueProgress={queueProgress}
            resourceSnapshot={resourceSnapshot}
            resourceSamplingError={resourceSamplingError}
            logicalCpuCount={logicalCpuCount}
            queueConcurrencySetting={queueConcurrencySetting}
            effectiveQueueConcurrency={effectiveQueueConcurrency}
            activeQueueJobs={activeQueueJobs}
            materialLoad={activeMaterialLoad}
            taskStatus={presentedTaskStatus}
            taskConcurrency={effectiveTaskConcurrency}
            estimateFactor={selectedPreset.estimateFactor}
            onPreset={choosePreset}
            onSpeed={setPlaybackSpeed}
            onDeliveryIntent={chooseDeliveryIntent}
            onDeliveryFormatPreference={chooseDeliveryFormat}
            onTargetPlatform={chooseTargetPlatform}
            onEncoder={(value) => { setEncoder(value); markCustom(); }}
            onGenerationMode={setGenerationMode}
            onTargetSizeMb={setTargetSizeMb}
            onVolumeDirectorEnabled={(enabled) => {
              setVolumeDirectorEnabled(enabled);
              if (enabled && outputFormat === "gif") setGenerationMode("target_size");
            }}
            onVolumeDirectorPriority={setVolumeDirectorPriority}
            onBayerScale={(value) => { setBayerScale(value); markCustom(); }}
            onAlphaThreshold={(value) => { setAlphaThreshold(value); markCustom(); }}
            onBackgroundRemoval={setBackgroundRemoval}
            onPerceptualFocus={setPerceptualFocus}
            onWidth={(value) => { setWidth(value); markCustom(); }}
            onFps={(value) => { setFps(value); markCustom(); }}
            onColors={(value) => { setColors(value); markCustom(); }}
            onDither={(value) => { setDither(value); markCustom(); }}
            onLossy={(value) => { setLossy(value); markCustom(); }}
            onOptimize={(value) => { setOptimizeLevel(value); markCustom(); }}
            onFilter={(value) => { setFilter(value); markCustom(); }}
            onLoop={setLoopOutput}
            onChooseOutput={() => void chooseOutput()}
            onOpenOutput={() => void openOutput(presentedExport?.result?.output_path)}
            onSaveCustom={saveCustomPreset}
            onGenerateCurrent={() => void generateCurrent()}
            onTuneOutput={tuneAndRegenerate}
            onOpenHistory={(path) => void openOutput(path)}
            onQueueConcurrencySetting={setQueueConcurrencySetting}
            onCancelTask={requestCancelTask}
            advancedOpen={settingsDrawerOpen}
            onOpenAdvanced={() => setSettingsDrawerOpen(true)}
          />}
          {mode === "quick" ? (
            <aside className="quick-sidebar" aria-label="快速生成侧栏">
              <OutputDirectoryButton outputDir={outputDir} disabled={busy} onChoose={() => void chooseOutput()} />
              <button type="button" className="quick-wizard-launcher paper-panel" onClick={() => active ? setQuickWizardOpen(true) : void chooseMedia()}>
                <MagicWand weight="fill" /><span><strong>{active ? "快速生成向导" : "先添加素材"}</strong><small>{active ? `× ${(quickScalePercent / 100).toFixed(2)} · ${fps} FPS · ${deliveryFormatPreference === "all" ? "全部格式" : formatLabel(outputFormat)}` : "文件载入后自动打开向导"}</small></span><b>{active ? "调整 →" : "选择文件"}</b>
              </button>
            </aside>
          ) : null}
          {mode === "editor" && <FormatEconomicsReport rows={formatEconomics} />}
        </main>
      )}

      <QuickGenerationWizard
        open={(mode === "quick" || mode === "meme") && Boolean(active) && quickWizardOpen}
        reducedMotion={reduceMotion}
        activeName={active?.name || "等待素材"}
        formatPreference={deliveryFormatPreference}
        outputFormat={outputFormat}
        playbackSpeed={playbackSpeed}
        sourceWidth={quickSource.width}
        sourceHeight={quickSource.height}
        outputAspect={quickOutputSource.width && quickOutputSource.height ? quickOutputSource.width / quickOutputSource.height : undefined}
        sourceFps={quickSource.fps}
        duration={editedDisplayDuration || active?.duration || 0}
        scalePercent={mode === "quick" ? quickScalePercent : quickScalePercentForWidth(quickSource.width ?? width, width)}
        width={width}
        fps={fps}
        colors={colors}
        dither={dither}
        lossy={lossy}
        optimizeLevel={optimizeLevel}
        encoder={active?.hasAlpha ? "ffmpeg_fast" : encoder}
        generationMode={generationMode}
        sourceHasAlpha={active?.hasAlpha}
        targetSizeMb={targetSizeMb}
        outputDir={outputDir}
        busy={busy}
        progress={busy ? progress : progress === 100 ? 100 : 0}
        status={status}
        backendReady={outputBackendReady}
        livePhotoReady={livePhotoBackendReady}
        desktopRuntime={tauri}
        hasResult={Boolean(presentedExport) && active?.status === "完成"}
        resultSizeBytes={presentedExport?.result?.size_bytes}
        cleanupNote={losslessStageNotes(presentedExport?.result)}
        compressionNote={presentedExport?.result?.index_compression_report
          ? presentedExport.result.index_compression_report.verified
            ? `索引压缩${presentedExport.result.index_compression_report.gentle ? "（温和）" : ""}已采用 · 减少 ${((1 - presentedExport.result.index_compression_report.after_bytes / Math.max(1, presentedExport.result.index_compression_report.before_bytes)) * 100).toFixed(1)}%（有损）`
            : "索引压缩未采用"
          : undefined}
        memeOverlayActive={memeOverlay?.sourceAssetId === active?.id}
        qualityReport={presentedExport?.result?.quality_report}
        qualityScoringEnabled={qualityScoringEnabled}
        qualityScoring={Boolean(qualityScoringTaskId)}
        qualityCancelPending={qualityCancelPending}
        onCancelQualityScoring={requestCancelQualityScoring}
        onClose={() => setQuickWizardOpen(false)}
        onFormat={chooseQuickFormat}
        onScale={(value) => {
          if (active) {
            quickDefaultsAppliedRef.current.add(active.id);
            quickUserAdjustedRef.current.add(active.id);
          }
          const nextWidth = quickWidthForScale(quickSource.width ?? width, value);
          const normalizedScale = quickScalePercentForWidth(quickSource.width ?? width, nextWidth);
          setQuickScalePercent(normalizedScale);
          setWidth(nextWidth);
          setPresetAdjusted(true);
          setStatus(`快速尺寸已调整为 × ${(normalizedScale / 100).toFixed(2)} · ${nextWidth}px`);
        }}
        onWidth={(value) => {
          if (active) {
            quickDefaultsAppliedRef.current.add(active.id);
            quickUserAdjustedRef.current.add(active.id);
          }
          const sourceWidth = quickSource.width ?? width;
          const maximumWidth = Math.max(mode === "meme" ? width : 2, Math.floor(sourceWidth / 2) * 2);
          const nextWidth = clamp(Math.floor(value / 2) * 2, Math.min(16, maximumWidth), maximumWidth);
          const normalizedScale = quickScalePercentForWidth(sourceWidth, nextWidth);
          setQuickScalePercent(normalizedScale);
          setWidth(nextWidth);
          setPresetAdjusted(true);
          setStatus(`快速宽度已固定为 ${nextWidth}px · × ${(normalizedScale / 100).toFixed(2)}`);
        }}
        onFps={(value) => {
          if (active) {
            quickDefaultsAppliedRef.current.add(active.id);
            quickUserAdjustedRef.current.add(active.id);
          }
          setFps(value);
          setPresetAdjusted(true);
          setStatus(`快速帧率已调整为 ${value} FPS`);
        }}
        onEncoder={(value) => { setEncoder(value); markCustom(); }}
        onGenerationMode={setGenerationMode}
        onTargetSizeMb={setTargetSizeMb}
        onColors={(value) => { setColors(value); markCustom(); }}
        onDither={(value) => { setDither(value); markCustom(); }}
        onLossy={(value) => { setLossy(value); markCustom(); }}
        onOptimize={(value) => { setOptimizeLevel(value); markCustom(); }}
        onGenerate={() => void generateCurrent()}
        postprocessControl={postprocessControl}
        onQualityScoringEnabled={setQualityScoringEnabled}
        onOpenOutput={() => void openOutput(presentedExport?.result?.output_path)}
        onOpenDetailed={() => { setQuickWizardOpen(false); setMode("editor"); setSettingsDrawerOpen(true); }}
        onOpenMeme={() => { setQuickWizardOpen(false); setMode("meme"); }}
        onCancelGeneration={requestCancelTask}
      />

      <IslandDrawer
        open={mode === "editor" && settingsDrawerOpen}
        title="手动覆盖"
        eyebrow="MANUAL OVERRIDES"
        reducedMotion={reduceMotion}
        onClose={() => setSettingsDrawerOpen(false)}
      >
        {settingsPanel}
      </IslandDrawer>

      {frameEditorOpen && (
        <FrameDrawer
          frames={frameEditorThumbs}
          totalFrames={totalOutputFrameCount}
          page={frameEditorPage}
          pageSize={EXACT_FRAME_PAGE_SIZE}
          loading={frameEditorLoading}
          error={frameEditorError}
          selected={validSelectedFrameTimes}
          deleted={validDeletedFrames}
          frameTimingMode={frameTimingMode}
          isFrameDeleted={(time) => {
            const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
            return index != null && deletedFrameIndices.includes(index);
          }}
          isFrameSelected={(time) => {
            const index = outputFrameIndexForSourceTime(time, start, trimEnd, playbackSpeed, fps);
            return index != null && selectedFrameIndices.includes(index);
          }}
          onSelect={(frame) => selectFrame(frame.time, frame.url)}
          onSelectRange={selectFrameRange}
          onPage={setFrameEditorPage}
          onTimingMode={changeFrameTimingMode}
          onManualSample={applyManualFrameSampling}
          onDelete={deleteSelectedFrames}
          onRestore={restoreSelectedFrames}
          onSelectAll={selectAllExactFrames}
          onClearSelection={() => setSelectedFrameTimes([])}
          onUndo={undoLastFrameDeletion}
          canUndo={lastDeletedBatch.length > 0}
          onClear={() => {
            setDeletedFrames([]);
            setLastDeletedBatch([]);
            setStatus("已恢复全部删除帧");
          }}
          onClose={() => {
            setFrameEditorOpen(false);
            setSelectedFrameTimes([]);
          }}
        />
      )}

      {frameAnnotationOpen && active && (
        <FrameAnnotationDrawer
          asset={active}
          value={memeOverlay?.sourceAssetId === active.id ? memeOverlay : null}
          timelineStart={start}
          timelineEnd={trimEnd}
          selectedTimes={validSelectedFrameTimes}
          thumbTimes={exactFrameTimes}
          onApply={applyFrameAnnotation}
          onRemove={removeFrameAnnotation}
          onClose={() => setFrameAnnotationOpen(false)}
        />
      )}

      {trackedEffectOpen && active && (
        <TrackedEffectDrawer
          asset={active}
          effects={trackedEffects.filter((effect) => effect.sourceAssetId === active.id)}
          timelineStart={start}
          timelineEnd={trimEnd}
          selectedTimes={validSelectedFrameTimes}
          thumbTimes={exactFrameTimes}
          onApply={applyTrackedEffect}
          onRemove={removeTrackedEffect}
          onClose={() => setTrackedEffectOpen(false)}
        />
      )}

    </div>
  );
}

function SectionRibbon({ icon, title, tone }: { icon: React.ReactNode; title: string; tone: "coral" | "aqua" | "yellow" }) {
  return <div className={`section-ribbon ribbon-${tone}`}><span>{icon}</span><strong>{title}</strong></div>;
}

function OutputDirectoryButton({ outputDir, disabled = false, onChoose }: {
  outputDir: string;
  disabled?: boolean;
  onChoose: () => void;
}) {
  const normalized = outputDir.trim();
  const locationLabel = normalized ? basename(normalized) || normalized : "素材所在文件夹";
  const fullLabel = normalized || "跟随当前素材目录";
  return (
    <button
      type="button"
      className="output-directory-button paper-panel"
      aria-label={`输出目录，当前 ${fullLabel}，点击更改`}
      title={fullLabel}
      disabled={disabled}
      onClick={onChoose}
    >
      <span className="output-directory-button__icon" aria-hidden="true"><FolderOpen weight="fill" /></span>
      <span className="output-directory-button__copy"><strong>输出目录</strong><small>{locationLabel}</small></span>
      <b>更改</b>
    </button>
  );
}

function MediaThumbnail({ asset, className = "" }: { asset: MediaAsset; className?: string }) {
  const src = asset.thumbnailUrl || (asset.kind !== "video" ? asset.sourceUrl : "");
  return (
    <span className={`media-thumbnail ${className}`}>
      {src ? <img src={src} alt="" /> : asset.kind === "video" ? <VideoCamera aria-hidden="true" /> : <Images aria-hidden="true" />}
    </span>
  );
}

function AssetPanel({ assets, activeId, allowStatic = false, onActivate, onAdd, onRemove, onRelink, onRetryInspect, onRetryTimeline }: {
  assets: MediaAsset[];
  activeId: string;
  allowStatic?: boolean;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onRelink: (id: string) => void;
  onRetryInspect: (id: string) => void;
  onRetryTimeline: (id: string) => void;
}) {
  return (
    <aside className="asset-panel paper-panel">
      <SectionRibbon icon={<Images />} title="输入素材" tone="coral" />
      <div className="asset-list">
        {assets.map((asset) => (
          <div className={`asset-card${asset.id === activeId ? " selected" : ""}${asset.error || asset.timelineError ? " has-recovery" : ""}`} key={asset.id}>
            <button type="button" className="asset-main" disabled={!allowStatic && !isConvertibleAsset(asset)} onClick={() => (allowStatic || isConvertibleAsset(asset)) && onActivate(asset.id)}>
              <MediaThumbnail asset={asset} className="asset-thumb" />
              <span className="asset-copy">
                <strong>{asset.name}</strong>
                <span><b className={`kind-badge ${asset.kind}`}>{mediaLabel(asset)}</b><em>{asset.status}</em></span>
                <small>{asset.error ? "素材需要重新读取或定位" : asset.timelineError ? "素材可用，时间线需要重试" : asset.dimensions || (asset.kind === "video" ? "等待生成缩略图" : "等待读取")}{!asset.error && asset.duration ? ` · ${asset.duration.toFixed(1)}s` : ""}{!asset.error && asset.frameCount ? ` · ${asset.frameCount} 帧` : ""}</small>
              </span>
              {asset.id === activeId && <Check className="asset-check" />}
            </button>
            <button type="button" className="asset-remove" aria-label={`移除 ${asset.name}`} onClick={() => onRemove(asset.id)}><X /></button>
            {(asset.error || asset.timelineError) && (
              <div className="asset-recovery" role="group" aria-label={`${asset.name} 素材恢复`}>
                <small title={asset.error || asset.timelineError}>{asset.error || `${asset.timelineError}（不影响播放和导出）`}</small>
                <span>
                  {asset.error && <button type="button" onClick={() => onRetryInspect(asset.id)}><ArrowsClockwise />重新读取</button>}
                  {asset.timelineError && <button type="button" onClick={() => onRetryTimeline(asset.id)}><FilmStrip />重试关键帧</button>}
                  {asset.error && <button type="button" className="primary" onClick={() => onRelink(asset.id)}><FolderOpen />重新定位</button>}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="add-asset" onClick={onAdd}><Plus /><strong>添加素材</strong><small>GIF / WebP / APNG / PNG / 视频 / JPG</small></button>
      <div className="asset-tip"><HandPointing /><span>GIF、WebP、APNG、PNG 与视频会进入转换队列；图片仍可进入合并制作。</span></div>
    </aside>
  );
}

function PreviewModeSwitch({ mode, outputLabel, onChange }: {
  mode: PreviewMode;
  outputLabel: string;
  onChange: (mode: PreviewMode) => void;
}) {
  return (
    <div className="preview-mode-switch" role="group" aria-label="预览方式">
      <button type="button" className={mode === "source" ? "selected" : ""} aria-pressed={mode === "source"} onClick={() => onChange("source")}>原素材</button>
      <button type="button" className={mode === "compare" ? "selected" : ""} aria-pressed={mode === "compare"} onClick={() => onChange("compare")}>对比</button>
      <button type="button" className={mode === "result" ? "selected" : ""} aria-pressed={mode === "result"} onClick={() => onChange("result")}>{outputLabel}</button>
    </div>
  );
}

function QuickWorkspace({ active, outputFormat, presentedExport, previewMode, reducedMotion, onPreviewMode }: {
  active?: MediaAsset;
  outputFormat: OutputFormat;
  presentedExport?: PresentedExport;
  previewMode: PreviewMode;
  reducedMotion: boolean;
  onPreviewMode: (mode: PreviewMode) => void;
}) {
  const resultUrl = presentedExport?.url ?? "";
  const presentedFormat = presentedExport?.format ?? outputFormat;
  const comparisonSnapshot = presentedExport?.snapshot;
  const hasResult = Boolean(presentedExport);
  return (
    <section className="quick-workspace paper-panel">
      <div className="section-heading">
        <SectionRibbon icon={<MagicWand />} title={previewMode === "compare" && hasResult ? "输出对比质检" : "快速预览"} tone="aqua" />
        <div className="preview-heading-actions">
          {hasResult && <PreviewModeSwitch mode={previewMode} outputLabel={formatLabel(presentedFormat)} onChange={onPreviewMode} />}
          <span className="quick-badge">{PRODUCT_VERSION} · {formatLabel(presentedFormat)}</span>
        </div>
      </div>
      <div className="quick-preview-grid">
        <div className="preview-shell quick-source-preview transparency-grid">
          {previewMode === "compare" && resultUrl && active?.sourceUrl ? (
            <OutputComparison
              source={{ src: active.sourceUrl, kind: active.kind, animated: active.animated, alt: `${active.name} 原素材`, crop: comparisonSnapshot?.crop }}
              output={{ src: resultUrl, format: presentedFormat, alt: `${active.name} ${presentedExport?.label ?? `${formatLabel(presentedFormat)} 成品`}`, label: presentedExport?.label }}
              aspectRatio={comparisonSnapshot?.outputAspect ?? active.aspect}
              timeline={comparisonSnapshot ? {
                startSeconds: comparisonSnapshot.startSeconds,
                endSeconds: comparisonSnapshot.endSeconds,
                playbackSpeed: comparisonSnapshot.playbackSpeed,
                outputFps: comparisonSnapshot.outputFps,
                deletedFrameIndices: comparisonSnapshot.deletedFrameIndices,
                frameTimingMode: comparisonSnapshot.frameTimingMode,
              } : undefined}
              reducedMotion={reducedMotion}
            />
          ) : previewMode === "result" && resultUrl ? <OutputPreview src={resultUrl} format={presentedFormat} livePhoto={presentedExport?.result?.live_photo} alt={`${active?.name || "素材"} ${presentedExport?.label ?? "生成结果"}`} interactive reducedMotion={reducedMotion} /> : active ? (
            active.kind === "video" ? (
              active.thumbnailUrl ? <img src={active.thumbnailUrl} alt={`${active.name} 首帧预览`} /> : <div className="preview-pending"><VideoCamera /><strong>{active.name}</strong><span>进入精细编辑可播放并生成关键帧</span></div>
            ) : active.kind === "gif" || active.kind === "webp" || active.kind === "apng" ? (
              <AnimatedMediaPlayer src={active.sourceUrl} format={active.kind} alt={`${active.name} 预览`} className="embedded-animation-player" reducedMotion={reducedMotion} />
            ) : <img src={active.sourceUrl} alt={`${active.name} 预览`} />
          ) : <div className="preview-pending"><UploadSimple /><strong>先添加 GIF、WebP、APNG、PNG 或视频</strong></div>}
        </div>
      </div>
      <div className="quick-explain">
        <strong>快速生成</strong>
        <span>设置尺寸、帧率和输出格式。</span>
      </div>
    </section>
  );
}

function FrameDotTimeline({
  frameTimes,
  outputFps,
  selectedFrameIndices,
  deletedFrameIndices,
  frameTimingMode,
  thumbs,
  hoverPreview,
  onHoverFrame,
  onSelectFrame,
  onSelectRange,
}: {
  frameTimes: number[];
  outputFps: number;
  selectedFrameIndices: number[];
  deletedFrameIndices: number[];
  frameTimingMode: FrameTimingMode;
  thumbs: Thumb[];
  hoverPreview: ExactFrameThumb | null;
  onHoverFrame: (index: number | null) => void;
  onSelectFrame: (time: number, previewUrl?: string) => void;
  onSelectRange: (firstIndex: number, lastIndex: number) => void;
}) {
  const dots = useMemo(
    () => timelineFrameDots(frameTimes.length, deletedFrameIndices, frameTimingMode),
    [deletedFrameIndices, frameTimes.length, frameTimingMode],
  );
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startDot: number;
    currentDot: number;
    dragging: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [hoveredDotIndex, setHoveredDotIndex] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; width: number } | null>(null);

  function dotIndexAt(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !dots.length) return 0;
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 0.999999);
    return Math.min(dots.length - 1, Math.floor(ratio * dots.length));
  }

  function updateMarquee(firstDot: number, lastDot: number) {
    const from = Math.min(firstDot, lastDot);
    const to = Math.max(firstDot, lastDot);
    setMarquee({
      left: (from / Math.max(1, dots.length)) * 100,
      width: ((to - from + 1) / Math.max(1, dots.length)) * 100,
    });
  }

  function beginBoxSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !dots.length) return;
    const dotIndex = dotIndexAt(event.clientX);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startDot: dotIndex,
      currentDot: dotIndex,
      dragging: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveBoxSelection(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dotIndex = dotIndexAt(event.clientX);
    if (!drag.dragging && Math.abs(event.clientX - drag.startX) < 5) return;
    drag.dragging = true;
    drag.currentDot = dotIndex;
    updateMarquee(drag.startDot, dotIndex);
  }

  function finishBoxSelection(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setMarquee(null);
    if (!drag.dragging) return;
    const from = Math.min(drag.startDot, drag.currentDot);
    const to = Math.max(drag.startDot, drag.currentDot);
    suppressClickRef.current = true;
    onSelectRange(dots[from].firstIndex, dots[to].lastIndex);
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  }

  const hoveredDot = hoveredDotIndex == null ? null : dots[hoveredDotIndex];
  const hoveredFrameIndex = hoveredDot?.representativeIndex ?? null;
  const hoveredTime = hoveredFrameIndex == null ? null : frameTimes[hoveredFrameIndex] ?? null;
  const nearestThumb = hoveredTime == null ? undefined : thumbs.reduce<Thumb | undefined>((best, thumb) =>
    !best || Math.abs(thumb.time - hoveredTime) < Math.abs(best.time - hoveredTime) ? thumb : best
  , undefined);
  const previewUrl = hoveredFrameIndex != null && hoverPreview?.index === hoveredFrameIndex
    ? hoverPreview.url
    : nearestThumb?.url;
  const bucketSize = dots.length ? Math.ceil(frameTimes.length / dots.length) : 1;

  return (
    <div
      className={`frame-dot-timeline${marquee ? " is-box-selecting" : ""}`}
      onPointerLeave={() => {
        if (dragRef.current) return;
        setHoveredDotIndex(null);
        onHoverFrame(null);
      }}
    >
      {hoveredDot && hoveredFrameIndex != null && hoveredTime != null && (
        <div
          className="frame-dot-preview"
          role="tooltip"
          style={{ left: `${clamp(((hoveredDotIndex ?? 0) + 0.5) / Math.max(1, dots.length) * 100, 12, 88)}%` }}
        >
          {previewUrl ? <img src={previewUrl} alt="" /> : <span className="frame-dot-preview__empty"><FilmStrip /></span>}
          <div>
            <strong>第 {hoveredFrameIndex + 1} 帧</strong>
            <span>源 {hoveredTime.toFixed(3)}s · 成品 {(hoveredDot.representativeOutputIndex / Math.max(1, outputFps)).toFixed(3)}s</span>
            <small>{hoveredDot.removed ? "此位置由相邻画面停留补齐" : "点击单选，拖拽可框选连续帧"}</small>
          </div>
        </div>
      )}
      <div
        ref={trackRef}
        className="frame-dot-track"
        role="listbox"
        aria-label="真实帧点时间线"
        aria-multiselectable="true"
        onPointerDown={beginBoxSelection}
        onPointerMove={moveBoxSelection}
        onPointerUp={finishBoxSelection}
        onPointerCancel={finishBoxSelection}
      >
        {marquee && <span className="frame-dot-marquee" aria-hidden="true" style={{ left: `${marquee.left}%`, width: `${marquee.width}%` }} />}
        {dots.map((dot, dotIndex) => {
          const selected = selectedFrameIndices.some((index) => index >= dot.firstIndex && index <= dot.lastIndex);
          const time = frameTimes[dot.representativeIndex] ?? 0;
          const frameRange = dot.firstIndex === dot.lastIndex
            ? `第 ${dot.firstIndex + 1} 帧`
            : `第 ${dot.firstIndex + 1}–${dot.lastIndex + 1} 帧`;
          return (
            <button
              type="button"
              key={`${dot.firstIndex}-${dot.lastIndex}`}
              className={`${selected ? "selected" : ""}${dot.removed ? " removed" : ""}${dot.partiallyRemoved ? " partial" : ""}`}
              aria-label={`${time.toFixed(2)} 秒关键帧，${frameRange}${dot.removed ? "，已删除" : ""}`}
              aria-pressed={selected}
              onPointerEnter={() => {
                setHoveredDotIndex(dotIndex);
                onHoverFrame(dot.representativeIndex);
              }}
              onClick={() => {
                if (suppressClickRef.current) return;
                onSelectFrame(time, previewUrl);
              }}
            >
              <i />
            </button>
          );
        })}
      </div>
      <div className="frame-dot-scale"><span>首帧</span><strong>{dots.length < frameTimes.length ? `长素材聚合显示 · 每点约 ${bucketSize} 帧` : "每个点对应 1 个真实输出帧"}</strong><span>末帧</span></div>
    </div>
  );
}

function DetailedWorkspace({
  active,
  aspect,
  videoRef,
  playing,
  previewZoom,
  cropEnabled,
  crop,
  duration,
  start,
  end,
  exportDuration,
  retainedTimelineRatio,
  selectedFrameTimes,
  selectedFrameIndices,
  deletedFrames,
  deletedFrameIndices,
  frameTimes,
  outputFps,
  totalFrameCount,
  frameTimingMode,
  focusedFramePreview,
  timelineHoverPreview,
  onVideoMetadata,
  onImageMetadata,
  onPlaying,
  onVideoTimeUpdate,
  onPlay,
  onPreviewRange,
  onZoom,
  onCropEnabled,
  onCrop,
  onCropApplied,
  onStart,
  onEnd,
  onSelectFrame,
  onSelectFrameRange,
  onHoverFrame,
  onDeleteFrame,
  timelineFeedback,
  onOpenFrames,
  onOpenAnnotation,
  onUndoFrame,
  canUndoFrame,
  onClearFrames,
  onReset,
  annotation,
  trackedEffects,
  onOpenTracking,
  outputFormat,
  presentedExport,
  previewMode,
  reducedMotion,
  onPreviewMode,
}: {
  active?: MediaAsset;
  aspect: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playing: boolean;
  previewZoom: number;
  cropEnabled: boolean;
  crop: CropInsets;
  duration: number;
  start: number;
  end: number;
  exportDuration: number;
  retainedTimelineRatio: number;
  selectedFrameTimes: number[];
  selectedFrameIndices: number[];
  deletedFrames: number[];
  deletedFrameIndices: number[];
  frameTimes: number[];
  outputFps: number;
  totalFrameCount: number;
  frameTimingMode: FrameTimingMode;
  focusedFramePreview: Thumb | null;
  timelineHoverPreview: ExactFrameThumb | null;
  onVideoMetadata: (assetId: string, assetPath: string) => void;
  onImageMetadata: (event: React.SyntheticEvent<HTMLImageElement>, assetId: string, assetPath: string) => void;
  onPlaying: (playing: boolean) => void;
  onVideoTimeUpdate: () => void;
  onPlay: () => void;
  onPreviewRange: () => void;
  onZoom: (delta: number) => void;
  onCropEnabled: (enabled: boolean) => void;
  onCrop: (crop: CropInsets) => void;
  onCropApplied: (crop: CropInsets, targetWidth: number) => void;
  onStart: (value: number) => void;
  onEnd: (value: number) => void;
  onSelectFrame: (time: number, previewUrl?: string) => void;
  onSelectFrameRange: (firstIndex: number, lastIndex: number) => void;
  onHoverFrame: (index: number | null) => void;
  onDeleteFrame: () => void;
  timelineFeedback: string;
  onOpenFrames: () => void;
  onOpenAnnotation: () => void;
  onUndoFrame: () => void;
  canUndoFrame: boolean;
  onClearFrames: () => void;
  onReset: () => void;
  annotation: MemeOverlaySettings | null;
  trackedEffects: TrackedEffect[];
  onOpenTracking: () => void;
  outputFormat: OutputFormat;
  presentedExport?: PresentedExport;
  previewMode: PreviewMode;
  reducedMotion: boolean;
  onPreviewMode: (mode: PreviewMode) => void;
}) {
  const resultUrl = presentedExport?.url ?? "";
  const presentedFormat = presentedExport?.format ?? outputFormat;
  const comparisonSnapshot = presentedExport?.snapshot;
  const hasResult = Boolean(presentedExport);
  const thumbs = active?.thumbs || [];
  const timelinePlaybackAvailable = active?.kind === "video" && previewMode === "source";
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [shellSize, setShellSize] = useState<{ width: number; height: number } | null>(null);
  const [cropAspect, setCropAspect] = useState<CropAspectValue>("free");
  const [cropDraft, setCropDraft] = useState<CropInsets>(EMPTY_CROP);
  const [cropEditing, setCropEditing] = useState(false);
  const [cropFeedback, setCropFeedback] = useState("");
  const hasCrop = crop.left > 0.01 || crop.top > 0.01 || crop.right > 0.01 || crop.bottom > 0.01;
  const draftHasCrop = cropDraft.left > 0.01 || cropDraft.top > 0.01 || cropDraft.right > 0.01 || cropDraft.bottom > 0.01;
  const cropApplied = cropEnabled && hasCrop && !cropEditing && previewMode === "source";
  const source = sourceProfile(active);
  const sourceWidth = source.width ?? Math.max(1, Math.round((source.height ?? 1080) * aspect));
  const sourceHeight = source.height ?? Math.max(1, Math.round(sourceWidth / aspect));
  const cropReadout = cropPixelRect(cropDraft, sourceWidth, sourceHeight);
  const visibleWidth = Math.max(0.01, 1 - (crop.left + crop.right) / 100);
  const visibleHeight = Math.max(0.01, 1 - (crop.top + crop.bottom) / 100);
  const displayAspect = cropApplied ? aspect * visibleWidth / visibleHeight : aspect;
  const cropSourceStyle = cropApplied ? {
    left: `${-crop.left / visibleWidth}%`,
    top: `${-crop.top / visibleHeight}%`,
    width: `${100 / visibleWidth}%`,
    height: `${100 / visibleHeight}%`,
  } : undefined;
  const rulerInset = cropEditing && previewMode === "source" ? CROP_RULER_SIZE : 0;
  const workspaceWidth = contentSize ? contentSize.width + rulerInset : 0;
  const workspaceHeight = contentSize ? contentSize.height + rulerInset : 0;
  const horizontalGutter = shellSize && contentSize ? Math.max(0, (shellSize.width - workspaceWidth) / 2) : 0;
  const verticalGutter = shellSize && contentSize ? Math.max(0, (shellSize.height - workspaceHeight) / 2) : 0;
  const cropRatioPlacement = horizontalGutter >= 72 ? "side" : verticalGutter >= 46 ? "top" : "header";
  const cropRatioDockStyle = cropRatioPlacement === "side"
    ? { left: `${horizontalGutter / 2}px` }
    : cropRatioPlacement === "top"
      ? { top: `${verticalGutter / 2}px` }
      : undefined;
  const trackedPreviewTime = selectedFrameTimes[0] ?? trackedEffects[0]?.startSeconds ?? start;
  const trackedPreviewItems = trackedEffects
    .map((effect) => ({ effect, box: interpolateTrackedBox(effect, trackedPreviewTime) }))
    .filter((item): item is { effect: TrackedEffect; box: TrackedBox } => item.box != null);

  useEffect(() => {
    setCropAspect("free");
    setCropDraft(EMPTY_CROP);
    setCropEditing(false);
    setCropFeedback("");
  }, [active?.id]);

  useEffect(() => {
    if (!cropFeedback) return;
    const timer = window.setTimeout(() => setCropFeedback(""), 2400);
    return () => window.clearTimeout(timer);
  }, [cropFeedback]);

  function chooseCropAspect(next: CropAspectValue) {
    const base = cropEditing ? cropDraft : hasCrop ? crop : EMPTY_CROP;
    setCropAspect(next);
    setCropDraft(cropDraftForAspect(aspect, next, base));
    setCropEditing(true);
  }

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const update = () => {
      const rect = shell.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setShellSize({ width: rect.width, height: rect.height });
      const safeAspect = Number.isFinite(displayAspect) && displayAspect > 0 ? displayAspect : 16 / 9;
      const rulerSpace = cropEditing && previewMode === "source" ? CROP_RULER_SIZE : 0;
      const availableWidth = Math.max(1, rect.width - rulerSpace);
      const availableHeight = Math.max(1, rect.height - rulerSpace);
      const shellAspect = availableWidth / availableHeight;
      if (shellAspect > safeAspect) {
        setContentSize({ width: availableHeight * safeAspect, height: availableHeight });
      } else {
        setContentSize({ width: availableWidth, height: availableWidth / safeAspect });
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [cropEditing, displayAspect, previewMode]);

  function beginCrop() {
    setCropDraft(hasCrop ? crop : EMPTY_CROP);
    setCropEditing(true);
  }

  function applyCrop(next: CropInsets = cropDraft) {
    const selected = next.left > 0.01 || next.top > 0.01 || next.right > 0.01 || next.bottom > 0.01;
    const target = cropPixelRect(next, sourceWidth, sourceHeight);
    if (selected) {
      onCropApplied(next, target.width);
      setCropFeedback(`已裁剪为 ${target.width} × ${target.height} px`);
    } else {
      onCrop(next);
      onCropEnabled(false);
      setCropFeedback("已恢复全画面");
    }
    setCropDraft(next);
    setCropEditing(false);
  }

  function cancelCrop() {
    setCropDraft(hasCrop ? crop : EMPTY_CROP);
    setCropEditing(false);
  }

  function clearCrop() {
    setCropAspect("free");
    setCropDraft(EMPTY_CROP);
    onCrop(EMPTY_CROP);
    onCropEnabled(false);
    setCropEditing(false);
  }

  return (
    <div className={`stage-panel paper-panel${cropEditing ? " crop-session-active" : ""}`}>
      <div className="section-heading">
        <SectionRibbon icon={previewMode === "compare" ? <Sparkle /> : <Crop />} title={previewMode === "compare" ? "输出对比质检" : "画面裁剪与时间编辑"} tone="aqua" />
        <div className="preview-heading-actions">
          <span className="result-format-chip">{formatLabel(presentedFormat)}</span>
          {hasResult && <PreviewModeSwitch mode={previewMode} outputLabel="成品" onChange={onPreviewMode} />}
          {previewMode === "compare" && hasResult
            ? <span className="crop-hint"><MagnifyingGlassPlus />拖中线，开镜后移动指针</span>
            : <>
              {!cropEditing && <div className="crop-command-bar" aria-label="裁剪操作">
                <button type="button" className={cropApplied ? "selected" : ""} onClick={beginCrop} disabled={!active}><Crop />{cropApplied ? "重新裁剪" : "画面裁剪"}</button>
                <button type="button" onClick={clearCrop} disabled={!hasCrop && !cropEditing}><ArrowsClockwise />全画面</button>
                <button type="button" onClick={() => onZoom(-0.25)} aria-label="缩小预览">−</button>
                <button type="button" onClick={() => onZoom(0.25)} aria-label="放大预览">+ {Math.round(previewZoom * 100)}%</button>
              </div>}
              {cropApplied && <span className="crop-state-chip" role="status"><Check />已裁剪</span>}
              {cropFeedback && <span className="crop-applied-feedback" role="status"><CheckCircle weight="fill" /><span><strong>{cropFeedback}</strong><small>已同步导出尺寸</small></span></span>}
            </>}
        </div>
      </div>
      {cropEditing && <div className="crop-session-bar" aria-label="裁剪会话操作">
        {cropRatioPlacement === "header" && <CropRatioPalette value={cropAspect} onChange={chooseCropAspect} className="in-header" />}
        <span className="crop-coordinate-readout" role="status">目标 {cropReadout.width} × {cropReadout.height} px · X {cropReadout.x} · Y {cropReadout.y}</span>
        <div className="crop-command-bar" aria-label="裁剪操作">
          <button type="button" className="primary" onClick={() => applyCrop()} disabled={!draftHasCrop && cropAspect !== "original"}><Check />完成裁剪</button>
          <button type="button" onClick={cancelCrop} title="Backspace / Esc"><X />回退</button>
        </div>
      </div>}
      <div className="preview-shell transparency-grid" ref={shellRef}>
        {active && previewMode === "compare" && resultUrl && active.sourceUrl ? (
          <OutputComparison
            source={{ src: active.sourceUrl, kind: active.kind, animated: active.animated, alt: `${active.name} 原素材`, crop: comparisonSnapshot?.crop }}
            output={{ src: resultUrl, format: presentedFormat, alt: `${active.name} ${presentedExport?.label ?? `${formatLabel(presentedFormat)} 成品`}`, label: presentedExport?.label }}
            aspectRatio={comparisonSnapshot?.outputAspect ?? active.aspect}
            timeline={comparisonSnapshot ? {
              startSeconds: comparisonSnapshot.startSeconds,
              endSeconds: comparisonSnapshot.endSeconds,
              playbackSpeed: comparisonSnapshot.playbackSpeed,
              outputFps: comparisonSnapshot.outputFps,
              deletedFrameIndices: comparisonSnapshot.deletedFrameIndices,
              frameTimingMode: comparisonSnapshot.frameTimingMode,
            } : undefined}
            reducedMotion={reducedMotion}
          />
        ) : active && (
          <div
            className={`media-workbench${cropEditing && previewMode === "source" ? " with-rulers" : ""}`}
            style={{
              width: contentSize ? `${contentSize.width + rulerInset}px` : "100%",
              height: contentSize ? `${contentSize.height + rulerInset}px` : "100%",
              transform: `scale(${previewZoom})`,
            }}
          >
            {cropEditing && previewMode === "source" && <CropRulers width={sourceWidth} height={sourceHeight} />}
            <div
              className="media-content"
              style={{
                width: contentSize ? `${contentSize.width}px` : "100%",
                height: contentSize ? `${contentSize.height}px` : "100%",
              }}
            >
            <div className={`preview-media${cropApplied ? " crop-preview-applied" : ""}`}>
              <div className="preview-media__source" style={cropSourceStyle}>
              {previewMode === "result" && resultUrl ? (
                <OutputPreview src={resultUrl} format={presentedFormat} livePhoto={presentedExport?.result?.live_photo} alt={`${active.name} ${presentedExport?.label ?? "生成结果"}`} interactive stageOnly reducedMotion={reducedMotion} />
              ) : active.sourceUrl ? (
                active.kind === "video" ? (
                  <video key={`${active.id}:${active.path}`} ref={videoRef} src={active.sourceUrl} aria-label={`${active.name} 视频预览`} muted playsInline onLoadedMetadata={() => onVideoMetadata(active.id, active.path)} onTimeUpdate={onVideoTimeUpdate} onPlay={() => onPlaying(true)} onPause={() => onPlaying(false)} />
                ) : focusedFramePreview && active.animated ? (
                  <img src={focusedFramePreview.url} alt={`${active.name} ${focusedFramePreview.time.toFixed(3)} 秒单帧预览`} />
                ) : active.kind === "gif" || active.kind === "webp" || active.kind === "apng" ? (
                  <AnimatedMediaPlayer src={active.sourceUrl} format={active.kind} alt={`${active.name} 动画预览`} className="embedded-animation-player" stageOnly reducedMotion={reducedMotion} />
                ) : (
                  <img key={`${active.id}:${active.path}`} src={active.sourceUrl} alt={`${active.name} 预览`} onLoad={(event) => onImageMetadata(event, active.id, active.path)} />
                )
              ) : (
                <div className="preview-pending">
                  <VideoCamera />
                  <strong>{active.name}</strong>
                  <span>载入素材后在这里预览视频</span>
                </div>
              )}
              </div>
              {annotation && (annotation.topText || annotation.bottomText) && (
                <div className={`frame-annotation-preview style-${annotation.style} placement-${annotation.position}`} aria-label="当前文字标注预览">
                  {annotation.topText && <span className="frame-annotation-preview__top">{annotation.topText}</span>}
                  {annotation.bottomText && <span className="frame-annotation-preview__bottom">{annotation.bottomText}</span>}
                  {annotation.startSeconds != null && <small>位置预览 · 仅 {annotation.startSeconds.toFixed(2)}–{annotation.endSeconds?.toFixed(2)}s 生效</small>}
                </div>
              )}
              {trackedPreviewItems.map(({ effect, box }) => (
                <div
                  key={effect.id}
                  className={`tracked-effect-preview kind-${effect.kind}`}
                  aria-label={`${effect.kind === "label" ? "跟踪标注" : effect.kind === "highlight" ? "跟踪高亮" : "隐私遮挡"}预览`}
                  style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` }}
                >
                  {effect.kind === "label" && <span>{effect.label}</span>}
                </div>
              ))}
            </div>
            {cropEditing && previewMode === "source" && <CropBox value={cropDraft} onChange={(next, reason) => { if (reason !== "move") setCropAspect("free"); setCropDraft(next); }} onApply={applyCrop} onCancel={cancelCrop} />}
            </div>
          </div>
        )}
        {!active && <button type="button" className="empty-preview"><UploadSimple /><strong>拖入 GIF、WebP、APNG、PNG 或视频</strong><span>从左侧添加素材后开始编辑</span></button>}
        {cropEditing && previewMode === "source" && cropRatioPlacement !== "header" && <CropRatioPalette value={cropAspect} onChange={chooseCropAspect} className={`dock-${cropRatioPlacement}`} style={cropRatioDockStyle} />}
      </div>
      <div className="timeline">
        <div className="timeline-times">{totalFrameCount ? <><span>帧点时间线 · 悬停看画面，拖拽框选</span><b>{selectedFrameTimes.length ? `已选择 ${selectedFrameTimes.length} 帧` : deletedFrames.length ? `已删除 ${deletedFrames.length} 帧 · ${frameTimingMode === "preserve" ? "保持" : "导出"} ${exportDuration.toFixed(2)}s` : `${totalFrameCount} 个可编辑输出帧`}</b></> : <span>正在分析可编辑输出帧</span>}</div>
        <div className="timeline-body">
          {timelinePlaybackAvailable ? (
            <button type="button" className="play-button" aria-label={playing ? "暂停" : "播放"} onClick={onPlay}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button>
          ) : (
            <span className="timeline-mode-chip" aria-label="动画时间线逐帧取样"><FilmStrip /><small>逐帧</small></span>
          )}
          {frameTimes.length ? (
            <FrameDotTimeline
              frameTimes={frameTimes}
              outputFps={outputFps}
              selectedFrameIndices={selectedFrameIndices}
              deletedFrameIndices={deletedFrameIndices}
              frameTimingMode={frameTimingMode}
              thumbs={thumbs}
              hoverPreview={timelineHoverPreview}
              onHoverFrame={onHoverFrame}
              onSelectFrame={onSelectFrame}
              onSelectRange={onSelectFrameRange}
            />
          ) : <span className="timeline-empty"><FilmStrip />暂无可编辑帧</span>}
        </div>
        <div className="timeline-footer">
          <span className="timeline-footer__spacer" aria-hidden="true" />
          <TrimRange duration={duration} start={start} end={end} effectiveDuration={exportDuration} retainedRatio={retainedTimelineRatio} onStart={onStart} onEnd={onEnd} />
        </div>
      </div>
      <div className="frame-actions">
        {timelinePlaybackAvailable ? <button type="button" onClick={onPreviewRange}><Play />预览片段</button> : <span className="timeline-range-note">导出按此区间生效</span>}
        <button type="button" className="frame-action-primary" onClick={onOpenFrames} disabled={!totalFrameCount}><FilmStrip />逐帧编辑（{deletedFrames.length}）</button>
        <button type="button" className={annotation ? "frame-action-annotation active" : "frame-action-annotation"} onClick={onOpenAnnotation} disabled={!active}><TextT />{annotation ? "编辑标注" : "添加标注"}</button>
        <button type="button" className={trackedEffects.length ? "frame-action-tracking active" : "frame-action-tracking"} onClick={onOpenTracking} disabled={!active}><HandPointing />对象跟踪（{trackedEffects.length}）</button>
        <button type="button" onClick={onDeleteFrame} disabled={!selectedFrameTimes.length}><Trash />删除所选帧（{selectedFrameTimes.length}）</button>
        <button type="button" onClick={onUndoFrame} disabled={!canUndoFrame}>撤销上次删除</button>
        <button type="button" className="frame-action-secondary" onClick={onClearFrames} disabled={!deletedFrames.length}>恢复全部帧</button>
        <button type="button" onClick={onReset}><ArrowsClockwise />重置编辑</button>
      </div>
      {timelineFeedback && <p className="timeline-feedback" role="status">{timelineFeedback}</p>}
    </div>
  );
}

function OutputConfidenceCard({ result, format, label, busy, onTune, onRegenerate }: {
  result?: GifResult;
  format?: OutputFormat;
  label?: string;
  busy: boolean;
  onTune: (direction: OutputTuningDirection) => void;
  onRegenerate: () => void;
}) {
  if (!result) return null;
  const confidence = assessOutputConfidence({
    status: result.status,
    sizeBytes: result.size_bytes,
    width: result.output_width,
    fps: result.effective_output_fps ?? result.output_fps,
    frameCount: result.output_frame_count,
    hasAlpha: result.output_has_alpha,
    targetSizeBytes: result.target_size_bytes,
    targetDeviationPercent: result.target_deviation_percent,
    warnings: result.warnings,
    fallbackReason: result.fallback_reason,
    quality: result.quality_report ? {
      status: result.quality_report.status,
      vmafMean: result.quality_report.vmaf_mean,
      ssimMean: result.quality_report.ssim_mean,
      message: result.quality_report.message,
    } : null,
  });
  const effectiveFps = result.effective_output_fps ?? result.output_fps;
  return (
    <section className={`output-confidence confidence-${confidence.level}`} aria-label="输出结论">
      <div className="output-confidence__heading">
        <span><small>输出结论</small><strong>{confidence.label}</strong></span>
        <b>{label ?? formatLabel(format ?? resultFormat(result, "gif"))}</b>
      </div>
      <p>{confidence.summary}</p>
      <div className="output-confidence__facts">
        <span><small>文件大小</small><strong>{sizeText(result.size_bytes)}</strong></span>
        <span><small>画面</small><strong>{result.output_width}px · {effectiveFps} FPS</strong></span>
        <span className={confidence.qualityMeasured ? "measured" : "unmeasured"}><small>质量</small><strong>{confidence.qualityLabel}</strong></span>
        <span><small>透明</small><strong>{result.output_has_alpha ? "已保留" : "不含透明"}</strong></span>
      </div>
      {confidence.risks.length > 0 && <div className="output-confidence__risks">{confidence.risks.slice(0, 3).map((risk) => <span key={risk}>{risk}</span>)}</div>}
      <div className="output-confidence__actions" aria-label="快速调整并重新生成">
        <button type="button" disabled={busy} onClick={() => onTune("clearer")}>更清晰<small>提高细节</small></button>
        <button type="button" disabled={busy} onClick={() => onTune("smaller")}>更小<small>降低体积</small></button>
        <button type="button" disabled={busy} onClick={() => onTune("smoother")}>更流畅<small>提高帧率</small></button>
        <button type="button" className={confidence.recommendedAction === "regenerate" ? "recommended" : ""} disabled={busy} onClick={onRegenerate}><ArrowsClockwise />重新生成</button>
      </div>
    </section>
  );
}

function vmafGrade(value: number) {
  if (value >= 90) return "优秀";
  if (value >= 80) return "清晰";
  if (value >= 70) return "可用";
  return "损失明显";
}

function ssimGrade(value: number) {
  if (value >= 0.98) return "优秀";
  if (value >= 0.95) return "清晰";
  if (value >= 0.9) return "可用";
  return "损失明显";
}

function QualityStamp({ metric, value, grade, detail, digits = 1 }: {
  metric: string;
  value: number;
  grade: string;
  detail: string;
  digits?: number;
}) {
  return (
    <div className={`quality-stamp grade-${grade === "优秀" ? "excellent" : grade === "清晰" ? "clear" : grade === "可用" ? "usable" : "loss"}`} aria-label={`${metric} ${value.toFixed(digits)}，${grade}`}>
      <small>{metric}</small>
      <strong>{value.toFixed(digits)}</strong>
      <b>{grade}</b>
      <em>{detail}</em>
    </div>
  );
}

function ResultReport({
  result,
  format,
  onOpenResource,
}: {
  result?: GifResult;
  format?: OutputFormat;
  onOpenResource?: (path: string) => void;
}) {
  if (!result) return null;
  const signalPercent = (value: number | null | undefined) => (
    value != null && Number.isFinite(value) ? Math.round(value * 100).toString() : "未报告"
  );
  const statusLabels: Record<string, string> = {
    done: "完成",
    target_exact: "命中目标",
    target_under: "低于目标",
    target_over: "高于目标",
    target_unreachable: "目标不可达",
  };
  const deviation = result.target_deviation_percent;
  const perceptual = result.perceptual_report;
  const roiAssessment = assessRoiReadiness({
    hasAlpha: result.output_has_alpha,
    report: perceptual,
  });
  const filterStrategyLabels: Record<string, string> = {
    neutral: "中性滤镜",
    temporal_cleanup: "时域清理",
    "temporal_cleanup+color_eq": "时域清理 + 动作色彩增强",
    "denoise_deband+color_eq": "降噪 + 去色带 + 色彩增强",
  };
  const perceptualColorRoute = perceptual
    ? `${filterStrategyLabels[perceptual.filter_strategy] ?? perceptual.filter_strategy} · ${perceptual.effective_dither}${perceptual.effective_bayer_scale == null ? "" : ` 强度 ${perceptual.effective_bayer_scale}`}`
    : null;
  const palette = result.palette_report;
  const paletteReservation = result.palette_reservation_selection_report;
  const paletteReservationBaseline = paletteReservation?.baseline;
  const paletteReservationCandidate = paletteReservation?.candidate;
  const paletteReservationSummary = paletteReservation?.status === "opaque_256_selected"
    && paletteReservationBaseline
    && paletteReservationCandidate
    ? `不透明全色表已选 · 可用 ${paletteReservationCandidate.usable_colors} 色 / 透明差分 ${paletteReservationBaseline.usable_colors} 色 · ${sizeText(paletteReservationCandidate.serialized_bytes)} / ${sizeText(paletteReservationBaseline.serialized_bytes)} · 时序与循环接缝已过门`
    : paletteReservation?.status === "transparent_delta_retained"
      && paletteReservationBaseline
      && paletteReservationCandidate
      ? `透明差分已保留 · 可用 ${paletteReservationBaseline.usable_colors} 色 / 不透明全色表 ${paletteReservationCandidate.usable_colors} 色 · ${sizeText(paletteReservationBaseline.serialized_bytes)} / ${sizeText(paletteReservationCandidate.serialized_bytes)}${paletteReservation.fallback_reason ? ` · ${paletteReservation.fallback_reason}` : ""}`
      : paletteReservation?.status === "candidate_failed"
        ? `全 256 色候选未完成比较 · 已保留透明差分${paletteReservation.fallback_reason ? ` · ${paletteReservation.fallback_reason}` : ""}`
        : null;
  const writer = result.indexed_gif_writer_report;
  const quantizer = writer?.regional_quantizer_report;
  const temporalSelection = quantizer?.temporal_selection;
  const temporalCandidate = temporalSelection?.candidate;
  const temporalSelectionSummary = temporalCandidate
    && temporalSelection?.status === "candidate_selected"
    && quantizer?.selected_route_id === "temporal_hysteresis"
    && (writer?.status === "encoded_default" || writer?.status === "encoded_experimental")
    ? `已选用时间索引稳定 · 索引保持 ${temporalCandidate.temporal_hold_count} 次 · 实际字节 ${sizeText(temporalCandidate.serialized_bytes)} / 有序基线 ${sizeText(temporalSelection.baseline.serialized_bytes)}`
    : null;
  const diffusionSelection = quantizer?.error_diffusion_selection;
  const diffusionCandidate = diffusionSelection?.candidate;
  const diffusionSelectionSummary = diffusionCandidate
    && diffusionSelection?.status === "candidate_selected"
    && quantizer?.selected_route_id === "error_diffusion_temporal"
    && (writer?.status === "encoded_default" || writer?.status === "encoded_experimental")
    ? `已启用渐变平滑 · 扩散像素 ${diffusionCandidate.diffused_pixel_count} · 静态索引翻转率 ${(diffusionCandidate.vfr_weighted_static_index_flip_rate * 100).toFixed(2)}% · 实际字节 ${sizeText(diffusionCandidate.serialized_bytes)}`
    : null;
  const segmentPalette = writer?.segment_palette_report;
  const usesSegmentPalette = segmentPalette?.status === "encoded";
  const paletteHash = usesSegmentPalette
    ? writer?.local_palette_sequence_sha256 ?? segmentPalette.palette_sequence_sha256
    : palette?.artifact_hashes.find((hash) => hash.length > 0);
  const paletteHashLabel = usesSegmentPalette ? "完整调色板序列 SHA-256" : "完整调色板 SHA-256";
  const segmentPaletteSummary = segmentPalette?.status === "encoded"
    ? `${segmentPalette.segment_count} 段 Local Color Table 已过多尺度/体积门 · 实色 ${segmentPalette.opaque_colors_by_segment.join("/")} · 表项 ${segmentPalette.local_table_entries_by_segment.join("/")}${segmentPalette.candidate_serialized_bytes == null || segmentPalette.baseline_serialized_bytes == null ? "" : ` · ${sizeText(segmentPalette.candidate_serialized_bytes)} / 全局基线 ${sizeText(segmentPalette.baseline_serialized_bytes)}`}`
    : segmentPalette?.status === "quality_gate_rejected"
      ? `${segmentPalette.segment_count} 段 Local Color Table 候选未过门 · 继续使用已验证全局表${segmentPalette.fallback_reason ? ` · ${segmentPalette.fallback_reason}` : ""}`
      : segmentPalette?.status === "selection_gate_rejected"
        ? `${segmentPalette.segment_count} 段 Local Color Table 候选无 Pareto 收益 · 继续使用已验证全局表${segmentPalette.fallback_reason ? ` · ${segmentPalette.fallback_reason}` : ""}`
      : segmentPalette?.status === "candidate_failed"
          ? `${segmentPalette.segment_count} 段 Local Color Table 候选失败 · 继续使用已验证全局表${segmentPalette.fallback_reason ? ` · ${segmentPalette.fallback_reason}` : ""}`
          : palette?.candidate_status === "planned_not_encoded" && (palette.candidate_segment_count ?? 0) > 1
            ? `${palette.candidate_segment_count} 段候选 · ${palette.shared_anchor_count ?? 0} 个共享锚点 · ${palette.global_color_table_verified ? "当前仍使用已验证全局表" : "当前输出全局表未通过契约验证"}`
            : null;
  const regions = result.region_dither_report;
  const activeQuantizationMetrics = segmentPalette?.status === "encoded"
    ? segmentPalette.candidate_metrics
    : quantizer?.candidate_metrics;
  const regionPlan = regions?.status === "planned_not_encoded"
    ? `${regions.grid_width}×${regions.grid_height} · 平面 ${regions.class_counts.flat} · 文字/边缘 ${regions.class_counts.text_edge} · 肤色/主体 ${regions.class_counts.skin_subject} · 纹理 ${regions.class_counts.texture} · 仅规划`
    : regions?.status === "encoded"
      ? `${regions.grid_width}×${regions.grid_height} · Rust 区域量化已过多尺度/体积门 · mean ${activeQuantizationMetrics?.mean_oklab_error.toFixed(4) ?? "未报告"} · P95 ${activeQuantizationMetrics?.p95_oklab_error.toFixed(4) ?? "未报告"} · 低频 ${activeQuantizationMetrics?.multiscale_low_frequency_oklab_error.toFixed(4) ?? "未报告"} · 条带 ${activeQuantizationMetrics?.multiscale_banding_score.toFixed(4) ?? "未报告"} · 边缘梯度 ${activeQuantizationMetrics?.edge_gradient_error.toFixed(4) ?? "未报告"} · 时稳 ${activeQuantizationMetrics?.multiscale_static_temporal_residual.toFixed(4) ?? "未报告"}`
      : regions?.status === "quality_gate_rejected"
        ? `Rust 区域量化候选未过门 · 继续使用 FFmpeg 调色板映射${regions.fallback_reason ? ` · ${regions.fallback_reason}` : ""}`
        : regions?.status === "candidate_failed"
          ? `Rust 区域量化候选失败 · 继续使用 FFmpeg 调色板映射${regions.fallback_reason ? ` · ${regions.fallback_reason}` : ""}`
    : regions?.status === "planning_failed"
      ? "区域抖动计划失败 · 当前输出继续使用全局抖动"
      : null;
  const writerColorRoute = segmentPalette?.status === "encoded"
    ? `${segmentPalette.segment_count} 段 Local Table`
    : quantizer?.status === "encoded"
      ? "Rust 区域量化"
      : "FFmpeg 映射";
  const writerLocalSummary = writer && writer.local_palette_frame_count > 0
    ? ` · Local Table ${writer.local_palette_frame_count} 帧 · 段边界强制全帧 ${writer.palette_boundary_full_frame_count}`
    : "";
  const disposalStrategyLabels: Record<string, string> = {
    opaque_keep_rectangles_v1: "不透明 Keep 矩形",
    transparent_background_bbox_v1: "透明 Background 包围框",
    transparent_previous_bbox_v1: "透明 Previous 包围框",
    transparent_mixed_disposal_v1: "透明混合处置",
  };
  const writerDisposalSummary = writer && writer.disposal_candidate_count > 1
    ? ` · 处置实测 ${writer.disposal_candidate_count} 路 · ${disposalStrategyLabels[writer.selected_disposal_strategy] ?? writer.selected_disposal_strategy} · Background ${writer.background_disposal_frame_count} 帧 / Previous ${writer.previous_disposal_frame_count} 帧`
    : "";
  const writerByteSummary = writer
    && writer.disposal_candidate_count > 1
    && writer.baseline_serialized_bytes != null
    && writer.candidate_serialized_bytes != null
    ? ` · 实际字节 ${sizeText(writer.candidate_serialized_bytes)} / FFmpeg ${sizeText(writer.baseline_serialized_bytes)}${writer.serialized_byte_reduction_percent == null ? "" : ` · ${writer.serialized_byte_reduction_percent >= 0 ? "缩小" : "增大"} ${Math.abs(writer.serialized_byte_reduction_percent).toFixed(1)}%`}`
    : "";
  const paletteCompaction = writer?.palette_compaction_report;
  const writerPaletteCompactionSummary = paletteCompaction?.status === "compacted_selected"
    && paletteCompaction.serialized_byte_reduction_percent != null
    ? ` · 无损索引压缩 ${paletteCompaction.original_global_palette_entries}→${paletteCompaction.selected_global_palette_entries} 色 · -${paletteCompaction.serialized_byte_reduction_percent.toFixed(1)}%`
    : "";
  const writerSummary = writer && (writer.status === "encoded_default" || writer.status === "encoded_experimental")
    ? `Rust Indexed Writer · ${writer.rectangle_frame_count}/${writer.frame_count} 变化矩形 · 索引像素 -${writer.indexed_pixel_reduction_percent.toFixed(1)}% · ${writerColorRoute}${writerLocalSummary}${writerPaletteCompactionSummary}${writerDisposalSummary}${writerByteSummary} · ${writer.disposal_simulation_verified ? "处置模拟已验证" : "处置模拟未验证"} · ${writer.decoded_pixel_parity_verified ? "独立解码逐像素已验证" : "逐像素未验证"}`
    : writer?.status === "baseline_retained"
      ? writer.decoded_pixel_parity_verified
        ? `透明处置搜索已验证${writerDisposalSummary}${writerByteSummary} · FFmpeg 基线更小，已保留原输出`
        : "候选未缩小文件，已保留原输出"
      : writer?.status === "fallback_ffmpeg"
        ? `Rust Indexed Writer 已回退 · 实际使用 FFmpeg 写入${writer.fallback_reason ? ` · ${writer.fallback_reason}` : ""}`
        : null;
  const paletteSummary = palette?.strategy === "segmented_local"
    ? `Rust OKLab · 分段 Local Color Table · ${segmentPalette?.segment_count ?? palette.segment_count} 段 · ${palette.global_color_table_verified ? "GIF 全局/局部表契约已验证" : "GIF 调色板契约未验证"}`
    : palette
      ? `Rust OKLab · ${palette.strategy === "global" ? "全局" : "分段"} · ${palette.emitted_colors}/${palette.requested_colors} 色 · ${palette.segment_count} 段 · ${palette.global_color_table_verified ? "GIF 调色板契约已验证" : "GIF 调色板契约未验证"}`
      : null;
  const targetOptimizer = result.target_optimizer_report;
  const targetPreferenceLabels: Record<string, string> = {
    balanced: "均衡优先",
    clarity: "清晰度优先",
    smoothness: "流畅度优先",
    smallest: "最小体积优先",
  };
  const targetRoleLabels: Record<string, string> = {
    clearest: "最清晰",
    smoothest: "最流畅",
    smallest: "最小体积",
  };
  const targetRecommendations = targetOptimizer?.recommendations
    .map((recommendation) => `${targetRoleLabels[recommendation.role] ?? recommendation.role} #${recommendation.attempt}`)
    .join(" · ");
  const targetRouteLabels: Record<string, string> = {
    baseline: "内容自适应基线",
    sierra_quality: "Sierra 质量路线",
    alternate_stats: "调色板统计备选",
    perceptual_timeline: "感知时间表",
    perceptual_reinvest: "感知预算回投",
    perceptual_reinvest_corrected: "回投超限修正",
  };
  const targetPredictionText = (route: TargetRouteObservationReport) => {
    const prediction = route.prediction;
    if (!prediction) return "";
    const ratio = prediction.actual_to_predicted_ratio == null
      ? ""
      : ` · 实测/预测 ${prediction.actual_to_predicted_ratio.toFixed(3)}×`;
    const correction = prediction.correction_pass > 0
      ? ` · 第 ${prediction.correction_pass} 次有界修正`
      : "";
    return ` · 预测 ${sizeText(prediction.predicted_size_bytes)}${ratio}${correction}`;
  };
  const selectedTargetRoute = targetOptimizer?.route_observations.find((route) => route.selected);
  const finalSettings = [
    result.output_width == null ? null : `${result.output_width}px`,
    result.output_fps == null ? null : perceptual ? `${result.output_fps} FPS 采样上限` : `${result.output_fps} FPS`,
    perceptual && result.effective_output_fps != null ? `${result.effective_output_fps.toFixed(2)} FPS 实际平均` : null,
    result.output_colors > 0 ? `${result.output_colors} 色` : null,
  ].filter(Boolean).join(" · ");
  const warnings = result.warnings?.filter(Boolean) ?? [];
  const deliveredFormat = format || result.output_format || "gif";
  const livePhoto = result.live_photo;
  const quality = result.quality_report;
  const livePhotoVerified = livePhoto ? isLivePhotoCompatibilityVerified(livePhoto) : false;

  return (
    <section className="result-report" aria-label="编码结果报告">
      <div className="result-report__heading"><strong>本次编码报告</strong><span>{statusLabels[result.status] ?? result.status}</span></div>
      {quality?.status === "measured" && quality.vmaf_mean != null && quality.ssim_mean != null && (
        <div className="quality-stamp-row" role="group" aria-label="质量评分">
          <QualityStamp metric="VMAF" value={quality.vmaf_mean} grade={vmafGrade(quality.vmaf_mean)} detail={`P05 ${quality.vmaf_p05?.toFixed(1) ?? "—"}`} />
          <QualityStamp metric="SSIM" value={quality.ssim_mean} grade={ssimGrade(quality.ssim_mean)} detail={quality.ms_ssim_mean == null ? "画面一致性" : `MS ${quality.ms_ssim_mean.toFixed(3)}`} digits={3} />
          <p><strong>画质评分</strong><span>{`${quality.metric_model} · ${quality.sample_duration_seconds.toFixed(1)}s / ${quality.compared_frames} 帧 · ${(quality.elapsed_ms / 1000).toFixed(1)}s`}</span></p>
        </div>
      )}
      <dl>
        {quality?.status === "unavailable" && <div><dt>质量评分</dt><dd>{quality.message || "暂时无法评分"}</dd></div>}
        <div><dt>5.7 ROI 基线</dt><dd>{`${roiAssessment.label} · ${roiAssessment.reason}${roiAssessment.samIncrementWorthTesting ? " · 建议再做 SAM 增量 A/B" : " · 不启用 SAM"}`}</dd></div>
        <div><dt>输出体积</dt><dd>{sizeText(result.size_bytes)}</dd></div>
        <div><dt>交付格式</dt><dd>{`${formatLabel(deliveredFormat)} · ${result.output_codec || result.encoder_used}${result.output_has_alpha ? " · Alpha" : ""}`}</dd></div>
        {deliveredFormat === "live_photo" && <div><dt>本地配对</dt><dd>{livePhoto ? livePhotoValidationLabel(livePhoto) : "后端未返回验证报告 · 不宣称 Apple Photos 已接收"}</dd></div>}
        <div><dt>帧数</dt><dd>{result.output_frame_count > 0 ? `${result.output_frame_count} 帧` : "后端未报告"}</dd></div>
        {result.structure_optimization_report && <div><dt>智能无损阶段</dt><dd>{result.structure_optimization_report.adopted && result.structure_optimization_report.verified
          ? `已采用并验证 · ${sizeText(result.structure_optimization_report.before_bytes)} → ${sizeText(result.structure_optimization_report.after_bytes)}`
          : "没有合格增量，保留原结果"}</dd></div>}
        <div><dt>编码耗时</dt><dd>{`${(result.elapsed_ms / 1000).toFixed(2)}s · ${result.attempts} 次编码`}</dd></div>
        <div><dt>目标偏差</dt><dd>{deviation == null ? "未设置目标" : `${deviation > 0 ? "+" : ""}${deviation.toFixed(1)}%`}</dd></div>
        {targetOptimizer && <div><dt>体积搜索</dt><dd>{`${targetPreferenceLabels[targetOptimizer.preference] ?? targetOptimizer.preference} · ${targetOptimizer.numeric_attempt_count ?? targetOptimizer.observations.length} 次尺寸实测${targetOptimizer.route_attempt_count ? ` + ${targetOptimizer.route_attempt_count} 次路线探测` : ""} · Pareto ${targetOptimizer.observations.filter((observation) => observation.pareto_frontier).length} 项 · 已选 #${targetOptimizer.selected_attempt}${selectedTargetRoute ? ` / ${targetRouteLabels[selectedTargetRoute.route_id] ?? selectedTargetRoute.route_id}` : ""}${targetRecommendations ? ` · ${targetRecommendations}` : ""}`}<details className="result-report__target"><summary>查看候选轨迹</summary><ol>{targetOptimizer.observations.map((observation) => <li key={observation.attempt}>{`#${observation.attempt} · ${observation.width}px · ${observation.fps} FPS · ${observation.colors} 色 · ${sizeText(observation.size_bytes)} · ${observation.symmetric_deviation_percent.toFixed(2)}%${observation.within_tolerance ? " · 命中" : observation.under_target ? " · 低于" : " · 超出"}${observation.pareto_frontier ? " · Pareto" : ""}${observation.selected ? " · 已选尺寸" : ""}`}</li>)}</ol>{targetOptimizer.route_observations.length > 0 && <ul>{targetOptimizer.route_observations.map((route) => <li key={route.route_id}>{`${targetRouteLabels[route.route_id] ?? route.route_id} · ${route.width}px · ${route.fps} FPS · ${route.colors} 色 · ${route.timeline === "perceptual_drop_hold" ? `Drop-and-Hold${route.kept_frame_count == null ? "" : ` ${route.kept_frame_count} 保留 / ${route.dropped_frame_count ?? 0} 删除`}${route.timeline_verified ? " · 时间轴已验证" : ""} · ` : ""}${route.dither} · ${route.palette_stats_mode}${route.size_bytes == null ? ` · 失败${route.failure_reason ? `：${route.failure_reason}` : ""}` : ` · ${sizeText(route.size_bytes)}${route.within_tolerance ? " · 命中" : route.under_target ? " · 低于" : " · 超出"}`}${targetPredictionText(route)}${route.selected ? " · 已选路线" : ""}`}</li>)}</ul>}</details></dd></div>}
        <div><dt>最终参数</dt><dd>{finalSettings || "后端未报告"}</dd></div>
        <div><dt>调色板</dt><dd>{result.palette_strategy === "not_applicable" ? "该格式不使用 GIF 调色板" : result.palette_strategy || "后端未报告"}</dd></div>
        <div><dt>编码后端</dt><dd>{[result.backend_id || result.encoder_used, result.backend_version, result.ffmpeg_engine_version ? `FFmpeg 引擎 ${result.ffmpeg_engine_version}` : null].filter(Boolean).join(" · ")}</dd></div>
        {perceptual && <div><dt>感知抽帧</dt><dd>{`${perceptual.analysis_frame_count} → ${perceptual.kept_frame_count} 帧 · 保留 ${(perceptual.kept_ratio * 100).toFixed(0)}%`}</dd></div>}
        {perceptual && <div><dt>时间轴</dt><dd>{`${perceptual.variable_delay_frames} 个可变延迟 · ${perceptual.output_duration_ms} ms · ${perceptual.aggregate_timeline_verified ? "FFprobe 帧数/总时长已验证" : "帧数/总时长未验证"}`}</dd></div>}
        {perceptualColorRoute && <div><dt>颜色路线</dt><dd>{perceptualColorRoute}</dd></div>}
        {perceptual && <div><dt>内容信号</dt><dd>{`${perceptual.scene_boundary_count} 个场景边界 · 动作 ${signalPercent(perceptual.mean_motion)} · 边缘 ${signalPercent(perceptual.mean_edge_text)} · 渐变 ${signalPercent(perceptual.mean_smooth_gradient_ratio)} · 噪声 ${signalPercent(perceptual.mean_noise)}`}</dd></div>}
        {paletteSummary && <div><dt>感知调色板</dt><dd>{paletteSummary}</dd></div>}
        {paletteReservationSummary && <div><dt>256 色取舍</dt><dd>{paletteReservationSummary}</dd></div>}
        {segmentPaletteSummary && <div><dt>分段颜色路线</dt><dd>{segmentPaletteSummary}</dd></div>}
        {regionPlan && <div><dt>区域抖动计划</dt><dd>{regionPlan}</dd></div>}
        {temporalSelectionSummary && <div><dt>跨帧索引稳定</dt><dd>{temporalSelectionSummary}</dd></div>}
        {diffusionSelectionSummary && <div><dt>渐变平滑</dt><dd>{diffusionSelectionSummary}</dd></div>}
        {writerSummary && <div><dt>GIF 写入内核</dt><dd>{writerSummary}</dd></div>}
        {result.gif_cleanup_report && <div><dt>无损整理</dt><dd>{result.gif_cleanup_report.verified
          ? `已验证 · 合并 ${result.gif_cleanup_report.merged_frames} 帧 · 色表减少 ${result.gif_cleanup_report.removed_palette_entries} 项 · ${sizeText(result.gif_cleanup_report.before_bytes)} → ${sizeText(result.gif_cleanup_report.after_bytes)}`
          : `未采用 · ${result.gif_cleanup_report.reason || "没有更小的候选"}`}</dd></div>}
        {result.index_compression_report && <div><dt>索引压缩（有损）</dt><dd>{result.index_compression_report.status === "optimized" && result.index_compression_report.verified
          ? `误差验收通过 · ${sizeText(result.index_compression_report.before_bytes)} → ${sizeText(result.index_compression_report.after_bytes)} · 最大通道变化 ${result.index_compression_report.max_channel_error}/255`
          : `保留原输出 · ${result.index_compression_report.reason || "没有满足条件的更小候选"}`}</dd></div>}
        {result.postprocess_report && <div><dt>无损后处理</dt><dd>{result.postprocess_report.status === "optimized" && result.postprocess_report.verified
          ? `已验证并缩小 · ${sizeText(result.postprocess_report.before_bytes)} → ${sizeText(result.postprocess_report.after_bytes)}`
          : `保留原输出${result.postprocess_report.reason ? ` · ${result.postprocess_report.reason}` : " · 候选未缩小文件"}`}</dd></div>}
        {palette && <div><dt>{usesSegmentPalette ? "全局基线拟合" : "拟合误差"}</dt><dd>{`5-bit 桶代表色拟合估算 · mean ${palette.weighted_histogram_mean_oklab_error.toFixed(4)} · P95 ${palette.weighted_histogram_p95_oklab_error.toFixed(4)}`}</dd></div>}
        {paletteHash && <div><dt>Artifact 指纹</dt><dd><details className="result-report__hash"><summary>{`SHA-256 前缀 ${paletteHash.slice(0, 12)}…`}</summary><label><span>完整 SHA-256（聚焦后可复制）</span><input aria-label={paletteHashLabel} type="text" readOnly value={paletteHash} onFocus={(event) => event.currentTarget.select()} /></label></details></dd></div>}
      </dl>
      {livePhoto && (
        <section className="result-report__live-photo" aria-label="实况照片成对资源">
          <div className="result-report__live-heading">
            <strong>成对资源</strong>
            <span className={livePhotoVerified ? "verified" : livePhoto.compatibility_status === "failed" ? "failed" : "unverified"}>
              {livePhotoValidationLabel(livePhoto)}
            </span>
          </div>
          <div className="result-report__live-resource">
            <span><b>静态关键帧</b><small title={livePhoto.still_path}>{livePhoto.still_path}</small></span>
            {livePhoto.still_size_bytes != null && <em>{sizeText(livePhoto.still_size_bytes)}</em>}
            <button type="button" onClick={() => onOpenResource?.(livePhoto.still_path)} disabled={!onOpenResource}>打开位置</button>
          </div>
          <div className="result-report__live-resource">
            <span><b>MOV 动态资源</b><small title={livePhoto.motion_path}>{livePhoto.motion_path}</small></span>
            {livePhoto.motion_size_bytes != null && <em>{sizeText(livePhoto.motion_size_bytes)}</em>}
            <button type="button" onClick={() => onOpenResource?.(livePhoto.motion_path)} disabled={!onOpenResource}>打开位置</button>
          </div>
          <p>
            <span>资源标识：{livePhoto.asset_identifier_verified ? "已验证" : "未验证"}</span>
            <span>配对元数据：{livePhoto.metadata_pairing_verified ? "已验证" : "未验证"}</span>
          </p>
          {livePhoto.validation_message && <small className="result-report__live-message">{livePhoto.validation_message}</small>}
        </section>
      )}
      {result.fallback_reason && <p className="result-report__fallback"><strong>降级原因</strong><span>{result.fallback_reason}</span></p>}
      {warnings.length > 0 && <div className="result-report__warnings"><strong>警告</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
    </section>
  );
}

function FormatEconomicsReport({ rows }: { rows: FormatEconomicsRow[] }) {
  if (!rows.length) return null;
  const encoded = rows.filter((row) => row.status === "encoded");
  const smallest = encoded.reduce<FormatEconomicsRow | null>((best, row) => (
    !best || (row.sizeBytes ?? Number.MAX_SAFE_INTEGER) < (best.sizeBytes ?? Number.MAX_SAFE_INTEGER) ? row : best
  ), null);
  return (
    <section className="format-economics paper-panel" aria-label="同源多格式经济性">
      <div className="format-economics__heading">
        <span><strong>格式对比</strong><small>基于相同裁剪、尺寸、帧率和时长</small></span>
        <b>{smallest ? `最小体积 ${formatLabel(smallest.format)}` : "等待实测"}</b>
      </div>
      <div className="format-economics__table" role="table" aria-label="六格式体积质量耗时兼容性比较">
        <div role="row" className="header"><span>格式</span><span>体积</span><span>质量</span><span>耗时</span><span>兼容性</span></div>
        {rows.map((row) => <div role="row" className={row.status} key={row.format}>
          <strong>{formatLabel(row.format)}</strong>
          <span>{row.sizeBytes == null ? "—" : sizeText(row.sizeBytes)}</span>
          <span title={row.failureReason}>{row.qualityLabel}</span>
          <span>{row.elapsedMs == null ? "—" : `${(row.elapsedMs / 1000).toFixed(2)}s`}</span>
          <span>{row.compatibilityLabel}</span>
        </div>)}
      </div>
      <p>质量评分不可用时显示“暂无”。</p>
    </section>
  );
}

type CutoutUiMode = "off" | "color_key";

function CutoutControl({
  value,
  sourceHasAlpha,
  outputFormat,
  allFormatsSelected,
  onChange,
}: {
  value: BackgroundRemovalRequest | null;
  sourceHasAlpha?: boolean;
  outputFormat: OutputFormat;
  allFormatsSelected: boolean;
  onChange: (value: BackgroundRemovalRequest | null) => void;
}) {
  const mode: CutoutUiMode = value?.mode === "color_key" ? "color_key" : "off";
  const alphaOutput = ["gif", "webp", "apng", "webm"].includes(outputFormat);
  const selectMode = (next: CutoutUiMode) => {
    if (next === "off") onChange(null);
    if (next === "color_key") onChange(value ?? {
      mode: "color_key",
      key_color: "#00FF00",
      similarity: 0.24,
      edge_blend: 0.08,
      despill: 0.35,
    });
  };
  const update = (patch: Partial<BackgroundRemovalRequest>) => onChange({
    mode: "color_key",
    key_color: value?.key_color ?? "#00FF00",
    similarity: value?.similarity ?? 0.24,
    edge_blend: value?.edge_blend ?? 0.08,
    despill: value?.despill ?? 0.35,
    ...patch,
  });
  return (
    <div className="cutout-control" role="group" aria-label="抠图方式">
      <div className={`cutout-alpha-status${sourceHasAlpha ? " detected" : ""}`}>
        <span>素材 Alpha</span>
        <strong>{sourceHasAlpha ? "已检测 · 自动保留" : "未检测到"}</strong>
      </div>
      <IslandRadioGroup
        ariaLabel="抠图来源"
        value={mode}
        compact
        options={[
          { value: "off", label: "不新增抠图", note: sourceHasAlpha ? "保留素材自带 Alpha" : "保持原始背景" },
          { value: "color_key", label: "色键背景", note: alphaOutput || allFormatsSelected ? "当前可用 · 支持绿幕/蓝幕" : "当前格式不保留透明", disabled: !alphaOutput && !allFormatsSelected },
        ]}
        onChange={selectMode}
      />
      {mode === "color_key" && value && (
        <div className="cutout-key-controls">
          <label><span>背景色</span><input aria-label="抠图背景色" type="color" value={value.key_color} onChange={(event) => update({ key_color: event.target.value.toUpperCase() })} /></label>
          <label><span>容差</span><input aria-label="抠图颜色容差" type="range" min="1" max="100" value={Math.round(value.similarity * 100)} onChange={(event) => update({ similarity: Number(event.target.value) / 100 })} /><b>{Math.round(value.similarity * 100)}%</b></label>
          <label><span>边缘融合</span><input aria-label="抠图边缘融合" type="range" min="0" max="100" value={Math.round(value.edge_blend * 100)} onChange={(event) => update({ edge_blend: Number(event.target.value) / 100 })} /><b>{Math.round(value.edge_blend * 100)}%</b></label>
          <label><span>去溢色</span><input aria-label="抠图去溢色" type="range" min="0" max="100" value={Math.round(value.despill * 100)} onChange={(event) => update({ despill: Number(event.target.value) / 100 })} /><b>{Math.round(value.despill * 100)}%</b></label>
        </div>
      )}
      <small>{allFormatsSelected ? "透明背景会保留在 GIF、WebP、APNG 和 WebM 中；其他格式使用原背景。" : alphaOutput ? "透明背景会随当前输出格式一并保留。" : "当前格式不保留透明背景，请切换 GIF、WebP、APNG 或 WebM。"}</small>
    </div>
  );
}

function TaskControlCard({ load, status, activeJobs, concurrency, onCancel }: {
  load: MaterialLoadAssessment;
  status: PresentedTaskStatus | null;
  activeJobs: number;
  concurrency: number;
  onCancel: () => void;
}) {
  const policy = taskControlPolicy(load);
  return (
    <section className={`task-control-card${status ? ` tone-${status.tone}` : ""}`} aria-label="长素材与任务控制">
      <div className="task-control-card__heading">
        <span><small>素材负载</small><strong>{load.label}</strong></span>
        <b>最多 {policy.thumbnailBudget} 张时间线取样 · 最多 {concurrency} 路</b>
      </div>
      <p>{load.reasons[0]} · {policy.summary}</p>
      {status && <div className="task-control-card__run" aria-live="polite">
        <span><strong>{status.label}</strong><small>{status.detail}{activeJobs > 0 ? ` · ${activeJobs} 项编码中` : ""}</small></span>
        {status.cancellable && <button type="button" onClick={onCancel}><X />停止任务</button>}
      </div>}
    </section>
  );
}

function VolumeDirectorControl({ enabled, active, priority, plan, targetSizeMb, onEnabled, onPriority }: {
  enabled: boolean;
  active: boolean;
  priority: VolumeDirectorPriority;
  plan: VolumeDirectorPlan;
  targetSizeMb: number;
  onEnabled: (enabled: boolean) => void;
  onPriority: (priority: VolumeDirectorPriority) => void;
}) {
  const pressureLabel = plan.pressure === "extreme" ? "极高压力" : plan.pressure === "high" ? "高压力" : plan.pressure === "medium" ? "中等压力" : "低压力";
  const priorities: Array<[VolumeDirectorPriority, string]> = [
    ["balanced", "均衡"],
    ["clarity", "清晰"],
    ["motion", "流畅"],
    ["text", "文字"],
    ["smallest", "最小"],
  ];
  return (
    <div className={`volume-director${enabled ? " enabled" : ""}${active ? " active" : ""}`}>
      <div className="volume-director__head">
        <span><Sparkle weight="fill" /><span><strong>体积导演</strong><small>{active ? `正在规划 ${targetSizeMb.toFixed(1)} MB 以内的方案` : enabled ? "选择精确体积后参与编码" : "由当前参数直接编码"}</small></span></span>
        <button type="button" role="switch" aria-checked={enabled} onClick={() => onEnabled(!enabled)}><i />{enabled ? "开启" : "关闭"}</button>
      </div>
      {enabled && <>
        <div className="volume-director__priority" role="group" aria-label="体积导演优先目标">
          {priorities.map(([id, label]) => <button type="button" key={id} className={priority === id ? "selected" : ""} aria-pressed={priority === id} onClick={() => onPriority(id)}>{label}</button>)}
        </div>
        {active ? <>
          <div className="volume-director__plan" aria-label="体积导演当前策略">
            <div><span><small>内容判断</small><strong>{plan.contentLabel}</strong></span><b>{pressureLabel}</b></div>
            <div><span><small>时间轴</small><strong>{plan.timelineLabel}</strong></span><span><small>预计节省</small><strong>{plan.estimatedSavingsPercent[0]}–{plan.estimatedSavingsPercent[1]}%</strong></span></div>
          </div>
          <div className="volume-director__tradeoffs"><strong>本次上限</strong><span>{plan.suggestedWidth}px · {plan.suggestedFps} FPS · {plan.suggestedColors} 色</span><small>{plan.tradeoffs.join("；")}</small></div>
        </> : <small className="volume-director__standby">切换到“精确体积”即可启用多轮实测与自动取舍。</small>}
      </>}
    </div>
  );
}

function SettingsPanel({
  postprocessControl,
  detailed,
  showCutout,
  presetId,
  presetAdjusted,
  playbackSpeed,
  outputFormat,
  encoder,
  sourceHasAlpha,
  deliveryFormatPreference,
  deliveryIntent,
  targetPlatform,
  livePhotoBackend,
  outputBackendReady,
  generationMode,
  targetSizeMb,
  volumeDirectorEnabled,
  volumeDirectorActive,
  volumeDirectorPriority,
  volumeDirectorPlan,
  targetOutcome,
  bayerScale,
  alphaThreshold,
  backgroundRemoval,
  perceptualFocus,
  backendCapabilities,
  width,
  fps,
  colors,
  dither,
  lossy,
  optimizeLevel,
  filter,
  memeOverlayActive,
  loopOutput,
  outputDir,
  progress,
  busy,
  status,
  sourceLabel,
  presentedExport,
  mediaAssets,
  history,
  queueProgress,
  resourceSnapshot,
  resourceSamplingError,
  logicalCpuCount,
  queueConcurrencySetting,
  effectiveQueueConcurrency,
  activeQueueJobs,
  materialLoad,
  taskStatus,
  taskConcurrency,
  estimateFactor,
  onPreset,
  onSpeed,
  onDeliveryIntent,
  onDeliveryFormatPreference,
  onTargetPlatform,
  onEncoder,
  onGenerationMode,
  onTargetSizeMb,
  onVolumeDirectorEnabled,
  onVolumeDirectorPriority,
  onBayerScale,
  onAlphaThreshold,
  onBackgroundRemoval,
  onPerceptualFocus,
  onWidth,
  onFps,
  onColors,
  onDither,
  onLossy,
  onOptimize,
  onFilter,
  onLoop,
  onChooseOutput,
  onOpenOutput,
  onSaveCustom,
  onGenerateCurrent,
  onTuneOutput,
  onOpenHistory,
  onQueueConcurrencySetting,
  onCancelTask,
  advancedOpen,
  onOpenAdvanced,
}: {
  postprocessControl?: React.ReactNode;
  detailed: boolean;
  showCutout: boolean;
  presetId: CompressionPresetId;
  presetAdjusted: boolean;
  playbackSpeed: number;
  outputFormat: OutputFormat;
  encoder: GifEncoder;
  sourceHasAlpha?: boolean;
  deliveryFormatPreference: DeliveryFormatPreference;
  deliveryIntent: DeliveryIntent;
  targetPlatform: TargetPlatform;
  livePhotoBackend?: BackendCapability;
  outputBackendReady: boolean;
  generationMode: GifGenerationMode;
  targetSizeMb: number;
  volumeDirectorEnabled: boolean;
  volumeDirectorActive: boolean;
  volumeDirectorPriority: VolumeDirectorPriority;
  volumeDirectorPlan: VolumeDirectorPlan;
  targetOutcome: TightCapOutcome | null;
  bayerScale: number;
  alphaThreshold: number;
  backgroundRemoval: BackgroundRemovalRequest | null;
  perceptualFocus: PerceptualFocus;
  backendCapabilities: BackendCapability[];
  width: number;
  fps: number;
  colors: number;
  dither: DitherId;
  lossy: number;
  optimizeLevel: number;
  filter: FilterStyle;
  memeOverlayActive: boolean;
  loopOutput: boolean;
  outputDir: string;
  progress: number;
  busy: boolean;
  status: string;
  sourceLabel: string;
  presentedExport?: PresentedExport;
  mediaAssets: MediaAsset[];
  history: GifResult[];
  queueProgress: number;
  resourceSnapshot: RuntimeResourceSnapshot | null;
  resourceSamplingError: string;
  logicalCpuCount: number;
  queueConcurrencySetting: QueueConcurrencySetting;
  effectiveQueueConcurrency: number;
  activeQueueJobs: number;
  materialLoad: MaterialLoadAssessment;
  taskStatus: PresentedTaskStatus | null;
  taskConcurrency: number;
  estimateFactor: number;
  onPreset: (value: CompressionPresetId) => void;
  onSpeed: (value: number) => void;
  onDeliveryIntent: (value: DeliveryIntent) => void;
  onDeliveryFormatPreference: (value: DeliveryFormatPreference) => void;
  onTargetPlatform: (value: TargetPlatform) => void;
  onEncoder: (value: GifEncoder) => void;
  onGenerationMode: (value: GifGenerationMode) => void;
  onTargetSizeMb: (value: number) => void;
  onVolumeDirectorEnabled: (enabled: boolean) => void;
  onVolumeDirectorPriority: (priority: VolumeDirectorPriority) => void;
  onBayerScale: (value: number) => void;
  onAlphaThreshold: (value: number) => void;
  onBackgroundRemoval: (value: BackgroundRemovalRequest | null) => void;
  onPerceptualFocus: (value: PerceptualFocus) => void;
  onWidth: (value: number) => void;
  onFps: (value: number) => void;
  onColors: (value: number) => void;
  onDither: (value: DitherId) => void;
  onLossy: (value: number) => void;
  onOptimize: (value: number) => void;
  onFilter: (value: FilterStyle) => void;
  onLoop: (value: boolean) => void;
  onChooseOutput: () => void;
  onOpenOutput: () => void;
  onSaveCustom: () => void;
  onGenerateCurrent: () => void;
  onTuneOutput: (direction: OutputTuningDirection) => void;
  onOpenHistory: (path: string) => void;
  onQueueConcurrencySetting: (value: QueueConcurrencySetting) => void;
  onCancelTask: () => void;
  advancedOpen?: boolean;
  onOpenAdvanced?: () => void;
}) {
  const selectedGenerationMode = GENERATION_MODE_OPTIONS.find((option) => option.value === generationMode) ?? GENERATION_MODE_OPTIONS[0];
  const sourceAlphaDetected = sourceHasAlpha === true;
  const effectiveGifEncoder: GifEncoder = sourceAlphaDetected ? "ffmpeg_fast" : encoder;
  const selectedGifEncoder = GIF_ENCODER_OPTIONS.find((option) => option.value === effectiveGifEncoder) ?? GIF_ENCODER_OPTIONS[0];
  const codecProfile = outputCodecProfile(outputFormat, lossy);
  const sourceAlphaMessage = !sourceAlphaDetected
    ? ""
    : codecProfile.alphaMode === "preserve"
      ? "已检测到透明像素，当前格式会保留透明通道。"
      : codecProfile.alphaMode === "reject"
        ? "当前 AVIF 不支持透明素材，请改用 WebP 或 APNG。"
        : "已检测到透明像素：输出时会合成为不透明背景。";
  const ffmpegBackend = backendCapabilities.find((backend) => backend.id === "ffmpeg.animation" || backend.id === "ffmpeg.gif");
  const rustBackend = backendCapabilities.find((backend) => backend.id === "rust.perceptual");
  const ffmpegAvailable = ffmpegBackend?.status.state === "available";
  const rustAvailable = rustBackend?.status.state === "available";
  const rustHasOklab = Boolean(rustBackend?.features?.perceptual_quantization);
  const ditherForced = generationMode !== "best_gif";
  const effectiveDither: DitherId = ditherForced ? "bayer" : dither;
  const bayerScaleActive = effectiveDither === "bayer";
  const selectedPreset = COMPRESSION_PRESETS.find((preset) => preset.id === presetId) ?? COMPRESSION_PRESETS[1];
  const presetSummary = `${selectedPreset.label}${presetAdjusted ? " · 已调整" : ""}`;
  const settingNoun = generationMode === "target_size" ? { width: "最大宽度", fps: "最高帧率", colors: "颜色上限" } : { width: "宽度", fps: "帧率", colors: "颜色上限" };
  const compressionPercent = clamp(Math.round(Math.max(
    lossy * 0.55,
    (1 - Math.min(1, estimateFactor)) * 100,
  )), 0, 90);
  const presentedResult = presentedExport?.result;
  const resultSummary = presentedResult
    ? `${presentedExport?.label ?? formatLabel(resultFormat(presentedResult, "gif"))} · ${sizeText(presentedResult.size_bytes)} · ${presentedResult.output_frame_count || "?"} 帧`
    : presentedExport
      ? `${presentedExport.label} · 预览`
      : "暂无结果";
  const livePhotoBackendState = livePhotoBackend?.status.state ?? "planned";
  const livePhotoBackendReady = livePhotoBackendState === "available"
    && Array.isArray(livePhotoBackend?.formats)
    && livePhotoBackend.formats.includes("live_photo");
  const livePhotoBackendMessage = livePhotoBackendReady
    ? "可以生成 Live Photo。"
    : livePhotoBackendState === "unavailable"
      ? `Live Photo 编码不可用：${livePhotoBackend?.status.state === "unavailable" ? livePhotoBackend.status.reason : "未报告原因"}`
      : livePhotoBackendState === "available"
        ? "Live Photo 组件不完整，请更新 GIFP 运行组件。"
        : "正在检查 Live Photo 组件。";
  const allFormatsSelected = deliveryFormatPreference === "all";
  const deliverySelectionLabel = allFormatsSelected ? "全部格式" : formatLabel(outputFormat);
  const deliveryFormatOptions = [
    { value: "auto" as DeliveryFormatPreference, label: "智能跟随推荐", note: "按交付意图与素材特征自动选择" },
    ...DELIVERY_FORMAT_OPTIONS,
  ];
  const smartOutputSummary = outputFormat === "gif"
    ? `${selectedGenerationMode.label}${generationMode === "target_size" ? ` · ${targetSizeMb.toFixed(1)} MB` : ""}${volumeDirectorActive ? ` · ${volumeDirectorPriority === "balanced" ? "均衡" : volumeDirectorPriority === "clarity" ? "清晰" : volumeDirectorPriority === "motion" ? "流畅" : volumeDirectorPriority === "text" ? "文字" : "最小"}` : ""}`
    : formatLabel(outputFormat);
  const generateActionLabel = allFormatsSelected
    ? `生成全部格式 · ${ALL_DELIVERY_FORMATS.length} 份`
    : outputFormat === "live_photo"
      ? "生成 Live Photo"
      : `生成 ${formatLabel(outputFormat)}`;
  const outputJourneyState = busy ? "working" : presentedExport ? "review" : "ready";
  const outputJourneyStep = outputJourneyState === "ready" ? 0 : outputJourneyState === "working" ? 1 : 2;
  const outputLocationLabel = outputDir.trim() ? basename(outputDir.trim()) || outputDir.trim() : "素材所在文件夹";
  const outputSpecLabel = `${width}px · ${fps} FPS${outputFormat === "gif" ? ` · ${colors} 色` : ""}`;
  const reviewFileLabel = presentedResult?.output_path ? basename(presentedResult.output_path) : presentedExport?.label ?? "成品预览";
  const showProgress = busy || progress > 0 || Boolean(presentedExport);
  const showTaskControl = busy || activeQueueJobs > 0 || Boolean(taskStatus) || materialLoad.tier !== "short";
  return (
    <aside className={`settings-panel paper-panel ${detailed ? "settings-panel--drawer" : "settings-panel--inline"}`}>
      {!detailed && <div className="settings-panel__heading"><OutputDirectoryButton outputDir={outputDir} disabled={busy} onChoose={onChooseOutput} /></div>}

      {!detailed && <>
      <section className={`output-journey state-${outputJourneyState}`} aria-label="输出流程" aria-live="polite">
        <ol className="output-journey__steps" aria-label="输出流程进度">
          {["确认输出", "生成中", "验收成品"].map((label, index) => (
            <li key={label} className={index < outputJourneyStep ? "is-complete" : index === outputJourneyStep ? "is-current" : ""} aria-current={index === outputJourneyStep ? "step" : undefined}>
              <i aria-hidden="true">{index < outputJourneyStep ? <Check weight="bold" /> : index + 1}</i>
              <span>{label}</span>
            </li>
          ))}
        </ol>

        <div className="output-journey__card">
          <header className="output-journey__heading">
            <span className="output-journey__icon" aria-hidden="true">
              {outputJourneyState === "review" ? <CheckCircle weight="fill" /> : outputJourneyState === "working" ? <Sparkle weight="fill" /> : <MagicWand weight="fill" />}
            </span>
            <span>
              <small>{outputJourneyState === "review" ? "DELIVERY RECEIPT" : outputJourneyState === "working" ? "EXPORTING" : "READY TO EXPORT"}</small>
              <strong>{outputJourneyState === "review" ? "成品已准备好" : outputJourneyState === "working" ? `正在生成 ${deliverySelectionLabel}` : "确认这次输出"}</strong>
            </span>
            {outputJourneyState === "working" && <b>{Math.round(progress)}%</b>}
          </header>

          {outputJourneyState === "ready" && <div className="output-journey__summary" aria-label="本次输出摘要">
            <span><small>格式</small><strong>{deliverySelectionLabel}</strong></span>
            <span><small>规格</small><strong>{outputSpecLabel}</strong></span>
            <span><small>策略</small><strong>{smartOutputSummary}</strong></span>
            <span><small>保存到</small><strong title={outputDir || undefined}>{outputLocationLabel}</strong></span>
          </div>}

          {outputJourneyState === "working" && <p className="output-journey__status">{status || "正在准备编码任务"}<small>可以继续查看画面；当前任务会在这里持续反馈。</small></p>}

          {outputJourneyState === "review" && <div className="output-journey__receipt">
            <span><small>成品</small><strong title={reviewFileLabel}>{reviewFileLabel}</strong></span>
            <span><small>实测</small><strong>{presentedResult ? `${sizeText(presentedResult.size_bytes)} · ${presentedResult.output_frame_count || "?"} 帧` : presentedExport?.label}</strong></span>
          </div>}

          <div className="output-journey__actions" aria-label="首屏输出操作">
            {outputJourneyState === "review" && <button type="button" className="output-journey__secondary" onClick={onOpenOutput}><FolderOpen /><span>打开成品位置</span></button>}
            {outputJourneyState === "working" ? (
              <button type="button" className="output-journey__secondary output-journey__stop" onClick={onCancelTask}><X weight="bold" /><span>停止本次生成</span></button>
            ) : (
              <button
                type="button"
                className="generate-button current"
                aria-label={outputJourneyState === "review" ? `${generateActionLabel}（按当前方案重新生成）` : generateActionLabel}
                onClick={onGenerateCurrent}
                disabled={!outputBackendReady}
                title={allFormatsSelected && !livePhotoBackendReady ? livePhotoBackendMessage : !outputBackendReady ? livePhotoBackendMessage : undefined}
              >
                <MagicWand weight="fill" />
                <span>{outputJourneyState === "review" ? "按当前方案再生成" : `确认并${generateActionLabel}`}</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {showProgress && <div className={`output-progress-shell${!busy && presentedExport ? " is-semantically-complete" : ""}`}>
        <EnergyProgress
          progress={progress}
          busy={busy}
          status={status}
          sourceLabel={sourceLabel}
          outputFormat={presentedExport?.format ?? outputFormat}
          resultUrl={presentedExport?.url ?? ""}
          compressionPercent={compressionPercent}
        />
      </div>}

      {showTaskControl && <TaskControlCard load={materialLoad} status={taskStatus} activeJobs={activeQueueJobs} concurrency={taskConcurrency} onCancel={onCancelTask} />}

      <CollapsibleSection title="智能输出" summary={smartOutputSummary} defaultOpen tone="green">
        <div className="setting-field format-choice-field output-format-setting">
          <span className="setting-label">输出格式</span>
          <AnimatedSelect
            ariaLabel="主输出格式"
            value={deliveryFormatPreference}
            compact
            options={deliveryFormatOptions}
            onChange={onDeliveryFormatPreference}
          />
        </div>
        {outputFormat === "gif" ? <>
          {postprocessControl}
          <div className="setting-group generation-mode-setting">
            <div className="setting-field"><span className="setting-label">输出策略</span><IslandRadioGroup ariaLabel="生成方式" value={generationMode} direction="horizontal" compact options={GENERATION_MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label, note: option.description }))} onChange={onGenerationMode} /></div>
            {generationMode === "target_size" && <div className="tight-cap-setting" role="group" aria-label="最大输出体积">
              <span>最大不超过</span>
              <label className="target-size-input">
                <input aria-label="最大输出体积（MB）" type="number" min="0.1" max="512" step="0.1" value={targetSizeMb} onChange={(event) => onTargetSizeMb(clamp(Number(event.currentTarget.value), 0.1, 512))} />
                <b>MB</b>
              </label>
              <small>{targetOutcome ? `${targetOutcome.label} · 最大 ${sizeText(targetOutcome.targetBytes)}${targetOutcome.actualBytes == null ? "" : ` · 实际 ${sizeText(targetOutcome.actualBytes)}`}` : `最大文件大小为 ${targetSizeMb.toFixed(1)} MB；如无法满足，将提供更小规格建议。`}</small>
            </div>}
          </div>
          {generationMode === "target_size" && <VolumeDirectorControl
            enabled={volumeDirectorEnabled}
            active={volumeDirectorActive}
            priority={volumeDirectorPriority}
            plan={volumeDirectorPlan}
            targetSizeMb={targetSizeMb}
            onEnabled={onVolumeDirectorEnabled}
            onPriority={onVolumeDirectorPriority}
          />}
        </> : <div className={`setting-group modern-codec-summary alpha-${codecProfile.alphaMode}${sourceAlphaDetected ? " source-alpha" : ""}`}>
          <span className="codec-summary-label">编码算法 · {formatLabel(outputFormat)}</span>
          <strong>{codecProfile.algorithm}</strong>
          <span>{codecProfile.detail}</span>
          <b>{codecProfile.alphaLabel}</b>
          {sourceAlphaMessage && <p role={codecProfile.alphaMode === "reject" ? "alert" : "status"}>{sourceAlphaMessage}</p>}
        </div>}
        {!volumeDirectorActive && <div className="effective-settings" aria-label="当前输出参数"><span>当前方案</span><strong>{width}px · {fps} FPS{outputFormat === "gif" ? ` · ${colors} 色` : ""}</strong></div>}
        {memeOverlayActive && <div className="meme-overlay-linked"><Smiley weight="fill" /><span><strong>文字标注已应用</strong><small>导出时优先保持文字边缘</small></span></div>}
      </CollapsibleSection>

      <CollapsibleSection title="画面与节奏" summary={`${playbackSpeed.toFixed(2).replace(/\.00$/, "")}×`} tone="aqua">
        <PlaybackSpeedControl value={playbackSpeed} onChange={onSpeed} />
      </CollapsibleSection>

      {showCutout && <CollapsibleSection title="抠图" summary={backgroundRemoval?.mode === "color_key" ? "色键背景 · 已启用" : sourceAlphaDetected ? "素材 Alpha · 自动保留" : "关闭"} tone="aqua">
        <CutoutControl
          value={backgroundRemoval}
          sourceHasAlpha={sourceHasAlpha}
          outputFormat={outputFormat}
          allFormatsSelected={allFormatsSelected}
          onChange={onBackgroundRemoval}
        />
      </CollapsibleSection>}

      <button type="button" className="advanced-drawer-button" aria-expanded={Boolean(advancedOpen)} onClick={onOpenAdvanced}><SlidersHorizontal weight="fill" /><span><strong>手动覆盖</strong><small>尺寸、编码、滤镜与队列</small></span><b>打开 →</b></button>

      {(presentedResult || presentedExport) && <CollapsibleSection title="结果" summary={resultSummary} openSignal={presentedResult?.output_path || presentedExport?.url || ""} tone="green">
        {presentedResult ? <div className="compact-result-card" key={presentedResult.output_path}>
          <div><CheckCircle weight="fill" /><span><strong>已生成</strong><small>{sizeText(presentedResult.size_bytes)} · {presentedResult.output_frame_count || "?"} 帧</small></span></div>
          {presentedResult.quality_report?.status === "measured" && presentedResult.quality_report.vmaf_mean != null && presentedResult.quality_report.ssim_mean != null && <div className="quality-stamp-row" role="group" aria-label="质量评分">
            <QualityStamp metric="VMAF" value={presentedResult.quality_report.vmaf_mean} grade={vmafGrade(presentedResult.quality_report.vmaf_mean)} detail={`P05 ${presentedResult.quality_report.vmaf_p05?.toFixed(1) ?? "—"}`} />
            <QualityStamp metric="SSIM" value={presentedResult.quality_report.ssim_mean} grade={ssimGrade(presentedResult.quality_report.ssim_mean)} detail={presentedResult.quality_report.ms_ssim_mean == null ? "画面一致性" : `MS ${presentedResult.quality_report.ms_ssim_mean.toFixed(3)}`} digits={3} />
          </div>}
          <button type="button" onClick={() => onOpenHistory(presentedResult.output_path)}><FolderOpen />打开位置</button>
        </div> : <small className="empty-section-copy">{presentedExport ? `${presentedExport.label} 已生成。` : ""}</small>}
      </CollapsibleSection>}
      </>}

      {detailed && <>
      <CollapsibleSection title="基础预设" summary={presetSummary} tone="aqua">
        <div className="setting-group preset-group">
          <label className="setting-label">基础预设</label>
          <CompressionPresetSelect value={presetId} onChange={onPreset} />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="编码覆盖" summary={`${settingNoun.width} ${width}px · ${settingNoun.fps} ${fps} · ${outputFormat === "gif" ? selectedGifEncoder.label : codecProfile.algorithm}${presetAdjusted ? " · 已覆盖智能方案" : ""}`} defaultOpen tone="yellow">
        <div className="advanced-settings full-advanced-settings">
          <p className="setting-relation-note">仅在需要固定技术参数时修改；这些值会覆盖智能方案。</p>
          <label>{settingNoun.width}（96–1920）<CommittedNumberInput ariaLabel="宽度" value={width} min={96} max={1920} onCommit={onWidth} /></label>
          <label>{settingNoun.fps}（1–60）<input aria-label="帧率" type="number" min={1} max={60} value={fps} onChange={(event) => onFps(clamp(Number(event.target.value) || 1, 1, 60))} /></label>
          <div className="setting-field inline"><span>滤镜</span><AnimatedSelect ariaLabel="滤镜" value={filter} compact options={FILTER_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} onChange={onFilter} /></div>
          {outputFormat !== "gif" && <div className={`drawer-codec-summary alpha-${codecProfile.alphaMode}${sourceAlphaDetected ? " source-alpha" : ""}`}>
            <span>编码算法</span><strong>{codecProfile.algorithm}</strong><small>{codecProfile.alphaLabel}</small>
          </div>}
          {outputFormat === "gif" ? <fieldset className="format-specific gif-specific"><legend>GIF 颜色与压缩</legend>
            <div className="setting-field drawer-encoder-control"><span>编码算法</span><AnimatedSelect ariaLabel="高级编码算法" value={effectiveGifEncoder} compact disabled={sourceAlphaDetected} options={GIF_ENCODER_OPTIONS} onChange={onEncoder} /></div>
            {sourceAlphaDetected && <p className="alpha-lock-note">已保留透明通道，编码选项已自动适配。</p>}
            <label>{settingNoun.colors}（3–256）<input aria-label="颜色上限" type="number" min={3} max={256} value={colors} onChange={(event) => onColors(clamp(Number(event.target.value) || 3, 3, 256))} /></label>
            <label>预处理强度（0–100）<input aria-label="预处理强度" type="number" min={0} max={100} value={lossy} onChange={(event) => onLossy(clamp(Number(event.target.value) || 0, 0, 100))} /></label>
            <div className="setting-field inline"><span>抖动</span><AnimatedSelect ariaLabel="抖动" value={effectiveDither} compact disabled={ditherForced} options={DITHER_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} onChange={onDither} /></div>
            <label>Bayer 尺度（0 强–5 弱）<input aria-label="Bayer 尺度" type="number" min={0} max={5} value={bayerScale} disabled={!bayerScaleActive} onChange={(event) => onBayerScale(clamp(Math.round(Number(event.target.value) || 0), 0, 5))} /></label>
            <label>Alpha 阈值（0–255）<input aria-label="Alpha 阈值" type="number" min={0} max={255} value={alphaThreshold} onChange={(event) => onAlphaThreshold(clamp(Math.round(Number(event.target.value) || 0), 0, 255))} /></label>
            <div className="setting-field inline"><span>优化级别</span><AnimatedSelect ariaLabel="优化级别" value={optimizeLevel} compact options={[{ value: 1, label: "1 · 快速" }, { value: 2, label: "2 · 标准" }, { value: 3, label: "3 · 深度" }, { value: 4, label: "4 · 最深" }]} onChange={onOptimize} /></div>
            <p>{ditherForced ? "快速 GIF 与精确体积使用 Bayer；Bayer 尺度仍可调整。" : bayerScaleActive ? "当前启用 Bayer 尺度。" : "当前抖动不是 Bayer，尺度参数不生效。"}</p>
          </fieldset> : outputFormat === "live_photo" ? <fieldset className="format-specific live-photo-specific"><legend>Live Photo</legend><label>MOV 压缩强度（0 高质量–100 更小）<input aria-label="实况照片 MOV 压缩强度" type="number" min={0} max={100} value={lossy} onChange={(event) => onLossy(clamp(Number(event.target.value) || 0, 0, 100))} /></label><p>生成封面照片和动态视频，并保持两者配对。</p></fieldset> : <fieldset className="format-specific modern-specific">
            <legend>{formatLabel(outputFormat)} 质量与压缩</legend>
            <label>{outputFormat === "webp" ? "压缩强度（0 无损；1–100 有损）" : "压缩强度（0 高质量–100 更小）"}<input aria-label="现代格式压缩强度" type="number" min={0} max={100} value={lossy} onChange={(event) => onLossy(clamp(Number(event.target.value) || 0, 0, 100))} /></label>
            {outputFormat === "webp" && <div className="setting-field inline"><span>WebP 优化级别</span><AnimatedSelect ariaLabel="WebP 优化级别" value={optimizeLevel} compact options={[{ value: 1, label: "1 · 快速" }, { value: 2, label: "2 · 标准" }, { value: 3, label: "3 · 深度" }, { value: 4, label: "4 · 最深" }]} onChange={onOptimize} /></div>}
            <p>{outputFormat === "apng" ? "APNG 为无损格式。" : outputFormat === "avif" ? "当前透明素材请改用 WebP 或 APNG。" : outputFormat === "webp" ? "0 为无损；数值越高，文件通常越小。优化级别越高，生成时间越长。" : "数值越低越清晰，文件通常越大。"}</p>
          </fieldset>}
          {presetAdjusted && <button type="button" className="reset-smart-overrides" onClick={() => onPreset("perceptual")}><ArrowsClockwise />恢复智能参数</button>}
          <button type="button" className="save-custom" onClick={onSaveCustom}><FloppyDisk />保存为自定义参数</button>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="交付与文件" summary={deliverySelectionLabel} tone="aqua">
        <div className="setting-field delivery-intent-setting">
          <span className="setting-label">交付意图</span>
          <IslandRadioGroup
            ariaLabel="交付意图"
            value={deliveryIntent}
            options={DELIVERY_INTENT_OPTIONS}
            compact
            onChange={onDeliveryIntent}
          />
        </div>
        {deliveryIntent === "target_platform" && (
          <div className="setting-field inline">
            <span>目标平台</span>
            <AnimatedSelect
              ariaLabel="目标平台"
              value={targetPlatform}
              compact
              options={TARGET_PLATFORM_OPTIONS}
              onChange={onTargetPlatform}
            />
          </div>
        )}
        <div className="setting-field inline">
          <span>内容重点</span>
          <AnimatedSelect
            ariaLabel="内容重点"
            value={perceptualFocus}
            compact
            disabled={memeOverlayActive}
            options={PERCEPTUAL_FOCUS_OPTIONS}
            onChange={onPerceptualFocus}
          />
        </div>
        {outputFormat === "live_photo" && (
          <div className={`live-photo-backend-status ${livePhotoBackendReady ? "available" : "missing"}`} role="status">
            <strong>Live Photo 直接生成：{livePhotoBackendReady ? "可用" : livePhotoBackendState === "unavailable" ? "不可用" : livePhotoBackendState === "available" ? "运行时能力不完整" : "检测中"}</strong>
            <span>{livePhotoBackendMessage}</span>
          </div>
        )}
        <label className="switch-row setting-row"><span>循环播放</span><input aria-label="循环播放" type="checkbox" checked={outputFormat === "live_photo" ? false : loopOutput} disabled={outputFormat === "live_photo"} onChange={(event) => onLoop(event.target.checked)} /><b>{outputFormat === "live_photo" ? "单次播放" : loopOutput ? "开启" : "关闭"}</b></label>
      </CollapsibleSection>

      <CollapsibleSection
        title="性能"
        summary={`${busy || activeQueueJobs > 0 ? "任务运行中" : "队列空闲"} · ${queueConcurrencySetting === "auto" ? `自动 ${effectiveQueueConcurrency}` : `${effectiveQueueConcurrency} 路`}`}
        openSignal={busy || activeQueueJobs > 0}
        tone="aqua"
      >
        <ResourceMonitor
          snapshot={resourceSnapshot}
          samplingError={resourceSamplingError}
          logicalCpuCount={logicalCpuCount}
          concurrencySetting={queueConcurrencySetting}
          effectiveConcurrency={effectiveQueueConcurrency}
          activeQueueJobs={activeQueueJobs}
          onConcurrencySetting={onQueueConcurrencySetting}
        />
      </CollapsibleSection>

      <CollapsibleSection title="任务与历史" summary={`${mediaAssets.length} 项 · 队列 ${queueProgress}%`} defaultOpen={false} tone="coral">
        <section className="side-section queue-summary">
          <div><strong>当前队列</strong><span>{queueProgress}%</span></div>
          {mediaAssets.length ? mediaAssets.map((asset) => <p key={asset.id} title={asset.error || asset.result?.output_path || asset.path}><span>{asset.name}</span><b className={`status-${asset.status}`}>{asset.status}</b></p>) : <small>暂无可转换素材</small>}
        </section>
        <section className="side-section recent-exports">
          <strong>最近导出</strong>
          {history.length ? history.slice(0, HISTORY_VISIBLE_LIMIT).map((item) => <button type="button" key={item.output_path} onClick={() => onOpenHistory(item.output_path)}><span>{basename(item.output_path)}</span><b>{sizeText(item.size_bytes)}</b></button>) : <small>还没有导出</small>}
        </section>
      </CollapsibleSection>

      {presentedResult && <CollapsibleSection title="编码报告" summary={resultSummary} tone="green">
        <OutputConfidenceCard
          result={presentedResult}
          format={presentedExport?.format}
          label={presentedExport?.label}
          busy={busy}
          onTune={onTuneOutput}
          onRegenerate={onGenerateCurrent}
        />
        <ResultReport result={presentedResult} format={presentedExport?.format} onOpenResource={onOpenHistory} />
        <div className="backend-status" aria-label="编码后端状态">
          <span className={ffmpegAvailable ? "available" : "missing"}>转换引擎：{ffmpegAvailable ? "可用" : "未发现"}</span>
          <span className={rustAvailable ? "available" : "missing"}>感知优化：{rustAvailable ? (rustHasOklab ? "可用" : "基础模式") : "未启用"}</span>
          <span className={livePhotoBackendReady ? "available" : "missing"}>Live Photo：{livePhotoBackendReady ? "可用" : livePhotoBackendState === "available" ? "组件不完整" : "尚未就绪"}</span>
        </div>
      </CollapsibleSection>}
      </>}
    </aside>
  );
}

function ResourceMonitor({
  snapshot,
  samplingError,
  logicalCpuCount,
  concurrencySetting,
  effectiveConcurrency,
  activeQueueJobs,
  onConcurrencySetting,
}: {
  snapshot: RuntimeResourceSnapshot | null;
  samplingError: string;
  logicalCpuCount: number;
  concurrencySetting: QueueConcurrencySetting;
  effectiveConcurrency: number;
  activeQueueJobs: number;
  onConcurrencySetting: (value: QueueConcurrencySetting) => void;
}) {
  const cpuPercent = clamp(Math.round(snapshot?.cpu_usage_percent ?? 0), 0, 100);
  const gpu = snapshot?.gpus.length
    ? snapshot.gpus.reduce((peak, current) => current.usage_percent > peak.usage_percent ? current : peak)
    : undefined;
  const gpuPercent = clamp(Math.round(gpu?.usage_percent ?? 0), 0, 100);
  const encoderSamples = snapshot?.gpus
    .map((item) => item.encoder_usage_percent)
    .filter((value): value is number => typeof value === "number") ?? [];
  const encoderPercent = encoderSamples.length ? Math.round(Math.max(...encoderSamples)) : null;
  const memoryPercent = snapshot?.total_memory_bytes
    ? clamp(Math.round((snapshot.used_memory_bytes / snapshot.total_memory_bytes) * 100), 0, 100)
    : null;
  const activeJobs = Math.max(activeQueueJobs, snapshot?.active_conversion_jobs ?? 0);
  const gpuReason = snapshot?.gpu_unavailable_reason
    || (!snapshot ? "等待桌面运行时返回真实 GPU 采样。" : "GPU 采样暂不可用。");
  const sampleNote = samplingError
    ? `资源采样中断：${samplingError}`
    : gpu
      ? `${gpu.name}${snapshot && snapshot.gpus.length > 1 ? ` · 共 ${snapshot.gpus.length} 块 GPU，显示峰值` : ""}`
      : gpuReason;

  return (
    <section className="resource-monitor resource-monitor--embedded" aria-label="资源与并行">
      <div className="resource-monitor__heading">
        <span><Monitor weight="fill" /><strong>资源与并行</strong></span>
        <b className={activeJobs > 0 ? "running" : "idle"}>队列 {activeJobs}/{effectiveConcurrency}</b>
      </div>
      <div className="resource-monitor__meter-row">
        <span>CPU</span>
        <div
          className="resource-monitor__meter cpu"
          role="meter"
          aria-label="CPU 总占用"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={snapshot ? cpuPercent : undefined}
        ><i style={{ width: `${cpuPercent}%` }} /></div>
        <strong>{snapshot ? `${cpuPercent}%` : "待采样"}</strong>
      </div>
      <div className="resource-monitor__meter-row">
        <span>GPU</span>
        <div
          className={`resource-monitor__meter gpu${gpu ? "" : " unavailable"}`}
          role="meter"
          aria-label="GPU 总占用"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={gpu ? gpuPercent : undefined}
        ><i style={{ width: `${gpuPercent}%` }} /></div>
        <strong>{gpu ? `${gpuPercent}%${encoderPercent === null ? "" : ` · 编码 ${encoderPercent}%`}` : "不可用"}</strong>
      </div>
      <div className="resource-monitor__controls">
        <label>
          <span>并行任务</span>
          <input
            type="range"
            aria-label="并行任务数"
            min={1}
            max={8}
            step={1}
            value={effectiveConcurrency}
            disabled={activeJobs > 0}
            onChange={(event) => onConcurrencySetting(event.target.value as QueueConcurrencySetting)}
          />
          <b>{concurrencySetting === "auto" ? `自动 ${effectiveConcurrency}` : `${effectiveConcurrency} 路`}</b>
          <button
            type="button"
            aria-label="使用自动并发"
            aria-pressed={concurrencySetting === "auto"}
            disabled={activeJobs > 0}
            onClick={() => onConcurrencySetting("auto")}
          >自动</button>
        </label>
        <span>{logicalCpuCount} 逻辑线程 · FFmpeg 单任务自动多线程{memoryPercent === null ? "" : ` · 内存 ${memoryPercent}%`}</span>
      </div>
      <small className={gpu ? "resource-monitor__device" : "resource-monitor__device unavailable"} title={sampleNote}>{sampleNote}</small>
    </section>
  );
}

function MergeWorkspace({ assets, imageSeconds, outputDir, width, fps, colors, busy, status, onAdd, onMove, onRemove, onImageSeconds, onOutput, onWidth, onFps, onColors, onRun }: {
  assets: MediaAsset[];
  imageSeconds: number;
  outputDir: string;
  width: number;
  fps: number;
  colors: number;
  busy: boolean;
  status: string;
  onAdd: () => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (path: string) => void;
  onImageSeconds: (value: number) => void;
  onOutput: () => void;
  onWidth: (value: number) => void;
  onFps: (value: number) => void;
  onColors: (value: number) => void;
  onRun: () => void;
}) {
  return (
    <section className="feature-workspace paper-panel merge-workspace">
      <div className="feature-hero"><span className="feature-icon"><Stack /></span><div><p>GIFP MERGE</p><h1>合并制作</h1><span>支持 GIF、PNG、JPG、WebP；顺序和图片停留时间都可调整。</span></div></div>
      <div className="merge-grid">
        <div className="merge-list-panel soft-card">
          <div className="feature-assets">
            {assets.map((asset, index) => (
              <div className="merge-item" key={asset.path}>
                <b>{index + 1}</b><MediaThumbnail asset={asset} /><span><strong>{asset.name}</strong><small>{mediaLabel(asset)}</small></span>
                <div><button type="button" aria-label={`上移 ${asset.name}`} onClick={() => onMove(index, -1)} disabled={index === 0}><ArrowUp /></button><button type="button" aria-label={`下移 ${asset.name}`} onClick={() => onMove(index, 1)} disabled={index === assets.length - 1}><ArrowDown /></button><button type="button" aria-label={`移除 ${asset.name}`} onClick={() => onRemove(asset.path)}><Trash /></button></div>
              </div>
            ))}
            <button type="button" className="soft-card add-card" onClick={onAdd}><Plus /><span>添加 GIF 或图片</span></button>
          </div>
        </div>
        <div className="merge-settings soft-card">
          <label>静态图片停留<input type="number" min={0.2} max={10} step={0.1} value={imageSeconds} onChange={(event) => onImageSeconds(clamp(Number(event.target.value) || 1.2, 0.2, 10))} /><span>秒</span></label>
          <label>输出宽度<input type="number" min={96} max={1920} value={width} onChange={(event) => onWidth(clamp(Number(event.target.value) || 96, 96, 1920))} /></label>
          <label>帧率<input type="number" min={1} max={60} value={fps} onChange={(event) => onFps(clamp(Number(event.target.value) || 1, 1, 60))} /></label>
          <label>颜色数（3–256）<input aria-label="合并颜色数" type="number" min={3} max={256} value={colors} onChange={(event) => onColors(clamp(Number(event.target.value) || 3, 3, 256))} /></label>
          <button type="button" className="merge-output" onClick={onOutput}><FolderOpen /><span>{outputDir || "选择输出目录"}</span></button>
          <button type="button" className="primary-action" onClick={onRun} disabled={busy || assets.length < 2}><MagicWand />合并所选素材</button>
          <p className="feature-status">{status}</p>
        </div>
      </div>
    </section>
  );
}

function RecordWorkspace({ recording, operation, regionPicking, region, fps, backend, outputDir, status, onRegion, onFps, onBackend, onPickRegion, onOutput, onToggle }: {
  recording: boolean;
  operation: RecordOperation;
  regionPicking: boolean;
  region: { enabled: boolean; x: number; y: number; width: number; height: number; screen_x: number; screen_y: number; screen_width: number; screen_height: number };
  fps: number;
  backend: RecordBackend;
  outputDir: string;
  status: string;
  onRegion: (region: { enabled: boolean; x: number; y: number; width: number; height: number; screen_x: number; screen_y: number; screen_width: number; screen_height: number }) => void;
  onFps: (fps: number) => void;
  onBackend: (backend: RecordBackend) => void;
  onPickRegion: () => void;
  onOutput: () => void;
  onToggle: () => void;
}) {
  const countdownStart = import.meta.env.MODE === "test" ? 0 : 3;
  const [countdown, setCountdown] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const setRegionField = (field: "x" | "y" | "width" | "height", value: number) => onRegion({ ...region, [field]: value });
  const locked = recording || operation !== "idle" || regionPicking || countdown !== null;
  const areaLabel = region.enabled ? `${region.width} × ${region.height}` : "整个桌面";
  const screenWidth = Math.max(1, region.screen_width || region.x + region.width);
  const screenHeight = Math.max(1, region.screen_height || region.y + region.height);
  const previewLeft = clamp(((region.x - region.screen_x) / screenWidth) * 100, 0, 100);
  const previewTop = clamp(((region.y - region.screen_y) / screenHeight) * 100, 0, 100);
  const previewWidth = clamp((region.width / screenWidth) * 100, 2, 100 - previewLeft);
  const previewHeight = clamp((region.height / screenHeight) * 100, 2, 100 - previewTop);
  const durationLabel = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

  useEffect(() => {
    if (countdown === null) return undefined;
    if (countdown <= 0) {
      setCountdown(null);
      onToggle();
      return undefined;
    }
    const timer = window.setTimeout(() => setCountdown((value) => value == null ? null : value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, onToggle]);

  useEffect(() => {
    if (!recording) {
      setElapsedSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (countdown === null) return undefined;
    const cancelCountdown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCountdown(null);
    };
    window.addEventListener("keydown", cancelCountdown);
    return () => window.removeEventListener("keydown", cancelCountdown);
  }, [countdown]);

  const requestToggle = () => {
    if (recording) {
      onToggle();
      return;
    }
    if (countdownStart === 0) onToggle();
    else setCountdown(countdownStart);
  };

  return (
    <section className="feature-workspace paper-panel record-workspace">
      <div className="feature-hero record-hero">
        <span className="feature-icon"><Monitor /></span>
        <div><p>GIFP CAPTURE</p><h1>屏幕录制</h1><span>选好范围即可开始；停止后自动进入精细编辑。</span></div>
        <ol className="record-flow" aria-label="录制流程"><li><b>1</b>选择范围</li><li><b>2</b>开始录制</li><li><b>3</b>自动编辑</li></ol>
      </div>
      <div className="record-layout">
        <div className="record-card soft-card">
          <div className="record-section-heading"><span><b>1</b><strong>录制范围</strong></span><small>开始后可随时停止</small></div>
          <div className="record-mode-row">
            <button type="button" className={!region.enabled ? "selected" : ""} aria-pressed={!region.enabled} disabled={locked} onClick={() => onRegion({ ...region, enabled: false })}><Monitor /><span><strong>整个桌面</strong><small>适合完整演示</small></span></button>
            <button type="button" className={region.enabled ? "selected" : ""} aria-pressed={region.enabled} disabled={locked} onClick={() => onRegion({ ...region, enabled: true })}><Crop /><span><strong>指定区域</strong><small>只录需要的内容</small></span></button>
          </div>
          {region.enabled && <div className="record-region-panel">
            <div className="record-region-preview" aria-label={`当前录制范围 ${region.width} × ${region.height}，X ${region.x}，Y ${region.y}`}>
              <span className="record-region-preview__screen" aria-hidden="true"><i style={{ left: `${previewLeft}%`, top: `${previewTop}%`, width: `${previewWidth}%`, height: `${previewHeight}%` }} /></span>
              <span><strong>当前范围</strong><small>{region.width} × {region.height} · X {region.x} · Y {region.y}</small></span>
            </div>
            <button type="button" className="pick-region" aria-busy={regionPicking} disabled={locked} onClick={onPickRegion}>
              {regionPicking ? <ArrowsClockwise className="record-region-spinner" /> : <Crop />}
              {regionPicking ? "正在准备选区…" : "拖拽框选录制区域"}
            </button>
            {regionPicking && (
              <div className="record-region-preparing" role="status" aria-live="polite" aria-atomic="true">
                <span><strong>正在准备屏幕画面</strong><small>选区界面即将打开，请稍候</small></span>
                <span className="record-region-progress" role="progressbar" aria-label="正在准备区域选择" aria-valuetext="正在读取桌面画面"><i /></span>
              </div>
            )}
            <div className="record-region-grid">
              <label>X<input type="number" min={0} value={region.x} disabled={locked} onChange={(event) => setRegionField("x", Math.max(0, Number(event.target.value) || 0))} /></label>
              <label>Y<input type="number" min={0} value={region.y} disabled={locked} onChange={(event) => setRegionField("y", Math.max(0, Number(event.target.value) || 0))} /></label>
              <label>宽<input type="number" min={120} value={region.width} disabled={locked} onChange={(event) => setRegionField("width", Math.max(120, Number(event.target.value) || 720))} /></label>
              <label>高<input type="number" min={120} value={region.height} disabled={locked} onChange={(event) => setRegionField("height", Math.max(120, Number(event.target.value) || 480))} /></label>
            </div>
          </div>}
          <div className="record-section-heading compact"><span><b>2</b><strong>流畅度</strong></span><small>15 FPS 适合大多数教程</small></div>
          <div className="record-fps-row" role="group" aria-label="录制帧率">
            {[15, 24, 30].map((value) => <button type="button" key={value} className={fps === value ? "selected" : ""} aria-label={`${value} FPS`} aria-pressed={fps === value} disabled={locked} onClick={() => onFps(value)}><strong>{value}</strong><small>FPS</small></button>)}
            <label><span>自定义</span><input aria-label="自定义录制帧率" type="number" min={5} max={30} value={fps} disabled={locked} onChange={(event) => onFps(clamp(Number(event.target.value) || 15, 5, 30))} /></label>
          </div>
          <div className="record-destination"><span><FolderOpen /><span><small>保存到</small><strong>{outputDir || "默认录屏目录"}</strong></span></span><button type="button" disabled={locked} onClick={onOutput}>更改</button></div>
          <details className="record-advanced">
            <summary>高级录制方式 <small>通常无需调整</small></summary>
            <div className="record-setting">
              <span>录制方式</span>
              <AnimatedSelect ariaLabel="录制方式" value={backend} compact disabled={locked} options={[
                { value: "psgrab", label: "截图序列模式", note: "稳定" },
                { value: "gdigrab", label: "兼容模式" },
                { value: "ddagrab", label: "显卡模式" },
              ]} onChange={onBackend} />
            </div>
          </details>
        </div>
        <div className={`record-action-card soft-card${recording ? " is-recording" : ""}${countdown !== null ? " is-countdown" : ""}`}>
          <span className="record-state-chip" aria-live="polite" aria-atomic="true"><i />{operation === "stopping" ? "正在保存" : operation === "starting" ? "正在启动" : recording ? "录制中" : countdown !== null ? "即将开始" : "准备就绪"}</span>
          <span className={recording ? "record-orb recording" : countdown !== null ? "record-orb countdown" : "record-orb"}>{countdown !== null ? <b>{countdown}</b> : <VideoCamera />}</span>
          <strong aria-live={countdown !== null ? "assertive" : "off"}>{operation === "stopping" ? "正在保存录制" : operation === "starting" ? "正在启动录制" : recording ? durationLabel : countdown !== null ? `${countdown} 秒后开始` : "一切准备就绪"}</strong>
          <p>{areaLabel} · {fps} FPS{recording ? " · 正在写入文件" : ""}</p>
          <dl className="record-ready-summary"><div><dt>范围</dt><dd>{areaLabel}</dd></div><div><dt>帧率</dt><dd>{fps} FPS</dd></div><div><dt>完成后</dt><dd>进入精细编辑</dd></div></dl>
          {countdown !== null ? (
            <button type="button" className="record-cancel" onClick={() => setCountdown(null)}><X />取消倒计时 <kbd>Esc</kbd></button>
          ) : operation !== "idle" ? (
            <button type="button" className="record-primary" disabled><ArrowsClockwise />{operation === "stopping" ? "正在保存录制…" : "正在启动录制…"}</button>
          ) : (
            <button type="button" className={recording ? "danger-action record-primary" : "primary-action record-primary"} onClick={requestToggle}>{recording ? <Pause /> : <VideoCamera />}{recording ? "停止录制并进入编辑" : "开始录制 · 3 秒倒计时"}</button>
          )}
          <small className={`record-status-copy${recording && status.startsWith("录制内容已安全保留") ? " retained" : ""}`}>
            {recording && !status.startsWith("录制内容已安全保留") ? "正在录制，请先停止后再调整设置" : status}
          </small>
        </div>
      </div>
    </section>
  );
}

function FrameDrawer({
  frames,
  totalFrames,
  page,
  pageSize,
  loading,
  error,
  selected,
  deleted,
  frameTimingMode,
  isFrameSelected,
  isFrameDeleted,
  onSelect,
  onSelectRange,
  onPage,
  onTimingMode,
  onManualSample,
  onDelete,
  onRestore,
  onSelectAll,
  onClearSelection,
  onUndo,
  canUndo,
  onClear,
  onClose,
}: {
  frames: ExactFrameThumb[];
  totalFrames: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string;
  selected: number[];
  deleted: number[];
  frameTimingMode: FrameTimingMode;
  isFrameSelected: (time: number) => boolean;
  isFrameDeleted: (time: number) => boolean;
  onSelect: (frame: ExactFrameThumb) => void;
  onSelectRange: (firstIndex: number, lastIndex: number) => void;
  onPage: (page: number) => void;
  onTimingMode: (mode: FrameTimingMode) => void;
  onManualSample: (keepEvery: number, preserveDuration: boolean) => void;
  onDelete: () => void;
  onRestore: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onUndo: () => void;
  canUndo: boolean;
  onClear: () => void;
  onClose: () => void;
}) {
  const pageCount = Math.max(1, Math.ceil(totalFrames / pageSize));
  const safePage = clamp(page, 0, pageCount - 1);
  const pageStart = totalFrames ? safePage * pageSize + 1 : 0;
  const pageEnd = Math.min(totalFrames, (safePage + 1) * pageSize);
  const selectedDeletedCount = selected.filter(isFrameDeleted).length;
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [keepEvery, setKeepEvery] = useState(2);
  const [preserveSamplingDuration, setPreserveSamplingDuration] = useState(frameTimingMode === "preserve");

  useEffect(() => {
    setPreserveSamplingDuration(frameTimingMode === "preserve");
  }, [frameTimingMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editingField = target?.matches("input, textarea, select, [contenteditable='true']");
      if (event.key === "Escape") onClose();
      if (!editingField && event.key === "Delete" && selected.length) {
        event.preventDefault();
        onDelete();
      }
      if (!editingField && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        onSelectAll();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onDelete, onSelectAll, selected.length]);

  function selectFrame(event: React.MouseEvent<HTMLButtonElement>, frame: ExactFrameThumb) {
    if (event.shiftKey && anchorIndex != null) onSelectRange(anchorIndex, frame.index);
    else onSelect(frame);
    setAnchorIndex(frame.index);
  }

  return (
    <div className="frame-drawer-backdrop" role="presentation">
      <section className="frame-drawer paper-panel" role="dialog" aria-modal="true" aria-labelledby="frame-drawer-title">
        <div className="frame-drawer-head">
          <div>
            <span className="frame-drawer-eyebrow">EXACT FRAME EDITOR</span>
            <h2 id="frame-drawer-title">逐帧编辑</h2>
            <p>这里展示真实输出帧。点击单选，Shift 点击连续选择，Delete 删除。</p>
          </div>
          <button type="button" aria-label="关闭逐帧编辑面板" onClick={onClose}><X /></button>
        </div>

        <div className="frame-timing-panel" aria-label="删帧后的时间处理">
          <div><strong>删除后时间</strong><small>决定删掉画面后，成品如何播放</small></div>
          <div className="frame-timing-toggle">
            <button type="button" className={frameTimingMode === "compact" ? "selected" : ""} aria-pressed={frameTimingMode === "compact"} onClick={() => onTimingMode("compact")}><strong>收紧时间线</strong><small>后续帧前移，时长变短</small></button>
            <button type="button" className={frameTimingMode === "preserve" ? "selected" : ""} aria-pressed={frameTimingMode === "preserve"} onClick={() => onTimingMode("preserve")}><strong>保持总时长</strong><small>相邻画面停留补齐</small></button>
          </div>
        </div>

        <div className="frame-drawer-toolbar" aria-label="帧选择工具">
          <span><strong>{totalFrames}</strong> 帧</span>
          <button type="button" onClick={onSelectAll} disabled={!totalFrames || selected.length === totalFrames}>全选</button>
          <button type="button" onClick={onClearSelection} disabled={!selected.length}>取消选择</button>
          <button type="button" onClick={onClear} disabled={!deleted.length}>恢复全部</button>
          <small>{pageStart}–{pageEnd} / {totalFrames}</small>
        </div>

        <div className="frame-grid" aria-busy={loading}>
          {loading && <div className="frame-grid-state"><FilmStrip /><strong>正在读取第 {safePage + 1} 页真实帧…</strong></div>}
          {!loading && error && <div className="frame-grid-state error"><WarningCircle /><strong>逐帧缩略图暂不可用</strong><small>{error}</small></div>}
          {!loading && !error && !frames.length && <div className="frame-grid-state"><FilmStrip /><strong>当前范围没有可编辑帧</strong></div>}
          {!loading && !error && frames.map((frame) => {
            const removed = isFrameDeleted(frame.time);
            const frameSelected = isFrameSelected(frame.time);
            return (
              <button
                type="button"
                key={frame.index}
                className={`${frameSelected ? "selected" : ""}${removed ? " removed" : ""}`}
                aria-label={`第 ${frame.index + 1} 帧，${frame.time.toFixed(3)} 秒${removed ? "，已删除" : ""}`}
                aria-pressed={frameSelected}
                onClick={(event) => selectFrame(event, frame)}
              >
                <img src={frame.url} alt="" />
                <span className="frame-grid__time">{frame.time.toFixed(3)}s</span>
                <span className="frame-grid__index">#{frame.index + 1}</span>
                {frameSelected && <i className="frame-grid__selection"><CheckCircle weight="fill" /></i>}
                {removed && <b>已移除</b>}
              </button>
            );
          })}
        </div>

        <div className="frame-drawer-pagination" aria-label="逐帧分页">
          <button type="button" onClick={() => onPage(0)} disabled={safePage === 0}>首页</button>
          <button type="button" onClick={() => onPage(safePage - 1)} disabled={safePage === 0}>← 上一页</button>
          <span>第 <strong>{safePage + 1}</strong> / {pageCount} 页</span>
          <button type="button" onClick={() => onPage(safePage + 1)} disabled={safePage >= pageCount - 1}>下一页 →</button>
          <button type="button" onClick={() => onPage(pageCount - 1)} disabled={safePage >= pageCount - 1}>末页</button>
        </div>

        <div className="frame-sampling-panel" aria-label="手动抽帧">
          <div><strong>手动抽帧</strong><small>{selected.length ? `只处理已选 ${selected.length} 帧` : "未选择时处理整个时间线"}</small></div>
          <label><span>每</span><input aria-label="抽帧间隔" type="number" min={2} max={60} value={keepEvery} onChange={(event) => setKeepEvery(clamp(Math.round(Number(event.target.value) || 2), 2, 60))} /><span>帧保留 1 帧</span></label>
          <label className="frame-sampling-preserve"><input type="checkbox" checked={preserveSamplingDuration} onChange={(event) => setPreserveSamplingDuration(event.target.checked)} /><span>保持原总时长</span></label>
          <button type="button" onClick={() => onManualSample(keepEvery, preserveSamplingDuration)} disabled={totalFrames < 3}>应用抽帧</button>
        </div>

        <div className="frame-drawer-actions">
          <button type="button" onClick={onDelete} disabled={!selected.length}><Trash />删除所选帧（{selected.length}）</button>
          <button type="button" onClick={onRestore} disabled={!selectedDeletedCount}>恢复所选（{selectedDeletedCount}）</button>
          <button type="button" onClick={onUndo} disabled={!canUndo}>撤销上次删除</button>
          <div className="frame-drawer-summary" aria-live="polite"><strong>已选择 {selected.length} 帧</strong><span>导出已移除 {deleted.length} 帧</span></div>
        </div>
      </section>
    </div>
  );
}

function FrameAnnotationDrawer({ asset, value, timelineStart, timelineEnd, selectedTimes, thumbTimes, onApply, onRemove, onClose }: {
  asset: MediaAsset;
  value: MemeOverlaySettings | null;
  timelineStart: number;
  timelineEnd: number;
  selectedTimes: number[];
  thumbTimes: number[];
  onApply: (settings: MemeOverlaySettings) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const sortedSelection = [...selectedTimes].sort((a, b) => a - b);
  const sortedThumbs = [...thumbTimes].sort((a, b) => a - b);
  const selectedIndexes = sortedSelection.map((time) => sortedThumbs.findIndex((thumb) => Math.abs(thumb - time) < 0.001));
  const selectionIsContiguous = selectedIndexes.length > 0 && selectedIndexes.every((index, itemIndex) =>
    index >= 0 && (itemIndex === 0 || index === selectedIndexes[itemIndex - 1] + 1)
  );
  const selectionStart = sortedSelection[0] ?? value?.startSeconds ?? timelineStart;
  const lastSelection = sortedSelection.length ? sortedSelection[sortedSelection.length - 1] : undefined;
  const nextThumb = lastSelection == null ? undefined : sortedThumbs.find((time) => time > lastSelection + 0.001);
  const selectionEnd = nextThumb ?? value?.endSeconds ?? timelineEnd;
  const [text, setText] = useState(value?.bottomText || value?.topText || "重点看这里");
  const [style, setStyle] = useState<MemeOverlaySettings["style"]>(value?.style ?? "highlight");
  const [placement, setPlacement] = useState<"top" | "center" | "bottom">(() => {
    const y = value?.bottomPosition.y ?? value?.topPosition.y ?? 82;
    return y < 35 ? "top" : y < 68 ? "center" : "bottom";
  });
  const [fontSize, setFontSize] = useState(value?.fontSize ?? 34);
  const [scope, setScope] = useState<"selection" | "timeline">(
    value?.startSeconds != null || selectionIsContiguous ? "selection" : "timeline"
  );
  const positionY = placement === "top" ? 16 : placement === "center" ? 50 : 84;
  const activeStart = scope === "selection" ? selectionStart : undefined;
  const activeEnd = scope === "selection" ? selectionEnd : undefined;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function apply() {
    const copy = text.trim();
    if (!copy) return;
    onApply({
      sourceAssetId: asset.id,
      templateId: "subtitle",
      topText: "",
      bottomText: copy,
      style,
      fontSize,
      textAlign: "center",
      position: "free",
      topPosition: { x: 50, y: 16 },
      bottomPosition: { x: 50, y: positionY },
      startSeconds: activeStart,
      endSeconds: activeEnd,
      source: "frame_annotation",
    });
  }

  return (
    <div className="frame-drawer-backdrop annotation-drawer-backdrop" role="presentation">
      <section className="frame-annotation-drawer paper-panel" role="dialog" aria-modal="true" aria-labelledby="frame-annotation-title">
        <div className="frame-drawer-head"><div><span className="frame-drawer-eyebrow">ANNOTATION</span><h2 id="frame-annotation-title">添加文字标注</h2><p>标注会真正烧录到导出文件，而不只是编辑器里的提示。</p></div><button type="button" aria-label="关闭标注面板" onClick={onClose}><X /></button></div>
        <div className={`frame-annotation-demo style-${style}`}>
          <MediaThumbnail asset={asset} />
          <span className="frame-annotation-demo__copy" style={{ left: "50%", top: `${positionY}%`, fontSize: `${Math.max(15, fontSize * 0.55)}px` }}>{text || "输入标注内容"}</span>
          <small>{scope === "selection" ? `${selectionStart.toFixed(2)}–${selectionEnd.toFixed(2)}s` : "整个时间线"}</small>
        </div>
        <div className="frame-annotation-form">
          <label className="annotation-copy-field"><span>标注内容</span><textarea aria-label="标注内容" maxLength={80} value={text} onChange={(event) => setText(event.target.value)} /></label>
          <fieldset><legend>视觉样式</legend><div className="annotation-choice-row">
            {([[
              "highlight", "重点高亮"
            ], ["panel", "清晰字幕"], ["classic", "描边文字"]] as const).map(([id, label]) => <button type="button" key={id} className={style === id ? "selected" : ""} aria-pressed={style === id} onClick={() => setStyle(id)}>{label}</button>)}
          </div></fieldset>
          <fieldset><legend>画面位置</legend><div className="annotation-choice-row">
            {([['top', '顶部'], ['center', '居中'], ['bottom', '底部']] as const).map(([id, label]) => <button type="button" key={id} className={placement === id ? "selected" : ""} aria-pressed={placement === id} onClick={() => setPlacement(id)}>{label}</button>)}
          </div></fieldset>
          <label className="annotation-size-field"><span>文字大小</span><input aria-label="标注文字大小" type="range" min={20} max={72} value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /><b>{fontSize}px</b></label>
          <fieldset><legend>生效范围</legend><div className="annotation-scope-options">
            <label className={scope === "selection" ? "selected" : ""}><input type="radio" name="annotation-scope" value="selection" checked={scope === "selection"} disabled={!selectionIsContiguous && value?.startSeconds == null} onChange={() => setScope("selection")} /><span><strong>所选连续片段</strong><small>{selectionIsContiguous ? `${sortedSelection.length} 段 · ${selectionStart.toFixed(2)}–${selectionEnd.toFixed(2)}s` : sortedSelection.length ? "选择不连续，请改选相邻片段" : "先在时间线上选择相邻片段"}</small></span></label>
            <label className={scope === "timeline" ? "selected" : ""}><input type="radio" name="annotation-scope" value="timeline" checked={scope === "timeline"} onChange={() => setScope("timeline")} /><span><strong>整个时间线</strong><small>{timelineStart.toFixed(2)}–{timelineEnd.toFixed(2)}s</small></span></label>
          </div></fieldset>
        </div>
        <div className="frame-annotation-actions">
          {value && <button type="button" className="annotation-remove" onClick={onRemove}><Trash />移除标注</button>}
          <button type="button" className="annotation-apply" disabled={!text.trim()} onClick={apply}><CheckCircle weight="fill" />应用标注到导出</button>
        </div>
      </section>
    </div>
  );
}

function TrackRegionSelector({ asset, value, keyframes, referenceTime, onChange }: {
  asset: MediaAsset;
  value: TrackedBox;
  keyframes: TrackedKeyframe[];
  referenceTime?: number;
  onChange: (box: TrackedBox) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<null | { mode: "draw" | "move"; startX: number; startY: number; origin: TrackedBox }>(null);
  const nearestThumb = referenceTime == null ? asset.thumbs?.[0] : asset.thumbs?.reduce((nearest, thumb) => (
    !nearest || Math.abs(thumb.time - referenceTime) < Math.abs(nearest.time - referenceTime) ? thumb : nearest
  ), undefined as Thumb | undefined);
  const source = nearestThumb?.url || asset.thumbnailUrl || (asset.kind === "video" ? "" : asset.sourceUrl);
  const profile = sourceProfile(asset);
  const sourceAspect = asset.aspect || (profile.width && profile.height ? profile.width / profile.height : 16 / 9);

  function point(event: React.PointerEvent<HTMLDivElement>) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: clamp((event.clientX - rect.left) / rect.width * 100, 0, 100),
      y: clamp((event.clientY - rect.top) / rect.height * 100, 0, 100),
    };
  }

  function begin(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const current = point(event);
    const inside = current.x >= value.x && current.x <= value.x + value.width
      && current.y >= value.y && current.y <= value.y + value.height;
    gestureRef.current = { mode: inside ? "move" : "draw", startX: current.x, startY: current.y, origin: value };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!inside) onChange(normalizeTrackedBox({ x: current.x, y: current.y, width: 3, height: 3 }));
  }

  function move(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const current = point(event);
    if (gesture.mode === "move") {
      onChange(normalizeTrackedBox({
        ...gesture.origin,
        x: gesture.origin.x + current.x - gesture.startX,
        y: gesture.origin.y + current.y - gesture.startY,
      }));
      return;
    }
    const x = Math.min(gesture.startX, current.x);
    const y = Math.min(gesture.startY, current.y);
    onChange(normalizeTrackedBox({
      x,
      y,
      width: Math.max(3, Math.abs(current.x - gesture.startX)),
      height: Math.max(3, Math.abs(current.y - gesture.startY)),
    }));
  }

  function end(event: React.PointerEvent<HTMLDivElement>) {
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div
      className="track-region-selector"
      ref={stageRef}
      style={{
        aspectRatio: String(clamp(sourceAspect, 0.2, 5)),
        maxWidth: `${Math.round(480 * clamp(sourceAspect, 0.2, 5))}px`,
      }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      role="application"
      aria-label="拖拽框选要跟踪的对象；拖动框内可移动范围"
    >
      {source ? <img src={source} alt={`${asset.name} 跟踪参考帧`} draggable={false} /> : <span className="track-region-selector__empty"><Images />等待参考帧</span>}
      {keyframes.length > 1 && <div className="track-path-preview" aria-hidden="true">
        {keyframes.map((frame, index) => <i key={`${frame.timeSeconds}-${index}`} style={{ left: `${frame.x + frame.width / 2}%`, top: `${frame.y + frame.height / 2}%`, opacity: 0.25 + frame.confidence * 0.75 }} />)}
      </div>}
      <span className="track-selection-box" style={{ left: `${value.x}%`, top: `${value.y}%`, width: `${value.width}%`, height: `${value.height}%` }}>
        <b>{Math.round(value.width)} × {Math.round(value.height)}%</b><i /><i /><i /><i />
      </span>
    </div>
  );
}

function TrackedEffectDrawer({ asset, effects, timelineStart, timelineEnd, selectedTimes, thumbTimes, onApply, onRemove, onClose }: {
  asset: MediaAsset;
  effects: TrackedEffect[];
  timelineStart: number;
  timelineEnd: number;
  selectedTimes: number[];
  thumbTimes: number[];
  onApply: (effect: TrackedEffect) => void;
  onRemove: (effectId: string) => void;
  onClose: () => void;
}) {
  const sortedSelection = [...selectedTimes].sort((left, right) => left - right);
  const sortedThumbs = [...thumbTimes].sort((left, right) => left - right);
  const selectedIndexes = sortedSelection.map((time) => sortedThumbs.findIndex((thumb) => Math.abs(thumb - time) < 0.001));
  const selectionIsContiguous = selectedIndexes.length > 0 && selectedIndexes.every((index, itemIndex) =>
    index >= 0 && (itemIndex === 0 || index === selectedIndexes[itemIndex - 1] + 1)
  );
  const selectionStart = sortedSelection[0] ?? timelineStart;
  const lastSelection = sortedSelection.length ? sortedSelection[sortedSelection.length - 1] : undefined;
  const selectionEnd = lastSelection == null ? timelineEnd : sortedThumbs.find((time) => time > lastSelection + 0.001) ?? timelineEnd;
  const [scope, setScope] = useState<"selection" | "timeline">(selectionIsContiguous ? "selection" : "timeline");
  const [editingId, setEditingId] = useState<string | null>(effects[0]?.id ?? null);
  const editing = effects.find((effect) => effect.id === editingId);
  const [kind, setKind] = useState<TrackedEffectKind>(editing?.kind ?? "label");
  const [label, setLabel] = useState(editing?.label ?? "重点");
  const [box, setBox] = useState<TrackedBox>(() => normalizeTrackedBox(editing?.keyframes[0] ?? { x: 28, y: 24, width: 28, height: 24 }));
  const [keyframes, setKeyframes] = useState<TrackedKeyframe[]>(editing?.keyframes ?? []);
  const [activeKeyframeIndex, setActiveKeyframeIndex] = useState<number | null>(editing?.keyframes.length ? 0 : null);
  const [analysis, setAnalysis] = useState<{ modelId: string; averageConfidence: number; lowConfidenceFrames: number } | null>(() => editing ? {
    modelId: editing.modelId,
    averageConfidence: editing.averageConfidence,
    lowConfidenceFrames: editing.lowConfidenceFrames,
  } : null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const activeStart = scope === "selection" ? selectionStart : timelineStart;
  const activeEnd = scope === "selection" ? selectionEnd : timelineEnd;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function chooseEffect(effect: TrackedEffect | null) {
    setEditingId(effect?.id ?? null);
    setKind(effect?.kind ?? "label");
    setLabel(effect?.label ?? "重点");
    setBox(normalizeTrackedBox(effect?.keyframes[0] ?? { x: 28, y: 24, width: 28, height: 24 }));
    setKeyframes(effect?.keyframes ?? []);
    setActiveKeyframeIndex(effect?.keyframes.length ? 0 : null);
    setAnalysis(effect ? { modelId: effect.modelId, averageConfidence: effect.averageConfidence, lowConfidenceFrames: effect.lowConfidenceFrames } : null);
    setAnalysisError("");
  }

  function changeBox(next: TrackedBox) {
    setBox(next);
    if (activeKeyframeIndex != null && keyframes[activeKeyframeIndex]) {
      const correctedFrames = keyframes.map((frame, index) => index === activeKeyframeIndex
        ? { ...frame, ...next, confidence: 1 }
        : frame
      );
      const averageConfidence = correctedFrames.reduce((total, frame) => total + frame.confidence, 0) / correctedFrames.length;
      const lowConfidenceFrames = correctedFrames.filter((frame) => frame.confidence < 0.55).length;
      setKeyframes(correctedFrames);
      setAnalysis({ modelId: "gifp.corrected-track.v1", averageConfidence, lowConfidenceFrames });
      setAnalysisError("");
      return;
    }
    setKeyframes([]);
    setActiveKeyframeIndex(null);
    setAnalysis(null);
    setAnalysisError("");
  }

  function selectKeyframe(index: number) {
    const frame = keyframes[index];
    if (!frame) return;
    setActiveKeyframeIndex(index);
    setBox(normalizeTrackedBox(frame));
  }

  async function analyze() {
    setAnalyzing(true);
    setAnalysisError("");
    try {
      if (asset.kind === "image" || activeEnd - activeStart < 0.12) {
        const frames = [{ ...box, timeSeconds: activeStart, confidence: 1 }];
        setKeyframes(frames);
        setActiveKeyframeIndex(0);
        setAnalysis({ modelId: "gifp.static-region.v1", averageConfidence: 1, lowConfidenceFrames: 0 });
        return;
      }
      if (!isTauriRuntime()) {
        const middle = activeStart + (activeEnd - activeStart) / 2;
        const frames = [
          { ...box, timeSeconds: activeStart, confidence: 1 },
          { ...normalizeTrackedBox({ ...box, x: box.x + 4, y: box.y + 2 }), timeSeconds: middle, confidence: 0.86 },
          { ...normalizeTrackedBox({ ...box, x: box.x + 7, y: box.y + 3 }), timeSeconds: activeEnd, confidence: 0.82 },
        ];
        setKeyframes(frames);
        setActiveKeyframeIndex(0);
        setAnalysis({ modelId: "gifp.browser-demo-track.v1", averageConfidence: 0.89, lowConfidenceFrames: 0 });
        return;
      }
      const result = await trackMediaRegion({
        input_path: asset.path,
        start_seconds: activeStart,
        end_seconds: activeEnd,
        sample_fps: 8,
        max_frames: 240,
        x_percent: box.x,
        y_percent: box.y,
        width_percent: box.width,
        height_percent: box.height,
      });
      const frames = simplifyTrackedKeyframes(result.keyframes.map((frame) => ({
        timeSeconds: frame.time_seconds,
        x: frame.x_percent,
        y: frame.y_percent,
        width: frame.width_percent,
        height: frame.height_percent,
        confidence: frame.confidence,
      })), 0.7, 28);
      setKeyframes(frames);
      setActiveKeyframeIndex(frames.length ? 0 : null);
      if (frames[0]) setBox(normalizeTrackedBox(frames[0]));
      setAnalysis({
        modelId: result.model_id,
        averageConfidence: result.average_confidence,
        lowConfidenceFrames: result.low_confidence_frames,
      });
    } catch (error) {
      setAnalysisError(String(error));
    } finally {
      setAnalyzing(false);
    }
  }

  function apply() {
    const frames = keyframes.length ? keyframes : [{ ...box, timeSeconds: activeStart, confidence: 1 }];
    const confidence = analysis?.averageConfidence ?? 1;
    onApply({
      id: editingId ?? `tracked-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      sourceAssetId: asset.id,
      kind,
      label: kind === "label" ? label.trim() || "重点" : "",
      startSeconds: activeStart,
      endSeconds: activeEnd,
      keyframes: frames,
      averageConfidence: confidence,
      lowConfidenceFrames: analysis?.lowConfidenceFrames ?? 0,
      modelId: analysis?.modelId ?? "gifp.manual-keyframe.v1",
    });
  }

  const confidenceSummary = analysis ? trackedEffectConfidenceLabel({
    averageConfidence: analysis.averageConfidence,
    lowConfidenceFrames: analysis.lowConfidenceFrames,
  }) : "等待分析";

  return (
    <div className="frame-drawer-backdrop tracking-drawer-backdrop" role="presentation">
      <section className="tracked-effect-drawer paper-panel" role="dialog" aria-modal="true" aria-labelledby="tracked-effect-title">
        <div className="frame-drawer-head"><div><span className="frame-drawer-eyebrow">OBJECT TRACKING</span><h2 id="tracked-effect-title">对象跟踪与隐私处理</h2><p>框选对象后生成可编辑轨迹；效果会真正进入导出文件。</p></div><button type="button" aria-label="关闭对象跟踪面板" onClick={onClose}><X /></button></div>
        <div className="tracked-effect-layout">
          <div className="tracked-effect-stage">
            <TrackRegionSelector
              asset={asset}
              value={box}
              keyframes={keyframes}
              referenceTime={activeKeyframeIndex == null ? activeStart : keyframes[activeKeyframeIndex]?.timeSeconds}
              onChange={changeBox}
            />
            <div className="tracking-readout"><span><strong>{confidenceSummary}</strong><small>{keyframes.length ? `${keyframes.length} 个可编辑关键帧` : "拖拽框选对象后开始分析"}</small></span>{analysis && <b>{Math.round(analysis.averageConfidence * 100)}%</b>}</div>
            {keyframes.length > 1 && <div className="tracking-keyframe-editor">
              <div><strong>轨迹校正</strong><small>选择节点后，在画面中拖动或重新框选</small></div>
              <div className="tracking-keyframe-strip" role="list" aria-label="轨迹关键帧">
                {keyframes.map((frame, index) => <button
                  type="button"
                  role="listitem"
                  key={`${frame.timeSeconds}-${index}`}
                  className={`${activeKeyframeIndex === index ? "selected" : ""}${frame.confidence < 0.55 ? " low-confidence" : ""}`}
                  aria-label={`${frame.timeSeconds.toFixed(2)} 秒，置信度 ${Math.round(frame.confidence * 100)}%`}
                  onClick={() => selectKeyframe(index)}
                ><span>{frame.timeSeconds.toFixed(2)}s</span><i style={{ height: `${Math.max(16, Math.round(frame.confidence * 100))}%` }} /><small>{Math.round(frame.confidence * 100)}%</small></button>)}
              </div>
            </div>}
            {analysisError && <p className="tracking-error" role="alert"><WarningCircle />{analysisError}</p>}
          </div>
          <div className="tracked-effect-controls">
            {effects.length > 0 && <div className="tracked-effect-list"><span>当前轨迹</span><div>{effects.map((effect, index) => <button type="button" key={effect.id} className={editingId === effect.id ? "selected" : ""} onClick={() => chooseEffect(effect)}>{index + 1}. {effect.kind === "label" ? effect.label : effect.kind === "highlight" ? "高亮框" : effect.kind === "soft_blur" ? "柔化遮挡" : "安全遮挡"}</button>)}<button type="button" onClick={() => chooseEffect(null)}><Plus />新增</button></div></div>}
            <fieldset><legend>作用方式</legend><div className="tracking-kind-grid">
              {([
                ["label", "跟踪标注", "文字与边框跟随对象"],
                ["highlight", "跟踪高亮", "只保留醒目边框"],
                ["soft_blur", "柔化遮挡", "边缘插值隐藏，适合小区域"],
                ["blackout", "安全遮挡", "完全覆盖，隐私最稳妥"],
              ] as const).map(([id, title, note]) => <button type="button" key={id} className={kind === id ? "selected" : ""} aria-pressed={kind === id} onClick={() => setKind(id)}><strong>{title}</strong><small>{note}</small></button>)}
            </div></fieldset>
            {kind === "label" && <label className="tracking-label-field"><span>标注文字</span><input aria-label="跟踪标注文字" maxLength={60} value={label} onChange={(event) => setLabel(event.target.value)} /></label>}
            <fieldset><legend>跟踪范围</legend><div className="annotation-scope-options">
              <label className={scope === "selection" ? "selected" : ""}><input type="radio" name="tracking-scope" checked={scope === "selection"} disabled={!selectionIsContiguous} onChange={() => { setScope("selection"); setKeyframes([]); setActiveKeyframeIndex(null); setAnalysis(null); }} /><span><strong>所选连续片段</strong><small>{selectionIsContiguous ? `${activeStart.toFixed(2)}–${activeEnd.toFixed(2)}s` : "先选择相邻时间片段"}</small></span></label>
              <label className={scope === "timeline" ? "selected" : ""}><input type="radio" name="tracking-scope" checked={scope === "timeline"} onChange={() => { setScope("timeline"); setKeyframes([]); setActiveKeyframeIndex(null); setAnalysis(null); }} /><span><strong>整个时间线</strong><small>{timelineStart.toFixed(2)}–{timelineEnd.toFixed(2)}s</small></span></label>
            </div></fieldset>
            <button type="button" className="tracking-analyze" disabled={analyzing || activeEnd - activeStart > 120} onClick={analyze}>{analyzing ? <ArrowsClockwise /> : <HandPointing />}{analyzing ? "正在分析轨迹…" : activeEnd - activeStart > 120 ? "请选择 120 秒内的连续片段" : keyframes.length ? "重新分析轨迹" : "分析并跟踪"}</button>
            <small className="tracking-privacy-note">低置信度位置会保留为关键帧供检查；单次最长 120 秒，敏感信息建议使用“安全遮挡”。</small>
          </div>
        </div>
        <div className="frame-annotation-actions tracked-effect-actions">
          {editingId && <button type="button" className="annotation-remove" onClick={() => { onRemove(editingId); chooseEffect(null); }}><Trash />移除当前轨迹</button>}
          <button type="button" className="annotation-apply" disabled={analyzing || activeEnd <= activeStart || (kind === "label" && !label.trim())} onClick={apply}><CheckCircle weight="fill" />应用到导出</button>
        </div>
      </section>
    </div>
  );
}
