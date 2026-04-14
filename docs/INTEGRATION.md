# Integrating Mnemos

Mnemos is designed to be embedded. The MCP server is the most common entry point, but the same code is published as a programmatic library so you can call it from your own tools.

## With TermDeck

[TermDeck](https://github.com/jhizzard/termdeck) is a browser-based terminal multiplexer with rich metadata overlays. The natural integration is:

1. TermDeck's session lifecycle (open, status change, command run, exit) emits structured events.
2. Each event becomes a `memory_remember` call with `source_type: 'fact'` and `project` set to the TermDeck project tag.
3. The "Ask about this terminal" input in each TermDeck panel becomes a `memory_recall` query scoped to that project.

There are two ways to wire it up:

### Option A — TermDeck as an MCP client

TermDeck spawns Mnemos as a child stdio MCP process and calls the tools directly. This is the cleanest separation: Mnemos doesn't know TermDeck exists.

### Option B — TermDeck imports Mnemos as a library

TermDeck adds `@jhizzard/mnemos` as a dependency and calls the functions directly:

```ts
import { memoryRemember, memoryRecall } from '@jhizzard/mnemos';

await memoryRemember({
  content: 'Server started on port 8080',
  project: 'my-app',
  source_type: 'fact',
  metadata: { terminal_id: 'term-3', event: 'server_start' },
});
```

This avoids the per-call subprocess overhead and is the recommended path for tools that emit a high volume of events.

## With Rumen

[Rumen](https://github.com/jhizzard/rumen) is an async learning layer that reads from any pgvector memory store and writes insights back. To run Rumen on top of Mnemos:

1. Apply the Mnemos migrations to your Postgres instance.
2. Apply the Rumen migrations to the same instance — Rumen creates its own `rumen_*` tables and never touches `memory_items`.
3. Point Rumen at the same `SUPABASE_URL` you gave Mnemos.

Rumen reads via `memory_hybrid_search` (the SQL function Mnemos already exposes) and writes to `rumen_insights`. There is no Mnemos code change required.

## With your own client

The programmatic API is in `src/index.ts`. The shapes you most likely care about:

```ts
import {
  memoryRemember,
  memoryRecall,
  memorySearch,
  memoryForget,
  memoryStatus,
  memorySummarizeSession,
  consolidateMemories,
} from '@jhizzard/mnemos';
```

Every function reads its credentials from environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, optionally `ANTHROPIC_API_KEY`). Set them once at process start and the cached Supabase client handles the rest.

### Running consolidation on a schedule

`consolidateMemories()` is the Fix 4 background job. Run it weekly via cron, GitHub Actions, or a Supabase scheduled function:

```ts
import { consolidateMemories } from '@jhizzard/mnemos';

const report = await consolidateMemories();
console.log(`[mnemos-consolidate] merged ${report.clusters_merged} clusters, superseded ${report.memories_superseded} memories`);
```

It is non-destructive: originals are marked `is_active = false` with `superseded_by` pointing to the canonical replacement. You can revert any merge by clearing those columns.
