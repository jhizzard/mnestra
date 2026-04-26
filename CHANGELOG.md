# Changelog

All notable changes to Mnestra will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned
- Web viewer UI for browsing memories (port 37777), matching the shape `claude-mem` ships.
- Claude Code lifecycle-hooks capture path — auto-ingest tool usage without a client call.

## [0.2.2] - 2026-04-26

### Fixed
- **`memory_items.source_session_id` missing from fresh installs.** The column existed in the original `rag-system` schema (TEXT) and is still present on stores upgraded from rag-system → Engram → Mnestra, but was dropped from the published Mnestra migration set during the rebrand. Rumen v0.4.x's Extract phase (`extract.ts:61`) groups memory_items by `source_session_id` to find eligible sessions for synthesis. On any fresh Mnestra install, every Rumen cron tick failed with `column m.source_session_id does not exist` (Postgres SQLSTATE 42703).
- New `migrations/007_add_source_session_id.sql` adds the column back as `TEXT`, idempotent (`ADD COLUMN IF NOT EXISTS`), with a partial index on `WHERE source_session_id IS NOT NULL`. NULL on every existing row is the correct default — old memories were never tagged with a session, and Rumen's `WHERE source_session_id IS NOT NULL` filter excludes them naturally.

### Notes
- Reported 2026-04-26 by a TermDeck tester (Brad) whose fresh `termdeck init --mnestra` on v0.6.3 left him with a Mnestra schema that worked for TermDeck/Flashback but couldn't host Rumen. v0.6.4 unblocked his Rumen install (access-token hint), v0.6.5 of TermDeck (which bundles the same migration) closes the contract break.
- Recovery for direct `@jhizzard/mnestra` users: `npm i -g @jhizzard/mnestra@latest`, then re-run your migration application step. The column lands idempotently. For TermDeck users, the recovery is `termdeck init --mnestra --yes` after upgrading to TermDeck v0.6.5+.

## [0.2.1] - 2026-04-19

### Added
- **`~/.termdeck/secrets.env` fallback for `mnestra serve`.** When `SUPABASE_URL` is not set in the environment, the `serve` subcommand now parses `~/.termdeck/secrets.env` (dotenv-style `KEY=value` lines, with `#` comments and optional surrounding quotes) and populates `process.env` for any keys that aren't already set. Existing env vars are never overridden; missing file is a silent no-op. Eliminates the #1 recurring startup friction: starting Mnestra without sourcing secrets first. Only the `serve` path is affected — the default stdio MCP server, `export`, `import`, `--help`, and `--version` are unchanged.

## [0.2.0] - 2026-04-13

### Added
- **`mnestra --help` / `--version` / `help` subcommand.** CLI now prints a human-readable usage block listing `serve`, `export`, `import`, and required environment variables, and reports the package version from `package.json`.
- **`memory_status_aggregation` SQL function** (`migrations/006_memory_status_rpc.sql`). Pushes the status histogram GROUP BY into Postgres so `memoryStatus()` no longer hits PostgREST's default 1000-row cap when streaming rows to the client. The JS side now calls the RPC first and falls back to the legacy client-side aggregation (with a one-time warning) when the migration hasn't been applied yet. Fixes the Sprint 1 observation where `by_project` summed to ~1000 despite `total_active` being 3,397.
- **Unit tests for `memoryStatus()`.** `tests/status.test.ts` drives `memoryStatus()` with an injected fake Supabase client and asserts (a) the RPC result is unpacked correctly, (b) bigints-as-strings from Postgres are normalized to numbers, and (c) the legacy fallback path still returns a correctly summed histogram. `memoryStatus()` grew an optional `client` parameter for test injection; default behavior unchanged.
- **HTTP webhook server** (`mnestra serve`). A tiny `node:http` surface on `MNESTRA_WEBHOOK_PORT` (default `37778`) exposing:
  - `POST /mnestra` with `{ op, ...args }` for `remember` / `recall` / `search` / `status` / `index` / `timeline` / `get`.
  - `GET /healthz` — liveness plus `{ version, store: { rows, last_write } }`.
  - `GET /observation/:id` — single memory by UUID, same row shape as `memory_get` (the citation endpoint).
  The MCP stdio server keeps working unchanged; the two are additive. Graceful shutdown on SIGTERM/SIGINT. Implemented in `src/webhook-server.ts` with a testable `dispatchOp()` that takes injectable deps.
- **Three-layer progressive-disclosure search**: `memory_index` / `memory_timeline` / `memory_get`. Exposed both as MCP tools and through the webhook server. `memory_index` returns a compact 80–120-token shape (`{id, snippet≤120, source_type, project, created_at}`); `memory_timeline` returns the same compact shape chronologically surrounding either a query hit or an explicit UUID with windows `1h`/`24h`/`7d`; `memory_get` batch-fetches full rows (1–100 UUIDs per call) and shares its row shape with `GET /observation/:id`. Implemented in `src/layered.ts`.
- **Privacy tags.** `memory_remember` now strips `<private>…</private>` blocks from content before embedding, dedup, and insert, replacing each block with `[redacted]`. Rows that had any redaction get `metadata.had_private_content = true`. Handles nested tags (collapse to one outer block), unclosed tags (preserved verbatim — fail-safe, never leak), case-insensitive tag matching, and attributes on the opening tag. The consolidation job re-applies the redactor defensively to every cluster member and to the canonical output so legacy rows are covered. Implemented in `src/privacy.ts`; documented in `docs/SOURCE-TYPES.md`.
- **`mnestra export` / `mnestra import` CLI.** Streaming JSONL dump and load with no in-memory accumulation.
  - `mnestra export --project <name> --since <iso>` paginates through `memory_items` 500 rows at a time and writes one JSON object per line to stdout, including the `embedding` column so re-imports don't need to re-embed.
  - `mnestra import < dump.jsonl` reads stdin line-by-line, skips existing IDs, computes missing embeddings, and inserts. Preserves `id`, `created_at`, `updated_at`, `is_active`, `archived`, `superseded_by` when present. Implemented in `src/export-import.ts`.
- **`match_count` cap on `memory_hybrid_search`.** Default cap 200, configurable via a PG setting: `SET mnestra.max_match_count = 500` (per-session) or `ALTER DATABASE … SET mnestra.max_match_count = 500` (persistent). The function was previously unbounded.
- **`memory_hybrid_search_explain`.** New SQL function returning `EXPLAIN (ANALYZE, BUFFERS)` output for the equivalent `memory_hybrid_search` call. Used by admin tooling (`mnestra diagnose`) to debug slow recall queries on large stores.
- **Unit test infrastructure.** New `tsconfig.tests.json` + `npm test` script (`tsc -p tsconfig.tests.json && node --test 'dist-tests/tests/**/*.test.js'`). 21 `node:test` cases across webhook dispatch, three-layer round-trip, privacy redaction edge cases, and error handling. No new runtime dependencies — `node:http`, `node:readline`, and `node:test` are built in.

### Changed
- **`POST /mnestra` with malformed JSON returns 400, not 500.** `readJsonBody` now throws a tagged `HttpError(400, 'invalid JSON body')` which the outer handler honours. New integration test boots the webhook server on port 0 and POSTs `"not json"` to assert the 400. Other thrown errors still default to 500.
- `memory_get` now SELECTs an explicit column list (no `embedding`) so its row shape exactly matches `GET /observation/:id`. Embeddings were never useful for citation callers and inflated responses by ~6 KB each.
- `README.md` tool reference table updated to list all nine MCP tools and the new HTTP surface.
- `migrations/003_mnestra_event_webhook.sql` stays as a placeholder — the webhook implementation lives in-process (`src/webhook-server.ts`), not in SQL. `migrations/004_mnestra_match_count_cap_and_explain.sql` is the new file.

## [0.1.0] - 2026-04-11

### Added
- Six MCP tools: `memory_remember`, `memory_recall`, `memory_search`, `memory_forget`, `memory_status`, `memory_summarize_session`
- `memory_items`, `memory_sessions`, `memory_relationships` schema with vector(1536) and HNSW indexing
- `memory_hybrid_search` SQL function with reciprocal rank fusion over full-text + semantic search
- `consolidateMemories` background job for clustering and merging near-duplicates via Claude Haiku
- Programmatic API at `@jhizzard/mnestra` for embedding Mnestra inside other Node tools
- Migrations split into three numbered files for clean upgrade history
- Full documentation: `README.md`, `docs/SCHEMA.md`, `docs/SOURCE-TYPES.md`, `docs/INTEGRATION.md`, `docs/RAG-FIXES-APPLIED.md`

### Fixed (the six RAG fixes from RAG-MEMORY-IMPROVEMENTS-AND-TERMDECK-STRATEGY.md)
- **Fix 1 — Tiered recency decay by source_type.** `memory_hybrid_search` now applies a `CASE source_type` decay, with one-year half-life for decisions / architecture / preferences, 90 days for facts, 30 days for bug fixes, 14 days for session summaries and document chunks. Implemented in `migrations/002_mnestra_search_function.sql`.
- **Fix 2 — Minimum result count in `memory_recall`.** `memoryRecall` always returns at least `min_results` (default 5) hits when that many exist, regardless of token budget or score threshold. Implemented in `src/recall.ts`.
- **Fix 3 — Source-type weighting inside the SQL function.** Decisions get a 1.5x multiplier, architecture 1.4x, bug fixes 1.3x, preferences 1.2x, document chunks 0.6x. Applied before `LIMIT` so important memories survive truncation. Implemented in `migrations/002_mnestra_search_function.sql`.
- **Fix 4 — Memory consolidation background job + looser dedup threshold.** New `consolidateMemories` function clusters memories at >0.85 similarity and merges them via Haiku. Dedup threshold in `memoryRemember` lowered from 0.92 to 0.88. Implemented in `src/consolidate.ts` and `src/remember.ts`.
- **Fix 5 — Project affinity scoring.** Exact project match multiplies score by 1.5x, the special `global` project by 1.0x, and unrelated projects by 0.7x. Implemented in `migrations/002_mnestra_search_function.sql`.
- **Fix 6 — Real-time event ingestion path documented.** `migrations/003_mnestra_event_webhook.sql` is a placeholder marker; the live ingestion endpoint will live in the MCP server process. Documented in `docs/RAG-FIXES-APPLIED.md`.

[Unreleased]: https://github.com/jhizzard/mnestra/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jhizzard/mnestra/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jhizzard/mnestra/releases/tag/v0.1.0
