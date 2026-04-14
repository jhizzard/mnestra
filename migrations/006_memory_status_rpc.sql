-- Mnemos migration 006 — memory_status_aggregation RPC
--
-- Why: `memoryStatus()` previously did a plain
--   supabase.from('memory_items').select('project, source_type, category')
-- which hits PostgREST's default 1000-row cap. On a store with 3,397 active
-- rows the `by_project` / `by_source_type` / `by_category` histograms only
-- summed to ~1000 even though `total_active` was correct. Pushing the GROUP
-- BY server-side eliminates the cap and saves the round-trip of streaming
-- every row to the client just to count them.
--
-- Safe to re-run — CREATE OR REPLACE.

create or replace function memory_status_aggregation()
returns table (
  total_active   bigint,
  sessions       bigint,
  by_project     jsonb,
  by_source_type jsonb,
  by_category    jsonb
)
language sql
stable
as $$
  select
    (select count(*)::bigint from memory_items
       where is_active = true and archived = false) as total_active,
    (select count(*)::bigint from memory_sessions) as sessions,
    coalesce(
      (select jsonb_object_agg(project, c) from (
         select project, count(*)::bigint as c
         from memory_items
         where is_active = true and archived = false
         group by project
       ) p),
      '{}'::jsonb
    ) as by_project,
    coalesce(
      (select jsonb_object_agg(source_type, c) from (
         select source_type, count(*)::bigint as c
         from memory_items
         where is_active = true and archived = false
         group by source_type
       ) s),
      '{}'::jsonb
    ) as by_source_type,
    coalesce(
      (select jsonb_object_agg(coalesce(category, 'uncategorized'), c) from (
         select category, count(*)::bigint as c
         from memory_items
         where is_active = true and archived = false
         group by category
       ) cat),
      '{}'::jsonb
    ) as by_category;
$$;

-- Ensure the service role (and anon, if you allow it) can call the RPC.
grant execute on function memory_status_aggregation() to anon, authenticated, service_role;
