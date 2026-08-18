# Feature parity

**Built.** This was the plan for the remaining product work - comments,
recurring expenses, search / filters / CSV, restore, and what those forced on
import and guest links - and all five slices have landed. The document stays as
the reference for how they work and why they work that way, because most of the
"why" is not visible from the code.

What is deliberately still open:

- **Phase 0, the fixture capture** below. It needs a real Splitwise account and
  cannot be done from here. The importer no longer *depends* on the answer (it
  handles nested and non-nested comments alike), but the raw backup is still
  time-boxed: run `yarn export:splitwise` while the API is free.
- **The optional compat wrappers** at the end. Still optional, still not the
  point, and `docs/PLAN.md` phase 3 lists them.

This was never a plan to finish `/api/sw/v3.0`. That layer already covers what
this instance needs (`splitwise-to-toshl`: current user, friends, categories,
expenses list, create expense).

Status checklists live in `docs/PLAN.md` phase 2. This document is the how.

---

## What was already true when this was written

The ledger, six split types, friends, groups, members, settle-up, activity,
guest links, and an in-app import of people → groups → expenses all existed.

The `comments` table existed - ULID PK, `metadata.splitwise_id` unique index,
soft `deleted_at`, rewritten in `mergeUsers` - and nothing read or wrote it. The
importer ignored `comments` / `comments_count`. The export script never fetched
comments as their own resource. Recurring did not exist at all.

All of that is now built. Compat `serializeExpense` still hardcodes
`repeats: false` and `comments_count: 0`, deliberately: see the frozen-wire note
below. Imported Splitwise recurrences still arrive as ordinary one-off bills,
which was the right answer then and is the implemented one now (slice 2).

---

## The cross-cutting rule

A feature is not done when the native route returns 200. It is done when
all of these that apply have landed together:

1. **Domain writer.** One module writes the table, inside a transaction.
   Guest (and any later compat wrap) call that function; they do not INSERT.
2. **Native routes** under `/api/v1`.
3. **Guest routes** under `/api/v1/guest/*`, if a link visitor can see the
   parent. They can see expenses, so they can see and write comments.
   They cannot create groups, add people, or import. `docs/GUEST.md`.
4. **Web UI** on both shells, sharing the component.
5. **Import**, matching on `metadata.splitwise_id`, skip-don't-fudge.
6. **Export script**, if the data is not already inside a dumped payload.
   Still time-boxed: the live API may go away.
7. **Merge.** `mergeUsers` already rewrites `comments.user_id`; new tables
   need a line there.
8. **Offline.** New sync entities go in the `sync_log` CHECK *before*
   foundations land. See `docs/OFFLINE.md`.
9. **`yarn db:check`** if the invariant surface grew.

Receipts stay out. CLAUDE.md "No file uploads": no multipart, no object
storage. Importing a Splitwise receipt URL is fetching untrusted bytes we
have nowhere to put. One preview warning, not a skip per expense.

Do not add comments, recurring flags, or search params to `/api/sw/v3.0`
as part of this work. New features get native routes. The frozen-wire rule
in CLAUDE.md still holds: if a later optional wrap needs `comments_count`
on an expense, fill it from a COUNT, do not invent fields Splitwise never
had.

---

## Capture what import will need

Phase 0 is still the only time-boxed item, and still the only thing here that
cannot be done from a keyboard without a Splitwise account.

`scripts/export-splitwise.ts` now walks it for you: after dumping expenses it
saves `comments.json`, taking the nested `comments[]` where the list payload has
them and calling `get_comments?expense_id=` where it does not. `_meta.json`
records how many of each, which is the answer to the question below.

Against a real account, while the API is free:

| Capture | Why |
|---|---|
| One `get_expenses` page with `comments_count > 0` | Did Splitwise nest complete `comments[]` on the list, or only a count? This decides whether comment import is a fourth wizard step. |
| `get_comments?expense_id=` (or `get_expense/:id`) for that expense | User vs System rows, `deleted_at`, who authored them. |
| One expense with `repeats: true`, if the account has any | How past occurrences look next to the live template (`expense_bundle_id`, `next_repeat`). |

If nested `comments[]` on the list is populated and complete, the raw expenses
dump already *is* the comments backup. If it is empty or truncated, the export's
per-expense walk is what saves that history.

The importer does not wait on the answer: it handles **both** shapes (slice 1,
"Import"), so a wrong guess costs nothing either way.

---

## Slice 1 - Comments ✅

The load-bearing feature of this plan. Built as described below;
`src/domain/comments.ts` is the writer, `src/routes/native/comments.ts` and the
guest tree are the routes, `web/src/CommentThread.tsx` is the one component both
shells render, and `src/routes/native/comments.test.ts` pins the rules.

### What we are cloning

Splitwise keeps two kinds of row on an expense, both called comments:

- **User** - someone typed it.
- **System** - generated on edit/delete. Example: `"Jane updated this transaction: - The cost changed from $6.99 to $8.99"`. There is no edit-comment; delete is a tombstone.

The native activity feed already records `expense.updated`. That is the
global feed. System comments are the same events hanging on the bill, which
is what you want when you open an old dinner and ask "why is this $8.99".
Importing System history and then not writing any more would make imported
expenses look annotated and new ones silent. Write both.

### Schema

`comments` already has `id`, `metadata`, `expense_id`, `user_id`,
`content`, `created_at`, `deleted_at`. Add:

```sql
-- Folded into migrations/001 (no deployed database yet), with the CHECK:
kind TEXT NOT NULL DEFAULT 'user',
CHECK (kind IN ('user', 'system'))
```

There is also a partial index for the thread query and the per-row count:

```sql
CREATE INDEX idx_comments_live ON comments(expense_id, created_at)
  WHERE deleted_at IS NULL;
```

Do not put `kind` in `metadata`. Listing user comments should not need
`json_extract`.

No `version` column. Creates cannot conflict. Commenting must **not** bump
`expenses.version` - otherwise an offline note fights an offline edit of
the split. Comments are their own sync entity in `docs/OFFLINE.md`.

### Domain

`src/domain/comments.ts` is the only writer.

```
createComment({ id?, expenseId, userId, content, kind?: 'user', createdAt?, metadata? })
deleteComment(id, deletedBy)   -- sets deleted_at; does not hard-delete
```

Rules:

- Caller must be a participant on a live expense, or a current member of
  its group. Same visibility as `GET /expenses/:id`.
- HTTP handlers accept only `kind: 'user'`. System rows are written by
  `updateExpense` / `deleteExpense`, and by import.
- Empty / whitespace content is a 400, not a row.
- Soft-delete only. Native list filters tombstones; they stay in the
  table so merge and import matching still work.
- Live user comments write `comment.created` / `comment.deleted` into
  `activity`. Import passes `recordActivity: false`.

On `updateExpense` / `deleteExpense`, insert a `kind: 'system'` row
describing the change, best-effort: a failed diff must not roll back the
expense write. The ledger is the invariant; the sentence is not. Keep the
wording boring and stable (who, what field, old → new, amounts via
`formatAmount`). Do not chase Splitwise's exact English.

### Native

```
GET    /api/v1/expenses/:id/comments
POST   /api/v1/expenses/:id/comments          { content }
DELETE /api/v1/comments/:id
```

List returns live user *and* system comments, oldest first, with author
`{ id, name, nickname, iconLetters, iconEmoji, iconHue }`. Guests get the same three routes under
`/api/v1/guest/...`, scoped with `expenseInScope`. A guest may comment as
the person the link acts as, and may delete only their own user comments.
System comments are not deletable.

Worth knowing, because it surprised the tests: **guest visibility is stricter
than the logged-in rule.** A logged-in group member can comment on a group bill
they are not on (the "why am I not on this?" case); a link holder cannot, because
`expenseInScope` requires them to be a participant. Both are correct, they are
just not the same rule, and the guest routes check theirs *before* calling the
domain writer.

### UI

A thread at the bottom of `ExpenseDetail` and `GuestExpense`, same
component. User comments are a conversation; System comments are quieter
(muted, no avatar emphasis). Composer is a single text field. No markdown.
Show a count on the expense list row.

### Import

People → groups → expenses already exist. Comments belong **after**
expenses, because of the FK.

Two possible shapes, decided by the fixture:

**A. Nested on the expenses page.** Extend `SplitwiseExpense` with
`comments_count` and `comments[]`. After `createExpense` succeeds, insert
each comment. Re-run still matches on `comments.metadata.splitwise_id`.
`POST /import/run` does not need a new step. Preview can sum
`comments_count`.

**B. Not nested, or truncated.** New step:

```
POST /api/v1/import/comments     { apiKey, offset? }
```

Walk locally-imported expenses that have a Splitwise id. Skip those whose
comments are already present (or whose captured `comments_count` was 0).
For the rest, `GET /get_comments?expense_id=<sw>`. Courtesy delay already
on the client. Cap per request so a large account does not hold one HTTP
request open. Wizard grows a fourth step; `/run` does it after expenses
for small accounts.

Either way:

- Identity is `metadata.splitwise_id`. PK is a fresh ULID, minted from
  `created_at` the same way expenses are (`originalInstant`).
- Author via `PersonResolver`. A comment from someone not yet seen
  creates a ghost rather than dropping the comment.
- Import **both** User and System rows. Skipping System throws away the
  only edit history Splitwise will give us.
- Source `deleted_at` set → skip, same as deleted expenses.
- `recordActivity: false`.
- Receipts: ignore. One preview warning: "Receipt images are not imported."
- Idempotent. A second run is a no-op plus a report.

`SplitwiseClient` stays read-only. Add `getComments(expenseId)` and the
`comments` / `comments_count` fields on expenses in
`src/splitwise/client.ts`. Nothing else talks to Splitwise.

### Merge

Already rewrites `comments.user_id`. Two people who both commented on the
same expense keep both rows. System comments that name the ghost in
`content` stay as imported text - rewriting English is how you invent
history.

### Offline

Specified in `docs/OFFLINE.md`: own Dexie table, own outbox kinds
(`comment.create` / `comment.delete`), own `sync_log` entity `'comment'`,
client-minted ULID, not part of `expenses.version`. Import of comments
still logs, like imported expenses.

---

## Slice 2 - Recurring expenses ✅

Built as described. `src/domain/recurring.ts` is the pure interval arithmetic
(imported by the form, like `split.ts`), `src/domain/scheduler.ts` is the job, and
`src/routes/native/recurring.test.ts` covers the clock-jump, edit-the-template and
guest cases.

A real feature, not a flag. Splitwise stores `repeats`, `repeat_interval`
(`never` / `weekly` / `fortnightly` / `monthly` / `yearly`), `next_repeat`,
and groups occurrences with `expense_bundle_id`. Each occurrence is a
normal expense. The template is the row that still has `repeats: true`.

### Schema

New columns on `expenses`, folded into `001`:

- `repeat_interval` - `null` means never
- `next_repeat` - when the scheduler should fire
- `repeat_of` - ULID of the template; null on the template itself

Plus CHECKs that a template is always scheduled, that an occurrence is never
itself a template (series stay one level deep), and that nothing repeats itself.
`yarn db:check` audits all three from the other side, along with
"no two occurrences share a due date".

No `expense_bundle_id`; the template id plus `repeat_of` is the bundle.
Email reminders are phase 4, not this slice.

### Writer

A scheduler in the same Node process (boot + interval), calling
`createExpense` for each due template. Server clock only. Generated rows
are ordinary expenses: same split as the template, `repeat_of` set,
`repeat_interval` null. Failures log and retry next tick.

Do not catch up a downtime by inserting three months of bills in one
request. Cap **one occurrence per template per tick** and leave
`next_repeat` behind so the user sees a gap rather than a surprise stack.
Say so in the UI when a series is behind.

Editing the template (amount, split, membership) affects **future**
occurrences only. Past bills do not move. Deleting the template stops the
series; it does not delete past occurrences. Deleting one occurrence does
not stop the series.

### UI

On `ExpenseForm`, a repeat control: never / weekly / fortnightly / monthly
/ yearly. Occurrences look like normal expenses on the list, with a small
"repeats" mark that links back to the series. Editing an occurrence is
editing that bill, not the template - make that obvious.

Guests can see occurrences (they are expenses). Creating or editing a
template is logged-in only for v1: the scheduler is a server job, and a
guest minting a series the owner cannot stop is a bad surprise. Revisit if
the guest-on-a-trip case wants it.

### Import

Past Splitwise occurrences are already separate expenses and import as
`exact` rows today. **Do not** turn `repeats: true` into a live SplitSmart
template. That would start generating future copies this account never
asked us to originate. Preview warning: "Recurring expenses are imported
as the bills that already happened. Future repeats are not scheduled
here." Users who want it going forward recreate the series once.

### Offline

Generating occurrences is server-side. Creating or editing a template is
**online-only** (`docs/OFFLINE.md`). Occurrences that already exist are
normal expenses and follow the ordinary outbox.

---

## Slice 3 - Search, filters, CSV ✅

Built. `src/routes/native/expense-filters.ts` is the one definition, shared by
the three list endpoints and the CSV export; `web/src/ExpenseFilters.tsx` is the
one bar, on the all-expenses, group and friend screens.

One implementation note worth keeping: `q` is `instr(lower(...))`, not `LIKE`, so
a search for `50%` finds a percent sign instead of matching every row.

**Native list endpoints** (all expenses, group, friend): `q` (description
substring), `group_id`, `friend_id`, `dated_after`, `dated_before`,
`category_id`, `is_payment`. Same filter bar on those screens. Do not add
amount-range until someone asks - per-currency integers make "more than
50" ambiguous without a currency.

**CSV:** `GET /api/v1/expenses.csv` with the same filters, scoped to what
the caller can see. Columns: date, description, cost (decimal string),
currency, category, group, per-participant paid/owed, `is_payment`. UTF-8
with header. Guests: in-scope rows only. Once the Dexie mirror exists, the
same CSV can be built locally; the HTTP endpoint stays for scripts.

---

## Slice 4 - Restore ✅

Built. Soft deletes were already stored; now there is a way back.

Native `POST /expenses/:id/restore` (and later groups, if group delete lands).
Goes through the expense writer, rebuilds repayments, writes activity and a
system comment, and must bump `version` once offline exists - otherwise a
restored row looks like the tombstone it replaced. `yarn db:check` clean after.

UI: the expense page no longer navigates away on delete; it stays and offers the
undo, and the activity feed offers one for a delete you find later.

---

## Slice 5 - Import leftovers ✅ (bar the operator step)

- **Re-import as update.** Implemented as recommended: overwrite through
  `updateExpense` only when the local row is untouched since import, otherwise
  skip with `"local edits, not refreshed"`. Never re-runs `computeSplit`; the
  split stays `exact`. New comments are inserted by `splitwise_id`; local user
  comments Splitwise never saw are never deleted.

  One detail the plan did not foresee: a refresh has to stamp
  `metadata.splitwise_synced_at` and write `updated_at` itself, or the trigger's
  own bump would make the next run think a person had edited the row. Import
  stamps use full ISO with milliseconds so they can never collide with the
  `YYYY-MM-DD HH:MM:SS` a native edit writes.
- **`yarn db:check` after import** and a manual balance spot-check against the
  Splitwise UI. Still an operator step, by nature; the wizard now says so on its
  last screen.

---

## Optional: a few more compat wrappers

Not required for the app. The six endpoints Toshl uses already work. If
something else you run wants to list groups or edit an expense through
`/api/sw/v3.0`, wrap native - do not invent a second write path:

- `get_groups` / `get_group/:id`
- `get_expense/:id`, `update_expense/:id`, `delete_expense/:id`
- `create_group`, `add_user_to_group`, `remove_user_from_group`
- `create_friend` / `delete_friend/:id` (native already does this)
- `get_currencies` if a client asks

Do **not** add `get_comments`, `get_notifications`, OAuth2, or recurring
fields on this wire as part of feature work. Native first. Frozen-wire
rule still applies if you do wrap: money as decimal strings, ULID ids,
`deleted_at` returned, both `user_id` and `user.id`.

`group_id: 0` stays `null`. `invite_link` on a serialized group stays
`null` (guest secrets are shown once at mint).

---

## Deliberately later or never

- Finishing `/api/sw/v3.0` for third-party Splitwise clients
- Push notifications, email-on-expense (phase 4)
- Receipts / image attachments (CLAUDE.md)
- Currency conversion, charts, Splitwise Pro
- Auto-continuing a Splitwise recurring series on import
- Importing Splitwise's notification stream (derived, ephemeral)
- Amount-range search

---

## The order it happened in

0. **Fixtures** - still outstanding, and no longer blocking: see above.
1. **Comments** - domain, native, guest, UI, import, System rows on live edit.
2. **Recurring.**
3. **Search / filters / CSV.**
4. **Restore**, then re-import-as-update.

---

## Testing

Written, in `src/domain/recurring.test.ts`,
`src/routes/native/comments.test.ts`, `src/routes/native/recurring.test.ts`,
`src/routes/native/expense-search.test.ts`, and additions to
`src/routes/native/import.test.ts`:

- Domain / route tests for comment create/delete, guest scope, author-only
  delete, System-not-via-HTTP.
- `src/routes/native/import.test.ts` grows a comments case on the fake
  Splitwise: nested or paged, idempotent second run, System + User,
  deleted skipped, unknown author becomes a ghost.
- Recurring: scheduler inserts one occurrence, does not insert a stack
  after a clock jump, goes through `createExpense`; editing the template
  does not rewrite past bills.
- Restore: `yarn db:check` clean; balances move back.
- Offline tests in `docs/OFFLINE.md` gain comment create/delete
  idempotency once that plan is built.

`yarn typecheck && yarn test && yarn db:check` before commit, same as
today.
