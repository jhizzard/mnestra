-- Mnemos v0.1 — core tables
--
-- Run against a Postgres 15+ database that has pgvector installed
-- (Supabase already ships with it). Apply in order:
--   001_mnemos_tables.sql
--   002_mnemos_search_function.sql
--   003_mnemos_event_webhook.sql

create extension if not exists "vector";
create extension if not exists "pg_trgm";
create extension if not exists "pgcrypto";

-- ── memory_items ──────────────────────────────────────────────────────────

create table if not exists memory_items (
  id              uuid primary key default gen_random_uuid(),
  content         text not null,
  embedding       vector(1536),
  source_type     text not null default 'fact',
  category        text,
  project         text not null default 'global',
  metadata        jsonb not null default '{}'::jsonb,
  is_active       boolean not null default true,
  archived        boolean not null default false,
  superseded_by   uuid references memory_items(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists memory_items_project_idx
  on memory_items(project) where is_active = true and archived = false;

create index if not exists memory_items_source_type_idx
  on memory_items(source_type) where is_active = true and archived = false;

create index if not exists memory_items_created_at_idx
  on memory_items(created_at desc);

create index if not exists memory_items_content_trgm_idx
  on memory_items using gin (content gin_trgm_ops);

-- HNSW vector index. If your Postgres/pgvector is too old for HNSW,
-- swap to ivfflat:
--   create index memory_items_embedding_idx on memory_items
--     using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists memory_items_embedding_hnsw_idx
  on memory_items using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ── memory_sessions ───────────────────────────────────────────────────────

create table if not exists memory_sessions (
  id          uuid primary key default gen_random_uuid(),
  project     text not null default 'global',
  summary     text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists memory_sessions_project_idx on memory_sessions(project);
create index if not exists memory_sessions_created_at_idx on memory_sessions(created_at desc);

-- ── memory_relationships ──────────────────────────────────────────────────

create table if not exists memory_relationships (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid not null references memory_items(id) on delete cascade,
  target_id         uuid not null references memory_items(id) on delete cascade,
  relationship_type text not null,
  created_at        timestamptz not null default now(),
  unique (source_id, target_id, relationship_type),
  check (source_id <> target_id),
  check (relationship_type in ('supersedes','relates_to','contradicts','elaborates','caused_by'))
);

create index if not exists memory_relationships_source_idx on memory_relationships(source_id);
create index if not exists memory_relationships_target_idx on memory_relationships(target_id);

-- ── match_memories helper RPC ─────────────────────────────────────────────
-- Used by remember.ts (dedup) and consolidate.ts (cluster seeding).

create or replace function match_memories (
  query_embedding   vector(1536),
  match_threshold   float,
  match_count       int,
  filter_project    text default null
)
returns table (
  id          uuid,
  content     text,
  source_type text,
  category    text,
  project     text,
  metadata    jsonb,
  similarity  float
)
language sql stable
as $$
  select
    m.id,
    m.content,
    m.source_type,
    m.category,
    m.project,
    m.metadata,
    1 - (m.embedding <=> query_embedding) as similarity
  from memory_items m
  where m.is_active = true
    and m.archived = false
    and m.superseded_by is null
    and m.embedding is not null
    and (filter_project is null or m.project = filter_project)
    and 1 - (m.embedding <=> query_embedding) >= match_threshold
  order by m.embedding <=> query_embedding asc
  limit match_count;
$$;
