import { useEffect, useState, type CSSProperties } from "react";
import { MASCOT_MOTION_MANIFEST } from "./motionManifest";
import type {
  MascotMotionClip,
  MascotMotionKey,
  MascotMotionManifest,
  MascotMotionPlayback,
} from "./motionTypes";

export type MascotSpriteProps = {
  motion: MascotMotionKey;
  reducedMotion?: boolean;
  className?: string;
  manifest?: MascotMotionManifest;
  onAssetError?: (src: string) => void;
  onPlaybackEnd?: (motion: MascotMotionKey) => void;
};

type PlaybackState = {
  key: string;
  frame: number;
};

type SpriteAsset = {
  key: string;
  motion: MascotMotionKey;
  src: string;
  usesPoster: boolean;
  frameCount: number;
  fps: number;
  playback: MascotMotionPlayback;
  reducedFrame: number;
};

function clampedFrame(frame: number, frameCount: number) {
  return Math.max(0, Math.min(Math.max(1, frameCount) - 1, Math.floor(frame)));
}

function systemPrefersReducedMotion() {
  return typeof window !== "undefined"
    && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function useSystemReducedMotion() {
  const [reduced, setReduced] = useState(systemPrefersReducedMotion);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

function stripAsset(motion: MascotMotionKey, clip: MascotMotionClip): SpriteAsset {
  return {
    key: `${motion}:strip:${clip.src}`,
    motion,
    src: clip.src,
    usesPoster: false,
    frameCount: Math.max(1, clip.frameCount),
    fps: clip.fps,
    playback: clip.playback,
    reducedFrame: clampedFrame(clip.reducedFrame, clip.frameCount),
  };
}

function posterAsset(motion: MascotMotionKey, src: string): SpriteAsset {
  return {
    key: `${motion}:poster:${src}`,
    motion,
    src,
    usesPoster: true,
    frameCount: 1,
    fps: 0,
    playback: "once-hold",
    reducedFrame: 0,
  };
}

function assetStyle(asset: SpriteAsset, frame: number, visible: boolean): CSSProperties {
  const translatePercent = asset.frameCount === 1 ? 0 : (frame / asset.frameCount) * 100;
  return {
    position: "absolute",
    inset: 0,
    width: `${asset.frameCount * 100}%`,
    maxWidth: "none",
    height: "100%",
    objectFit: asset.usesPoster ? "contain" : "fill",
    objectPosition: "left bottom",
    transform: `translate3d(-${translatePercent}%, 0, 0)`,
    transformOrigin: "left bottom",
    willChange: visible && !asset.usesPoster ? "transform" : undefined,
    opacity: visible ? 1 : 0,
  };
}

export function MascotSprite({
  motion,
  reducedMotion = false,
  className = "",
  manifest = MASCOT_MOTION_MANIFEST,
  onAssetError,
  onPlaybackEnd,
}: MascotSpriteProps) {
  const requestedClip = manifest.clips[motion];
  const systemReducedMotion = useSystemReducedMotion();
  const shouldReduceMotion = reducedMotion || systemReducedMotion;
  const [failedSources, setFailedSources] = useState<Set<string>>(() => new Set());
  const [posterFailed, setPosterFailed] = useState(false);
  const [activeAsset, setActiveAsset] = useState<SpriteAsset | null>(null);

  const requestedStrip = stripAsset(motion, requestedClip);
  const requestedStripFailed = failedSources.has(requestedClip.src);
  const pendingAsset = !requestedStripFailed
    ? activeAsset?.key === requestedStrip.key ? null : requestedStrip
    : activeAsset || posterFailed
      ? null
      : posterAsset(motion, manifest.poster);

  const playbackKey = activeAsset
    ? `${activeAsset.key}:${shouldReduceMotion ? "reduced" : "animated"}`
    : `none:${shouldReduceMotion ? "reduced" : "animated"}`;
  const initialFrame = activeAsset && shouldReduceMotion && !activeAsset.usesPoster
    ? activeAsset.reducedFrame
    : 0;
  const [playback, setPlayback] = useState<PlaybackState>({ key: playbackKey, frame: initialFrame });
  const frame = playback.key === playbackKey ? playback.frame : initialFrame;
  const canAnimate = Boolean(
    activeAsset
    && !shouldReduceMotion
    && !activeAsset.usesPoster
    && activeAsset.frameCount > 1
    && activeAsset.fps > 0,
  );

  useEffect(() => {
    setPlayback({ key: playbackKey, frame: initialFrame });
    if (!canAnimate || !activeAsset) return undefined;

    let nextFrame = 0;
    let timer: number | undefined;
    let ended = false;
    const frameDuration = 1_000 / activeAsset.fps;

    const advance = () => {
      if (nextFrame >= activeAsset.frameCount - 1) {
        if (activeAsset.playback === "once-hold") {
          if (!ended) {
            ended = true;
            onPlaybackEnd?.(activeAsset.motion);
          }
          return;
        }
        nextFrame = 0;
      } else {
        nextFrame += 1;
      }
      setPlayback({ key: playbackKey, frame: nextFrame });
      timer = window.setTimeout(advance, frameDuration);
    };

    timer = window.setTimeout(advance, frameDuration);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeAsset, canAnimate, initialFrame, onPlaybackEnd, playbackKey]);

  const fallback = activeAsset?.usesPoster
    ? "poster"
    : requestedStripFailed && activeAsset
      ? "previous"
      : posterFailed && !activeAsset
        ? "stage"
        : requestedStripFailed
          ? "poster"
          : undefined;
  const visibleFrameCount = activeAsset?.frameCount ?? (requestedStripFailed ? 1 : requestedStrip.frameCount);
  const visibleFrame = activeAsset
    ? frame
    : shouldReduceMotion && !requestedStripFailed
      ? requestedStrip.reducedFrame
      : 0;
  const stageStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    aspectRatio: `${manifest.frame.width} / ${manifest.frame.height}`,
    overflow: "hidden",
    backgroundImage: activeAsset || posterFailed ? undefined : `url(${manifest.poster})`,
    backgroundPosition: "center bottom",
    backgroundRepeat: "no-repeat",
    backgroundSize: "contain",
  };

  const reportAssetError = (asset: SpriteAsset) => {
    onAssetError?.(asset.src);
    if (asset.usesPoster) {
      setPosterFailed(true);
      return;
    }
    setFailedSources((current) => {
      if (current.has(asset.src)) return current;
      const next = new Set(current);
      next.add(asset.src);
      return next;
    });
  };

  return (
    <span
      className={`mascot-sprite${className ? ` ${className}` : ""}`}
      style={stageStyle}
      data-motion={motion}
      data-visible-motion={activeAsset?.motion}
      data-playback={activeAsset?.playback ?? requestedClip.playback}
      data-frame-index={visibleFrame}
      data-frame-count={visibleFrameCount}
      data-reduced-motion={shouldReduceMotion || undefined}
      data-fallback={fallback}
      aria-hidden="true"
    >
      {activeAsset && (
        <img
          key={activeAsset.key}
          className="mascot-sprite__strip is-active"
          style={assetStyle(activeAsset, frame, true)}
          src={activeAsset.src}
          alt=""
          draggable={false}
          onError={() => {
            reportAssetError(activeAsset);
            setActiveAsset(null);
          }}
        />
      )}
      {pendingAsset && (
        <img
          key={pendingAsset.key}
          className="mascot-sprite__strip is-pending"
          style={assetStyle(pendingAsset, pendingAsset.reducedFrame, false)}
          src={pendingAsset.src}
          alt=""
          draggable={false}
          onLoad={() => setActiveAsset(pendingAsset)}
          onError={() => reportAssetError(pendingAsset)}
        />
      )}
    </span>
  );
}
