-- 009_memory_relationship_metadata.sql
--
-- Sprint 38 (T1) — Knowledge graph substrate.
-- Adds graph-edge metadata columns to memory_relationships, expands the
-- relationship_type vocabulary from 5 to 8 values, and ships a recursive-CTE
-- traversal function (expand_memory_neighborhood) for N-hop neighborhood
-- queries.
--
-- Idempotent: safe to re-run.
--
-- Pre-existing state (verified against petvetbid 2026-04-27 17:25 ET):
--   memory_relationships has 749 live edges. The migration adds nullable
--   columns and a wider CHECK; no existing row violates the new constraint.
--
-- The original CHECK on relationship_type is anonymous (defined inline in
-- migration 001), so its name is auto-generated (e.g., memory_relationships_check1).
-- We can't rely on a known name for DROP CONSTRAINT; the DO block below
-- introspects pg_constraint and drops any CHECK on this table whose
-- definition references "relationship_type IN" — preserving the separate
-- (source_id <> target_id) CHECK.

-- ── 1. Metadata columns ──────────────────────────────────────────────────

alter table memory_relationships
  add column if not exists weight       float,
  add column if not exists inferred_at  timestamptz,
  add column if not exists inferred_by  text;

-- ── 2. Expand relationship_type CHECK vocabulary ─────────────────────────

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    where cls.relname = 'memory_relationships'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%relationship_type%'
  loop
    execute format('alter table memory_relationships drop constraint %I', c.conname);
  end loop;
end
$$;

alter table memory_relationships
  add constraint memory_relationships_relationship_type_check
  check (relationship_type in (
    'supersedes',
    'relates_to',
    'contradicts',
    'elaborates',
    'caused_by',
    'blocks',
    'inspired_by',
    'cross_project_link'
  ));

-- ── 3. Indexes for graph traversal ───────────────────────────────────────

create index if not exists memory_relationships_weight_idx
  on memory_relationships(weight)
  where weight is not null;

create index if not exists memory_relationships_inferred_at_idx
  on memory_relationships(inferred_at)
  where inferred_at is not null;

-- ── 4. expand_memory_neighborhood — recursive-CTE N-hop traversal ────────
--
-- Returns one row per (memory_id, depth) reachable from start_id within
-- max_depth hops. Edges are undirected for traversal purposes (source_id
-- and target_id treated symmetrically) — agents linking memories don't
-- always think directionally, and graph-aware recall benefits from
-- bidirectional reachability.
--
-- Cycle-safe: the path[] array tracks visited nodes; we only follow an
-- edge if its other endpoint is not already in path. Without this check,
-- the CTE would loop indefinitely on any cycle in the graph.
--
-- edge_kinds[] mirrors path: position i in edge_kinds is the relationship_type
-- of the edge that brought us to position i+1 in path. Caller can filter
-- downstream by inspecting edge_kinds (e.g., drop rows whose path traversed
-- a 'contradicts' edge).
--
-- Performance note: with ~5K memory_items and ~750 edges (current scale),
-- recursive expansion to depth 2 returns in <50ms unsharded. At >50K edges
-- consider materializing precomputed neighborhoods.

create or replace function expand_memory_neighborhood(
  start_id  uuid,
  max_depth int default 2
)
returns table (
  memory_id  uuid,
  depth      int,
  path       uuid[],
  edge_kinds text[]
)
language sql stable
as $$
  with recursive neighborhood as (
    select
      start_id                  as memory_id,
      0                         as depth,
      array[start_id]           as path,
      array[]::text[]           as edge_kinds
    union all
    select
      case when r.source_id = n.memory_id then r.target_id else r.source_id end,
      n.depth + 1,
      n.path || (case when r.source_id = n.memory_id then r.target_id else r.source_id end),
      n.edge_kinds || r.relationship_type
    from neighborhood n
    join memory_relationships r
      on (r.source_id = n.memory_id or r.target_id = n.memory_id)
    where n.depth < max_depth
      and not (
        case when r.source_id = n.memory_id then r.target_id else r.source_id end
        = any (n.path)
      )
  )
  select memory_id, depth, path, edge_kinds from neighborhood;
$$;
