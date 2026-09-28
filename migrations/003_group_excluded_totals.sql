-- Some development databases already received this column through a folded 001.
-- Record the migration without changing their existing settings.
-- migrate:skip-if-column-exists groups.excluded_from_totals

-- Presentation only: excluded groups still retain their expenses and balances.
-- Existing groups continue to count towards headline totals by default.
ALTER TABLE groups ADD COLUMN excluded_from_totals INTEGER NOT NULL DEFAULT 0
  CHECK (excluded_from_totals IN (0, 1));
