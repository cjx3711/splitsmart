# Offline-first SplitSmart

A plan, not an implementation. Nothing in here has been built yet.

The goal: SplitSmart installs as a PWA, holds the user's whole visible ledger in
a local database, stays fully usable with no network, and writes back when the
connection returns, with an honest unsynced count and last-synced time in the
UI.

The reference implementation for the *shape* of this is DumberTime
(`~/development/DumberTime`, see its `CLOUD_SYNC.md`): Dexie on the client, an
explicit change queue, receive-then-send, gzip over HTTP. That design is sound
and we borrow its skeleton. But DumberTime is **single-user**, its server is a
**schema-agnostic blob store**, and blanket last-write-wins is fine there. None
of those three hold here, and the differences are most of this document.

---

## Why this app is a good candidate

Two of the three hard parts are already done, by accident of earlier decisions:

- **`src/domain/split.ts` is pure and already runs in the browser.**
  `web/src/SplitEditor.tsx` imports the server's own `computeSplit()` to preview
  splits as you type. Creating an expense offline is therefore arithmetic that
  is already shared, already tested, and cannot drift from the server's answer.
- **Money handling is already currency-aware on the client.**
  `web/src/money.tsx` renders through the currencies table with `decimalPlaces`
  as a **required** argument.

And the canonical use case for a bill splitter: a restaurant or a trip abroad
with no signal, is exactly the case that fails today.

---

## What is offline-capable, and what is not

This line is deliberate. Everything on the right needs a server round trip and
must show a clear "needs connection" state rather than queueing.

| Offline | Online-only |
|---|---|
| Read every group, friend, expense, balance | **Adding a friend** |
| Create an expense (people you already know) | **Creating a group** |
| Edit an expense | Group invite links / rotation |
| Delete an expense (soft) | Splitwise import |
| Record a payment / settle up | Email verification, API tokens, account claim |
| Settle-up suggestions (derived locally) | Login, register, `/invite/claim` |

**Why friends and groups are online-only.** `POST /api/v1/friends` creates a
**ghost user server-side**, with the email address you invited them at, and
returns a recovery code exactly once. `POST /api/v1/groups` mints an
`invite_token`. Queueing either means the client inventing user or group
identities that later have to be reconciled, and for friends, reconciled *by
email*, which is the one heuristic `src/domain/import.ts` deliberately gates
behind a named preview because a wrong match merges two people's money. A local
ghost that gets created twice from two devices is two people where there should
be one, and every expense attached to the loser is stranded.

The practical consequence is worth stating plainly: **offline you can only add
expenses among people already in your local database.** That is the right v1
boundary: the trip you are on is a trip with people you already added.

---

## The five decisions that matter

Everything else in this plan is downstream of these.

### 1. `client_uuid`, not UUID primary keys

`expenses.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`
(`migrations/001_initial_schema.sql`), and that id passes straight through the
frozen compat layer to third-party clients like `splitwise-to-toshl`. Rule 5
says the wire format does not move, so the PK does not become a UUID.

Instead: **add `expenses.client_uuid TEXT UNIQUE`.** The client mints a UUID at
creation time, the local Dexie row is keyed by it, and each local row carries a
nullable `serverId` filled in when the write lands.

The unique index is not decoration; it is what makes replay **idempotent**. If
a push succeeds but the response is lost, the retry hits the unique constraint
and resolves to the existing row instead of creating a second expense.
DumberTime lists "network failure after server processes POST" as a *remaining*
edge case mitigated by timestamp filtering; here it is structurally impossible.

### 2. The server stays the only writer of expense tables

Rule 3 is load-bearing: it is the only thing enforcing

```
SUM(expense_users.paid_share_minor) == expenses.cost_minor
SUM(expense_users.owed_share_minor) == expenses.cost_minor
```

So `POST /api/v1/sync/push` is a **batching wrapper that loops over
`createExpense` / `updateExpense` / `deleteExpense` unchanged**. It is not a new
write path, it adds no new SQL against `expenses`, `expense_users`, or
`expense_repayments`, and `yarn db:check` gains no new audit surface.

Corollary: an unsynced local expense is a **provisional record**, not ledger
truth. The server recomputes on replay and stays authoritative, exactly as it
already does for the live editor.

### 3. Balances are derived locally, never synced

Do not cache server-computed balances as local truth. If you do, a locally
created expense will not move them, and the user sees a number that contradicts
the expense list directly above it.

Instead store `expense_users` locally and recompute. This needs one refactor:
`src/domain/balances.ts` is DB-coupled, so extract its pure arithmetic into a
core the browser can import: the same shape `split.ts` already has. Per-currency
arrays stay arrays (rule 2); there is still no exchange rate anywhere.

**Do not replicate `expense_repayments`.** It is a write-time cache (rule 4)
that exists to keep server balance queries a plain `SUM ... GROUP BY`. Locally,
compute straight from shares; at one user's data volume the cost is nil, and
mirroring a cache means mirroring the job of keeping it consistent.

### 4. Server-assigned timestamps and a sequence cursor, from day one

DumberTime's own known-issues table has client clock skew as its top remaining
edge case ("a device with a clock ahead by even a few minutes will always win"),
and its server has since grown `last_sent_seq` to supersede
`last_sent_timestamp` because a client clock cannot order writes from more than
one device. Start where they ended up:

- The **server** stamps every accepted change. Client timestamps are advisory
  metadata only, never used to decide a winner.
- The pull cursor is a **monotonic `seq`**, not a timestamp. This removes the
  boundary-overlap re-fetch, the `>=`-vs-`>` bug class, and the stall-detection
  loop guard all at once.

### 5. Conflicts are surfaced, not silently resolved

Blanket LWW is wrong for shared financial records, but the exposure is much
smaller than it first looks:

- A `client_uuid`-created expense **cannot** conflict. It is new by
  construction.
- Expenses are overwhelmingly append-only in practice.

That confines real conflict to concurrent edit/edit or edit/delete of the *same*
expense. Policy:

| Case | Resolution |
|---|---|
| Local create, any remote state | Always applies (unique `client_uuid`) |
| Remote edit, no local pending edit | Apply remote |
| Local edit, no remote edit since base | Apply local |
| Either side deleted | **Delete wins.** Tombstone, never resurrect |
| Both edited the same expense since base | **Surface to the user.** Keep both, ask |

Detecting the last case needs a base version. Add `expenses.version INTEGER NOT
NULL DEFAULT 1`, bumped on every write; the client stores the version it edited
from and push includes it. A mismatch is a conflict, not an overwrite. Someone's
money is not a merge to resolve quietly.

---

## Server-side design

### Migration

Forward-only, next number in sequence. Three things:

```sql
-- expenses gains an idempotency key and an optimistic-concurrency version.
ALTER TABLE expenses ADD COLUMN client_uuid TEXT;
ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX idx_expenses_client_uuid
  ON expenses(client_uuid) WHERE client_uuid IS NOT NULL;

-- Append-only change log. One row per accepted write. Never updated, never
-- deleted. seq is the only sync cursor.
CREATE TABLE sync_log (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity         TEXT    NOT NULL,   -- 'expense' | 'group' | 'group_member' |
                                     -- 'friendship' | 'user'
  entity_id      INTEGER NOT NULL,
  op             TEXT    NOT NULL,   -- 'upsert' | 'delete'
  -- Denormalised audience hints, so the pull query does not have to reach into
  -- a soft-deleted parent row to work out who may see this change.
  group_id       INTEGER REFERENCES groups(id),
  actor_user_id  INTEGER REFERENCES users(id),
  server_ts      TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (op IN ('upsert', 'delete')),
  CHECK (entity IN ('expense','group','group_member','friendship','user'))
) STRICT;

CREATE INDEX idx_sync_log_group ON sync_log(group_id, seq);
CREATE INDEX idx_sync_log_entity ON sync_log(entity, entity_id);
```

Notes that will bite otherwise:

- **`ALTER TABLE ADD COLUMN` is fine here.** No CHECK constraint is being
  changed, so no table rebuild and no `-- migrate:no-transaction`. If a later
  revision *does* touch a CHECK, read the CLAUDE.md warning about
  `PRAGMA foreign_keys=OFF` first.
- **`STRICT`** on the new table, matching every other table.
- **`src/db/types.ts` is hand-maintained in practice.** Running
  `yarn db:codegen` renames every interface and breaks `src/db/index.ts`. Add
  the new columns and the `SyncLog` table by hand alongside the migration.
- `client_uuid` is a **partial** unique index so the 168k existing/imported rows
  with NULL do not collide.

### Where `sync_log` rows get written

One place, for the same reason there is one expense writer: inside the existing
transactions in `src/domain/expenses.ts`, plus the group/friend/member mutations.
A change that is committed without a log row is a change no device will ever
learn about, so it goes in the same transaction as the write itself.

Imported expenses (`recordActivity: false`) still log; the log is not an
activity feed, it is a replication cursor, and an import that does not replicate
leaves every other device permanently behind.

### Audience resolution: at read time

DumberTime pulls "changes for this user" because there is only ever one user. A
group expense here is visible to every member, and your visibility set *changes
retroactively* when you join a group.

So resolve audience in the pull query rather than fanning out one log row per
recipient:

```sql
-- Sketch. A caller sees a change if it is in a group they belong to, or it is a
-- non-group expense they participate in, or it concerns them directly.
SELECT * FROM sync_log l
WHERE l.seq > :since
  AND (
        l.group_id IN (SELECT group_id FROM group_members
                        WHERE user_id = :me AND left_at IS NULL)
    OR (l.entity = 'expense' AND l.entity_id IN
          (SELECT expense_id FROM expense_users WHERE user_id = :me))
    OR (l.entity IN ('user','friendship') AND l.actor_user_id = :me)
  )
ORDER BY l.seq
LIMIT :limit;
```

Read-time resolution buys one thing fan-out cannot: **joining a group backfills
its history automatically**, because the membership subquery now matches old log
rows. With fan-out you would have to synthesise thousands of rows at join time.

The cost is that the pull query is the most expensive thing in this design.
Budget for indexing work and a real test at volume.

### Endpoints

Two new native routes. The compat layer is untouched; it reads SQLite
server-side and knows nothing about any of this.

```
GET  /api/v1/sync/bootstrap
     Everything the caller can see, plus the seq to start from. For a fresh
     install or a local DB reset. Paginated.
     -> { seq, users[], groups[], friends[], expenses[], categories[],
          currencies[], nextCursor? }

GET  /api/v1/sync/pull?since=<seq>&limit=1000
     Incremental. Entities are returned whole; no field-level diffs.
     -> { changes: [{ seq, entity, op, data }], seq, more, remaining }

POST /api/v1/sync/push
     Body: { ops: [{ clientUuid, kind, baseVersion?, payload }] }
     kind: 'expense.create' | 'expense.update' | 'expense.delete' | 'payment.create'
     Each op routed to the existing domain function. Per-op result, so one bad
     op never fails the batch:
     -> { results: [{ clientUuid, status, serverId?, version?, reason?, server? }] }
        status: 'applied' | 'duplicate' | 'conflict' | 'rejected'
```

`status` is the whole contract:

- **`applied`**: new `serverId` and `version`; client clears the outbox entry.
- **`duplicate`**: `client_uuid` already present. Not an error. Client clears
  the entry and adopts the returned `serverId`. This is the lost-response case.
- **`conflict`**: `baseVersion` is stale. Returns the server's current row so
  the client can show both. Entry moves to a conflict state, not the bin.
- **`rejected`**: cannot be applied exactly: unknown currency, group gone,
  participant no longer a member, shares that do not sum. Carries a `reason`.

**Rejections must be visible.** The import layer already sets this precedent -
"a row that cannot be imported exactly is skipped with a reason, never fudged",
returned in `skipped[]`. Same discipline: a rejected expense goes to a
quarantine list the user can see and re-edit. An expense that silently vanishes
between devices is worse than an error message.

Gzip the push body with `pako` above a size threshold, as DumberTime does.
Pull responses get gzip from the HTTP layer for free.

---

## Client-side design

### Dexie, not raw IndexedDB

Decided. `dexie-cloud-addon` is a separate opt-in package, so not using Dexie
Cloud costs nothing. What Dexie is actually buying:

- **`liveQuery` + `dexie-react-hooks`.** The real prize. Every page under
  `web/src/pages/` currently does fetch-into-`useState`; offline-first means
  reading the local DB *and re-rendering when a sync pull writes new rows*.
  `useLiveQuery` is that, for free. Hand-rolled IDB gives no reactivity, so it
  means building an event bus and subscription registry, and getting it subtly
  wrong the first time.
- **Versioned schema migrations.** The local schema will change repeatedly, and
  a botched raw `onupgradeneeded` means a user's local ledger is unreadable.
- **Multi-store transactions and compound indexes.** Both are needed: applying a
  pull batch must be atomic across `expenses` + `expenseUsers` + `outbox`, and
  the outbox dedup lookup wants a compound index. See DumberTime's
  `[tableId+table]` index and the comment above it; without it Dexie fell back
  to a JS filter on *every mutation*.

Roughly 25kB gzipped, against hand-rolling a promise wrapper, a migration
runner, and a reactivity layer underneath financial data. Not a close call.

Also skip `dexie-syncable`: its protocol assumes a conflict model that is not
this one, and skip `db.on('changes')` for change tracking. Keep DumberTime's
**explicit outbox table**: inspectable in devtools, testable as a pure reducer,
and it survives a reload.

### Local schema

```ts
// web/src/db/local.ts (sketch)
const db = new Dexie(`splitsmart-${userId}`) as Dexie & {
  expenses:      EntityTable<LocalExpense, "uuid">;
  expenseUsers:  EntityTable<LocalExpenseUser, "key">;  // `${uuid}:${userId}`
  groups:        EntityTable<LocalGroup, "id">;
  groupMembers:  EntityTable<LocalGroupMember, "key">;
  users:         EntityTable<LocalUser, "id">;
  friendships:   EntityTable<LocalFriendship, "key">;
  currencies:    EntityTable<Currency, "code">;
  categories:    EntityTable<Category, "id">;
  outbox:        EntityTable<OutboxOp, "seq">;
  meta:          EntityTable<MetaRow, "key">;   // cursor, lastSyncedAt, profile
};

db.version(1).stores({
  expenses:     "uuid, serverId, groupId, date, deletedAt, syncState",
  expenseUsers: "key, uuid, userId, [uuid+userId]",
  groups:       "id, name",
  groupMembers: "key, groupId, userId, [groupId+userId]",
  users:        "id, email",
  friendships:  "key, otherUserId",
  currencies:   "code",
  categories:   "id, parentId",
  outbox:       "++seq, clientUuid, kind, status, [clientUuid+kind]",
  meta:         "key",
});
```

`LocalExpense.syncState` is `'synced' | 'pending' | 'conflict' | 'rejected'`,
and it is what the UI badges. **The DB name is namespaced by user id** so
switching accounts cannot mix two ledgers.

### The outbox

Same pattern as DumberTime's `cloudBackupChanges`, with dedup on
`[clientUuid+kind]` so ten edits to one unsynced expense collapse to one push.
Two corrections learned from its bug list:

- **Do not shadow the outer variable in a Dexie `.and()` callback.** DumberTime's
  dedup filter became `change.table === change.table`: always true, and wiped
  pending changes across every table.
- **Only clear an entry after a successful, parsed, per-op `status`.** Not on
  HTTP 200 alone.

Never clear the outbox on a 401. The 30-day httpOnly session cookie can expire
while unsynced expenses are queued; that is a "reconnect to keep syncing" state,
not a logout, and certainly not a reason to destroy the user's only copy of an
expense.

### Sync loop

Receive-then-send, as DumberTime does, and for the same reason: arriving
changes should not immediately overwrite what you are about to send:

```
pull(since: cursor)  →  apply in one transaction  →  advance cursor
push(outbox)         →  per-op results  →  clear / conflict / quarantine
```

Triggers: app foreground, `window.online`, an interval (5 minutes is fine), and
a manual Sync now. Guard with a minimum interval, single-flight so two triggers
cannot overlap, and no retry storm; a failed sync just waits for the next tick.

### Boot without the network

Today `App.tsx` cannot render until `/auth/me` answers. Change to: read the
cached profile from `meta`, render immediately, revalidate in the background.
Treat 401 as "offline / reconnect", never as an automatic local wipe.

**Reference data must be cached or nothing renders at all.** `money.tsx`
requires `decimalPlaces`; with no currencies table the app cannot display a
single amount. Both currencies and the category tree are static; cache them at
bootstrap and refresh lazily.

### Status UI

What was asked for, and the honest version of it:

- **Unsynced count**: `outbox.where('status').equals('pending').count()`,
  live via `useLiveQuery`.
- **Last synced**: `meta.lastSyncedAt`, rendered relative ("2 minutes ago").
  Show *last successful sync*, not last attempt.
- **Offline indicator**: `navigator.onLine` plus last-failure state, since
  `onLine` lies about captive portals.
- **Per-expense badge**: pending / conflict / rejected, driven by `syncState`.
- **Conflict and quarantine screens**: small, but non-negotiable. This is where
  a rejected or collided expense goes to be seen instead of disappearing.

---

## PWA shell

`web/vite.config.ts` is currently plain `react()`. Add `vite-plugin-pwa`, mirroring
DumberTime's config:

```ts
VitePWA({
  registerType: "autoUpdate",
  devOptions: { enabled: true },
  workbox: { globPatterns: ["**/*.{js,css,html,ico,png,svg,json}"] },
  includeAssets: ["favicon.svg", "icons/*"],
  manifest: {
    name: "SplitSmart",
    short_name: "SplitSmart",
    description: "Self-hosted expense splitting",
    display: "standalone",
    start_url: "/",
    theme_color: "#0e1214",       // match index.html's dark theme-color
    background_color: "#f6f9f8",
    icons: [/* 32, 64, 128, 256, 512 png, generated from Logo.tsx */],
  },
})
```

Two app-specific points:

- **Precache the shell only. Never cache `/api` responses in the service
  worker.** The local database is the offline read path; a second, dumber cache
  in front of the API is how you end up showing a stale balance that nothing in
  the app can explain or invalidate.
- Icons are generated from `web/src/Logo.tsx`, which is already duplicated
  literally into `public/favicon.svg`. Add the PNG set next to it.

---

## Phasing

Each phase ships on its own and is useful alone.

### Phase 0: Foundations
Migration (`client_uuid`, `version`, `sync_log`), hand-updated `db/types.ts`,
`sync_log` writes inside the existing expense/group transactions, pure balance
core extracted from `src/domain/balances.ts`. No client changes. `yarn db:check`
must still pass.

### Phase 1: PWA shell
`vite-plugin-pwa`, manifest, icon set. Installable, survives a reload with no
network. No sync yet. Small and independently shippable.

### Phase 2: Local read mirror
Dexie schema, `/sync/bootstrap`, reference-data cache, pages converted to
`useLiveQuery`, local balance computation. **The app becomes fully usable
offline, read-only.** The largest UX win in the plan and it carries no write
risk; worth landing before Phase 4 regardless of schedule.

### Phase 3: Incremental pull
`/sync/pull`, audience query, seq cursor, paginated apply in one transaction.
Indexing and a volume test belong here.

### Phase 4: Offline writes
Outbox, `/sync/push` routed through the existing domain writers, the four-status
result contract, conflict detection via `version`, quarantine UI.
**This is where the risk in the project lives.** It deserves its own end-to-end
test suite.

### Phase 5: Status and polish
Unsynced count, last-synced time, per-expense badges, conflict resolution
screen, online-only affordances disabled with an explanation.

Rough shape: phases 0–3 are a few days each; phase 4 is where the week goes.
Call it two focused weeks, with phase 4 holding nearly all of the uncertainty.

---

## Testing

Follow the pattern already in `src/routes/native/import.test.ts`; it drives the
real client, the real routes, and the real expense writer end to end, with
`DATABASE_PATH` set before any import that reaches `src/db/index.ts`. Sync
deserves the same treatment. Specifically:

- **Push idempotency**: same batch twice yields one expense and a `duplicate`.
- **Conflict**: two clients, same base version, second gets `conflict` and the
  server row, and no balance moves.
- **Rejection**: unknown currency, departed member, shares that do not sum;
  each returns a reason and writes nothing.
- **Audience**: a group member sees a group expense; a non-member does not; a
  new member's pull backfills history.
- **Cursor**: pull is complete and non-duplicating across a page boundary, and
  many rows sharing one `server_ts` cannot stall it.
- **The invariant**: `yarn db:check` clean after every replay test.

Keep the outbox reducer and the conflict policy **pure**, so they are testable
under `node:test` without a browser. That is the same reasoning that keeps
`split.ts` free of I/O.

---

## Deliberately not doing

- **CRDTs or vector clocks.** The conflict surface is narrow (a `client_uuid`
  create cannot conflict) and a version check plus a visible prompt covers it.
- **Real-time sync.** This is a backup-and-catch-up system, like DumberTime's.
  No websockets, no push.
- **Offline friend or group creation.** See the table above.
- **Caching `/api` in the service worker.** Two sources of truth for reads.
- **Mirroring `expense_repayments`.** It is a cache; mirror the inputs.
- **Client-side writes to the ledger as truth.** The server recomputes on
  replay. Rule 3 does not bend for this feature.
