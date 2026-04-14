# RAG fixes applied

Mnemos v0.1 ships with all six fixes from `RAG-MEMORY-IMPROVEMENTS-AND-TERMDECK-STRATEGY.md`. This document is the audit trail: what each fix is, where it lives in the codebase, and how to verify it.

## Fix 1 — Tiered recency decay by source type

**Problem.** A flat 30-day half-life crushes architectural decisions from two months ago into the same score band as trivial facts from yesterday. Important long-lived knowledge becomes invisible.

**Fix.** Apply a different decay half-life per `source_type`:

- `decision`, `architecture`, `preference` — 365 days
- `fact`, `convention` — 90 days
- `bug_fix`, `debugging` — 30 days
- `session_summary`, `document_chunk`, `code_context` — 14 days

**Where.** `migrations/002_mnemos_search_function.sql`, inside the `scored` CTE of `memory_hybrid_search`. Search for the comment `Fix 1: tiered recency decay by source_type`.

**How to verify.** Insert a `decision` row dated 60 days ago and a `fact` row dated 60 days ago. Run a recall query that matches both semantically. The decision should rank higher purely on the decay multiplier.

---

## Fix 2 — Minimum result count in `memory_recall`

**Problem.** When all candidate scores cluster low (because of uniform decay or because the query embedding matches everything weakly), a hard quality threshold can drop the result set to zero or one. The user sees "no relevant memories found" when in fact there were 20 plausible hits.

**Fix.** `memoryRecall` honours a `min_results` parameter (default 5). It always returns at least that many hits if they exist, regardless of token budget or score. Token budget trimming only kicks in *after* the minimum is satisfied.

**Where.** `src/recall.ts`. Search for the comment `Fix 2: honour min_results first`.

**How to verify.** Insert ten low-quality memories. Call `memory_recall` with a query that scores all of them weakly. The result should still contain at least 5 hits.

---

## Fix 3 — Source-type weighting inside the SQL function

**Problem.** Re-ranking in the application layer happens *after* `LIMIT`, so important memories that fall outside the SQL function's top-N never get a chance to be promoted. The weighting has to happen inside the SQL function, before the cut.

**Fix.** Multiply the fused score by a `CASE source_type` weight before ordering:

- `decision` × 1.5
- `architecture` × 1.4
- `bug_fix` × 1.3
- `preference` × 1.2
- `fact` × 1.0
- `document_chunk` × 0.6

**Where.** `migrations/002_mnemos_search_function.sql`, inside the `scored` CTE. Search for the comment `Fix 3: source_type weighting`.

**How to verify.** With a mixed corpus (decisions, facts, document chunks), run `memory_search` with `limit: 5`. Decisions should appear above document chunks of comparable raw similarity.

---

## Fix 4 — Memory consolidation background job

**Problem.** The original dedup threshold (0.92) was too tight. Two memories saying "we use Postgres" and "the database is Postgres" would both survive. Over months a project accumulates hundreds of near-duplicates and recall quality decays.

**Fix (two parts).**

1. The dedup threshold in `memory_remember` is lowered to **0.88** (with a hard skip at 0.95). This catches more near-duplicates at write time.
2. A `consolidateMemories` background job clusters surviving rows at >0.85 similarity, asks Claude Haiku to merge each cluster into a single canonical fact, and marks the originals as `is_active = false` with `superseded_by` set.

**Where.**
- Lower dedup threshold: `src/remember.ts`, constant `DEDUP_SIMILARITY_THRESHOLD = 0.88`.
- Consolidation job: `src/consolidate.ts`, function `consolidateMemories`.

**How to verify.** Insert five paraphrases of the same fact. Run `consolidateMemories()`. Check that one canonical row exists with `metadata.consolidated_from` populated, and the originals have `superseded_by` pointing to it.

---

## Fix 5 — Project affinity scoring

**Problem.** Project filtering was binary: either filter to one project or search all of them. There was no middle ground for "prefer this project but allow cross-project hits."

**Fix.** Multiply the fused score by:

- 1.5x when `filter_project` matches the row's project exactly
- 1.0x when the row is in the special `global` project
- 0.7x for any other mismatch

When `filter_project` is `NULL` (cross-project search), no multiplier is applied.

**Where.** `migrations/002_mnemos_search_function.sql`, inside the `scored` CTE. Search for the comment `Fix 5: project affinity scoring`.

**How to verify.** Insert one memory in `project: 'app-a'` and one in `project: 'app-b'` with identical content. Run `memory_recall` with `project: 'app-a'`. The `app-a` memory should rank above the `app-b` memory.

---

## Fix 6 — Real-time event ingestion path

**Problem.** Memories only flowed at end-of-session. For tools like TermDeck that emit live events ("server started", "tests failing"), the user wants those events in memory immediately, not after the session ends.

**Fix.** Mnemos exposes its core functions as a programmatic library (`@jhizzard/mnemos`) so any host process can call `memoryRemember` directly per-event, without spawning a new MCP child each time. The MCP server in `mcp-server/index.ts` is one consumer; embedded library use is the other.

A future v0.2 will add an HTTP webhook server (`/api/memory/event`) so non-Node clients can POST events. `migrations/003_mnemos_event_webhook.sql` is a placeholder marker for that work — the live ingestion logic is application-layer, not SQL.

**Where.**
- Library entry point: `src/index.ts`
- Placeholder migration: `migrations/003_mnemos_event_webhook.sql`
- Documentation of the integration pattern: `docs/INTEGRATION.md`

**How to verify.** Import `memoryRemember` from `@jhizzard/mnemos` in a small Node script and call it in a loop. Confirm rows appear in `memory_items` without spawning the MCP server.
