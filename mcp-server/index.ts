#!/usr/bin/env node

/**
 * Mnemos CLI entry point
 *
 * Default (no args): starts the stdio MCP server with six tools:
 *   memory_remember, memory_recall, memory_search, memory_forget,
 *   memory_status, memory_summarize_session.
 *
 * `mnemos serve`: starts the HTTP webhook server (src/webhook-server.ts)
 * instead of the MCP stdio server. The two are additive — existing MCP
 * clients are unaffected.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  memoryRemember,
  memoryRecall,
  memorySearch,
  memoryForget,
  memoryStatus,
  formatStatus,
  memorySummarizeSession,
  memoryIndex,
  memoryTimeline,
  memoryGet,
} from '../src/index.js';
import { startWebhookServer } from '../src/webhook-server.js';
import { exportMemories, importMemories } from '../src/export-import.js';

const subcommand = process.argv[2];

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === prefix) return args[i + 1];
    if (a.startsWith(`${prefix}=`)) return a.slice(prefix.length + 1);
  }
  return undefined;
}

const HELP_TEXT = `mnemos — persistent developer memory (MCP + HTTP)

Usage:
  mnemos                    Start the stdio MCP server (default; backwards compatible)
  mnemos serve              Start the HTTP webhook server on $MNEMOS_WEBHOOK_PORT (default 37778)
  mnemos export [opts]      Stream memory rows as JSONL to stdout
                              --project <name>   only this project
                              --since <ISO-8601> only rows updated on/after timestamp
  mnemos import             Read JSONL from stdin; skip existing IDs, embed missing
  mnemos --help             Show this message
  mnemos --version          Print package version

Environment:
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   required for all operations
  OPENAI_API_KEY                             required for embeddings (remember/recall/index/search)
  MNEMOS_WEBHOOK_PORT                        HTTP port for \`mnemos serve\` (default 37778)

Docs: https://github.com/jhizzard/mnemos
`;

if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
} else if (subcommand === '--version' || subcommand === '-v') {
  // Read version lazily so the CLI doesn't crash if package.json is missing in dev.
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    process.stdout.write(`${pkg.version}\n`);
  } catch {
    process.stdout.write('unknown\n');
  }
  process.exit(0);
} else if (subcommand === 'serve') {
  startWebhookServer();
} else if (subcommand === 'export') {
  const rest = process.argv.slice(3);
  const project = parseFlag(rest, 'project');
  const since = parseFlag(rest, 'since');
  const report = await exportMemories({ project, since, out: process.stdout });
  process.stderr.write(`[mnemos-export] wrote ${report.rows} rows\n`);
} else if (subcommand === 'import') {
  const report = await importMemories({ in: process.stdin });
  process.stderr.write(
    `[mnemos-import] processed=${report.processed} inserted=${report.inserted} skipped=${report.skipped} errors=${report.errors}\n`
  );
} else {
  await startMcpStdio();
}

async function startMcpStdio(): Promise<void> {

const server = new McpServer({
  name: 'mnemos',
  version: '0.2.0',
});

// ── memory_remember ──────────────────────────────────────────────────────

server.registerTool(
  'memory_remember',
  {
    title: 'Remember',
    description:
      'Store a fact, decision, or preference in long-term memory. Use this when you learn something important about the user, project, or codebase that should persist across sessions.',
    inputSchema: {
      text: z.string().describe('The fact or information to remember'),
      project: z.string().default('global').describe('Project name (e.g., "my-app")'),
      category: z
        .enum([
          'technical',
          'business',
          'workflow',
          'debugging',
          'architecture',
          'convention',
          'relationship',
        ])
        .optional()
        .describe('Category of this memory'),
      source_type: z
        .enum(['fact', 'decision', 'preference', 'bug_fix', 'architecture', 'code_context'])
        .default('fact')
        .describe('Type of memory'),
    },
  },
  async ({ text, project, category, source_type }) => {
    try {
      const result = await memoryRemember({
        content: text,
        project: project || 'global',
        source_type: source_type || 'fact',
        category: category ?? null,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory ${result}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
          },
        ],
      };
    } catch (err) {
      console.error('[mnemos-mcp] memory_remember failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_recall ────────────────────────────────────────────────────────

server.registerTool(
  'memory_recall',
  {
    title: 'Recall',
    description:
      'Smart retrieval of relevant memories. Returns concise, deduplicated results within a token budget. Prioritizes decisions and bug fixes over raw document chunks. Always returns at least min_results hits when available. Omit project to search across ALL projects.',
    inputSchema: {
      query: z.string().describe('What to search for in memory'),
      project: z
        .string()
        .optional()
        .describe('Filter by project (omit for cross-project search)'),
      token_budget: z
        .number()
        .default(2000)
        .describe('Max tokens to return (default 2000, ~8000 chars).'),
      min_results: z
        .number()
        .default(5)
        .describe(
          'Minimum number of hits to return if that many exist, regardless of score threshold.'
        ),
    },
  },
  async ({ query, project, token_budget, min_results }) => {
    try {
      const out = await memoryRecall({
        query,
        project: project ?? null,
        token_budget: token_budget || 2000,
        min_results: min_results || 5,
      });
      return { content: [{ type: 'text' as const, text: out.text }] };
    } catch (err) {
      console.error('[mnemos-mcp] memory_recall failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_search ────────────────────────────────────────────────────────

server.registerTool(
  'memory_search',
  {
    title: 'Search Memories',
    description:
      'Low-level hybrid search with filters. Returns raw JSON with scores. Use for detailed exploration or admin tooling.',
    inputSchema: {
      query: z.string().describe('Search query'),
      project: z.string().optional().describe('Filter by project'),
      source_type: z
        .enum(['fact', 'decision', 'preference', 'bug_fix', 'architecture', 'code_context'])
        .optional()
        .describe('Filter by source type'),
      limit: z.number().default(20).describe('Max results'),
    },
  },
  async ({ query, project, source_type, limit }) => {
    try {
      const hits = await memorySearch({
        query,
        project: project ?? null,
        source_type: source_type ?? null,
        limit: limit || 20,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }],
      };
    } catch (err) {
      console.error('[mnemos-mcp] memory_search failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_forget ────────────────────────────────────────────────────────

server.registerTool(
  'memory_forget',
  {
    title: 'Forget',
    description: 'Soft-delete a memory by UUID. The row is archived but preserved.',
    inputSchema: {
      memoryId: z.string().uuid().describe('UUID of the memory to forget'),
    },
  },
  async ({ memoryId }) => {
    try {
      const result = await memoryForget(memoryId);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }] };
      }
      return { content: [{ type: 'text' as const, text: `Memory ${memoryId} archived.` }] };
    } catch (err) {
      console.error('[mnemos-mcp] memory_forget failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_status ────────────────────────────────────────────────────────

server.registerTool(
  'memory_status',
  {
    title: 'Memory Status',
    description:
      'System stats: total active memories, sessions, breakdown by project / source_type / category.',
    inputSchema: {},
  },
  async () => {
    try {
      const report = await memoryStatus();
      return { content: [{ type: 'text' as const, text: formatStatus(report) }] };
    } catch (err) {
      console.error('[mnemos-mcp] memory_status failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_summarize_session ─────────────────────────────────────────────

server.registerTool(
  'memory_summarize_session',
  {
    title: 'Summarize Session',
    description:
      'Extract discrete facts from text (a session transcript, document, or any text) and store them as memories. Uses Claude Haiku.',
    inputSchema: {
      text: z.string().describe('The text to extract facts from'),
      project: z.string().default('global').describe('Project name'),
    },
  },
  async ({ text, project }) => {
    try {
      const result = await memorySummarizeSession(text, project || 'global');
      if (result.total === 0) {
        return { content: [{ type: 'text' as const, text: 'No facts extracted from the text.' }] };
      }
      const summary = result.facts
        .map((f, i) => `${i + 1}. [${f.category ?? 'uncategorized'}/${f.importance}] ${f.content}`)
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Extracted ${result.total} facts: ${result.inserted} stored, ${result.updated} updated, ${result.skipped} skipped.\n\n${summary}`,
          },
        ],
      };
    } catch (err) {
      console.error('[mnemos-mcp] memory_summarize_session failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_index ─────────────────────────────────────────────────────────

server.registerTool(
  'memory_index',
  {
    title: 'Memory Index',
    description:
      'Three-layer search — step 1. Returns a compact index of matching memories (≤120-char snippet, source_type, project, created_at). Use this first; drill into IDs with memory_get, or surround with memory_timeline. Much cheaper in tokens than memory_recall.',
    inputSchema: {
      query: z.string().describe('Search query'),
      project: z.string().optional().describe('Filter by project'),
      source_type: z
        .enum(['fact', 'decision', 'preference', 'bug_fix', 'architecture', 'code_context'])
        .optional()
        .describe('Filter by source type'),
      limit: z.number().default(20).describe('Max results'),
    },
  },
  async ({ query, project, source_type, limit }) => {
    try {
      const hits = await memoryIndex({
        query,
        project: project ?? null,
        source_type: source_type ?? null,
        limit: limit || 20,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    } catch (err) {
      console.error('[mnemos-mcp] memory_index failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_timeline ──────────────────────────────────────────────────────

server.registerTool(
  'memory_timeline',
  {
    title: 'Memory Timeline',
    description:
      'Three-layer search — step 2. Returns memories from the same project chronologically surrounding either a query hit or a specific observation ID. Compact shape matches memory_index. Use after memory_index when you want temporal context.',
    inputSchema: {
      query: z.string().optional().describe('Query to locate the anchor memory (optional)'),
      around_id: z
        .string()
        .uuid()
        .optional()
        .describe('Anchor by an explicit memory UUID (optional)'),
      window: z
        .enum(['1h', '24h', '7d'])
        .default('24h')
        .describe('Time window around the anchor'),
    },
  },
  async ({ query, around_id, window }) => {
    try {
      const hits = await memoryTimeline({
        query,
        around_id,
        window: window || '24h',
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    } catch (err) {
      console.error('[mnemos-mcp] memory_timeline failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_get ───────────────────────────────────────────────────────────

server.registerTool(
  'memory_get',
  {
    title: 'Memory Get (batch)',
    description:
      'Three-layer search — step 3. Batch-fetch full memory rows by UUID. Pass the IDs returned by memory_index or memory_timeline. Batch-only (up to 100 IDs) to discourage N+1 calls.',
    inputSchema: {
      ids: z
        .array(z.string().uuid())
        .min(1)
        .max(100)
        .describe('Array of memory UUIDs to fetch (1–100)'),
    },
  },
  async ({ ids }) => {
    try {
      const rows = await memoryGet({ ids });
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (err) {
      console.error('[mnemos-mcp] memory_get failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── Start Server ─────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mnemos-mcp] mnemos MCP server listening on stdio');
}
