# Changelog

All notable changes to Mnestra will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned
- Web viewer UI for browsing memories (port 37777), matching the shape `claude-mem` ships.
- Claude Code lifecycle-hooks capture path — auto-ingest tool usage without a client call.
- `mnestra doctor` subcommand — runs `select 1 from memory_items limit 0` (catches GRANT issues), an embedding ping, and an RPC probe; prints a green/red checklist. (Brad's third upstream suggestion 2026-04-28; deferred from 0.3.2.)
- Trust-weighted recall (Path B from `docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md` § Deliverable 2): `trust` JSONB param on `memory_recall` mapping agent → weight so mixed-agent recalls rank Claude rows higher rather than excluding the others. Deferred — Path A (filter) shipped first; revisit after live use exposes whether weights would improve outcomes.

## [0.4.2] - 2026-05-04

### Added — Sprint 51.6 T3 (TermDeck): migration 017 — `memory_sessions` schema reconciliation for the bundled session-end hook

- **NEW migration `017_memory_sessions_session_metadata.sql`** reconciles canonical engram `memory_sessions` (mig 001) with the rag-system writer's richer column set so TermDeck's bundled hook (`@jhizzard/termdeck-stack@0.6.2`) can write a uniform shape on both fresh-canonical installs and Joshua's daily-driver `petvetbid` (which had been receiving rows from a now-overwritten personal hook). Adds nullable columns: `session_id text`, `summary_embedding vector(1536)`, `started_at`, `ended_at`, `duration_minutes`, `messages_count`, `facts_extracted`, `files_changed jsonb default '[]'`, `topics jsonb default '[]'`, `transcript_path text`. Idempotent (`ADD COLUMN IF NOT EXISTS`). Unique constraint on `session_id` is wrapped in a `do`-block scoped by `conrelid = 'public.memory_sessions'::regclass` (catches the case where Joshua's petvetbid already has the constraint from the rag-system bootstrap). HNSW index on `summary_embedding` + ended-at index for recency queries. Verified to apply cleanly on petvetbid in a `BEGIN ... ROLLBACK` transaction probe.

### Notes

- **Cross-repo coordination.** Sprint 51.6 ships this alongside `@jhizzard/termdeck@1.0.2` (audit-upgrade extended to 10 probes including memory_sessions.session_id) and `@jhizzard/termdeck-stack@0.6.2` (bundled hook now writes both `memory_items` AND `memory_sessions` per the rich shape that mig 017 enables). Migration 017 must apply BEFORE the bundled hook starts inserting `memory_sessions` rows on the new schema — orchestrator handles the apply-then-publish ordering at sprint close.
- **Why this migration exists** (architectural context). Sprint 50's bundled session-end hook only writes `memory_items`. Joshua's daily-driver Mnestra had been receiving `memory_sessions` rows from his personal `~/Documents/Graciella/rag-system/src/scripts/process-session.ts` writer until 2026-05-02 13:24 ET when a `termdeck init` overwrote `~/.claude/hooks/memory-session-end.js` with the bundled hook. Since then, `memory_sessions` stopped accumulating. T2 + T1 of Sprint 51.6 reclassified the bug as **Class M — architectural omission, not execution failure**. Mig 017 is the schema half of the fix; the bundled hook in `@jhizzard/termdeck-stack@0.6.2` is the code half. Together they restore parity with Joshua's pre-swap experience AND give every fresh canonical install the rich shape from day one.

## [0.4.0] - 2026-05-02

### Added — Sprint 50 T2 (TermDeck): `source_agent` provenance column + recall filter

- **NEW migration `015_source_agent.sql`** adds `memory_items.source_agent text` (nullable, with a partial index `idx_memory_items_source_agent ON memory_items (source_agent) WHERE source_agent IS NOT NULL`), a column comment that lists the canonical 5-agent set (`claude|codex|gemini|grok|orchestrator|NULL`), and a backwards-compatible backfill — every historical `source_type='session_summary'` row is set to `source_agent='claude'` since only Claude Code shipped a SessionEnd hook before Sprint 50 T1's per-adapter trigger landed. Idempotent (re-running the migration is a no-op). Other historical rows stay NULL — they came from a mix of MCP tools and the rag-system extractor with no clean single-agent attribution.
- **`memoryRecall()` accepts `source_agents?: string[]`** — filter the result set to memories produced by specific source agents. Empty array == omitted (defensive against MCP clients that pass `[]` as a default). When the filter is set, rows with NULL `source_agent` are excluded — historical rows are reachable only from unfiltered recalls. Implementation post-filters via a follow-up `select id, source_agent` batch lookup against `memory_items` rather than rewriting the hot `memory_hybrid_search` RPC; zero overhead when the filter is omitted (the common case), one extra round-trip when it's set. Migration 015 keeps the search RPC's signature stable so `memory_hybrid_search_explain` and admin tooling continue to work without a coordinated DDL change.
- **`memory_recall` MCP tool input schema** gains the `source_agents: z.array(z.enum(['claude','codex','gemini','grok','orchestrator'])).optional()` field — agents using mixed 4+1 sprints can pass `source_agents=['claude']` for trust-grade recall (per Joshua's "trust Claude most" preference documented in `docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md` § Deliverable 2 Path A).
- **NEW dependency injection on `memoryRecall`** — second arg `RecallDeps = { client?, generateEmbedding? }` lets tests bypass the live OpenAI + Supabase calls. Mirrors the existing `memoryStatus(client?)` pattern. No behavior change when omitted.
- **NEW `tests/recall-source-agent.test.ts`** (~7 tests) — pins the post-filter contract: omitted/empty filter is a no-op (one RPC, zero batch lookups); single-agent filter (`['claude']`) returns only matching rows; multi-agent filter returns the union; unknown-agent filter returns zero hits; NULL-source-agent rows are excluded when any filter is set; empty RPC result short-circuits.
- **`SourceAgent` type + `SOURCE_AGENTS` runtime array** exported from `src/types.ts` so adapters in the bundled hook (and downstream consumers) can mirror the canonical set without drift.

### Notes

- **Cross-repo coordination.** Sprint 50 ships this alongside `@jhizzard/termdeck-stack@0.6.0` (which bundles the updated `assets/hooks/memory-session-end.js` with the `source_agent` payload field) and TermDeck server `onPanelClose` (Sprint 50 T1 lane). Migration 015 must apply BEFORE either side starts inserting with the new column — orchestrator handles the apply-then-publish ordering at sprint close. Defensive: PostgREST silently drops unknown columns from inserts, so old hook versions won't crash if they POST without `source_agent` post-migration.
- **Why post-filter, not RPC modification.** Adding a `filter_source_agents text[]` param to `memory_hybrid_search` would require DROP+CREATE FUNCTION (default-parameter additions still change PostgreSQL signatures), which would either break the dependent `memory_hybrid_search_explain` static signature or force a coordinated multi-function migration. The post-filter path is one extra round-trip when the filter is set, zero overhead otherwise — measured cost dominated by latency to Supabase, not row count. Path B's trust-weighted ranking (in Unreleased) requires the SQL modification; if that ships, the post-filter goes away.
- **Validation.** Mnestra full test suite green (existing 42 + 7 new = 49 expected). TypeScript clean. Migration 015 is idempotent and verified against the design doc backfill rule (12 historical session_summary rows expected to land in `source_agent='claude'` post-apply).

## [0.3.4] - 2026-05-02

### Fixed — MCP stdio bypassed `~/.termdeck/secrets.env` fallback (Joshua's 2026-05-02 regression)

- **`loadTermdeckSecretsFallback()` was only invoked for the `serve` subcommand** (`mcp-server/index.ts:124`); the default MCP stdio path (the one Claude Code launches via `claude mcp add mnestra ...`) skipped it entirely. Combined with the parallel `@jhizzard/termdeck-stack@≤0.4.11` bug that wrote literal `${SUPABASE_URL}` / `${SUPABASE_SERVICE_ROLE_KEY}` strings into the MCP env block (Claude Code does not shell-expand MCP env), every `memory_recall` / `memory_remember` / `memory_status` call surfaced as `Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.` even though `~/.termdeck/secrets.env` was correctly populated. Three-layer fix: (1) `loadTermdeckSecretsFallback()` now runs for the default MCP stdio launch and the `export` / `import` subcommands too; (2) NEW helper `isUnexpandedPlaceholder(v)` treats values shaped like `${VAR}` as if the env var were unset, so the fallback overrides them from `secrets.env` instead of bailing out on a non-empty-but-invalid string; (3) the existing concrete-value protection still wins (legitimate runtime env vars are never overridden). Stack-installer companion fix in `@jhizzard/termdeck-stack@0.4.12` rewrites the env writer to read concrete values from `secrets.env` and to repair already-broken `${...}` entries on next stack run.

### Notes

- Verified by running `mnestra` with `SUPABASE_URL='${SUPABASE_URL}'` literal env: the secrets fallback fires (`[mnestra] Loaded N secrets from ~/.termdeck/secrets.env`) and `memory_status` returns the live aggregation (6237 memories at the time of fix). Mnestra full test suite **42/42 green**, no test changes needed (the bug was in entry-point branch routing, which has no direct unit coverage; integration verified manually).
- Defense-in-depth lesson: a fix should both prevent the upstream cause AND survive the upstream cause regressing. Even after `termdeck-stack@0.4.12` ships, an old `~/.claude.json` written by `≤0.4.11` keeps working without manual repair because mnestra now ignores `${...}` placeholders.

## [0.3.3] - 2026-04-29

### Fixed — Sprint 42 T3: package.json `main` and `types` fields

- **`package.json "main": "./dist/index.js"` and `"types": "./dist/index.d.ts"` were broken since v0.2.0** — the actual compiled outputs land at `dist/src/index.js` and `dist/src/index.d.ts` because `tsconfig.json` `"rootDir": "."` plus `"include": ["src/**/*.ts", "mcp-server/**/*.ts"]` preserves the source-tree layout under `dist/`. Consumers haven't hit the bug because npm `bin` (`./dist/mcp-server/index.js`) resolves correctly and the package is consumed via the `mnestra` CLI, not `require('@jhizzard/mnestra')`. Cosmetic-but-correctness fix; pinned by NEW `tests/main-field.test.ts` (3 tests) which asserts `main`, `types`, and `bin.mnestra` all resolve to existing files via `fs.existsSync`.

### Notes

- Bundled as part of the TermDeck Sprint 42 close-out. T3's lane diagnosed both the `main` field gap here and a parallel migration-003 templating gap on the TermDeck side; both ship in the same release wave (`termdeck@0.11.0` / `termdeck-stack@0.4.6` / `mnestra@0.3.3` / `rumen@0.4.4`).
- **Validation.** Mnestra full test suite **42/42 green** (was 39 pre-Sprint-42, +3 from `main-field.test.ts`). `node -e "require('./package.json'); console.log(require.resolve('./dist/src/index.js'))"` resolves cleanly.

## [0.3.2] - 2026-04-28

### Fixed — Brad install incident: silent permission-denied failures (root-caused 2026-04-28)

- **NEW migration `014_explicit_grants.sql`** ships explicit `GRANT` statements that prior migrations relied on Supabase's auto-grant default to provide. Schema-wide on `service_role` (Mnestra's only direct connection role) for tables, plus `service_role / authenticated / anon` for functions, plus `alter default privileges` so any future tables/RPCs we add inherit the same grants automatically. Idempotent — no-op on greenfield projects where the auto-grant default already fired.
- **`src/remember.ts` no longer silently swallows insert/update errors.** Lines 75-82 (update path) and 96-98 (insert path) previously logged to stderr and returned `'skipped'` to the MCP caller — which reads as "deduped" — masking real failures (e.g. missing GRANTs) as expected behavior. Now throws the actual error message; the MCP server, webhook server, and `summarize.ts` all already wrap `memoryRemember` in try/catch and surface `err.message` to the user. `RememberResult` type unchanged.

### Notes

- **Root cause attribution.** Brad Heath surfaced the bug 2026-04-28 against project ref `rrzkceirgciiqgeefvbe` (his "jizzard-brain tools" Mnestra-dedicated Supabase). Symptom: `memory_remember` returned `Memory skipped: "..."`, `memory_status` showed 0 memories, `memory_recall` returned `Search error: permission denied for table memory_items`. He proved the Postgres `service_role` had no SELECT/INSERT/UPDATE on `memory_items` via direct curl with the literal JWT (HTTP 403, code 42501) — ruling out env propagation, RLS, and anon-key fallback. Applied the schema-wide fix as a one-shot migration; verified end-to-end (insert + status + recall) with the same env vars and MCP process — confirms fix is purely at the database GRANT level.
- **Why this only bit some installs.** Supabase auto-grants public-schema privileges to anon/authenticated/service_role only when (a) the creating role is `postgres` or another role in the auto-grant chain AND (b) the project's default privileges in schema public haven't been tightened. Projects where one of those preconditions failed silently lost the GRANTs; users got the misleading "Memory skipped" return with no diagnostic.
- **Validation.** TypeScript clean, full test suite 39/39 pass, including `dispatchOp wraps thrown errors as 500` which confirms the webhook layer correctly renders thrown errors as `{ ok: false, error: <message> }`.

## [0.3.1] - 2026-04-28

### Added — Sprint 41 mirror migrations (TermDeck Sprint 41 close-out)

- **NEW migration `012_project_tag_re_taxonomy.sql`** (397 LOC, byte-identical mirror of TermDeck's bundled copy). Re-tags historical chopin-nashville rows using the new project taxonomy. Eight buckets (broadest-first): termdeck, rumen, podium, chopin-in-bohemia, chopin-scheduler+Maestro alias, pvb, claimguard, dor. Idempotent on re-run. `[012-retaxonomy]` RAISE NOTICE prefix on all 11 probes. Live-applied at TermDeck Sprint 41 close: 957 → 896 chopin-nashville rows after the deterministic pass.
- **NEW migration `013_reclassify_uncertain.sql`** (39 LOC). Adds `reclassified_by text` + `reclassified_at timestamptz` columns to `memory_items` plus a partial index filtered to non-NULL rows (keeps the index small). Idempotent (`add column if not exists`). Used by TermDeck's `scripts/reclassify-chopin-nashville.js` to stamp LLM-classified rows for audit + idempotent re-runs. After TermDeck Sprint 41 T4's full reclassify pass landed (~$0.18 Anthropic spend, 896 rows classified across 45 batches with zero errors), the chopin-nashville count dropped 896 → 40.

### Notes

- These migrations ship in the TermDeck-bundled `mnestra-migrations/` directory at the same time. The TermDeck migration runner (bundled-FIRST per v0.6.8+) picks them up automatically on a fresh install. The Mnestra-repo copies are for direct-`psql` users who consume `@jhizzard/mnestra` standalone.
- No `dist/` changes — these are SQL-only additions. Mnestra package.json `files` array already includes `migrations/`.

## [0.3.0] - 2026-04-27

### Added — Knowledge graph MCP layer (TermDeck Sprint 38)

- **Three new MCP tools for graph operations.** `memory_link(source_id, target_id, kind, weight?)` connects two memories with a typed relationship (idempotent on the `(source_id, target_id, kind)` tuple via `ON CONFLICT DO UPDATE`); `memory_unlink(source_id, target_id, kind?)` removes one or all relationship types between two memories; `memory_related(id, depth=2, kind=*)` returns the N-hop neighborhood of a memory with optional kind filtering. Implementation in NEW `src/relationships.ts` (~225 LOC). Full input validation: UUID format on both endpoints, `kind` constrained to the 8-value enum, `weight ∈ [0, 1]`, `depth ∈ [1, 5]`, `source_id ≠ target_id`. Tool inserts stamp `inferred_by = 'mcp:memory_link'` so audit queries can split MCP-direct edges from cron-inferred and ingest-time edges. NEW `tests/relationships.test.ts` (~290 LOC, **14 tests**, all pass): input rejection paths, upsert payload + onConflict tuple, insert-vs-update detection heuristic, kind-filter scoping, depth boundary rejection, empty-neighborhood handling.
- **`memory_recall_graph` MCP tool — graph-aware recall.** Two-stage recall: vector seed via `match_memories` → graph expansion via `expand_memory_neighborhood` → re-rank by `vector_score × edge_weight × recency_score`. NEW `src/recall_graph.ts` (~125 LOC) wraps the Postgres RPC defined in migration 010; reuses the existing `generateEmbedding` + `formatEmbedding` + `getSupabase` helpers. Returns `{ hits: GraphRecallHit[], depth_distribution: Record<number, number>, text: string }` where `text` rendering uses a `(d{depth} {final_score})` prefix so callers can eyeball vector-vs-graph hits at a glance. Tool registers with zod input schema (`query`, `project?`, `depth ∈ [1, 5]` default 2, `k ∈ [1, 50]` default 10).
- **8-value `RelationshipType` union extended in `src/types.ts`.** Existing 5 values from migration 001 (`supersedes`, `relates_to`, `contradicts`, `elaborates`, `caused_by`) plus three new (`blocks`, `inspired_by`, `cross_project_link`). New runtime `RELATIONSHIP_TYPES` array exported for validation. Underscore convention preserved (existing 749 rag-system-classified edges in production already use it).
- **NEW migration `009_memory_relationship_metadata.sql`** (110 LOC, byte-identical mirror in TermDeck `packages/server/src/setup/mnestra-migrations/`). Adds three columns to `memory_relationships` (`weight float`, `inferred_at timestamptz`, `inferred_by text`); expands the relationship-type CHECK from 5 to 8 values via a `DO $$ pg_constraint walk $$` block (the original CHECK from migration 001 is anonymous, defined inline; a hardcoded `DROP CONSTRAINT IF EXISTS memory_relationships_relationship_type_check` would silently no-op against the live DB and leave both old and new CHECKs racing for the column); adds the new CHECK with an explicit name so future migrations can target it cleanly. Creates `expand_memory_neighborhood(start_id uuid, max_depth int default 2) RETURNS TABLE (memory_id uuid, depth int, path uuid[], edge_kinds text[])` — recursive CTE traversing edges bidirectionally (CASE-WHEN flips source/target during recursion so reachability is symmetric — graph-aware recall benefits from undirected expansion), cycle-safe via `NOT (next_id = ANY (path))`. Idempotent. Adds two partial indexes on `weight` and `inferred_at` for traversal hot paths.
- **NEW migration `010_memory_recall_graph.sql`** (147 LOC, byte-identical in both repos). Defines `memory_recall_graph(query_embedding vector(1536), project_filter text DEFAULT NULL, max_depth int DEFAULT 2, k int DEFAULT 10) RETURNS TABLE`. Two-stage CTE: `match_memories` for vector seeds → `expand_memory_neighborhood` for graph expansion → re-rank by `vector_score × edge_weight × recency_score` (30-day half-life via `exp(-age_seconds / (30 * 86400))`) → `LIMIT 50`. Path-edge weight uses `coalesce(r.weight, 0.5)` — the 749 pre-edge-inference-cron edges contribute neutrally until the cron's first pass populates real weights. `DISTINCT ON (memory_id) ... ORDER BY memory_id, final_score DESC, depth ASC` keeps the strongest path when a memory is reachable multiple ways. Path-edge lookup is undirected (CASE-WHEN matches A→B or B→A) — aligns with `expand_memory_neighborhood`'s bidirectional contract.

### Notes

- **Migration ordering at deploy:** apply 009 before 010 (010 depends on `expand_memory_neighborhood`). Both are idempotent on second run. The TermDeck migration runner globs alphabetically so fresh installs handle this automatically; live-DB application is single-shot via psql in the orchestrator close-out flow.
- **The 749 existing edges populated by `rag-system`'s MCP-side classifier** (`~/Documents/Graciella/rag-system/src/lib/relationships.ts`, called from `detectAndStoreRelationships()` after every `memory_remember`) are **preserved untouched** by migration 009. Every existing `relationship_type` value is in the new 8-value CHECK; rows have `weight = NULL / inferred_at = NULL / inferred_by = NULL`. The TermDeck Sprint 38 T2 cron's first pass backfills `weight` onto these via `ON CONFLICT DO UPDATE` when existing rows have `weight IS NULL`. The two classifiers (rag-system at ingest time, T2 cron periodic) coexist with distinct `inferred_by` namespaces and no role overlap.
- **Test status:** Mnestra full suite **39/39 pass** (was 25 pre-Sprint-38, +14 from `relationships.test.ts`). TypeScript clean.
- **Dependency on TermDeck v0.10.0:** the migration 003 pg_cron schedule and the `graph-inference` Edge Function ship in TermDeck (Rumen-side); a fresh Mnestra install without TermDeck stack-installer would have the SQL substrate (009 + 010) but not the inference pipeline. That's intentional — Mnestra is the storage + tools layer; the cron is product-specific to the TermDeck stack.

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
