# CLAUDE.md: working on SplitSmart

Read this before changing anything. It is written for agents and covers the
invariants that are easy to break and hard to notice.

## What this is

A self-hosted Splitwise replacement with **byte-level API compatibility** for the
endpoints Splitwise clients actually use. Two consumers matter:

1. The React frontend in `web/` talks to the native API at `/api/v1`.
2. External tools (notably `splitwise-to-toshl`) talk to the compat API at
   `/api/sw/v3.0`, which mimics Splitwise's v3.0 wire format exactly.

The long-term goal is full API parity. See `docs/PLAN.md` for the roadmap and
`docs/SPLITWISE_COMPAT.md` for the endpoint-by-endpoint status.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node ≥ 22 | `--experimental-strip-types` runs `.ts` directly, no build in dev |
| Server | Hono | `src/server.ts` mounts everything |
| Database | SQLite via better-sqlite3 | WAL, foreign keys ON |
| Queries | Kysely | Typed builder. **No ORM**: raw SQL via `sql\`\`` for aggregates |
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
yarn db:check               # AUDIT DATA INTEGRITY: run after any expense change
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
from the `currencies` table; never assume 2.

This holds in the frontend too. `web/src/money.tsx` fetches the currencies table
once and exposes `<Amount>`, `<Amounts>` and `useParseMoney()`; its
`formatMoney(minor, decimalPlaces)` takes decimals as a **required** argument
specifically so nothing can default to 2. Render money through those components
or not at all. Use `<Amounts>` for several currencies on one line, rendered
back to back, `34750 JPY 74.02 USD` reads as one number.

`src/db/currencies.ts` holds 168 currencies: the full active ISO 4217 list plus
11 legacy codes Splitwise still accepts. Exponents: 17 zero-decimal (JPY, KRW,
VND, ISK, the CFA francs, BYR), 7 three-decimal (the Gulf dinars plus TND), 2
four-decimal accounting units, and BTC at 8. `currencies.test.ts` pins those
sets exactly; if you change an exponent, that test should stop you.

The list is complete on purpose: `expenses.currency_code` is a foreign key, so a
missing currency rejects the expense rather than degrading gracefully. That is
also why demonetised codes (HRK, LTL, VEF…) are present: Splitwise still lists
them because users have historical expenses in them, and dropping one would make
that history unimportable.

### 2. Currencies are never converted

Balances are parallel per-currency ledgers. That is why every balance API
returns an **array**. There is no exchange-rate table and there must not be one -
netting USD against EUR requires an opinion about which day's rate applies, and
that does not belong in a ledger.

### 3. All expense writes go through `src/domain/expenses.ts`

Nothing else may write `expenses`, `expense_users`, or `expense_repayments`.

The invariant, for every non-deleted expense:

```
SUM(expense_users.paid_share_minor) == expenses.cost_minor
SUM(expense_users.owed_share_minor) == expenses.cost_minor
```

SQLite cannot express this; it spans rows, so it is enforced in application
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
routes under `/api/v1`. Never extend `/api/sw/v3.0` with fields Splitwise never had.

## Layout

```
migrations/          Forward-only .sql, applied in filename order
src/
  env.ts             Zod-validated environment, frozen at import
  db/
    index.ts         Connection + pragmas + transaction()
    types.ts         Kysely types: regenerate with `yarn db:codegen`
    migrate.ts       Migration runner
    currencies.ts    ISO 4217 + Splitwise's legacy codes
    categories.ts    Splitwise's REAL category tree, with their ids
    seed.ts          Loads both (idempotent)
  domain/            PURE business logic: no I/O except expenses.ts
    money.ts         parse/format/split helpers
    split.ts         The split engine. Pure. Heavily tested. Also imported by
                     the frontend. See "Split types" below.
    balances.ts      Balance queries + simplifyDebts
    expenses.ts      The ONLY writer of expense tables
    friends.ts       Explicit vs derived friendships. ONE definition of "friend"
    import.ts        Splitwise import: people -> groups -> expenses
  splitwise/
    client.ts        READ-ONLY client for the real Splitwise API. Nothing else
                     may talk to secure.splitwise.com.
  auth/
    password.ts      scrypt hashing + token generation
    session.ts       Cookie sessions AND bearer API tokens
    middleware.ts    requireAuth / optionalAuth
  routes/
    native/          Clean API at /api/v1, used by web/
    compat/          Splitwise v3.0 shim. Wire format frozen.
  server.ts          Entry point
web/                 React frontend (Vite)
  src/
    money.tsx        Currency-aware formatting. THE ONLY WAY TO RENDER MONEY
    Logo.tsx         The mark (also copied literally into public/favicon.svg)
    Sidebar.tsx      Owns the group/friend lists shown on every screen
    ExpenseForm.tsx      The one add-expense form (group, friend, or neither)
    AddExpenseDialog.tsx Loads the people/groups it offers; the only entry point
    PeoplePicker.tsx     Who is on the expense: an email-style To: field
    PaidBy.tsx           Who put the money in. NOT how it is split
    SplitEditor.tsx      How it is split, previewed with the real engine
    categories.tsx       Category icons (react-icons/lucide) + the picker
scripts/
  export-splitwise.ts    Raw API dump. RUN THIS FIRST, see below
  check-invariants.ts    Data integrity audit
docs/                Plan, data model, compat reference
fixtures/splitwise/  REAL API responses, captured while the API is free.
                     Treat as read-only ground truth; categories.test.ts diffs
                     our data against them. Cannot be re-fetched once Splitwise
                     paywalls the API.
```

## Category IDs are Splitwise's real IDs

`src/db/categories.ts` is not a reconstruction: it was captured from the live
API. This matters because `category_id` passes straight through the compat
layer, so an imported expense or a third-party client carrying a Splitwise id
has to resolve to the same category here.

The ids are **non-sequential**, and parents and children share **one** id space:
parents are 1, 2, 19, 25, 27, 31, 40 while children run 3–50. `Dining out` is
13, `Uncategorized > General` is 18 (the default). Do not renumber them, and do
not "sort" the tree; `src/db/categories.test.ts` diffs it against
`fixtures/splitwise/get_categories.json` on every run and will fail.

## Auth model

Two independent paths, deliberately separate:

- **Sessions**: httpOnly cookie, 30-day expiry, for the web UI.
- **API tokens**: bearer header, long-lived, revocable, for external clients.

`requireAuth` accepts either, so one route tree serves both.

Only hashes are stored for both. Passwords use scrypt with self-describing
hashes (`scrypt$N$r$p$salt$hash`) so raising the cost or migrating to argon2 is a
non-event; `needsRehash()` drives transparent upgrade on login. Session and API
tokens use plain SHA-256, which is correct because they are already full-entropy
random; scrypt there would add 200ms to every request for no security gain.

## Ghost accounts

Two kinds of user share the `users` table:

- **Real** (`is_ghost = 0`): email + password, can log in normally.
- **Ghost** (`is_ghost = 1`): created by opening a group invite link. No email,
  no password. Identity is possession of a session cookie, with a one-time
  recovery code as the only way back in from another device.

A ghost is upgraded to a real account **in place** (`POST /api/v1/invite/claim`)
by setting email + password and flipping the flag. Never create a new user and
merge; keeping the row means every expense, share and repayment stays attached
and no balance moves.

**A ghost may carry an email.** `POST /api/v1/friends` creates one with the
address you invited them at, so the invite has somewhere to go. This is safe
because login rejects ghosts outright and `issueVerificationToken` returns
`no_email` for them; an unverified address on a ghost can never become a
working login. It is also why `/invite/claim` excludes the caller's own row when
checking whether an address is taken: without that, the invitee's own pending
address blocks them from claiming their own account. There is a test for it.

Known trade-offs, accepted deliberately: anyone holding an invite link can join
**and read every expense in that group**; rotating the token stops future joins
but does not remove existing members.

## Split types

Six, all in `src/domain/split.ts`: `equal`, `exact`, `percent`, `shares`,
`adjustment`, `itemized`. Five of them are one number per person, carried in
`expense_users.split_input`, which exists only so the editor can reopen the
form, and is **never** used to compute a balance.

**The frontend imports the split engine.** `src/domain/split.ts` is pure: no
database, no Node built-ins, so `web/src/SplitEditor.tsx` runs the real
`computeSplit()` to preview a split as you type. This is deliberate and worth
preserving: the alternative is a second implementation of the rounding in the
browser, which would drift, and the first symptom of drift is a preview that
disagrees with the stored expense by a cent. Keep that module free of I/O.
The server still recomputes on submit and stays authoritative.

Itemization is the one that does not fit one-number-per-person: a bill has
several lines, each shared by a different subset of the table. So:

- **Lines are computed, then thrown into `expenses.split_meta` as JSON.** Each
  line splits evenly among its own sharers; whatever the lines do not cover -
  tax, tip, service charge) is spread in in **proportion** to what each person
  already owes, because that is what proportional tax means. If every line is
  zero there are no weights, so it falls back to an even split rather than
  throwing.
- **`split_meta` is presentation detail, not ledger data.** Nothing queries it,
  sums it, or joins on it; it is read back whole by the editor and nothing else.
  Delete every byte of it and all balances in the app are unchanged. The derived
  shares in `expense_users` remain the only thing balance queries read, so the
  invariant is untouched.
- Two CHECKs enforce that: `split_meta` must be valid JSON, and it must be NULL
  unless `split_type = 'itemized'`. So editing an itemized expense into a
  percent one has to **clear** the blob; `updateExpense` always writes the
  column rather than leaving it alone, and there is a test for it.
- **`taxMinor` / `tipMinor` live in that same blob and are captions, not
  maths.** They name part of the gap the engine already spreads, so sending
  them changes no share. `createExpense` refuses a pair that does not equal
  `cost - sum(items)` exactly: a stored tip that contradicts the ledger under
  it is worse than no tip at all. The form never lets that happen, because in
  itemized mode the amount box is **derived** (lines + tax + tip), rather than
  typed.

Adding a seventh split type means touching a Zod enum, a DB CHECK constraint,
and the engine. The enum lives in `src/routes/native/expense-schema.ts`, shared
by the group and friend routes so it cannot be added to one and forgotten on the
other. The CHECK means a table rebuild. See below.

## Paying is not splitting

`expense_users.paid_share_minor` is per person and always has been: several
people can each have fronted part of one bill, and the split engine takes them
as given (it only insists they sum to the cost). The add-expense form exposes
that as three shapes: one payer, stated amounts per payer, or "everyone paid
their own share", which is resolved by computing the split first and then
setting each person's payment to what they owe.

Keep the two axes apart in the UI as well as the model. `web/src/PaidBy.tsx`
edits payments and nothing else; `web/src/SplitEditor.tsx` decides who owes
what and never touches a payment.

## Where an expense can be created

Three endpoints write expenses, and the newest one is what the web UI uses:

| Route | Who may be on it |
|---|---|
| `POST /api/v1/expenses` | a group's members, or you + anyone you share history with |
| `POST /api/v1/groups/:id/expenses` | that group's members |
| `POST /api/v1/friends/:id/expenses` | exactly the two of you |

The narrow two are unchanged and still used; the generic one exists because the
add-expense dialog can name several people with no group at all, which neither
of the others can express. It requires the caller to be a participant: a
non-group expense between two other people creates a balance neither of them can
see and there is no screen for it.

On the client, `web/src/AddExpenseDialog.tsx` is the only place that knows where
people come from (a group's members, or your friends). `ExpenseForm` takes the
pool as a prop, so the group screen, the friend screen and the top bar all open
the same form.

## Friends

Two kinds, and the difference decides what the UI may offer:

- **Explicit**: a row in `friendships`, stored canonically with
  `user_a_id < user_b_id`. Removable.
- **Derived**, someone you share a live group or an expense with. No row.
  Not removable; they reappear on the next load.

`listRelatedUserIds()` in `src/domain/friends.ts` returns the union and is the
**only** definition of "who is my friend". Both `/api/v1/friends` and the compat
layer's `get_friends` call it, so the two cannot drift. Do not hand-roll the
UNION at a call site; the schema comment says so too.

Removing a friendship touches nothing financial. `DELETE /api/v1/friends/:id`
returns `stillVisible` so the UI can explain why someone is still listed rather
than looking broken.

**Friend invites do not use `email_tokens`.** The emailed link carries the
ghost's recovery code and lands on `/accept/:code`, which is just
`POST /invite/recover`. That was chosen over adding a `friend_invite` purpose
because SQLite cannot ALTER a CHECK constraint without rebuilding the table, and
because the recovery code still works when Postmark is unconfigured; the API
returns it so the inviter can pass it on by hand.

## Email

`src/email/`: Postmark transport, templates, and the verification flow.
Migration 002 adds `email_tokens`.

**`sendEmail()` never throws and never blocks boot.** With Postmark
unconfigured it logs the message (link included) to the console. That is the
documented unconfigured path, not a failure: it is how you complete verification
locally, and it means a mail outage cannot turn a successful registration into a
500. Callers check `result.delivered` rather than catching.

Verification tokens are single-use, expire in 24h, stored hash-only, and issuing
a new one supersedes any outstanding ones.

Two details that look optional and are not:

- **`email_tokens.email` is a snapshot** of the address at issue time.
  Consuming compares it against `users.email` and refuses on mismatch -
  otherwise a pending link would verify an address it was never issued for.
- **`/verify/resend` must stay registered BEFORE `/verify/:token`.** Hono matches
  in order; reverse them and "resend" is captured as a token and the endpoint
  becomes unreachable. There is a regression test for this.

Enforcement is advisory by default: unverified users log in fine and see a
banner. `EMAIL_VERIFICATION_REQUIRED=true` blocks login instead, and if you
enable it on a box where Postmark is broken, nobody can get in. The way out is
`yarn verify:user -- you@example.com`, which needs only filesystem access.

Ghosts have no address. `needsEmailVerification` is always false for them, and
`issueVerificationToken` returns `no_email`; never nag a guest to confirm an
address they do not have.

## Splitwise import

Per-user and in-app, not a server-side script. `src/domain/import.ts` does the
work, `src/routes/native/import.ts` exposes it, `web/src/pages/Import.tsx` is a
thin wizard over those endpoints.

**The API key is the user's, and is never stored.** There is no
`SPLITWISE_API_KEY` in `src/env.ts` on purpose. The key arrives in the body of
each import request, is used for that request, and is dropped. A database dump
of this app therefore contains no credential to anyone else's Splitwise account.
Do not add a column, a cache, or a background job that would keep it; that
decision is the reason this is a sequence of short requests rather than one long
one.

**One step per request, in dependency order**, because expenses reference groups
and groups reference people:

```
GET  /api/v1/import/status     what is already here (no key needed)
POST /api/v1/import/preview    dry run: reads Splitwise, writes nothing
POST /api/v1/import/friends    step 1
POST /api/v1/import/groups     step 2
POST /api/v1/import/expenses   step 3, one page per call, resumable
POST /api/v1/import/run        all three server-side, for small accounts
```

That shape exists so the whole flow is drivable by curl or by a test with no
browser. `SPLITWISE_API_BASE` completes the picture: point it at a fake
Splitwise on localhost and `src/routes/native/import.test.ts` runs the real
client, the real routes and the real expense writer end to end.

Four things this must keep doing:

- **Identity is `splitwise_id` first, email second.** Every imported row carries
  the id it came from, so a second run matches instead of duplicating. Email is
  the *only* heuristic, used just to link a Splitwise contact to a SplitSmart
  account that already exists, and the preview names every person it applies to
  before anything is written, because a wrong match merges two people's money.
- **Splitwise's own `owed_share` is imported as an `exact` split.** Never
  re-derive an equal split from the total: the two disagree by a cent on
  three-way splits, and a cent is a balance.
- **Group 0 is not a group.** It is Splitwise's "Non-group expenses" bucket and
  maps to `group_id = NULL`.
- **A row that cannot be imported exactly is skipped with a reason**, never
  fudged. Unknown currency, missing group, shares that do not add up; each
  comes back in `skipped[]` and writes nothing.

Two smaller deliberate choices: imported expenses pass `recordActivity: false`
to `createExpense` (one summary feed entry per run, not one per expense), and an
imported group gets **no** `invite_token`; importing a group is not deciding to
share it.

## No file uploads

There is no upload endpoint, no multipart parsing, no image handling, and no
object storage anywhere in this codebase. This is intentional.

The only trace is `receipt: { large: null, original: null }` in
`src/routes/compat/serializers.ts`, which is a hardcoded null so Splitwise
clients see the key they expect instead of `undefined`. It is not a feature stub.

If you are asked to add receipts, that is a real feature with real
consequences (storage, MIME sniffing, size limits, EXIF stripping, and serving
untrusted bytes, so it needs an explicit decision, not an incidental one.

## Things that will bite you

- **`src/db/index.ts` opens a connection at import time.** Tests must set
  `process.env.DATABASE_PATH` *before* importing anything that reaches it. See
  the dynamic-import pattern at the top of `src/routes/compat/v3.test.ts`.
- **`src/db/types.ts` is checked in but generated.** After a migration, run
  `yarn db:migrate && yarn db:codegen`. Hand-editing it without a matching
  migration gives you types that lie. Note that the checked-in file predates the
  current `kysely-codegen` naming (it uses `*Table` interfaces and exports
  `Database`); running codegen renames all of them and breaks `src/db/index.ts`,
  so either fix up the output or add the column by hand alongside its migration.
- **Changing a CHECK constraint means rebuilding the table.** SQLite cannot
  ALTER one, and the rebuild needs `PRAGMA foreign_keys=OFF`, a no-op inside a
  transaction, which is what the migration runner normally wraps each file in.
  Put `-- migrate:no-transaction` on its own line to opt out and drive your own
  BEGIN/COMMIT (see `src/db/migrate.ts` for the mechanics). Get the pragma
  wrong and `ALTER TABLE ... RENAME` silently repoints every other table's
  foreign keys at your temporary table. Not needed today: there is only one
  migration, and it creates the tables fresh, but it will be the day a second
  one exists.
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

## Splitwise export (time-sensitive)

Splitwise is moving its API behind a paywall. `scripts/export-splitwise.ts`
dumps raw, untransformed JSON to `splitwise-export/<timestamp>/`. It does not
touch the database on purpose: the schema will change many times during
development, and a raw snapshot makes re-import free and repeatable instead of
requiring another round-trip to an API that may no longer be free.

```bash
SPLITWISE_API_KEY=... yarn export:splitwise
```

The output is gitignored; it contains personal financial data. Back it up
somewhere private.
