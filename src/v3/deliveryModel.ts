import type {
  DeliveryIntent,
  OutputFormat,
  PerceptualFocus,
  TargetPlatform,
} from "../tauri";

export type DeliveryContext = {
  intent: DeliveryIntent;
  targetPlatform: TargetPlatform;
  duration: number;
  fps: number;
  hasAlpha: boolean;
  focus: PerceptualFocus;
  sourceKind?: "gif" | "webp" | "apng" | "video" | "image";
};

export type DeliveryRecommendation = {
  format: OutputFormat;
  reason: string;
};

export type DeliveryFormatPreference = "auto" | "all" | OutputFormat;

export const ALL_DELIVERY_FORMATS: readonly OutputFormat[] = [
  "gif",
  "webp",
  "avif",
  "apng",
  "mp4",
  "webm",
  "live_photo",
];

/**
 * Formats that can be delivered without knowingly violating a source or
 * runtime capability contract. Unknown alpha keeps AVIF available so the
 * backend remains the final authority after media inspection.
 */
export function availableDeliveryFormats({
  sourceHasAlpha,
  livePhotoReady,
}: {
  sourceHasAlpha?: boolean;
  livePhotoReady: boolean;
}): OutputFormat[] {
  return ALL_DELIVERY_FORMATS.filter((format) => {
    if (format === "avif" && sourceHasAlpha === true) return false;
    if (format === "live_photo" && !livePhotoReady) return false;
    return true;
  });
}

export const DELIVERY_FORMAT_OPTIONS: Array<{
  value: DeliveryFormatPreference;
  label: string;
  note: string;
}> = [
  { value: "gif", label: "GIF", note: "聊天粘贴与未知平台的最大兼容格式" },
  { value: "webp", label: "Animated WebP", note: "现代网页动图，支持完整透明" },
  { value: "avif", label: "Animated AVIF", note: "现代平台体积优先；当前仅支持不透明素材" },
  { value: "apng", label: "APNG", note: "无损动画，适合 UI、文字与像素画" },
  { value: "mp4", label: "MP4", note: "长时长、高帧率的通用视频交付" },
  { value: "webm", label: "WebM", note: "网页视频，可保留透明通道" },
  {
    value: "live_photo",
    label: "实况照片（Live Photo）",
    note: "生成封面照片和动态视频，可导入支持 Live Photo 的设备",
  },
  {
    value: "all",
    label: "全部格式",
    note: "为每种可用格式各生成一份文件",
  },
];

export function resolveDeliveryFormat(
  recommendation: DeliveryRecommendation,
  preference: DeliveryFormatPreference,
): DeliveryRecommendation {
  if (preference === "auto") return recommendation;
  if (preference === "all") {
    return {
      format: "gif",
      reason: "生成全部可用格式，并以 GIF 作为主预览",
    };
  }
  if (preference === "live_photo") {
    return {
      format: "live_photo",
      reason: "生成 Live Photo 封面照片和动态视频",
    };
  }
  const selected = DELIVERY_FORMAT_OPTIONS.find((option) => option.value === preference);
  return {
    format: preference,
    reason: `已手动选择 ${selected?.label ?? preference.toUpperCase()} 交付`,
  };
}

export const DELIVERY_INTENT_OPTIONS: Array<{
  value: DeliveryIntent;
  label: string;
  note: string;
}> = [
  { value: "smart", label: "智能推荐", note: "按时长、帧率、透明度和内容重点自动选择" },
  { value: "compatibility", label: "最大兼容", note: "输出 GIF，优先聊天粘贴和未知平台" },
  { value: "modern_animation", label: "现代动图", note: "优先 Animated WebP，透明 UI 可转 APNG" },
  { value: "video", label: "视频", note: "普通内容输出 MP4，透明内容输出 WebM" },
  { value: "target_platform", label: "目标平台", note: "按聊天、网页、透明 UI 或社交视频交付" },
];

export const TARGET_PLATFORM_OPTIONS: Array<{
  value: TargetPlatform;
  label: string;
  note: string;
}> = [
  { value: "chat", label: "聊天 / 未知平台", note: "GIF，兼容粘贴与旧客户端" },
  { value: "modern_web", label: "现代网页", note: "Animated WebP，体积和透明度更平衡" },
  { value: "transparent_ui", label: "透明 UI / 像素画", note: "APNG，无损保存边缘与完整 alpha" },
  { value: "social_video", label: "社交视频", note: "MP4/H.264，适合长时长和高帧率" },
];

export function recommendDelivery(context: DeliveryContext): DeliveryRecommendation {
  if (context.intent === "compatibility") {
    return { format: "gif", reason: "最大兼容模式固定使用 GIF" };
  }
  if (context.intent === "modern_animation") {
    if (context.hasAlpha && (context.focus === "text_ui" || context.focus === "flat_art")) {
      return { format: "apng", reason: "透明文字或平面内容使用 APNG 无损保存边缘" };
    }
    return { format: "webp", reason: "短动图使用 Animated WebP 保存完整 alpha 并缩小体积" };
  }
  if (context.intent === "video") {
    return context.hasAlpha
      ? { format: "webm", reason: "透明视频使用 VP9 WebM 保留 alpha" }
      : { format: "mp4", reason: "普通视频使用 H.264 MP4 获得广泛播放兼容" };
  }
  if (context.intent === "target_platform") {
    const formatByPlatform: Record<TargetPlatform, OutputFormat> = {
      chat: "gif",
      modern_web: "webp",
      transparent_ui: "apng",
      social_video: "mp4",
    };
    const format = formatByPlatform[context.targetPlatform];
    return { format, reason: `已按目标平台选择 ${format.toUpperCase()}` };
  }

  if (context.duration >= 10 || context.fps >= 30) {
    return context.hasAlpha
      ? { format: "webm", reason: "长时长或高帧率透明素材使用 WebM" }
      : { format: "mp4", reason: "长时长或高帧率素材使用 MP4，避免动图体积失控" };
  }
  if (context.sourceKind === "gif" && !context.hasAlpha) {
    return { format: "gif", reason: "GIF 源素材保持最大兼容，避免无必要转码" };
  }
  if (context.hasAlpha && (context.focus === "text_ui" || context.focus === "flat_art")) {
    return { format: "apng", reason: "透明 UI、文字或平面动画使用 APNG 无损保边" };
  }
  return { format: "webp", reason: "短时长素材优先 Animated WebP" };
}
