-- 013_reclassify_uncertain.sql
--
-- Sprint 41 (T4) — Audit-trail columns for the LLM-classification pass that
-- finishes the chopin-nashville taxonomy cleanup.
--
-- Background:
--   Sprint 41 T2's deterministic re-tag (`012_project_tag_re_taxonomy.sql`)
--   handles every chopin-nashville row whose content has a clear keyword or
--   path signal. The residue — rows with no clear signal — gets classified
--   by `scripts/reclassify-chopin-nashville.js` which calls Haiku 4.5 in
--   batches of 20 and writes back per-row tag decisions.
--
--   Some of those LLM decisions will be "this row really IS chopin-nashville
--   competition work — leave the tag." Without an audit stamp the script
--   can't distinguish "row the LLM voted to keep" from "row the LLM hasn't
--   seen yet" — every re-run would re-ask Haiku about the same rows
--   indefinitely. The stamp also gives a one-line audit trail
--   (`SELECT count(*) FROM memory_items WHERE reclassified_by = '...'`).
--
-- Idempotent: safe to re-run. ADD COLUMN IF NOT EXISTS — no-op if already
-- applied.
--
-- Constraints:
--   Both columns nullable. Only rows the script touches get stamped; every
--   other row stays untouched. There is no foreign key, no NOT NULL, no
--   default — these are pure audit metadata.

alter table memory_items
  add column if not exists reclassified_by text,
  add column if not exists reclassified_at timestamptz;

-- Lightweight partial index — useful for `count(*) WHERE reclassified_by = ...`
-- audit queries and for the script's own idempotency filter. Keeps the index
-- small (only stamped rows are indexed) so it doesn't cost anything on the
-- vast majority of memory_items rows that stay untouched.

create index if not exists memory_items_reclassified_by_idx
  on memory_items(reclassified_by)
  where reclassified_by is not null;
