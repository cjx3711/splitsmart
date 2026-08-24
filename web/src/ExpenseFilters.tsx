/**
 * The filter bar over an expense list.
 *
 * One component for the three screens that list expenses (all, one group, one
 * friend), because the alternative is three search boxes that behave slightly
 * differently. What varies is which controls are offered: the group screen has no
 * use for a group picker, and the friend screen has no use for a person picker.
 *
 * Filtering runs over the WHOLE local mirror, not over a page of rows already
 * fetched - which is what the old server-side-only version was protecting against,
 * since a capped list would have searched the most recent hundred expenses and
 * quietly called that "no results". The rules are the same ones the server
 * applies, from the same module (src/domain/expense-query.ts), so a filter cannot
 * mean one thing here and another in a download.
 *
 * The CSV carries the same filters, and is built from the mirror through the same
 * pure formatter the server uses, so the file is byte-identical either way and
 * downloading works offline.
 *
 * Search stays on the bar (it is the thing people type every time). Everything
 * else lives in a modal so the seven-control wrap does not eat the list.
 */
import { useEffect, useState } from "react";
import { displayName, type ExpenseQuery, type Friend, type Group } from "./api.ts";
import { categoryPath, CategoryPicker, useCategories } from "./categories.tsx";
import { useAuth } from "./App.tsx";
import { Modal } from "./Modal.tsx";
import { useLocalDb } from "./sync/SyncProvider.tsx";
import { localExpenseCsv } from "./db/queries.ts";

function modalFilterCount(value: ExpenseQuery): number {
  return (
    Number(value.groupId !== undefined) +
    Number(value.friendId !== undefined) +
    Number(value.datedAfter !== undefined) +
    Number(value.datedBefore !== undefined) +
    Number(value.categoryId !== undefined) +
    Number(value.isPayment !== undefined)
  );
}

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
   * The CSV endpoint is `/api/v1/expenses.csv` - everything the caller can see -
   * so on a group or friend screen the filters alone would hand back the whole
   * ledger. Passing the screen's own scope here keeps the file equal to the list
   * above it, which is the entire promise of putting the link in this bar.
   */
  csvScope?: ExpenseQuery;
  csvFilename?: string;
}) {
  const categories = useCategories();
  const db = useLocalDb();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
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

  const modalCount = modalFilterCount(value);
  const active = Boolean(value.q) || modalCount > 0;
  const categoryLabel = categoryPath(categories, value.categoryId);

  return (
    <div className="filters">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search descriptions"
        aria-label="Search descriptions"
      />

      <button
        type="button"
        className={`filters-trigger${modalCount > 0 ? " is-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={modalCount > 0 ? `Filters, ${modalCount} active` : "Filters"}
        onClick={() => setOpen(true)}
      >
        Filters
        {modalCount > 0 && <span className="filters-badge">{modalCount}</span>}
      </button>

      {active && (
        <button type="button" className="link" onClick={() => onChange({})}>
          Clear
        </button>
      )}

      {/* Built from the mirror and handed to the browser as a blob, rather than a
          link to /api/v1/expenses.csv. That endpoint still exists and still works
          - it is what curl and the API docs use - but a link to it is the one
          thing on this bar that would fail with no network, and the document it
          returns is identical to this one by construction. */}
      <button
        type="button"
        className="link"
        title="Download these expenses as CSV"
        disabled={!db || !user}
        onClick={() => {
          if (!db || !user) return;
          void localExpenseCsv(db, user.id, { ...csvScope, ...value }).then((csv) => {
            const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${csvFilename}.csv`;
            anchor.click();
            // Revoked immediately: the click has already handed the blob to the
            // download, and leaving it alive holds the whole file in memory.
            URL.revokeObjectURL(url);
          });
        }}
      >
        Download CSV
      </button>

      <Modal
        open={open}
        title="Filter expenses"
        onClose={() => setOpen(false)}
        className="modal-wide"
      >
        <div className="filter-modal">
          {groups && (
            <label className="filter-field">
              Group
              <select
                value={value.groupId ?? ""}
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
            </label>
          )}

          {people && (
            <label className="filter-field">
              With
              <select
                value={value.friendId ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    friendId: e.target.value === "" ? undefined : e.target.value,
                  })
                }
              >
                <option value="">Anyone</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {displayName(p)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="filter-dates">
            <label className="filter-field">
              From
              <input
                type="date"
                value={value.datedAfter?.slice(0, 10) ?? ""}
                onChange={(e) => onChange({ ...value, datedAfter: e.target.value || undefined })}
              />
            </label>
            <label className="filter-field">
              To
              <input
                type="date"
                value={value.datedBefore?.slice(0, 10) ?? ""}
                onChange={(e) => onChange({ ...value, datedBefore: e.target.value || undefined })}
              />
            </label>
          </div>

          <label className="filter-field">
            Kind
            <select
              value={value.isPayment === undefined ? "" : String(value.isPayment)}
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
          </label>

          <div className="filter-field">
            <div className="filter-field-label">Category</div>
            {categoryLabel && <p className="field-hint">{categoryLabel}</p>}
            <CategoryPicker
              value={value.categoryId ?? null}
              allowAny
              allowParent
              onChange={(id) => onChange({ ...value, categoryId: id ?? undefined })}
            />
          </div>

          <div className="filter-modal-actions">
            {modalCount > 0 && (
              <button
                type="button"
                className="link"
                onClick={() => onChange(value.q ? { q: value.q } : {})}
              >
                Clear filters
              </button>
            )}
            <button type="button" className="inline" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
