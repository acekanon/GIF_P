import { X } from "@phosphor-icons/react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export function IslandDrawer({
  open,
  title,
  eyebrow,
  reducedMotion,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  eyebrow?: string;
  reducedMotion?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className={`island-drawer-layer${reducedMotion ? " reduce-motion" : ""}`}>
      <button type="button" className="island-drawer-mask" aria-label={`关闭${title}抽屉`} onClick={onClose} />
      <aside
        ref={panelRef}
        className="island-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="island-drawer-head">
          <span>{eyebrow && <small>{eyebrow}</small>}<strong id={titleId}>{title}</strong></span>
          <button type="button" aria-label={`关闭${title}`} onClick={onClose}><X weight="bold" /></button>
        </header>
        <div className="island-drawer-body">{children}</div>
      </aside>
    </div>,
    document.querySelector(".gifp-v3") ?? document.body,
  );
}
