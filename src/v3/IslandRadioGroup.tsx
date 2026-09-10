import { Check } from "@phosphor-icons/react";
import { useId } from "react";

export type IslandRadioOption<T extends string | number> = {
  value: T;
  label: string;
  note?: string;
  disabled?: boolean;
};

export function IslandRadioGroup<T extends string | number>({
  ariaLabel,
  value,
  options,
  direction = "vertical",
  compact = false,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: Array<IslandRadioOption<T>>;
  direction?: "horizontal" | "vertical";
  compact?: boolean;
  onChange: (value: T) => void;
}) {
  const groupName = `gifp-island-radio-${useId().replace(/:/g, "")}`;

  return (
    <div
      className={`island-radio-group ${direction}${compact ? " compact" : ""}`}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label
            className={`island-radio${checked ? " checked" : ""}${option.disabled ? " disabled" : ""}`}
            key={String(option.value)}
          >
            <span className="island-radio__control">
              <input
                type="radio"
                name={groupName}
                value={String(option.value)}
                checked={checked}
                disabled={option.disabled}
                onChange={() => onChange(option.value)}
              />
              <span className="island-radio__splash" aria-hidden="true" />
              <Check className="island-radio__check" weight="bold" aria-hidden="true" />
            </span>
            <span className="island-radio__copy">
              <strong>{option.label}</strong>
              {option.note && <small>{option.note}</small>}
            </span>
          </label>
        );
      })}
    </div>
  );
}
