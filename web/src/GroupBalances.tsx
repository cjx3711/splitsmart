import type { CurrencyAmount } from "./api.ts";
import { Amount, useCurrencies } from "./money.tsx";
import { convertBalances, needsConversion, useExchangeRates } from "./exchangeRates.ts";
import { ConvertBalancesHint } from "./ConversionNote.tsx";
import { ledgerVerb } from "./FriendListItem.tsx";
import { HelpTip } from "./HelpTip.tsx";
import { settleChoiceId } from "./SettleUpDialog.tsx";

/**
 * The headline figure for one person in a group roster.
 *
 * Per-currency rows are still the truth (see the note at the top of
 * styles.css): this only decides which of them is READ FIRST. With a single
 * currency that is the amount itself; with several it is the labelled ≈
 * estimate, and the real ledgers move into a collapsible underneath. If no
 * estimate is available - one currency missing a rate, rates offline - there
 * is no honest headline, so the rows stay expanded and nothing is invented.
 */
export function RosterBalance({
  balances,
  isYou,
  preferredCurrency,
}: {
  balances: CurrencyAmount[];
  isYou: boolean;
  preferredCurrency: string;
}) {
  const { decimalsFor } = useCurrencies();
  const needed = needsConversion(balances, preferredCurrency);
  const { rates, loading, error } = useExchangeRates(
    preferredCurrency,
    needed ? balances.map((b) => b.currencyCode) : [],
  );

  if (balances.length === 0) return <span className="muted">settled up</span>;

  const estimate =
    needed && !loading && !error && rates
      ? convertBalances(balances, preferredCurrency, rates, decimalsFor)
      : null;

  const rows = (
    <div className="ledger">
      {balances.map((b) => (
        <div key={b.currencyCode} className={b.amountMinor >= 0 ? "positive" : "negative"}>
          {ledgerVerb(isYou, b.amountMinor)}
          <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
        </div>
      ))}
    </div>
  );

  // One currency: it is both the headline and the whole ledger, so the ≈ stays
  // a footnote under it rather than replacing the real figure.
  if (balances.length === 1) {
    const only = balances[0]!;
    return (
      <div className="balance-cell">
        <div className={`balance-headline ${only.amountMinor >= 0 ? "positive" : "negative"}`}>
          <span className="balance-verb">{ledgerVerb(isYou, only.amountMinor)}</span>
          <Amount minor={only.amountMinor} currency={only.currencyCode} absolute />
        </div>
        {estimate !== null && (
          <div className="estimate estimate-compact">
            ≈ <Amount minor={estimate} currency={preferredCurrency} absolute />*
          </div>
        )}
      </div>
    );
  }

  if (estimate === null) return <div className="balance-cell">{rows}</div>;

  return (
    <div className="balance-cell">
      <div className={`balance-headline ${estimate >= 0 ? "positive" : "negative"}`}>
        <span className="balance-approx">≈</span>
        <span className="balance-verb">{ledgerVerb(isYou, estimate)}</span>
        <Amount minor={estimate} currency={preferredCurrency} absolute />
        <span className="balance-approx">*</span>
      </div>
      <details className="balance-detail">
        <summary>{balances.map((b) => b.currencyCode).join(" · ")}</summary>
        {rows}
      </details>
    </div>
  );
}

/**
 * What this group offers to settle up, one set per currency. It leads the panel
 * because it is the only part anyone acts on.
 *
 * Simplified when the group has simplify debts on, the recorded per-pair debts
 * when it does not; the wording says which, because "fewest transfers" is a
 * promise only one of those two keeps. Each row opens the settle-up dialog
 * prefilled with that payment - the fastest path from reading a suggestion to
 * recording it, and the reason `settleChoiceId` is shared with the dialog.
 */
export function SettleSuggestion({
  settle,
  nameOf,
  currentUserId,
  simplified,
  onPick,
  onSimplify,
  onConvert,
  convertTo,
}: {
  settle: Array<{ currencyCode: string; transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }> }>;
  nameOf: (userId: string) => string;
  currentUserId: string;
  /** True when the group's simplify-debts is on. */
  simplified: boolean;
  /** Open settle-up on one suggestion. Omitted where settling is not offered. */
  onPick?: (choiceId: string) => void;
  /**
   * Turn simplify debts on for this group. Offered only when it is off and the
   * caller can actually change it: guests have no group settings, and offline
   * this is a live call.
   */
  onSimplify?: () => void;
  /** Open the convert-balance dialog. Only nudged for a multi-currency group. */
  onConvert?: () => void;
  /**
   * What the convert dialog will open on: the code, and whose default it is.
   * The nudge names both, because "convert to one currency" without saying
   * WHICH reads like the app picking one at random.
   */
  convertTo?: { code: string; label: string };
}) {
  const sets = settle.filter((s) => s.transfers.length > 0);
  if (sets.length === 0) return null;
  const payments = sets.reduce((n, s) => n + s.transfers.length, 0);
  return (
    <>
      <h2 className="with-help" style={{ marginTop: 0 }}>
        Suggested payments
        <HelpTip label="About these payments">
          {simplified
            ? "The fewest transfers that clear this group, one set per currency. Simplify debts is on, so a chain of debts can collapse into a single payment - which may be to someone you did not share a bill with."
            : "One payment per debt, exactly as the bills recorded them, netted per pair and grouped by currency. Simplify debts is off, so nobody is asked to pay someone they never shared a bill with, even when that means more payments."}{" "}
          Nothing is recorded until someone actually pays. Pick a row to record it.
        </HelpTip>
      </h2>
      <div className="card stack settle-suggest">
        {sets.map((s) => (
          <div key={s.currencyCode}>
            {sets.length > 1 && <span className="eyebrow">{s.currencyCode}</span>}
            <ul className="settle-list">
              {s.transfers.map((t, i) => {
                const people = (
                  <>
                    <span className="settle-people">
                      <span className={t.fromUserId === currentUserId ? "settle-you" : undefined}>
                        {t.fromUserId === currentUserId ? "You" : nameOf(t.fromUserId)}
                      </span>
                      <span className="settle-arrow">→</span>
                      <span className={t.toUserId === currentUserId ? "settle-you" : undefined}>
                        {t.toUserId === currentUserId ? "You" : nameOf(t.toUserId)}
                      </span>
                    </span>
                    <Amount minor={t.amountMinor} currency={s.currencyCode} />
                  </>
                );
                return (
                  <li key={i}>
                    {onPick ? (
                      <button
                        type="button"
                        className="settle-row"
                        onClick={() => onPick(settleChoiceId(s.currencyCode, t, i))}
                      >
                        {people}
                      </button>
                    ) : (
                      people
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {/* Two ways to make this list shorter, offered where it is read rather
            than buried in Options. Both are opt-in: one changes how balances
            are presented, the other records real payments. */}
        {(onSimplify || (sets.length > 1 && onConvert && convertTo)) && (
          <div className="settle-hints">
            {onSimplify && (
              <p>
                {payments} payments, one per recorded debt.{" "}
                <button type="button" className="link" onClick={onSimplify}>
                  Turn on simplify debts
                </button>{" "}
                to collapse them into the fewest that clear the group.
              </p>
            )}
            {sets.length > 1 && onConvert && convertTo && (
              <ConvertBalancesHint
                lead={`${sets.length} currencies to settle separately.`}
                target={convertTo}
                action={
                  <button type="button" className="link" onClick={onConvert}>
                    Convert the balances
                  </button>
                }
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}
