/**
 * A "?" next to a heading or label. The how-it-works copy lives in the popover,
 * not as a paragraph on the page: smoke dumps and everyday reading stay short.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function HelpTip({
  label,
  children,
}: {
  /** Accessible name. Shown as the button's aria-label, not on the page. */
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <span className="help-tip" ref={rootRef}>
      <button
        type="button"
        className="help-tip-btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        ?
      </button>
      {open && (
        <span className="help-tip-pop" id={popId} role="note">
          {children}
        </span>
      )}
    </span>
  );
}
