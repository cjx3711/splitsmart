/**
 * A "?" next to a heading or label. The how-it-works copy lives in the popover,
 * not as a paragraph on the page: smoke dumps and everyday reading stay short.
 *
 * The popover is portaled to document.body. Several parents (the group aside,
 * modal bodies) scroll, and an in-tree pop gets clipped. Mouse/pen hover opens
 * it; a following click must not toggle it shut. Phones have no hover, so tap
 * still toggles. Keyboard activate (Enter/Space) too.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

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
  const [coords, setCoords] = useState<{ top: number; left: number; above: boolean } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const lastPointer = useRef<string | null>(null);
  const popId = useId();

  function isInside(node: EventTarget | null): boolean {
    return Boolean(
      (node instanceof Node && rootRef.current?.contains(node)) ||
        (node instanceof Node && popRef.current?.contains(node)),
    );
  }

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    function place() {
      const btn = btnRef.current;
      const pop = popRef.current;
      if (!btn || !pop) return;
      const r = btn.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const popW = pop.offsetWidth;
      const popH = pop.offsetHeight;
      // A "?" in the right-hand group panel should grow left so the copy sits
      // over the aside, not the expense list. Same rule when the pop would
      // otherwise run off the viewport's right edge.
      const preferLeft = r.left + r.width / 2 > window.innerWidth * 0.55;
      let left = preferLeft ? r.right - popW : r.left;
      if (left + popW > window.innerWidth - margin) left = window.innerWidth - popW - margin;
      if (left < margin) left = margin;
      const below = r.bottom + gap;
      const aboveTop = r.top - gap - popH;
      const fitsBelow = below + popH <= window.innerHeight - margin;
      const placeAbove = !fitsBelow && aboveTop >= margin;
      setCoords({ top: placeAbove ? aboveTop : below, left, above: placeAbove });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!isInside(event.target)) setOpen(false);
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

  function hoverLeave(event: ReactPointerEvent) {
    if (!isHoverPointer(event.pointerType)) return;
    if (isInside(event.relatedTarget)) return;
    setOpen(false);
  }

  return (
    <span
      className="help-tip"
      ref={rootRef}
      onPointerEnter={(event) => {
        if (!isHoverPointer(event.pointerType)) return;
        setOpen(true);
      }}
      onPointerLeave={hoverLeave}
    >
      <button
        type="button"
        className="help-tip-btn"
        ref={btnRef}
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
      {open &&
        createPortal(
          <span
            className={coords?.above ? "help-tip-pop help-tip-pop-above" : "help-tip-pop"}
            id={popId}
            role="note"
            ref={popRef}
            style={coords ? { top: coords.top, left: coords.left } : { visibility: "hidden" }}
            onPointerEnter={(event) => {
              if (!isHoverPointer(event.pointerType)) return;
              setOpen(true);
            }}
            onPointerLeave={hoverLeave}
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
