import { ArrowCounterClockwise, Pause, Play, Repeat, Timer } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";
import "./animated-media-player.css";

export type AnimatedMediaFormat = "gif" | "webp" | "avif" | "apng";

export type AnimatedMediaPlaybackCapability = "loading" | "exact" | "native" | "error";

export type AnimatedMediaExternalClock = {
  timeMs: number;
  playing: boolean;
  revision: number;
};

export type AnimatedMediaPlayerProps = {
  src: string;
  format: AnimatedMediaFormat;
  alt: string;
  poster?: string;
  className?: string;
  stageOnly?: boolean;
  reducedMotion?: boolean;
  externalClock?: AnimatedMediaExternalClock;
  onPlaybackCapabilityChange?: (capability: AnimatedMediaPlaybackCapability) => void;
};

type PlaybackEngine = "loading" | "decoded" | "native" | "error";
type PlaybackSpeed = 0.5 | 1 | 2;

type FrameTiming = {
  index: number;
  startMs: number;
  durationMs: number;
};

type DecodedImageFrame = {
  codedWidth?: number;
  codedHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  duration?: number | null;
  timestamp?: number;
  close: () => void;
};

type AnimatedImageTrack = {
  frameCount: number;
  repetitionCount?: number;
};

type ImageDecoderLike = {
  tracks: {
    ready: Promise<void>;
    selectedTrack?: AnimatedImageTrack;
  };
  decode: (options: { frameIndex: number; completeFramesOnly?: boolean }) => Promise<{
    image: DecodedImageFrame;
  }>;
  close: () => void;
};

type ImageDecoderConstructor = {
  new (options: { data: ArrayBuffer; type: string; preferAnimation?: boolean }): ImageDecoderLike;
  isTypeSupported?: (type: string) => Promise<boolean>;
};

const MIME_BY_FORMAT: Record<AnimatedMediaFormat, string> = {
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  apng: "image/png",
};

const SPEEDS: PlaybackSpeed[] = [0.5, 1, 2];
const DEFAULT_FRAME_DURATION_MS = 100;
export const MAX_EXACT_DECODE_BYTES = 32 * 1024 * 1024;

type AnimationPayload =
  | { kind: "data"; data: ArrayBuffer }
  | { kind: "oversized" };

type PendingAnimationFetch = {
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<AnimationPayload>;
};

const pendingAnimationFetches = new Map<string, PendingAnimationFetch>();

function acquireAnimationPayload(src: string) {
  let pending = pendingAnimationFetches.get(src);
  if (!pending) {
    const controller = new AbortController();
    const request = {} as PendingAnimationFetch;
    const promise = (async (): Promise<AnimationPayload> => {
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok) throw new Error(`Animation fetch failed with ${response.status}`);
      const declaredBytes = Number(response.headers?.get?.("content-length") ?? 0);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_EXACT_DECODE_BYTES) {
        void response.body?.cancel();
        return { kind: "oversized" };
      }
      return { kind: "data", data: await response.arrayBuffer() };
    })().finally(() => {
      request.settled = true;
      if (pendingAnimationFetches.get(src) === request) pendingAnimationFetches.delete(src);
    });

    Object.assign(request, {
      controller,
      consumers: 0,
      settled: false,
      promise,
    });
    pending = request;
    pendingAnimationFetches.set(src, pending);
  }

  const active = pending;
  active.consumers += 1;
  let released = false;
  return {
    promise: active.promise,
    release() {
      if (released) return;
      released = true;
      active.consumers = Math.max(0, active.consumers - 1);
      queueMicrotask(() => {
        if (active.consumers > 0 || active.settled) return;
        active.controller.abort();
        if (pendingAnimationFetches.get(src) === active) pendingAnimationFetches.delete(src);
      });
    },
  };
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function shouldStartPlaying(reducedMotion?: boolean) {
  return !(reducedMotion ?? prefersReducedMotion());
}

function getDecoderConstructor(): ImageDecoderConstructor | undefined {
  return (window as typeof window & { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder;
}

function formatTime(milliseconds: number) {
  const safeMilliseconds = Math.max(0, milliseconds);
  const minutes = Math.floor(safeMilliseconds / 60_000);
  const seconds = Math.floor((safeMilliseconds % 60_000) / 1_000);
  const hundredths = Math.floor((safeMilliseconds % 1_000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

function frameDurationMilliseconds(frame: DecodedImageFrame) {
  const duration = Number(frame.duration);
  if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_FRAME_DURATION_MS;
  return Math.max(20, duration / 1_000);
}

function frameTimestampMilliseconds(frame: DecodedImageFrame) {
  const timestamp = Number(frame.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < 0) return null;
  return timestamp / 1_000;
}

function timelineDurationMilliseconds(timeline: FrameTiming[]) {
  return timeline.reduce(
    (maximum, frame) => Math.max(maximum, frame.startMs + frame.durationMs),
    0,
  );
}

function normalizedTimelineTime(timeMs: number, durationMs: number) {
  if (!Number.isFinite(timeMs) || durationMs <= 0) return 0;
  return ((timeMs % durationMs) + durationMs) % durationMs;
}

function frameAtTimelineTime(timeline: FrameTiming[], timeMs: number) {
  if (timeline.length < 2) return timeline[0];

  let low = 0;
  let high = timeline.length - 1;
  let match = timeline[0];
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = timeline[middle];
    if (candidate.startMs <= timeMs) {
      match = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

function paintDecodedFrame(canvas: HTMLCanvasElement | null, frame: DecodedImageFrame) {
  const context = canvas?.getContext("2d");
  const width = frame.displayWidth ?? frame.codedWidth ?? 1;
  const height = frame.displayHeight ?? frame.codedHeight ?? 1;
  if (!canvas || !context) throw new Error("Canvas 2D context unavailable");

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.clearRect(0, 0, width, height);
  context.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
}

export function AnimatedMediaPlayer({
  src,
  format,
  alt,
  poster,
  className = "",
  stageOnly = false,
  reducedMotion,
  externalClock,
  onPlaybackCapabilityChange,
}: AnimatedMediaPlayerProps) {
  const [engine, setEngine] = useState<PlaybackEngine>("loading");
  const [isPlaying, setIsPlaying] = useState(() => shouldStartPlaying(reducedMotion));
  const [hasEnded, setHasEnded] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [loop, setLoop] = useState(true);
  const [frameCount, setFrameCount] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [totalDurationMs, setTotalDurationMs] = useState<number | null>(null);
  const [replayVersion, setReplayVersion] = useState(0);
  const [nativeVersion, setNativeVersion] = useState(0);
  const [nativeFrozen, setNativeFrozen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nativeImageRef = useRef<HTMLImageElement | null>(null);
  const decoderRef = useRef<ImageDecoderLike | null>(null);
  const frameIndexRef = useRef(0);
  const frameDurationsRef = useRef(new Map<number, number>());
  const frameTimelineRef = useRef<FrameTiming[]>([]);
  const externalRequestKeyRef = useRef("");
  const decoderGenerationRef = useRef(0);
  const externalClockRef = useRef(externalClock);
  const externalRevisionRef = useRef(externalClock?.revision);
  const externalPlayingRef = useRef(externalClock?.playing);
  const reducedMotionRef = useRef(reducedMotion);
  const helpId = useId();

  reducedMotionRef.current = reducedMotion;
  externalClockRef.current = externalClock;
  const usesExternalClock = externalClock !== undefined;
  const effectivePlaying = externalClock?.playing ?? isPlaying;
  const capability: AnimatedMediaPlaybackCapability = engine === "decoded" ? "exact" : engine;

  useEffect(() => {
    onPlaybackCapabilityChange?.(capability);
  }, [capability, onPlaybackCapabilityChange]);

  useEffect(() => {
    let cancelled = false;
    let ownedDecoder: ImageDecoderLike | null = null;
    let releaseFetch: (() => void) | null = null;
    const decoderGeneration = decoderGenerationRef.current + 1;
    decoderGenerationRef.current = decoderGeneration;

    setEngine("loading");
    setLoadError(false);
    setHasEnded(false);
    setSpeed(1);
    setFrameCount(0);
    setFrameIndex(0);
    setElapsedMs(0);
    setTotalDurationMs(null);
    setNativeFrozen(false);
    frameIndexRef.current = 0;
    frameDurationsRef.current.clear();
    frameTimelineRef.current = [];
    externalRequestKeyRef.current = "";
    externalRevisionRef.current = externalClockRef.current?.revision;
    externalPlayingRef.current = externalClockRef.current?.playing;
    if (canvasRef.current) {
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
    }
    setIsPlaying(shouldStartPlaying(reducedMotionRef.current));

    async function prepareDecoder() {
      const Decoder = getDecoderConstructor();
      const mime = MIME_BY_FORMAT[format];

      if (!Decoder) {
        if (!cancelled) setEngine("native");
        return;
      }

      try {
        if (Decoder.isTypeSupported) {
          const supported = await Decoder.isTypeSupported(mime);
          if (cancelled) return;
          if (!supported) {
            setEngine("native");
            return;
          }
        }

        const lease = acquireAnimationPayload(src);
        const releaseLease = lease.release;
        releaseFetch = releaseLease;
        const payload = await lease.promise;
        releaseLease();
        if (releaseFetch === releaseLease) releaseFetch = null;
        if (cancelled) return;
        if (payload.kind === "oversized") {
          setEngine("native");
          return;
        }
        const decoder = new Decoder({
          data: payload.data.slice(0),
          type: mime,
          preferAnimation: true,
        });
        ownedDecoder = decoder;
        await decoder.tracks.ready;

        if (cancelled) return;
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount < 1) throw new Error("No decodable image frames");

        if (usesExternalClock) {
          const timeline: FrameTiming[] = [];
          let fallbackStartMs = 0;
          for (let index = 0; index < track.frameCount; index += 1) {
            const result = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
            const frame = result.image;
            if (cancelled) {
              frame.close();
              return;
            }

            const durationMs = frameDurationMilliseconds(frame);
            const timestampMs = frameTimestampMilliseconds(frame);
            const startMs = timestampMs ?? fallbackStartMs;
            timeline.push({ index, startMs, durationMs });
            frameDurationsRef.current.set(index, durationMs);
            fallbackStartMs = Math.max(fallbackStartMs, startMs + durationMs);
            frame.close();
          }

          if (cancelled || decoderGenerationRef.current !== decoderGeneration) return;
          frameTimelineRef.current = timeline;
          setTotalDurationMs(timelineDurationMilliseconds(timeline));
        }

        decoderRef.current = decoder;
        setFrameCount(track.frameCount);
        setEngine("decoded");
      } catch {
        if (!cancelled) {
          ownedDecoder?.close();
          ownedDecoder = null;
          decoderRef.current = null;
          setSpeed(1);
          setEngine("native");
        }
      }
    }

    void prepareDecoder();

    return () => {
      cancelled = true;
      releaseFetch?.();
      releaseFetch = null;
      if (decoderRef.current === ownedDecoder) decoderRef.current = null;
      ownedDecoder?.close();
    };
  }, [format, src, usesExternalClock]);

  useEffect(() => {
    if (usesExternalClock) return;
    if (engine !== "decoded") return;
    const decoder = decoderRef.current;
    if (!decoder || frameCount < 1) return;
    const activeDecoder: ImageDecoderLike = decoder;

    let cancelled = false;
    let timer: number | undefined;

    async function drawFrame(index: number) {
      const frameStartedAt = performance.now();
      try {
        const result = await activeDecoder.decode({ frameIndex: index, completeFramesOnly: true });
        const frame = result.image;

        if (cancelled) {
          frame.close();
          return;
        }

        try {
          paintDecodedFrame(canvasRef.current, frame);
        } catch (error) {
          frame.close();
          throw error;
        }

        const duration = frameDurationMilliseconds(frame);
        const timestampMs = frameTimestampMilliseconds(frame);
        frame.close();
        frameIndexRef.current = index;
        setFrameIndex(index);
        setElapsedMs(timestampMs ?? index * duration);

        const knownDurations = frameDurationsRef.current;
        knownDurations.set(index, duration);
        if (knownDurations.size === frameCount) {
          setTotalDurationMs(Array.from(knownDurations.values()).reduce((total, value) => total + value, 0));
        }

        if (!isPlaying || cancelled) return;

        const reachedEnd = index >= frameCount - 1;
        if (reachedEnd && !loop) {
          setHasEnded(true);
          setIsPlaying(false);
          return;
        }

        const nextIndex = reachedEnd ? 0 : index + 1;
        const renderCost = performance.now() - frameStartedAt;
        timer = window.setTimeout(
          () => void drawFrame(nextIndex),
          Math.max(0, duration / speed - renderCost),
        );
      } catch {
        if (!cancelled) {
          setSpeed(1);
          setEngine("native");
        }
      }
    }

    void drawFrame(frameIndexRef.current);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [engine, frameCount, isPlaying, loop, replayVersion, speed, usesExternalClock]);

  useEffect(() => {
    if (!externalClock || engine !== "decoded") return;
    const decoder = decoderRef.current;
    const timeline = frameTimelineRef.current;
    if (!decoder || frameCount < 1 || timeline.length !== frameCount) return;

    const durationMs = timelineDurationMilliseconds(timeline);
    const timelineTimeMs = normalizedTimelineTime(externalClock.timeMs, durationMs);
    const timing = frameAtTimelineTime(timeline, timelineTimeMs);
    if (!timing) return;

    setElapsedMs(timelineTimeMs);
    const generation = decoderGenerationRef.current;
    const requestKey = `${generation}:${externalClock.revision}:${timing.index}`;
    if (externalRequestKeyRef.current === requestKey) return;
    externalRequestKeyRef.current = requestKey;

    void decoder.decode({ frameIndex: timing.index, completeFramesOnly: true }).then(({ image: frame }) => {
      const requestIsCurrent = externalRequestKeyRef.current === requestKey
        && decoderGenerationRef.current === generation
        && decoderRef.current === decoder;
      if (!requestIsCurrent) {
        frame.close();
        return;
      }

      try {
        paintDecodedFrame(canvasRef.current, frame);
        frameIndexRef.current = timing.index;
        setFrameIndex(timing.index);
      } catch {
        setSpeed(1);
        setEngine("native");
      } finally {
        frame.close();
      }
    }).catch(() => {
      if (
        externalRequestKeyRef.current === requestKey
        && decoderGenerationRef.current === generation
        && decoderRef.current === decoder
      ) {
        setSpeed(1);
        setEngine("native");
      }
    });
  }, [engine, externalClock, frameCount]);

  useEffect(() => {
    if (usesExternalClock) return;
    if (engine !== "native" || !isPlaying) return;
    const startedAt = performance.now();
    const initialElapsed = elapsedMs;
    const timer = window.setInterval(() => {
      setElapsedMs(initialElapsed + performance.now() - startedAt);
    }, 100);
    return () => window.clearInterval(timer);
  }, [engine, isPlaying, nativeVersion, usesExternalClock]);

  function freezeNativeFrame() {
    const image = nativeImageRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas) return false;
    if (!image || !context || !image.naturalWidth || !image.naturalHeight) {
      if (canvas.width > 0 && canvas.height > 0) {
        setNativeFrozen(true);
        return true;
      }
      return false;
    }

    try {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setNativeFrozen(true);
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    if (!externalClock || engine !== "native") return;

    setElapsedMs(Math.max(0, Number.isFinite(externalClock.timeMs) ? externalClock.timeMs : 0));
    const revisionChanged = externalRevisionRef.current !== externalClock.revision;
    const playingChanged = externalPlayingRef.current !== externalClock.playing;
    externalRevisionRef.current = externalClock.revision;
    externalPlayingRef.current = externalClock.playing;

    if (revisionChanged) {
      setNativeFrozen(false);
      setNativeVersion((value) => value + 1);
      return;
    }

    if (!externalClock.playing) {
      freezeNativeFrame();
      return;
    }

    if (playingChanged && nativeFrozen) {
      setNativeFrozen(false);
      setNativeVersion((value) => value + 1);
    }
  }, [engine, externalClock, nativeFrozen]);

  useEffect(() => {
    if (usesExternalClock) return;
    if (reducedMotion !== true) return;
    if (engine === "native") freezeNativeFrame();
    setIsPlaying(false);
    setHasEnded(false);
  }, [engine, reducedMotion, usesExternalClock]);

  function pause() {
    if (engine === "native") freezeNativeFrame();
    setIsPlaying(false);
    setHasEnded(false);
  }

  function play() {
    if (engine === "native" && nativeFrozen) {
      setNativeFrozen(false);
      setNativeVersion((value) => value + 1);
      setElapsedMs(0);
    } else if (hasEnded) {
      frameIndexRef.current = 0;
      setFrameIndex(0);
      setElapsedMs(0);
      setReplayVersion((value) => value + 1);
    }
    setHasEnded(false);
    setIsPlaying(true);
  }

  function replay() {
    frameIndexRef.current = 0;
    setFrameIndex(0);
    setElapsedMs(0);
    setHasEnded(false);
    setNativeFrozen(false);
    if (engine === "native") setNativeVersion((value) => value + 1);
    else setReplayVersion((value) => value + 1);
    setIsPlaying(true);
  }

  const formatLabel = format.toUpperCase();
  const hasExactControls = engine === "decoded";
  const controlsDisabled = engine === "loading" || engine === "error" || usesExternalClock;
  const status = engine === "loading"
    ? "正在准备动画"
    : engine === "error"
      ? "动画无法载入"
      : hasEnded
        ? "播放结束"
        : effectivePlaying
          ? "正在播放"
          : "已暂停";
  const engineLabel = engine === "decoded" ? "逐帧模式" : engine === "native" ? "兼容模式" : "";
  const timeLabel = totalDurationMs === null
    ? `${formatTime(elapsedMs)} / ${engine === "native" ? "总时长未知" : "时长读取中"}`
    : `${formatTime(elapsedMs)} / ${formatTime(totalDurationMs)}`;
  const stageLabel = stageOnly
    ? `${alt}，${formatLabel} 动画预览，${status}${engineLabel ? `，${engineLabel}` : ""}`
    : `${alt}，${formatLabel} 动画预览`;

  return (
    <figure
      className={`animated-media-player${stageOnly ? " animated-media-player--stage-only" : ""}${className ? ` ${className}` : ""}`}
      data-engine={engine}
      data-playback-capability={capability}
      data-format={format}
      data-stage-only={stageOnly || undefined}
    >
      <div
        className="animated-media-player__stage"
        role="img"
        aria-label={stageLabel}
        aria-live={stageOnly ? "polite" : undefined}
        aria-atomic={stageOnly || undefined}
        aria-busy={stageOnly ? engine === "loading" : undefined}
      >
        {poster && engine === "loading" && (
          <img className="animated-media-player__poster" src={poster} alt="" aria-hidden="true" />
        )}
        <canvas
          ref={canvasRef}
          className={`animated-media-player__canvas${engine === "decoded" || nativeFrozen ? " visible" : ""}`}
          aria-hidden="true"
        />
        {engine === "native" && (
          <img
            key={`${src}-${nativeVersion}`}
            ref={nativeImageRef}
            className={`animated-media-player__image${nativeFrozen ? " frozen" : ""}`}
            src={src}
            alt=""
            aria-hidden="true"
            onLoad={() => {
              setLoadError(false);
              if (!effectivePlaying) freezeNativeFrame();
            }}
            onError={() => {
              setLoadError(true);
              setEngine("error");
            }}
          />
        )}
        {engine === "loading" && !poster && <div className="animated-media-player__placeholder" aria-hidden="true" />}
        {engine === "error" && (
          <div className="animated-media-player__error" role="alert">
            <strong>无法预览 {formatLabel}</strong>
            <span>{loadError ? "请确认文件仍然存在且可以读取。" : "当前环境无法解码这个文件。"}</span>
          </div>
        )}
        <span className="animated-media-player__format">{formatLabel}</span>
      </div>

      {!stageOnly && <figcaption className="animated-media-player__panel">
        <div className="animated-media-player__readout">
          <span className={`animated-media-player__state${effectivePlaying ? " playing" : ""}`} aria-live="polite">
            <i aria-hidden="true" />
            <strong>{status}</strong>
            {engineLabel && <small>{engineLabel}</small>}
          </span>
          <span className="animated-media-player__time" aria-label={`播放时间 ${timeLabel}`}>
            <Timer weight="bold" aria-hidden="true" />
            <b>{timeLabel}</b>
            {engine === "decoded" && frameCount > 0 && <small>帧 {frameIndex + 1}/{frameCount}</small>}
          </span>
        </div>

        <div className="animated-media-player__controls">
          <button
            type="button"
            className="animated-media-player__primary"
            onClick={effectivePlaying ? pause : play}
            disabled={controlsDisabled}
            aria-label={effectivePlaying ? "暂停动画" : engine === "native" && nativeFrozen ? "从头继续播放动画" : "播放动画"}
          >
            {effectivePlaying ? <Pause weight="fill" aria-hidden="true" /> : <Play weight="fill" aria-hidden="true" />}
            <span>{effectivePlaying ? "暂停" : "播放"}</span>
          </button>
          <button
            type="button"
            className="animated-media-player__icon-button"
            onClick={replay}
            disabled={controlsDisabled}
            aria-label="从头重播动画"
            title="从头重播"
          >
            <ArrowCounterClockwise weight="bold" aria-hidden="true" />
          </button>

          <div className="animated-media-player__speeds" role="group" aria-label="预览播放速度" aria-describedby={helpId}>
            {SPEEDS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={`预览 ${option}×`}
                aria-pressed={speed === option}
                disabled={controlsDisabled || (!hasExactControls && option !== 1)}
                onClick={() => setSpeed(option)}
              >
                {option}×
              </button>
            ))}
          </div>

          <button
            type="button"
            className="animated-media-player__loop"
            role="switch"
            aria-checked={loop}
            aria-describedby={helpId}
            disabled={controlsDisabled || !hasExactControls}
            onClick={() => setLoop((value) => !value)}
          >
            <Repeat weight="bold" aria-hidden="true" />
            <span>循环</span>
            <i aria-hidden="true" />
          </button>
        </div>

        <p id={helpId} className="animated-media-player__help">
          {engine === "decoded"
            ? "支持暂停、倍速和循环播放。"
            : engine === "native"
              ? "支持暂停和重新播放；倍速与循环由文件格式决定。"
              : "正在准备播放控制。"}
        </p>
      </figcaption>}
    </figure>
  );
}
