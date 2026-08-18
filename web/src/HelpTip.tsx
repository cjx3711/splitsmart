/**
 * A "?" next to a heading or label. The how-it-works copy lives in the popover,
 * not as a paragraph on the page: smoke dumps and everyday reading stay short.
 *
 * Mouse/pen hover opens it; a following click must not toggle it shut. Phones
 * have no hover, so tap still toggles. Keyboard activate (Enter/Space) too.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

function isHoverPointer(type: string): boolean {
  return type === "mouse" || type === "pen";
}

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
  const lastPointer = useRef<string | null>(null);
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
    <span
      className="help-tip"
      ref={rootRef}
      onPointerEnter={(event) => {
        if (!isHoverPointer(event.pointerType)) return;
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (!isHoverPointer(event.pointerType)) return;
        setOpen(false);
      }}
    >
      <button
        type="button"
        className="help-tip-btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onPointerDown={(event) => {
          lastPointer.current = event.pointerType;
        }}
        onClick={() => {
          const type = lastPointer.current;
          lastPointer.current = null;
          if (type && isHoverPointer(type)) return;
          setOpen((value) => !value);
        }}
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
