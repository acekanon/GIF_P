import { CaretDown, Check } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState } from "react";

export type AnimatedSelectOption<T extends string | number> = {
  value: T;
  label: string;
  note?: string;
};

type Props<T extends string | number> = {
  ariaLabel: string;
  value: T;
  options: Array<AnimatedSelectOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  compact?: boolean;
};

export function AnimatedSelect<T extends string | number>({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function openMenu(index = selectedIndex) {
    if (disabled) return;
    setOpen(true);
    setActiveIndex(index);
    window.requestAnimationFrame(() => optionRefs.current[index]?.focus());
  }

  function closeMenu({ restoreFocus = true } = {}) {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function selectOption(index: number) {
    const option = options[index];
    if (!option) return;
    if (option.value !== value) onChange(option.value);
    closeMenu();
  }

  function moveActive(nextIndex: number) {
    const bounded = Math.max(0, Math.min(options.length - 1, nextIndex));
    setActiveIndex(bounded);
    optionRefs.current[bounded]?.focus();
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : selectedIndex;
      openMenu(index);
    }
  }

  function onOptionKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(index === options.length - 1 ? 0 : index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(index === 0 ? options.length - 1 : index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOption(index);
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      closeMenu({ restoreFocus: event.key === "Escape" });
    }
  }

  return (
    <div className={`animated-select${open ? " open" : ""}${compact ? " compact" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="animated-select__trigger"
        aria-label={`${ariaLabel}：${selected?.label ?? "未选择"}`}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? closeMenu({ restoreFocus: false }) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span>
          <strong>{selected?.label}</strong>
          {selected?.note && <small>{selected.note}</small>}
        </span>
        <CaretDown weight="bold" aria-hidden="true" />
      </button>
      <div
        id={listboxId}
        className="animated-select__menu"
        role="listbox"
        aria-label={`${ariaLabel}选项`}
        aria-hidden={!open}
      >
        <div className="animated-select__menu-inner">
          {options.map((option, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node; }}
              key={String(option.value)}
              type="button"
              role="option"
              tabIndex={open && index === activeIndex ? 0 : -1}
              aria-selected={option.value === value}
              className={option.value === value ? "animated-select__option selected" : "animated-select__option"}
              onFocus={() => setActiveIndex(index)}
              onClick={() => selectOption(index)}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
            >
              <span><strong>{option.label}</strong>{option.note && <small>{option.note}</small>}</span>
              {option.value === value && <Check weight="bold" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
