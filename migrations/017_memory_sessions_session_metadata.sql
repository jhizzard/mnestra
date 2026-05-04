-- Migration 017 — memory_sessions session metadata columns.
--
-- Sprint 51.6 T3 (TermDeck v1.0.2 hotfix wave). Brings the canonical engram
-- memory_sessions schema in line with the rag-system writer's column set so
-- TermDeck's bundled session-end hook can write a uniform shape on both
-- fresh-canonical installs and Joshua's daily-driver petvetbid (where the
-- columns were already added by hand when rag-system bootstrap ran).
--
-- Why: until v1.0.2 the bundled hook only wrote memory_items. The actual
-- memory_sessions writer was Joshua's PRIOR personal hook at
-- ~/Documents/Graciella/rag-system/hooks/memory-session-end.js, which spawned
-- ~/Documents/Graciella/rag-system/src/scripts/process-session.ts; that script
-- INSERTed memory_sessions rows with this richer column set. When the
-- TermDeck stack-installer overwrote the personal hook on 2026-05-02, the
-- writer disappeared and memory_sessions stopped accumulating. v1.0.2's
-- bundled hook gains a memory_sessions write path; this migration ensures
-- the schema it expects exists everywhere.
--
-- Idempotent — safe on:
--   1. petvetbid (where these columns are already present from hand-applied
--      DDL Joshua ran when setting up rag-system; the IF NOT EXISTS guards
--      no-op on every column).
--   2. Fresh canonical installs that ran migrations 001-016 only (the canonical
--      engram set, which left memory_sessions at the minimal mig-001 shape).
--   3. Re-runs of this migration — every operation is guarded.
--
-- The unique constraint on session_id is wrapped in a do-block because
-- ADD CONSTRAINT does not support IF NOT EXISTS in PostgreSQL. Joshua's
-- petvetbid already has the constraint as memory_sessions_session_id_key
-- (auto-named by the rag-system bootstrap); this block detects that name
-- and skips re-adding.
--
-- session_id is added NULLABLE on canonical installs even though petvetbid's
-- existing constraint is NOT NULL. Adding NOT NULL via ALTER TABLE on a
-- table with existing rows would fail; the bundled hook always supplies
-- session_id at write time, so nullability is non-blocking. A future sprint
-- may tighten to NOT NULL with a DEFAULT after a backfill pass.

-- Defensive: vector extension must already be installed (migration 001
-- requires it for memory_items.embedding). If it's somehow missing this
-- ADD COLUMN errors, surfacing the real environment issue rather than
-- silently skipping the embedding column.

alter table public.memory_sessions
  add column if not exists session_id text,
  add column if not exists summary_embedding vector(1536),
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists duration_minutes integer,
  add column if not exists messages_count integer default 0,
  add column if not exists facts_extracted integer default 0,
  add column if not exists files_changed jsonb default '[]'::jsonb,
  add column if not exists topics jsonb default '[]'::jsonb,
  add column if not exists transcript_path text;

-- Unique constraint on session_id. Skip if any unique constraint on
-- (session_id) is already in place — covers both the canonical name
-- memory_sessions_session_id_key and any alternate name from a manual
-- ALTER TABLE Joshua may have run on petvetbid.
do $$
declare
  has_unique boolean;
begin
  select exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'memory_sessions'
      and c.contype = 'u'
      and (
        select array_agg(att.attname order by att.attnum)
        from unnest(c.conkey) as colnum
        join pg_attribute att on att.attrelid = c.conrelid and att.attnum = colnum
      ) = ARRAY['session_id']::name[]
  ) into has_unique;

  if not has_unique then
    alter table public.memory_sessions
      add constraint memory_sessions_session_id_key unique (session_id);
  end if;
end $$;

-- HNSW index on summary_embedding for future similarity search. Idempotent.
-- Cost on insert is negligible; cost on backfill is one-time.
create index if not exists memory_sessions_summary_embedding_hnsw_idx
  on public.memory_sessions using hnsw (summary_embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Helpful covering index for time-range scans (used by Flashback / rumen
-- queries that filter by ended_at). Idempotent.
create index if not exists memory_sessions_ended_at_idx
  on public.memory_sessions(ended_at desc nulls last);
