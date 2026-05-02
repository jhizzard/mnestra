-- Mnestra v0.4.0 — source_agent provenance column on memory_items
--
-- Sprint 50 T2 (TermDeck). Adds an LLM-provenance tag to every memory row
-- so future memory_recall callers can filter or trust-weight by the agent
-- that produced the row (Claude / Codex / Gemini / Grok / orchestrator).
--
-- Why now:
--   Sprint 49 (mixed-agent dogfood, 2026-05-02) surfaced a trust-fundamental
--   gap. Each lane's panel produced real work; only Claude's hook wrote to
--   Mnestra. Sprint 50 closes both halves of that gap — T1 fires the hook
--   for every adapter at panel close (write-side); T2 (this migration) adds
--   the read-side ability to filter by source. Without this column,
--   memory_recall returns a careful Claude observation alongside (e.g.) a
--   Gemini-produced timestamp claim, with no way to tell them apart at the
--   recall consumer. See docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md
--   § Deliverable 2 in the TermDeck repo for the full design.
--
-- Backwards compatibility:
--   Historical rows stay NULL (no destructive default backfill on archived
--   data). The recall filter treats NULL as "unknown agent" — rows with
--   NULL source_agent are excluded from a filtered recall and included in
--   an unfiltered one.
--
--   Exception: pre-Sprint-50 session_summary rows came exclusively from
--   Claude Code's SessionEnd hook (only Claude shipped a hook system before
--   Sprint 50 T1 added per-agent triggers). Backfill those to 'claude' so
--   they remain reachable via source_agents=['claude']. Other source_types
--   (fact / decision / preference / bug_fix / architecture / code_context)
--   came from a mix of MCP tools and the rag-system extractor — no clean
--   single-agent attribution exists for them, so they stay NULL.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- and the backfill UPDATE skips rows already populated.

alter table memory_items
  add column if not exists source_agent text;

create index if not exists idx_memory_items_source_agent
  on memory_items (source_agent)
  where source_agent is not null;

comment on column memory_items.source_agent is
  'Agent that produced this memory: claude|codex|gemini|grok|orchestrator|NULL (historical or unknown). Populated by the SessionEnd hook from Sprint 50 onward; NULL for pre-Sprint-50 rows except session_summary which were always Claude (backfilled).';

-- Backfill historical session_summary rows. These came from Claude Code's
-- SessionEnd hook (only Claude shipped a hook system before Sprint 50 T1).
-- Idempotent — re-running this UPDATE on already-tagged rows is a no-op.
update memory_items
  set source_agent = 'claude'
  where source_type = 'session_summary'
    and source_agent is null;
