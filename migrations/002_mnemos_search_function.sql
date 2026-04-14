-- Mnemos v0.1 — memory_hybrid_search
--
-- Reciprocal rank fusion over full-text and semantic search, with the
-- three SQL-side fixes from RAG-MEMORY-IMPROVEMENTS-AND-TERMDECK-STRATEGY.md:
--
--   Fix 1 — Tiered recency decay by source_type. Architectural decisions
--           decay on a one-year half-life; bug fixes on a 30-day half-life;
--           session summaries and document chunks on a 14-day half-life.
--
--   Fix 3 — Source_type weighting. Decisions and architecture outrank
--           raw document chunks in the final fused score.
--
--   Fix 5 — Project affinity scoring. Exact project match multiplies the
--           score by 1.5x; mismatches are penalised 0.7x.

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
    -- RRF base score
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
      -- Fix 1: tiered recency decay by source_type
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
      -- Fix 3: source_type weighting
      * case f.source_type
          when 'decision'       then 1.5
          when 'architecture'   then 1.4
          when 'bug_fix'        then 1.3
          when 'preference'     then 1.2
          when 'fact'           then 1.0
          when 'document_chunk' then 0.6
          else                       1.0
        end
      -- Fix 5: project affinity scoring
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
limit match_count;
$$;
