# SplitSmart roadmap

**Primary goal: a Splitwise clone with full API parity.** Everything else is
secondary to that. A client written against Splitwise should work against
SplitSmart by changing only its base URL.

The **product** work that `docs/PARITY.md` planned — comments, recurring
expenses, search / filters / CSV, restore, and what those forced on import and
guest links — has landed. That document is now the reference for how it works and
why, plus what is deliberately still open (the phase 0 fixture capture, and the
optional compat wrappers). The compat layer already covers the Toshl endpoints;
finishing `/api/sw/v3.0` is not on that plan.

Status legend: ✅ done · 🚧 partial · ⬜ not started

---

## Phase 0: Export Splitwise data ⬜ **DO THIS FIRST**

The only genuinely time-boxed item. Splitwise is moving API access behind a
paywall; once that lands the data is unreachable.

- ✅ `scripts/export-splitwise.ts`: raw JSON dump, no transformation
- ⬜ **Actually run it** and verify the output covers every group and expense
- ⬜ Back up `splitwise-export/` somewhere private (it is gitignored)
- ⬜ Capture what comment (and recurring) **import** will need, while the API
      is free — see `docs/PARITY.md`, "Capture what import will need". A
      `get_expenses` page with `comments_count > 0`, plus `get_comments` or
      `get_expense/:id` for that expense. If the list payload does not nest
      complete `comments[]`, extend the export script to dump them per
      expense before that history is unreadable.

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
- ✅ Placeholder people (ghosts) and guest access links (`docs/GUEST.md`)
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
- ✅ **Add a friend by email**: creates a placeholder carrying that address and
      emails a guest link (`/guest/l/<secret>`). Works with Postmark
      unconfigured: the URL comes back in the response instead, once.
- ✅ Activity feed: `GET /api/v1/activity`, scoped to groups you're in plus
      expenses you're on
- ✅ **Comments**: `src/domain/comments.ts` is the only writer; native and guest
      routes; the same `CommentThread` on both shells; counts on list rows;
      import of Splitwise's User *and* System rows. Editing, deleting or
      restoring a bill writes a generated `system` comment describing the change,
      best-effort — the ledger is the invariant, the sentence is not. Design and
      reasoning in `docs/PARITY.md` slice 1.
- ✅ **Recurring expenses** (`docs/PARITY.md` slice 2): one template plus
      ordinary occurrences carrying `repeat_of`, generated by an in-process job
      one bill per template per tick, each dated the day it was due. Editing a
      template affects future bills only. Imported Splitwise recurrences arrive
      as the bills that already happened and are never auto-scheduled.
- ✅ **Expense search and filters**: `q`, `group_id`, `friend_id`,
      `dated_after`, `dated_before`, `category_id`, `is_payment` on all three
      list endpoints, defined once in `src/routes/native/expense-filters.ts` and
      shared with the CSV export. Filters narrow a scope and can never widen it.
- ✅ **CSV export**: `GET /api/v1/expenses.csv` with the same filters, plus a
      link-scoped `/api/v1/guest/expenses.csv`.
- ✅ **Restore a soft-deleted expense**: `POST /api/v1/expenses/:id/restore`,
      through the expense writer, rebuilding repayments. Undo on the expense page
      after a delete, and from the activity feed later.

How those landed on import, guest links, and offline is in `docs/PARITY.md`. Do
not ship a native route without the rest of that list.

## Phase 3: Compat API 🚧

The six endpoints `splitwise-to-toshl` uses are done. That is enough for this
instance. Finishing Splitwise v3.0 is **not** a goal of `docs/PARITY.md`.

**Implemented ✅**
`get_current_user`, `get_friends`, `get_friend/:id`, `get_categories`,
`get_expenses`, `create_expense`

**Optional ⬜** if something else you run wants them — wrap native, do not
invent a second write path. See `docs/PARITY.md`, "Optional: a few more
compat wrappers".

- `get_groups`, `get_group/:id`
- `get_expense/:id`, `update_expense/:id`, `delete_expense/:id`
- `create_group`, `add_user_to_group`, `remove_user_from_group`
- `create_friend`, `delete_friend/:id`
- `get_currencies`

**Not doing** (unless a specific client forces it): comments, notifications,
OAuth2, `undelete_*`, `split_equally`, recurring fields on this wire.

**Deliberately out of scope**
- Splitwise Pro features (receipt scanning, currency conversion, charts)
- Push notifications
- Their web UI's private endpoints

### Parity testing

`src/routes/compat/v3.test.ts` asserts on exact field names and string formats.
If you add one of the optional wrappers, extend that file. Do not "improve"
a response shape.

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
      `email`). Deliberately does NOT use `email_tokens`: the link is a guest
      access link, so the same flow works when Postmark is unconfigured and no
      migration was needed to add a purpose.
- ⬜ Group invite by email (today the owner copies the link and sends it)
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
- ✅ Re-import as **update in place**: an expense that changed in Splitwise is
      overwritten only when the local row is untouched since import (
      `updated_at == created_at`, or equal to the `splitwise_synced_at` stamp a
      previous refresh left). Otherwise it is skipped as
      `"local edits, not refreshed"`. Never re-split; the split stays `exact`.
- ✅ **Import comments**, in both shapes Splitwise might send them: nested on
      the expenses page, or fetched per expense by
      `POST /api/v1/import/comments` (step 4). User *and* System rows, matched on
      `splitwise_id`, unknown authors become placeholders, source-deleted ones
      skipped. Receipt images are not imported (CLAUDE.md, "No file uploads") —
      one preview warning, not a skip per expense. A Splitwise recurring expense
      is imported as the bills that happened and never as a live template; the
      preview says so before anything is written.
- ⬜ Run `yarn db:check` after import and reconcile every balance against the
      Splitwise UI before trusting it. Operator step; the wizard now says it on
      the last screen.

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

## Phase 9: Guest links ✅

Full design in `docs/GUEST.md`. Recovery codes are gone. Ghosts are
placeholders somebody with an account created; the invite URL is the credential
(secret in `localStorage`, sent on every request, optional expiry, revocable).
Claim is always: create an account first, then merge the ghost into it.

- ✅ `access_links` (`group` / `group_member` / `friend`), one live link per
      slot; `users.recovery_code_hash` and `groups.invite_token` dropped;
      `users.merged_into_user_id` added
- ✅ `mergeExpenseParticipants` + `mergeUsers` in `src/domain/merge.ts`.
      Overlapping shares combine rather than re-split, and the expense becomes
      `exact` with `split_meta` cleared, so no cent moves
- ✅ `/guest/*` shell (network-only SW) and `/app/*` for the logged-in app;
      marketing left at `/`. Vite MPA, three entries, shared components
- ✅ `/api/v1/guest/*` scoped to the link, enforced per handler; no cookie
      exchange, and `requireAuth` rejects `link_` tokens everywhere else
- ✅ Owner mint/revoke UI (`LinkPanel.tsx`); email invites carry
      `/guest/l/:token`; the URL is returned exactly once
- ✅ Group membership management, since opening a link no longer creates anyone
- ✅ Claim preview + confirm; `is_ghost = 0` cannot be acted as via a link
- ✅ Old `/join/:token` and `/accept/:code` 301 into `/guest/l/...`

## Phase 10: Offline-first + PWA ⬜

Full plan in `docs/OFFLINE.md`. Assumes phases 8 and 9. Dexie mirror of the
**logged-in** user's visible ledger, an outbox replayed through the existing
domain writers, installable PWA shell scoped to `/app/`, unsynced count and
last-synced time in the UI.

Guest-link visitors under `/guest` are **not** offline-capable, and the shell
already enforces it: its service worker is network-only and clears any cache it
finds, and losing the network shows a needs-connection screen. A link is a
revocable capability; a local copy would outlive the owner expiring it.

- ⬜ Foundations: `expenses.version`, `sync_log` (entity CHECK includes
      `comment` from day one — see `docs/OFFLINE.md`; comments now exist, so
      that entity is a real one and `src/domain/comments.ts` is where its log
      rows go), local balances via `deriveRepayments`
- 🚧 PWA shell: manifest and an app-shell service worker scoped to `/app/`
      already exist (phase 9 needed the scope). Still to do: icons, cached
      profile + currencies
- ⬜ Local read mirror: the app becomes fully usable offline, read-only (write-through while online), including comments
- ⬜ Incremental pull: `/api/v1/sync/pull`, snapshot on join, seq cursor
- ⬜ Offline writes: outbox reducer, `/api/v1/sync/push`, conflict + quarantine UI
      (comment create/delete are their own ops, not nested in `expense.update`)
- ⬜ Status UI: unsynced count, last synced, per-expense sync badges

Adding a friend, adding a group member, and creating a group stay
**online-only** on purpose: they mint server-side identities, and a queued
identity reconciled by email is how two people become one. Expense and
comment ids are client-minted ULIDs; that is the whole reason phase 8
exists. Recurring templates are online-only too (`docs/PARITY.md` slice 2).

---

## Non-goals

- Receipts / image attachments: no upload endpoint, no multipart parsing, no
  object storage anywhere in this codebase, and that's deliberate. See
  CLAUDE.md, "No file uploads"
- Multi-tenancy or a hosted service: this is personal, self-hosted software
- Currency conversion (see CLAUDE.md rule 2)
- Mobile apps: the web UI should be responsive instead
- Rebranding as Splitwise, or redistributing their icon assets
