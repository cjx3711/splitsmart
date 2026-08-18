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
sorted by `userId` before allocation. `userId` is a ULID; the sort is string
`<`, never numeric coerce and never `localeCompare`. Determinism matters: if
the order varied, re-saving an expense would shuffle whose cent it is and
balances would drift.

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
| `email` | required, unique | always NULL (must not occupy the login index) |
| `invite_email` | always NULL | optional, unique among that owner's live friend-ghosts |
| `password_hash` | required | NULL (enforced) |
| Identity | email + password | none of their own; a guest link acts as them |

CHECK constraints enforce both directions: a real account must be able to
authenticate, and a ghost must not carry credentials it cannot use.

A ghost is a **placeholder person** somebody with an account created. They have
no credential; a guest reaches their data by holding an `access_links` secret
that says it may act as them. See `docs/GUEST.md`.

A ghost is never upgraded in place. The one path is CLAIM: create a real
account, then merge the ghost into it (`src/domain/merge.ts`), which rewrites
every FK onto the survivor and retires the ghost row with `merged_into_user_id`
+ `deleted_at`. The merge exists so the app can handle the case an in-place
upgrade never could: someone who already had an account. It never moves a
balance; where both people are on one expense the two shares are added, not
re-split.

## Soft deletes

`expenses.deleted_at` rather than a DELETE, for three reasons: balance queries
filter on it, the compat API must return `deleted_at` to clients so they can
sync incrementally, and `restoreExpense` can put a row back. Never hard-delete an
expense.

Restore is not just clearing the column: `expense_repayments` is rebuilt from
`expense_users` on the way back, because it is a cache (above) and the row has
been sitting outside every balance query since the delete. `yarn db:check` is the
proof that the two agree afterwards.

## Comments

Two kinds of row in `comments`, distinguished by `kind`:

- **`user`** - somebody typed it. Deletable by its author and nobody else.
- **`system`** - generated when an expense is edited, deleted or restored, and
  hung on the bill so "why is this 92.43 now" is answerable from the expense
  rather than from the global activity feed. Never accepted over HTTP, never
  deletable.

`kind` is a column rather than a metadata key because listing a thread has to
distinguish the two, and a WHERE on `json_extract` is not free.

A comment is **not part of the expense**. It has no `version`, it cannot
conflict, and writing one must never bump the expense's own version once offline
sync exists (`docs/OFFLINE.md`) - otherwise an offline note would fight an
offline edit of the split. Deletes are soft, so merge and re-import matching
still find the row. All writes go through `src/domain/comments.ts`.

## Recurring expenses

A series is one **template** row plus ordinary expenses generated from it. There
is no bundle table: the template's id, carried by each occurrence in
`repeat_of`, is the bundle.

| | `repeat_interval` | `next_repeat` | `repeat_of` |
|---|---|---|---|
| template | set | set | NULL |
| occurrence | NULL | NULL | set |
| ordinary expense | NULL | NULL | NULL |

CHECK constraints enforce that a template is always scheduled and that an
occurrence is never itself a template, so a series stays one level deep and
"which bills belong to this series" is one WHERE clause forever.

`next_repeat` advances by exactly **one interval** per scheduler tick
(`src/domain/scheduler.ts`), and each generated bill is dated the day it was due.
A series that fell behind during downtime therefore catches up one bill at a
time instead of dropping three months of rent into the ledger all dated today.

## Metadata

`users`, `groups`, `expenses` and `comments` carry a JSON `metadata` column
(default `'{}'`). It is a bag for data that does not need to be joined or
filtered on, except for one key:

`splitwise_id` is the import matching key. Entity PKs are always fresh ULIDs;
the original Splitwise integer is **not** reused as `id` and is **not**
returned on `/api/sw/v3.0`. A unique expression index on
`json_extract(metadata, '$.splitwise_id')` lets a second import match instead
of duplicating. `notes` and other leftovers share the same object. See
`src/domain/metadata.ts` and `docs/ULIDS.md`.

## Payments

A settle-up is an expense with `is_payment = 1`, where the payer covers the whole
cost and the recipient owes all of it. Modelling it this way means it falls out
of the same balance query as everything else instead of needing its own path.

## STRICT tables

Every table is `STRICT`, so SQLite rejects type mismatches instead of coercing
them. In a system where a string sneaking into an integer money column is a real
hazard, failing loudly is the point. Do not remove it.
