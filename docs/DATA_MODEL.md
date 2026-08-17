# Data model

Schema lives in `migrations/001_initial_schema.sql`, which carries inline
commentary. This file explains the reasoning behind the choices that are easy to
get wrong.

## Money

Every amount is an **integer number of minor units** in a `*_minor` column,
paired with a `currency_code`.

`currencies.decimal_places` is load-bearing; it is the only way to turn a
minor-unit integer back into a display string:

| Currency | Decimals | `1000` means |
|---|---|---|
| USD, EUR, SGD | 2 | 10.00 |
| JPY, KRW, VND | 0 | 1000 |
| KWD, BHD, OMR | 3 | 1.000 |

Never assume 2. The seed includes three-decimal currencies specifically so tests
can catch code that does.

Parsing is string-based (`src/domain/money.ts`), not
`Math.round(parseFloat(s) * 100)`; the latter is wrong for values like `"8.115"`
that have no exact binary representation.

## The expense invariant

For every non-deleted expense:

```
SUM(expense_users.paid_share_minor) == expenses.cost_minor
SUM(expense_users.owed_share_minor) == expenses.cost_minor
```

Two independent numbers per participant:

- `paid_share_minor`: how much cash they actually put in
- `owed_share_minor`: how much of the cost is their responsibility

Their difference is that person's net position. Both sums must equal the total:
the first says the money was actually paid, the second says it was fully
allocated.

SQLite cannot express a cross-row CHECK, so this is enforced in
`src/domain/expenses.ts` inside a transaction and audited by `yarn db:check`.

## Why `expense_repayments` exists

`expense_users` gives each person's **net** position but not who owes whom, which
is what every balance screen needs. Deriving it requires matching creditors to
debtors; cheap for one expense, wasteful on every page load.

So it is computed once at write time by `deriveRepayments()` and stored. Balance
queries become a plain `SUM ... GROUP BY`.

It is a **cache**. `expense_users` is the source of truth. `yarn db:check`
verifies the two agree.

## Rounding

`splitEvenly(1000, 3)` → `[334, 333, 333]`, never `[333.33, …]`.

Remainder minor units go to the **earliest participants**, and participants are
sorted by `userId` before allocation. Determinism matters: if the order varied,
re-saving an expense would shuffle whose cent it is and balances would drift.

`splitByWeights` (percent and shares) uses largest-remainder: floor every share,
then give leftovers to whoever lost most to rounding, ties broken by index.

## Currencies are never converted

Balances are parallel per-currency ledgers, which is why every balance API
returns an array. There is no exchange-rate table and there must not be one.
Netting USD against EUR requires an opinion about which day's rate applies, and
a ledger should not hold opinions.

## Users: real and ghost

One table, two kinds:

| | Real | Ghost |
|---|---|---|
| `is_ghost` | 0 | 1 |
| `email` | required | NULL |
| `password_hash` | required | NULL (enforced) |
| Identity | email + password | session cookie + recovery code |

CHECK constraints enforce both directions: a real account must be able to
authenticate, and a ghost must not carry credentials it cannot use.

Upgrading a ghost happens **in place**: same row, set email + password, flip the
flag. Creating a new user and merging would mean rewriting every expense share
and repayment, and any mistake there moves money.

## Soft deletes

`expenses.deleted_at` rather than a DELETE, for two reasons: balance queries
filter on it, and the compat API must return `deleted_at` to clients so they can
sync incrementally. Never hard-delete an expense.

## Splitwise ID preservation

`users`, `groups`, `expenses`, `categories` and `comments` carry a nullable
`splitwise_id`. The importer inserts with `id = splitwise_id` so external
references, including anything `splitwise-to-toshl` already recorded, stay
valid, then bumps `sqlite_sequence` past the highest imported id so new local
rows never collide.

## Payments

A settle-up is an expense with `is_payment = 1`, where the payer covers the whole
cost and the recipient owes all of it. Modelling it this way means it falls out
of the same balance query as everything else instead of needing its own path.

## STRICT tables

Every table is `STRICT`, so SQLite rejects type mismatches instead of coercing
them. In a system where a string sneaking into an integer money column is a real
hazard, failing loudly is the point. Do not remove it.
