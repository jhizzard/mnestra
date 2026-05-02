/**
 * Mnestra — Sprint 50 T2: source_agent recall filter
 *
 * memoryRecall accepts an optional `source_agents: string[]` filter. The
 * SQL function (memory_hybrid_search, migration 004) does not surface
 * source_agent in its result set — Sprint 50 keeps that hot RPC unchanged
 * and post-filters in JS via a follow-up `select id, source_agent` batch
 * query against memory_items. These tests pin the post-filter contract:
 *
 *   - Filter omitted              → no follow-up query, every RPC row kept.
 *   - Filter empty array          → same as omitted (defensive against
 *                                   MCP clients that pass `[]` as a default).
 *   - Filter ['claude']           → only rows whose source_agent='claude'.
 *   - Filter ['claude','gemini']  → union, in original RPC order.
 *   - Filter ['unknown-agent']    → zero results, "No relevant memories…".
 *   - Rows with NULL source_agent → excluded when any filter is set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryRecall } from '../src/recall.js';

interface FakeRow {
  id: string;
  content: string;
  source_type: string;
  category: string | null;
  project: string;
  metadata: Record<string, unknown>;
  score: number;
  created_at: string;
  source_agent: string | null;
}

const NOW = new Date().toISOString();

function row(id: string, agent: string | null, content = `content-${id}`): FakeRow {
  return {
    id,
    content,
    source_type: 'fact',
    category: null,
    project: 'termdeck',
    metadata: {},
    score: 0.5,
    created_at: NOW,
    source_agent: agent,
  };
}

interface ProbeRecorder {
  rpcCalls: number;
  agentSelectCalls: number;
  selectedIds: string[][];
}

/**
 * Build a fake Supabase client whose `rpc('memory_hybrid_search', …)`
 * returns the supplied rows (without source_agent, matching the real RPC's
 * shape) and whose `from('memory_items').select('id, source_agent').in(…)`
 * returns the source_agent map for the requested IDs (the post-filter
 * batch lookup memoryRecall performs when a filter is set).
 */
function makeFakeClient(rows: FakeRow[], probe?: ProbeRecorder): any {
  return {
    rpc: async (name: string, _args: unknown) => {
      assert.equal(name, 'memory_hybrid_search');
      if (probe) probe.rpcCalls++;
      // Strip source_agent from the RPC result — the real function doesn't
      // return that column. The recall code must batch-query for it.
      const data = rows.map((r) => {
        const { source_agent: _drop, ...rest } = r;
        return rest;
      });
      return { data, error: null };
    },
    from: (table: string) => {
      assert.equal(table, 'memory_items');
      const ctx: { ids: string[] | null } = { ids: null };
      const chain = {
        select: (cols: string) => {
          assert.equal(cols, 'id, source_agent');
          if (probe) probe.agentSelectCalls++;
          return chain;
        },
        in: (col: string, ids: string[]) => {
          assert.equal(col, 'id');
          ctx.ids = ids;
          if (probe) probe.selectedIds.push(ids);
          return chain;
        },
        then: (resolve: (v: unknown) => void) => {
          const data = (ctx.ids ?? []).map((id) => {
            const r = rows.find((row) => row.id === id);
            return { id, source_agent: r ? r.source_agent : null };
          });
          resolve({ data, error: null });
        },
      };
      return chain;
    },
  };
}

const fakeEmbed = async (_text: string) => new Array(1536).fill(0);

const fixture: FakeRow[] = [
  row('00000000-0000-0000-0000-000000000001', 'claude', 'A claude row'),
  row('00000000-0000-0000-0000-000000000002', 'codex', 'A codex row'),
  row('00000000-0000-0000-0000-000000000003', 'gemini', 'A gemini row'),
  row('00000000-0000-0000-0000-000000000004', 'grok', 'A grok row'),
  row('00000000-0000-0000-0000-000000000005', null, 'A historical row'),
];

test('source_agents omitted: no follow-up query, every RPC row kept', async () => {
  const probe: ProbeRecorder = { rpcCalls: 0, agentSelectCalls: 0, selectedIds: [] };
  const client = makeFakeClient(fixture, probe);

  const out = await memoryRecall(
    { query: 'find anything' },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(probe.rpcCalls, 1);
  assert.equal(
    probe.agentSelectCalls,
    0,
    'no batch lookup should fire when filter is omitted'
  );
  assert.equal(out.hits.length, fixture.length);
});

test('source_agents=[] is treated as omitted (no filter, no batch lookup)', async () => {
  const probe: ProbeRecorder = { rpcCalls: 0, agentSelectCalls: 0, selectedIds: [] };
  const client = makeFakeClient(fixture, probe);

  const out = await memoryRecall(
    { query: 'find anything', source_agents: [] },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(
    probe.agentSelectCalls,
    0,
    'empty array must not trigger the post-filter — defensive against MCP clients'
  );
  assert.equal(out.hits.length, fixture.length);
});

test('source_agents=["claude"] keeps only Claude rows', async () => {
  const probe: ProbeRecorder = { rpcCalls: 0, agentSelectCalls: 0, selectedIds: [] };
  const client = makeFakeClient(fixture, probe);

  const out = await memoryRecall(
    { query: 'find', source_agents: ['claude'] },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(probe.agentSelectCalls, 1, 'one batch lookup for the candidate IDs');
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0]!.id, '00000000-0000-0000-0000-000000000001');
});

test('source_agents=["claude","gemini"] keeps the union', async () => {
  const client = makeFakeClient(fixture);

  const out = await memoryRecall(
    { query: 'find', source_agents: ['claude', 'gemini'] },
    { client, generateEmbedding: fakeEmbed }
  );

  const ids = out.hits.map((h) => h.id).sort();
  assert.deepEqual(ids, [
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000003',
  ]);
});

test('source_agents=["nope"] (unknown agent) returns zero hits', async () => {
  const client = makeFakeClient(fixture);

  const out = await memoryRecall(
    { query: 'find', source_agents: ['nope'] },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(out.hits.length, 0);
  assert.match(out.text, /No relevant memories found/);
});

test('NULL source_agent rows are excluded when any filter is set', async () => {
  const client = makeFakeClient(fixture);

  // Filter that would match the NULL-agent row's content but not its agent.
  // Confirms the implementation excludes NULL rows on filter rather than
  // treating NULL as a wildcard.
  const out = await memoryRecall(
    { query: 'find', source_agents: ['claude', 'codex', 'gemini', 'grok'] },
    { client, generateEmbedding: fakeEmbed }
  );

  const ids = out.hits.map((h) => h.id);
  assert.equal(out.hits.length, 4);
  assert.ok(
    !ids.includes('00000000-0000-0000-0000-000000000005'),
    'historical NULL row must be excluded from a filtered recall'
  );
});

test('empty RPC result short-circuits without a follow-up batch lookup', async () => {
  const probe: ProbeRecorder = { rpcCalls: 0, agentSelectCalls: 0, selectedIds: [] };
  const client = makeFakeClient([], probe);

  const out = await memoryRecall(
    { query: 'find', source_agents: ['claude'] },
    { client, generateEmbedding: fakeEmbed }
  );

  assert.equal(probe.agentSelectCalls, 0);
  assert.equal(out.hits.length, 0);
  assert.match(out.text, /No relevant memories found/);
});
