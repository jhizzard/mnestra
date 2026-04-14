# Contributing to Mnemos

Thanks for your interest in Mnemos. This is a small solo project right now, but contributions are welcome.

## Before opening a PR

1. **Open an issue first** for any non-trivial change. A 5-minute discussion can save a 5-hour PR rewrite.
2. **Check the existing issues** to make sure you're not duplicating work.
3. **Match the code style** — TypeScript with strict mode, NodeNext modules, no build tools beyond `tsc`. If you find yourself wanting to add a bundler or a framework, please open an issue first.

## What I'm looking for

- **Bug fixes** — especially anything Postgres-version-specific (HNSW, pgvector quirks, RLS edge cases)
- **Adapter examples** — recipes for wiring Mnemos into editors and tools other than Claude Code, Cursor, Windsurf
- **SQL improvements** — better recall ranking, smarter project affinity, additional decay profiles
- **Tests** — there are none in v0.1; a Vitest harness against a local Postgres would be very welcome
- **Documentation improvements** — especially worked examples of `memory_summarize_session` against real session transcripts

## What I'd rather you discuss first

- Major architectural changes (e.g. swapping Supabase for a different vector store, adding an agent framework)
- New external dependencies — Mnemos intentionally has a small dep tree
- Anything that changes the migration history (rename, reorder, or rewrite an applied migration)
- Anything that changes the MCP tool surface (the six tool names and their input schemas are part of the public contract)

## Local setup

```bash
git clone https://github.com/jhizzard/mnemos.git
cd mnemos
npm install
npm run typecheck
npm run build
```

To smoke-test against a real database, set the env vars and run the server directly:

```bash
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
export OPENAI_API_KEY=...
node dist/mcp-server/index.js
```

It will block on stdin waiting for MCP messages, which is correct.

## Code conventions

- **Logging:** every `console.error` and `console.log` must use a `[tag]` prefix. The valid tags are:
  - `[mnemos]` — general
  - `[mnemos-mcp]` — MCP tool calls
  - `[mnemos-search]` — search and recall paths
  - `[mnemos-store]` — remember, dedup, forget
  - `[mnemos-embed]` — embedding generation
  - `[mnemos-consolidate]` — the consolidation background job
- **No silent `catch {}` blocks.** If you swallow an error, log it with the appropriate `[mnemos-*]` tag and an explanation.
- **Strict TypeScript.** No `any` unless interacting with an external untyped surface. No `// @ts-ignore` without a comment explaining why.
- **Commit messages** should be imperative ("Add X" not "Added X") and describe the why, not just the what.
- **No AI co-author trailers** in commit messages. If you used an AI assistant, you can disclose it however you like in your PR description, just not in the commit metadata.

## Migrations

- **Never edit a published migration.** Add a new numbered file instead.
- **Migrations are append-only.** If you need to change a function, write a new `CREATE OR REPLACE FUNCTION` in the next migration file.
- **Test against a fresh database** before submitting — apply all migrations in order, then exercise the affected tools.

## License

By contributing, you agree your contributions are licensed under the same MIT license as the project.
