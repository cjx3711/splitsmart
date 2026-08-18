/**
 * The split editor: how an expense is divided.
 *
 * Six modes, matching what the server's split engine accepts:
 *
 *   equal       everyone pays the same
 *   exact       you type each person's amount; they must add up to the total
 *   percent     you type percentages; they must add up to 100
 *   shares      you type weights (2 shares vs 1 share); any positive numbers
 *   adjustment  fixed +/- per person, then the rest splits evenly
 *   itemized    a line-item bill, plus tax and tip
 *
 * THE PREVIEW RUNS THE REAL ENGINE. `computeSplit` is imported from
 * src/domain/split.ts, the same pure module the server calls, so the amounts
 * shown here are the amounts that will be stored, down to which person gets the
 * leftover cent. There is no second implementation of the rounding to drift out
 * of sync, and the validation messages the user sees are the server's own.
 *
 * The server still recomputes on submit and remains authoritative; this is a
 * preview, not a substitute for validation.
 *
 * WHO is on the expense is not decided here; PeoplePicker owns that, and this
 * component renders a row per person it is given. Two controls editing one list
 * is how a person ends up on the chips but not in the split.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { computeSplit, type SplitItem, type SplitType } from "../../src/domain/split.ts";
import { Amount, useCurrencies, useParseMoney } from "./money.tsx";
import { resolvePayments, type Payment } from "./PaidBy.tsx";
import type { Person } from "./PeoplePicker.tsx";
import { HelpTip } from "./HelpTip.tsx";

export const SPLIT_MODES: Array<{ id: SplitType; label: string; hint: string }> = [
  { id: "equal", label: "Equally", hint: "Split the total evenly between everyone on the expense." },
  { id: "exact", label: "Exact amounts", hint: "Enter what each person owes. Must add up to the total." },
  { id: "percent", label: "Percentages", hint: "Enter each person's share of the bill. Must add up to 100%." },
  { id: "shares", label: "Shares", hint: "Weights, not amounts: a couple taking 2 shares to someone else's 1." },
  {
    id: "adjustment",
    label: "Adjustment",
    hint: "A fixed amount for one person (their own drink, their single room), then the rest splits evenly.",
  },
  {
    id: "itemized",
    label: "Itemized",
    hint: "Enter the bill line by line and tick who shared each one. Tax and tip are spread in proportion to what each person ordered.",
  },
];

/** One row of the itemized editor. `key` is local UI identity only. */
interface DraftItem {
  key: number;
  label: string;
  amount: string;
  participantIds: string[];
}

export interface SplitDraft {
  mode: SplitType;
  setMode: (mode: SplitType) => void;
  /** Raw text per person. Meaning depends on `mode`; cleared when mode changes. */
  values: Record<string, string>;
  setValue: (id: string, value: string) => void;
  /** Used by the one-sided presets, which set every person at once. */
  setAllValues: (values: Record<string, string>) => void;
  items: DraftItem[];
  addItem: (participantIds: string[]) => void;
  updateItem: (key: number, patch: Partial<Omit<DraftItem, "key">>) => void;
  removeItem: (key: number) => void;
  /** Itemized only: raw text, in the expense's currency. */
  tax: string;
  setTax: (value: string) => void;
  tip: string;
  setTip: (value: string) => void;
  /** Drops people who are no longer on the expense from every line. */
  syncParticipants: (ids: string[]) => void;
  /** Called after a successful submit, to empty the form for the next expense. */
  reset: () => void;
}

/** Reopens an existing expense's split, from its stored split_input/split_meta. */
export interface SplitDraftInit {
  mode: SplitType;
  values: Record<string, string>;
  items?: Array<{ label: string; amount: string; participantIds: string[] }>;
  tax?: string;
  tip?: string;
}

export function useSplitDraft(initial?: SplitDraftInit): SplitDraft {
  const [mode, setModeRaw] = useState<SplitType>(initial?.mode ?? "equal");
  const [values, setValues] = useState<Record<string, string>>(initial?.values ?? {});
  const nextKey = useRef(1);
  const [items, setItems] = useState<DraftItem[]>(() =>
    (initial?.items ?? []).map((item) => ({ ...item, key: nextKey.current++ })),
  );
  const [tax, setTax] = useState(initial?.tax ?? "");
  const [tip, setTip] = useState(initial?.tip ?? "");

  // Switching mode clears the per-person values, because they do not survive
  // reinterpretation: "50" as a percentage and "50" as an exact amount are not
  // the same claim, and carrying one into the other silently changes the split.
  const setMode = useCallback((next: SplitType) => {
    setModeRaw(next);
    setValues({});
  }, []);

  return {
    mode,
    setMode,
    values,
    setValue: useCallback((id: string, value: string) => {
      setValues((prev) => ({ ...prev, [id]: value }));
    }, []),
    setAllValues: useCallback((next: Record<string, string>) => setValues(next), []),
    items,
    addItem: useCallback((participantIds: string[]) => {
      setItems((prev) => [
        ...prev,
        // A new line starts shared by everyone, which is the common case and is
        // faster to narrow than to build up.
        { key: nextKey.current++, label: "", amount: "", participantIds: [...participantIds] },
      ]);
    }, []),
    updateItem: useCallback((key: number, patch: Partial<Omit<DraftItem, "key">>) => {
      setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
    }, []),
    removeItem: useCallback((key: number) => {
      setItems((prev) => prev.filter((item) => item.key !== key));
    }, []),
    tax,
    setTax,
    tip,
    setTip,
    // Dropping someone from the expense must also drop them from every line, or
    // the itemized split would charge a person who is no longer on it.
    syncParticipants: useCallback((ids: string[]) => {
      setItems((prev) => {
        let changed = false;
        const next = prev.map((item) => {
          const kept = item.participantIds.filter((x) => ids.includes(x));
          if (kept.length === item.participantIds.length) return item;
          changed = true;
          return { ...item, participantIds: kept };
        });
        return changed ? next : prev;
      });
    }, []),
    reset: useCallback(() => {
      setValues({});
      setItems([]);
      setTax("");
      setTip("");
    }, []),
  };
}

/** Parses a raw box that is allowed to be empty, treating blank as zero. */
function parseOrZero(
  raw: string,
  currency: string,
  parseInCurrency: (input: string, currency: string) => number,
): number {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  return parseInCurrency(trimmed, currency);
}

/**
 * The total an itemized bill comes to: the lines, plus tax, plus tip.
 *
 * In itemized mode this REPLACES the amount box rather than being checked
 * against it. A restaurant bill is not a number you know and then break down;
 * it is lines you add up. Deriving it also means tax and tip always agree with
 * the gap the engine spreads, which is what the server insists on.
 *
 * Unparseable boxes count as zero; the preview reports them properly.
 */
export function itemizedTotal(
  draft: SplitDraft,
  currency: string,
  parseInCurrency: (input: string, currency: string) => number,
): number {
  const safe = (raw: string) => {
    try {
      return parseOrZero(raw, currency, parseInCurrency);
    } catch {
      return 0;
    }
  };

  return (
    draft.items.reduce((sum, item) => sum + safe(item.amount), 0) +
    safe(draft.tax) +
    safe(draft.tip)
  );
}

/**
 * Turns the draft into the `participants` / `items` the API expects.
 *
 * Throws on unparseable input (a stray letter in an amount), with the same
 * MoneyError text the server would produce. Numbers that parse but do not add
 * up are NOT rejected here; that is computeSplit's call, so there is one set of
 * arithmetic rules rather than two.
 */
export function buildSplit(
  draft: SplitDraft,
  participantIds: string[],
  costMinor: number,
  payment: Payment,
  currency: string,
  parseInCurrency: (input: string, currency: string) => number,
): {
  splitType: SplitType;
  participants: Array<{ userId: string; paidMinor: number; input?: number }>;
  items?: SplitItem[];
  taxMinor?: number;
  tipMinor?: number;
} {
  const { mode, values } = draft;

  const inputFor = (userId: string): number | undefined => {
    const raw = (values[userId] ?? "").trim();

    switch (mode) {
      case "equal":
      case "itemized":
        // The line items carry the detail; there is no per-person figure.
        return undefined;

      // Money, in the selected currency's own precision.
      case "exact":
      case "adjustment":
        // Blank means zero: nothing owed, or no adjustment. Typing 0 into every
        // box to express "the default" would be busywork.
        return raw === "" ? 0 : parseInCurrency(raw, currency);

      // Plain numbers, and legitimately fractional (33.33%, 1.5 shares).
      case "percent":
      case "shares": {
        if (raw === "") return 0;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          throw new Error(`"${raw}" is not a number`);
        }
        return parsed;
      }

      default:
        return undefined;
    }
  };

  const items: SplitItem[] | undefined =
    mode === "itemized"
      ? draft.items.map((item, n) => {
          const raw = item.amount.trim();
          if (raw === "") {
            throw new Error(`Item ${n + 1}${item.label ? ` (${item.label})` : ""} has no amount`);
          }
          return {
            label: item.label.trim() || null,
            amountMinor: parseInCurrency(raw, currency),
            participantIds: item.participantIds,
          };
        })
      : undefined;

  const inputs = new Map(participantIds.map((id) => [id, inputFor(id)]));

  // `own-share` cannot be resolved before the split is known; what each person
  // paid IS what they owe. So the shares are computed once with a provisional
  // payer (which changes no owed amount; paid only has to sum to the total),
  // then the payments are set from the result.
  const resolved =
    resolvePayments(payment, participantIds, costMinor, currency, parseInCurrency) ??
    (() => {
      const provisional = participantIds.map((userId, i) => ({
        userId,
        paidMinor: i === 0 ? costMinor : 0,
        input: inputs.get(userId),
      }));
      const shares = computeSplit(costMinor, mode, provisional, { items });
      return new Map(shares.map((s) => [s.userId, s.owedMinor]));
    })();

  const participants = participantIds.map((userId) => ({
    userId,
    paidMinor: resolved.get(userId) ?? 0,
    input: inputs.get(userId),
  }));

  if (mode !== "itemized") return { splitType: mode, participants };

  return {
    splitType: mode,
    participants,
    items,
    taxMinor: parseOrZero(draft.tax, currency, parseInCurrency),
    tipMinor: parseOrZero(draft.tip, currency, parseInCurrency),
  };
}

/**
 * Runs the split for the preview, returning either per-person amounts or the
 * reason it does not work yet.
 *
 * Every failure is expected here (a half-typed form is invalid most of the
 * time, so this reports rather than throws, and the message is shown inline as
 * guidance instead of as an error.
 */
function previewSplit(
  draft: SplitDraft,
  participantIds: string[],
  costMinor: number,
  payment: Payment,
  currency: string,
  parseInCurrency: (input: string, currency: string) => number,
): { shares: Map<string, number> | null; problem: string | null } {
  if (participantIds.length === 0) {
    return { shares: null, problem: "Nobody is on this expense yet." };
  }
  if (costMinor <= 0) {
    return { shares: null, problem: null }; // No amount typed yet; not a problem.
  }

  try {
    const built = buildSplit(draft, participantIds, costMinor, payment, currency, parseInCurrency);
    const result = computeSplit(costMinor, built.splitType, built.participants, {
      items: built.items,
    });
    return {
      shares: new Map(result.map((r) => [r.userId, r.owedMinor])),
      problem: null,
    };
  } catch (err) {
    return { shares: null, problem: err instanceof Error ? err.message : "This split does not add up." };
  }
}

export function SplitEditor({
  people,
  draft,
  costMinor,
  currency,
  payment,
}: {
  /** The expense's participants: exactly the rows shown. */
  people: Person[];
  draft: SplitDraft;
  costMinor: number;
  currency: string;
  payment: Payment;
}) {
  const { decimalsFor } = useCurrencies();
  const parseInCurrency = useParseMoney();
  const decimals = decimalsFor(currency);
  const participantIds = people.map((p) => p.id);
  // The caller rebuilds `people` on every render, so the identity of the array
  // is worthless as a dependency; the ids are what the split actually reads.
  const idKey = participantIds.join(",");

  const { shares, problem } = useMemo(
    () => previewSplit(draft, participantIds, costMinor, payment, currency, parseInCurrency),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draft is a bag of
    // setters plus the state we actually depend on; the state fields are listed.
    [draft.mode, draft.values, draft.items, draft.tax, draft.tip, costMinor, currency, payment, idKey],
  );

  const mode = SPLIT_MODES.find((m) => m.id === draft.mode);

  return (
    <div className="split-editor stack">
      <div>
        <div className="label-with-help">
          <label>Split</label>
          {mode && (
            <HelpTip label={`About ${mode.label}`}>{mode.hint}</HelpTip>
          )}
        </div>

        {/* Splitwise's two one-sided shortcuts. They set `shares` weights rather
            than fixed amounts so that changing the total afterwards keeps them
            true (a preset that silently goes stale is worse than no preset). */}
        {people.length === 2 && (
          <div className="split-presets">
            {people.map((person) => {
              const other = people.find((p) => p.id !== person.id)!;
              const active =
                draft.mode === "shares" &&
                Number(draft.values[person.id] ?? "0") > 0 &&
                Number(draft.values[other.id] ?? "0") === 0;
              return (
                <button
                  key={person.id}
                  type="button"
                  className={`split-mode${active ? " is-active" : ""}`}
                  aria-pressed={active}
                  onClick={() => {
                    draft.setMode("shares");
                    draft.setAllValues({ [person.id]: "1", [other.id]: "0" });
                  }}
                >
                  {person.label === "You" ? "You owe" : `${person.label} owes`} the full amount
                </button>
              );
            })}
          </div>
        )}

        <div className="split-modes" role="group" aria-label="How to split this expense">
          {SPLIT_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`split-mode${draft.mode === m.id ? " is-active" : ""}`}
              aria-pressed={draft.mode === m.id}
              onClick={() => draft.setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {draft.mode === "itemized" ? (
        <ItemizedEditor
          people={people}
          draft={draft}
          currency={currency}
          decimals={decimals}
          parseInCurrency={parseInCurrency}
        />
      ) : null}

      <PersonRows
        people={people}
        draft={draft}
        currency={currency}
        decimals={decimals}
        shares={shares}
      />

      {problem && <p className="split-problem">{problem}</p>}
    </div>
  );
}

/**
 * Each person's per-mode input and what they end up owing.
 *
 * Shown for every mode including itemized and equal; in those two there is no
 * value to type, but the computed per-person amount is the whole point of the
 * preview.
 */
function PersonRows({
  people,
  draft,
  currency,
  decimals,
  shares,
}: {
  people: Person[];
  draft: SplitDraft;
  currency: string;
  decimals: number | null;
  shares: Map<string, number> | null;
}) {
  const needsValue = draft.mode !== "equal" && draft.mode !== "itemized";

  return (
    <div>
      <label>Who owes what</label>
      <div className="split-rows">
        {people.map((person) => {
          const owed = shares?.get(person.id);

          return (
            <div key={person.id} className="split-row">
              <span className="split-row-name">{person.label}</span>

              {needsValue && (
                <span className="split-row-input">
                  <input
                    value={draft.values[person.id] ?? ""}
                    onChange={(e) => draft.setValue(person.id, e.target.value)}
                    placeholder={valuePlaceholder(draft.mode, decimals)}
                    inputMode="decimal"
                    aria-label={`${person.label}: ${valueLabel(draft.mode)}`}
                  />
                  <span className="split-row-unit">{valueUnit(draft.mode)}</span>
                </span>
              )}

              <span className="split-row-owed">
                {owed !== undefined ? <Amount minor={owed} currency={currency} /> : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ItemizedEditor({
  people,
  draft,
  currency,
  decimals,
  parseInCurrency,
}: {
  people: Person[];
  draft: SplitDraft;
  currency: string;
  decimals: number | null;
  parseInCurrency: (input: string, currency: string) => number;
}) {
  const safe = (raw: string) => {
    try {
      return parseOrZero(raw, currency, parseInCurrency);
    } catch {
      return 0;
    }
  };

  const subtotal = draft.items.reduce((sum, item) => sum + safe(item.amount), 0);
  const grandTotal = subtotal + safe(draft.tax) + safe(draft.tip);
  const amountPlaceholder = decimals === 0 ? "1200" : `12.${"0".repeat(decimals ?? 2)}`;

  return (
    <div>
      <label>Line items</label>

      {draft.items.length === 0 && (
        <p className="split-hint">No lines yet; add the first one below.</p>
      )}

      <div className="stack-tight">
        {draft.items.map((item, n) => (
          <div key={item.key} className="split-item">
            <div className="split-item-head">
              <input
                value={item.label}
                onChange={(e) => draft.updateItem(item.key, { label: e.target.value })}
                placeholder={`Item ${n + 1}`}
                aria-label={`Item ${n + 1} description`}
              />
              <input
                value={item.amount}
                onChange={(e) => draft.updateItem(item.key, { amount: e.target.value })}
                placeholder={amountPlaceholder}
                inputMode="decimal"
                className="split-item-amount"
                aria-label={`Item ${n + 1} amount`}
              />
              <button
                type="button"
                className="icon"
                onClick={() => draft.removeItem(item.key)}
                aria-label={`Remove item ${n + 1}`}
              >
                ×
              </button>
            </div>

            <div className="split-item-people">
              {people.map((person) => {
                const on = item.participantIds.includes(person.id);
                return (
                  <button
                    key={person.id}
                    type="button"
                    className={`chip${on ? " is-active" : ""}`}
                    aria-pressed={on}
                    onClick={() =>
                      draft.updateItem(item.key, {
                        participantIds: on
                          ? item.participantIds.filter((x) => x !== person.id)
                          : [...item.participantIds, person.id],
                      })
                    }
                  >
                    {person.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="split-item-actions">
        <button
          type="button"
          className="secondary inline"
          onClick={() => draft.addItem(people.map((p) => p.id))}
        >
          Add a line
        </button>
      </div>

      {/* Tax and tip are not a third kind of split: they are the part of the
          bill nobody ordered, spread in proportion to what each person did. */}
      <div className="split-totals">
        <div className="split-total-row">
          <span>Subtotal</span>
          <Amount minor={subtotal} currency={currency} />
        </div>
        <div className="split-total-row">
          <label htmlFor="split-tax">Tax</label>
          <input
            id="split-tax"
            value={draft.tax}
            onChange={(e) => draft.setTax(e.target.value)}
            placeholder={decimals === 0 ? "0" : `0.${"0".repeat(decimals ?? 2)}`}
            inputMode="decimal"
          />
        </div>
        <div className="split-total-row">
          <label htmlFor="split-tip">Tip</label>
          <input
            id="split-tip"
            value={draft.tip}
            onChange={(e) => draft.setTip(e.target.value)}
            placeholder={decimals === 0 ? "0" : `0.${"0".repeat(decimals ?? 2)}`}
            inputMode="decimal"
          />
        </div>
        <div className="split-total-row is-total">
          <span>Grand total</span>
          <Amount minor={grandTotal} currency={currency} />
        </div>
      </div>
    </div>
  );
}

function valuePlaceholder(mode: SplitType, decimals: number | null): string {
  switch (mode) {
    case "percent":
      return "33.33";
    case "shares":
      return "1";
    case "exact":
    case "adjustment":
      return decimals === 0 ? "1000" : `10.${"0".repeat(decimals ?? 2)}`;
    default:
      return "";
  }
}

function valueUnit(mode: SplitType): string {
  switch (mode) {
    case "percent":
      return "%";
    case "shares":
      return "×";
    case "adjustment":
      return "+/−";
    default:
      return "";
  }
}

function valueLabel(mode: SplitType): string {
  switch (mode) {
    case "percent":
      return "percentage";
    case "shares":
      return "shares";
    case "exact":
      return "exact amount";
    case "adjustment":
      return "adjustment";
    default:
      return "value";
  }
}
