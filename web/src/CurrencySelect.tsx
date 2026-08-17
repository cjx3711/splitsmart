/**
 * A searchable currency picker.
 *
 * A plain <select> with 168 options (see src/db/currencies.ts) is unusable by
 * typing — nothing lets you jump to "SGD" without scrolling past everything
 * alphabetically before it. This filters by code, name, or symbol, and pins a
 * handful of commonly-used currencies at the top of the unfiltered list so the
 * common case never needs to type at all.
 *
 * Positioned with `fixed`, not `absolute`: the menu lives inside the add-expense
 * dialog's scrollable body (`.modal-body { overflow-y: auto }`), which would
 * otherwise clip a long dropdown.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useCurrencies } from "./money.tsx";
import { type Currency } from "./api.ts";

/** Used only when the signed-in user has no expense history of their own yet. */
const FALLBACK_POPULAR_CODES = ["USD", "EUR", "GBP", "CAD", "AUD", "INR", "JPY", "CNY", "SGD", "CHF"];

function label(c: Currency): string {
  return c.symbol ? `${c.code} · ${c.symbol}` : c.code;
}

function matches(c: Currency, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    c.code.toLowerCase().includes(q) ||
    c.name.toLowerCase().includes(q) ||
    (c.symbol?.toLowerCase().includes(q) ?? false)
  );
}

export function CurrencySelect({
  id,
  value,
  onChange,
  codes,
}: {
  id?: string;
  value: string;
  onChange: (code: string) => void;
  /** Restrict the list to these codes, e.g. currencies already in play. */
  codes?: string[];
}) {
  const { currencies, frequentCodes } = useCurrencies();
  const pinnedCodes = frequentCodes.length > 0 ? frequentCodes : FALLBACK_POPULAR_CODES;
  const pinnedLabel = frequentCodes.length > 0 ? "Frequently used" : "Popular";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [menuStyle, setMenuStyle] = useState<{ top: number; left: number; width: number }>();

  const available = useMemo(
    () => (codes ? currencies.filter((c) => codes.includes(c.code)) : currencies),
    [currencies, codes],
  );

  const selected = available.find((c) => c.code === value);

  const { results, pinnedCount } = useMemo(() => {
    const filtered = available.filter((c) => matches(c, query));
    if (query.trim()) {
      return { results: filtered.sort((a, b) => a.code.localeCompare(b.code)), pinnedCount: 0 };
    }
    const pinned = pinnedCodes.map((code) => filtered.find((c) => c.code === code)).filter(
      (c): c is Currency => c !== undefined,
    );
    const rest = filtered
      .filter((c) => !pinnedCodes.includes(c.code))
      .sort((a, b) => a.code.localeCompare(b.code));
    return { results: [...pinned, ...rest], pinnedCount: pinned.length };
  }, [available, query, pinnedCodes]);

  useEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuStyle({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
    setQuery("");
    setHighlighted(0);
  }, [open]);

  // The search input only exists in the DOM once `menuStyle` is set (it's
  // gated on `open && menuStyle` below), so focusing it has to wait for that
  // render rather than happen in the effect above — inputRef is still null there.
  useEffect(() => {
    if (open && menuStyle) inputRef.current?.focus();
  }, [open, menuStyle]);

  useEffect(() => {
    if (!open) return;
    const option = listRef.current?.querySelectorAll("[role=option]")[highlighted];
    option?.scrollIntoView({ block: "nearest" });
  }, [highlighted, open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onScrollOrResize(e: Event) {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  function select(code: string) {
    onChange(code);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = results[highlighted];
      if (pick) select(pick.code);
    }
  }

  return (
    <div className="currency-select" ref={containerRef}>
      <button
        type="button"
        id={id}
        ref={buttonRef}
        className="currency-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {selected ? label(selected) : value}
        <span aria-hidden="true" className="currency-select-caret">
          ▾
        </span>
      </button>

      {open && menuStyle && (
        <div
          className="currency-select-menu"
          style={{ top: menuStyle.top, left: menuStyle.left, width: Math.max(menuStyle.width, 220) }}
        >
          <input
            ref={inputRef}
            type="text"
            className="currency-select-search"
            placeholder="Search currencies…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlighted(0);
            }}
            onKeyDown={onKeyDown}
          />
          <ul role="listbox" className="currency-select-list" ref={listRef}>
            {results.length === 0 && <li className="currency-select-empty">No matches</li>}
            {pinnedCount > 0 && <li className="currency-select-group-label">{pinnedLabel}</li>}
            {results.map((c, i) => (
              <li key={c.code}>
                {i === pinnedCount && pinnedCount > 0 && (
                  <div className="currency-select-divider" />
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={c.code === value}
                  className={`currency-select-option${i === highlighted ? " highlighted" : ""}${
                    c.code === value ? " selected" : ""
                  }`}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => select(c.code)}
                >
                  <span className="currency-select-code">{label(c)}</span>
                  <span className="currency-select-name">{c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
