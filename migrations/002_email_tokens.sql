-- 002_email_tokens.sql
--
-- Single-use, expiring tokens sent by email.
--
-- `purpose` exists so password reset (docs/PLAN.md phase 4) can reuse this table
-- rather than needing another migration. Only 'verify_email' is implemented
-- today; the CHECK constraint already permits 'reset_password'.
--
-- As everywhere else in this codebase, only the token HASH is stored. A leaked
-- database must not hand out working verification links.

PRAGMA foreign_keys = ON;

CREATE TABLE email_tokens (
  id         TEXT    PRIMARY KEY,
  token_hash TEXT    NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT    NOT NULL,

  -- SNAPSHOT of the address this token was issued for.
  --
  -- Load-bearing: if a user requests verification, then changes their email,
  -- the outstanding token must NOT verify the new address. Consuming a token
  -- compares this against users.email and refuses on mismatch. Without it,
  -- someone could verify an address they no longer control — or worse, have a
  -- pending token silently validate an attacker-supplied address.
  email      TEXT    NOT NULL,

  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  used_at    TEXT,

  CHECK (purpose IN ('verify_email', 'reset_password'))
) STRICT;

CREATE INDEX idx_email_tokens_user_purpose ON email_tokens(user_id, purpose);
CREATE INDEX idx_email_tokens_expires_at ON email_tokens(expires_at);
