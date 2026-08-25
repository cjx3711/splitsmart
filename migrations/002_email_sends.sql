-- 002_email_sends.sql
--
-- Generic outbound-mail log. Every send that should be auditable or rate-limited
-- writes a row here (type = 'invite' today; notifications, reminders, and the
-- rest later).
--
-- type is free text on purpose: adding 'reminder' must not rebuild the table.
-- subject_user_id is not a foreign key so deleting a placeholder cannot refund
-- a cooldown. actor_user_id is SET NULL so a wiped account leaves the log.

CREATE TABLE email_sends (
  id               TEXT NOT NULL PRIMARY KEY,
  type             TEXT NOT NULL,
  to_address       TEXT NOT NULL,
  actor_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id  TEXT,
  subject          TEXT,
  provider_id      TEXT,
  delivered        INTEGER NOT NULL DEFAULT 0,
  reason           TEXT,
  sent_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (LENGTH(id) = 26),
  CHECK (delivered IN (0, 1))
) STRICT;

CREATE INDEX idx_email_sends_type_actor_sent
  ON email_sends(type, actor_user_id, sent_at);
CREATE INDEX idx_email_sends_type_subject_sent
  ON email_sends(type, subject_user_id, sent_at);
