-- Mnestra v0.3 — memory_recall_graph (Sprint 38 / T3)
--
-- Graph-aware recall. Two-stage retrieval:
--
--   Stage 1: vector recall via match_memories() — top-K nearest neighbors
--            in embedding space (existing RPC; tombstone filters inherited).
--   Stage 2: graph expansion via expand_memory_neighborhood() — for each
--            stage-1 seed, walk the relationship graph to max_depth.
--
-- Re-rank the union of (stage 1 ∪ stage 2) by a combined signal:
--
--   final_score = vector_score × edge_weight × recency_score
--
-- where:
--   vector_score  = cosine similarity of seed memory to query (0..1)
--   edge_weight   = mean of memory_relationships.weight along the path,
--                   defaulting to 0.5 for edges T2 hasn't classified yet
--                   (the 749 pre-T2 edges all start with weight = NULL).
--   recency_score = exp(-age_seconds / (30 × 86400))  (30-day half-life)
--
-- Initial (depth=0) results are seeded with edge_weight = 1.0 (no path).
--
-- Hard dependencies:
--   • migration 009 must have run (introduces memory_relationships.weight
--     and the expand_memory_neighborhood function).
--   • migration 001 (match_memories, memory_items, memory_relationships).
--
-- Rerun-safe: CREATE OR REPLACE.

create or replace function memory_recall_graph (
  query_embedding   vector(1536),
  project_filter    text default null,
  max_depth         int default 2,
  k                 int default 10
)
returns table (
  memory_id      uuid,
  content        text,
  project        text,
  depth          int,
  vector_score   float,
  edge_weight    float,
  recency_score  float,
  final_score    float,
  path           uuid[]
)
language sql stable
as $$
  with initial as (
    -- Stage 1: top-K vector recall. match_memories already filters
    -- is_active / archived / superseded_by / project, so depth-0 hits
    -- are tombstone-clean. match_threshold=0.0 returns the full top-K
    -- (we rank by combined signal, not by raw similarity threshold).
    select
      mm.id          as memory_id,
      mm.content,
      mm.project,
      0              as depth,
      mm.similarity  as vector_score,
      mi.created_at,
      array[mm.id]   as path
    from match_memories(query_embedding, 0.0, k, project_filter) mm
    join memory_items mi on mi.id = mm.id
  ),
  expanded as (
    -- Stage 2: graph expansion. For each stage-1 seed, walk the graph to
    -- max_depth via T1's expand_memory_neighborhood RPC. Carry the seed's
    -- vector_score forward (we do NOT re-embed neighbors — the assumption
    -- is "if A is relevant to the query and B is connected to A, then B
    -- inherits some of A's relevance, attenuated by the path weight").
    select
      n.memory_id,
      mi.content,
      mi.project,
      n.depth,
      i.vector_score,
      mi.created_at,
      n.path,
      coalesce(
        (
          -- Average of edge weights along the path (cycle-safe: T1's CTE
          -- guarantees no repeats). Pairwise lookup over consecutive path
          -- elements, treating the relationship as undirected so A→B and
          -- B→A both count.
          select avg(coalesce(r.weight, 0.5))
          from generate_series(1, array_length(n.path, 1) - 1) as g
          join memory_relationships r
            on (r.source_id = n.path[g] and r.target_id = n.path[g + 1])
            or (r.source_id = n.path[g + 1] and r.target_id = n.path[g])
        ),
        0.5
      ) as edge_weight
    from initial i
    cross join lateral expand_memory_neighborhood(i.memory_id, max_depth) n
    join memory_items mi
      on mi.id = n.memory_id
     and mi.is_active = true
     and mi.archived = false
     and mi.superseded_by is null
    where n.depth > 0
      and (project_filter is null or mi.project = project_filter)
  ),
  unioned as (
    -- depth-0 seeds get edge_weight = 1.0 (no path traversed).
    select memory_id, content, project, depth, vector_score,
           1.0::float as edge_weight, created_at, path
    from initial
    union all
    select memory_id, content, project, depth, vector_score,
           edge_weight, created_at, path
    from expanded
  ),
  scored as (
    -- Same memory may be reached via multiple paths (vector seed AND graph
    -- expansion, or two different seeds). Keep the strongest path: highest
    -- final_score wins, with depth-0 (vector hit) preferred on ties.
    select distinct on (memory_id)
      memory_id,
      content,
      project,
      depth,
      vector_score,
      edge_weight,
      exp(-extract(epoch from (now() - created_at))::float / (30.0 * 86400.0))
        as recency_score,
      vector_score * edge_weight
        * exp(-extract(epoch from (now() - created_at))::float / (30.0 * 86400.0))
        as final_score,
      path
    from unioned
    order by memory_id, final_score desc, depth asc
  )
  select
    memory_id, content, project, depth, vector_score,
    edge_weight, recency_score, final_score, path
  from scored
  order by final_score desc
  limit 50;
$$;

-- Lightweight grant convention follows existing match_memories. Service-role
-- and authenticated callers should already have execute by inheritance, but
-- be explicit for the new function so PostgREST surfaces it without a manual
-- dashboard step.

grant execute on function memory_recall_graph(vector, text, int, int)
  to authenticated, service_role, anon;
