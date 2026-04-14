# Mnemos schema

Mnemos stores everything in three tables and exposes one search function. The DDL lives in `migrations/001_mnemos_tables.sql` and `migrations/002_mnemos_search_function.sql` — this document explains what each piece is for and why it's shaped that way.

## Tables

### `memory_items`

The primary store. Every memory you record lands here.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, generated server-side. |
| `content` | `text` | The actual memory text. |
| `embedding` | `vector(1536)` | OpenAI `text-embedding-3-large` at 1536 dimensions. Indexed with HNSW (cosine). |
| `source_type` | `text` | One of the six exposed types — `decision`, `fact`, `preference`, `bug_fix`, `architecture`, `code_context` — plus internal types `session_summary` and `document_chunk` populated by other paths. |
| `category` | `text` | Optional human category: `technical`, `business`, `workflow`, `debugging`, `architecture`, `convention`, `relationship`. |
| `project` | `text` | Project scope. The string `global` is treated as cross-project shared memory. |
| `metadata` | `jsonb` | Free-form metadata. The recall ranker reads `metadata.importance` (`critical`, `important`, `minor`). |
| `is_active` | `boolean` | Recall and search ignore inactive rows. |
| `archived` | `boolean` | Set by `memory_forget`. Recall and search ignore archived rows. |
| `superseded_by` | `uuid` | Self-reference. Set by the consolidation job when this row was merged into a canonical replacement. |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | Touched on dedup-update. |

Indexes:

- `memory_items_embedding_hnsw_idx` — HNSW with cosine ops on `embedding`. The single most important index in the schema. If you can't use HNSW, fall back to ivfflat.
- `memory_items_content_trgm_idx` — GIN trigram on `content` for the full-text half of hybrid search.
- `memory_items_project_idx`, `memory_items_source_type_idx` — partial indexes on active/non-archived rows.
- `memory_items_created_at_idx` — descending, used by the consolidation seed query.

### `memory_sessions`

Optional. The `memory_summarize_session` tool stores high-level session metadata here when you wire it up via a hook. v0.1 leaves it as a simple table; v0.2 will hang relationships off it.

### `memory_relationships`

Typed edges between memories. Five relationship types:

- `supersedes` — A replaces B
- `relates_to` — A and B describe the same feature, decision, or bug
- `contradicts` — A and B disagree (a useful flag — Mnemos does not auto-resolve)
- `elaborates` — A adds detail to B
- `caused_by` — A is the consequence of B

The unique constraint `(source_id, target_id, relationship_type)` prevents duplicate edges. The check constraint forbids self-loops.

## Functions

### `match_memories(query_embedding, match_threshold, match_count, filter_project)`

Pure cosine similarity search. Used by `memoryRemember` to find dedup candidates and by `consolidateMemories` to seed clusters. Returns rows above `match_threshold` similarity, ordered by closest first.

### `memory_hybrid_search(query_text, query_embedding, ...)`

The main retrieval function. RRF fusion of full-text + semantic search, then three multipliers stacked on top:

1. **Tiered recency decay** — different half-life per source_type (Fix 1).
2. **Source-type weighting** — decisions and architecture rank above document chunks (Fix 3).
3. **Project affinity** — exact project match × 1.5, `global` × 1.0, mismatch × 0.7 (Fix 5).

See `migrations/002_mnemos_search_function.sql` for the exact SQL. The function is `STABLE` and has no side effects, so it's safe to call from RLS-restricted contexts if you add policies later.

## Three-layer progressive-disclosure tools

`memory_hybrid_search` is the workhorse, but most callers don't want to pull full rows for every hit — that's wasteful when you only need snippets to decide which memories to drill into. Mnemos ships three layered tools that share one shape vocabulary:

- `memory_index(query, project?, source_type?, limit?)` — projection of `memory_hybrid_search` into a compact `IndexHit = { id, snippet≤120, source_type, project, created_at }`. About 80–120 tokens per hit. Use first.
- `memory_timeline({ query? | around_id? }, window: '1h'|'24h'|'7d')` — same compact `IndexHit` shape, but rows come from a plain `memory_items` filter in the same project, chronologically surrounding either the top hit of `query` or an explicit UUID. Radius defaults to ±10 rows.
- `memory_get({ ids: uuid[] })` — batch fetch of full `memory_items` rows by UUID (1–100 per call). Batch-only to discourage N+1 callers. The HTTP counterpart is `GET /observation/:id`, which returns the same shape for a single ID (the citation endpoint).

These are additive to `memory_recall` and `memory_search` — nothing changes about the SQL schema.

## Why these shapes

- **vector(1536), not 3072.** OpenAI's `text-embedding-3-large` defaults to 3072 dimensions, but supports a `dimensions` parameter to truncate. 1536 is the sweet spot — half the storage, almost identical recall quality, fits comfortably in HNSW indexes for stores into the millions.
- **Soft delete via `is_active` + `archived`, not row deletion.** Memories link to each other via `memory_relationships`. Hard-deleting would cascade or strand edges; soft-delete keeps the graph intact and lets the consolidation job reverse its decisions if needed.
- **`project` as a plain text column, not a foreign key.** Mnemos is meant to be embedded into many tools, each with its own project naming. A foreign key would force every tool to maintain a `projects` table; a free string lets you start with `project: 'global'` and add structure later.
- **`metadata jsonb` instead of fixed columns.** Importance, source URLs, session IDs, agent identifiers — all of these belong in metadata. Promoting them to columns later is cheap; demoting them is expensive.
