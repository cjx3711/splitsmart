/**
 * The dashboard.
 *
 * Per-currency rows are the honest picture and stay primary: there is no
 * exchange-rate table in the ledger and there must not be one (see
 * src/domain/balances.ts). A labeled ≈ estimate in the viewer's preferred
 * currency is added when any amount is not already in that currency, sourced
 * from Exchange Rate API and cached in the browser for a day. The estimate is
 * dated and additive to the stack, not a replacement for it.
 */
import { Link } from "react-router-dom";
import { displayName, type Friend, type CurrencyAmount } from "../api.ts";
import { Amount, Amounts, sumByCurrency, useCurrencies } from "../money.tsx";
import { avatarFromRow } from "../Avatar.tsx";
import { FriendListItem } from "../FriendListItem.tsx";
import { useAuth } from "../App.tsx";
import { useFriends } from "../localData.ts";
import { OnlineOnly } from "../OnlineOnly.tsx";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { friendDashboardColumn, useExchangeRates } from "../exchangeRates.ts";
import { HelpTip } from "../HelpTip.tsx";

export function Dashboard() {
  const { user } = useAuth();
  const { decimalsFor } = useCurrencies();
  // Every figure below is derived here from the shares in the mirror, through the
  // same pure deriveRepayments the server runs. Balances are never replicated:
  // a pairwise net taken from two people's paid/owed on a three-way bill is
  // wrong, and expense_repayments is a write-time cache, not a source of truth.
  const friends = useFriends()?.friends ?? null;
  const fxSymbols = friends?.flatMap((f) => f.balances.map((b) => b.currencyCode)) ?? [];
  const { rates } = useExchangeRates(user?.defaultCurrency ?? "", fxSymbols);

  if (!friends || !user) return <p className="muted">Loading…</p>;

  const columnOf = (person: Friend) =>
    friendDashboardColumn(person.balances, user.defaultCurrency, rates, decimalsFor);
  const youOwe = friends.filter((f) => {
    const column = columnOf(f);
    return column === "owe" || column === "both";
  });
  const owedToYou = friends.filter((f) => {
    const column = columnOf(f);
    return column === "owed" || column === "both";
  });

  const allBalances = friends.flatMap((f) => f.balances);
  const positives = sumByCurrency(allBalances.filter((b) => b.amountMinor > 0));
  const negatives = sumByCurrency(allBalances.filter((b) => b.amountMinor < 0));
  const net = sumByCurrency(allBalances);

  return (
    <>
      <div className="page-head">
        <h1 className="with-help">
          Dashboard
          <HelpTip label="About these totals">
            Every currency is a separate ledger. A combined figure, when shown, is an estimate.
            Friend totals use simplify-debts inside groups that have it on, matching Splitwise.
            One-on-one expenses stay between the two of you.
          </HelpTip>
        </h1>
        <div className="page-actions">
          <OnlineOnly what="Creating a group">
            <Link to="/groups/new">
              <button className="secondary inline">New group</button>
            </Link>
          </OnlineOnly>
          <OnlineOnly what="Adding a friend">
            <Link to="/friends/new">
              <button className="inline">Add a friend</button>
            </Link>
          </OnlineOnly>
        </div>
      </div>

      <div className="summary">
        <div>
          <span className="eyebrow">Net position</span>
          {/* Signed and not absolute: this column mixes directions, so the
              minus sign has to carry the meaning, not just the colour. */}
          <SummaryLedger balances={net} empty="All settled" signed showSign />
          <EstimatedTotal balances={net} preferredCurrency={user.defaultCurrency} />
        </div>
        <div>
          <span className="eyebrow">You owe</span>
          <SummaryLedger balances={negatives} empty="Nothing" tone="negative" />
        </div>
        <div>
          <span className="eyebrow">You are owed</span>
          <SummaryLedger balances={positives} empty="Nothing" tone="positive" />
        </div>
      </div>

      <ConversionFootnote
        sets={[net, ...friends.map((f) => f.balances)]}
        preferredCurrency={user.defaultCurrency}
      />

      <div className="columns" style={{ marginTop: "1.75rem" }}>
        <section>
          <h2 style={{ marginTop: 0 }}>You owe</h2>
          <PeopleList
            people={youOwe}
            preferredCurrency={user.defaultCurrency}
            empty="You don't owe anyone."
          />
        </section>
        <section>
          <h2 style={{ marginTop: 0 }}>You are owed</h2>
          <PeopleList
            people={owedToYou}
            preferredCurrency={user.defaultCurrency}
            empty="Nobody owes you."
          />
        </section>
      </div>
    </>
  );
}

function SummaryLedger({
  balances,
  empty,
  signed = false,
  showSign = false,
  tone,
}: {
  balances: CurrencyAmount[];
  empty: string;
  signed?: boolean;
  /** Keep the minus sign. Needed wherever a column mixes both directions. */
  showSign?: boolean;
  tone?: "positive" | "negative";
}) {
  if (balances.length === 0) return <span className="muted">{empty}</span>;

  return (
    <div className="ledger">
      {balances.map((b) => (
        <div key={b.currencyCode} className={tone}>
          <Amount
            minor={b.amountMinor}
            currency={b.currencyCode}
            signed={signed}
            absolute={!showSign}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * One row per person, with the per-group breakdown underneath.
 *
 * Mixed balances show both directions on the same card so "you owe SGD" does
 * not hide "they owe you JPY". The column they sit in is the converted net
 * when rates are in; until then a mixed person can still appear in both.
 */
function PeopleList({
  people,
  preferredCurrency,
  empty,
}: {
  people: Friend[];
  preferredCurrency: string;
  empty: string;
}) {
  if (people.length === 0) return <p className="empty">{empty}</p>;

  return (
    <div className="list owe-list">
      {people.map((person) => {
        const youOwe = person.balances.filter((b) => b.amountMinor < 0);
        const theyOwe = person.balances.filter((b) => b.amountMinor > 0);

        return (
          <FriendListItem
            key={person.id}
            to={`/friends/${person.id}`}
            avatar={avatarFromRow(person)}
            title={displayName(person)}
            subtitle={
              <div className="owe-summary">
                {youOwe.length > 0 && (
                  <div className="negative">
                    you owe <Amounts balances={youOwe} absolute />
                  </div>
                )}
                {theyOwe.length > 0 && (
                  <div className="positive">
                    owes you <Amounts balances={theyOwe} absolute />
                  </div>
                )}
                <EstimatedTotal
                  balances={person.balances}
                  preferredCurrency={preferredCurrency}
                  compact
                />
              </div>
            }
            extra={
              // Every bucket, signed - including ones pointing the other way.
              // Filtering to this column's direction would print sub-lines
              // that don't add up to the figure above them. Only shown when
              // there is more than one, since a single line just repeats it.
              person.breakdown.length > 1 ? (
                <ul className="breakdown">
                  {person.breakdown.map((entry) => (
                    <li key={entry.groupId ?? "none"}>
                      <Amounts balances={entry.balances} signed />
                      <span className="breakdown-where">
                        {entry.groupId
                          ? (entry.groupName?.trim() || "this group")
                          : "one-on-one"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}
