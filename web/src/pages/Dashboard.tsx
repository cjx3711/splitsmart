/**
 * The dashboard.
 *
 * Splitwise shows one grand total with an asterisk and a footnote when you hold
 * several currencies. SplitSmart cannot do that honestly - there is no
 * exchange-rate table and there must not be one (see src/domain/balances.ts) -
 * so the summary is a stack of per-currency rows instead. That stack is the
 * page, not a detail of it.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fullName, type Friend, type CurrencyAmount } from "../api.ts";
import { Amount, Amounts, sumByCurrency } from "../money.tsx";
import { Avatar } from "../Avatar.tsx";

export function Dashboard() {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listFriends()
      .then((r) => setFriends(r.friends))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load balances"));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!friends) return <p className="muted">Loading…</p>;

  // Someone can owe you in one currency while you owe them in another, so a
  // person can legitimately appear in both columns.
  const owedToYou = friends.filter((f) => f.balances.some((b) => b.amountMinor > 0));
  const youOwe = friends.filter((f) => f.balances.some((b) => b.amountMinor < 0));

  const allBalances = friends.flatMap((f) => f.balances);
  const positives = sumByCurrency(allBalances.filter((b) => b.amountMinor > 0));
  const negatives = sumByCurrency(allBalances.filter((b) => b.amountMinor < 0));
  const net = sumByCurrency(allBalances);

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <div className="page-actions">
          <Link to="/groups/new">
            <button className="secondary inline">New group</button>
          </Link>
          <Link to="/friends/new">
            <button className="inline">Add a friend</button>
          </Link>
        </div>
      </div>

      <div className="summary">
        <div>
          <span className="eyebrow">Net position</span>
          {/* Signed and not absolute: this column mixes directions, so the
              minus sign has to carry the meaning, not just the colour. */}
          <SummaryLedger balances={net} empty="All settled" signed showSign />
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

      <p className="ledger-note">
        Every currency is a separate ledger. Nothing here is converted, so there is no combined
        total to show.
      </p>

      <div className="columns" style={{ marginTop: "1.75rem" }}>
        <section>
          <h2 style={{ marginTop: 0 }}>You owe</h2>
          <PeopleList people={youOwe} direction="negative" empty="You don't owe anyone." />
        </section>
        <section>
          <h2 style={{ marginTop: 0 }}>You are owed</h2>
          <PeopleList people={owedToYou} direction="positive" empty="Nobody owes you." />
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
 * `direction` picks which half of a mixed balance to show: someone you owe EUR
 * but who owes you USD appears in both columns, each showing only its side.
 */
function PeopleList({
  people,
  direction,
  empty,
}: {
  people: Friend[];
  direction: "positive" | "negative";
  empty: string;
}) {
  if (people.length === 0) return <p className="empty">{empty}</p>;

  const keep = (amount: number) => (direction === "positive" ? amount > 0 : amount < 0);

  return (
    <div className="list">
      {people.map((person) => {
        const relevant = person.balances.filter((b) => keep(b.amountMinor));

        return (
          <Link key={person.id} to={`/friends/${person.id}`} className="list-item">
            <Avatar id={person.id} name={fullName(person)} />
            <div className="list-item-body">
              <div className="list-item-title">{fullName(person)}</div>
              <div className={direction}>
                {direction === "positive" ? "owes you " : "you owe "}
                <Amounts balances={relevant} absolute />
              </div>
              {/* Every bucket, signed - including ones pointing the other way.
                  Filtering to this column's direction would print sub-lines
                  that don't add up to the figure above them. Only shown when
                  there is more than one, since a single line just repeats it. */}
              {person.breakdown.length > 1 && (
                <ul className="breakdown">
                  {person.breakdown.map((entry) => (
                    <li key={entry.groupId ?? "none"}>
                      <Amounts balances={entry.balances} signed /> in{" "}
                      {entry.groupName ?? "one-on-one expenses"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
