# CLAUDE.md: working on SplitSmart

Read this before changing anything. It is written for agents and covers the
invariants that are easy to break and hard to notice.

## What this is

A self-hosted Splitwise replacement. Two consumers matter:

1. The React frontend in `web/` talks to the native API at `/api/v1`.
2. External tools talk to the same `/api/v1` with a bearer token minted in
   Settings.

There was a Splitwise-compatible shim at `/api/sw/v3.0`. It is gone: native
already had the same information, and recoding a client against `/api/v1` is
cheaper than maintaining a frozen Splitwise wire. See `/docs`. Native entity
ids are ULIDs (`docs/ULIDS.md`).

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
yarn seed:demo              # a demo account: groups, comments, a repeat series
```

## The smoke suite

`yarn test` covers the logic. `docs/AI_SMOKE_TESTS.md` covers the part a unit
test cannot see: Playwright drives a seeded app, screenshots every important
screen (desktop and mobile, including JJ's view of the same groups), runs a
handful of click-through flows, and diffs PNG + DOM against committed
baselines. The `ai-smoke-test` skill starts that suite and only looks at a
browser if something already failed. It reports and never repairs, so a red
run stays informative.

```bash
yarn playwright install chromium   # once per machine
yarn smoke                         # reset, serve, capture, flows, compare, check
yarn smoke -- --update             # re-record baselines on this machine
```

It runs against **its own** database and ports - `data/smoke.db` on 5644/5645 -
so it never touches your dev data. `yarn smoke:reset` rebuilds that database
only; `yarn db:reset` is still the one that wipes yours.

PNG baselines live in `smoke/baselines/png/` and DOM dumps in
`smoke/baselines/dom/`. Both ARE committed. PNGs are machine-local (system
fonts); re-record with `--update` on the device you run on rather than
"fixing" a font diff. DOM dumps go through `scripts/smoke-lib.ts`, which
strips ULIDs, dates, link secrets and the live FX estimate. Update a baseline
in the commit that changed the UI, never to quiet a failing run.

## The four rules

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

The web UI may show a labeled ≈ estimate from live Exchange Rate API rates
(`web/src/exchangeRates.ts`). That is display-only: rates are fetched in the
browser, cached in localStorage for a day, and never written to the ledger. If
the fetch fails and nothing is cached, the estimate is omitted. Nothing in
`expense_users`, `expense_repayments`, or any balance query may use a rate.

### 3. All expense writes go through `src/domain/expenses.ts`

Nothing else may write `expenses`, `expense_users`, or `expense_repayments`.

The one exception is `src/domain/wipe.ts`, which hard-deletes an account's
ledger so a Splitwise import can start over. A wipe cannot be a soft delete:
the unique indexes on `metadata.splitwise_id` would still match, and the next
import would treat everything as already present. Wipe refuses if another live
real account shares a group or expense with the caller.

The invariant, for every non-deleted expense:

```
SUM(expense_users.paid_share_minor) == expenses.cost_minor
SUM(expense_users.owed_share_minor) == expenses.cost_minor
```

SQLite cannot express this; it spans rows, so it is enforced in application
code inside a transaction, and audited by `yarn db:check`. If you add a code
path that touches these tables directly, you have created a bug that will not
surface until someone's balance is wrong.

That includes columns the ledger does not read. `restoreExpense`,
`advanceRepeatSchedule` (a recurring template's `next_repeat`) and
`markImportSynced` (the re-import stamp) all live in this module for no other
reason. `src/domain/comments.ts` is the equivalent single writer for `comments`,
and `src/domain/scheduler.ts` generates recurring occurrences by calling
`createExpense` rather than inserting anything itself.

### 4. `expense_repayments` is a cache, not a source of truth

It stores the derived who-owes-whom for each expense so balance queries stay a
plain `SUM ... GROUP BY` instead of re-deriving creditor/debtor matching on
every page load. It is rebuilt from scratch on every expense write by
`deriveRepayments()`. If it ever disagrees with `expense_users`, `expense_users`
wins. `yarn db:check` verifies the two agree.

**Net positions do not determine the pairing**, which is the subtlety here. With
two payers and four people, "A owes C 13000, A owes D 3000" and "A owes D 16000,
B owes C 3000" settle the *same* nets; greedy picks one arbitrarily. That never
shows inside a group, because `simplifyDebts` re-nets at read time, but a
non-group expense is displayed pairwise, so an arbitrary choice becomes a
one-on-one balance the other party does not have.

So `deriveRepayments(shares, preferred?)` takes an optional preferred pairing,
and the Splitwise importer passes the `repayments[]` the API already published.
It stays a **hint, not a second source of truth**: each entry is clamped to what
the shares support and greedy fills the remainder, so a hint that is stale,
partial, or nonsense cannot make the cache disagree with `expense_users` - the
worst it can do is choose a different valid pairing. Do not add a path that
writes `expense_repayments` from anything but this function.

## simplify_by_default governs two screens, and nothing financial

The group flag decides how a set of nets is turned into edges. It changes who
hands money to whom, never what anyone is up or down, and it writes nothing:

- **Friend totals** — `pairwiseWithSimplify` in `settle.ts`, called by
  `getPairwiseBalancesByGroup` and by the mirror's `localFriends`. On, a cycle
  through a third party collapses and their debt can be rerouted onto you; off,
  the sidebar shows the raw per-bill edges.
- **A group's suggested settle-up** — `settleSuggestions`, called by
  `GET /groups/:id/settle`, its guest twin, and `localSettleSuggestions`. On,
  the fewest transfers from the member nets; off, `expense_repayments` netted
  per pair, so nobody is asked to pay someone they never shared a bill with.

Both surfaces must read the same flag. Suggested settle-up used to simplify
unconditionally, which made the toggle look broken: it sits in Group options,
and the group page — nets, which simplify cannot move, plus an always-simplified
suggestion list — was the one screen where nothing changed.

New groups get it **on**: the API create default, `NewGroup.tsx`, the column
default in `001`, and the mirror's assumption for a group it has not stored yet
all agree. An imported group keeps Splitwise's setting instead.

`web/src/groupSettings.ts` is the one writer of the flag from the client (Group
options and the shortcut under the payment list), so the mirror-first,
roll-back-on-refusal shape cannot drift between them. `default_currency` is
written from the same module for the same reason.

## A group's default currency is settable, and moves no money

It decides two presentational things: what currency a new expense in the group
STARTS in (`AddExpenseDialog` prefers it over your own preferred currency) and
what the group screen offers to convert balances to. It converts nothing —
every recorded expense keeps the currency it was entered in, and no balance is
touched (rule 2), so changing it is safe on a group with history.

A new group starts from the creator's own preferred currency rather than a
hardcoded USD, and both `NewGroup.tsx` and Group options offer the picker.
`POST /groups` still defaults to `USD` for an API client that names no currency.
Both write paths check the code against the `currencies` table first: the column
is a foreign key, so an unknown code would otherwise be a 500 rather than a
message the form can show.

## Closing out balances that already cancel

Two screens offer to record payments that move no money, and both must ASK.

`planSettleAll` (`src/domain/settle.ts`) takes a friend's per-group breakdown
and returns one transfer per bucket, for **only** those currencies whose
buckets already sum to zero. A currency that does not sum to zero is a real
debt and must never get an invented transfer; that is the invariant worth
keeping, and F14 in the smoke suite asserts it directly.

The friend page reaches it two ways:

- **Found**: simplify-debts has left a group and the one-on-one bucket holding
  opposite amounts. The note under the balance explains that before offering
  "Close them out".
- **Created**: a settle-up recorded here is one-on-one, so bringing a currency
  to zero between two people leaves any shared group still reading as owed.
  `FriendDetail` computes the follow-up plan in the settle-up's `onSubmit`,
  stashes it in a **ref**, and opens a confirm dialog from `onClose` — the two
  run in the same tick, so state would be a render behind and the question
  would be dropped. It used to write those payments silently; they land in
  groups with other people in them, so they are offered, never assumed.

Every one carries `SETTLE_ALL_NOTE` as a comment saying no money changed hands.

## Converting balances says whose default currency

Multi-currency balances are per-currency ledgers (rule 2), and converting is a
pair of ordinary payments per currency - close the old one, open the new - never
a stored rate. The wording rule: **every mention of converting names the target
as a default currency, and whose.** A bare code presented without that word
reads as the app choosing for you, and it is not arbitrary - it is a setting.

- `ConvertBalancesHint` (`web/src/ConversionNote.tsx`) is the one nudge, shared
  by a group's payment list, the friend page and the guest friend page, so the
  same situation is not met in three different sentences.
- `ConvertBalanceDialog` / `ConvertGroupBalanceDialog` take `defaultLabel`
  alongside `preferredCurrency`: "your default currency" on a friend page,
  "this group's default currency" inside a group.

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
    ulid.ts          Crockford ULID. Pure. Also imported by the frontend.
    person.ts        Names, nicknames, icon letters. Pure. Shared with web/
    avatar-pattern.ts  Geometric avatars: HSLA bands, hashed or stored. Pure.
    metadata.ts      JSON bag on users/groups/expenses/comments
    balances.ts      Balance queries. Friend totals apply simplifyDebts per
                     group when simplify_by_default is on. One-on-one expenses
                     stay pairwise. expense_repayments stays the per-bill
                     cache; simplify is compute-time only.
    settle.ts        simplifyDebts + pairwiseWithSimplify + settleSuggestions.
                     Pure. Also imported by the frontend so offline friend
                     totals cannot drift.
    expenses.ts      The ONLY writer of expense tables, except wipe.ts
    comments.ts      The ONLY writer of `comments`. User + system rows
    recurring.ts     Interval arithmetic. Pure. Also imported by the frontend
    scheduler.ts     The recurring job: one occurrence per template per tick
    expense-csv.ts   CSV export. Decimal strings, per-currency decimals
    friends.ts       Explicit vs derived friendships. ONE definition of "friend"
    import.ts        Splitwise import: people -> groups -> expenses -> comments
    wipe.ts          Hard-delete one account's ledger so reimport is possible
    admin-stats.ts   Operator usage counts + 30-day series (ADMIN_EMAILS)
  backup/            Daily SQLite snapshot to S3. Config never throws (kept
                     out of env.ts so a typo cannot take the ledger down).
                     VACUUM INTO on a dedicated connection; claim_key UNIQUE
                     is the day lock. wipeUserLedger must never touch
                     database_backups.
  splitwise/
    client.ts        READ-ONLY client for the real Splitwise API. Nothing else
                     may talk to secure.splitwise.com.
  auth/
    password.ts      scrypt hashing + token generation
    session.ts       Cookie sessions AND bearer API tokens
    middleware.ts    requireAuth / optionalAuth / requireAdmin
  email/
    send.ts          Resend or Postmark; never throws
    signup.ts        Email-first signup (`emails` table)
    verification.ts  Existing-account verify tokens (`email_tokens`)
    reset.ts         Password reset tokens (`email_tokens.reset_password`)
    templates.ts     Mail bodies
  routes/
    native/          Clean API at /api/v1, used by web/
      expense-filters.ts  ONE definition of q / dates / category / friend / group
      comments.ts         Thread routes; system rows are NOT reachable from here
      export.ts           /api/v1/expenses.csv (a sibling of /expenses, not a child)
      admin.ts            /api/v1/admin/* usage + backups (ADMIN_EMAILS)
  server.ts          Entry point
web/                 React frontend (Vite)
  src/
    money.tsx        Currency-aware formatting. THE ONLY WAY TO RENDER MONEY
    reopenExpense.ts Stored expense -> the form the user typed. Shared by both
                     edit dialogs so they cannot drift
    CommentThread.tsx    The thread. Same component on both shells
    RepeatNote.tsx       What a bill says about its own recurrence
    ExpenseFilters.tsx   Search on the bar; the rest in a modal. CSV link.
    LinkPanel.tsx    Mint/rotate/revoke a guest link. Shows the URL once
    guest/           The guest shell. No Dexie, no sync, no logged-in router
    Avatar.tsx           Letters/emoji on a hashed or stored chord-band pattern
    PersonIdentityForm.tsx  Name, nickname, pattern editor, letters, emoji
    Sidebar.tsx      Owns the group/friend lists shown on every screen
    ExpenseForm.tsx      The one add-expense form (group, friend, or neither)
    ExpenseDialog.tsx    ExpenseForm in a modal. Shared by both shells
    AddExpenseDialog.tsx Loads people/groups from the mirror; logged-in entry
    AddPaymentDialog.tsx Header entry: pick a person, then SettleUpDialog
    SettleUpDialog.tsx   Balance picker + SettleUpForm. Shared by both shells
    SettleUpForm.tsx     The payment form. Two people get a swap row, not selects
    recordPayment.ts     Enqueues a payment plus its note, as a comment
    Icons.tsx            The inline SVG glyphs the chrome uses (+, swap)
    Modal.tsx            Native <dialog>. Modal chrome; Dialog for the lightbox
    ConfirmDialog.tsx    Two-button confirm on top of Modal
    PeoplePicker.tsx     Who is on the expense: an email-style To: field
    PaidBy.tsx           Who put the money in. NOT how it is split
    SplitEditor.tsx      How it is split, previewed with the real engine
    categories.tsx       Category icons + the parent/child picker (form + filters)
scripts/
  export-splitwise.ts    Raw API dump. RUN THIS FIRST, see below
  check-invariants.ts    Data integrity audit
docs/                Plan, data model
fixtures/splitwise/  REAL API responses, captured while the API is free.
                     Treat as read-only ground truth; categories.test.ts diffs
                     our data against them. Cannot be re-fetched once Splitwise
                     paywalls the API.
```

## Category IDs are Splitwise's real IDs

`src/db/categories.ts` is not a reconstruction: it was captured from the live
API. This matters because `category_id` is what an imported expense or a
third-party client carrying a Splitwise id has to resolve to.

The ids are **non-sequential**, and parents and children share **one** id space:
parents are 1, 2, 19, 25, 27, 31, 40 while children run 3–50. `Dining out` is
13, `Uncategorized > General` is 18 (the default). Do not renumber them, and do
not "sort" the tree; `src/db/categories.test.ts` diffs it against
`fixtures/splitwise/get_categories.json` on every run and will fail.

Native extras live in `EXTRA_PARENTS` / `EXTRA_LEAVES` with ids **≥ 51**.
`splitwise_id` is NULL on those rows. Import still matches in the Splitwise
id space; extras only appear in the native picker. Adding one is a seed, not
a migration.

## Auth model

Two independent paths, deliberately separate:

- **Sessions**: httpOnly cookie, 30-day expiry, for the web UI.
- **API tokens**: bearer header, long-lived, revocable, for external clients.

`requireAuth` accepts either, so one route tree serves both. It accepts
**neither** a guest access link; those are `Bearer link_...` and are handled
only by `/api/v1/guest/*`. See "Ghost accounts and guest links" below.

Only hashes are stored for both. Passwords use scrypt with self-describing
hashes (`scrypt$N$r$p$salt$hash`) so raising the cost or migrating to argon2 is a
non-event; `needsRehash()` drives transparent upgrade on login. Session and API
tokens use plain SHA-256, which is correct because they are already full-entropy
random; scrypt there would add 200ms to every request for no security gain.

## Ghost accounts and guest links

Read `docs/GUEST.md` before touching any of this. Two kinds of user share the
`users` table:

- **Real** (`is_ghost = 0`): email + password, can log in normally.
- **Ghost** (`is_ghost = 1`): a PLACEHOLDER PERSON, created by someone with an
  account (`POST /api/v1/friends`, `POST /api/v1/groups/:id/members`, or the
  importer). No email, no password, and no credential of their own.

**Opening a link does not create a user.** A guest reaches a ghost's data by
holding an `access_links` secret that says it may act as them, sent as
`Authorization: Bearer link_<secret>` on every request and re-resolved every
time. That is what makes revocation immediate, and it is why the guest shell is
never allowed to work offline: a link can be withdrawn, a cached ledger cannot.

`requireAuth` **rejects** `link_` tokens rather than ignoring them, so a guest
secret can never reach `/api/v1`. The guest tree is
`/api/v1/guest/*` and nothing else; there is deliberately no route there that
mints a link, adds a person, or creates a group.

**A ghost is never upgraded in place.** The usual path is: create a real account,
then CLAIM the ghost, which merges it (`src/domain/merge.ts`) and retires the
row with `merged_into_user_id` + `deleted_at`. Claim needs a cookie session AND
the link token: the token is the only thing making a *manual* placeholder
claimable, and without it a logged-in caller could absorb a stranger by guessing
a ULID.

Two automatic exceptions, both narrower than the link:

- **Import.** The Splitwise API key proves the importer is that Splitwise user.
  If a live ghost already carries their `metadata.splitwise_id`, it is merged
  into them before the import writes anything (`src/domain/splitwise-identity.ts`).
- **Signup.** Splitwise marks registered people `registration_status: confirmed`
  (placeholders it never signed up are `dummy`). An imported confirmed ghost
  stores that flag plus `invite_email`. Signing up at that address merges the
  ghost. Dummy and invite-only ghosts still need the link: the email may have
  been typed by someone else, and two owners can invite the same inbox.

The merge rule that matters: when both people are on the same expense their
shares are **added together**, never re-split. Re-running `computeSplit` with
one fewer participant would move cents belonging to third parties. The stored
split becomes `exact` with `split_input = owed` and `split_meta = NULL`, which
is the honest description of "these are the numbers"; no money moves.

**A ghost may carry an invite address.** `POST /api/v1/friends` stores it in
`invite_email`, not `users.email`. Login uniqueness is `users.email` only, so
inviting someone cannot squat an inbox and block them from registering. The
address is unique among that owner's live friend-ghosts, not globally: two
people can invite the same inbox, and the inbox can still sign up. Login still
refuses ghosts, and `issueVerificationToken` returns `no_email`. Claim clears
`invite_email` on the retired stub.

Known trade-off, accepted deliberately: anyone holding a link can read **and
edit** everything in its scope. Revoking is instant, but it does not un-share
what they already saw.

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

## The UI calls them expenses and payments

Two nouns, one glyph each: **＋ Expense** and **＋ Payment**, on the header, on
every page head, and in both shells. "Settle up" is gone from the buttons - it
named a goal rather than the row it writes, and it had no counterpart on the
other button. The suggestion list on a group page is still a suggestion, so it
is headed "Suggested payments" and remains the only place the word describes
something not yet recorded.

Recording one is `SettleUpForm`, and three things about it are deliberate:

- **Two people get a direction row, not two selects.** "A → B" that swaps on
  click. Two selects can be set to the same person, which is the one thing the
  form must refuse, and they take two gestures to express a correction that is
  really one bit.
- **There is no "show in" currency.** A payment clears the currency it is made
  in; an estimate of it in another currency answers a question nobody recording
  a payment is asking, and it sat right next to the amount box.
- **The note is a comment, not a column.** `web/src/recordPayment.ts` enqueues
  the payment and then the note against the id it just minted, so every logged-in
  screen posts it the same way; the guest screens do the same through
  `guestApi.addComment`. A payment's description is always "Payment", so this is
  where "cash at dinner" actually goes.

`AddPaymentDialog` is the header entry point. A payment needs a person before it
needs a form, so it asks who first and then opens the ordinary `SettleUpDialog`
on that person's real balances - the same dialog the friend page opens, not a
second copy of it.

Whenever that dialog shows its balance picker it also offers **Enter a different
amount**. The listed balances are shortcuts; a part payment, or one in a currency
nobody currently owes, has to be typeable or the picker is a dead end.

## Comments

Two kinds of row in `comments`, both of them called comments, exactly as
Splitwise has them:

- **`user`** - somebody typed it. Deletable by its author, and by nobody else.
- **`system`** - generated by `updateExpense` / `deleteExpense` /
  `restoreExpense`, describing what changed. Not deletable, and **not writable
  over HTTP by anyone**: there is no `kind` on the wire, and the routes hardcode
  `"user"`.

`src/domain/comments.ts` is the only writer. It also owns the visibility rule,
which is deliberately the same one as `GET /expenses/:id`: you are on the bill,
or you are currently in its group. A caller who fails it gets **404, not 403** -
a 403 would confirm the expense exists.

Three things worth keeping:

- **The system sentence is best-effort.** `recordExpenseEvent` swallows and logs
  its own failures rather than rolling back the expense write it describes. The
  ledger is the invariant; the footnote is not. It also skips an edit that
  changed nothing visible, so an idempotent save does not leave a note saying so.
- **Amounts in that sentence go through `formatAmount`** with the expense's own
  currency decimals. `3400 JPY → 3500 JPY`, not `34.00`.
- **A comment is not part of the expense.** It has no `version`, and commenting
  must never bump `expenses.version` when offline sync lands
  (`docs/OFFLINE.md`), or an offline note would conflict with an offline edit of
  the split. The comment count on a list row is a correlated subquery
  (`commentCountSql`), not a join, so it cannot disturb the shares aggregation
  next to it.

Guests get the same three routes under `/api/v1/guest/*`, scoped with
`expenseInScope`. Guest visibility is **stricter** than the logged-in rule: a
link holder sees bills they are a participant of, not everything in the group.

## Recurring expenses

A series is one **template** expense plus ordinary expenses generated from it,
each carrying `repeat_of`. There is no bundle id; the template's own id is the
bundle. `src/domain/recurring.ts` is pure interval arithmetic (and is imported by
the frontend, like `split.ts`); `src/domain/scheduler.ts` is the job.

The rules that make this safe rather than surprising:

- **One occurrence per template per tick.** After downtime a series is behind and
  catches up one bill at a time, each dated **the day it was due**. Inserting
  three months of rent in one pass, all dated today, is the failure mode the cap
  exists to prevent. The UI says so when a series is behind.
- **Generation goes through `createExpense`** (rule 3), replaying the template's
  split type and per-person inputs. `computeSplit` is deterministic, so the
  occurrence reopens in the editor as the same kind of split the user set up.
- **Idempotent per (template, due date).** The occurrence and the schedule
  advance cannot share a transaction (`createExpense` opens its own and SQLite
  has no nested BEGIN), so the generator checks for a bill already dated that day.
- **`repeatInterval` has three states on the wire.** Absent means "leave the
  schedule alone", `null` means "stop repeating", a value sets it. This is
  load-bearing: the guest editor and the settle-up form send nothing, and
  silently ending someone's rent series because a guest fixed a typo would be a
  bad surprise. Guests cannot create a template at all - the field is dropped,
  not rejected, so the bill they were recording still lands.
- Editing a template affects **future** bills only. Deleting it stops the series
  and leaves the bills it already made; deleting one occurrence does not stop the
  series.

The scheduler is started from `src/server.ts` only when it is run as the server,
so importing the app in a test never generates a bill. `runDueRecurrences(now)`
takes its clock as an argument for exactly that reason.

## Search, filters, and CSV

`src/routes/native/expense-filters.ts` is the ONE definition of `q`,
`group_id`, `friend_id`, `dated_after`, `dated_before`, `category_id` and
`is_payment`, shared by the three list endpoints and the CSV export so a filter
cannot mean one thing on a screen and another in a download.

- **Filters narrow a scope, never widen it.** The group endpoint applies them on
  top of its own group, so `GET /groups/A/expenses?group_id=B` returns nothing
  rather than B's expenses. There is a test for that specifically.
- **`q` is `instr(lower(...))`, not LIKE**, so searching for `50%` finds a
  percent sign instead of matching everything.
- **Malformed filters are ignored, not rejected.** A stale bookmark should show
  your expenses, not a validation error.
- **No amount range.** Amounts are per-currency integers; "more than 50" has no
  meaning until someone says 50 of what, and answering it would need a
  conversion (rule 2).
- `GET /api/v1/expenses.csv` is a **sibling** of `/api/v1/expenses`, so it lives
  in a router mounted at `/api/v1`. That router must not carry
  `use("*", requireAuth)`: a wildcard middleware there would also cover
  `/api/v1/guest/*`, which exists precisely to be outside `requireAuth`. Auth
  goes on the route. Guests get their own link-scoped `/api/v1/guest/expenses.csv`.

## Restore

`POST /api/v1/expenses/:id/restore` undoes a soft delete, participant-only, and
is the reason tombstones were worth keeping. It goes through the expense writer,
**rebuilds `expense_repayments`** from `expense_users` (the cache has been
outside every balance query since the delete), writes `expense.restored` to the
feed and a system comment to the bill. Restoring twice is a no-op.

The delete flow no longer navigates away: the expense page stays put and offers
the undo, and the activity feed offers one for a delete you find later.

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

On the client, `web/src/ExpenseDialog.tsx` wraps the form for both shells.
The logged-in `AddExpenseDialog` is the only place that knows where people
come from (a group's members, or your friends); the guest screens pass the
people the link can see. `ExpenseForm` takes the pool as a prop, so nobody
gets a second form.

## Friends

Two kinds, and the difference decides what the UI may offer:

- **Explicit**: a row in `friendships`, stored canonically with
  `user_a_id < user_b_id`. Removable.
- **Derived**, someone you share a live group or an expense with. No row.
  Not removable; they reappear on the next load.

`listRelatedUserIds()` in `src/domain/friends.ts` returns the union and is the
**only** definition of "who is my friend". `/api/v1/friends` calls it. Do not
hand-roll the UNION at a call site; the schema comment says so too.

Removing a friendship touches nothing financial. `DELETE /api/v1/friends/:id`
returns `stillVisible` so the UI can explain why someone is still listed rather
than looking broken.

**Friend invites do not use `email_tokens`.** The emailed link is a guest
access link (`/guest/l/<secret>`), minted in the same transaction as the
placeholder so the address we invite them at always has somewhere to go. That
avoids adding a `friend_invite` purpose to a CHECK constraint SQLite cannot
ALTER, and it keeps working when mail is unconfigured: `POST /friends`
returns `inviteUrl` once so the inviter can pass it on by hand.

## Email

`src/email/`: Resend or Postmark transport (one provider), templates, signup,
existing-account verification, and password reset. Verification links point at
`/app/verify/:token`; reset links at `/app/reset/:token`. Both are inside the
logged-in shell.

**Signup is email-first.** `POST /api/v1/auth/signup` writes a row to `emails`
(address, hashed token, requester IP) and does not create a user.
`POST /api/v1/auth/register` consumes that token and then inserts the account.

- When `EMAIL_VERIFICATION_REQUIRED` is false (the default), signup returns
  `verifyUrl` so the frontend can open the complete-account form without a mail
  provider. That is the documented unconfigured path.
- When it is true, the URL is emailed and omitted from the response. Holding
  the token is the proof.

Signup is rate-limited: 60s between starts for one address, 20 starts per IP
per hour. `requester_ip` is stored on the row so the IP limit has something to
count. `next_path` is stored too: the claim flow sends people through signup
and they have to come back still holding the guest-link secret.

**Existing-account verification** (the banner / resend path, and the future
change-email path) still uses `email_tokens`. `issueVerificationToken()` is
not called from register.

**Password reset** uses the same `email_tokens` table with
`purpose = 'reset_password'`. `POST /api/v1/auth/password/forgot` always
returns `{ ok: true }` so the wording cannot enumerate accounts; the link
goes to `/app/reset/:token`. Completing it writes the new hash, marks the
address verified (inbox proof), ends every web session for that account, and
opens a new one. API tokens are a separate credential and stay. Ghosts have
no login, so they cannot reset. The URL is never returned on the wire (that
would leak whether the address exists); when mail is unconfigured,
`sendEmail()` logs it like every other message.

**`sendEmail()` never throws and never blocks boot.** Configure either
`RESEND_API_KEY` + `RESEND_FROM_ADDRESS` or `POSTMARK_SERVER_TOKEN` +
`POSTMARK_FROM_ADDRESS`, not both. With neither set it logs the message
(link included) to the console. Callers check `result.delivered` rather than
catching.

Verification and reset tokens are single-use, expire in 24h, stored hash-only,
and issuing a new one supersedes any outstanding ones of the same purpose.

Two details that look optional and are not:

- **`email_tokens.email` is a snapshot** of the address at issue time.
  Consuming compares it against `users.email` and refuses on mismatch -
  otherwise a pending link would verify an address it was never issued for.
- **`/verify/resend` must stay registered BEFORE `/verify/:token`.** Hono matches
  in order; reverse them and "resend" is captured as a token and the endpoint
  becomes unreachable. There is a regression test for this.

Enforcement is advisory by default: unverified existing users log in fine and
see a banner. `EMAIL_VERIFICATION_REQUIRED=true` withholds the signup URL and
blocks login instead, and if you enable it on a box where mail is broken,
nobody can get in. The way out is `yarn verify:user -- you@example.com`, which
needs only filesystem access.

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
POST /api/v1/import/comments   step 4, pending commented expenses, 25 per call
POST /api/v1/import/rounding   step 5, settle leftover cents vs Splitwise group nets, then friend totals
POST /api/v1/import/continue-recurring  resume stopped imported series (no key)
POST /api/v1/import/run        all five server-side, for small accounts
POST /api/v1/import/wipe       hard-delete this ledger so a reimport starts empty
                               (`{ "confirm": "DELETE ALL DATA" }`; refuses if
                               another live account shares a group or expense)
```

That shape exists so the whole flow is drivable by curl or by a test with no
browser. `SPLITWISE_API_BASE` completes the picture: point it at a fake
Splitwise on localhost and `src/routes/native/import.test.ts` runs the real
client, the real routes and the real expense writer end to end.

Four things this must keep doing:

- **Identity is `metadata.splitwise_id` first, email second.** Every imported
  row carries the Splitwise id it came from in the JSON metadata bag, so a
  second run matches instead of duplicating. The id is **global**: a friend's
  later import finds the same people, groups and expenses rather than copying
  them. The native PK is always a fresh ULID. Email is the *only* heuristic,
  used just to link a Splitwise contact to a SplitSmart account that already
  exists, and the preview names every person it applies to before anything is
  written, because a wrong match merges two people's money.
- **The importer is claimed, not duplicated.** If they already exist as a
  ghost (someone else imported them first), that ghost is merged into their
  account at the start of the import. Signing up at a confirmed Splitwise
  invite address does the same merge without an import. See
  `src/domain/splitwise-identity.ts`.
- **Splitwise's own `owed_share` is imported as an `exact` split.** Never
  re-derive an equal split from the total: the two disagree by a cent on
  three-way splits, and a cent is a balance.
- **Group 0 is not a group.** It is Splitwise's "Non-group expenses" bucket and
  maps to `group_id = NULL`.
- **A row that cannot be imported exactly is skipped with a reason**, never
  fudged, with one exception: extra digits past the currency's scale (Splitwise
  sending `197529.02` JPY) are **rounded**, a system comment is left on the bill,
  and the expense is listed in `warnings[]` rather than `skipped[]`. Rounded,
  not truncated, and the difference is the whole point: truncation is biased -
  every correction is negative - so across a few hundred JPY bills with cents
  the error compounds into a friend total tens of yen adrift, which is more than
  `POST /import/rounding` is allowed to settle. Rounding half away from zero
  centres the error at zero so the corrections cancel. Unknown
  currency, missing group, shares that do not add up; those still come back in
  `skipped[]` and write nothing. After comments, `POST /import/rounding`
  matches Splitwise group member nets first (anyone-to-anyone inside the group),
  then friend totals, and records a settle-up for any leftover of at most 100
  minor units, with a note on the payment.
- **Splitwise's `repayments[]` are imported, not re-derived.** Per-person nets
  do not determine who pays whom: a two-payer bill has several valid pairings
  and our greedy matcher picks a different one from Splitwise. Inside a group
  that is invisible (`simplifyDebts` re-nets at read time), but a **non-group**
  expense is shown pairwise, so the arbitrary pairing surfaces on a friend page
  as a debt the other side has no record of. The importer passes Splitwise's
  answer to `createExpense` as `repayments`, a *hint* to `deriveRepayments`;
  see rule 4.

Two smaller deliberate choices: imported expenses pass `recordActivity: false`
to `createExpense` (one summary feed entry per run, not one per expense), and an
imported group gets **no** guest link; importing a group is not deciding to
share it.

### Comments, recurrence, and re-import

**Comments arrive in either of two shapes, and both are supported.** Splitwise's
`get_expenses` may nest complete `comments[]` on each expense, or it may only
report `comments_count`. The fixture that would settle which can only be captured
against a live account while the API is still free (`docs/PARITY.md`, "Capture
what import will need"), so the importer handles both: nested comments come in
with their expense, and step 4 fetches the rest with `get_comments`. Expense
import stamps a pending `splitwise_comments_count` when the list did not nest
the thread and the count is > 0; step 4 fetches only those rows (25 per call)
and removes the stamp, so a second run does not spend a request per bill.

**System comments are imported too.** They are the only edit history Splitwise
will ever hand over; dropping them would throw it away. An author nobody has seen
becomes a ghost via the shared `PersonResolver` rather than costing us the
comment. A comment with no author at all (Splitwise's own "record a cash
payment" notes, `user: null`) is kept as a system row attributed to the
importer — the thread does not show a name on system comments, so this does
not pretend they typed it. A comment deleted at the source is skipped like a
deleted expense.
Comment import passes `enforceVisibility: false` - it is replaying history, and
Splitwise lets somebody comment and then leave the group.

**A Splitwise repeating expense lands as a stopped series.** Its past
occurrences are already separate expenses and import as ordinary `exact` bills.
The live Splitwise row (`repeats: true`) is stamped `metadata.repeat_paused`
with its interval, and `repeat_interval` stays null so the scheduler cannot
fire. The wizard then offers to continue any of them: resume starts from today
and does not create months that already happened. Receipts are one preview
warning, never a skip per expense.

**Re-import can update in place, but only what nobody has touched.** An
already-imported expense that changed upstream is overwritten through
`updateExpense` **only** if the local row is untouched since import; otherwise it
comes back in `skipped[]` as `"local edits, not refreshed"`. The split stays
`exact` - never re-run `computeSplit` on a refresh.

"Untouched" means `updated_at == created_at` (which `createExpense` guarantees
for an imported row: it pins `updated_at` to `created_at` rather than letting it
default to now) or `updated_at` equal to the `metadata.splitwise_synced_at` stamp
a previous refresh left. Import stamps are full ISO **with milliseconds**, unlike
the `YYYY-MM-DD HH:MM:SS` a native edit writes, so the two are distinguishable by
construction rather than by luck - with second resolution, somebody editing in
the same second as a refresh would look like the refresh and lose their edit.

Local comments Splitwise never saw are never deleted by a re-import.

## No file uploads

There is no upload endpoint, no multipart parsing, no image handling, and no
object storage anywhere in this codebase. This is intentional.

The importer reads a source receipt URL for exactly one purpose: to warn, once,
in the preview. Fetching it would be downloading untrusted bytes we have nowhere
to put.

If you are asked to add receipts, that is a real feature with real
consequences (storage, MIME sniffing, size limits, EXIF stripping, and serving
untrusted bytes, so it needs an explicit decision, not an incidental one.

## Things that will bite you

- **`src/db/index.ts` opens a connection at import time.** Tests must set
  `process.env.DATABASE_PATH` *before* importing anything that reaches it. See
  the dynamic-import pattern at the top of `src/routes/native/guest.test.ts`.
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
  allocation. `userId` is a ULID; sort with `<`, not numeric coerce or
  `localeCompare`. Change that ordering and re-saving an expense shuffles whose
  cent it is, drifting balances.
- **`STRICT` tables.** SQLite will reject a type mismatch rather than coercing.
  This is intentional. Do not remove it.
- **Soft deletes only.** Every balance query filters `deleted_at IS NULL`.
  Never hard-delete an expense; restore needs the tombstone.

## Before you commit

```bash
yarn typecheck && yarn test && yarn db:check
```

If you touched anything under `src/domain/`, the tests in `split.test.ts` are
the ones that matter. They are fast.

**`migrations/001` is still folded, not layered.** Anything that changed the
schema means `yarn db:reset` (destructive) on every local database, including
whatever the dev server is holding open. Comments gained `kind`, and expenses
gained `repeat_interval` / `next_repeat` / `repeat_of`, so a database created
before those exist will fail every query that selects them.

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
