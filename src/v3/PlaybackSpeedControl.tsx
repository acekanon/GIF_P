import type { CSSProperties } from "react";

type Props = {
  value: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
};

function normalizeSpeed(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(3, Math.max(1, value)) * 10) / 10;
}

function speedLabel(value: number) {
  return Number.isInteger(value) ? `${value}×` : `${value.toFixed(1)}×`;
}

export function PlaybackSpeedControl({ value, onChange, ariaLabel = "输出速度" }: Props) {
  const speed = normalizeSpeed(value);
  return (
    <div className="speed-control" role="group" aria-label={ariaLabel}>
      <div className="speed-control__readout"><span>1.0×</span><strong>{speedLabel(speed)}</strong><span>3.0×</span></div>
      <input
        className="speed-control__slider"
        aria-label={`${ariaLabel}滑杆`}
        type="range"
        min={1}
        max={3}
        step={0.1}
        value={speed}
        style={{ "--speed-progress": `${((speed - 1) / 2) * 100}%` } as CSSProperties}
        onChange={(event) => onChange(normalizeSpeed(Number(event.target.value)))}
      />
      <div className="speed-control__shortcuts">
        {[1, 2].map((shortcut) => (
          <button
            key={shortcut}
            type="button"
            aria-pressed={speed === shortcut}
            className={speed === shortcut ? "selected" : ""}
            onClick={() => onChange(shortcut)}
          >
            {shortcut}×
          </button>
        ))}
      </div>
    </div>
  );
}
