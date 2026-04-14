-- Mnemos v0.2 — minimal additive delta for stores provisioned against the
-- original rag-system schema.
--
-- This migration is idempotent and non-destructive:
--   • adds only the single column (`archived`) that Mnemos v0.2 reads/writes
--     but which is absent from the original rag-system `memory_items` table;
--   • re-creates the two partial indexes under v2 names so they cannot
--     collide with any pre-existing same-named index that uses a different
--     `where` predicate;
--   • does NOT replace `memory_hybrid_search`, `match_memories`, or any
--     other SQL function — those remain on their production versions.
--
-- Apply once, in the Supabase SQL editor, against any existing store that
-- pre-dates Mnemos v0.2's `archived` soft-delete column.

alter table memory_items
  add column if not exists archived boolean not null default false;

create index if not exists memory_items_project_idx_v2
  on memory_items(project) where is_active = true and archived = false;

create index if not exists memory_items_source_type_idx_v2
  on memory_items(source_type) where is_active = true and archived = false;
