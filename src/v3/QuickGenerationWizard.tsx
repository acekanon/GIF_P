import {
  ArrowLeft,
  ChatCircleDots,
  FilmStrip,
  GlobeHemisphereWest,
  SlidersHorizontal,
  Smiley,
  CheckCircle,
  FolderOpen,
  MagicWand,
  X,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AdvancedCompressionExecutionReport, GifEncoder, GifGenerationMode, OutputFormat, OutputQualityReport } from "../tauri";
import { AdvancedCompressionReport } from "./AdvancedCompressionReport";
import { AnimatedSelect } from "./AnimatedSelect";
import { CommittedNumberInput } from "./CommittedNumberInput";
import {
  ALL_DELIVERY_FORMATS,
  availableDeliveryFormats,
  DELIVERY_FORMAT_OPTIONS,
  type DeliveryFormatPreference,
} from "./deliveryModel";
import {
  DITHER_OPTIONS,
  type DitherId,
} from "./editorModel";
import { GifTreatmentPicker } from "./GifTreatmentPicker";
import { IslandRadioGroup } from "./IslandRadioGroup";
import { OutputParameterSummary } from "./OutputParameterSummary";
import {
  recommendQuickStart,
  QUICK_FPS_MAX,
  QUICK_FPS_MIN,
  QUICK_SCALE_MIN,
} from "./quickDeliveryModel";

const QUICK_SCALE_TICKS = [QUICK_SCALE_MIN, 20, 50, 75, 100] as const;

function qualityGrade(metric: "vmaf" | "ssim", value: number) {
  if (metric === "vmaf") {
    if (value >= 90) return "优秀";
    if (value >= 80) return "清晰";
    if (value >= 70) return "可用";
    return "损失明显";
  }
  if (value >= 0.98) return "优秀";
  if (value >= 0.95) return "清晰";
  if (value >= 0.9) return "可用";
  return "损失明显";
}

function QuickQualityStamp({ metric, value, detail, digits = 1 }: {
  metric: "VMAF" | "SSIM";
  value: number;
  detail: string;
  digits?: number;
}) {
  const grade = qualityGrade(metric === "VMAF" ? "vmaf" : "ssim", value);
  const gradeClass = grade === "优秀" ? "excellent" : grade === "清晰" ? "clear" : grade === "可用" ? "usable" : "loss";
  return (
    <div className={`quality-stamp grade-${gradeClass}`} aria-label={`${metric} ${value.toFixed(digits)}，${grade}`}>
      <small>{metric}</small>
      <strong>{value.toFixed(digits)}</strong>
      <b>{grade}</b>
      <em>{detail}</em>
    </div>
  );
}

function formatName(format: OutputFormat) {
  return format === "live_photo" ? "Live 图" : format.toUpperCase();
}

function AllFormatsSummary({
  width,
  fps,
  formats,
}: {
  width: number;
  fps: number;
  formats: readonly OutputFormat[];
}) {
  return (
    <div className="output-parameter-summary compact" role="group" aria-label="本次全部输出参数">
      <span><small>最大宽度</small><strong>{width}px</strong></span>
      <span><small>帧率</small><strong>{fps} FPS</strong></span>
      <span><small>输出数量</small><strong>{formats.length} 份</strong></span>
      <span><small>格式</small><strong>{formats.length === ALL_DELIVERY_FORMATS.length ? "全部格式" : "可用格式"}</strong></span>
      <span className="output-parameter-summary__size"><small>文件大小</small><strong>生成后逐份显示</strong></span>
    </div>
  );
}

function FormatSizeComparison({
  value,
  availableFormats,
  livePhotoReady,
  desktopRuntime,
  sourceHasAlpha,
  onChange,
}: {
  value: DeliveryFormatPreference;
  availableFormats: readonly OutputFormat[];
  livePhotoReady: boolean;
  desktopRuntime: boolean;
  sourceHasAlpha?: boolean;
  onChange: (value: DeliveryFormatPreference) => void;
}) {
  const groupName = `quick-format-${useId().replace(/:/g, "")}`;
  return (
    <section className="quick-format-comparison" aria-label="输出格式与用途">
      <div className="quick-format-comparison__grid" role="radiogroup" aria-label="快速生成输出格式">
        {DELIVERY_FORMAT_OPTIONS.map((option) => {
          const all = option.value === "all";
          const format = option.value === "all" || option.value === "auto" ? null : option.value;
          const unavailable = format != null && !availableFormats.includes(format);
          const selected = option.value === value;
          const availabilityNote = option.value === "avif" && sourceHasAlpha === true
            ? "不支持透明"
            : option.value === "live_photo" && desktopRuntime && !livePhotoReady
              ? "后端未就绪"
              : null;
          return (
            <label className={`quick-format-option${selected ? " selected" : ""}${all ? " total" : ""}${unavailable ? " unavailable" : ""}`} key={option.value}>
              <input
                type="radio"
                name={groupName}
                value={option.value}
                checked={selected}
                disabled={unavailable}
                onChange={() => onChange(option.value)}
              />
              <span className="quick-format-option__copy">
                <strong>{option.label}</strong>
                {option.value === "live_photo" && (
                  <em className={livePhotoReady ? "ready" : "missing"}>
                    {livePhotoReady ? "可生成" : desktopRuntime ? "不可用" : "桌面版可用"}
                  </em>
                )}
                {availabilityNote && option.value !== "live_photo" && <em className="missing">{availabilityNote}</em>}
              </span>
              <span className="quick-format-option__size">
                <small>{option.note}</small>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function OutputSizeNotice({
  width,
  height,
  fps,
}: {
  width: number;
  height: number;
  fps: number;
}) {
  return (
    <div className="quick-size-prediction" role="status" aria-label="文件大小与输出规格" aria-live="polite">
      <span>
        <small>文件大小</small>
        <strong>生成后显示实际大小</strong>
      </span>
      <span>
        <small>输出规格</small>
        <strong>{width} × {height} · {fps} FPS</strong>
      </span>

    </div>
  );
}

export function QuickGenerationWizard({
  open,
  reducedMotion,
  activeName,
  formatPreference,
  outputFormat,
  sourceWidth,
  sourceHeight,
  outputAspect,
  sourceFps,
  duration,
  scalePercent,
  width,
  fps,
  colors,
  dither,
  lossy,
  optimizeLevel,
  encoder,
  generationMode,
  sourceHasAlpha,
  targetSizeMb,
  outputDir,
  busy,
  progress,
  status,
  backendReady,
  livePhotoReady,
  desktopRuntime,
  hasResult,
  qualityReport,
  qualityScoringEnabled,
  qualityScoring = false,
  qualityCancelPending = false,
  onCancelQualityScoring,
  memeOverlayActive = false,
  resultSizeBytes,
  compressionNote,
  advancedCompressionReport,
  cleanupNote,
  onClose,
  onFormat,
  onScale,
  onWidth,
  onFps,
  onEncoder,
  onGenerationMode,
  onTargetSizeMb,
  onColors,
  onDither,
  onLossy,
  onOptimize,
  onGenerate,
  onQualityScoringEnabled,
  onOpenOutput,
  onOpenDetailed,
  onOpenMeme,
  onCancelGeneration,
  postprocessControl,
}: {
  open: boolean;
  reducedMotion: boolean;
  activeName: string;
  formatPreference: DeliveryFormatPreference;
  outputFormat: OutputFormat;
  playbackSpeed: number;
  sourceWidth?: number;
  sourceHeight?: number;
  outputAspect?: number;
  sourceFps?: number;
  duration: number;
  scalePercent: number;
  width: number;
  fps: number;
  colors: number;
  dither: DitherId;
  lossy: number;
  optimizeLevel: number;
  encoder: GifEncoder;
  generationMode: GifGenerationMode;
  sourceHasAlpha?: boolean;
  targetSizeMb: number;
  outputDir: string;
  busy: boolean;
  progress: number;
  status: string;
  backendReady: boolean;
  livePhotoReady: boolean;
  desktopRuntime: boolean;
  hasResult: boolean;
  qualityReport?: OutputQualityReport | null;
  qualityScoringEnabled: boolean;
  qualityScoring?: boolean;
  qualityCancelPending?: boolean;
  onCancelQualityScoring?: () => void;
  memeOverlayActive?: boolean;
  resultSizeBytes?: number;
  compressionNote?: string;
  advancedCompressionReport?: AdvancedCompressionExecutionReport | null;
  cleanupNote?: string;
  onClose: () => void;
  onFormat: (value: DeliveryFormatPreference) => void;
  onScale: (value: number) => void;
  onWidth: (value: number) => void;
  onFps: (value: number) => void;
  onEncoder: (value: GifEncoder) => void;
  onGenerationMode: (value: GifGenerationMode) => void;
  onTargetSizeMb: (value: number) => void;
  onColors: (value: number) => void;
  onDither: (value: DitherId) => void;
  onLossy: (value: number) => void;
  onOptimize: (value: number) => void;
  onGenerate: () => void;
  onQualityScoringEnabled: (value: boolean) => void;
  onOpenOutput: () => void;
  onOpenDetailed: () => void;
  onOpenMeme: () => void;
  onCancelGeneration: () => void;
  postprocessControl?: React.ReactNode;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;
  const advancedId = useId();
  const safeSourceWidth = sourceWidth && sourceWidth > 0 ? sourceWidth : width;
  const safeSourceHeight = sourceHeight && sourceHeight > 0
    ? sourceHeight : Math.max(2, Math.round(safeSourceWidth * 9 / 16));
  const outputHeight = Math.max(2, Math.floor((width / (outputAspect && outputAspect > 0 ? outputAspect : safeSourceWidth / safeSourceHeight)) / 2) * 2);
  const maximumQuickWidth = Math.max(width, 2, Math.floor(safeSourceWidth / 2) * 2);
  const minimumQuickWidth = Math.min(width, Math.max(2, Math.floor(Math.max(Math.min(16, safeSourceWidth), safeSourceWidth * QUICK_SCALE_MIN / 100) / 2) * 2));
  const maxFps = Math.max(fps, QUICK_FPS_MIN, Math.min(QUICK_FPS_MAX, Math.floor(sourceFps || QUICK_FPS_MAX)));
  const recommendation = recommendQuickStart({ width: safeSourceWidth, height: safeSourceHeight, fps: sourceFps, duration }, outputFormat);
  const selectedFormatName = DELIVERY_FORMAT_OPTIONS.find((option) => option.value === formatPreference)?.label ?? formatName(outputFormat);
  const availableFormats = availableDeliveryFormats({ sourceHasAlpha, livePhotoReady: !desktopRuntime || livePhotoReady });
  const bulkDelivery = formatPreference === "all";
  const supportsCap = outputFormat === "gif" && !bulkDelivery;
  const capped = supportsCap && generationMode === "target_size";
  const ditherForced = generationMode !== "best_gif";
  const showResult = submitted || busy;
  const completed = showResult && hasResult && !busy;
  const progressLabel = Math.max(0, Math.min(100, Math.round(progress)));
  const title = showResult ? busy ? "正在生成" : completed ? "生成完成" : "本次生成已结束" : "快速生成";
  const purposes = [
    { id: "chat", label: "聊天动图", note: "GIF · 日常分享", icon: ChatCircleDots, format: "gif" },
    { id: "meme", label: "表情包", note: memeOverlayActive ? "文字已应用 · 继续编辑" : "加字、排版与小图预览", icon: Smiley, format: "gif" },
    { id: "web", label: "网页动效", note: "WebP · 支持透明", icon: GlobeHemisphereWest, format: "webp" },
    { id: "video", label: "清晰视频", note: sourceHasAlpha ? "WebM · 保留透明" : "MP4 · 适合长片段", icon: FilmStrip, format: sourceHasAlpha ? "webm" : "mp4" },
  ] as const;
  const selectedPurpose = bulkDelivery ? null : memeOverlayActive && outputFormat === "gif" ? "meme"
    : outputFormat === "gif" ? "chat" : outputFormat === "webp" ? "web"
    : outputFormat === "mp4" || outputFormat === "webm" ? "video" : null;

  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setAdvancedOpen(false);
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busyRef.current) onCloseRef.current();
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
        .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [open]);

  // A new stage replaces the clicked button. Keep keyboard focus in the dialog.
  useEffect(() => { if (open && submitted) dialogRef.current?.focus(); }, [open, submitted]);

  const dimensions = (
      <div className="quick-wizard__compression">
        <div className="quick-source-formula" aria-label="输入与输出尺寸">
          <span><small>输入</small><strong>{Math.round(safeSourceWidth)} × {Math.round(safeSourceHeight)}</strong></span>
          <b>× {(width / safeSourceWidth).toFixed(2)}</b>
          <span><small>输出</small><strong>{width} × {outputHeight}</strong></span>
        </div>
        <section className="quick-range-card">
          <header><span><small>缩放比例</small><strong>× {(width / safeSourceWidth).toFixed(2)}</strong></span><em>建议 × {(recommendation.scalePercent / 100).toFixed(2)}</em></header>
          <label className="quick-fixed-width">
            <span>固定宽度</span>
            <span><CommittedNumberInput ariaLabel="快速生成固定宽度" value={width} min={minimumQuickWidth} max={maximumQuickWidth} step={2} onCommit={onWidth} /><b>px</b></span>
          </label>
          {width <= safeSourceWidth && width >= safeSourceWidth * QUICK_SCALE_MIN / 100 ? <><input
            aria-label="快速生成缩放比例"
            type="range"
            min={QUICK_SCALE_MIN}
            max="100"
            step="5"
            value={scalePercent}
            onChange={(event) => onScale(Number(event.currentTarget.value))}
          />
          <div className="quick-range-ticks" aria-hidden="true">
            {QUICK_SCALE_TICKS.map((tick) => (
              <span
                key={tick}
                style={{ left: `${((tick - QUICK_SCALE_MIN) / (100 - QUICK_SCALE_MIN)) * 100}%` }}
              >
                {tick}%
              </span>
            ))}
          </div></> : <p className="quick-range-reason">此尺寸使用固定宽度调整。</p>}
        </section>
        <section className="quick-range-card">
          <header><span><small>输出帧率</small><strong>{fps} FPS</strong></span><em>建议 {recommendation.fps} FPS</em></header>
          <input
            aria-label="快速生成帧率"
            type="range"
            min={Math.min(fps, QUICK_FPS_MIN)}
            max={maxFps}
            step="1"
            value={Math.min(fps, maxFps)}
            onChange={(event) => onFps(Number(event.currentTarget.value))}
          />
          <p className="quick-range-reason">{recommendation.reason}</p>
        </section>
      </div>
  );
  const tuning = outputFormat === "gif" ? (
      <div className="quick-wizard__tuning">
        <section className="quick-generation-mode">
          <label>生成目标</label>
          <IslandRadioGroup ariaLabel="快速生成方式" value={generationMode}
            direction="horizontal" compact
            options={[
              { value: "best_gif", label: "画质优先", note: "优先画质，寻找更好的压缩方案", disabled: capped },
              { value: "fast_gif", label: "快速生成", note: "减少等待，快速得到成品", disabled: capped },
            ]} onChange={onGenerationMode} />
          {generationMode === "target_size" && <p className="quick-tuning-note">已启用体积上限，将自动寻找符合上限的编码方案。</p>}
        </section>
        <GifTreatmentPicker value={encoder} fps={fps} colors={colors} sourceHasAlpha={sourceHasAlpha} onChange={onEncoder} />
        <section className="quick-fine-grid" aria-label="快速生成 GIF 细项">
          <label className="quick-fine-control">
            <span><small>颜色上限</small><strong>{colors}</strong></span>
            <input aria-label="快速生成颜色上限" type="range" min="16" max="256" step="8" value={colors} onChange={(event) => onColors(Number(event.currentTarget.value))} />
          </label>
          <label className="quick-fine-control">
            <span><small>有损压缩</small><strong>{lossy}</strong></span>
            <input aria-label="快速生成有损压缩" type="range" min="0" max="100" step="1" value={lossy} onChange={(event) => onLossy(Number(event.currentTarget.value))} />
          </label>
          <div className="quick-fine-select">
            <span><small>抖动算法</small><strong>{ditherForced ? "Bayer（自动）" : "可调"}</strong></span>
            <AnimatedSelect
              ariaLabel="快速生成抖动算法"
              value={ditherForced ? "bayer" : dither}
              compact
              disabled={ditherForced}
              options={DITHER_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={onDither}
            />
          </div>
          <label className="quick-fine-control">
            <span><small>优化级别</small><strong>{optimizeLevel} / 3</strong></span>
            <input aria-label="快速生成优化级别" type="range" min="1" max="3" step="1" value={optimizeLevel} onChange={(event) => onOptimize(Number(event.currentTarget.value))} />
          </label>
        </section>
      </div>
    ) : outputFormat === "live_photo" ? (
      <div className="quick-wizard__modern-tuning quick-wizard__live-photo-tuning">
        <strong>Live Photo</strong>
        <p>生成一张封面照片和一段动态视频。</p>
        <div className="quick-live-photo-chain" aria-label="Live Photo 直接生成链">
          <span><small>静态资源</small><b>JPG 关键帧</b></span>
          <i>+</i>
          <span><small>动态资源</small><b>H.264 MOV</b></span>
          <i>→</i>
          <span><small>输出</small><b>Live Photo</b></span>
        </div>
        <label className="quick-live-photo-quality">
          <span>MOV 压缩强度</span>
          <strong>{lossy}</strong>
          <input aria-label="快速生成 Live Photo MOV 压缩强度" type="range" min="0" max="100" step="1" value={lossy} onChange={(event) => onLossy(Number(event.currentTarget.value))} />
        </label>
        <OutputParameterSummary compact format={outputFormat} width={width} fps={fps} colors={colors} lossy={lossy} />
      </div>
    ) : (
      <div className="quick-wizard__modern-tuning">
        <strong>{formatName(outputFormat)}</strong>
        <p>输出规格：{width} × {outputHeight} · {fps} FPS。更多参数可在精细编辑中调整。</p>
        <OutputParameterSummary compact format={outputFormat} width={width} fps={fps} colors={colors} lossy={lossy} />
      </div>
    );

  if (!open) return null;
  return createPortal(
    <div className={`quick-wizard-layer${reducedMotion ? " reduce-motion" : ""}`}>
      <button type="button" className="quick-wizard-mask" tabIndex={-1} aria-label="关闭快速生成向导" onClick={busy ? undefined : onClose} />
      <div ref={dialogRef} className="quick-wizard quick-wizard--intent" role="dialog" aria-modal="true" aria-labelledby="quick-wizard-title" tabIndex={-1}>
        <header>
          <span><small>QUICK EXPORT · {showResult ? "YOUR DELIVERY" : "READY WHEN YOU ARE"}</small><strong id="quick-wizard-title">{title}</strong></span>
          <button type="button" aria-label="关闭快速生成向导" onClick={onClose} disabled={busy}><X /></button>
        </header>
        <div className="quick-wizard__scene" key={showResult ? "result" : "prepare"}>
          {showResult ? (
            <div className={`quick-wizard__result${completed ? " complete" : ""}`} role="status">
              {completed ? <><CheckCircle weight="fill" aria-hidden="true" /><strong>已生成</strong></> : <><MagicWand weight="fill" aria-hidden="true" /><strong>{status}</strong></>}
              {completed && cleanupNote && <p className="quick-compression-result">{cleanupNote}</p>}
              {completed && compressionNote && <p className="quick-compression-result">{compressionNote}</p>}
              {completed && advancedCompressionReport && <details className="quick-advanced-compression-report"><summary>新算法候选与画质参考</summary><AdvancedCompressionReport report={advancedCompressionReport} /></details>}
              {completed && resultSizeBytes != null && <span className="quick-result-size">{resultSizeBytes >= 1024 * 1024 ? `${(resultSizeBytes / 1024 / 1024).toFixed(2)} MB` : `${(resultSizeBytes / 1024).toFixed(1)} KB`}{bulkDelivery ? " · 主预览 GIF" : ` · ${selectedFormatName}`}</span>}
              {completed && qualityScoring && <div className="quick-wizard__scoring">
                <span>{qualityCancelPending ? "正在停止评分 · 成品可用" : "评分中 · 成品可用"}</span>
                <button type="button" disabled={qualityCancelPending} onClick={onCancelQualityScoring}>{qualityCancelPending ? "正在终止…" : "终止评分"}</button>
              </div>}
              {completed && qualityReport?.status === "measured" && qualityReport.vmaf_mean != null && qualityReport.ssim_mean != null && (
                <div className="quick-wizard__quality" role="group" aria-label="生成质量评分">
                  <QuickQualityStamp metric="VMAF" value={qualityReport.vmaf_mean} detail={`P05 ${qualityReport.vmaf_p05?.toFixed(1) ?? "—"}`} />
                  <QuickQualityStamp metric="SSIM" value={qualityReport.ssim_mean} detail={qualityReport.ms_ssim_mean == null ? "画面一致性" : `MS ${qualityReport.ms_ssim_mean.toFixed(3)}`} digits={3} />
                </div>
              )}
              {busy && <><div className="quick-wizard__progress" role="progressbar" aria-label="生成进度" aria-valuenow={progressLabel} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${progressLabel}%` }} /></div><span>{progressLabel}%</span></>}
              {!busy && !completed && <p>可调整设置后重试。{!desktopRuntime && "浏览器为界面演示，请在桌面版导出文件。"}</p>}
            </div>
          ) : (
            <div className="quick-intent">
              <div className="quick-intent-source"><span title={activeName}>{activeName}</span><small>{duration.toFixed(1)} s · {Math.round(safeSourceWidth)} × {Math.round(safeSourceHeight)}</small></div>
              <section className="quick-purpose" aria-label="选择用途">
                <div className="quick-section-label"><strong>用在哪里</strong><small>已有推荐，也可以直接生成</small></div>
                <div className="quick-purpose-grid">
                  {purposes.map((purpose) => <button type="button" key={purpose.id} aria-pressed={selectedPurpose === purpose.id}
                    onClick={() => purpose.id === "meme" ? onOpenMeme() : onFormat(purpose.format)}>
                    <purpose.icon weight="duotone" aria-hidden="true" /><strong>{purpose.label}</strong><small>{purpose.note}</small>
                  </button>)}
                </div>
              </section>
              <section className={`quick-cap-card${capped ? " capped" : ""}`} aria-label="文件大小设置">
                <label className="quick-cap-toggle"><span><strong>文件大小上限</strong><small>{supportsCap ? capped ? "超过上限时不交付超限文件" : "不设大小上限" : bulkDelivery ? "全部格式按各自画质生成；体积上限仅支持单个 GIF" : "此格式暂不支持体积上限"}</small></span>
                  <input type="checkbox" role="switch" aria-label="限制文件大小" checked={capped} disabled={!supportsCap} onChange={(event) => onGenerationMode(event.currentTarget.checked ? "target_size" : "best_gif")} />
                </label>
                {capped && <div className="quick-cap-fields" role="group" aria-label="最大输出体积">
                  <label className="target-size-input"><span>最大不超过</span><CommittedNumberInput ariaLabel="快速生成最大输出体积（MB）" value={targetSizeMb} min={0.1} max={512} step={0.1} onCommit={onTargetSizeMb} /><b>MB</b></label>
                  <p>输出规格：{width} × {outputHeight} · {fps} FPS；最大 {targetSizeMb.toFixed(1)} MB。不会自动降低尺寸或帧率。</p>
                </div>}
              </section>
              <div className="quick-format-field">
                <div className="quick-format-field__heading"><strong>输出格式</strong><span>当前：{selectedFormatName}{memeOverlayActive && <em> · 含表情文字</em>}</span></div>
                <FormatSizeComparison value={formatPreference} availableFormats={availableFormats} livePhotoReady={livePhotoReady} desktopRuntime={desktopRuntime} sourceHasAlpha={sourceHasAlpha} onChange={onFormat} />
              </div>
              <OutputSizeNotice width={width} height={outputHeight} fps={fps} />
              {bulkDelivery && <AllFormatsSummary width={width} fps={fps} formats={availableFormats} />}
              <div className="quick-advanced">
                <button type="button" className="quick-advanced-toggle" aria-expanded={advancedOpen} aria-controls={advancedId} onClick={() => setAdvancedOpen(!advancedOpen)}>
                  <SlidersHorizontal aria-hidden="true" /><span><strong>更多设置</strong><small>尺寸、帧率与编码</small></span><b aria-hidden="true">{advancedOpen ? "−" : "+"}</b>
                </button>
                {advancedOpen && <div id={advancedId} className="quick-disclosure-content quick-advanced-body">{dimensions}{bulkDelivery ? <p>全部格式沿用此尺寸和帧率，分别使用适配的编码方案。</p> : tuning}{postprocessControl}</div>}
              </div>
              <label className="quick-quality-option">
                <span><strong>质量评分</strong><small>成品立即可用，评分随后补上</small></span>
                <input type="checkbox" role="switch" aria-label="质量评分" checked={qualityScoringEnabled} onChange={(event) => onQualityScoringEnabled(event.currentTarget.checked)} />
                <b>{qualityScoringEnabled ? "开启" : "关闭"}</b>
              </label>
              <div className="quick-wizard__folder quick-wizard__folder-summary" role="note" aria-label="当前输出目录"><FolderOpen /><span><strong>输出目录</strong><small>{outputDir || "跟随原素材目录"}</small></span><b>右上角修改</b></div>
            </div>
          )}
        </div>
        <footer>
          {showResult && !busy && <button type="button" className="quick-wizard__back" onClick={() => { setSubmitted(false); dialogRef.current?.focus(); }}><ArrowLeft />调整设置</button>}
          {busy ? <button type="button" className="quick-wizard__back" onClick={onCancelGeneration}>停止生成</button> : <button type="button" className="quick-wizard__detail" onClick={onOpenDetailed}>转到精细编辑</button>}
          {!showResult ? <button type="button" className="quick-wizard__next" disabled={!backendReady || !activeName || activeName === "等待素材"} onClick={() => { setSubmitted(true); onGenerate(); }}><MagicWand weight="fill" />开始生成</button>
            : <button type="button" className="quick-wizard__next" disabled={busy} onClick={completed ? onOpenOutput : onClose}>{completed ? outputFormat === "live_photo" ? "打开配对包" : "打开目录" : "关闭"}</button>}
        </footer>
      </div>
    </div>, document.querySelector(".gifp-v3") ?? document.body,
  );
}
