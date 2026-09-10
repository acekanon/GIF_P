export type MaterialLoadTier = "short" | "standard" | "long" | "extreme";

export type MaterialLoadInput = {
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  frameCount?: number | null;
  sizeBytes?: number | null;
};

export type MaterialLoadAssessment = {
  tier: MaterialLoadTier;
  label: "短素材" | "标准素材" | "长素材" | "极长素材";
  loadScore: number;
  estimatedFrameCount: number;
  estimatedPixelFrames: number;
  reasons: string[];
};

export type TaskControlPolicy = {
  tier: MaterialLoadTier;
  thumbnailBudget: number;
  useProxyPreview: boolean;
  proxyMaxWidth: number | null;
  useDiskCache: boolean;
  maxConcurrency: number;
  keepFullResolutionFramesInMemory: boolean;
  summary: string;
};

export type CancelBackendTasksResult = {
  requested: number;
  accepted: number;
  failed: number;
};

/** Cancels each distinct backend task once and waits for every RPC in parallel. */
export async function cancelBackendTasks(
  ids: Iterable<string>,
  cancelFn: (taskId: string) => Promise<boolean>,
): Promise<CancelBackendTasksResult> {
  const uniqueIds = [...new Set(ids)];
  const results = await Promise.allSettled(uniqueIds.map((taskId) => cancelFn(taskId)));
  return {
    requested: uniqueIds.length,
    accepted: results.filter((result) => result.status === "fulfilled" && result.value).length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}

const finiteNonNegative = (value: number | null | undefined, fallback = 0) =>
  Number.isFinite(value) && (value ?? 0) >= 0 ? Number(value) : fallback;

/**
 * Estimates interactive workload rather than export file size alone. A long,
 * low-resolution clip and a short 4K clip can therefore land in the same tier.
 */
export function assessMaterialLoad(input: MaterialLoadInput): MaterialLoadAssessment {
  const duration = finiteNonNegative(input.durationSeconds);
  const width = finiteNonNegative(input.width);
  const height = finiteNonNegative(input.height);
  const fps = finiteNonNegative(input.fps, 15) || 15;
  const explicitFrames = finiteNonNegative(input.frameCount);
  const estimatedFrameCount = Math.max(explicitFrames, Math.ceil(duration * fps));
  const pixelsPerFrame = width * height;
  const estimatedPixelFrames = pixelsPerFrame * estimatedFrameCount;
  const sizeBytes = finiteNonNegative(input.sizeBytes);

  const durationScore = duration >= 300 ? 4 : duration >= 120 ? 3 : duration >= 45 ? 2 : duration >= 12 ? 1 : 0;
  const framesScore = estimatedFrameCount >= 9_000 ? 4 : estimatedFrameCount >= 3_600 ? 3 : estimatedFrameCount >= 1_200 ? 2 : estimatedFrameCount >= 360 ? 1 : 0;
  const pixelFramesScore = estimatedPixelFrames >= 8_000_000_000 ? 4
    : estimatedPixelFrames >= 2_000_000_000 ? 3
      : estimatedPixelFrames >= 500_000_000 ? 2
        : estimatedPixelFrames >= 100_000_000 ? 1
          : 0;
  const sizeScore = sizeBytes >= 1_500_000_000 ? 4 : sizeBytes >= 500_000_000 ? 3 : sizeBytes >= 150_000_000 ? 2 : sizeBytes >= 40_000_000 ? 1 : 0;
  const loadScore = Math.max(durationScore, framesScore, pixelFramesScore, sizeScore);
  const tier: MaterialLoadTier = loadScore >= 4 ? "extreme" : loadScore === 3 ? "long" : loadScore === 2 ? "standard" : "short";
  const labels = { short: "短素材", standard: "标准素材", long: "长素材", extreme: "极长素材" } as const;
  const reasons: string[] = [];
  if (durationScore >= 2) reasons.push(`时长约 ${Math.round(duration)} 秒`);
  if (framesScore >= 2) reasons.push(`预计 ${estimatedFrameCount.toLocaleString("zh-CN")} 帧`);
  if (pixelFramesScore >= 2) reasons.push("画面尺寸与帧数的组合负载较高");
  if (sizeScore >= 2) reasons.push("源文件体积较大");
  if (!reasons.length) reasons.push("适合完整预览");

  return { tier, label: labels[tier], loadScore, estimatedFrameCount, estimatedPixelFrames, reasons };
}

export function taskControlPolicy(load: MaterialLoadAssessment | MaterialLoadTier): TaskControlPolicy {
  const tier = typeof load === "string" ? load : load.tier;
  if (tier === "extreme") {
    return {
      tier, thumbnailBudget: 8, useProxyPreview: true, proxyMaxWidth: 720,
      useDiskCache: true, maxConcurrency: 1, keepFullResolutionFramesInMemory: false,
      summary: "时间线使用低密度取样和磁盘帧缓存，并限制为单任务处理。",
    };
  }
  if (tier === "long") {
    return {
      tier, thumbnailBudget: 12, useProxyPreview: true, proxyMaxWidth: 960,
      useDiskCache: true, maxConcurrency: 2, keepFullResolutionFramesInMemory: false,
      summary: "时间线减少取样并复用磁盘帧缓存，同时降低并发。",
    };
  }
  if (tier === "standard") {
    return {
      tier, thumbnailBudget: 16, useProxyPreview: false, proxyMaxWidth: null,
      useDiskCache: true, maxConcurrency: 3, keepFullResolutionFramesInMemory: false,
      summary: "按需生成缩略图并使用磁盘缓存，兼顾速度与内存占用。",
    };
  }
  return {
    tier, thumbnailBudget: 20, useProxyPreview: false, proxyMaxWidth: null,
    useDiskCache: false, maxConcurrency: 4, keepFullResolutionFramesInMemory: true,
    summary: "使用完整分辨率预览。",
  };
}

/** Returns evenly distributed midpoint samples and avoids fragile exact end seeks. */
export function thumbnailSampleTimes(durationSeconds: number, budget: number): number[] {
  const duration = finiteNonNegative(durationSeconds);
  const count = Math.max(0, Math.floor(finiteNonNegative(budget)));
  if (!count || !duration) return [];
  return Array.from({ length: count }, (_, index) => (duration * (index + 0.5)) / count);
}

export type TaskRun = {
  generation: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
  commit: <T>(write: () => T) => T | undefined;
};

/**
 * Owns the currently active async run. Starting or cancelling a run aborts the
 * old signal; commit() adds a second guard for work that cannot be aborted.
 */
export class TaskRunGate {
  private generation = 0;
  private controller: AbortController | null = null;

  start(): TaskRun {
    this.controller?.abort();
    const controller = new AbortController();
    const generation = ++this.generation;
    this.controller = controller;
    const isCurrent = () => this.generation === generation && this.controller === controller && !controller.signal.aborted;
    return {
      generation,
      signal: controller.signal,
      isCurrent,
      commit: <T>(write: () => T) => isCurrent() ? write() : undefined,
    };
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) return false;
    this.controller.abort();
    this.controller = null;
    this.generation += 1;
    return true;
  }

  get active(): boolean {
    return Boolean(this.controller && !this.controller.signal.aborted);
  }
}

export type TaskStatusKind = "queued" | "analyzing" | "generating" | "cancelling" | "cancelled" | "completed" | "failed";

export type TaskStatusInput = {
  kind: TaskStatusKind;
  progress?: number | null;
  currentStep?: string | null;
  error?: string | null;
};

export type PresentedTaskStatus = {
  label: string;
  detail: string;
  tone: "neutral" | "active" | "success" | "warning" | "danger";
  progressPercent: number | null;
  cancellable: boolean;
};

export function presentTaskStatus(input: TaskStatusInput): PresentedTaskStatus {
  const hasProgress = Number.isFinite(input.progress);
  const progressPercent = (input.kind === "analyzing" || input.kind === "generating") && hasProgress
    ? Math.round(Math.min(1, Math.max(0, Number(input.progress))) * 100)
    : input.kind === "completed" ? 100 : null;
  const step = input.currentStep?.trim();
  switch (input.kind) {
    case "queued": return { label: "等待开始", detail: step || "任务已进入队列", tone: "neutral", progressPercent: null, cancellable: true };
    case "analyzing": return { label: "正在分析素材", detail: step || "正在准备预览和任务参数", tone: "active", progressPercent, cancellable: true };
    case "generating": return { label: `正在生成${progressPercent != null ? ` ${progressPercent}%` : ""}`, detail: step || "可以继续浏览，任务会在后台完成", tone: "active", progressPercent, cancellable: true };
    case "cancelling": return { label: "正在停止", detail: "正在安全结束当前任务", tone: "warning", progressPercent: null, cancellable: false };
    case "cancelled": return { label: "已停止", detail: "没有覆盖上一次可用结果", tone: "neutral", progressPercent: null, cancellable: false };
    case "completed": return { label: "生成完成", detail: step || "结果已准备好", tone: "success", progressPercent, cancellable: false };
    case "failed": return { label: "生成失败", detail: input.error?.trim() || "任务未完成，请检查设置后重试", tone: "danger", progressPercent: null, cancellable: false };
  }
}
