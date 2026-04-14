-- Mnemos v0.2 — match_count cap + EXPLAIN variant
--
-- Two changes to the search surface:
--
--   1. memory_hybrid_search gains a configurable cap on `match_count`.
--      Default cap: 200. The original function was unbounded, which risks
--      runaway queries at scale (10k+ rows pulled per call).
--
--      Override per-database:   ALTER DATABASE your_db SET mnemos.max_match_count = 500;
--      Override per-session:    SET mnemos.max_match_count = 500;
--      Leave unset:             cap defaults to 200.
--
--   2. A new function `memory_hybrid_search_explain` that returns
--      EXPLAIN (ANALYZE, BUFFERS) output for an equivalent call. Used by
--      `mnemos diagnose` to troubleshoot slow recall queries.
--
-- Rerun-safe: CREATE OR REPLACE on both.

-- ── memory_hybrid_search ─────────────────────────────────────────────────

create or replace function memory_hybrid_search (
  query_text          text,
  query_embedding     vector(1536),
  match_count         int default 20,
  full_text_weight    float default 1.0,
  semantic_weight     float default 1.0,
  rrf_k               int default 60,
  filter_project      text default null,
  filter_source_type  text default null
)
returns table (
  id          uuid,
  content     text,
  source_type text,
  category    text,
  project     text,
  metadata    jsonb,
  score       float,
  created_at  timestamptz
)
language sql stable
as $$
with candidates as (
  select
    m.id,
    m.content,
    m.source_type,
    m.category,
    m.project,
    m.metadata,
    m.created_at,
    m.embedding,
    ts_rank_cd(to_tsvector('english', m.content), plainto_tsquery('english', query_text))
      as ft_rank,
    1 - (m.embedding <=> query_embedding) as sem_rank,
    extract(epoch from (now() - m.created_at))::float as age_seconds
  from memory_items m
  where m.is_active = true
    and m.archived = false
    and m.superseded_by is null
    and m.embedding is not null
    and (filter_project is null or m.project = filter_project)
    and (filter_source_type is null or m.source_type = filter_source_type)
),
ft_ranked as (
  select id, row_number() over (order by ft_rank desc nulls last) as rank
  from candidates where ft_rank > 0
),
sem_ranked as (
  select id, row_number() over (order by sem_rank desc nulls last) as rank
  from candidates
),
fused as (
  select
    c.id,
    c.content,
    c.source_type,
    c.category,
    c.project,
    c.metadata,
    c.created_at,
    c.age_seconds,
    coalesce(full_text_weight / (rrf_k + ft.rank), 0.0) +
    coalesce(semantic_weight  / (rrf_k + sr.rank), 0.0) as base_score
  from candidates c
  left join ft_ranked  ft on ft.id = c.id
  left join sem_ranked sr on sr.id = c.id
),
scored as (
  select
    f.id,
    f.content,
    f.source_type,
    f.category,
    f.project,
    f.metadata,
    f.created_at,
    f.base_score
      * case f.source_type
          when 'decision'        then 1.0 / (1.0 + f.age_seconds / (365.0 * 86400.0))
          when 'architecture'    then 1.0 / (1.0 + f.age_seconds / (365.0 * 86400.0))
          when 'preference'      then 1.0 / (1.0 + f.age_seconds / (365.0 * 86400.0))
          when 'fact'            then 1.0 / (1.0 + f.age_seconds / ( 90.0 * 86400.0))
          when 'convention'      then 1.0 / (1.0 + f.age_seconds / ( 90.0 * 86400.0))
          when 'bug_fix'         then 1.0 / (1.0 + f.age_seconds / ( 30.0 * 86400.0))
          when 'debugging'       then 1.0 / (1.0 + f.age_seconds / ( 30.0 * 86400.0))
          when 'session_summary' then 1.0 / (1.0 + f.age_seconds / ( 14.0 * 86400.0))
          when 'document_chunk'  then 1.0 / (1.0 + f.age_seconds / ( 14.0 * 86400.0))
          when 'code_context'    then 1.0 / (1.0 + f.age_seconds / ( 14.0 * 86400.0))
          else                         1.0 / (1.0 + f.age_seconds / ( 30.0 * 86400.0))
        end
      * case f.source_type
          when 'decision'       then 1.5
          when 'architecture'   then 1.4
          when 'bug_fix'        then 1.3
          when 'preference'     then 1.2
          when 'fact'           then 1.0
          when 'document_chunk' then 0.6
          else                       1.0
        end
      * case
          when filter_project is null then 1.0
          when f.project = filter_project then 1.5
          when f.project = 'global' then 1.0
          else 0.7
        end
      as score
  from fused f
)
select
  s.id,
  s.content,
  s.source_type,
  s.category,
  s.project,
  s.metadata,
  s.score,
  s.created_at
from scored s
order by s.score desc
limit least(
  greatest(match_count, 1),
  coalesce(nullif(current_setting('mnemos.max_match_count', true), '')::int, 200)
);
$$;

-- ── memory_hybrid_search_explain ─────────────────────────────────────────

create or replace function memory_hybrid_search_explain (
  query_text          text,
  query_embedding     vector(1536),
  match_count         int default 20,
  full_text_weight    float default 1.0,
  semantic_weight     float default 1.0,
  rrf_k               int default 60,
  filter_project      text default null,
  filter_source_type  text default null
)
returns setof text
language plpgsql
as $$
begin
  return query execute
    'explain (analyze, buffers, format text) '
    || 'select * from memory_hybrid_search($1, $2, $3, $4, $5, $6, $7, $8)'
  using
    query_text,
    query_embedding,
    match_count,
    full_text_weight,
    semantic_weight,
    rrf_k,
    filter_project,
    filter_source_type;
end;
$$;
