export type DesktopFailureCategory =
  | "disk-space"
  | "permission"
  | "output-path"
  | "dependency"
  | "input-media"
  | "cancelled"
  | "unknown";

export type FailureRecovery = {
  category: DesktopFailureCategory;
  label: string;
  message: string;
  suggestions: string[];
  retryable: boolean;
  /** Original error text for local troubleshooting. Never put this directly in a shared diagnostic. */
  technicalDetails: string;
};

export type BackendCapabilitySummary = {
  ffmpegAvailable?: boolean;
  ffprobeAvailable?: boolean;
  gifEncoderAvailable?: boolean;
  hardwareAcceleration?: string | null;
};

export type ResourceSnapshot = {
  freeDiskBytes?: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  activeTasks?: number | null;
};

export type DiagnosticInput = {
  version: string;
  operation: string;
  occurredAt: Date | string;
  failure: FailureRecovery;
  backend?: BackendCapabilitySummary | null;
  resources?: ResourceSnapshot | null;
};

const textOf = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
};

const includesAny = (text: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));

const RECOVERY: Record<DesktopFailureCategory, Omit<FailureRecovery, "category" | "technicalDetails">> = {
  "disk-space": {
    label: "磁盘空间不足",
    message: "可用磁盘空间不足，任务未能安全完成。",
    suggestions: ["清理输出磁盘或临时目录空间", "改用空间充足的输出位置后重试"],
    retryable: true,
  },
  permission: {
    label: "没有访问权限",
    message: "GIFP 无法读取素材或写入目标位置。",
    suggestions: ["选择当前账户可访问的素材和输出文件夹", "关闭可能占用输出文件的其他程序后重试"],
    retryable: true,
  },
  "output-path": {
    label: "输出位置不可用",
    message: "输出路径或文件名无效，结果尚未写入。",
    suggestions: ["重新选择一个已存在的本地文件夹", "缩短文件名并移除特殊字符后重试"],
    retryable: true,
  },
  dependency: {
    label: "转换组件不可用",
    message: "FFmpeg 或必要的转换能力当前不可用。",
    suggestions: ["重新启动 GIFP，让应用重新检查转换组件", "若仍失败，请重新安装完整版本"],
    retryable: true,
  },
  "input-media": {
    label: "素材无法读取",
    message: "输入素材损坏、格式不受支持或缺少可解码的画面。",
    suggestions: ["确认素材能在本机播放器中正常播放", "将素材转换为常见格式，或换一份源文件后重试"],
    retryable: false,
  },
  cancelled: {
    label: "任务已停止",
    message: "任务已按请求停止，没有覆盖已有结果。",
    suggestions: ["需要时可重新开始任务"],
    retryable: true,
  },
  unknown: {
    label: "任务未完成",
    message: "遇到未识别的问题，已有结果不会被覆盖。",
    suggestions: ["保持当前设置再试一次", "若问题重复出现，请复制脱敏诊断信息反馈"],
    retryable: true,
  },
};

export function classifyDesktopFailure(error: unknown): FailureRecovery {
  const technicalDetails = textOf(error).trim() || "Unknown error";
  const value = technicalDetails.toLowerCase();
  let category: DesktopFailureCategory = "unknown";

  if (includesAny(value, [/gifp_task_cancelled/, /\bcancell?ed\b/, /operation was aborted/, /任务已(取消|停止)/])) {
    category = "cancelled";
  } else if (includesAny(value, [/no space left/, /disk (?:is )?full/, /enospc/, /磁盘空间不足/, /空间不够/])) {
    category = "disk-space";
  } else if (includesAny(value, [/permission denied/, /access (?:is )?denied/, /eacces/, /eperm/, /cannot write/, /could not create/, /read-only/, /拒绝访问/, /没有权限/, /不可写/])) {
    category = "permission";
  } else if (includesAny(value, [/(?:ffmpeg|ffprobe).*(?:not found|missing|unavailable)/, /(?:not found|failed to (?:find|locate)).*(?:ffmpeg|ffprobe)/, /missing dependency/, /encoder .*not found/, /unknown (?:encoder|filter)/, /转换组件/])) {
    category = "dependency";
  } else if (includesAny(value, [/invalid (?:output|path|filename)/, /output (?:directory|path).*not (?:found|exist)/, /points to a file/, /not a folder/, /parent directory/, /路径.*(?:无效|不存在)/, /文件名.*无效/])) {
    category = "output-path";
  } else if (includesAny(value, [/invalid data found/, /could not find codec parameters/, /unsupported (?:video|format|codec)/, /moov atom not found/, /decode failed/, /decode(?:r|ing)? (?:error|failed)/, /素材.*(?:损坏|无法读取|不支持)/])) {
    category = "input-media";
  }

  return { category, ...RECOVERY[category], technicalDetails };
}

/** Removes local paths and task identifiers before diagnostic text leaves the device. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:task[_ -]?id\s*[:=]\s*|GIFP_TASK_CANCELLED:)[\w{}.-]+/gi, "[任务编号已隐藏]")
    .replace(/\btask-[a-z0-9][\w.-]*/gi, "[任务编号已隐藏]")
    .replace(/\b[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\b/gi, "[任务编号已隐藏]")
    .replace(/["'][a-zA-Z]:[\\/][^"'\r\n]+["']/g, "[本地路径已隐藏]")
    .replace(/\b[a-zA-Z]:[\\/].*?(?=\s+(?:\/(?:Users|home|tmp|var|private|mnt|media|opt)\/|task(?:[_ -]?id|-)|(?:input|output)=)|[\r\n;,]|$)/gi, "[本地路径已隐藏]")
    .replace(/(?:[a-zA-Z]:[\\/](?:[^\s<>:"|?*\r\n]+[\\/])*[^\s<>:"|?*\r\n]*)/g, "[本地路径已隐藏]")
    .replace(/(?:^|[\s='"(])\/(?:Users|home|tmp|var|private|mnt|media|opt)(?:\/[^\s'"),;\r\n]+)+/g,
      (match) => `${match[0] === "/" ? "" : match[0]}[本地路径已隐藏]`)
    .replace(/\[本地路径已隐藏\](?:[\\/][^\s'"),;\r\n]+)+/g, "[本地路径已隐藏]");
}

const showBytes = (value: number | null | undefined) => Number.isFinite(value)
  ? `${Math.max(0, Math.floor(Number(value)))} B`
  : "未知";

const FAILURE_CATEGORIES = new Set<DesktopFailureCategory>([
  "disk-space",
  "permission",
  "output-path",
  "dependency",
  "input-media",
  "cancelled",
  "unknown",
]);

/**
 * Shareable diagnostics use an allow-list, rather than trying to redact every
 * possible secret from attacker-controlled strings. Keep these labels generic:
 * operation text can originate next to asset names and paths in the UI.
 */
const SAFE_OPERATIONS: Array<[RegExp, string]> = [
  [/^生成 GIF$/, "生成 GIF"],
  [/^生成动态海报$/, "生成动态海报"],
  [/^生成当前动画$/, "生成当前动画"],
  [/^全部格式生成(?:（\d+ 个失败）)?$/, "全部格式生成"],
  [/^候选生成(?:（\d+ 个失败）)?$/, "候选生成"],
  [/^批量生成(?:（\d+ 个失败）)?$/, "批量生成"],
  [/^合并动画$/, "合并动画"],
  [/^保存屏幕录制$/, "保存屏幕录制"],
  [/^开始屏幕录制$/, "开始屏幕录制"],
];

const safeOperation = (value: string): string => {
  const normalized = value.trim();
  return SAFE_OPERATIONS.find(([pattern]) => pattern.test(normalized))?.[1] ?? "未识别操作";
};

const safeVersion = (value: string): string => {
  const normalized = value.trim();
  return /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/.test(normalized)
    ? normalized
    : "未知";
};

const safeOccurredAt = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "未知";
};

const showCapability = (value: boolean | undefined): "可用" | "不可用" | "未知" => (
  value === true ? "可用" : value === false ? "不可用" : "未知"
);

const safeHardwareCapability = (value: string | null | undefined): string => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "未知";
  const capabilities: Record<string, string> = {
    cpu: "CPU",
    none: "无",
    d3d11va: "D3D11VA",
    dxva2: "DXVA2",
    cuda: "CUDA",
    nvenc: "NVENC",
    qsv: "QSV",
    amf: "AMF",
    vulkan: "Vulkan",
    videotoolbox: "VideoToolbox",
  };
  return capabilities[normalized] ?? "未知";
};

const showCount = (value: number | null | undefined): string => Number.isFinite(value)
  ? String(Math.max(0, Math.floor(Number(value))))
  : "未知";

export function buildFailureDiagnostic(input: DiagnosticInput): string {
  const category = FAILURE_CATEGORIES.has(input.failure.category) ? input.failure.category : "unknown";
  const recovery = RECOVERY[category];
  const backend = input.backend ?? {};
  const resources = input.resources ?? {};
  const lines = [
    `GIFP 版本：${safeVersion(input.version)}`,
    `操作：${safeOperation(input.operation)}`,
    `时间：${safeOccurredAt(input.occurredAt)}`,
    `错误分类：${category}（${recovery.label}）`,
    `安全建议：${recovery.suggestions.join("；")}`,
    `后端能力：FFmpeg=${showCapability(backend.ffmpegAvailable)}；FFprobe=${showCapability(backend.ffprobeAvailable)}；GIF 编码=${showCapability(backend.gifEncoderAvailable)}；硬件加速=${safeHardwareCapability(backend.hardwareAcceleration)}`,
    `资源快照：可用磁盘=${showBytes(resources.freeDiskBytes)}；内存=${showBytes(resources.memoryUsedBytes)}/${showBytes(resources.memoryTotalBytes)}；活动任务=${showCount(resources.activeTasks)}`,
  ];
  return lines.join("\n");
}
