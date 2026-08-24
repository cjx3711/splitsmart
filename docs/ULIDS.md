# ULID primary keys

Implemented. Landed before offline-first (`docs/OFFLINE.md`) and before any
deployed database. Schema changes folded into `migrations/001_initial_schema.sql`;
local copies are wiped with `yarn db:reset`. There is no compatibility window
and no backfill of live integer ids.

Offline create will mint the same id the server stores. That only works because
the primary key is something a client can generate.

## Why

Integer `AUTOINCREMENT` PKs leak how many rows exist, are guessable, and cannot
be minted offline without a later reconciliation step. ULIDs are 128-bit, 26
characters of Crockford base32, time-sortable, and safe to generate on the
client with `crypto.getRandomValues`. They are **not sequential**, which is the
point; they are only ordered by time.

Native API ids are strings. There is no parallel integer `compat_id`.

## What is a ULID

Every **entity** primary key, and every foreign key that points at one:

| Table | PK |
|---|---|
| `users` | ULID |
| `groups` | ULID |
| `expenses` | ULID |
| `comments` | ULID |
| `activity` | ULID |
| `sessions`, `api_tokens`, `email_tokens`, `emails` | ULID (same helper) |

FKs follow: `sessions.user_id`, `group_members.*`, `friendships.*`,
`expense_users.*`, `expense_repayments.from_user_id` / `to_user_id`,
`expenses.group_id` / `created_by` / `updated_by`, `activity.*`, and so on.
All `TEXT`, all `STRICT`, with `CHECK (LENGTH(id) = 26)` on entity PKs.

Junction tables keep composite primary keys. `group_members (group_id, user_id)`,
`friendships (user_a_id, user_b_id)`, `expense_users (expense_id, user_id)` do
not get a surrogate ULID; their FKs just change type. `friendships` orders the
pair with `CHECK (user_a_id < user_b_id)` - lexicographic `<` on Crockford
strings is a total order, so the CHECK stays. `friendPair()` in
`src/domain/friends.ts` compares the strings the same way SQLite will.

## What stays integer

These are not entity ids.

| Column | Why |
|---|---|
| `categories.id` | Splitwise's real ids (1–50), captured in `fixtures/splitwise/get_categories.json`, plus native extras at ≥ 51. Renumbering a Splitwise id breaks import and every client that already stores `13` for Dining out. Seed continues to insert explicit integers. |
| `categories.splitwise_id` | Same number, kept for the importer. |
| `expense_repayments.seq` | Stable order inside one expense, not an identity. |
| `*_minor`, `decimal_places`, flags | Money and booleans. |
| `sync_log.seq` (when offline lands) | Monotonic pull cursor. Must be `INTEGER PRIMARY KEY AUTOINCREMENT`. |

`expenses.category_id` stays `INTEGER REFERENCES categories(id)`.

## Metadata and Splitwise ids

`users`, `groups`, `expenses`, and `comments` carry a JSON `metadata` column
(default `'{}'`). It is a bag for data that is stored, not queried:

- `splitwise_id` - original Splitwise integer, set on import so a second run
  matches instead of duplicating. Never the native PK.
- `notes` - freeform user notes.
- Extra keys are allowed.

The one exception to "not queried" is a unique expression index on
`json_extract(metadata, '$.splitwise_id')`, because re-import matching needs it.
Helpers live in `src/domain/metadata.ts`.

Import mints a fresh ULID for every new row. The original integer is **not**
reused as `id`.

## Client-minted expense ids

`createExpense` accepts an optional `id`. If present it must be a valid ULID
and is used as the PK; if absent the server mints one. Today's web UI takes
the absent path until offline writes land.

A retry with the same id hits the PK and is a no-op that returns the existing
row. That is the idempotency story offline-first needs - there is no separate
`client_uuid` column.

Users and groups stay server-minted: creating either is online-only
(`docs/OFFLINE.md`).

Import is the exception that pins the timestamp: a new user, group, or
expense is minted with Splitwise `created_at` when present, otherwise the
expense `date`, and that same instant is written to the `created_at` column
so the ULID and the row agree. Native creates still use wall-clock time.

## Helper

One pure module, `src/domain/ulid.ts`, imported by the server and by `web/`
the same way `split.ts` already is. No extra npm dependency.

- `ulid()` - timestamp + 80 bits of `crypto.getRandomValues`
- `ulidTime(id)` - milliseconds encoded in the first 10 characters
- `isUlid(s)` - 26 chars, Crockford alphabet, no `I`, `L`, `O`, `U`
- Zod: `z.string().refine(isUlid)` at native route boundaries (`ulidSchema`)

Native path params (`/groups/:id`, `/expenses/:id`, `/friends/:id`) parse as
ULID strings, not `Number(...)`. Invalid ids are 400, not a silent `NaN`.

## `split.ts` ordering

`splitEvenly` sorts participants by `userId` so leftover cents are stable.
String `<` on ULIDs is deterministic. Do not switch to numeric coerce, and do
not `localeCompare` with a locale that could reorder.

## Types

`src/db/types.ts` is hand-updated (`id: string`, FKs `string`). Do not run
`yarn db:codegen` as the only step; it still renames every interface.

Test fixtures mint with `ulid()`. Compat tests assert string ULIDs on entity
ids; category ids stay numbers.

## Out of scope

- Migrating a deployed database. There isn't one. If this needs to happen
  after a deploy, write a real forward migration; do not fold into `001`.
- Changing category ids.
- Offline-first itself. That assumes this is done (`docs/OFFLINE.md`).
