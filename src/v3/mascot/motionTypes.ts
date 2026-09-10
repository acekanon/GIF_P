export const MASCOT_MOTION_KEYS = ["idle", "loading", "working", "complete", "error"] as const;

export type MascotMotionKey = (typeof MASCOT_MOTION_KEYS)[number];

export type MascotMotionPlayback = "loop" | "once-hold";

export type MascotMotionClip = {
  src: string;
  frameCount: number;
  fps: number;
  playback: MascotMotionPlayback;
  /** Zero-based frame used when motion is reduced. */
  reducedFrame: number;
  fallback: "poster";
  preload: "eager" | "idle";
};

export type MascotMotionManifest = {
  version: 1 | 2;
  poster: string;
  frame: {
    width: number;
    height: number;
  };
  anchor: {
    x: number;
    y: number;
  };
  clips: Record<MascotMotionKey, MascotMotionClip>;
};
