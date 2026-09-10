import type { OutputFormat } from "../tauri";

type Props = {
  format: OutputFormat;
  width: number;
  fps: number;
  colors: number;
  lossy: number;
  compact?: boolean;
};

function formatDetails(format: OutputFormat, colors: number, lossy: number) {
  if (format === "gif") {
    return {
      color: `${colors} 色索引`,
      encoding: "调色板 + 抖动",
      size: "体积小 · 兼容最广",
    };
  }
  if (format === "webp") {
    const quality = Math.max(45, Math.min(100, 100 - Math.min(100, lossy) / 2));
    return {
      color: lossy === 0 ? "BGRA 真彩" : "真彩 + Alpha",
      encoding: lossy === 0 ? "WebP 无损" : `WebP Q${Math.round(quality)}`,
      size: lossy === 0 ? "清晰 · 体积中等" : "清晰 · 体积较小",
    };
  }
  if (format === "avif") {
    const crf = Math.max(20, Math.min(40, 20 + Math.floor(Math.min(100, lossy) / 5)));
    return {
      color: "YUV 真彩",
      encoding: `AV1 · CRF ${crf}`,
      size: "体积最小 · 现代端",
    };
  }
  if (format === "apng") {
    return {
      color: "RGBA 真彩",
      encoding: "APNG 无损",
      size: "最干净 · 体积较大",
    };
  }
  if (format === "mp4") {
    return { color: "YUV 真彩", encoding: "H.264", size: "高效 · 不保透明" };
  }
  if (format === "webm") {
    return { color: "真彩 + Alpha", encoding: "VP9", size: "高效 · 适合网页" };
  }
  return { color: "静态图 + 视频", encoding: "Live Photo", size: "Apple 成对交付" };
}

export function OutputParameterSummary({ format, width, fps, colors, lossy, compact = false }: Props) {
  const details = formatDetails(format, colors, lossy);
  return (
    <div className={`output-parameter-summary${compact ? " compact" : ""}`} role="group" aria-label="本次实际输出参数">
      <span><small>最大宽度</small><strong>{width}px</strong></span>
      <span><small>帧率</small><strong>{fps} FPS</strong></span>
      <span><small>色彩</small><strong>{details.color}</strong></span>
      <span><small>编码</small><strong>{details.encoding}</strong></span>
      <span className="output-parameter-summary__size"><small>体积倾向</small><strong>{details.size}</strong></span>
    </div>
  );
}
