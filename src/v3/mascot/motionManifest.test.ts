// @ts-expect-error The production app intentionally does not depend on @types/node.
import { existsSync, readFileSync, statSync } from "node:fs";
// @ts-expect-error The production app intentionally does not depend on @types/node.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MASCOT_MOTION_MANIFEST } from "./motionManifest";
import { MASCOT_MOTION_KEYS, type MascotMotionKey, type MascotMotionPlayback } from "./motionTypes";

type PublicClip = {
  strip: string;
  preview: string;
  frameCount: number;
  fps: number;
  playback: MascotMotionPlayback;
  reducedFrame: number;
};

type PublicManifest = {
  frame: { width: number; height: number };
  anchor: { x: number; y: number };
  poster: string;
  clips: Record<MascotMotionKey, PublicClip>;
};

type PngHeader = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
};

// @ts-expect-error Vitest runs this contract test in Node; app sources do not install Node globals.
const PROJECT_ROOT = process.cwd();
const PUBLIC_ROOT = resolve(PROJECT_ROOT, "public", "characters", "gifp-main", "v2");
const PUBLIC_URL_ROOT = "/characters/gifp-main/v2";
const publicManifest = JSON.parse(
  readFileSync(resolve(PUBLIC_ROOT, "manifest.json"), "utf8"),
) as PublicManifest;

function publicPath(relativePath: string) {
  return resolve(PUBLIC_ROOT, ...relativePath.split("/"));
}

function publicUrl(relativePath: string) {
  return `${PUBLIC_URL_ROOT}/${relativePath}`;
}

function readPngHeader(path: string): PngHeader {
  const bytes = readFileSync(path);
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.readUInt32BE(8)).toBe(13);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes.readUInt8(24),
    colorType: bytes.readUInt8(25),
  };
}

describe("production mascot motion manifest", () => {
  it("keeps the public JSON and TypeScript runtime contract aligned", () => {
    expect(MASCOT_MOTION_MANIFEST.version).toBe(2);
    expect(JSON.stringify(MASCOT_MOTION_MANIFEST)).not.toContain("/v1/");
    expect(MASCOT_MOTION_MANIFEST.frame).toEqual(publicManifest.frame);
    expect(MASCOT_MOTION_MANIFEST.anchor).toEqual({
      x: publicManifest.anchor.x,
      y: publicManifest.anchor.y,
    });
    expect(MASCOT_MOTION_MANIFEST.poster).toBe(publicUrl(publicManifest.poster));

    for (const action of MASCOT_MOTION_KEYS) {
      const publicClip = publicManifest.clips[action];
      const runtimeClip = MASCOT_MOTION_MANIFEST.clips[action];
      expect(runtimeClip.src, `${action} strip URL`).toBe(publicUrl(publicClip.strip));
      expect(runtimeClip.frameCount, `${action} frameCount`).toBe(publicClip.frameCount);
      expect(runtimeClip.fps, `${action} fps`).toBe(publicClip.fps);
      expect(runtimeClip.playback, `${action} playback`).toBe(publicClip.playback);
      expect(runtimeClip.reducedFrame, `${action} reducedFrame`).toBe(publicClip.reducedFrame);
    }
  });

  it.each(MASCOT_MOTION_KEYS)("ships a correctly sized RGBA %s strip", (action) => {
    const clip = publicManifest.clips[action];
    const header = readPngHeader(publicPath(clip.strip));
    expect(header).toEqual({
      width: publicManifest.frame.width * clip.frameCount,
      height: publicManifest.frame.height,
      bitDepth: 8,
      colorType: 6,
    });
  });

  it.each(MASCOT_MOTION_KEYS)("ships the %s preview", (action) => {
    const clip = publicManifest.clips[action];
    const path = publicPath(clip.preview);
    expect(existsSync(path), clip.preview).toBe(true);
    expect(statSync(path).size, clip.preview).toBeGreaterThan(0);
  });

  it("ships an RGBA poster PNG", () => {
    const header = readPngHeader(publicPath(publicManifest.poster));
    expect(header).toEqual({
      width: publicManifest.frame.width,
      height: publicManifest.frame.height,
      bitDepth: 8,
      colorType: 6,
    });
  });
});
