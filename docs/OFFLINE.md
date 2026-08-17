# Offline-first SplitSmart

A plan for the remaining work. The logged-in app should install as a PWA, hold
the user's visible ledger locally, stay fully usable with no network, and write
back when the connection returns — with an honest unsynced count and last-synced
time in the UI.

The reference *shape* is DumberTime (`~/development/DumberTime`, `CLOUD_SYNC.md`):
Dexie, an explicit outbox, receive-then-send, gzip over HTTP. That skeleton is
sound. DumberTime is single-user, schema-agnostic, and last-write-wins. None of
those three hold here.

**Link access is not part of this.** A guest-link visitor (`docs/GUEST.md`) has
no local ledger, no outbox, and no offline UI. See "Link access is online-only".

## Context

Already in place, and this plan assumes them:

- ULID primary keys (`docs/ULIDS.md`). The client may mint an expense or comment
  id; `createExpense` / `createComment` already take optional `id` and treat a
  retry as a no-op. There is no `client_uuid` and no parallel integer `compat_id`.
- Guest shell at `/guest/`, logged-in app at `/app/` (`docs/GUEST.md`). Hand-rolled
  service workers already claim those scopes. Guest never opens Dexie.
- Comments (`src/domain/comments.ts`), restore, recurring templates + scheduler,
  search/filters/CSV, claim/merge (`src/domain/merge.ts`).
- `src/domain/split.ts` is pure and already runs in the browser, including
  `deriveRepayments` / `simplifyDebts`. `web/src/money.tsx` already requires
  `decimalPlaces`.

Not built: `expenses.version`, `sync_log`, `/api/v1/sync/*`, Dexie, the outbox,
cached profile/currencies so a logged-in reload without the network is the app.

The canonical use case — a restaurant or a trip with no signal — is exactly
what fails today.

---

## What is offline-capable, and what is not

This table is **only for a logged-in account** (email + password, cookie
session or API token). Everything on the right needs a server round trip and
must show a clear "needs connection" state rather than queueing.

| Offline | Online-only |
|---|---|
| Read every group, friend, expense, comment, balance | **Adding a friend** |
| Create an expense (people you already know) | **Creating a group** |
| Edit an expense (including a template's amount / description) | **Starting or changing a repeat schedule** |
| Delete an expense (soft) | Guest links: mint / rotate / revoke |
| Restore an expense | Splitwise import (including comments) |
| Record a payment / settle up | Email verification, API tokens, **claiming** |
| Settle-up suggestions (derived locally) | **Adding a group member** |
| Read and write **user** comments on an expense you can see | Login, register |
| Search / filter the local ledger (and build the same CSV from it) | **Anything a guest-link visitor does** |

**Why friends and groups are online-only.** `POST /api/v1/friends` creates a
placeholder user server-side, and so does `POST /api/v1/groups/:id/members`.
Queueing either means the client inventing user or group identities that later
have to be reconciled — and for friends, reconciled *by email*, which is the
one heuristic `src/domain/import.ts` deliberately gates behind a named preview
because a wrong match merges two people's money. A local placeholder created
twice from two devices is two people where there should be one, and every
expense attached to the loser is stranded.

The practical consequence: **offline you can only add expenses among people
already in your local database.** The trip you are on is a trip with people
you already added.

**Comments.** First-class entity, not a field on the expense. The client mints
the comment ULID; the outbox carries `comment.create` / `comment.delete`;
commenting does **not** bump `expenses.version` — otherwise an offline note
would conflict with an offline edit of the split.

**System comments are server-only.** There is no client path. HTTP has no
`kind` field; routes hardcode `"user"`. `recordExpenseEvent` is called only
from `updateExpense` / `deleteExpense` / `restoreExpense` (and import replays
Splitwise's System rows through `createComment` on the server). The client
never mints them, not even a provisional one for a local edit: the wording is
the server's, and a local copy would duplicate on pull. They arrive on the
next pull after the expense write is applied.

**Recurring is generated on the server; clients only pull.** The scheduler
(`src/domain/scheduler.ts`) is the only thing that creates occurrences or
advances `next_repeat`. A client never enqueues an occurrence and never sends
`next_repeat`. The repeat *control* is online-only, same as "add a friend".
Occurrences that already exist (or that land on pull) are ordinary expenses
and follow create/edit/delete/restore. See "Scheduler" below.

**Claiming is online-only.** The write is `mergeUsers`. Other devices learn
about it through a merge log row plus expense upserts — they do **not** wipe
the local DB. See "Claim / merge".

### Link access is online-only

Invite links authenticate someone **as that member, in that group, for this
browser**. They are not an account.

- **No Dexie, no outbox, no bootstrap, no pull, no push.** `/api/v1/sync/*`
  rejects link credentials.
- **No "reload without the network is the app".** Cached profile + currencies
  are for logged-in accounts. A link visitor with no network sees a
  needs-connection state. A stale cached ledger for a shared dinner-table link
  can outlive the owner expiring the secret.
- **The service worker must not become a second copy of the group.** Precache
  the `/app` shell if you want; never cache `/api`. A shell that boots and then
  fails every fetch is fine; a shell that boots into cached JSON is not.
- **Guest `activate` must not delete origin caches.** `caches.keys()` is
  origin-wide. Wiping them on a `/guest` visit destroys the logged-in shell
  cache (the claim flow does exactly that visit). Guest caches nothing; it
  should not touch what it did not create.
- **`localStorage` holds the link secret, not the ledger.** Clearing it, or
  the owner expiring the secret, both mean "ask for a new link".
- **A later login on the same browser is a different mode.** `entry-app.tsx`
  already clears the leftover link secret. Never reuse a link-scoped identity
  as the Dexie namespace.

A link is a capability the owner can expire at any time. Offline-first means
keeping a copy the owner cannot revoke. Those two disagree, so link visitors
stay live-only.

---

## The five decisions that matter

Everything else in this plan is downstream of these.

### 1. The client mints the expense ULID; it is the primary key

The browser calls `ulid()`, Dexie is keyed by it, and `createExpense` inserts
with that id. A retry of the same id is a no-op that returns the existing row
— even if the body differs. That is the lost-response case, not a merge. Push
`duplicate` must **SELECT and return the stored row**; the domain helper only
returns the id.

Users and groups remain server-minted (online-only creates). Comments follow
the expense rule. The compat layer already speaks the same ULID `id`.

### 2. The server stays the only writer of expense tables

Rule 3 is load-bearing: it is the only thing enforcing

```
SUM(expense_users.paid_share_minor) == expenses.cost_minor
SUM(expense_users.owed_share_minor) == expenses.cost_minor
```

`POST /api/v1/sync/push` is a **batching wrapper** over `createExpense` /
`updateExpense` / `deleteExpense` / `restoreExpense` / `createPayment` /
`createComment` / `deleteComment`. It adds no new SQL against `expenses`,
`expense_users`, or `expense_repayments`. `yarn db:check` gains no new audit
surface.

`updateExpense`, `deleteExpense`, and `restoreExpense` gain `expectedVersion`,
checked **inside** the transaction (`UPDATE ... WHERE version = :base`). A
mismatch is a conflict, not an overwrite.

The known exception is `mergeUsers`, which already rewrites expense rows
directly (shares are *added*, never re-split). It must write `sync_log` in
the same transaction. It is not a second live write path for clients.

Corollary: an unsynced local expense is a **provisional record**, not ledger
truth. The server recomputes on replay and stays authoritative.

### 3. Balances are derived locally, never synced

Do not cache server-computed balances as local truth. Store `expense_users`
locally, run `deriveRepayments()` per expense, then SUM. Pairwise nets taken
from two people's `paid`/`owed` on a three-way bill are wrong. `simplifyDebts`
is already pure.

Per-currency arrays stay arrays (rule 2). The Frankfurter ≈ estimate is
display-only and simply omitted offline.

**Do not replicate `expense_repayments`.** It is a write-time cache (rule 4).

### 4. Server-assigned timestamps and a sequence cursor, from day one

- The **server** stamps every accepted change. Client timestamps are advisory
  metadata only, never used to decide a winner.
- The pull cursor is a monotonic integer **`seq`**, not a timestamp and not a
  ULID.

### 5. Conflicts are surfaced, not silently resolved

A client-minted create cannot conflict. Comment creates are the same: a new
ULID, no `version`. Real conflict is concurrent edit/edit, edit/delete, or
delete/restore of the *same* expense.

| Case | Resolution |
|---|---|
| Local create, any remote state | Always applies (PK is the ULID) |
| Remote edit, no local pending edit | Apply remote |
| Local edit, no remote edit since base | Apply local |
| Remote `delete` / `forget`, any local pending | **Delete/forget wins.** Tombstone or drop locally, drop outbox, never resurrect |
| Remote restore (live upsert) vs local pending **delete** | **Conflict.** Do not push the delete on top of someone else's undo. Show both. |
| Local restore, no remote change since base | Apply local |
| Both edited the same expense since base | **Surface to the user.** Server row stays ledger truth |
| Remote `user_merge` vs local pending op that names the ghost | Remap or quarantine — see "Claim / merge". Never combine shares locally |

"Keep both" is UI-only. Applying both versions would double the money. If the
server row is already deleted, that is delete-wins, not the edit/edit prompt —
`updateExpense` already refuses deleted rows.

Detecting this needs `expenses.version INTEGER NOT NULL DEFAULT 1`, bumped on
user-visible writes (see the table under Migration). The client stores the
version it edited from and push includes it. A mismatch is a conflict, not an
overwrite.

---

## Server-side design

### Migration

`migrations/001` is still folded. Put `version` and `sync_log` **in `001`**,
not an `ALTER` on a later file, until a deployed database exists. `client_uuid`
is not a column.

```sql
-- on expenses, next to the other columns. The ULID PK is the idempotency key.
version INTEGER NOT NULL DEFAULT 1,

-- Append-only change log. One row per accepted write. Never updated, never
-- deleted. seq is the only sync cursor — INTEGER, not a ULID.
CREATE TABLE sync_log (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  entity             TEXT    NOT NULL,
  -- ULID of the entity, or the subject user for group_member / friendship /
  -- user_merge (the ghost being consumed).
  entity_id          TEXT    NOT NULL,
  -- Friendship: user_b_id. user_merge: the survivor. Null otherwise.
  other_user_id      TEXT    REFERENCES users(id),
  op                 TEXT    NOT NULL,
  group_id           TEXT    REFERENCES groups(id),
  actor_user_id      TEXT    REFERENCES users(id),
  -- Extra viewer: forget rows, and fan-out of user_merge.
  audience_user_id   TEXT    REFERENCES users(id),
  server_ts          TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (op IN ('upsert', 'delete', 'forget', 'merge')),
  -- SQLite cannot ALTER a CHECK. 'comment' and 'user_merge' are in from day one.
  CHECK (entity IN (
    'expense','comment','group','group_member','friendship','user','user_merge'
  ))
) STRICT;

CREATE INDEX idx_sync_log_group ON sync_log(group_id, seq);
CREATE INDEX idx_sync_log_entity ON sync_log(entity, entity_id);
CREATE INDEX idx_sync_log_audience ON sync_log(audience_user_id, seq);
```

How composite keys are encoded — junction tables have no surrogate ULID:

| entity | `entity_id` | extra |
|---|---|---|
| `expense`, `comment`, `group`, `user` | that row's ULID | — |
| `group_member` | member's user ULID | `group_id` |
| `friendship` | `user_a_id` | `other_user_id` = `user_b_id` |
| `user_merge` | ghost (`from`) | `other_user_id` = survivor (`to`) |

A `comment` log row copies `group_id` from its parent expense (null if
non-group) so the pull query does not have to join a possibly-deleted parent.
The payload still carries `expense_id`.

Ops: `delete` is a ledger tombstone (expense `deleted_at`); `forget` means drop
**this caller's** replica; `merge` is claim (ghost → survivor). `upsert` is
everything else, including restore (the row is live again) and a scheduler
tick's template `next_repeat`.

**When `version` bumps** — only writes that a human could also have made:

| Write | Bump `version`? | `sync_log` |
|---|---|---|
| `createExpense` | insert at `1` | `expense` upsert |
| `updateExpense` | yes | upsert + participant `forget`s |
| `deleteExpense` | yes | `delete` |
| `restoreExpense` | yes | upsert (live row; tombstone is not a second identity) |
| `advanceRepeatSchedule` | **no** | template upsert (`next_repeat` only). A monthly tick must not conflict with a pending typo fix |
| `markImportSynced` | **no** | **none**. Metadata stamp, not a person editing |
| Import via `updateExpense` | yes | upsert |
| `mergeUsers` share rewrite | yes | `user_merge` (fan-out) + expense upserts |

Restore must bump: otherwise the restored row still looks like the tombstone
it replaced (`docs/PARITY.md` slice 4), and a stale edit at the old version
would overwrite it.

Notes that will bite otherwise:

- **`STRICT`** on the new table, matching every other table.
- **`src/db/types.ts` is hand-maintained in practice.** Running
  `yarn db:codegen` renames every interface and breaks `src/db/index.ts`. Add
  `version` and `SyncLog` by hand alongside the schema change.
- Other people's names and emails travel **nested** on expense / member /
  friendship / snapshot payloads. A standalone `user` log row is for your own
  profile. Stale names until the next shared write are acceptable for v1.
- The pull sketch's `OR` will not use `idx_sync_log_group`. At volume this
  wants a `UNION` of index-friendly queries, plus a real test.

### Where `sync_log` rows get written

In the same transaction as the write. A committed change without a log row is
a change no device will ever learn about.

- `src/domain/expenses.ts` — create / update / delete / restore, and
  `advanceRepeatSchedule` (template upsert, no version bump).
- `src/domain/comments.ts` — user-comment create / delete. System comments
  too: they are rows other devices must see, even though the client never
  pushes them.
- Group / friend / member mutations.
- `mergeUsers` — see "Claim / merge". This is the other writer of expense
  rows; skipping it leaves every other device with a ghost id.

Imported expenses (`recordActivity: false`) still log — the log is not an
activity feed. Imported comments log as `entity = 'comment'` upserts.

On `updateExpense`, diff old vs new participants:

- Lost access, and they would not still see the expense via group membership:
  `forget` with `audience_user_id` set to them. The client that applies it
  also drops local comments for that expense.
- **Gained access** (they are now a participant and were not): if this is a
  **non-group** expense, the pull page also returns
  `catchUp: [{ entity: "expense", id }]`. Group expenses do not need it —
  comments on them already match the membership subquery. See "Snapshot on
  access grant".

### Audience resolution: at read time

```sql
-- Sketch. Current ACL, plus rows that exist so you can learn you lost access,
-- plus your own membership changes even after left_at, plus merges aimed at you.
SELECT * FROM sync_log l
WHERE l.seq > :since
  AND (
        l.group_id IN (SELECT group_id FROM group_members
                        WHERE user_id = :me AND left_at IS NULL)
    OR (l.entity = 'expense' AND l.entity_id IN
          (SELECT expense_id FROM expense_users WHERE user_id = :me))
    OR (l.entity = 'comment' AND (
          l.group_id IN (SELECT group_id FROM group_members
                          WHERE user_id = :me AND left_at IS NULL)
       OR l.entity_id IN (
            SELECT c.id FROM comments c
            JOIN expense_users eu ON eu.expense_id = c.expense_id
            WHERE eu.user_id = :me)
        ))
    OR (l.entity = 'group_member' AND l.entity_id = :me)
    OR (l.entity = 'friendship' AND (l.entity_id = :me OR l.other_user_id = :me))
    OR (l.entity = 'user_merge' AND l.other_user_id = :me)
    OR l.audience_user_id = :me
  )
ORDER BY l.seq
LIMIT :limit;
```

The `group_member AND entity_id = :me` clause is load-bearing: after `left_at`
is set you no longer match the membership subquery, and without it you would
never receive the row that tells you you left. Client applies `left_at`, drops
local expenses for that group **where you are not a participant**, and keeps
ones you are on — the same rule as All expenses today. Comments follow the
expenses they hang off.

Pending **create** in a group you then left: you are a participant, so the
local row stays, but push fails `assertParticipantsAreMembers`. Quarantine.
Do not coerce `group_id` to null.

`user_merge` for the survivor matches `other_user_id = :me`. Everyone else who
had the ghost in their replica matches via fan-out `audience_user_id` (the
ghost is already gone from `expense_users` by the time others pull, so
read-time "who knew the ghost" cannot work).

Read-time resolution does **not** backfill history. Incremental pull is
`seq > :since`. Joining a group from an already-synced device is why snapshot
exists. Same reason a newly added non-group participant needs catch-up for
comments.

### Snapshot on access grant

```
GET  /api/v1/sync/snapshot?group_id=<ulid>
     Current group, members, their user rows, expenses with shares, comments
     on those expenses.
     Same upsert shape as a slice of bootstrap. Does not rewind the cursor.

GET  /api/v1/sync/snapshot?expense_id=<ulid>
     One expense's comments (the expense itself is already in the pull page).
     Used when the caller was just added as a participant on a non-group bill.
```

Pull pages that contain a `group_member` upsert for **the caller** also return:

```
catchUp: [{ entity: "group", id }]
```

Pull pages that contain an expense upsert on which **the caller gained**
participant access, and `group_id` is null, also return:

```
catchUp: [{ entity: "expense", id }]
```

The expense row (shares, description) arrives as the upsert — entities are
returned whole, but comments are a **separate** entity with old `seq`s below
the cursor. Without this catch-up the caller gets the bill and an empty
thread. Group join already snapshots comments; this is the non-group
equivalent.

The client applies the change, fetches the snapshot, upserts, and does **not**
rewind `since`. (It still advances `since` to the pull page's head. "Leave
`since` alone" means do not reset to 0.) New writes in a group you already
belong to still arrive via normal pull. Import too.

`catchUp` continues in the same sync cycle as `more: true`.

### Restore

`restoreExpense` is a first-class write, not an `update` that happens to clear
`deleted_at`. `updateExpense` refuses deleted rows and that stays.

Push kind `expense.restore`. `baseVersion` is the tombstone's version.
The wrapper calls `restoreExpense` (bumps version, rebuilds repayments, system
comment + activity). If the outbox folded a later edit into the same op, it
then calls `updateExpense` in the same request and returns the **final**
version. One round-trip; the client cannot know the post-restore version in
between.

A restore of an already-live row is a no-op (`duplicate`), same as restoring
twice today.

### Scheduler

Server-side only. `runDueRecurrences` calls `createExpense` (occurrence,
`repeat_of` set) then `advanceRepeatSchedule` (template `next_repeat`). Those
cannot share a transaction (`createExpense` opens its own). Each logs
separately. A pull between them can show the new bill and a still-behind
template; the next page or next cycle catches up. That is already the
idempotency story for a crash between the two.

The client:

- Never mints an occurrence, never sends `next_repeat`, never calls anything
  like "generate now".
- Applies a new occurrence as a normal expense upsert (new ULID, no local
  pending row).
- Applies a template upsert (`next_repeat` moved) unless there is a pending
  local update of that same expense — then skip the remote row, push, take
  `applied` / `conflict`. The occurrence still applies (different id). After
  push, ordinary edits **omit** `repeatInterval` (`undefined` = leave the
  schedule). Sending the current interval is a *set*, which would recompute
  `next_repeat` from the date.
- Does not bump into a conflict just because rent generated: scheduler does
  not bump `version`.

### Claim / merge

Wipe-and-rebootstrap is the wrong default. It destroys the outbox (the only
copy of an unsynced dinner), conflict/quarantine state, and would fire on the
*owner's* other laptop because someone else claimed a ghost. Remap instead.

`mergeUsers` already runs in one transaction. Same transaction, also:

1. **Fan-out `user_merge` rows** (`op = 'merge'`, `entity_id` = ghost,
   `other_user_id` = survivor, `audience_user_id` = each person who could see
   the ghost: shared expense, shared group, or friendship). Plus the survivor
   if they were not already in that set.
2. **Expense upserts** for every expense whose participants or shares changed
   (transferred or combined). Version bumps: this is real money. The client
   must not locally add shares — that logic lives in `merge.ts` and a second
   copy would drift.
3. **`group_member` upserts** for memberships the survivor newly gained. Those
   already trigger `catchUp` of the group for the survivor, which is how their
   other devices acquire history they never had. Do not special-case a
   full bootstrap.
4. Forget/drop the ghost user for those audiences.

Client applying `user_merge`, **before** expense upserts in the same page:

- Remap `from` → `to` in `users`, `groupMembers`, `friendships`, `comments`,
  and outbox payloads.
- If both ids already exist on the same local membership/friendship unique
  key, drop `from` (the survivor's row wins).
- **Do not remap `expenseUsers` by rewriting the id.** Wait for the expense
  upsert and replace the document. A remap of shares would either duplicate
  the survivor on a combined bill or keep the pre-merge amounts.
- Outbox: rewrite participant ids `from` → `to`. If that produces the
  survivor twice on one bill, **quarantine** — combining paid/owed is not a
  client job. The user re-edits.
- Drop the ghost `users` row.

Pending edit of an expense the merge rewrote: the upsert has a new `version`.
Push then `conflict`s, which is correct (shares changed under you).

### Endpoints

Native routes. The compat layer is untouched.

```
GET  /api/v1/sync/bootstrap
     Everything the caller can see, plus the seq to start from. For a fresh
     install or a local DB reset. Paginated.
     Capture seq at the **start**, then paginate; accept duplicates on the
     first pull. Snapshot at the end and you drop writes that landed after
     their page was scanned.
     -> { seq, users[], groups[], friends[], expenses[], comments[], categories[],
          currencies[], nextCursor? }

GET  /api/v1/sync/snapshot?group_id=<ulid>
GET  /api/v1/sync/snapshot?expense_id=<ulid>
     Catch-up. See above.

GET  /api/v1/sync/pull?since=<seq>&limit=1000
     Incremental. Entities are returned whole — no field-level diffs.
     Drain `more: true` in one sync cycle, not one page per 5-minute tick.
     -> { changes: [{ seq, entity, op, data }], seq, more, remaining,
          catchUp?: [{ entity: "group" | "expense", id }] }

POST /api/v1/sync/push
     Body: { ops: [{ id, kind, baseVersion?, payload }] }
     kind: 'expense.create' | 'expense.update' | 'expense.delete'
         | 'expense.restore' | 'payment.create'
         | 'comment.create' | 'comment.delete'
     `id` is the expense or comment ULID.
     Each op routed to the existing domain function. Per-op result:
     -> { results: [{ id, status, version?, reason?, server? }] }
        status: 'applied' | 'duplicate' | 'conflict' | 'rejected'
```

`payment.create` is `createExpense` with `is_payment = 1`. Same ULID, same
create path.

**Push order is load-bearing.** The client sorts a batch so parent exists
before child: `expense.create` / `payment.create` first, then
update/restore/delete, then comments. A `comment.create` whose expense is
still sitting later in the same `ops` array is `rejected`. The reducer
already collapsed create+edit into one `create`; this is about two entities.

`comment.create` / `comment.delete` route to `src/domain/comments.ts`. No
`baseVersion`. Delete of a missing/already-deleted row is `duplicate`. A
comment on an expense the caller can no longer see is `rejected`. System
comments are never pushed.

`status`:

- **`applied`** — new `version` (expense kinds that bump); client clears the
  outbox entry.
- **`duplicate`** — ULID PK already present, or restore/delete of a row
  already in that state. Not an error. Client clears the entry and adopts
  `server` (the stored row, not just the id).
- **`conflict`** — `baseVersion` is stale. Returns the server's current row.
  Entry moves to a conflict state, not the bin.
- **`rejected`** — cannot be applied exactly: unknown currency, group gone,
  participant no longer a member, shares that do not sum. Carries a `reason`.

**Rejections must be visible.** Same discipline as import `skipped[]`: a
rejected expense goes to a quarantine list. An expense that silently vanishes
between devices is worse than an error message.

Gzip the push body with `pako` above a size threshold — that needs a matching
server gunzip. Pull responses get gzip from the HTTP layer.

---

## Client-side design

### Dexie, not raw IndexedDB

Decided. `dexie-cloud-addon` is a separate opt-in package. What Dexie is
buying: `liveQuery` + `dexie-react-hooks`, versioned schema migrations,
multi-store transactions and compound indexes. Skip `dexie-syncable` and skip
`db.on('changes')`. Explicit outbox table, testable as a pure reducer.

### Local schema

```ts
// web/src/db/local.ts — sketch
const db = new Dexie(`splitsmart-${userId}`) as Dexie & {
  expenses:      EntityTable<LocalExpense, "id">;
  expenseUsers:  EntityTable<LocalExpenseUser, "key">;  // `${expenseId}:${userId}`
  comments:      EntityTable<LocalComment, "id">;
  groups:        EntityTable<LocalGroup, "id">;
  groupMembers:  EntityTable<LocalGroupMember, "key">;
  users:         EntityTable<LocalUser, "id">;
  friendships:   EntityTable<LocalFriendship, "key">;
  currencies:    EntityTable<Currency, "code">;
  categories:    EntityTable<Category, "id">;  // still Splitwise integers
  outbox:        EntityTable<OutboxOp, "seq">;
  meta:          EntityTable<MetaRow, "key">;   // cursor, lastSyncedAt, profile
};

db.version(1).stores({
  expenses:     "id, groupId, date, deletedAt, syncState, repeatOf",
  expenseUsers: "key, expenseId, userId, [expenseId+userId]",
  comments:     "id, expenseId, createdAt, deletedAt, syncState",
  groups:       "id, name",
  groupMembers: "key, groupId, userId, [groupId+userId]",
  users:        "id, email",
  friendships:  "key, otherUserId",
  currencies:   "code",
  categories:   "id, parentId",
  outbox:       "++seq, id, kind, status",
  meta:         "key",
});
```

Indexed fields are not the whole row. `LocalExpense` also carries `version`,
`currencyCode`, `costMinor`, `splitType`, `splitMeta`, `details`, `categoryId`,
`isPayment`, `paymentMethod`, `repeatInterval`, `nextRepeat`, `repeatOf`,
`createdBy` — everything the editor needs to reopen a bill. Groups need
`default_currency` and `simplify_by_default`.

`LocalComment` carries `expenseId`, `userId`, `content`, `kind` (`'user'` |
`'system'`), `createdAt`, `deletedAt`, `syncState`. Applying an expense
`delete` / `forget` drops local comments for that `expenseId` in the same
transaction.

`LocalExpense.syncState` is `'synced' | 'pending' | 'conflict' | 'rejected'`.
**The DB name is namespaced by user id.** Link-access visitors never open it.

Nothing from `access_links` goes in Dexie.

### The outbox

One pending op per expense, specified as a **pure reducer**:

| Incoming | Pending | Result |
|---|---|---|
| create | — | pending `create` |
| edit | pending `create` | stay `create`, replace payload |
| delete | pending `create` | **drop the entry** (never existed on the server) |
| edit | — (synced) | pending `update`, freeze `baseVersion` |
| edit | pending `update` | replace payload, **keep original `baseVersion`** |
| delete | pending `update` | become `delete`, same `baseVersion` |
| delete | — (synced) | pending `delete` |
| restore | pending `delete` | **drop the entry** (delete never left this device) |
| restore | — (synced tombstone) | pending `restore`, freeze `baseVersion` |
| edit | pending `restore` | stay `restore`, attach payload (restore-and-replace) |
| delete | pending `restore` | drop the entry; local row stays a tombstone |
| pull `delete`/`forget` | anything | drop outbox (**delete/forget wins**) |
| pull live upsert (restore) | pending `delete` | **conflict**, keep both, do not apply blindly |

`baseVersion` is the server version at first local edit/restore/delete, not an
optimistic bump.

Ordinary expense payloads **omit** `repeatInterval` unless the user used the
(online-only) repeat control. The three-state field is load-bearing: absent
leaves the schedule, `null` stops it, a value sets it.

Comments have their own outbox entries, keyed by comment id:

| Incoming | Pending | Result |
|---|---|---|
| create | — | pending `comment.create` |
| delete | pending `create` | **drop the entry** |
| delete | — (synced) | pending `comment.delete` |
| pull `delete`/`forget` of the comment | anything | drop outbox |
| pull `delete`/`forget` of the **expense** | any comment op on it | drop those entries, drop local comments |

No `comment.update`. A user comment cannot conflict with an expense edit
because they do not share `version`.

Two corrections learned from DumberTime's bug list:

- **Do not shadow the outer variable in a Dexie `.and()` callback.**
- **Only clear an entry after a successful, parsed, per-op `status`.** Not on
  HTTP 200 alone. `duplicate` still needs the returned `server` row.

Never clear the outbox on a 401. The 30-day httpOnly session cookie can expire
while unsynced expenses are queued; that is "reconnect to keep syncing", not
a logout. `Protected` today navigates to `/login` on a failed `/auth/me`; that
has to stop treating 401-while-offline (or 401-while-outbox-nonempty) as a
wipe. Network failure on `/auth/me` is not "logged out".

### Sync loop

```
pull(since: cursor)  →  apply in one transaction  →  advance cursor
push(outbox)         →  per-op results  →  clear / conflict / quarantine
```

Receive-then-send, so arriving changes do not overwrite what you are about to
send.

Pull vs a pending outbox entry:

- Pending create: ignore echoes until push returns `applied`.
- Pending update or restore + remote upsert: **do not apply**; push and take
  `applied` / `conflict`.
- Pending anything + remote `delete` / `forget`: apply remote, drop outbox.
- Pending delete + remote live upsert: conflict (see reducer).
- `user_merge`: always apply the remap rules, even with a pending outbox;
  then the expense upserts in the same cycle follow the rows above.
- Successful push, then pull echo: upsert by `id`, do not insert a second row.

Triggers: app foreground, `window.online`, an interval (5 minutes is fine),
and a manual Sync now. Single-flight, no retry storm. A successful sync with
`more: true` or a non-empty `catchUp` continues in the same cycle.

### Boot without the network

Today `App.tsx` cannot render until `/auth/me` answers, and `money.tsx`
renders a dash until `/currencies` does. Change to: read the cached profile
and currencies from Dexie/`meta`, render immediately, revalidate in the
background. Treat 401 as "offline / reconnect" when a cached profile exists,
never as an automatic local wipe. Link-access visitors do not take this path.

**Reference data must be cached or nothing renders at all.** Currencies and
the category tree are static — cache them at bootstrap and refresh lazily.

### Status UI

- **Unsynced count** — `outbox.where('status').equals('pending').count()`.
- **Last synced** — `meta.lastSyncedAt`, last *successful* sync.
- **Offline indicator** — `navigator.onLine` plus last-failure state.
- **Per-expense badge** — pending / conflict / rejected.
- **Conflict and quarantine screens** — non-negotiable.

Activity is not in the local schema. The Activity page stays online-only.
Restore-from-the-feed therefore needs the network; restore from the expense
page (already the delete UX) does not. Comments live in Dexie.

---

## PWA shell

Already claimed, on purpose, so a later worker cannot sit at `/`:

- `web/public/app/sw.js` — shell only, `/app/` scope, no `/api`.
- `web/public/guest/sw.js` — network-only, `/guest/` scope.
- `web/public/app/manifest.webmanifest` — `start_url` and `scope` must both
  be `/app/` (a `start_url` of `/app` is outside a scope of `/app/`).
- `entry-app.tsx` registers the app worker in production; `entry-guest.tsx`
  registers the guest worker in dev too, so it can steal the scope from a
  stale wider worker.

Do not add `vite-plugin-pwa` on top of this unless it replaces the hand-rolled
files entirely. Two workers fighting for `/app/` is worse than none.

Still to do: PNG icon set from `web/src/Logo.tsx`, cached profile + currencies
so a logged-in reload with no network is the app, and the guest worker must
**not** `caches.delete` the origin (see above).

The app worker already serves the cached `/app` document for navigations under
`/app` when the network fails — that *is* `navigateFallback`. Keep denying
`/api`, `/health`, and `/guest`. Do not glob `json`.

A new worker version that claims immediately can reload the tab mid-form.
Outbox in IDB survives; the form does not. Acceptable for v1, not invisible.

---

## Phasing

Each phase ships on its own and is useful alone.

### Phase 0 — Foundations
`version` + `sync_log` in `001` (entity CHECK includes `comment` and
`user_merge`; op CHECK includes `merge`), hand-updated `db/types.ts`,
`expectedVersion` on update/delete/restore, `sync_log` writes inside
`expenses.ts` (including restore, `advanceRepeatSchedule`, participant-diff
`forget` **and** non-group gain-access catch-up), `comments.ts`,
group/friend/member mutations, and `mergeUsers`. Local balance path via
`deriveRepayments`. No client changes. `yarn db:check` must still pass.

### Phase 1 — PWA shell
Icons, cached profile + currencies for a **logged-in** reload, guest worker
must not wipe the app cache. No sync yet.

### Phase 2 — Local read mirror
Dexie schema, `/sync/bootstrap`, reference-data cache, pages converted to
`useLiveQuery`, local balance computation. **The app becomes fully usable
offline, read-only.** Online writes in this phase must write-through to Dexie
from the existing API responses. CSV can be built from the mirror with the
same filters as `expense-filters.ts`.

### Phase 3 — Incremental pull
`/sync/pull`, `/sync/snapshot` (group **and** expense), `catchUp`, audience
query, seq cursor, `user_merge` remap, drain `more`. Test
already-synced-then-joined-a-group, already-synced-then-added-to-a-non-group
bill (comments present), and claim-then-other-device (ghost id gone, shares
combined, outbox intact).

### Phase 4 — Offline writes
Outbox reducer (including restore and merge remap), `/sync/push` through the
existing domain writers, four-status contract, conflict + quarantine.
**This is where the risk in the project lives.**

### Phase 5 — Status and polish
Unsynced count, last-synced time, per-expense badges, conflict resolution
screen, online-only affordances disabled with an explanation.

Rough shape: phases 0–3 are a few days each; phase 4 is where the week goes.

---

## Testing

Follow `src/routes/native/import.test.ts` — real client, real routes, real
expense writer, `DATABASE_PATH` set before any import that reaches
`src/db/index.ts`.

- **Push idempotency** — same batch twice yields one expense and a `duplicate`
  that includes the stored row.
- **Push order** — `comment.create` before its `expense.create` in the same
  batch is `rejected`; the sorted batch applies both.
- **Conflict** — two clients, same base version, second gets `conflict` and
  the server row, and no balance moves.
- **Delete-wins** — local edit, remote delete; push of the edit does not
  resurrect. Version bump on delete is what makes this a conflict, not a
  silent `rejected`.
- **Restore** — bumps `version`; restore of a tombstone with a stale
  `baseVersion` is `conflict`; local delete-then-undo never hits the server;
  pending delete vs remote restore is a conflict, not a silent re-delete.
- **Rejection** — unknown currency, departed member, shares that do not sum;
  each returns a reason and writes nothing. Left-a-group-then-push of a
  still-local create is `rejected`, not coerced.
- **Audience** — a group member sees a group expense; a non-member does not.
- **Join catch-up** — already-synced user added to a group with N expenses;
  after pull + snapshot, local DB has all N, comments included.
- **Non-group catch-up** — already-synced user added as a participant on a
  non-group expense that already has comments; after pull + expense snapshot,
  the thread is there. The expense upsert alone is not this test.
- **Leave / forget** — leaving a group keeps expenses you are a participant of
  and drops the rest; being removed from a non-group expense delivers `forget`
  and the local copy goes away, comments included.
- **Comments** — client-minted create is idempotent; delete of a pending
  create never hits the server; a comment op does not change
  `expenses.version`; forgetting the parent drops local comments and their
  outbox entries. System comments appear on pull after an applied edit, and
  are absent from push.
- **Scheduler** — a due template produces an occurrence another device sees
  via pull; the template's `version` is unchanged; a pending local edit of the
  template does not block the occurrence from applying.
- **Claim / merge** — ghost id is gone locally; combined shares match the
  server (not a client-side add); survivor's other device catch-up-joins the
  ghost's groups; a pending create that named the ghost is remapped; a pending
  create that would name the survivor twice is quarantined; the outbox is
  otherwise intact (this is why we do not wipe).
- **Cursor** — pull is complete and non-duplicating across a page boundary;
  bootstrap seq is captured at start.
- **Outbox reducer** — create-then-edit-then-push is one `create`;
  create-then-delete never hits the server; ten edits keep the original
  `baseVersion`; delete-then-restore drops the entry; restore-then-edit stays
  one `restore` with payload.
- **The invariant** — `yarn db:check` clean after every replay test.

Keep the outbox reducer and the conflict policy **pure**, so they are testable
under `node:test` without a browser.

---

## Deliberately not doing

- **CRDTs or vector clocks.**
- **Real-time sync.** No websockets.
- **Offline friend or group creation.**
- **Offline repeat-schedule edits, or client-generated occurrences.**
- **Client-generated system comments.**
- **Wipe-and-rebootstrap on claim.** Remap + expense upserts. Wipe is a
  last-resort recovery button, not the merge path.
- **Locally combining shares on `user_merge`.** Server row wins; quarantine
  if the outbox cannot remap cleanly.
- **Caching `/api` in the service worker.**
- **Mirroring `expense_repayments`.**
- **Client-side writes to the ledger as truth.**
- **Fan-out of historical log rows at join time.** Snapshot on access grant
  instead — groups *and* newly visible non-group expenses.
- **A `client_uuid` column.**
- **Nesting comments inside `expense.update`.**
- **Field-level merge of `next_repeat` into a pending template edit.** Skip
  the remote template row; the occurrence still applies.
- **Offline (or a local ledger of any kind) for invite-link visitors.**
- **`vite-plugin-pwa` stacked on the existing workers.**
