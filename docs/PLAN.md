# SplitSmart roadmap

A self-hosted Splitwise replacement. The **product** work that `docs/PARITY.md`
planned - comments, recurring expenses, search / filters / CSV, restore, and
what those forced on import and guest links - has landed. That document is now
the reference for how it works and why.

The Splitwise-compatible shim at `/api/sw/v3.0` was dropped. Native `/api/v1`
has the equivalent information; recoding a client against that shape is cheaper
than maintaining a frozen Splitwise wire.

Status legend: ✅ done · 🚧 partial · ⬜ not started · ❌ dropped

---

## Phase 0: Export Splitwise data ⬜ **DO THIS FIRST**

The only genuinely time-boxed item. Splitwise is moving API access behind a
paywall; once that lands the data is unreachable.

- ✅ `scripts/export-splitwise.ts`: raw JSON dump, no transformation
- ⬜ **Actually run it** and verify the output covers every group and expense
- ⬜ Back up `splitwise-export/` somewhere private (it is gitignored)
- ⬜ Capture what comment (and recurring) **import** will need, while the API
      is free - see `docs/PARITY.md`, "Capture what import will need". A
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
- ❌ Compat API: shipped the 6 endpoints `splitwise-to-toshl` used, then dropped
      the shim. Native `/api/v1` is the API.
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
      definition.
- ✅ **Add a friend by email**: creates a placeholder carrying that address and
      emails a guest link (`/guest/l/<secret>`). Works with mail unconfigured:
      the URL comes back in the response instead, once.
- ✅ Activity feed: `GET /api/v1/activity`, scoped to groups you're in plus
      expenses you're on
- ✅ **Comments**: `src/domain/comments.ts` is the only writer; native and guest
      routes; the same `CommentThread` on both shells; counts on list rows;
      import of Splitwise's User *and* System rows. Editing, deleting or
      restoring a bill writes a generated `system` comment describing the change,
      best-effort - the ledger is the invariant, the sentence is not. Design and
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

## Phase 3: Compat API ❌ dropped

Shipped the six endpoints `splitwise-to-toshl` used, then removed `/api/sw/v3.0`.
Native `/api/v1` already had the equivalent information. Recoding that client
against the native shape is cheaper than maintaining a frozen Splitwise wire.
See the tombstone on `/docs`.

## Phase 4: Email 🚧

Wired to Resend (`RESEND_API_KEY` / `RESEND_FROM_ADDRESS`) or Postmark
(`POSTMARK_SERVER_TOKEN` / `POSTMARK_FROM_ADDRESS`). Configure one complete
pair, not both.

**Absence of those vars silently disables sending, never crashes at boot.**
`sendEmail()` logs the message (including the link) to the console instead, so
the verification flow is completable locally with no mail provider.

- ✅ **Email-first signup**: `emails` table holds the pending proof (address,
      hashed token, requester IP). `POST /auth/signup` then `POST /auth/register`
      with the token. When `EMAIL_VERIFICATION_REQUIRED` is off the verify URL
      is returned to the client so a box with no mail still works; when on, it
      is emailed and omitted from the response.
  - ✅ Single-use, 24h, hash-only storage, supersedes previous tokens
  - ✅ Address snapshot on existing-account tokens so a changed email can't be
        verified by an outstanding link
  - ✅ 60s per-address cooldown and 20 starts/hour per IP
  - ✅ Advisory by default; `EMAIL_VERIFICATION_REQUIRED=true` withholds the
        signup URL and blocks login for unverified existing accounts
  - ✅ `yarn verify:user` lockout escape hatch
- ✅ **Password reset**: `email_tokens.purpose` already permitted
      `'reset_password'`. `POST /auth/password/forgot` emails a 24h single-use
      link; `POST /auth/password/reset/:token` writes the new hash, marks the
      address verified, and ends other web sessions. The request response does
      not reveal whether the address has an account.
- ⬜ Change-email flow (re-verify the new address before it takes effect)
- ✅ **Invite by email**: friend invites (`POST /api/v1/friends` with an
      `email`). Deliberately does NOT use `email_tokens`: the link is a guest
      access link, so the same flow works when mail is unconfigured and no
      migration was needed to add a purpose.
- ⬜ Group invite by email (today the owner copies the link and sends it)
- ⬜ Optional expense notifications
- ⬜ Bounce / spam-complaint webhook

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
      before writing anything. A later import by that person merges the ghost
      (API key). Signing up at a confirmed Splitwise invite address does too.
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
      skipped. Receipt images are not imported (CLAUDE.md, "No file uploads") -
      one preview warning, not a skip per expense. A Splitwise recurring expense
      lands as a stopped series (`repeat_paused`); the wizard offers to continue
      any of them after import, and resume starts from today without backfill.
- ⬜ Run `yarn db:check` after import and reconcile every balance against the
      Splitwise UI before trusting it. Operator step; the wizard now says it on
      the last screen.

`scripts/export-splitwise.ts` stays as an independent raw-JSON backup, unrelated
to this flow. It still takes `SPLITWISE_API_KEY` from the shell.

## Phase 6: Type safety end to end ✅

- ✅ Replace `web/src/api.ts` hand-written types with Hono RPC (`hc<NativeApi>()`).
      Native routers are chained so Hono can infer them; `src/routes/native/v1.ts`
      is the composed type the client imports. The `api` object is a thin wrapper
      for credentials, `ApiError`, and the gzipped sync push.

## Phase 7: Deployment ⬜

Land ULIDs (phase 8) **before** any real database exists somewhere. Schema
changes still fold into `migrations/001` until then; after a deploy they cannot.

- ⬜ Dockerfile (single container, SQLite on a mounted volume)
- ⬜ **Backups**: Litestream or a nightly `.backup` to object storage. This is
      real financial data in a single file; treat losing it as the top risk.

## Phase 8: ULID primary keys ✅ **before offline, before deploy**

Full plan in `docs/ULIDS.md`. Destructive. Native entity ids are ULIDs so a
client can mint an expense id offline. Categories
stay Splitwise's integers. Original Splitwise ids live in `metadata.splitwise_id`.

- ✅ Fold TEXT ULIDs into `migrations/001`; `yarn db:reset`
- ✅ `src/domain/ulid.ts`, native routes parse path ids as ULIDs
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

## Phase 10: Offline-first + PWA ✅

Full design in `docs/OFFLINE.md`. Dexie mirror of the **logged-in** user's
visible ledger, an outbox replayed through the existing domain writers,
installable PWA shell scoped to `/app/`, unsynced count and last-synced time
in the UI.

Guest-link visitors under `/guest` are **not** offline-capable, and the shell
already enforces it: its service worker is network-only and does not cache,
and losing the network shows a needs-connection screen. A link is a
revocable capability; a local copy would outlive the owner expiring it.

- ✅ Foundations: `expenses.version` + `sync_log` folded into `001` (entity
      CHECK includes `comment` and `user_merge`; op CHECK includes `merge`),
      `expectedVersion` on update/delete/restore, log writes in `expenses.ts`
      (including restore and `advanceRepeatSchedule`), `comments.ts`,
      group/friend/member mutations, and `mergeUsers`. See `docs/OFFLINE.md`
- ✅ PWA shell: manifest (`start_url` `/app/`), app-shell service worker
      scoped to `/app/`, PNG icons, cached profile + currencies
- ✅ Local read mirror: the app is fully usable offline (writes go through
      the outbox), including comments
- ✅ Incremental pull: `/api/v1/sync/pull`, snapshot on join **and** on being
      added to a non-group expense (comments), `user_merge` remap, seq cursor
- ✅ Offline writes: outbox reducer (including restore), `/api/v1/sync/push`,
      conflict + quarantine UI (comment create/delete are their own ops, not
      nested in `expense.update`)
- ✅ Status UI: unsynced count, last synced, per-expense sync badges,
      `/conflicts`

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
