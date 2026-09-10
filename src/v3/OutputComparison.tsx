import {
  ArrowCounterClockwise,
  ArrowsLeftRight,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Pause,
  Play,
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import type { CropInsets, FrameTimingMode } from "./editorModel";
import {
  AnimatedMediaPlayer,
  type AnimatedMediaExternalClock,
  type AnimatedMediaPlaybackCapability,
} from "./AnimatedMediaPlayer";
import type { OutputFormat } from "../tauri";
import "./output-comparison.css";

type SourceKind = "gif" | "webp" | "avif" | "apng" | "video" | "image";

export type ComparisonSource = {
  src: string;
  kind: SourceKind;
  animated?: boolean;
  alt: string;
  crop?: CropInsets;
};

export type ComparisonOutput = {
  src: string;
  format: OutputFormat;
  alt: string;
  label?: string;
};

export type OutputComparisonProps = {
  source: ComparisonSource;
  output: ComparisonOutput;
  aspectRatio?: number;
  timeline?: {
    startSeconds: number;
    endSeconds: number;
    playbackSpeed: number;
    outputFps?: number;
    deletedFrameIndices?: number[];
    frameTimingMode?: FrameTimingMode;
  };
  reducedMotion?: boolean;
  className?: string;
};

type CanvasRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const EMPTY_CROP: CropInsets = { left: 0, top: 0, right: 0, bottom: 0 };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isAnimatedSource(source: ComparisonSource) {
  return source.kind === "gif"
    || source.kind === "avif"
    || source.kind === "apng"
    || (source.kind === "webp" && source.animated !== false);
}

function ComparisonMedia({
  source,
  output,
  clock,
  reducedMotion,
  sourceSide,
  playbackRate,
  seekKey,
  onCapabilityChange,
}: {
  source?: ComparisonSource;
  output?: ComparisonOutput;
  clock: AnimatedMediaExternalClock;
  reducedMotion: boolean;
  sourceSide: boolean;
  playbackRate: number;
  seekKey: number;
  onCapabilityChange: (capability: AnimatedMediaPlaybackCapability) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastVideoRevisionRef = useRef(clock.revision);
  const lastVideoSeekKeyRef = useRef(Number.NaN);
  const videoSource = sourceSide && source?.kind === "video"
    ? source.src
    : !sourceSide && (output?.format === "mp4" || output?.format === "webm")
      ? output.src
      : "";

  useEffect(() => {
    if (!videoSource) return;
    const video = videoRef.current;
    if (!video) return;
    onCapabilityChange("exact");
    const revisionChanged = lastVideoRevisionRef.current !== clock.revision;
    lastVideoRevisionRef.current = clock.revision;
    const seekKeyChanged = lastVideoSeekKeyRef.current !== seekKey;
    lastVideoSeekKeyRef.current = seekKey;
    const targetSeconds = Math.max(0, clock.timeMs / 1_000);
    video.playbackRate = clamp(playbackRate, 0.25, 4);
    if (Number.isFinite(video.duration) && video.duration > 0) {
      const boundedTarget = Math.min(targetSeconds, Math.max(0, video.duration - 0.001));
      if (revisionChanged || seekKeyChanged || Math.abs(video.currentTime - boundedTarget) > 0.09) {
        video.currentTime = boundedTarget;
      }
    } else if (revisionChanged || seekKeyChanged || Math.abs(video.currentTime - targetSeconds) > 0.09) {
      video.currentTime = targetSeconds;
    }
    if (clock.playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [clock.playing, clock.revision, clock.timeMs, onCapabilityChange, playbackRate, seekKey, videoSource]);

  if (sourceSide && source) {
    if (source.kind === "video") {
      return <video ref={videoRef} src={source.src} aria-label={source.alt} muted autoPlay={false} loop playsInline />;
    }
    if (isAnimatedSource(source)) {
      return (
        <AnimatedMediaPlayer
          src={source.src}
          format={source.kind as "gif" | "webp" | "avif" | "apng"}
          alt={source.alt}
          className="output-comparison__animated"
          stageOnly
          reducedMotion={reducedMotion}
          externalClock={clock}
          onPlaybackCapabilityChange={onCapabilityChange}
        />
      );
    }
    return <img src={source.src} alt={source.alt} onLoad={() => onCapabilityChange("exact")} />;
  }

  if (!output) return null;
  if (output.format === "mp4" || output.format === "webm") {
    return <video ref={videoRef} src={output.src} aria-label={output.alt} muted autoPlay={false} loop playsInline />;
  }
  if (output.format === "live_photo") {
    return <img src={output.src} alt={`${output.alt} 静态关键帧`} onLoad={() => onCapabilityChange("exact")} />;
  }
  return (
    <AnimatedMediaPlayer
      src={output.src}
      format={output.format}
      alt={output.alt}
      className="output-comparison__animated"
      stageOnly
      reducedMotion={reducedMotion}
      externalClock={clock}
      onPlaybackCapabilityChange={onCapabilityChange}
    />
  );
}

function sourceCropStyle(crop: CropInsets) {
  const visibleWidth = Math.max(0.01, 1 - (crop.left + crop.right) / 100);
  const visibleHeight = Math.max(0.01, 1 - (crop.top + crop.bottom) / 100);
  return {
    left: `${-crop.left / visibleWidth}%`,
    top: `${-crop.top / visibleHeight}%`,
    width: `${100 / visibleWidth}%`,
    height: `${100 / visibleHeight}%`,
  };
}

function mediaCanvas(
  side: "source" | "output",
  rect: CanvasRect,
  crop: CropInsets,
  source: ComparisonSource,
  output: ComparisonOutput,
  clock: AnimatedMediaExternalClock,
  playbackRate: number,
  seekKey: number,
  reducedMotion: boolean,
  onCapabilityChange: (capability: AnimatedMediaPlaybackCapability) => void,
) {
  return (
    <div
      className="output-comparison__canvas"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <div
        className={`output-comparison__media output-comparison__media--${side}`}
        style={side === "source" ? sourceCropStyle(crop) : undefined}
      >
        <ComparisonMedia
          source={source}
          output={output}
          clock={clock}
          reducedMotion={reducedMotion}
          sourceSide={side === "source"}
          playbackRate={playbackRate}
          seekKey={seekKey}
          onCapabilityChange={onCapabilityChange}
        />
      </div>
    </div>
  );
}

export function OutputComparison({
  source,
  output,
  aspectRatio = 1,
  timeline,
  reducedMotion = false,
  className = "",
}: OutputComparisonProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const previousSourcesRef = useRef(`${source.src}\n${output.src}`);
  const synchronizedStartRef = useRef("");
  const descriptionId = useId();
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState({ x: 50, y: 50 });
  const [revision, setRevision] = useState(0);
  const [playing, setPlaying] = useState(() => !reducedMotion);
  const [timeMs, setTimeMs] = useState(0);
  const [sourceCapability, setSourceCapability] = useState<AnimatedMediaPlaybackCapability>("loading");
  const [outputCapability, setOutputCapability] = useState<AnimatedMediaPlaybackCapability>("loading");
  const [dragging, setDragging] = useState(false);
  const [canvasRect, setCanvasRect] = useState<CanvasRect>({ left: 0, top: 0, width: 1, height: 1 });
  const crop = source.crop ?? EMPTY_CROP;
  const safeAspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;

  const startSeconds = Math.max(0, timeline?.startSeconds ?? 0);
  const endSeconds = Math.max(startSeconds, timeline?.endSeconds ?? 0);
  const playbackSpeed = timeline?.playbackSpeed ?? 1;
  const outputFps = Number.isFinite(timeline?.outputFps) && (timeline?.outputFps ?? 0) > 0
    ? clamp(Math.round(timeline!.outputFps!), 1, 60)
    : 0;
  const deletedFrameIndices = [...new Set((timeline?.deletedFrameIndices ?? [])
    .filter((index) => Number.isInteger(index) && index >= 0))]
    .sort((left, right) => left - right);
  const uncutDurationMs = endSeconds > startSeconds ? ((endSeconds - startSeconds) / playbackSpeed) * 1_000 : 0;
  const uncutFrameCount = outputFps > 0 ? Math.round((uncutDurationMs / 1_000) * outputFps) : 0;
  const deletedFrameCount = deletedFrameIndices.filter((index) => index < uncutFrameCount).length;
  const frameTimingMode = timeline?.frameTimingMode ?? "compact";
  const durationMs = outputFps > 0 && uncutFrameCount > 0
    ? (frameTimingMode === "preserve"
      ? uncutFrameCount
      : Math.max(1, uncutFrameCount - deletedFrameCount)) / outputFps * 1_000
    : uncutDurationMs;
  const livePhotoPoster = output.format === "live_photo";

  useEffect(() => {
    setSplit(50);
    setZoom(1);
    setFocus({ x: 50, y: 50 });
    setTimeMs(livePhotoPoster && durationMs > 0 ? durationMs / 2 : 0);
    const sources = `${source.src}\n${output.src}`;
    if (previousSourcesRef.current !== sources) {
      previousSourcesRef.current = sources;
      synchronizedStartRef.current = "";
      setSourceCapability("loading");
      setOutputCapability("loading");
      setRevision((value) => value + 1);
    }
  }, [durationMs, livePhotoPoster, output.src, source.src]);

  useEffect(() => {
    if (livePhotoPoster) return;
    const sourceReady = sourceCapability === "exact" || sourceCapability === "native";
    const outputReady = outputCapability === "exact" || outputCapability === "native";
    if (!sourceReady || !outputReady) return;

    const signature = `${source.src}\n${output.src}\n${sourceCapability}\n${outputCapability}`;
    if (synchronizedStartRef.current === signature) return;
    synchronizedStartRef.current = signature;
    setTimeMs(0);
    setRevision((value) => value + 1);
  }, [livePhotoPoster, output.src, outputCapability, source.src, sourceCapability]);

  useEffect(() => {
    setPlaying(!reducedMotion && !livePhotoPoster);
  }, [livePhotoPoster, output.src, reducedMotion, source.src]);

  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    let lastCommitted = previous;
    let accumulated = 0;
    const tick = (now: number) => {
      const delta = Math.max(0, now - previous);
      previous = now;
      accumulated += delta;
      if (now - lastCommitted >= 30) {
        lastCommitted = now;
        const advance = accumulated;
        accumulated = 0;
        setTimeMs((value) => {
          const next = value + advance;
          return durationMs > 0 ? next % durationMs : next;
        });
      }
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };
    animationFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    };
  }, [durationMs, playing]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const bounds = viewport.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const viewportAspect = bounds.width / bounds.height;
      if (viewportAspect > safeAspect) {
        const width = bounds.height * safeAspect;
        setCanvasRect({ left: (bounds.width - width) / 2, top: 0, width, height: bounds.height });
      } else {
        const height = bounds.width / safeAspect;
        setCanvasRect({ left: 0, top: (bounds.height - height) / 2, width: bounds.width, height });
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [safeAspect]);

  function pointerPosition(event: React.PointerEvent<HTMLElement>) {
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return null;
    const canvasX = clamp(event.clientX - bounds.left - canvasRect.left, 0, canvasRect.width);
    const canvasY = clamp(event.clientY - bounds.top - canvasRect.top, 0, canvasRect.height);
    return {
      canvasX: canvasRect.width > 0 ? (canvasX / canvasRect.width) * 100 : 50,
      focusX: ((canvasRect.left + canvasX) / bounds.width) * 100,
      focusY: ((canvasRect.top + canvasY) / bounds.height) * 100,
    };
  }

  function updateSplit(event: React.PointerEvent<HTMLElement>) {
    const next = pointerPosition(event);
    if (next) setSplit(Math.round(next.canvasX * 10) / 10);
  }

  function onDividerPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    updateSplit(event);
  }

  function onDividerPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragging) updateSplit(event);
  }

  function finishDividerDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }

  function onDividerKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 5 : 1;
    let next = split;
    if (event.key === "ArrowLeft") next -= step;
    else if (event.key === "ArrowRight") next += step;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 100;
    else return;
    event.preventDefault();
    setSplit(clamp(next, 0, 100));
  }

  function onViewportPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (zoom <= 1 || dragging) return;
    const next = pointerPosition(event);
    if (next) setFocus({ x: next.focusX, y: next.focusY });
  }

  function onViewportPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (zoom <= 1 || dragging) return;
    const next = pointerPosition(event);
    if (next) setFocus({ x: next.focusX, y: next.focusY });
  }

  function resetPlayback() {
    setTimeMs(livePhotoPoster && durationMs > 0 ? durationMs / 2 : 0);
    setRevision((value) => value + 1);
    setPlaying(!reducedMotion && !livePhotoPoster);
  }

  function resetView() {
    setSplit(50);
    setZoom(1);
    setFocus({ x: 50, y: 50 });
  }

  const transformStyle = {
    transform: `scale(${zoom})`,
    transformOrigin: `${focus.x}% ${focus.y}%`,
  };
  const outputLabel = output.label ?? `${output.format.toUpperCase()} 成品`;
  const hasCrop = crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0;
  const dividerLeft = canvasRect.left + (canvasRect.width * split) / 100;
  const sourceTimelinePosition = (() => {
    if (outputFps <= 0 || deletedFrameIndices.length === 0) {
      return {
        timeMs: startSeconds * 1_000 + timeMs * playbackSpeed,
        skippedFrames: 0,
      };
    }
    const outputFramePosition = timeMs / 1_000 * outputFps;
    const outputFrameIndex = Math.floor(outputFramePosition);
    const frameProgress = outputFramePosition - outputFrameIndex;
    if (frameTimingMode === "preserve") {
      const deleted = new Set(deletedFrameIndices);
      let sourceFrameIndex = Math.min(Math.max(0, outputFrameIndex), Math.max(0, uncutFrameCount - 1));
      if (deleted.has(sourceFrameIndex)) {
        let previous = sourceFrameIndex - 1;
        while (previous >= 0 && deleted.has(previous)) previous -= 1;
        if (previous >= 0) sourceFrameIndex = previous;
        else {
          let next = sourceFrameIndex + 1;
          while (next < uncutFrameCount && deleted.has(next)) next += 1;
          sourceFrameIndex = Math.min(next, Math.max(0, uncutFrameCount - 1));
        }
      }
      const held = sourceFrameIndex !== outputFrameIndex;
      const sourceOffsetMs = ((sourceFrameIndex + (held ? 0 : frameProgress)) / outputFps) * 1_000 * playbackSpeed;
      return {
        timeMs: startSeconds * 1_000 + sourceOffsetMs,
        skippedFrames: Math.abs(outputFrameIndex - sourceFrameIndex),
      };
    }
    let sourceFrameIndex = outputFrameIndex;
    let skippedFrames = 0;
    for (const deletedIndex of deletedFrameIndices) {
      if (deletedIndex > sourceFrameIndex) break;
      sourceFrameIndex += 1;
      skippedFrames += 1;
    }
    const sourceOffsetMs = ((sourceFrameIndex + frameProgress) / outputFps) * 1_000 * playbackSpeed;
    return {
      timeMs: startSeconds * 1_000 + sourceOffsetMs,
      skippedFrames,
    };
  })();
  const sourceClock: AnimatedMediaExternalClock = {
    timeMs: sourceTimelinePosition.timeMs,
    playing,
    revision,
  };
  const outputClock: AnimatedMediaExternalClock = { timeMs, playing, revision };
  const exactSync = sourceCapability === "exact" && outputCapability === "exact";
  const compatibilitySync = sourceCapability === "native" || outputCapability === "native";
  const syncLabel = livePhotoPoster ? "关键帧对照" : exactSync ? "逐帧同步" : compatibilitySync ? "兼容同起" : "正在对齐";

  return (
    <section className={`output-comparison ${zoom > 1 ? "is-zoomed" : ""} ${className}`.trim()} aria-label="原素材与输出结果对比">
      <div className="output-comparison__toolbar">
        <div className="output-comparison__legend" aria-hidden="true">
          <span className="source">原素材</span>
          <span className="output">{outputLabel}</span>
        </div>
        <span className="output-comparison__readout">原素材 {Math.round(split)}% · 成品 {Math.round(100 - split)}% · {syncLabel}</span>
        <div className="output-comparison__tools" role="group" aria-label="对比检视工具">
          <button type="button" aria-label={playing ? "暂停对比播放" : "播放对比动画"} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button>
          <button type="button" aria-label="缩小放大镜" onClick={() => setZoom((value) => clamp(value - 0.5, 1, 4))} disabled={zoom <= 1}><MagnifyingGlassMinus /></button>
          <button
            type="button"
            className={zoom > 1 ? "active" : ""}
            aria-label={zoom > 1 ? "关闭放大镜" : "打开 2 倍放大镜"}
            aria-pressed={zoom > 1}
            onClick={() => setZoom((value) => value > 1 ? 1 : 2)}
          >
            <MagnifyingGlassPlus /><span>{zoom.toFixed(1)}×</span>
          </button>
          <button type="button" aria-label="放大放大镜" onClick={() => setZoom((value) => clamp(value + 0.5, 1, 4))} disabled={zoom >= 4}><MagnifyingGlassPlus /></button>
          <button type="button" aria-label="重新同步播放" onClick={resetPlayback}><ArrowCounterClockwise /></button>
          <button type="button" className="reset" onClick={resetView}>复位</button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="output-comparison__viewport transparency-grid"
        onPointerMove={onViewportPointerMove}
        onPointerDown={onViewportPointerDown}
        onDoubleClick={() => setZoom((value) => value > 1 ? 1 : 2)}
        aria-describedby={descriptionId}
      >
        <div className="output-comparison__layer output-comparison__layer--source">
          <div className="output-comparison__zoom-plane" style={transformStyle}>
            {mediaCanvas("source", canvasRect, crop, source, output, sourceClock, playbackSpeed, sourceTimelinePosition.skippedFrames, reducedMotion, setSourceCapability)}
          </div>
        </div>
        <div className="output-comparison__layer output-comparison__layer--output" style={{ clipPath: `inset(0 0 0 ${dividerLeft}px)` }}>
          <div className="output-comparison__zoom-plane" style={transformStyle}>
            {mediaCanvas("output", canvasRect, crop, source, output, outputClock, 1, 0, reducedMotion, setOutputCapability)}
          </div>
        </div>

        <span className="output-comparison__label output-comparison__label--source">原素材{hasCrop ? " · 按导出裁剪" : ""}</span>
        <span className="output-comparison__label output-comparison__label--output">{outputLabel}</span>
        <div
          className={`output-comparison__divider ${dragging ? "dragging" : ""}`}
          style={{ left: `${dividerLeft}px` }}
          role="slider"
          tabIndex={0}
          aria-label="原素材与成品分割线"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(split)}
          aria-valuetext={`左侧原素材 ${Math.round(split)}%，右侧成品 ${Math.round(100 - split)}%`}
          aria-describedby={descriptionId}
          onKeyDown={onDividerKeyDown}
          onPointerDown={onDividerPointerDown}
          onPointerMove={onDividerPointerMove}
          onPointerUp={finishDividerDrag}
          onPointerCancel={finishDividerDrag}
        >
          <span><ArrowsLeftRight weight="bold" /></span>
        </div>
      </div>
      <p id={descriptionId} className="output-comparison__hint">
        拖动中线检查变化；开启放大镜后移动指针查看同一位置。{livePhotoPoster ? "实况照片以中点关键帧进行静态对照；动态部分请在结果预览中按住播放。" : compatibilitySync ? "兼容预览会同时重播，逐帧定位取决于当前解码能力。" : "播放按导出片段与速度对齐。"}
      </p>
    </section>
  );
}
