import { Minus, Plus } from "@phosphor-icons/react";
import { useEffect, useId, useState } from "react";

type Props = {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  openSignal?: string | number | boolean;
  tone?: "aqua" | "green" | "yellow" | "coral";
  children: React.ReactNode;
};

export function CollapsibleSection({
  title,
  summary,
  defaultOpen = false,
  openSignal,
  tone = "aqua",
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  return (
    <section className={`collapsible-section tone-${tone}${open ? " open" : ""}`}>
      <button
        type="button"
        className="collapsible-section__trigger"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        <i className="collapsible-section__toggle" aria-hidden="true">{open ? <Minus weight="bold" /> : <Plus weight="bold" />}</i>
        <span><strong>{title}</strong>{summary && <small>{summary}</small>}</span>
      </button>
      <div id={bodyId} className="collapsible-section__wrap" aria-hidden={!open}>
        <div className="collapsible-section__body">{children}</div>
      </div>
    </section>
  );
}
