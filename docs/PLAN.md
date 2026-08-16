# SplitSmart roadmap

**Primary goal: a Splitwise clone with full API parity.** Everything else is
secondary to that. A client written against Splitwise should work against
SplitSmart by changing only its base URL.

Status legend: ✅ done · 🚧 partial · ⬜ not started

---

## Phase 0 — Export Splitwise data ⬜ **DO THIS FIRST**

The only genuinely time-boxed item. Splitwise is moving API access behind a
paywall; once that lands the data is unreachable.

- ✅ `scripts/export-splitwise.ts` — raw JSON dump, no transformation
- ⬜ **Actually run it** and verify the output covers every group and expense
- ⬜ Back up `splitwise-export/` somewhere private (it is gitignored)

The dump is deliberately raw. The schema will change repeatedly during
development, and each change would otherwise mean re-hitting an API that may no
longer be free.

## Phase 1 — Foundation ✅

- ✅ Schema with the expense invariant documented (`migrations/001`)
- ✅ Integer minor units + per-currency decimal places
- ✅ Split engine: equal, exact, percent, shares, adjustment — pure and tested
- ✅ Derived pairwise repayments (`deriveRepayments`)
- ✅ Balance queries: pairwise, group, total, simplify-debts
- ✅ Auth: scrypt passwords, cookie sessions, bearer API tokens
- ✅ Ghost accounts via group invite links, with recovery codes
- ✅ Compat API: the 6 endpoints `splitwise-to-toshl` uses, with tests
- ✅ Minimal React frontend
- ✅ `yarn db:check` integrity audit

## Phase 2 — Feature parity with Splitwise 🚧

Ordered by how much they matter for day-to-day use.

- 🚧 **Expense editing** — server supports it (`updateExpense`), no UI yet
- ⬜ **Split-type UI** — only equal split is exposed; exact/percent/shares/
      adjustment all work server-side already
- ⬜ **Settle up in the UI** — `createPayment` and `/settle` suggestions exist,
      no screen
- ⬜ **One-on-one expenses** — schema supports `group_id = NULL`; needs a
      friends screen and routes
- ⬜ **Friend management** — the `friendships` table is unused; `get_friends`
      currently derives relationships from shared groups and expenses
- ⬜ Comments (table exists, no routes)
- ⬜ Activity feed (table is written to, never read)
- ⬜ Receipts / image attachments
- ⬜ Recurring expenses
- ⬜ Expense search and filters
- ⬜ CSV export

## Phase 3 — Full API parity 🚧

`docs/SPLITWISE_COMPAT.md` is the authoritative endpoint list. Summary:

**Implemented ✅**
`get_current_user`, `get_friends`, `get_friend/:id`, `get_categories`,
`get_expenses`, `create_expense`

**Next up ⬜** (roughly in dependency order)
- `get_groups`, `get_group/:id` — needed by most third-party clients
- `create_group`, `add_user_to_group`, `remove_user_from_group`
- `get_expense/:id`, `update_expense/:id`, `delete_expense/:id`
- `get_currencies` — trivial, the table already exists
- `create_comment`, `get_comments`
- `get_notifications`
- OAuth2 flow — only needed if a third-party client refuses bearer tokens

**Deliberately out of scope**
- Splitwise Pro features (receipt scanning, currency conversion, charts)
- Push notifications
- Their web UI's private endpoints

### Parity testing

`src/routes/compat/v3.test.ts` asserts on exact field names and string formats.
Extend it for every endpoint added. Where possible, diff responses against real
Splitwise output captured **while the API is still free** — capturing those
fixtures now is worth more than any amount of guessing later.

## Phase 4 — Email 🚧

Wired to Postmark via `POSTMARK_SERVER_TOKEN` / `POSTMARK_FROM_ADDRESS`.

**Absence of those vars silently disables sending, never crashes at boot.**
`sendEmail()` logs the message (including the link) to the console instead, so
the verification flow is completable locally with no mail provider.

- ✅ **Email verification for new accounts** — `src/email/`, migration 002
  - ✅ Single-use, 24h, hash-only storage, supersedes previous tokens
  - ✅ Address snapshot on the token so a changed email can't be verified by an
        outstanding link
  - ✅ 60s resend cooldown
  - ✅ Advisory by default; `EMAIL_VERIFICATION_REQUIRED=true` blocks login
  - ✅ `yarn verify:user` lockout escape hatch
  - ✅ 20 tests
- ⬜ **Password reset** — `email_tokens.purpose` already permits
      `'reset_password'`, so this needs routes and a template, not a migration
- ⬜ Change-email flow (re-verify the new address before it takes effect)
- ⬜ Invite by email (as an alternative to the link)
- ⬜ Optional expense notifications
- ⬜ Postmark webhook for bounces and spam complaints

## Phase 5 — Import from Splitwise ⬜

- ⬜ `scripts/import-splitwise.ts` reading the Phase 0 dump
- ⬜ **Preserve original IDs**: insert with `id = splitwise_id` on users, groups,
      expenses and categories so external references stay valid. Bump
      `sqlite_sequence` past the highest imported id afterwards.
- ✅ **Category id parity done** — `src/db/categories.ts` carries Splitwise's
      real ids, captured from the live API and pinned against
      `fixtures/splitwise/get_categories.json`. `yarn db:seed` is enough;
      no extra step before import.
- ✅ **Currency coverage done** — all 153 Splitwise codes present, including
      demonetised ones (HRK, LTL, VEF) that historical expenses still use
- ⬜ Map Splitwise users to local users; create ghosts for anyone unmatched
- ⬜ Idempotent re-import (match on `splitwise_id`, update in place)
- ⬜ Run `yarn db:check` after import and reconcile every balance against the
      Splitwise UI before trusting it

## Phase 6 — Type safety end to end ⬜

- ⬜ Replace `web/src/api.ts` hand-written types with Hono RPC (`hc<AppType>()`)
- ⬜ `@hono/zod-openapi` on the compat routes to emit an OpenAPI spec — mainly as
      documentation of the compat surface
- ⬜ Optionally generate a client for `splitwise-to-toshl` with hey-api, though
      six endpoints of hand-written types is barely worth the build step

## Phase 7 — Deployment ⬜

- ⬜ Dockerfile (single container, SQLite on a mounted volume)
- ⬜ **Backups** — Litestream or a nightly `.backup` to object storage. This is
      real financial data in a single file; treat losing it as the top risk.
- ⬜ Point `splitwise-to-toshl` at this server: set `SPLITWISE_API_URL` in its
      `webapp/server.js` proxy target and paste a SplitSmart API token in as the
      Splitwise key

---

## Non-goals

- Multi-tenancy or a hosted service — this is personal, self-hosted software
- Currency conversion (see CLAUDE.md rule 2)
- Mobile apps — the web UI should be responsive instead
- Rebranding as Splitwise, or redistributing their icon assets
