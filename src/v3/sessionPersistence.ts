import type {
  DeliveryIntent,
  FilterStyle,
  GifEncoder,
  GifGenerationMode,
  OutputFormat,
  PerceptualFocus,
  TargetPlatform,
} from "../tauri";
import type { MemeOverlaySettings } from "./MemeWorkspace";
import type { CompressionPresetId, CropInsets, DitherId, FrameTimingMode } from "./editorModel";
import type { DeliveryFormatPreference } from "./deliveryModel";
import type { PlatformPolicyId } from "./platformPolicy";
import type { TrackedEffect } from "./trackedEffectsModel";
import type { VolumeDirectorPriority } from "./volumeDirectorModel";

export const SESSION_DRAFT_KEY = "gifp.last-session.v1";
export const SESSION_DRAFT_VERSION = 1 as const;
export const SESSION_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_DRAFT_WRITE_INTERVAL_MS = 800;

export type SessionPathAvailability = {
  state: "unchecked" | "available" | "missing";
  checkedAt?: number;
};

export type SessionAssetReference = {
  id: string;
  path: string;
  name: string;
  kind: "gif" | "webp" | "apng" | "video" | "image";
  duration?: number;
  dimensions?: string;
  frameCount?: number;
  animated?: boolean;
  hasAlpha?: boolean;
  codec?: string;
  pathAvailability: SessionPathAvailability;
};

/**
 * Durable user intent only. Runtime URLs, thumbnails, encoder results, progress,
 * and open drawer state are deliberately excluded because they are ephemeral.
 */
export type SessionDraftData = {
  mode: "quick" | "editor" | "merge" | "record" | "meme" | "poster";
  assets: SessionAssetReference[];
  activeAssetId: string;
  activeAssetPath?: string;
  mergePaths: string[];
  outputDir: string;
  editor: {
    presetId: CompressionPresetId;
    encoder: GifEncoder;
    deliveryIntent: DeliveryIntent;
    deliveryFormatPreference: DeliveryFormatPreference;
    targetPlatform: TargetPlatform;
    platformPolicyId?: PlatformPolicyId;
    playbackSpeed: number;
    cropEnabled: boolean;
    crop: CropInsets;
    loopOutput: boolean;
    width: number;
    fps: number;
    colors: number;
    dither: DitherId;
    lossy: number;
    optimizeLevel: number;
    generationMode: GifGenerationMode;
    targetSizeMb: number;
    bayerScale: number;
    alphaThreshold: number;
    perceptualFocus: PerceptualFocus;
    filter: FilterStyle;
    outputFormat: OutputFormat;
    startSeconds: number;
    endSeconds: number;
    selectedFrameTimes: number[];
    deletedFrameTimes: number[];
    frameTimingMode?: FrameTimingMode;
    memeOverlay: MemeOverlaySettings | null;
    volumeDirectorEnabled?: boolean;
    volumeDirectorPriority?: VolumeDirectorPriority;
    trackedEffects?: TrackedEffect[];
  };
};

export type SessionDraftEnvelope = {
  version: typeof SESSION_DRAFT_VERSION;
  savedAt: number;
  data: SessionDraftData;
};

export type SessionDraftReadResult =
  | { status: "empty" }
  | { status: "ready"; draft: SessionDraftEnvelope; ageMs: number }
  | { status: "expired"; savedAt: number }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasString(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "string";
}

function hasNumber(record: Record<string, unknown>, key: string) {
  return isFiniteNumber(record[key]);
}

function isNumberArray(value: unknown) {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isCropInsets(value: unknown): value is CropInsets {
  if (!isRecord(value)) return false;
  return ["left", "top", "right", "bottom"].every((key) => hasNumber(value, key));
}

function isTrackedEffect(value: unknown): value is TrackedEffect {
  if (!isRecord(value)) return false;
  if (!["label", "highlight", "soft_blur", "blackout"].includes(String(value.kind))) return false;
  if (!["id", "sourceAssetId", "label", "modelId"].every((key) => hasString(value, key))) return false;
  if (!["startSeconds", "endSeconds", "averageConfidence", "lowConfidenceFrames"].every((key) => hasNumber(value, key))) return false;
  return Array.isArray(value.keyframes) && value.keyframes.every((frame) => (
    isRecord(frame)
    && ["timeSeconds", "x", "y", "width", "height", "confidence"].every((key) => hasNumber(frame, key))
  ));
}

function isPathAvailability(value: unknown): value is SessionPathAvailability {
  if (!isRecord(value) || !["unchecked", "available", "missing"].includes(String(value.state))) return false;
  return value.checkedAt === undefined || isFiniteNumber(value.checkedAt);
}

function isAssetReference(value: unknown): value is SessionAssetReference {
  if (!isRecord(value)) return false;
  return hasString(value, "id")
    && hasString(value, "path")
    && hasString(value, "name")
    && ["gif", "webp", "apng", "video", "image"].includes(String(value.kind))
    && isPathAvailability(value.pathAvailability);
}

function isEditorDraft(value: unknown): value is SessionDraftData["editor"] {
  if (!isRecord(value)) return false;
  const requiredStrings = [
    "presetId", "encoder", "deliveryIntent", "deliveryFormatPreference", "targetPlatform",
    "dither", "generationMode", "perceptualFocus", "filter", "outputFormat",
  ];
  const requiredNumbers = [
    "playbackSpeed", "width", "fps", "colors", "lossy", "optimizeLevel",
    "targetSizeMb", "bayerScale", "alphaThreshold", "startSeconds", "endSeconds",
  ];
  return requiredStrings.every((key) => hasString(value, key))
    && (value.platformPolicyId === undefined || typeof value.platformPolicyId === "string")
    && requiredNumbers.every((key) => hasNumber(value, key))
    && typeof value.cropEnabled === "boolean"
    && typeof value.loopOutput === "boolean"
    && isCropInsets(value.crop)
    && isNumberArray(value.selectedFrameTimes)
    && isNumberArray(value.deletedFrameTimes)
    && (value.frameTimingMode === undefined || ["compact", "preserve"].includes(String(value.frameTimingMode)))
    && (value.memeOverlay === null || isRecord(value.memeOverlay))
    && (value.volumeDirectorEnabled === undefined || typeof value.volumeDirectorEnabled === "boolean")
    && (value.volumeDirectorPriority === undefined
      || ["balanced", "clarity", "motion", "text", "smallest"].includes(String(value.volumeDirectorPriority)))
    && (value.trackedEffects === undefined
      || (Array.isArray(value.trackedEffects) && value.trackedEffects.every(isTrackedEffect)));
}

export function isSessionDraftData(value: unknown): value is SessionDraftData {
  if (!isRecord(value)) return false;
  return ["quick", "editor", "merge", "record", "meme", "poster"].includes(String(value.mode))
    && Array.isArray(value.assets)
    && value.assets.every(isAssetReference)
    && hasString(value, "activeAssetId")
    && (value.activeAssetPath === undefined || typeof value.activeAssetPath === "string")
    && Array.isArray(value.mergePaths)
    && value.mergePaths.every((path) => typeof path === "string")
    && hasString(value, "outputDir")
    && isEditorDraft(value.editor);
}

export function createSessionDraftEnvelope(
  data: SessionDraftData,
  savedAt = Date.now(),
): SessionDraftEnvelope {
  return { version: SESSION_DRAFT_VERSION, savedAt, data };
}

export function serializeSessionDraft(data: SessionDraftData, savedAt = Date.now()) {
  return JSON.stringify(createSessionDraftEnvelope(data, savedAt));
}

export function readSessionDraft(
  storage: SessionStorageLike,
  now = Date.now(),
  maxAgeMs = SESSION_DRAFT_MAX_AGE_MS,
): SessionDraftReadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_DRAFT_KEY);
  } catch {
    return { status: "corrupt", reason: "storage-unavailable" };
  }
  if (raw === null) return { status: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt", reason: "invalid-json" };
  }
  if (!isRecord(parsed)) return { status: "corrupt", reason: "invalid-envelope" };
  if (!isFiniteNumber(parsed.version)) return { status: "corrupt", reason: "missing-version" };
  if (parsed.version !== SESSION_DRAFT_VERSION) {
    return { status: "unsupported", version: parsed.version };
  }
  if (!isFiniteNumber(parsed.savedAt) || !isSessionDraftData(parsed.data)) {
    return { status: "corrupt", reason: "invalid-schema" };
  }
  const ageMs = Math.max(0, now - parsed.savedAt);
  if (ageMs > maxAgeMs) return { status: "expired", savedAt: parsed.savedAt };
  return { status: "ready", draft: parsed as SessionDraftEnvelope, ageMs };
}

export function writeSessionDraft(
  storage: SessionStorageLike,
  data: SessionDraftData,
  savedAt = Date.now(),
): boolean {
  try {
    storage.setItem(SESSION_DRAFT_KEY, serializeSessionDraft(data, savedAt));
    return true;
  } catch {
    return false;
  }
}

export function clearSessionDraft(storage: SessionStorageLike): boolean {
  try {
    storage.removeItem(SESSION_DRAFT_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Pure scheduling decision for a React effect or other caller-owned timer. */
export function shouldWriteSessionDraft(
  previousFingerprint: string | null,
  nextFingerprint: string,
  lastWriteAt: number | null,
  now: number,
  intervalMs = SESSION_DRAFT_WRITE_INTERVAL_MS,
) {
  if (previousFingerprint === nextFingerprint) return false;
  return lastWriteAt === null || now - lastWriteAt >= intervalMs;
}

/** A stable comparison value; savedAt is intentionally not included. */
export function sessionDraftFingerprint(data: SessionDraftData) {
  return JSON.stringify(data);
}

export function markSessionAssetAvailability(
  asset: SessionAssetReference,
  state: SessionPathAvailability["state"],
  checkedAt = Date.now(),
): SessionAssetReference {
  return {
    ...asset,
    pathAvailability: state === "unchecked" ? { state } : { state, checkedAt },
  };
}

// Integration-friendly aliases. Keep the versioned names above as the canonical
// API while the main application can read naturally at the call site.
export const LAST_SESSION_KEY = SESSION_DRAFT_KEY;
export const createLastSessionDraft = createSessionDraftEnvelope;
export const readLastSession = readSessionDraft;
export const writeLastSession = writeSessionDraft;
export const clearLastSession = clearSessionDraft;
