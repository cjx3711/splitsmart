# CLAUDE.md — working on SplitSmart

Read this before changing anything. It is written for agents and covers the
invariants that are easy to break and hard to notice.

## What this is

A self-hosted Splitwise replacement with **byte-level API compatibility** for the
endpoints Splitwise clients actually use. Two consumers matter:

1. The React frontend in `web/` — talks to the native API at `/api/v1`.
2. External tools (notably `splitwise-to-toshl`) — talk to the compat API at
   `/api/v3.0`, which mimics Splitwise's v3.0 wire format exactly.

The long-term goal is full API parity. See `docs/PLAN.md` for the roadmap and
`docs/SPLITWISE_COMPAT.md` for the endpoint-by-endpoint status.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node ≥ 22 | `--experimental-strip-types` runs `.ts` directly, no build in dev |
| Server | Hono | `src/server.ts` mounts everything |
| Database | SQLite via better-sqlite3 | WAL, foreign keys ON |
| Queries | Kysely | Typed builder. **No ORM** — raw SQL via `sql\`\`` for aggregates |
| Validation | Zod | At route boundaries only |
| Frontend | React + Vite | Built to `web/dist`, served by the same Node process |
| Tests | `node:test` | Built in, no framework |

**better-sqlite3 must be v13+.** Versions ≤ 12 do not compile against Node 26.

## Commands

```bash
yarn install
cp .env.example .env        # then set SESSION_SECRET
yarn db:migrate             # apply migrations
yarn db:seed                # currencies + categories (idempotent)
yarn dev                    # API on :5545, Vite on :5173
yarn test                   # all tests
yarn typecheck              # server + web
yarn db:check               # AUDIT DATA INTEGRITY — run after any expense change
yarn db:reset                # wipe and rebuild the local database
```

## The five rules

These are the things that will silently corrupt financial data if broken.

### 1. Money is always integer minor units

Never `REAL`, never a float, never `amount * 100`. Columns are named `*_minor`.
Conversion happens **only** at the edges via `src/domain/money.ts`:
`parseAmount()` in, `formatAmount()` out.

A minor-unit integer is meaningless without its currency: `1000` is `10.00 USD`
but `1000 JPY`. Always carry `currency_code` alongside, and get decimal places
from the `currencies` table — never assume 2.

`src/db/currencies.ts` holds 168 currencies — the full active ISO 4217 list plus
11 legacy codes Splitwise still accepts. Exponents: 17 zero-decimal (JPY, KRW,
VND, ISK, the CFA francs, BYR), 7 three-decimal (the Gulf dinars plus TND), 2
four-decimal accounting units, and BTC at 8. `currencies.test.ts` pins those
sets exactly — if you change an exponent, that test should stop you.

The list is complete on purpose: `expenses.currency_code` is a foreign key, so a
missing currency rejects the expense rather than degrading gracefully. That is
also why demonetised codes (HRK, LTL, VEF…) are present — Splitwise still lists
them because users have historical expenses in them, and dropping one would make
that history unimportable.

### 2. Currencies are never converted

Balances are parallel per-currency ledgers. That is why every balance API
returns an **array**. There is no exchange-rate table and there must not be one —
netting USD against EUR requires an opinion about which day's rate applies, and
that does not belong in a ledger.

### 3. All expense writes go through `src/domain/expenses.ts`

Nothing else may write `expenses`, `expense_users`, or `expense_repayments`.

The invariant, for every non-deleted expense:

```
SUM(expense_users.paid_share_minor) == expenses.cost_minor
SUM(expense_users.owed_share_minor) == expenses.cost_minor
```

SQLite cannot express this — it spans rows — so it is enforced in application
code inside a transaction, and audited by `yarn db:check`. If you add a code
path that touches these tables directly, you have created a bug that will not
surface until someone's balance is wrong.

### 4. `expense_repayments` is a cache, not a source of truth

It stores the derived who-owes-whom for each expense so balance queries stay a
plain `SUM ... GROUP BY` instead of re-deriving creditor/debtor matching on
every page load. It is rebuilt from scratch on every expense write by
`deriveRepayments()`. If it ever disagrees with `expense_users`, `expense_users`
wins. `yarn db:check` verifies the two agree.

### 5. The compat layer's wire format is frozen

`src/routes/compat/` must reproduce Splitwise's shapes exactly, including the
parts that are ugly:

- money as decimal **strings** (`"25.00"`), not numbers
- `users__0__paid_share` flattened keys on `create_expense` input
- `deleted_at` tombstones returned to the client, not filtered out
- both `user_id` **and** nested `user.id` on expense participants

Wrong-but-compatible beats right-but-broken. **Do not "improve" a response
shape.** `src/routes/compat/v3.test.ts` asserts on these field names and string
formats specifically to catch well-intentioned cleanups. New features get native
routes under `/api/v1` — never extend `/api/v3.0` with fields Splitwise never had.

## Layout

```
migrations/          Forward-only .sql, applied in filename order
src/
  env.ts             Zod-validated environment, frozen at import
  db/
    index.ts         Connection + pragmas + transaction()
    types.ts         Kysely types — regenerate with `yarn db:codegen`
    migrate.ts       Migration runner
    currencies.ts    ISO 4217 + Splitwise's legacy codes
    categories.ts    Splitwise's REAL category tree, with their ids
    seed.ts          Loads both (idempotent)
  domain/            PURE business logic — no I/O except expenses.ts
    money.ts         parse/format/split helpers
    split.ts         The split engine. Pure. Heavily tested.
    balances.ts      Balance queries + simplifyDebts
    expenses.ts      The ONLY writer of expense tables
  auth/
    password.ts      scrypt hashing + token generation
    session.ts       Cookie sessions AND bearer API tokens
    middleware.ts    requireAuth / optionalAuth
  routes/
    native/          Clean API at /api/v1 — used by web/
    compat/          Splitwise v3.0 shim. Wire format frozen.
  server.ts          Entry point
web/                 React frontend (Vite)
scripts/
  export-splitwise.ts    Raw API dump — RUN THIS FIRST, see below
  check-invariants.ts    Data integrity audit
docs/                Plan, data model, compat reference
fixtures/splitwise/  REAL API responses, captured while the API is free.
                     Treat as read-only ground truth — categories.test.ts diffs
                     our data against them. Cannot be re-fetched once Splitwise
                     paywalls the API.
```

## Category IDs are Splitwise's real IDs

`src/db/categories.ts` is not a reconstruction — it was captured from the live
API. This matters because `category_id` passes straight through the compat
layer, so an imported expense or a third-party client carrying a Splitwise id
has to resolve to the same category here.

The ids are **non-sequential**, and parents and children share **one** id space:
parents are 1, 2, 19, 25, 27, 31, 40 while children run 3–50. `Dining out` is
13, `Uncategorized > General` is 18 (the default). Do not renumber them, and do
not "sort" the tree — `src/db/categories.test.ts` diffs it against
`fixtures/splitwise/get_categories.json` on every run and will fail.

## Auth model

Two independent paths, deliberately separate:

- **Sessions** — httpOnly cookie, 30-day expiry, for the web UI.
- **API tokens** — bearer header, long-lived, revocable, for external clients.

`requireAuth` accepts either, so one route tree serves both.

Only hashes are stored for both. Passwords use scrypt with self-describing
hashes (`scrypt$N$r$p$salt$hash`) so raising the cost or migrating to argon2 is a
non-event — `needsRehash()` drives transparent upgrade on login. Session and API
tokens use plain SHA-256, which is correct because they are already full-entropy
random; scrypt there would add 200ms to every request for no security gain.

## Ghost accounts

Two kinds of user share the `users` table:

- **Real** (`is_ghost = 0`) — email + password, can log in normally.
- **Ghost** (`is_ghost = 1`) — created by opening a group invite link. No email,
  no password. Identity is possession of a session cookie, with a one-time
  recovery code as the only way back in from another device.

A ghost is upgraded to a real account **in place** (`POST /api/v1/invite/claim`)
by setting email + password and flipping the flag. Never create a new user and
merge — keeping the row means every expense, share and repayment stays attached
and no balance moves.

Known trade-offs, accepted deliberately: anyone holding an invite link can join
**and read every expense in that group**; rotating the token stops future joins
but does not remove existing members.

## Email

`src/email/` — Postmark transport, templates, and the verification flow.
Migration 002 adds `email_tokens`.

**`sendEmail()` never throws and never blocks boot.** With Postmark
unconfigured it logs the message — link included — to the console. That is the
documented unconfigured path, not a failure: it is how you complete verification
locally, and it means a mail outage cannot turn a successful registration into a
500. Callers check `result.delivered` rather than catching.

Verification tokens are single-use, expire in 24h, stored hash-only, and issuing
a new one supersedes any outstanding ones.

Two details that look optional and are not:

- **`email_tokens.email` is a snapshot** of the address at issue time.
  Consuming compares it against `users.email` and refuses on mismatch —
  otherwise a pending link would verify an address it was never issued for.
- **`/verify/resend` must stay registered BEFORE `/verify/:token`.** Hono matches
  in order; reverse them and "resend" is captured as a token and the endpoint
  becomes unreachable. There is a regression test for this.

Enforcement is advisory by default: unverified users log in fine and see a
banner. `EMAIL_VERIFICATION_REQUIRED=true` blocks login instead — and if you
enable it on a box where Postmark is broken, nobody can get in. The way out is
`yarn verify:user -- you@example.com`, which needs only filesystem access.

Ghosts have no address. `needsEmailVerification` is always false for them, and
`issueVerificationToken` returns `no_email` — never nag a guest to confirm an
address they do not have.

## No file uploads

There is no upload endpoint, no multipart parsing, no image handling, and no
object storage anywhere in this codebase. This is intentional.

The only trace is `receipt: { large: null, original: null }` in
`src/routes/compat/serializers.ts`, which is a hardcoded null so Splitwise
clients see the key they expect instead of `undefined`. It is not a feature stub.

If you are asked to add receipts, that is a real feature with real
consequences — storage, MIME sniffing, size limits, EXIF stripping, and serving
untrusted bytes — so it needs an explicit decision, not an incidental one.

## Things that will bite you

- **`src/db/index.ts` opens a connection at import time.** Tests must set
  `process.env.DATABASE_PATH` *before* importing anything that reaches it — see
  the dynamic-import pattern at the top of `src/routes/compat/v3.test.ts`.
- **`src/db/types.ts` is checked in but generated.** After a migration, run
  `yarn db:migrate && yarn db:codegen`. Hand-editing it without a matching
  migration gives you types that lie.
- **Rounding must be deterministic.** `splitEvenly` gives leftover minor units to
  the earliest participants, and participants are sorted by `userId` before
  allocation. Change that ordering and re-saving an expense shuffles whose cent
  it is, drifting balances.
- **`STRICT` tables.** SQLite will reject a type mismatch rather than coercing.
  This is intentional. Do not remove it.
- **Soft deletes only.** Every balance query filters `deleted_at IS NULL`, and
  the compat API must return `deleted_at` to clients. Never hard-delete an expense.

## Before you commit

```bash
yarn typecheck && yarn test && yarn db:check
```

If you touched anything under `src/domain/` or `src/routes/compat/`, the tests
in `split.test.ts` and `v3.test.ts` are the ones that matter. Both are fast.

## Splitwise export — time-sensitive

Splitwise is moving its API behind a paywall. `scripts/export-splitwise.ts`
dumps raw, untransformed JSON to `splitwise-export/<timestamp>/`. It does not
touch the database on purpose: the schema will change many times during
development, and a raw snapshot makes re-import free and repeatable instead of
requiring another round-trip to an API that may no longer be free.

```bash
SPLITWISE_API_KEY=... yarn export:splitwise
```

The output is gitignored — it contains personal financial data. Back it up
somewhere private.
