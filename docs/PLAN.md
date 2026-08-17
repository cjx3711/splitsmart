# SplitSmart roadmap

**Primary goal: a Splitwise clone with full API parity.** Everything else is
secondary to that. A client written against Splitwise should work against
SplitSmart by changing only its base URL.

Status legend: ✅ done · 🚧 partial · ⬜ not started

---

## Phase 0: Export Splitwise data ⬜ **DO THIS FIRST**

The only genuinely time-boxed item. Splitwise is moving API access behind a
paywall; once that lands the data is unreachable.

- ✅ `scripts/export-splitwise.ts`: raw JSON dump, no transformation
- ⬜ **Actually run it** and verify the output covers every group and expense
- ⬜ Back up `splitwise-export/` somewhere private (it is gitignored)

The dump is deliberately raw. The schema will change repeatedly during
development, and each change would otherwise mean re-hitting an API that may no
longer be free.

## Phase 1: Foundation ✅

- ✅ Schema with the expense invariant documented (`migrations/001`)
- ✅ Integer minor units + per-currency decimal places
- ✅ Split engine: equal, exact, percent, shares, adjustment, itemized (pure
      and tested
- ✅ Derived pairwise repayments (`deriveRepayments`)
- ✅ Balance queries: pairwise, group, total, simplify-debts
- ✅ Auth: scrypt passwords, cookie sessions, bearer API tokens
- ✅ Ghost accounts via group invite links, with recovery codes
- ✅ Compat API: the 6 endpoints `splitwise-to-toshl` uses, with tests
- ✅ Minimal React frontend
- ✅ `yarn db:check` integrity audit

## Phase 2: Feature parity with Splitwise 🚧

Ordered by how much they matter for day-to-day use.

- ✅ **Expense editing**: `web/src/EditExpenseDialog.tsx`, opened from the
      Edit button on `web/src/pages/ExpenseDetail.tsx`. Reconstructs the
      payment shape (single payer / own-share / amounts) and the split draft
      (including itemized lines + tax/tip) from the stored expense so
      reopening it doesn't re-derive anything, then resubmits through the same
      `ExpenseForm` used to create one. Delete lives on the same page, with a
      confirm dialog.
- ✅ **Split-type UI**: all six types in `web/src/SplitEditor.tsx`: equal,
      exact, percent, shares, adjustment, itemized. The editor imports the
      server's own `computeSplit` from `src/domain/split.ts` (it is pure, so the
      browser can run it) and previews per-person amounts live, which means
      there is no second implementation of the rounding to drift and the
      validation messages the user sees are the server's own.
- ✅ **Itemized splits**: a line-item bill where each line is shared by a
      different subset, with unitemised tax/tip spread in proportion to what
      each person ordered. Lines live in `expenses.split_meta` (JSON) purely so
      the editor can reopen them; the ledger numbers are still the derived
      shares in `expense_users`.
- ✅ **Settle up in the UI**: on both the friend and group screens, as a dialog
      off the page header. The group one opens prefilled from the largest
      suggested transfer, so `/settle` finally leads somewhere.
- ✅ **One-on-one expenses**: `POST /api/v1/friends/:id/expenses`, group_id
      NULL. Participants are restricted to the pair, because `createExpense`
      skips its membership check when there is no group.
- ✅ **Friend management**: `src/domain/friends.ts` + `src/routes/native/
      friends.ts`. Explicit friendships live in `friendships`; derived ones come
      from shared groups and expenses. `listRelatedUserIds` is the single
      definition, shared with the compat layer's `get_friends`.
- ✅ **Add a friend by email**: creates a ghost carrying that address and
      emails an invite whose link is the ghost's recovery code. Works with
      Postmark unconfigured: the code comes back in the response instead.
- ⬜ Comments (table exists, no routes)
- ✅ Activity feed: `GET /api/v1/activity`, scoped to groups you're in plus
      expenses you're on
- ⬜ Recurring expenses
- ⬜ Expense search and filters
- ⬜ CSV export

## Phase 3: Full API parity 🚧

`docs/SPLITWISE_COMPAT.md` is the authoritative endpoint list. Summary:

**Implemented ✅**
`get_current_user`, `get_friends`, `get_friend/:id`, `get_categories`,
`get_expenses`, `create_expense`

**Next up ⬜** (roughly in dependency order)
- `get_groups`, `get_group/:id`: needed by most third-party clients
- `create_group`, `add_user_to_group`, `remove_user_from_group`
- `get_expense/:id`, `update_expense/:id`, `delete_expense/:id`
- `get_currencies`: trivial, the table already exists
- `create_comment`, `get_comments`
- `get_notifications`
- OAuth2 flow: only needed if a third-party client refuses bearer tokens

**Deliberately out of scope**
- Splitwise Pro features (receipt scanning, currency conversion, charts)
- Push notifications
- Their web UI's private endpoints

### Parity testing

`src/routes/compat/v3.test.ts` asserts on exact field names and string formats.
Extend it for every endpoint added. Where possible, diff responses against real
Splitwise output captured **while the API is still free**: capturing those
fixtures now is worth more than any amount of guessing later.

## Phase 4: Email 🚧

Wired to Postmark via `POSTMARK_SERVER_TOKEN` / `POSTMARK_FROM_ADDRESS`.

**Absence of those vars silently disables sending, never crashes at boot.**
`sendEmail()` logs the message (including the link) to the console instead, so
the verification flow is completable locally with no mail provider.

- ✅ **Email verification for new accounts**: `src/email/`, `email_tokens` table
  - ✅ Single-use, 24h, hash-only storage, supersedes previous tokens
  - ✅ Address snapshot on the token so a changed email can't be verified by an
        outstanding link
  - ✅ 60s resend cooldown
  - ✅ Advisory by default; `EMAIL_VERIFICATION_REQUIRED=true` blocks login
  - ✅ `yarn verify:user` lockout escape hatch
  - ✅ 20 tests
- ⬜ **Password reset**: `email_tokens.purpose` already permits
      `'reset_password'`, so this needs routes and a template, not a migration
- ⬜ Change-email flow (re-verify the new address before it takes effect)
- ✅ **Invite by email**: friend invites (`POST /api/v1/friends` with an
      `email`). Deliberately does NOT use `email_tokens`: the link carries the
      ghost's recovery code, so the same flow works when Postmark is
      unconfigured and no migration was needed to add a purpose.
- ⬜ Group invite by email (today groups still share one link for everyone)
- ⬜ Optional expense notifications
- ⬜ Postmark webhook for bounces and spam complaints

## Phase 5: Import from Splitwise ✅ (in-app)

Importing is a **per-user, in-app** flow, not a server-side script with a
server-wide key. The user pastes their own Splitwise API key into the wizard at
`/import`; it is used for that request and never persisted. See
`src/routes/native/import.ts` for the endpoint contract and the reasoning.

- ✅ `POST /api/v1/import/{preview,friends,groups,expenses,run}` +
      `GET /api/v1/import/status`. One step per request, so the whole flow is
      drivable by curl, by a test, or by an agent; no browser needed.
- ✅ **Testable end to end without Splitwise**: `SPLITWISE_API_BASE` points the
      importer at a fake; `src/routes/native/import.test.ts` runs one over HTTP.
- ✅ Map Splitwise users to local users by `splitwise_id`, then by **email**;
      create ghosts for anyone unmatched. The wizard names the email matches
      before writing anything.
- ✅ Idempotent re-import (match on `splitwise_id`; a second run is a no-op)
- ✅ Splitwise's own `owed_share` allocation imported as an `exact` split, so no
      cent moves in translation
- ✅ **Category id parity**: `src/db/categories.ts` carries Splitwise's real
      ids, captured from the live API and pinned against
      `fixtures/splitwise/get_categories.json`. `yarn db:seed` is enough.
- ✅ **Currency coverage**: all Splitwise codes present, including demonetised
      ones (HRK, LTL, VEF) that historical expenses still use
- ⬜ Re-import as **update in place** (today an already-imported expense edited
      in Splitwise is left alone rather than refreshed)
- ⬜ Import comments and expense attachments (there is no upload story. See
      CLAUDE.md, "No file uploads")
- ⬜ Run `yarn db:check` after import and reconcile every balance against the
      Splitwise UI before trusting it

`scripts/export-splitwise.ts` stays as an independent raw-JSON backup, unrelated
to this flow. It still takes `SPLITWISE_API_KEY` from the shell.

## Phase 6: Type safety end to end ⬜

- ⬜ Replace `web/src/api.ts` hand-written types with Hono RPC (`hc<AppType>()`)
- ⬜ `@hono/zod-openapi` on the compat routes to emit an OpenAPI spec, mainly as
      documentation of the compat surface
- ⬜ Optionally generate a client for `splitwise-to-toshl` with hey-api, though
      six endpoints of hand-written types is barely worth the build step

## Phase 7: Deployment ⬜

Land ULIDs (phase 8) **before** any real database exists somewhere. Schema
changes still fold into `migrations/001` until then; after a deploy they cannot.

- ⬜ Dockerfile (single container, SQLite on a mounted volume)
- ⬜ **Backups**: Litestream or a nightly `.backup` to object storage. This is
      real financial data in a single file; treat losing it as the top risk.
- ⬜ Point `splitwise-to-toshl` at this server: set `SPLITWISE_API_URL` in its
      `webapp/server.js` proxy target and paste a SplitSmart API token in as the
      Splitwise key

## Phase 8: ULID primary keys ✅ **before offline, before deploy**

Full plan in `docs/ULIDS.md`. Destructive. Native entity ids are ULIDs so a
client can mint an expense id offline. The compat layer uses those same ULID
strings on the wire (a documented break from Splitwise integers). Categories
stay Splitwise's integers. Original Splitwise ids live in `metadata.splitwise_id`.

- ✅ Fold TEXT ULIDs into `migrations/001`; `yarn db:reset`
- ✅ Compat serializers emit the native ULID as `id` (string)
- ✅ `src/domain/ulid.ts`, native and compat routes parse path ids as ULIDs
- ✅ Import matches on `metadata.splitwise_id`; PK is always a fresh ULID

## Phase 9: Guest links ⬜ **before offline PWA**

Full plan in `docs/GUEST.md`. Replaces recovery codes. Ghosts are placeholders
the owner created; invite URLs are the credential (secret in `localStorage`,
sent on every request, optional expiry). Claim is always: create an account
first, then merge the ghost into that account.

- ⬜ `access_links` (`group` / `group_member` / `friend`); drop recovery codes
      and `groups.invite_token`
- ⬜ `mergeExpenseParticipants` + user merge (overlapping shares combine, with
      a confirm; convert that expense to `exact`)
- ⬜ `/guest/*` shell (network-only SW) and `/app/*` for the logged-in app
- ⬜ `/api/v1/guest/*` scoped to the link; no cookie exchange
- ⬜ Owner mint/revoke UI; email invites carry `/guest/l/:token`
- ⬜ Claim preview + confirm; `is_ghost = 0` cannot be acted as via a link

## Phase 10: Offline-first + PWA ⬜

Full plan in `docs/OFFLINE.md`. Assumes phases 8 and 9. Dexie mirror of the
**logged-in** user's visible ledger, an outbox replayed through the existing
domain writers, installable PWA shell scoped to `/app/`, unsynced count and
last-synced time in the UI.

Invite-link visitors under `/guest` are **not** offline-capable. No Dexie, no
sync endpoints, no cached ledger: no network means it does not work. A link is
a revocable capability; a local copy would outlive the owner expiring it.

- ⬜ Foundations: `expenses.version`, `sync_log`, local balances via `deriveRepayments`
- ⬜ PWA shell: `vite-plugin-pwa`, manifest, icons, cached profile + currencies
- ⬜ Local read mirror: the app becomes fully usable offline, read-only (write-through while online)
- ⬜ Incremental pull: `/api/v1/sync/pull`, snapshot on join, seq cursor
- ⬜ Offline writes: outbox reducer, `/api/v1/sync/push`, conflict + quarantine UI
- ⬜ Status UI: unsynced count, last synced, per-expense sync badges

Adding a friend and creating a group stay **online-only** on purpose: both mint
server-side identities (a placeholder user, an invite-link secret), and a
queued identity reconciled by email is how two people become one. Expense ids
are client-minted ULIDs; that is the whole reason phase 8 exists.

---

## Non-goals

- Receipts / image attachments: no upload endpoint, no multipart parsing, no
  object storage anywhere in this codebase, and that's deliberate. See
  CLAUDE.md, "No file uploads"
- Multi-tenancy or a hosted service: this is personal, self-hosted software
- Currency conversion (see CLAUDE.md rule 2)
- Mobile apps: the web UI should be responsive instead
- Rebranding as Splitwise, or redistributing their icon assets
