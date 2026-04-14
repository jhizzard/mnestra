/**
 * Mnemos — memory_status unit tests
 *
 * Drives memoryStatus() with an injected fake Supabase client so the tests
 * never touch the real DB. The important assertion is that when the
 * `memory_status_aggregation` RPC succeeds, the JS histograms sum back to
 * `total_active` — i.e. the PostgREST 1000-row cap bug is fixed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStatus } from '../src/status.js';

interface FakeClientOpts {
  rpcResult?:
    | {
        data:
          | {
              total_active: number | string;
              sessions: number | string;
              by_project: Record<string, number> | null;
              by_source_type: Record<string, number> | null;
              by_category: Record<string, number> | null;
            }
          | null;
        error: { message: string } | null;
      }
    | 'throw-rpc-missing';
  // for the legacy fallback path only
  rows?: Array<{ project: string; source_type: string; category: string | null }>;
  totalActive?: number;
  sessionCount?: number;
}

function makeFakeClient(opts: FakeClientOpts): any {
  return {
    rpc: async (name: string) => {
      assert.equal(name, 'memory_status_aggregation');
      if (opts.rpcResult === 'throw-rpc-missing') {
        return {
          data: null,
          error: { message: 'function memory_status_aggregation() does not exist' },
        };
      }
      if (opts.rpcResult) return opts.rpcResult;
      return { data: null, error: null };
    },
    from: (table: string) => {
      const ctx: any = { _table: table, _countHead: false };
      const chain = {
        select: (_cols: string, options?: { count?: string; head?: boolean }) => {
          if (options?.head) ctx._countHead = true;
          return chain;
        },
        eq: () => chain,
        then: (resolve: (v: any) => void) => {
          if (ctx._countHead) {
            if (table === 'memory_items')
              resolve({ count: opts.totalActive ?? 0, error: null });
            else if (table === 'memory_sessions')
              resolve({ count: opts.sessionCount ?? 0, error: null });
            else resolve({ count: 0, error: null });
            return;
          }
          if (table === 'memory_items') {
            resolve({ data: opts.rows ?? [], error: null });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return chain;
    },
  };
}

test('memoryStatus uses memory_status_aggregation RPC when available', async () => {
  const fake = makeFakeClient({
    rpcResult: {
      data: {
        total_active: 3397,
        sessions: 42,
        by_project: { termdeck: 1200, mnemos: 1000, rumen: 1197 },
        by_source_type: { fact: 2000, decision: 900, bug_fix: 497 },
        by_category: { technical: 3397 },
      },
      error: null,
    },
  });

  const report = await memoryStatus(fake);

  assert.equal(report.total_active, 3397);
  assert.equal(report.sessions, 42);
  const sumProjects = Object.values(report.by_project).reduce((a, b) => a + b, 0);
  // The whole point of the fix: by_project sums to total_active.
  assert.equal(sumProjects, report.total_active);
  assert.equal(report.by_source_type.fact, 2000);
  assert.equal(report.by_category.technical, 3397);
});

test('memoryStatus normalizes bigint-as-string values from Postgres', async () => {
  // pg/postgrest sometimes returns bigints as strings in JSON.
  const fake = makeFakeClient({
    rpcResult: {
      data: {
        total_active: '3397',
        sessions: '42',
        by_project: { termdeck: 1200 as unknown as number },
        by_source_type: { fact: '2000' as unknown as number },
        by_category: null,
      },
      error: null,
    },
  });

  const report = await memoryStatus(fake);
  assert.equal(report.total_active, 3397);
  assert.equal(report.sessions, 42);
  assert.equal(report.by_project.termdeck, 1200);
  assert.equal(report.by_source_type.fact, 2000);
  assert.deepEqual(report.by_category, {});
});

test('memoryStatus falls back to legacy aggregation if RPC is missing', async () => {
  const fake = makeFakeClient({
    rpcResult: 'throw-rpc-missing',
    totalActive: 3,
    sessionCount: 1,
    rows: [
      { project: 'a', source_type: 'fact', category: 'technical' },
      { project: 'a', source_type: 'fact', category: null },
      { project: 'b', source_type: 'decision', category: 'workflow' },
    ],
  });

  const report = await memoryStatus(fake);
  assert.equal(report.total_active, 3);
  assert.equal(report.sessions, 1);
  assert.deepEqual(report.by_project, { a: 2, b: 1 });
  assert.deepEqual(report.by_source_type, { fact: 2, decision: 1 });
  assert.deepEqual(report.by_category, { technical: 1, uncategorized: 1, workflow: 1 });
});
