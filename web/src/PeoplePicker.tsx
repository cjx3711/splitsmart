/**
 * "With you and: [Jia J. ×] [Bob ×]": who the expense is between.
 *
 * Behaves like an email To: field, because that is the interaction people
 * already know: type to filter, Enter to add the top match, Backspace on an
 * empty box to take the last one back off.
 *
 * You are always on your own expense and cannot be removed; every screen in
 * this app shows an expense from your side of it, and one you are not part of
 * has nowhere to appear. The server enforces the same rule.
 */
import { useMemo, useRef, useState } from "react";

export interface Person {
  id: string;
  label: string;
}

export function PeoplePicker({
  candidates,
  selectedIds,
  onChange,
  lockedId,
  disabled = false,
  emptyHint = "Search your friends by name",
}: {
  candidates: Person[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Cannot be removed. Normally you. */
  lockedId?: string;
  disabled?: boolean;
  emptyHint?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(candidates.map((p) => [p.id, p])), [candidates]);
  const selected = selectedIds
    .map((id) => byId.get(id))
    .filter((p): p is Person => p !== undefined);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates
      .filter((p) => !selectedIds.includes(p.id))
      .filter((p) => q === "" || p.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, selectedIds, query]);

  function add(person: Person) {
    onChange([...selectedIds, person.id]);
    setQuery("");
    setHighlighted(0);
    inputRef.current?.focus();
  }

  function remove(id: string) {
    if (id === lockedId) return;
    onChange(selectedIds.filter((x) => x !== id));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      // Never submit the form from this box: Enter here means "add this person",
      // and an accidental save is much more annoying than a missing shortcut.
      e.preventDefault();
      const pick = matches[highlighted];
      if (pick) add(pick);
    } else if (e.key === "Backspace" && query === "") {
      const last = [...selectedIds].reverse().find((id) => id !== lockedId);
      if (last !== undefined) remove(last);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlighted((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="people-picker">
      <div className="people-chips" onClick={() => inputRef.current?.focus()}>
        {selected.map((person) => (
          <span
            key={person.id}
            className={`person-chip${person.id === lockedId ? " is-locked" : ""}`}
          >
            {person.label}
            {person.id !== lockedId && !disabled && (
              <button
                type="button"
                className="person-chip-remove"
                onClick={() => remove(person.id)}
                aria-label={`Remove ${person.label}`}
              >
                ×
              </button>
            )}
          </span>
        ))}

        {!disabled && (
          <input
            ref={inputRef}
            className="people-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setHighlighted(0);
            }}
            onFocus={() => setOpen(true)}
            // A click on an option would otherwise be lost to the blur that
            // precedes it, so closing waits a tick.
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={onKeyDown}
            placeholder={selected.length === 0 ? emptyHint : "Add someone…"}
            aria-label="Add someone to this expense"
          />
        )}
      </div>

      {open && matches.length > 0 && (
        <ul className="people-menu" role="listbox">
          {matches.map((person, i) => (
            <li key={person.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlighted}
                className={`people-option${i === highlighted ? " highlighted" : ""}`}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => add(person)}
              >
                {person.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && query.trim() !== "" && matches.length === 0 && (
        <ul className="people-menu">
          <li className="people-empty">
            Nobody by that name. Add them on the Friends page first.
          </li>
        </ul>
      )}
    </div>
  );
}
