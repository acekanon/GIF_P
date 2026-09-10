export type TrackedEffectKind = "label" | "highlight" | "soft_blur" | "blackout";

export type TrackedBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TrackedKeyframe = TrackedBox & {
  timeSeconds: number;
  confidence: number;
};

export type TrackedEffect = {
  id: string;
  sourceAssetId: string;
  kind: TrackedEffectKind;
  label: string;
  startSeconds: number;
  endSeconds: number;
  keyframes: TrackedKeyframe[];
  averageConfidence: number;
  lowConfidenceFrames: number;
  modelId: string;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeTrackedBox(box: TrackedBox): TrackedBox {
  const width = clamp(Number.isFinite(box.width) ? box.width : 20, 2, 100);
  const height = clamp(Number.isFinite(box.height) ? box.height : 20, 2, 100);
  return {
    x: clamp(Number.isFinite(box.x) ? box.x : 0, 0, 100 - width),
    y: clamp(Number.isFinite(box.y) ? box.y : 0, 0, 100 - height),
    width,
    height,
  };
}

export function normalizeTrackedKeyframes(keyframes: TrackedKeyframe[], startSeconds: number, endSeconds: number) {
  const start = Math.max(0, Math.min(startSeconds, endSeconds));
  const end = Math.max(start + 0.01, endSeconds);
  return keyframes
    .filter((frame) => Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= start - 0.001 && frame.timeSeconds <= end + 0.001)
    .map((frame) => ({
      ...normalizeTrackedBox(frame),
      timeSeconds: clamp(frame.timeSeconds, start, end),
      confidence: clamp(Number.isFinite(frame.confidence) ? frame.confidence : 0, 0, 1),
    }))
    .sort((left, right) => left.timeSeconds - right.timeSeconds)
    .filter((frame, index, items) => index === 0 || Math.abs(frame.timeSeconds - items[index - 1].timeSeconds) > 0.001);
}

function pointLineDistance(frame: TrackedKeyframe, start: TrackedKeyframe, end: TrackedKeyframe) {
  const span = Math.max(0.0001, end.timeSeconds - start.timeSeconds);
  const ratio = clamp((frame.timeSeconds - start.timeSeconds) / span, 0, 1);
  const predicted = {
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
    width: start.width + (end.width - start.width) * ratio,
    height: start.height + (end.height - start.height) * ratio,
  };
  return Math.max(
    Math.abs(frame.x - predicted.x),
    Math.abs(frame.y - predicted.y),
    Math.abs(frame.width - predicted.width),
    Math.abs(frame.height - predicted.height),
  );
}

export function simplifyTrackedKeyframes(keyframes: TrackedKeyframe[], tolerance = 0.7, maxKeyframes = 28): TrackedKeyframe[] {
  if (keyframes.length <= 2) return keyframes;
  const keep = new Set([0, keyframes.length - 1]);
  const visit = (from: number, to: number) => {
    let maxDistance = 0;
    let maxIndex = -1;
    for (let index = from + 1; index < to; index += 1) {
      const confidencePenalty = keyframes[index].confidence < 0.55 ? (0.55 - keyframes[index].confidence) * 4 : 0;
      const distance = pointLineDistance(keyframes[index], keyframes[from], keyframes[to]) + confidencePenalty;
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = index;
      }
    }
    if (maxIndex >= 0 && maxDistance > tolerance) {
      keep.add(maxIndex);
      visit(from, maxIndex);
      visit(maxIndex, to);
    }
  };
  visit(0, keyframes.length - 1);
  let result = [...keep].sort((left, right) => left - right).map((index) => keyframes[index]);
  if (result.length > maxKeyframes) {
    const budget = Math.max(2, maxKeyframes);
    const selected = new Set<number>([0, result.length - 1]);
    const weakFrames = result
      .map((frame, index) => ({ frame, index }))
      .filter(({ frame, index }) => index > 0 && index < result.length - 1 && frame.confidence < 0.55)
      .sort((left, right) => left.frame.confidence - right.frame.confidence);
    for (const { index } of weakFrames) {
      if (selected.size >= budget) break;
      selected.add(index);
    }
    const remaining = result.map((_, index) => index).filter((index) => !selected.has(index));
    const openSlots = budget - selected.size;
    for (let slot = 0; slot < openSlots && remaining.length; slot += 1) {
      const candidateIndex = Math.round((slot + 1) * (remaining.length + 1) / (openSlots + 1)) - 1;
      selected.add(remaining[Math.min(remaining.length - 1, Math.max(0, candidateIndex))]);
    }
    result = [...selected].sort((left, right) => left - right).map((index) => result[index]);
  }
  return result;
}

export function interpolateTrackedBox(effect: Pick<TrackedEffect, "keyframes">, timeSeconds: number): TrackedBox | null {
  const frames = effect.keyframes;
  if (!frames.length) return null;
  if (timeSeconds <= frames[0].timeSeconds) return normalizeTrackedBox(frames[0]);
  if (timeSeconds >= frames[frames.length - 1].timeSeconds) return normalizeTrackedBox(frames[frames.length - 1]);
  const nextIndex = frames.findIndex((frame) => frame.timeSeconds >= timeSeconds);
  const next = frames[Math.max(1, nextIndex)];
  const previous = frames[Math.max(0, nextIndex - 1)];
  const ratio = clamp((timeSeconds - previous.timeSeconds) / Math.max(0.0001, next.timeSeconds - previous.timeSeconds), 0, 1);
  return normalizeTrackedBox({
    x: previous.x + (next.x - previous.x) * ratio,
    y: previous.y + (next.y - previous.y) * ratio,
    width: previous.width + (next.width - previous.width) * ratio,
    height: previous.height + (next.height - previous.height) * ratio,
  });
}

export function trackedEffectConfidenceLabel(effect: Pick<TrackedEffect, "averageConfidence" | "lowConfidenceFrames">) {
  if (effect.averageConfidence >= 0.82 && effect.lowConfidenceFrames === 0) return "轨迹稳定";
  if (effect.averageConfidence >= 0.64) return effect.lowConfidenceFrames ? `建议检查 ${effect.lowConfidenceFrames} 处` : "轨迹可用";
  return "需要校正";
}

export function transformTrackedBoxForCrop(box: TrackedBox, crop: { left: number; top: number; right: number; bottom: number }) {
  const visibleWidth = Math.max(0.01, 100 - crop.left - crop.right);
  const visibleHeight = Math.max(0.01, 100 - crop.top - crop.bottom);
  return normalizeTrackedBox({
    x: (box.x - crop.left) / visibleWidth * 100,
    y: (box.y - crop.top) / visibleHeight * 100,
    width: box.width / visibleWidth * 100,
    height: box.height / visibleHeight * 100,
  });
}
