import type { GifResult } from "../tauri";

export type TightCapOutcome = {
  status: "reachable" | "unreachable";
  label: "可达" | "不可达";
  targetBytes: number;
  actualBytes?: number;
};

export function tightCapOutcome(targetBytes: number, actualBytes?: number): TightCapOutcome {
  const reachable = actualBytes != null && actualBytes <= targetBytes;
  return {
    status: reachable ? "reachable" : "unreachable",
    label: reachable ? "可达" : "不可达",
    targetBytes,
    actualBytes,
  };
}

export const ECONOMICS_FORMATS = ["gif", "webp", "apng", "avif", "mp4", "webm"] as const;
export type EconomicsFormat = typeof ECONOMICS_FORMATS[number];

export type FormatEconomicsRow = {
  format: EconomicsFormat;
  sizeBytes: number | null;
  elapsedMs: number | null;
  qualityLabel: string;
  qualityScore: number | null;
  compatibilityLabel: string;
  compatibilityScore: number;
  status: "encoded" | "failed" | "skipped";
  failureReason?: string;
};

const COMPATIBILITY: Record<EconomicsFormat, { label: string; score: number }> = {
  gif: { label: "最广 · 聊天兼容锚点", score: 5 },
  webp: { label: "高 · 现代网页/应用", score: 4 },
  apng: { label: "高 · 现代浏览器/UI", score: 4 },
  avif: { label: "中 · 需验证动画支持", score: 3 },
  mp4: { label: "最广视频 · 非图片语义", score: 5 },
  webm: { label: "中高 · 网页视频", score: 4 },
};

function resultQuality(result: GifResult) {
  const paletteError = result.palette_report?.weighted_histogram_mean_oklab_error;
  if (typeof paletteError === "number" && Number.isFinite(paletteError)) {
    return { score: paletteError, label: `OKLab 误差 ${paletteError.toFixed(4)}` };
  }
  return { score: null, label: "编码完成 · 暂无跨格式质量分" };
}

export function buildFormatEconomicsRows(
  results: Partial<Record<EconomicsFormat, GifResult>>,
  failures: Partial<Record<EconomicsFormat, string>> = {},
): FormatEconomicsRow[] {
  return ECONOMICS_FORMATS.map((format) => {
    const compatibility = COMPATIBILITY[format];
    const result = results[format];
    if (result) {
      const quality = resultQuality(result);
      return {
        format,
        sizeBytes: result.size_bytes,
        elapsedMs: result.elapsed_ms,
        qualityLabel: quality.label,
        qualityScore: quality.score,
        compatibilityLabel: compatibility.label,
        compatibilityScore: compatibility.score,
        status: "encoded",
      };
    }
    const failureReason = failures[format];
    return {
      format,
      sizeBytes: null,
      elapsedMs: null,
      qualityLabel: failureReason ? "编码失败" : "未生成",
      qualityScore: null,
      compatibilityLabel: compatibility.label,
      compatibilityScore: compatibility.score,
      status: failureReason ? "failed" : "skipped",
      failureReason,
    };
  });
}
