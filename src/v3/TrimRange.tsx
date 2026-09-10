import { useState } from "react";

type Props = {
  duration: number;
  start: number;
  end: number;
  effectiveDuration?: number;
  retainedRatio?: number;
  onStart: (value: number) => void;
  onEnd: (value: number) => void;
};

export function TrimRange({ duration, start, end, effectiveDuration, retainedRatio = 1, onStart, onEnd }: Props) {
  const [activeHandle, setActiveHandle] = useState<"start" | "end" | null>(null);
  const max = Math.max(0.1, duration || 0.1);
  const safeStart = Math.max(0, Math.min(start, max - 0.1));
  const safeEnd = Math.max(safeStart + 0.1, Math.min(end || max, max));
  const startPercent = (safeStart / max) * 100;
  const endPercent = (safeEnd / max) * 100;
  const handlesOverlap = endPercent - startPercent < 4;
  const rangeDuration = safeEnd - safeStart;
  const safeRetainedRatio = Math.max(0, Math.min(1, retainedRatio));
  const effectiveEndPercent = startPercent + (endPercent - startPercent) * safeRetainedRatio;
  const hasDeletedDuration = safeRetainedRatio < 0.999;
  const durationLabel = effectiveDuration != null && effectiveDuration < rangeDuration - 0.05
    ? `导出 ${effectiveDuration.toFixed(1)}s`
    : `${rangeDuration.toFixed(1)}s`;

  return (
    <div className="trim-range" aria-label="时间范围">
      <div className="trim-range__labels"><span>开始 {safeStart.toFixed(1)}s</span><strong>{durationLabel}</strong><span>结束 {safeEnd.toFixed(1)}s</span></div>
      <div className={`trim-range__rail${handlesOverlap ? " handles-overlap" : ""}`}>
        <span className={`trim-range__selected${hasDeletedDuration ? " has-deletions" : ""}`} style={{ left: `${startPercent}%`, right: `${100 - endPercent}%` }} />
        <span
          className="trim-range__effective"
          role="progressbar"
          aria-label="删除后导出长度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(safeRetainedRatio * 100)}
          style={{ left: `${startPercent}%`, right: `${100 - effectiveEndPercent}%` }}
        />
        <input
          aria-label="开始时间"
          className="trim-range__input start"
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={safeStart}
          style={{ zIndex: activeHandle === "start" ? 5 : handlesOverlap ? 4 : 3 }}
          onPointerDown={() => setActiveHandle("start")}
          onFocus={() => setActiveHandle("start")}
          onBlur={() => setActiveHandle(null)}
          onChange={(event) => onStart(Math.min(Number(event.target.value), safeEnd - 0.1))}
        />
        <input
          aria-label="结束时间"
          className="trim-range__input end"
          type="range"
          min={0.1}
          max={max}
          step={0.1}
          value={safeEnd}
          style={{ zIndex: activeHandle === "end" ? 5 : handlesOverlap ? 3 : 4 }}
          onPointerDown={() => setActiveHandle("end")}
          onFocus={() => setActiveHandle("end")}
          onBlur={() => setActiveHandle(null)}
          onChange={(event) => onEnd(Math.max(Number(event.target.value), safeStart + 0.1))}
        />
      </div>
    </div>
  );
}
