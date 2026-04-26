-- 007_add_source_session_id.sql
--
-- Adds memory_items.source_session_id back to fresh Mnestra installs.
--
-- The column existed in the original rag-system schema (TEXT) and is still
-- present on stores that were upgraded from rag-system → Engram → Mnestra.
-- It was dropped from the published Mnestra migration set during the rebrand,
-- which created a silent contract break with Rumen.
--
-- Rumen's Extract phase groups memory_items by source_session_id to find
-- eligible sessions for synthesis (see rumen/src/extract.ts:61). Without this
-- column, every Rumen cron tick fails with:
--   ERROR: column m.source_session_id does not exist  (SQLSTATE 42703)
--
-- Reported 2026-04-26 by a tester (Brad) whose fresh `termdeck init --mnestra`
-- on v0.6.3 left him with a Mnestra schema that worked for TermDeck/Flashback
-- but couldn't host Rumen. Surfaced after v0.6.4's access-token hint unblocked
-- his Rumen install — the Edge Function deployed cleanly, the manual POST test
-- returned 500, and the pg_cron tick keeps failing with the same query.
--
-- TEXT matches the rag-system-era type and Josh's production schema. Rumen's
-- UUID[] cast handles values that look like UUIDs; non-UUID values would fail
-- the cast (the column has only ever held UUID-shaped strings historically).
--
-- Idempotent. Safe to re-run via `termdeck init --mnestra --yes`. NULL on every
-- existing row is the correct default — old memories were never tagged with a
-- session, and Rumen's WHERE source_session_id IS NOT NULL filter excludes
-- them naturally.

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS source_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_items_source_session_id
  ON memory_items (source_session_id)
  WHERE source_session_id IS NOT NULL;
