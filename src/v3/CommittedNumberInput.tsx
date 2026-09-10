import { useEffect, useRef, useState } from "react";

export function CommittedNumberInput({
  ariaLabel,
  value,
  min,
  max,
  step = 1,
  className,
  onCommit,
}: {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const discardOnBlur = useRef(false);

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit(rawDraft: string) {
    const parsed = Number(rawDraft);
    if (discardOnBlur.current || rawDraft.trim() === "" || !Number.isFinite(parsed)) {
      discardOnBlur.current = false;
      setDraft(String(value));
      return;
    }
    const precision = String(step).split(".")[1]?.length ?? 0;
    const rounded = Math.round(parsed / step) * step;
    const normalized = Number(Math.max(min, Math.min(max, rounded)).toFixed(precision));
    setDraft(String(normalized));
    if (normalized !== value) onCommit(normalized);
  }

  return (
    <input
      aria-label={ariaLabel}
      className={className}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => { discardOnBlur.current = false; }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          discardOnBlur.current = true;
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}
