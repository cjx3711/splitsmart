/**
 * The dashboard.
 *
 * Per-currency rows are the honest picture: there is no exchange-rate table in
 * the ledger and there must not be one (see src/domain/balances.ts). With one
 * currency the amount is the headline. With several, a labeled ≈ estimate in
 * the viewer's preferred currency leads - the same shape as a group roster -
 * and the real ledgers fold underneath. The estimate is dated, display-only,
 * and sourced from Exchange Rate API (cached in the browser for a day).
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { displayName, type Friend, type CurrencyAmount } from "../api.ts";
import { Amount, Amounts, sumByCurrency, useCurrencies } from "../money.tsx";
import { avatarFromRow } from "../Avatar.tsx";
import { FriendListItem } from "../FriendListItem.tsx";
import { useAuth } from "../App.tsx";
import { useFriends } from "../localData.ts";
import { OnlineOnly } from "../OnlineOnly.tsx";
import { ConversionFootnote, useConvertedTotal } from "../ConversionNote.tsx";
import { BalanceDetail } from "../GroupBalances.tsx";
import { friendDashboardColumn, useExchangeRates } from "../exchangeRates.ts";
import { HelpTip } from "../HelpTip.tsx";
import { Skeleton } from "../Skeleton.tsx";

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

  if (!user) return <Skeleton kind="page" />;

  const head = (
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
  );

  if (!friends) {
    return (
      <>
        {head}
        <Skeleton kind="dashboard" />
      </>
    );
  }

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
      {head}

      <div className="summary">
        <div>
          <span className="eyebrow">Net position</span>
          {/* Signed and not absolute: this column mixes directions, so the
              minus sign has to carry the meaning, not just the colour. */}
          <SummaryLedger
            balances={net}
            preferredCurrency={user.defaultCurrency}
            empty="All settled"
            signed
            showSign
          />
        </div>
        <div>
          <span className="eyebrow">You owe</span>
          <SummaryLedger
            balances={negatives}
            preferredCurrency={user.defaultCurrency}
            empty="Nothing"
            tone="negative"
          />
        </div>
        <div>
          <span className="eyebrow">You are owed</span>
          <SummaryLedger
            balances={positives}
            preferredCurrency={user.defaultCurrency}
            empty="Nothing"
            tone="positive"
          />
        </div>
      </div>

      <ConversionFootnote
        sets={[net, ...friends.map((f) => f.balances)]}
        preferredCurrency={user.defaultCurrency}
        settingsHref="/settings"
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
  preferredCurrency,
  empty,
  signed = false,
  showSign = false,
  tone,
}: {
  balances: CurrencyAmount[];
  preferredCurrency: string;
  empty: string;
  signed?: boolean;
  /** Keep the minus sign. Needed wherever a column mixes both directions. */
  showSign?: boolean;
  tone?: "positive" | "negative";
}) {
  const estimate = useConvertedTotal(balances, preferredCurrency);
  if (balances.length === 0) return <span className="muted">{empty}</span>;

  const rows = (
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

  const headlineClass = (minor: number) => {
    const sign = tone ?? (minor >= 0 ? "positive" : "negative");
    return `summary-headline ${sign}`;
  };

  if (balances.length === 1) {
    const only = balances[0]!;
    return (
      <>
        <div className={headlineClass(only.amountMinor)}>
          <Amount
            minor={only.amountMinor}
            currency={only.currencyCode}
            signed={signed}
            absolute={!showSign}
          />
        </div>
        {estimate !== null && (
          <div className="estimate">
            ≈ <Amount minor={estimate} currency={preferredCurrency} signed={signed} absolute={!showSign} />{" "}
            overall*
          </div>
        )}
      </>
    );
  }

  // Several currencies: converted total is the headline, same shape as a group
  // roster. Do not mark it `.estimate` — smoke hides that class, and these cards
  // would then show only a closed dropdown. If rates are not in, leave the
  // per-currency rows visible rather than folding them away.
  if (estimate === null) return rows;

  return (
    <>
      <div className={headlineClass(estimate)}>
        <span className="balance-approx">≈</span>
        <Amount
          minor={estimate}
          currency={preferredCurrency}
          signed={signed}
          absolute={!showSign}
        />
        <span className="balance-approx">*</span>
      </div>
      <BalanceDetail label={balances.map((b) => b.currencyCode).join(" · ")}>
        {rows}
      </BalanceDetail>
    </>
  );
}

/**
 * One row per person. A single currency is the headline; mixed currencies and
 * per-group buckets fold under a dropdown, same shape as a group roster.
 *
 * Mixed balances still show both directions inside that dropdown so "you owe
 * SGD" does not hide "they owe you JPY". The column they sit in is the
 * converted net when rates are in; until then a mixed person can still appear
 * in both.
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
      {people.map((person) => (
        <FriendOweage
          key={person.id}
          person={person}
          preferredCurrency={preferredCurrency}
        />
      ))}
    </div>
  );
}

function FriendOweage({
  person,
  preferredCurrency,
}: {
  person: Friend;
  preferredCurrency: string;
}) {
  const estimate = useConvertedTotal(person.balances, preferredCurrency);
  const youOwe = person.balances.filter((b) => b.amountMinor < 0);
  const theyOwe = person.balances.filter((b) => b.amountMinor > 0);
  const showGroups = person.breakdown.length > 1;
  const multiCurrency = person.balances.length > 1;

  const currencyLines = (
    <>
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
    </>
  );

  const groupLines = showGroups ? (
    <ul className="breakdown">
      {person.breakdown.map((entry) => (
        <li key={entry.groupId ?? "none"}>
          <Amounts balances={entry.balances} signed />
          <span className="breakdown-where">
            {entry.groupId ? entry.groupName?.trim() || "this group" : "one-on-one"}
          </span>
        </li>
      ))}
    </ul>
  ) : null;

  const detailLabel = multiCurrency
    ? person.balances.map((b) => b.currencyCode).join(" · ")
    : person.breakdown
        .map((entry) =>
          entry.groupId ? entry.groupName?.trim() || "this group" : "one-on-one",
        )
        .join(" · ");

  let headline: ReactNode = null;
  if (multiCurrency && estimate !== null) {
    const positive = estimate >= 0;
    headline = (
      <div className={`owe-headline ${positive ? "positive" : "negative"}`}>
        <span className="balance-approx">≈</span>
        {positive ? "owes you " : "you owe "}
        <Amount minor={estimate} currency={preferredCurrency} absolute />
        <span className="balance-approx">*</span>
      </div>
    );
  } else if (multiCurrency) {
    headline = currencyLines;
  } else {
    headline = (
      <>
        {currencyLines}
        {estimate !== null && (
          <div className="estimate estimate-compact">
            ≈ <Amount minor={estimate} currency={preferredCurrency} absolute />*
          </div>
        )}
      </>
    );
  }

  const extra =
    (multiCurrency && estimate !== null) || showGroups ? (
      <BalanceDetail label={detailLabel}>
        {multiCurrency && estimate !== null ? (
          <div className="owe-summary">{currencyLines}</div>
        ) : null}
        {groupLines}
      </BalanceDetail>
    ) : undefined;

  return (
    <FriendListItem
      to={`/friends/${person.id}`}
      avatar={avatarFromRow(person)}
      title={displayName(person)}
      subtitle={headline ? <div className="owe-summary">{headline}</div> : undefined}
      extra={extra}
    />
  );
}
