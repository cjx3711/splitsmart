/**
 * The add-expense form.
 *
 * One form for every way of adding an expense — a group, a friend, or neither —
 * because the alternative was three forms drifting apart. What varies is the
 * pool of people it offers and whether the group is fixed; both are props.
 *
 * It owns the expense's own fields: category, description, amount, currency,
 * date, notes, and who paid. How the cost is divided belongs to SplitEditor,
 * which handles all six split types and previews the result using the server's
 * own split engine. Who is on it belongs to PeoplePicker.
 *
 * Amounts are parsed against the SELECTED currency's decimal places, not a
 * hardcoded 2. Typing 1000 with JPY selected means one thousand yen.
 *
 * In itemized mode the amount box is DERIVED, not typed: a restaurant bill is
 * lines plus tax plus tip, and deriving it is also what keeps the tax and tip
 * figures in agreement with the gap the engine spreads.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { formatMoney, type ExpenseInput, type Group } from "./api.ts";
import { useCurrencies, useParseMoney } from "./money.tsx";
import { CurrencySelect } from "./CurrencySelect.tsx";
import { CategoryButton, DEFAULT_CATEGORY_ID } from "./categories.tsx";
import { PeoplePicker, type Person } from "./PeoplePicker.tsx";
import { PaidByField, type Payment } from "./PaidBy.tsx";
import { SplitEditor, buildSplit, itemizedTotal, useSplitDraft } from "./SplitEditor.tsx";

/** Kept as the old name so SettleUpForm and friends need no churn. */
export type Payer = Person;
export type { Person };

/**
 * A placeholder in the selected currency's own precision.
 *
 * Typing "30.00" with JPY selected is rejected — correctly, since yen has no
 * subunit — so the hint must not suggest it in the first place.
 */
function amountPlaceholder(decimals: number | null): string {
  if (decimals === null) return "30";
  return decimals === 0 ? "3000" : `30.${"0".repeat(decimals)}`;
}

export function ExpenseForm({
  candidates,
  initialParticipantIds,
  defaultCurrency,
  currentUserId,
  groups,
  groupId,
  onGroupChange,
  onSubmit,
  submitLabel = "Add expense",
  className = "card stack",
}: {
  /** Everyone selectable: your friends, or the members of the chosen group. */
  candidates: Person[];
  initialParticipantIds: number[];
  defaultCurrency: string;
  currentUserId: number;
  /** Omit to hide the group selector — the friend screen has no use for it. */
  groups?: Group[];
  groupId: number | null;
  onGroupChange?: (groupId: number | null) => void;
  onSubmit: (input: ExpenseInput) => Promise<void>;
  submitLabel?: string;
  /** Pass "stack" inside a Modal — the dialog already draws the surround. */
  className?: string;
}) {
  const { decimalsFor } = useCurrencies();
  const parseInCurrency = useParseMoney();

  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categoryId, setCategoryId] = useState<number>(DEFAULT_CATEGORY_ID);
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [participantIds, setParticipantIds] = useState<number[]>(initialParticipantIds);
  const [payment, setPayment] = useState<Payment>({ kind: "single", payerId: currentUserId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = useSplitDraft();

  const byId = useMemo(() => new Map(candidates.map((p) => [p.id, p])), [candidates]);
  // Participants in the picker's order, minus anyone the pool no longer offers
  // (switching to a group drops the friends who are not in it).
  const people = participantIds
    .map((id) => byId.get(id))
    .filter((p): p is Person => p !== undefined);

  const decimals = decimalsFor(currency);
  const itemizing = draft.mode === "itemized";

  // The preview needs the amount as minor units on every keystroke, including
  // the keystrokes where it is not a valid amount yet ("12."). Zero means "no
  // total to divide", which the editor renders as an empty preview rather than
  // an error — the real parse happens on submit and reports properly there.
  let costMinor = 0;
  if (itemizing) {
    costMinor = itemizedTotal(draft, currency, parseInCurrency);
  } else {
    try {
      costMinor = amount.trim() === "" ? 0 : parseInCurrency(amount, currency);
    } catch {
      costMinor = 0;
    }
  }

  useEffect(() => setCurrency(defaultCurrency), [defaultCurrency]);

  // The candidate pool changed under us — a different group, or a friend list
  // that has just loaded. Reset to whatever the caller says belongs on the
  // expense now rather than leaving half a stale selection behind.
  useEffect(() => {
    setParticipantIds(initialParticipantIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ids, not the array identity
  }, [initialParticipantIds.join(",")]);

  useEffect(() => {
    draft.syncParticipants(participantIds);
    setPayment((current) => {
      if (current.kind !== "single") return current;
      // The payer left the expense: fall back to you, or to whoever is left.
      if (participantIds.includes(current.payerId)) return current;
      const fallback = participantIds.includes(currentUserId)
        ? currentUserId
        : participantIds[0];
      return fallback === undefined ? current : { kind: "single", payerId: fallback };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters are stable
  }, [participantIds.join(","), currentUserId]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (people.length === 0) return setError("Add at least one person to this expense");

    let cost: number;
    if (itemizing) {
      cost = costMinor;
    } else {
      try {
        cost = parseInCurrency(amount, currency);
      } catch (err) {
        return setError(err instanceof Error ? err.message : "Invalid amount");
      }
    }

    if (cost <= 0) return setError("Amount must be greater than zero");

    // Everything about how the cost divides comes from the split draft. Building
    // it can fail on unparseable input; the arithmetic itself is checked by the
    // server, which is the only place that decides whether a split is valid.
    let split: ReturnType<typeof buildSplit>;
    try {
      split = buildSplit(draft, participantIds, cost, payment, currency, parseInCurrency);
    } catch (err) {
      return setError(err instanceof Error ? err.message : "Invalid split");
    }

    setBusy(true);
    try {
      await onSubmit({
        description: description.trim(),
        ...(notes.trim() ? { details: notes.trim() } : {}),
        costMinor: cost,
        currencyCode: currency,
        date,
        categoryId,
        ...split,
      });
      setDescription("");
      setAmount("");
      setNotes("");
      setShowNotes(false);
      setCategoryId(DEFAULT_CATEGORY_ID);
      draft.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add expense");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      {error && <p className="error">{error}</p>}

      <div>
        <label htmlFor="expense-people">With you and</label>
        <PeoplePicker
          candidates={candidates}
          selectedIds={participantIds}
          onChange={setParticipantIds}
          lockedId={currentUserId}
          emptyHint="Search your friends by name"
        />
      </div>

      {groups && (
        <div>
          <label htmlFor="expense-group">Group</label>
          <select
            id="expense-group"
            value={groupId ?? ""}
            onChange={(e) => onGroupChange?.(e.target.value === "" ? null : Number(e.target.value))}
            disabled={!onGroupChange}
          >
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="expense-headline">
        <CategoryButton value={categoryId} onChange={setCategoryId} />
        <div className="stack" style={{ flex: 1, gap: "0.5rem" }}>
          <div>
            <label htmlFor="description">Description</label>
            <input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Dinner"
              autoFocus
              required
            />
          </div>

          <div className="form-grid">
            <div>
              <label htmlFor="amount">Amount</label>
              <input
                id="amount"
                value={itemizing ? (formatMoney(costMinor, decimals ?? 2) ?? "") : amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={amountPlaceholder(decimals)}
                inputMode="decimal"
                readOnly={itemizing}
                title={itemizing ? "Added up from the line items, tax and tip below" : undefined}
                required={!itemizing}
              />
            </div>
            <div>
              <label htmlFor="currency">Currency</label>
              <CurrencySelect id="currency" value={currency} onChange={setCurrency} />
            </div>
          </div>
        </div>
      </div>

      <div className="form-grid">
        <div>
          <label htmlFor="date">Date</label>
          <input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <PaidByField
            people={people}
            payment={payment}
            onChange={setPayment}
            costMinor={costMinor}
            currency={currency}
            parseInCurrency={parseInCurrency}
          />
        </div>
      </div>

      <SplitEditor
        people={people}
        draft={draft}
        costMinor={costMinor}
        currency={currency}
        payment={payment}
      />

      {/* Notes only. There is no image upload in this app and there will not be
          one without an explicit decision — see CLAUDE.md. */}
      <div>
        {showNotes || notes ? (
          <>
            <label htmlFor="notes">Notes</label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={5000}
              placeholder="Anything worth remembering about this one"
            />
          </>
        ) : (
          <button type="button" className="link" onClick={() => setShowNotes(true)}>
            + Add notes
          </button>
        )}
      </div>

      <div>
        <button type="submit" disabled={busy || people.length === 0} className="inline">
          {busy ? "Adding…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
