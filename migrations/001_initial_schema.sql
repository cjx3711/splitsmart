-- 001_initial_schema.sql
--
-- Core data model for SplitSmart.
--
-- DESIGN RULES (read docs/DATA_MODEL.md before changing anything here):
--
-- 1. MONEY IS ALWAYS INTEGER MINOR UNITS. Never REAL, never TEXT. A column
--    holding money is named `*_minor` and is paired with a currency_code so
--    the value can be formatted. You need both: 1000 is 10.00 USD but 1000 JPY.
--
-- 2. CURRENCIES ARE NEVER CONVERTED. Balances are kept as parallel per-currency
--    ledgers, which is why the API returns `balance` as an array. There is no
--    exchange-rate table and there should not be one.
--
-- 3. THE EXPENSE INVARIANT: for every non-deleted expense,
--       SUM(expense_users.paid_share_minor) = expenses.cost_minor
--       SUM(expense_users.owed_share_minor) = expenses.cost_minor
--    SQLite cannot express this as a CHECK constraint (it spans rows), so it is
--    enforced in the application layer inside a transaction, and audited by
--    `npm run db:check`. Any code path writing expense_users MUST go through
--    src/domain/expenses.ts.
--
-- 4. ENTITY IDS ARE ULIDS, INCLUDING ON THE COMPAT WIRE. There is no parallel
--    integer `compat_id`. After a Splitwise import the original integer lives
--    only in `metadata.splitwise_id` (JSON), used for re-import matching, and
--    is never returned as `id`. Category ids stay Splitwise's integers.
--    See docs/SPLITWISE_COMPAT.md and docs/ULIDS.md.
--
-- This app has never been deployed, so there is exactly one migration: schema
-- changes during development are folded back into this file rather than
-- layered as forward-only steps. Once a real database exists somewhere, that
-- stops being true. See src/db/migrate.ts for the forward-only runner this
-- file is written to run under from that point on.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- currencies
-- ---------------------------------------------------------------------------
-- decimal_places is load-bearing: it is the ONLY way to turn a minor-unit
-- integer back into a display string. JPY/KRW are 0, most are 2, KWD/BHD are 3.
-- Getting this wrong silently multiplies people's money by 100.
--
-- The upper bound is 8 rather than 4 because Splitwise's live currency list
-- includes BTC, which uses satoshi (1e-8) precision. Since currency_code is a
-- foreign key, a currency we cannot represent does not degrade gracefully; it
-- rejects the expense outright. 8 digits stays well inside MAX_SAFE_INTEGER.
CREATE TABLE currencies (
  code           TEXT    PRIMARY KEY,          -- ISO 4217, uppercase
  decimal_places INTEGER NOT NULL DEFAULT 2,
  symbol         TEXT,
  name           TEXT,
  CHECK (code = UPPER(code)),
  CHECK (LENGTH(code) = 3),
  CHECK (decimal_places BETWEEN 0 AND 8)
) STRICT;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- Two kinds of user share this table:
--
--   Real users  (is_ghost = 0): have email + password_hash, can log in normally.
--   Ghost users (is_ghost = 1): PLACEHOLDER PEOPLE, created by whoever added
--                               them. No login email, no password, and no
--                               credential of their own. A guest reaches a
--                               ghost's data by holding an access_links secret
--                               that says it may act as them. See docs/GUEST.md.
--                               The address they were invited at lives in
--                               invite_email, never in email: occupying the
--                               unique login index would let anyone squat an
--                               inbox by adding a friend.
--
-- A ghost is never upgraded in place. The one path is: create a real account,
-- then claim the ghost, which MERGES it (src/domain/merge.ts) and retires the
-- row below.
CREATE TABLE users (
  id                 TEXT    PRIMARY KEY,      -- ULID; see src/domain/ulid.ts
  -- JSON object. splitwise_id (import matching), notes, and other unindexed
  -- leftovers. See src/domain/metadata.ts. Default '{}' so inserts can omit it.
  metadata           TEXT    NOT NULL DEFAULT '{}',

  -- Login address. Unique. Ghosts must leave this NULL (CHECK below) so
  -- inviting someone cannot block them from registering.
  email              TEXT UNIQUE COLLATE NOCASE,
  -- Address this ghost was invited at. Not a login. Not globally unique:
  -- two owners may invite the same inbox, and that inbox may still sign up.
  -- Unique among one owner's live friend-ghosts (enforced at friend-add,
  -- audited by yarn db:check).
  invite_email       TEXT COLLATE NOCASE,
  password_hash      TEXT,                     -- see src/auth/password.ts for format
  email_verified_at  TEXT,

  -- One name, not first/last. Nickname is an optional shorter form used in
  -- lists when set. Icon fields are appearance only; balances never read them.
  name               TEXT NOT NULL,
  nickname           TEXT,
  icon_letters       TEXT,
  icon_emoji         TEXT,
  icon_hue           INTEGER,
  avatar_url         TEXT,

  default_currency   TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),

  is_ghost           INTEGER NOT NULL DEFAULT 0,

  -- Set when this row was consumed by a claim (src/domain/merge.ts). Every FK
  -- that pointed here has been rewritten onto the survivor; this column exists
  -- so a pointer we MISSED shows up as a stub rather than as a living person
  -- with a mysteriously empty history. Only ever a tombstone, never a
  -- participant: the CHECK below refuses one that is not also soft-deleted.
  merged_into_user_id TEXT REFERENCES users(id),

  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT,

  CHECK (is_ghost IN (0, 1)),
  CHECK (LENGTH(id) = 26),
  CHECK (json_valid(metadata)),
  CHECK (json_type(metadata) = 'object'),
  CHECK (icon_hue IS NULL OR (icon_hue >= 0 AND icon_hue <= 359)),
  -- A real (non-ghost) account must be able to authenticate.
  CHECK (is_ghost = 1 OR (email IS NOT NULL AND password_hash IS NOT NULL)),
  -- A ghost must not occupy the login unique index, or carry a password.
  CHECK (is_ghost = 0 OR (email IS NULL AND password_hash IS NULL)),
  -- invite_email is the invite-only address; real accounts do not have one.
  CHECK (is_ghost = 1 OR invite_email IS NULL),
  -- A merged row is retired, not alive.
  CHECK (merged_into_user_id IS NULL OR deleted_at IS NOT NULL),
  CHECK (merged_into_user_id IS NULL OR merged_into_user_id <> id)
) STRICT;

CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_invite_email ON users(invite_email) WHERE invite_email IS NOT NULL;
-- Live rows only: a claimed ghost must not keep the Splitwise id slot, so the
-- survivor (or a later import) can hold it.
CREATE UNIQUE INDEX idx_users_splitwise_id
  ON users(json_extract(metadata, '$.splitwise_id'))
  WHERE json_extract(metadata, '$.splitwise_id') IS NOT NULL
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- sessions: browser cookie sessions
-- ---------------------------------------------------------------------------
-- We store a HASH of the session token, not the token. A leaked database should
-- not hand out live sessions.
CREATE TABLE sessions (
  id             TEXT    PRIMARY KEY,          -- ULID, safe to log
  token_hash     TEXT    NOT NULL UNIQUE,      -- sha256 of the cookie value
  user_id        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT    NOT NULL,

  CHECK (LENGTH(id) = 26)
) STRICT;

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- api_tokens: bearer tokens for the Splitwise-compatible API
-- ---------------------------------------------------------------------------
-- Deliberately separate from sessions: different lifetime, different revocation
-- story, and different threat model. splitwise-to-toshl uses one of these.
-- Only the hash is stored; the plaintext is shown once at creation.
CREATE TABLE api_tokens (
  id           TEXT    PRIMARY KEY,            -- ULID
  token_hash   TEXT    NOT NULL UNIQUE,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,               -- e.g. "splitwise-to-toshl"
  last_used_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT,                           -- NULL = never expires
  revoked_at   TEXT,

  CHECK (LENGTH(id) = 26)
) STRICT;

CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);

-- ---------------------------------------------------------------------------
-- email_tokens: single-use, expiring tokens sent by email
-- ---------------------------------------------------------------------------
-- `purpose` exists so password reset (docs/PLAN.md phase 4) can reuse this
-- table rather than needing a schema change. Only 'verify_email' is
-- implemented today; the CHECK constraint already permits 'reset_password'.
--
-- As everywhere else in this codebase, only the token HASH is stored. A leaked
-- database must not hand out working verification links.
CREATE TABLE email_tokens (
  id         TEXT    PRIMARY KEY,              -- ULID
  token_hash TEXT    NOT NULL UNIQUE,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT    NOT NULL,

  -- SNAPSHOT of the address this token was issued for.
  --
  -- Load-bearing: if a user requests verification, then changes their email,
  -- the outstanding token must NOT verify the new address. Consuming a token
  -- compares this against users.email and refuses on mismatch. Without it,
  -- someone could verify an address they no longer control; or worse, have a
  -- pending token silently validate an attacker-supplied address.
  email      TEXT    NOT NULL,

  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  used_at    TEXT,

  CHECK (purpose IN ('verify_email', 'reset_password')),
  CHECK (LENGTH(id) = 26)
) STRICT;

CREATE INDEX idx_email_tokens_user_purpose ON email_tokens(user_id, purpose);
CREATE INDEX idx_email_tokens_expires_at ON email_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- groups
-- ---------------------------------------------------------------------------
-- There is no invite_token here any more. Sharing a group is a row in
-- access_links (kind = 'group'), which can be revoked, expired, and sits
-- alongside per-member links rather than being the only door. Opening a link
-- also no longer creates a member: the owner adds people, guests pick among
-- the names the owner created. See docs/GUEST.md.
CREATE TABLE groups (
  id                TEXT    PRIMARY KEY,       -- ULID
  metadata          TEXT    NOT NULL DEFAULT '{}',

  name              TEXT    NOT NULL,
  group_type        TEXT    NOT NULL DEFAULT 'other',
  default_currency  TEXT    NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
  avatar_url        TEXT,

  -- Whether to collapse the debt graph when displaying balances.
  simplify_by_default INTEGER NOT NULL DEFAULT 0,

  created_by        TEXT    REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT,

  CHECK (group_type IN ('trip', 'outing', 'home', 'couple', 'family', 'work', 'school', 'sports', 'event', 'project', 'other')),
  CHECK (simplify_by_default IN (0, 1)),
  CHECK (LENGTH(id) = 26),
  CHECK (json_valid(metadata)),
  CHECK (json_type(metadata) = 'object')
) STRICT;

CREATE UNIQUE INDEX idx_groups_splitwise_id
  ON groups(json_extract(metadata, '$.splitwise_id'))
  WHERE json_extract(metadata, '$.splitwise_id') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- group_members
-- ---------------------------------------------------------------------------
CREATE TABLE group_members (
  group_id   TEXT    NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL DEFAULT 'member',
  -- How this person got in. There is no self-service value: opening a guest
  -- link does not create a member, so every row here was put there by someone
  -- with an account. See docs/GUEST.md.
  joined_via TEXT    NOT NULL DEFAULT 'added',
  joined_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  left_at    TEXT,

  PRIMARY KEY (group_id, user_id),
  CHECK (role IN ('owner', 'member')),
  CHECK (joined_via IN ('added', 'import', 'creator'))
) STRICT;

CREATE INDEX idx_group_members_user_id ON group_members(user_id);

-- ---------------------------------------------------------------------------
-- access_links: the guest credential
-- ---------------------------------------------------------------------------
-- THE URL IS THE CREDENTIAL. A guest has no account, no cookie and no session
-- row; they hold a secret that this table describes the scope of, and it is
-- re-checked on every single request. That is what makes revocation immediate.
-- See docs/GUEST.md for the whole model.
--
-- Three kinds, one table:
--
--   group         bound to a group, acts as whichever ghost member the holder
--                 picks (and can re-pick). Sees that group only.
--   group_member  bound to a group AND one ghost. No picker. That group only.
--   friend        bound to one ghost (created_by is the owner who minted it).
--                 Sees the owner<->ghost non-group expenses, plus every group
--                 that ghost belongs to, acting as them.
--
-- token_hash is what guest auth resolves; token_secret is stored so the owner
-- can copy the link again. expires_at is set at mint (default 3 months, capped in
-- application code).
--
-- A link may only ever act as a GHOST. Once someone claims that person the row
-- becomes is_ghost = 0 (in practice merged and soft-deleted), and every link
-- pointing at them stops resolving on the next request. That check lives in
-- src/domain/access-links.ts, not here, because it spans tables.
CREATE TABLE access_links (
  id           TEXT    PRIMARY KEY,            -- ULID
  token_hash   TEXT    NOT NULL UNIQUE,        -- sha256 of the secret
  token_secret TEXT,                           -- plaintext for owner copy; guest auth uses token_hash
  kind         TEXT    NOT NULL,               -- 'group' | 'group_member' | 'friend'
  group_id     TEXT    REFERENCES groups(id),
  user_id      TEXT    REFERENCES users(id),   -- ghost the link acts as; NULL on kind='group'
  created_by   TEXT    NOT NULL REFERENCES users(id),
  expires_at   TEXT,                           -- set at mint; default 3 months in app code
  revoked_at   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,

  CHECK (kind IN ('group', 'group_member', 'friend')),
  CHECK (LENGTH(id) = 26),
  -- group and group_member need a group; friend does not. group_member and
  -- friend name the person they act as; the general group link does not.
  CHECK (
    (kind = 'friend'       AND group_id IS NULL     AND user_id IS NOT NULL)
    OR (kind = 'group'        AND group_id IS NOT NULL AND user_id IS NULL)
    OR (kind = 'group_member' AND group_id IS NOT NULL AND user_id IS NOT NULL)
  )
) STRICT;

-- One LIVE link per slot, so "the group's link" is a single thing the owner can
-- copy, rotate or revoke. Rotation is revoke-then-mint, and a revoked row stays
-- for the audit trail, which is why these are partial on revoked_at IS NULL.
-- Expiry is deliberately NOT part of the predicate: `datetime('now')` is not
-- deterministic and SQLite refuses it in an index.
CREATE UNIQUE INDEX idx_access_links_live_group
  ON access_links(group_id) WHERE kind = 'group' AND revoked_at IS NULL;
CREATE UNIQUE INDEX idx_access_links_live_member
  ON access_links(group_id, user_id) WHERE kind = 'group_member' AND revoked_at IS NULL;
CREATE UNIQUE INDEX idx_access_links_live_friend
  ON access_links(created_by, user_id) WHERE kind = 'friend' AND revoked_at IS NULL;

CREATE INDEX idx_access_links_group_id ON access_links(group_id);
CREATE INDEX idx_access_links_user_id ON access_links(user_id);

-- ---------------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------------
-- Stored canonically with user_a_id < user_b_id so a pair can only exist once.
-- Query helper lives in src/domain/friends.ts; do not hand-roll the UNION.
CREATE TABLE friendships (
  user_a_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (user_a_id, user_b_id),
  CHECK (user_a_id < user_b_id)
) STRICT;

CREATE INDEX idx_friendships_user_b_id ON friendships(user_b_id);

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
-- Two levels, mirroring Splitwise: parents are display-only groupings and only
-- leaf categories are assignable to an expense. The compat layer nests these
-- back into parent/subcategories on the way out.
CREATE TABLE categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  splitwise_id INTEGER UNIQUE,
  parent_id    INTEGER REFERENCES categories(id),
  name         TEXT    NOT NULL,
  icon         TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  -- Exactly one category should carry is_default=1; used when nothing matches.
  is_default   INTEGER NOT NULL DEFAULT 0,

  CHECK (is_default IN (0, 1))
) STRICT;

CREATE INDEX idx_categories_parent_id ON categories(parent_id);

-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
-- A settle-up payment is an expense with is_payment = 1. That is how Splitwise
-- models it too, and it keeps balance math uniform: a payment is just an expense
-- where one person paid and the other owes the whole thing.
--
-- group_id NULL = a one-on-one expense not attached to any group.
CREATE TABLE expenses (
  id             TEXT    PRIMARY KEY,          -- ULID; clients may mint this
  metadata       TEXT    NOT NULL DEFAULT '{}',

  group_id       TEXT    REFERENCES groups(id),
  description    TEXT    NOT NULL,
  details        TEXT,

  cost_minor     INTEGER NOT NULL,
  currency_code  TEXT    NOT NULL REFERENCES currencies(code),

  -- Date the expense happened (not when it was entered). Stored as ISO-8601 UTC
  -- so it sorts lexically and round-trips through the compat layer unchanged.
  date           TEXT    NOT NULL,

  category_id    INTEGER REFERENCES categories(id),

  -- How the shares were derived. The authoritative numbers are always the
  -- per-user rows in expense_users; this field plus expense_users.split_input
  -- exist so the UI can reopen an expense in the same editor the user used.
  split_type     TEXT    NOT NULL DEFAULT 'equal',

  -- JSON, or NULL. Presentation detail for the editor; never ledger data.
  -- Only 'itemized' populates it: a line-item bill where each line is shared by
  -- a different subset of participants doesn't fit the one-row-per-participant
  -- shape of expense_users, so the lines are kept here purely so the editor can
  -- reopen them. They are never summed, joined, or filtered on by the server -
  -- read back verbatim by exactly one consumer, the expense editor. The ledger
  -- numbers are still the derived shares in expense_users; if split_meta were
  -- dropped entirely, every balance in the app would be unchanged. Deliberately
  -- untyped so a future split type doesn't need a schema change.
  --
  -- Shape, for split_type = 'itemized':
  --   {"items":[{"label":"Ramen","amountMinor":1200,"participantIds":["01ARZ3NDEKTSV4RRFFQ69G5FAV"]}]}
  split_meta     TEXT,

  is_payment     INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,

  -- --- recurrence ----------------------------------------------------------
  -- A recurring series is one TEMPLATE row plus ordinary expenses generated
  -- from it. There is no expense_bundle_id: the template's id, carried by each
  -- occurrence in `repeat_of`, IS the bundle.
  --
  --   template:    repeat_interval NOT NULL, next_repeat NOT NULL, repeat_of NULL
  --   occurrence:  repeat_interval NULL,     next_repeat NULL,     repeat_of set
  --   ordinary:    all three NULL
  --
  -- next_repeat is when the scheduler (src/domain/recurring.ts) should fire.
  -- It advances by exactly ONE interval per tick, so a series that fell behind
  -- during downtime catches up one bill at a time, with each occurrence dated
  -- the day it was due, instead of appearing as a stack dated today.
  repeat_interval TEXT,
  next_repeat     TEXT,
  repeat_of       TEXT    REFERENCES expenses(id),

  -- --- optimistic concurrency ----------------------------------------------
  -- Bumped by every write a HUMAN could also have made: update, delete,
  -- restore, and a merge's share rewrite. NOT bumped by the scheduler moving
  -- `next_repeat`, and NOT bumped by the importer's re-sync stamp; neither is
  -- somebody editing a bill, and a monthly tick must not conflict with a
  -- pending typo fix. See docs/OFFLINE.md, "When `version` bumps".
  --
  -- An offline client stores the version it edited from and sends it back as
  -- `baseVersion`; the writers compare it inside the transaction, so a stale
  -- edit is a conflict rather than an overwrite. The ULID primary key is the
  -- idempotency key for creates, which is why there is no `client_uuid`.
  version        INTEGER NOT NULL DEFAULT 1,

  created_by     TEXT    REFERENCES users(id),
  updated_by     TEXT    REFERENCES users(id),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Soft delete. The compat API must surface this as `deleted_at`, and callers
  -- filter on it, so never hard-delete an expense.
  deleted_at     TEXT,

  CHECK (version >= 1),
  CHECK (cost_minor >= 0),
  CHECK (is_payment IN (0, 1)),
  CHECK (split_type IN ('equal', 'exact', 'percent', 'shares', 'adjustment', 'itemized')),
  CHECK (LENGTH(id) = 26),
  CHECK (json_valid(metadata)),
  CHECK (json_type(metadata) = 'object'),
  -- Cheap guard against a non-JSON string being written here. json_valid() is
  -- built in, so this costs nothing and stops a malformed blob from reaching
  -- the editor as a parse error at read time.
  CHECK (split_meta IS NULL OR json_valid(split_meta)),
  -- Only itemized expenses carry line items. Keeps a stale blob from surviving
  -- an edit that switched the expense to a different split type.
  CHECK (split_meta IS NULL OR split_type = 'itemized'),
  CHECK (repeat_interval IS NULL
         OR repeat_interval IN ('weekly', 'fortnightly', 'monthly', 'yearly')),
  -- A template is always scheduled. Without this a repeat_interval could be set
  -- with nothing to fire on, which is a series that silently never runs.
  CHECK ((repeat_interval IS NULL AND next_repeat IS NULL)
         OR (repeat_interval IS NOT NULL AND next_repeat IS NOT NULL)),
  -- An occurrence is not itself a template: series are one level deep, so
  -- "which bills belong to this series" is one WHERE clause forever.
  CHECK (repeat_of IS NULL OR repeat_interval IS NULL),
  CHECK (repeat_of IS NULL OR repeat_of <> id)
) STRICT;

CREATE INDEX idx_expenses_group_id ON expenses(group_id);
CREATE INDEX idx_expenses_date ON expenses(date);
CREATE INDEX idx_expenses_repeat_of ON expenses(repeat_of) WHERE repeat_of IS NOT NULL;
-- The scheduler's only query: live templates that are due. Partial on columns
-- (never on datetime('now'), which SQLite refuses in an index predicate).
CREATE INDEX idx_expenses_due_repeats ON expenses(next_repeat)
  WHERE repeat_interval IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_expenses_splitwise_id
  ON expenses(json_extract(metadata, '$.splitwise_id'))
  WHERE json_extract(metadata, '$.splitwise_id') IS NOT NULL;
CREATE INDEX idx_expenses_live ON expenses(date) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- expense_users: who paid, and who owes
-- ---------------------------------------------------------------------------
-- The heart of the model. Two independent numbers per participant:
--   paid_share_minor: how much cash this person actually put in
--   owed_share_minor: how much of the cost is their responsibility
-- Their difference is that person's net position on this expense.
--
-- split_input stores the raw value the user typed for the expense's split_type
-- (percent, share count, exact amount, or adjustment) purely so the editor can
-- be reopened. It is NEVER used to compute balances.
CREATE TABLE expense_users (
  expense_id       TEXT    NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id          TEXT    NOT NULL REFERENCES users(id),

  paid_share_minor INTEGER NOT NULL DEFAULT 0,
  owed_share_minor INTEGER NOT NULL DEFAULT 0,

  split_input      REAL,

  PRIMARY KEY (expense_id, user_id),
  CHECK (paid_share_minor >= 0),
  CHECK (owed_share_minor >= 0)
) STRICT;

CREATE INDEX idx_expense_users_user_id ON expense_users(user_id);

-- ---------------------------------------------------------------------------
-- expense_repayments: derived pairwise debts
-- ---------------------------------------------------------------------------
-- Denormalised on purpose. expense_users tells you each person's NET position
-- but not who owes whom, which is what every balance screen actually needs.
-- Rather than recompute the creditor/debtor matching on every read, we compute
-- it once at write time and store it, which turns balance queries into a plain
-- SUM ... GROUP BY.
--
-- Rebuilt from scratch by src/domain/expenses.ts on every expense write, and
-- verifiable at any time with `npm run db:check`. Treat as a cache: never write
-- here directly, and never let it be the source of truth.
CREATE TABLE expense_repayments (
  expense_id   TEXT    NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,               -- stable ordering within expense
  from_user_id TEXT    NOT NULL REFERENCES users(id),  -- debtor
  to_user_id   TEXT    NOT NULL REFERENCES users(id),  -- creditor
  amount_minor INTEGER NOT NULL,

  PRIMARY KEY (expense_id, seq),
  CHECK (amount_minor > 0),
  CHECK (from_user_id <> to_user_id)
) STRICT;

CREATE INDEX idx_repayments_from_user ON expense_repayments(from_user_id);
CREATE INDEX idx_repayments_to_user ON expense_repayments(to_user_id);

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------
-- Two kinds of row, both called comments, exactly as Splitwise has them:
--
--   user    somebody typed it.
--   system  generated by an edit, a delete or a restore, and hung on the bill
--           so "why is this 8.99 now" is answerable from the expense itself.
--           The activity feed is the global version of the same events.
--
-- `kind` is a column rather than a metadata key because listing a thread has to
-- distinguish the two, and a WHERE on json_extract is not free.
--
-- There is no `version` and no edit path: a create cannot conflict, and
-- commenting must never bump `expenses.version` (docs/OFFLINE.md) or an offline
-- note would fight an offline edit of the split. Deletes are soft, so merge and
-- re-import matching still see the row.
--
-- All writes go through src/domain/comments.ts.
CREATE TABLE comments (
  id           TEXT    PRIMARY KEY,            -- ULID; clients may mint this
  metadata     TEXT    NOT NULL DEFAULT '{}',
  expense_id   TEXT    NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL REFERENCES users(id),
  kind         TEXT    NOT NULL DEFAULT 'user',
  content      TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT,

  CHECK (LENGTH(id) = 26),
  CHECK (kind IN ('user', 'system')),
  CHECK (json_valid(metadata)),
  CHECK (json_type(metadata) = 'object')
) STRICT;

CREATE INDEX idx_comments_expense_id ON comments(expense_id);
-- The thread query and the per-row count on expense lists.
CREATE INDEX idx_comments_live ON comments(expense_id, created_at)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_comments_splitwise_id
  ON comments(json_extract(metadata, '$.splitwise_id'))
  WHERE json_extract(metadata, '$.splitwise_id') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- activity (the feed)
-- ---------------------------------------------------------------------------
-- Append-only. `payload` is JSON with a shape determined by `action`.
CREATE TABLE activity (
  id         TEXT    PRIMARY KEY,              -- ULID; not exposed on the compat wire
  user_id    TEXT    REFERENCES users(id),     -- actor
  group_id   TEXT    REFERENCES groups(id),
  expense_id TEXT    REFERENCES expenses(id),
  action     TEXT    NOT NULL,
  payload    TEXT,                             -- JSON
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),

  CHECK (LENGTH(id) = 26)
) STRICT;

CREATE INDEX idx_activity_group_id ON activity(group_id, created_at DESC);
CREATE INDEX idx_activity_user_id ON activity(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- sync_log: the change log offline clients pull from
-- ---------------------------------------------------------------------------
-- Append-only. One row per accepted write, inserted in the SAME transaction as
-- the write it describes: a committed change without a log row is a change no
-- other device will ever learn about. Never updated, never deleted.
--
-- `seq` is the ONLY sync cursor. An integer, not a timestamp and not a ULID,
-- because a cursor has to be totally ordered by the thing that assigned it:
-- `datetime('now')` has second resolution and two writes in one second would
-- make "everything after :since" either skip a row or repeat one forever.
--
-- This is NOT the activity feed. `activity` is a human-readable story with its
-- own visibility and suppression rules (the importer writes one summary entry
-- for a thousand expenses); this is a replication log and every write is in it.
--
-- WHO MAY READ A ROW IS DECIDED AT READ TIME, not fanned out at write time.
-- There is no per-recipient copy: `/api/v1/sync/pull` joins the caller's
-- current ACL against this table (see src/routes/native/sync.ts). Fan-out
-- would mean N rows per write and a rewrite of history whenever somebody
-- joined a group. The exceptions are the two columns below, which exist
-- precisely because read-time resolution cannot answer their question:
--
--   audience_user_id  "this row is for you and only you". A `forget` (you were
--                     removed from an expense, so you no longer match the
--                     participant subquery that would have shown it to you)
--                     and the fan-out of a merge.
--   other_user_id     the second half of a pair: a friendship's `user_b_id`,
--                     or a merge's survivor.
--
-- Composite keys have no surrogate ULID, so they are encoded:
--
--   expense / comment / group / user   that row's own ULID
--   group_member                       member's user ULID, plus group_id
--   friendship                         user_a_id, other_user_id = user_b_id
--   user_merge                         the ghost, other_user_id = survivor
--
-- A `comment` row copies `group_id` from its parent expense so the pull query
-- does not have to join a parent that may itself be deleted. The payload the
-- endpoint builds still carries `expense_id`.
CREATE TABLE sync_log (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  entity             TEXT    NOT NULL,
  -- ULID of the entity, or the subject user for group_member / friendship /
  -- user_merge (the ghost being consumed).
  entity_id          TEXT    NOT NULL,
  -- Friendship: user_b_id. user_merge: the survivor. NULL otherwise.
  other_user_id      TEXT    REFERENCES users(id),
  op                 TEXT    NOT NULL,
  group_id           TEXT    REFERENCES groups(id),
  actor_user_id      TEXT    REFERENCES users(id),
  -- Extra viewer: forget rows, and the fan-out of user_merge.
  audience_user_id   TEXT    REFERENCES users(id),
  server_ts          TEXT    NOT NULL DEFAULT (datetime('now')),

  -- 'delete' is a ledger tombstone (the row still exists, deleted_at is set);
  -- 'forget' means drop THIS caller's replica of a row they can no longer see;
  -- 'merge' is a claim (ghost -> survivor); 'upsert' is everything else,
  -- including a restore (the row is live again) and a scheduler tick moving a
  -- template's next_repeat.
  CHECK (op IN ('upsert', 'delete', 'forget', 'merge')),
  -- SQLite cannot ALTER a CHECK, and changing one means rebuilding the table
  -- with foreign_keys OFF. Every entity this log will ever carry is listed
  -- from day one for that reason, including the two that are not written by a
  -- client at all: 'comment' and 'user_merge'.
  CHECK (entity IN (
    'expense','comment','group','group_member','friendship','user','user_merge'
  )),
  CHECK (LENGTH(entity_id) = 26)
) STRICT;

-- The three shapes the pull query actually runs. The audience index is not
-- optional: `audience_user_id = :me` is the branch that delivers a forget, and
-- without it that branch is a full scan of the log on every sync.
CREATE INDEX idx_sync_log_group ON sync_log(group_id, seq);
CREATE INDEX idx_sync_log_entity ON sync_log(entity, entity_id);
CREATE INDEX idx_sync_log_audience ON sync_log(audience_user_id, seq);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_users_updated_at AFTER UPDATE ON users
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_groups_updated_at AFTER UPDATE ON groups
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE groups SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER trg_expenses_updated_at AFTER UPDATE ON expenses
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE expenses SET updated_at = datetime('now') WHERE id = NEW.id; END;
