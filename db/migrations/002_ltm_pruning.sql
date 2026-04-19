-- Migration 002: Add access tracking columns to long_term_memory
-- These columns enable the LTM condensation pipeline to identify dormant facts
-- (never accessed since creation) and merge similar ones into coarser summaries.

ALTER TABLE long_term_memory
  ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE long_term_memory
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- Backfill: for existing rows, treat last_accessed as the creation timestamp
UPDATE long_term_memory
SET created_at = last_accessed
WHERE created_at IS NULL;

ALTER TABLE long_term_memory
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN created_at SET NOT NULL;
