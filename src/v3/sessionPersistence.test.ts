import { describe, expect, it } from "vitest";
import {
  SESSION_DRAFT_KEY,
  SESSION_DRAFT_MAX_AGE_MS,
  clearSessionDraft,
  createSessionDraftEnvelope,
  markSessionAssetAvailability,
  readSessionDraft,
  serializeSessionDraft,
  sessionDraftFingerprint,
  shouldWriteSessionDraft,
  type SessionDraftData,
  writeSessionDraft,
} from "./sessionPersistence";

const draft: SessionDraftData = {
  mode: "editor",
  assets: [{
    id: "asset-1",
    path: "D:\\clips\\demo.gif",
    name: "demo.gif",
    kind: "gif",
    duration: 4.2,
    pathAvailability: { state: "unchecked" },
  }],
  activeAssetId: "asset-1",
  activeAssetPath: "D:\\clips\\demo.gif",
  mergePaths: [],
  outputDir: "D:\\exports",
  editor: {
    presetId: "perceptual",
    encoder: "pngquant_opt",
    deliveryIntent: "smart",
    deliveryFormatPreference: "gif",
    targetPlatform: "modern_web",
    platformPolicyId: "web_animation",
    playbackSpeed: 1,
    cropEnabled: false,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    loopOutput: true,
    width: 420,
    fps: 15,
    colors: 112,
    dither: "sierra2_4a",
    lossy: 28,
    optimizeLevel: 3,
    generationMode: "best_gif",
    targetSizeMb: 2,
    bayerScale: 2,
    alphaThreshold: 128,
    perceptualFocus: "auto",
    filter: "vivid",
    outputFormat: "gif",
    startSeconds: 0.5,
    endSeconds: 3.5,
    selectedFrameTimes: [1],
    deletedFrameTimes: [2],
    memeOverlay: null,
  },
};

function memoryStorage(initial?: string) {
  const entries = new Map<string, string>();
  if (initial !== undefined) entries.set(SESSION_DRAFT_KEY, initial);
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

describe("session persistence", () => {
  it("round-trips a versioned last-session draft", () => {
    const storage = memoryStorage();
    expect(writeSessionDraft(storage, draft, 10_000)).toBe(true);
    expect(readSessionDraft(storage, 11_500)).toEqual({
      status: "ready",
      draft: createSessionDraftEnvelope(draft, 10_000),
      ageMs: 1_500,
    });
  });

  it("persists volume direction and editable privacy trajectories", () => {
    const enhanced: SessionDraftData = {
      ...draft,
      editor: {
        ...draft.editor,
        volumeDirectorEnabled: true,
        volumeDirectorPriority: "text",
        trackedEffects: [{
          id: "track-private",
          sourceAssetId: "asset-1",
          kind: "blackout",
          label: "",
          startSeconds: 0.5,
          endSeconds: 3.5,
          keyframes: [
            { timeSeconds: 0.5, x: 20, y: 25, width: 18, height: 20, confidence: 1 },
            { timeSeconds: 3.5, x: 36, y: 31, width: 18, height: 20, confidence: 0.8 },
          ],
          averageConfidence: 0.9,
          lowConfidenceFrames: 0,
          modelId: "gifp.zero-mean-template.v1",
        }],
      },
    };
    const storage = memoryStorage();
    expect(writeSessionDraft(storage, enhanced, 20_000)).toBe(true);
    expect(readSessionDraft(storage, 20_500)).toMatchObject({
      status: "ready",
      draft: { data: { editor: {
        volumeDirectorPriority: "text",
        trackedEffects: [expect.objectContaining({ id: "track-private", kind: "blackout" })],
      } } },
    });
  });

  it("rejects expired, damaged, and future-version data without throwing", () => {
    const expired = memoryStorage(serializeSessionDraft(draft, 1_000));
    expect(readSessionDraft(expired, 1_001 + SESSION_DRAFT_MAX_AGE_MS)).toEqual({
      status: "expired",
      savedAt: 1_000,
    });
    expect(readSessionDraft(memoryStorage("{nope"), 2_000)).toEqual({
      status: "corrupt",
      reason: "invalid-json",
    });
    expect(readSessionDraft(memoryStorage(JSON.stringify({ version: 2, savedAt: 2_000, data: draft })), 2_000)).toEqual({
      status: "unsupported",
      version: 2,
    });
    expect(readSessionDraft(memoryStorage(JSON.stringify({ version: 1, savedAt: 2_000, data: {} })), 2_000)).toEqual({
      status: "corrupt",
      reason: "invalid-schema",
    });
  });

  it("contains storage failures and supports explicit clearing", () => {
    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("full"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readSessionDraft(broken)).toEqual({ status: "corrupt", reason: "storage-unavailable" });
    expect(writeSessionDraft(broken, draft)).toBe(false);
    expect(clearSessionDraft(broken)).toBe(false);

    const storage = memoryStorage();
    writeSessionDraft(storage, draft);
    expect(clearSessionDraft(storage)).toBe(true);
    expect(readSessionDraft(storage)).toEqual({ status: "empty" });
  });

  it("provides a pure throttle decision and stable content fingerprint", () => {
    const fingerprint = sessionDraftFingerprint(draft);
    expect(shouldWriteSessionDraft(null, fingerprint, null, 100)).toBe(true);
    expect(shouldWriteSessionDraft(fingerprint, fingerprint, 0, 10_000)).toBe(false);
    expect(shouldWriteSessionDraft("old", fingerprint, 500, 1_000, 800)).toBe(false);
    expect(shouldWriteSessionDraft("old", fingerprint, 500, 1_300, 800)).toBe(true);
    expect(sessionDraftFingerprint({ ...draft, outputDir: draft.outputDir })).toBe(fingerprint);
  });

  it("records path checks supplied by the desktop layer without touching the filesystem", () => {
    const asset = draft.assets[0];
    expect(markSessionAssetAvailability(asset, "available", 12_345).pathAvailability).toEqual({
      state: "available",
      checkedAt: 12_345,
    });
    expect(markSessionAssetAvailability(asset, "unchecked", 12_345).pathAvailability).toEqual({ state: "unchecked" });
  });
});
