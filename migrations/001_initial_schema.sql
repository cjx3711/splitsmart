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
-- 4. SPLITWISE ID PRESERVATION. Tables exposed through the Splitwise-compatible
--    API carry a nullable `splitwise_id`. The importer inserts rows with
--    `id = splitwise_id` so external references stay valid forever.
--    See docs/SPLITWISE_COMPAT.md.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- currencies
-- ---------------------------------------------------------------------------
-- decimal_places is load-bearing: it is the ONLY way to turn a minor-unit
-- integer back into a display string. JPY/KRW are 0, most are 2, KWD/BHD are 3.
-- Getting this wrong silently multiplies people's money by 100.
CREATE TABLE currencies (
  code           TEXT    PRIMARY KEY,          -- ISO 4217, uppercase
  decimal_places INTEGER NOT NULL DEFAULT 2,
  symbol         TEXT,
  name           TEXT,
  CHECK (code = UPPER(code)),
  CHECK (LENGTH(code) = 3),
  CHECK (decimal_places BETWEEN 0 AND 4)
) STRICT;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- Two kinds of user share this table:
--
--   Real users  (is_ghost = 0): have email + password_hash, can log in normally.
--   Ghost users (is_ghost = 1): created by opening a group invite link. No email,
--                               no password. Identity is possession of a session
--                               token, with recovery_code_hash as the only way
--                               back in from another device.
--
-- A ghost can later be upgraded in place by setting email + password_hash and
-- flipping is_ghost to 0. Upgrading in place (rather than creating a new row and
-- merging) is deliberate: expense history stays attached and balances never move.
CREATE TABLE users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  splitwise_id       INTEGER UNIQUE,

  email              TEXT UNIQUE COLLATE NOCASE,
  password_hash      TEXT,                     -- see src/auth/password.ts for format
  email_verified_at  TEXT,

  first_name         TEXT NOT NULL,
  last_name          TEXT,
  avatar_url         TEXT,

  default_currency   TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),

  is_ghost           INTEGER NOT NULL DEFAULT 0,
  recovery_code_hash TEXT,                     -- ghosts only; same format as password_hash

  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT,

  CHECK (is_ghost IN (0, 1)),
  -- A real (non-ghost) account must be able to authenticate.
  CHECK (is_ghost = 1 OR (email IS NOT NULL AND password_hash IS NOT NULL)),
  -- A ghost must not carry credentials it cannot use.
  CHECK (is_ghost = 0 OR password_hash IS NULL)
) STRICT;

CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_splitwise_id ON users(splitwise_id) WHERE splitwise_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sessions — browser cookie sessions
-- ---------------------------------------------------------------------------
-- We store a HASH of the session token, not the token. A leaked database should
-- not hand out live sessions.
CREATE TABLE sessions (
  id             TEXT    PRIMARY KEY,          -- random id, safe to log
  token_hash     TEXT    NOT NULL UNIQUE,      -- sha256 of the cookie value
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- api_tokens — bearer tokens for the Splitwise-compatible API
-- ---------------------------------------------------------------------------
-- Deliberately separate from sessions: different lifetime, different revocation
-- story, and different threat model. splitwise-to-toshl uses one of these.
-- Only the hash is stored; the plaintext is shown once at creation.
CREATE TABLE api_tokens (
  id           TEXT    PRIMARY KEY,
  token_hash   TEXT    NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,               -- e.g. "splitwise-to-toshl"
  last_used_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT,                           -- NULL = never expires
  revoked_at   TEXT
) STRICT;

CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);

-- ---------------------------------------------------------------------------
-- groups
-- ---------------------------------------------------------------------------
-- invite_token is the shareable secret from the product spec: anyone holding it
-- can join the group and self-create a ghost account. It is rotatable, and
-- rotating it does not affect anyone who already joined.
CREATE TABLE groups (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  splitwise_id      INTEGER UNIQUE,

  name              TEXT    NOT NULL,
  group_type        TEXT    NOT NULL DEFAULT 'other',
  default_currency  TEXT    NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
  avatar_url        TEXT,

  -- Whether to collapse the debt graph when displaying balances.
  simplify_by_default INTEGER NOT NULL DEFAULT 0,

  invite_token      TEXT    UNIQUE,            -- NULL disables joining entirely
  invite_rotated_at TEXT,

  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT,

  CHECK (group_type IN ('home', 'trip', 'couple', 'event', 'project', 'other')),
  CHECK (simplify_by_default IN (0, 1))
) STRICT;

CREATE INDEX idx_groups_invite_token ON groups(invite_token) WHERE invite_token IS NOT NULL;

-- ---------------------------------------------------------------------------
-- group_members
-- ---------------------------------------------------------------------------
CREATE TABLE group_members (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL DEFAULT 'member',
  -- How this person got in. 'invite_link' means they self-created a ghost.
  joined_via TEXT    NOT NULL DEFAULT 'added',
  joined_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  left_at    TEXT,

  PRIMARY KEY (group_id, user_id),
  CHECK (role IN ('owner', 'member')),
  CHECK (joined_via IN ('added', 'invite_link', 'import', 'creator'))
) STRICT;

CREATE INDEX idx_group_members_user_id ON group_members(user_id);

-- ---------------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------------
-- Stored canonically with user_a_id < user_b_id so a pair can only exist once.
-- Query helper lives in src/domain/friends.ts — do not hand-roll the UNION.
CREATE TABLE friendships (
  user_a_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  splitwise_id   INTEGER UNIQUE,

  group_id       INTEGER REFERENCES groups(id),
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

  is_payment     INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,

  created_by     INTEGER REFERENCES users(id),
  updated_by     INTEGER REFERENCES users(id),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Soft delete. The compat API must surface this as `deleted_at`, and callers
  -- filter on it, so never hard-delete an expense.
  deleted_at     TEXT,

  CHECK (cost_minor >= 0),
  CHECK (is_payment IN (0, 1)),
  CHECK (split_type IN ('equal', 'exact', 'percent', 'shares', 'adjustment'))
) STRICT;

CREATE INDEX idx_expenses_group_id ON expenses(group_id);
CREATE INDEX idx_expenses_date ON expenses(date);
CREATE INDEX idx_expenses_splitwise_id ON expenses(splitwise_id) WHERE splitwise_id IS NOT NULL;
CREATE INDEX idx_expenses_live ON expenses(date) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- expense_users — who paid, and who owes
-- ---------------------------------------------------------------------------
-- The heart of the model. Two independent numbers per participant:
--   paid_share_minor — how much cash this person actually put in
--   owed_share_minor — how much of the cost is their responsibility
-- Their difference is that person's net position on this expense.
--
-- split_input stores the raw value the user typed for the expense's split_type
-- (percent, share count, exact amount, or adjustment) purely so the editor can
-- be reopened. It is NEVER used to compute balances.
CREATE TABLE expense_users (
  expense_id       INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id),

  paid_share_minor INTEGER NOT NULL DEFAULT 0,
  owed_share_minor INTEGER NOT NULL DEFAULT 0,

  split_input      REAL,

  PRIMARY KEY (expense_id, user_id),
  CHECK (paid_share_minor >= 0),
  CHECK (owed_share_minor >= 0)
) STRICT;

CREATE INDEX idx_expense_users_user_id ON expense_users(user_id);

-- ---------------------------------------------------------------------------
-- expense_repayments — derived pairwise debts
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
  expense_id   INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,               -- stable ordering within expense
  from_user_id INTEGER NOT NULL REFERENCES users(id),  -- debtor
  to_user_id   INTEGER NOT NULL REFERENCES users(id),  -- creditor
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
CREATE TABLE comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  splitwise_id INTEGER UNIQUE,
  expense_id   INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  content      TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
) STRICT;

CREATE INDEX idx_comments_expense_id ON comments(expense_id);

-- ---------------------------------------------------------------------------
-- activity — the feed
-- ---------------------------------------------------------------------------
-- Append-only. `payload` is JSON with a shape determined by `action`.
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),     -- actor
  group_id   INTEGER REFERENCES groups(id),
  expense_id INTEGER REFERENCES expenses(id),
  action     TEXT    NOT NULL,
  payload    TEXT,                             -- JSON
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_activity_group_id ON activity(group_id, created_at DESC);
CREATE INDEX idx_activity_user_id ON activity(user_id, created_at DESC);

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
