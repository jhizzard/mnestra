# Mnemos

**The LLM is stateless. Mnemos isn't.**

Mnemos is a persistent developer-memory MCP server. It gives Claude Code, Cursor, Windsurf, Cline, Continue, and any other Model Context Protocol client a long-term memory backed by Postgres + pgvector (Supabase by default). Nine MCP tools — `memory_remember`, `memory_recall`, `memory_search`, `memory_forget`, `memory_status`, `memory_summarize_session`, plus the three-layer progressive-disclosure set `memory_index` / `memory_timeline` / `memory_get` — let your assistant store decisions, recall them across sessions, and surface the right context when you start a new conversation. An optional HTTP webhook server (`mnemos serve`) exposes the same operations to non-MCP clients.

---

## Why Mnemos exists

Every new chat with an LLM starts from zero. You explain the project, the conventions, the bug you fixed last Tuesday, the reason you picked Postgres over DynamoDB — and tomorrow you do it all again. Codebases have CLAUDE.md / AGENTS.md / cursor rules, but those are static. They don't grow as you work.

Mnemos is the writable side of that. As your assistant works it stores discrete facts, decisions, and bug fixes into a vector database with embeddings and metadata. On the next session it can recall the relevant slice — scoped to the project you're in, ranked by importance and recency, deduplicated, and trimmed to a token budget.

It is deliberately small. Six MCP tools, one schema, one SQL function. No agent framework, no orchestration layer, no proprietary cloud. If you can run Postgres with pgvector, you can run Mnemos.

---

## Install

```bash
npm install -g @jhizzard/mnemos
```

Or pin it as a project dev dependency:

```bash
npm install --save-dev @jhizzard/mnemos
```

You will also need:

- A Postgres database with the `vector` and `pg_trgm` extensions (Supabase ships with both)
- An `OPENAI_API_KEY` for embedding generation (`text-embedding-3-large`, 1536 dimensions)
- An `ANTHROPIC_API_KEY` if you want `memory_summarize_session` and the consolidation job (uses Haiku)

### Apply the migrations

The `migrations/` directory contains three SQL files. Apply them in order against your database:

```bash
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnemos/migrations/001_mnemos_tables.sql
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnemos/migrations/002_mnemos_search_function.sql
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnemos/migrations/003_mnemos_event_webhook.sql
```

If you're using Supabase, paste each file into the SQL editor and run them in order.

---

## MCP setup

All of the configurations below assume the `mnemos` binary is on your `PATH` (because you ran `npm install -g`). If you'd rather run it from a checkout, replace `"command": "mnemos"` with `"command": "node"` and add `"args": ["/absolute/path/to/dist/mcp-server/index.js"]`.

### Claude Code

Edit `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "mnemos",
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Restart Claude Code. The six `memory_*` tools should appear in the MCP tools list.

### Cursor

Edit `~/.cursor/mcp.json` (Cursor uses the same MCP config shape):

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "mnemos",
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "mnemos",
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Generic stdio MCP (Cline, Continue, anything else)

Mnemos speaks the standard stdio MCP transport. Any client that lets you point at a binary will work:

```json
{
  "command": "mnemos",
  "args": [],
  "env": {
    "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

---

## Tool reference

| Tool | Purpose |
|---|---|
| `memory_remember` | Store a fact, decision, or preference. Embeds, dedups (cosine > 0.88 → update in place, > 0.95 → skip), inserts. |
| `memory_recall` | Smart retrieval. Hybrid search (full-text + semantic + recency + project affinity), dedup, smart re-rank, token-budget trim. Always returns at least `min_results` if available. |
| `memory_search` | Low-level filtered search. Returns raw scored hits. Use this for admin tooling or debugging recall. |
| `memory_forget` | Soft-delete a memory by UUID. The row is archived, not destroyed. |
| `memory_status` | Stats: total active memories, sessions processed, breakdown by project / source_type / category. |
| `memory_summarize_session` | Pass in a session transcript or document; Mnemos extracts discrete facts via Haiku and stores each as a memory. |
| `memory_index` | Three-layer search step 1. Compact `{id, snippet≤120, source_type, project, created_at}` hits (~80–120 tokens each). Drill into IDs with `memory_get`, or surround with `memory_timeline`. |
| `memory_timeline` | Three-layer search step 2. Memories from the same project chronologically surrounding either a query hit or a specific observation ID. Windows: `1h` / `24h` / `7d`. |
| `memory_get` | Three-layer search step 3. Batch-fetch full rows by UUID (1–100 IDs). Batch-only to discourage N+1 calls. |

### Three-layer progressive disclosure

The `memory_index` → `memory_timeline` → `memory_get` trio is designed for token-efficient retrieval. Start with `memory_index` to get a cheap overview, use `memory_timeline` when you need temporal context around a hit, and only call `memory_get` once you know which full rows you actually want. This matches the `search` / `timeline` / `get_observations` shape from `claude-mem`.

### HTTP webhook server (non-MCP clients)

Run `mnemos serve` to start a tiny HTTP surface on `MNEMOS_WEBHOOK_PORT` (default `37778`). It exposes the same operations as the MCP tools over JSON:

- `POST /mnemos` with body `{ "op": "remember" | "recall" | "search" | "status" | "index" | "timeline" | "get", ...args }`.
- `GET  /healthz` — returns `{ ok, version, store: { rows, last_write } }`.
- `GET  /observation/:id` — single memory by UUID (the citation endpoint). Same shape as a `memory_get` row.

The MCP stdio server is unaffected — `mnemos` with no subcommand still starts it.

### CLI subcommands

| Command | What it does |
|---|---|
| `mnemos` | Start the stdio MCP server (default — backwards compatible). |
| `mnemos serve` | Start the HTTP webhook server on `$MNEMOS_WEBHOOK_PORT` (default 37778). |
| `mnemos export --project <name> --since <iso>` | Stream every matching memory as JSONL on stdout. Paginated, never loads the full store into memory. Include embeddings so re-imports don't re-embed. |
| `mnemos import` | Read JSONL from stdin. Skips rows whose `id` already exists, embeds rows that are missing an `embedding`, preserves `id`/`created_at`/`updated_at`/`is_active`/`archived`/`superseded_by` when present. |

Export/import is the migration path out of (or into) Mnemos:

```bash
mnemos export --project termdeck > termdeck-backup.jsonl
mnemos import < termdeck-backup.jsonl
```

### Configuring `memory_hybrid_search`

Starting in 0.2.0, `memory_hybrid_search` caps `match_count` at 200 by default so a single call cannot pull tens of thousands of rows. Override per-database or per-session:

```sql
ALTER DATABASE your_db SET mnemos.max_match_count = 500;
SET mnemos.max_match_count = 500;
```

`memory_hybrid_search_explain(...)` is a sibling function that returns `EXPLAIN (ANALYZE, BUFFERS)` output for the equivalent call. Use it when diagnosing slow recall on very large stores.

---

## Source types

Every memory has a `source_type`. The six values you can pass to `memory_remember` are:

| Value | When to use it |
|---|---|
| `decision` | Architectural or strategic choices ("we picked Postgres because…"). Decays slowly (one-year half-life), highest weight in ranking. |
| `fact` | Project facts ("the API base URL is X"). 90-day half-life. |
| `preference` | User or team preferences ("the team prefers Tailwind over CSS modules"). One-year half-life. |
| `bug_fix` | A specific bug and its resolution. 30-day half-life — stale fixes age out. |
| `architecture` | System architecture notes. One-year half-life, second-highest weight. |
| `code_context` | Snippet-level context about a specific file or function. 14-day half-life. |

Internal source types like `session_summary` and `document_chunk` exist in the SQL ranking function but are not exposed via the MCP `memory_remember` tool — they're populated by `memory_summarize_session` and external ingestion pipelines.

See [`docs/SOURCE-TYPES.md`](docs/SOURCE-TYPES.md) for the full decay and weighting profile.

---

## Schema overview

Three tables and one search function:

- **`memory_items`** — the main store. `id`, `content`, `embedding vector(1536)`, `source_type`, `category`, `project`, `metadata jsonb`, `is_active`, `archived`, `superseded_by`, `created_at`, `updated_at`. Indexed with HNSW on the embedding column and a GIN trigram index on `content`.
- **`memory_sessions`** — optional session metadata for the `memory_summarize_session` workflow.
- **`memory_relationships`** — typed relationships between memories: `supersedes`, `relates_to`, `contradicts`, `elaborates`, `caused_by`.
- **`memory_hybrid_search()`** — RRF fusion of full-text + semantic search, with tiered recency decay, source_type weighting, and project affinity scoring all in one SQL function.

Full DDL is in [`migrations/001_mnemos_tables.sql`](migrations/001_mnemos_tables.sql) and [`migrations/002_mnemos_search_function.sql`](migrations/002_mnemos_search_function.sql). Schema documentation is at [`docs/SCHEMA.md`](docs/SCHEMA.md).

---

## Pairs with TermDeck

[TermDeck](https://github.com/jhizzard/termdeck) is a browser-based terminal multiplexer with rich metadata overlays and per-terminal AI agent detection. Wire Mnemos into TermDeck and every terminal session can write its events into shared memory; the "Ask about this terminal" input then becomes a recall query against the same store. See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the integration recipe.

## Pairs with Rumen

[Rumen](https://github.com/jhizzard/rumen) is an async learning layer that runs on top of any pgvector memory store, including Mnemos. Rumen wakes on a schedule, reads recent session activity, cross-references it with everything you've ever stored, and writes the connections back as `rumen_insights` rows. Mnemos is the memory; Rumen is the part of the stomach that keeps chewing after you stop working.

---

## License

MIT. See [`LICENSE`](LICENSE).
