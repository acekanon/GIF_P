import type { MascotMotionManifest } from "./motionTypes";

const ASSET_ROOT = "/characters/gifp-main/v2";
const STRIP_ROOT = `${ASSET_ROOT}/strips`;

export const MASCOT_MOTION_MANIFEST = {
  version: 2,
  poster: `${ASSET_ROOT}/poster.png`,
  frame: { width: 360, height: 360 },
  anchor: { x: 180, y: 348 },
  clips: {
    idle: {
      src: `${STRIP_ROOT}/idle.png`,
      frameCount: 12,
      fps: 6,
      playback: "loop",
      reducedFrame: 0,
      fallback: "poster",
      preload: "eager",
    },
    loading: {
      src: `${STRIP_ROOT}/loading.png`,
      frameCount: 8,
      fps: 10,
      playback: "loop",
      reducedFrame: 0,
      fallback: "poster",
      preload: "eager",
    },
    working: {
      src: `${STRIP_ROOT}/working.png`,
      frameCount: 8,
      fps: 10,
      playback: "loop",
      reducedFrame: 0,
      fallback: "poster",
      preload: "eager",
    },
    complete: {
      src: `${STRIP_ROOT}/complete.png`,
      frameCount: 8,
      fps: 10,
      playback: "once-hold",
      reducedFrame: 3,
      fallback: "poster",
      preload: "idle",
    },
    error: {
      src: `${STRIP_ROOT}/error.png`,
      frameCount: 8,
      fps: 8,
      playback: "loop",
      reducedFrame: 0,
      fallback: "poster",
      preload: "idle",
    },
  },
} satisfies MascotMotionManifest;

const PRELOADED_MASCOT_ASSETS = new Set<string>();

export function preloadMascotAssets(priority: "eager" | "idle") {
  if (typeof Image === "undefined") return;
  const sources = [
    ...(priority === "eager" ? [MASCOT_MOTION_MANIFEST.poster] : []),
    ...Object.values(MASCOT_MOTION_MANIFEST.clips)
      .filter((clip) => clip.preload === priority)
      .map((clip) => clip.src),
  ];

  for (const src of sources) {
    if (PRELOADED_MASCOT_ASSETS.has(src)) continue;
    PRELOADED_MASCOT_ASSETS.add(src);
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    void image.decode?.().catch(() => undefined);
  }
}
