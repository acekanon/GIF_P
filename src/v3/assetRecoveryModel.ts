export type RecoverableAssetKind = "gif" | "webp" | "apng" | "video" | "image";

export type AssetReplacementSource = {
  id: string;
  path: string;
  name: string;
  kind: RecoverableAssetKind;
};

export type AssetReplacementPlan = {
  assetId: string;
  oldPath: string;
  newPath: string;
  name: string;
  kind: RecoverableAssetKind;
};

export type AssetReplacementPlanResult =
  | { ok: true; plan: AssetReplacementPlan }
  | { ok: false; reason: "empty-path" | "unsupported-format" };

export type AssetReplacementStatePolicy = {
  preserveAssetIdentity: true;
  preserveEditState: boolean;
  clearRuntimeState: true;
};

export type ReplaceableAsset = AssetReplacementSource & {
  sourceUrl?: string;
  thumbnailUrl?: string;
  thumbs?: unknown[];
  duration?: number;
  dimensions?: string;
  frameCount?: number;
  animated?: boolean;
  hasAlpha?: boolean;
  codec?: string;
  aspect?: number;
  result?: unknown;
  comparisonSnapshot?: unknown;
  error?: string;
  timelineError?: string;
  status?: string;
  [key: string]: unknown;
};

export type RuntimeAssetKey =
  | "sourceUrl"
  | "thumbnailUrl"
  | "thumbs"
  | "duration"
  | "dimensions"
  | "frameCount"
  | "animated"
  | "hasAlpha"
  | "codec"
  | "aspect"
  | "result"
  | "comparisonSnapshot"
  | "error"
  | "timelineError";

export type RecoveredAsset<T extends ReplaceableAsset> = Omit<T, RuntimeAssetKey | "path" | "name" | "kind" | "status"> & {
  path: string;
  name: string;
  kind: RecoverableAssetKind;
  status: "等待";
};

const EXTENSION_KIND: Readonly<Record<string, RecoverableAssetKind>> = {
  gif: "gif",
  webp: "webp",
  apng: "apng",
  png: "image",
  jpg: "image",
  jpeg: "image",
  mp4: "video",
  mov: "video",
  mkv: "video",
  webm: "video",
};

function windowsPathKey(path: string): string {
  return path.trim().replace(/\//g, "\\").toLocaleLowerCase("en-US");
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function assetKindFromPath(path: string): RecoverableAssetKind | null {
  const filename = basename(path.trim());
  const extension = filename.match(/\.([^.]+)$/)?.[1]?.toLocaleLowerCase("en-US");
  return extension ? EXTENSION_KIND[extension] ?? null : null;
}

/** Validates a user-selected replacement and describes the durable identity update. */
export function planAssetReplacement(
  asset: AssetReplacementSource,
  selectedPath: string,
): AssetReplacementPlanResult {
  const newPath = selectedPath.trim();
  if (!newPath) return { ok: false, reason: "empty-path" };
  const kind = assetKindFromPath(newPath);
  if (!kind) return { ok: false, reason: "unsupported-format" };
  return {
    ok: true,
    plan: {
      assetId: asset.id,
      oldPath: asset.path,
      newPath,
      name: basename(newPath),
      kind,
    },
  };
}

/**
 * Replaces every reference to the old path, then removes Windows-equivalent
 * duplicates while retaining the first occurrence and its original order.
 */
export function replaceMergePaths(
  paths: readonly string[],
  oldPath: string,
  newPath: string,
): string[] {
  const oldKey = windowsPathKey(oldPath);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const replacement = windowsPathKey(path) === oldKey ? newPath : path;
    const key = windowsPathKey(replacement);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(replacement);
  }
  return result;
}

/** A plan keeps editor associations only when it still targets this asset/path. */
export function replacementStatePolicy(
  asset: AssetReplacementSource,
  plan: AssetReplacementPlan,
): AssetReplacementStatePolicy {
  return {
    preserveAssetIdentity: true,
    preserveEditState: asset.id === plan.assetId && windowsPathKey(asset.path) === windowsPathKey(plan.oldPath),
    clearRuntimeState: true,
  };
}

/**
 * Keeps the asset identity (and caller-owned edit state keyed by it), but
 * deliberately invalidates every value derived from the previous file.
 * sourceUrl is omitted because URL creation belongs to the integration layer.
 */
export function applyAssetReplacement<T extends ReplaceableAsset>(
  asset: T,
  plan: AssetReplacementPlan,
): RecoveredAsset<T> {
  const policy = replacementStatePolicy(asset, plan);
  if (!policy.preserveEditState) throw new Error("asset-replacement-plan-mismatch");
  const {
    sourceUrl: _sourceUrl,
    thumbnailUrl: _thumbnailUrl,
    thumbs: _thumbs,
    duration: _duration,
    dimensions: _dimensions,
    frameCount: _frameCount,
    animated: _animated,
    hasAlpha: _hasAlpha,
    codec: _codec,
    aspect: _aspect,
    result: _result,
    comparisonSnapshot: _comparisonSnapshot,
    error: _error,
    timelineError: _timelineError,
    ...durable
  } = asset;
  return {
    ...durable,
    id: asset.id,
    path: plan.newPath,
    name: plan.name,
    kind: plan.kind,
    status: "等待",
  } as RecoveredAsset<T>;
}
