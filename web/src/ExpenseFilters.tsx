/**
 * The filter bar over an expense list.
 *
 * One component for the three screens that list expenses (all, one group, one
 * friend), because the alternative is three search boxes that behave slightly
 * differently. What varies is which controls are offered: the group screen has no
 * use for a group picker, and the friend screen has no use for a person picker.
 *
 * Filtering happens SERVER-SIDE (src/routes/native/expense-filters.ts), not by
 * hiding rows the client already fetched. A list is capped at 100 rows, so
 * filtering locally would search the most recent hundred expenses and quietly
 * call that "no results".
 *
 * The download link carries the same filters, so the CSV is what is on screen.
 */
import { useEffect, useState } from "react";
import { api, type ExpenseQuery, type Friend, type Group } from "./api.ts";
import { useCategories } from "./categories.tsx";

export function ExpenseFilters({
  value,
  onChange,
  groups,
  people,
  csvScope,
  csvFilename = "expenses",
}: {
  value: ExpenseQuery;
  onChange: (next: ExpenseQuery) => void;
  /** Offer a group picker. Omit on a group's own screen. */
  groups?: Group[];
  /** Offer a "with this person" picker. Omit on a friend's own screen. */
  people?: Friend[];
  /**
   * The scope the screen itself imposes, for the download only.
   *
   * The CSV endpoint is `/api/v1/expenses.csv` — everything the caller can see —
   * so on a group or friend screen the filters alone would hand back the whole
   * ledger. Passing the screen's own scope here keeps the file equal to the list
   * above it, which is the entire promise of putting the link in this bar.
   */
  csvScope?: ExpenseQuery;
  csvFilename?: string;
}) {
  const categories = useCategories();
  // Typing is local so every keystroke does not fire a request; the parent is
  // told once the box settles. 250ms is short enough to feel immediate.
  const [q, setQ] = useState(value.q ?? "");

  useEffect(() => setQ(value.q ?? ""), [value.q]);

  useEffect(() => {
    if ((value.q ?? "") === q) return;
    const timer = setTimeout(() => onChange({ ...value, q: q || undefined }), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce the text, not the callback identity
  }, [q]);

  const active =
    Boolean(value.q) ||
    value.groupId !== undefined ||
    value.friendId !== undefined ||
    value.datedAfter !== undefined ||
    value.datedBefore !== undefined ||
    value.categoryId !== undefined ||
    value.isPayment !== undefined;

  // Leaf categories only: a parent is a display grouping and no expense carries
  // its id. See src/db/categories.ts.
  const leaves = categories.filter((c) => c.parent_id !== null);

  return (
    <div className="filters">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search descriptions"
        aria-label="Search descriptions"
      />

      {groups && (
        <select
          value={value.groupId ?? ""}
          aria-label="Group"
          onChange={(e) =>
            onChange({ ...value, groupId: e.target.value === "" ? undefined : e.target.value })
          }
        >
          <option value="">Any group</option>
          {/* Splitwise's "non-group expenses" bucket, spelled for a query string. */}
          <option value="none">No group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}

      {people && (
        <select
          value={value.friendId ?? ""}
          aria-label="With"
          onChange={(e) =>
            onChange({ ...value, friendId: e.target.value === "" ? undefined : e.target.value })
          }
        >
          <option value="">Anyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {[p.first_name, p.last_name].filter(Boolean).join(" ")}
            </option>
          ))}
        </select>
      )}

      <select
        value={value.categoryId ?? ""}
        aria-label="Category"
        onChange={(e) =>
          onChange({
            ...value,
            categoryId: e.target.value === "" ? undefined : Number(e.target.value),
          })
        }
      >
        <option value="">Any category</option>
        {leaves.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <input
        type="date"
        value={value.datedAfter?.slice(0, 10) ?? ""}
        aria-label="From"
        onChange={(e) => onChange({ ...value, datedAfter: e.target.value || undefined })}
      />
      <input
        type="date"
        value={value.datedBefore?.slice(0, 10) ?? ""}
        aria-label="To"
        onChange={(e) => onChange({ ...value, datedBefore: e.target.value || undefined })}
      />

      <select
        value={value.isPayment === undefined ? "" : String(value.isPayment)}
        aria-label="Kind"
        onChange={(e) =>
          onChange({
            ...value,
            isPayment: e.target.value === "" ? undefined : e.target.value === "true",
          })
        }
      >
        <option value="">Expenses and payments</option>
        <option value="false">Expenses only</option>
        <option value="true">Settle-ups only</option>
      </select>

      {active && (
        <button type="button" className="link" onClick={() => onChange({})}>
          Clear
        </button>
      )}

      {/* A plain link, not a fetch: the browser downloads it with the session
          cookie attached, and there is nothing for JavaScript to add. */}
      <a
        className="link"
        href={api.expensesCsvUrl({ ...csvScope, ...value })}
        download={`${csvFilename}.csv`}
        title="Download these expenses as CSV"
      >
        Download CSV
      </a>
    </div>
  );
}
