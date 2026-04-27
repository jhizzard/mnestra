/**
 * Mnestra — relationships unit tests (Sprint 38 / T1)
 *
 * Drives memoryLink / memoryUnlink / memoryRelated against an injected fake
 * Supabase client so the tests never touch the real DB. Asserts:
 *   - input validation (uuid, kind enum, weight range, source≠target)
 *   - link upsert payload + onConflict shape
 *   - link insert-vs-update detection heuristic
 *   - unlink with and without kind filter
 *   - related kind filter only retains paths whose every edge matches
 *   - related rejects depth out of [1, 5]
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryLink, memoryUnlink, memoryRelated } from '../src/relationships.js';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';

interface FakeUpsertCall {
  table: string;
  row: Record<string, unknown>;
  onConflict?: string;
}

interface FakeDeleteCall {
  table: string;
  filters: Record<string, unknown>;
}

function fakeClientForLink(opts: {
  returnRow?: { id: string; created_at: string; inferred_at: string } | null;
  error?: { message: string } | null;
  capture: { calls: FakeUpsertCall[] };
}): any {
  return {
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, options?: { onConflict?: string }) => {
        opts.capture.calls.push({ table, row, onConflict: options?.onConflict });
        return {
          select: () => ({
            maybeSingle: async () => ({
              data: opts.returnRow ?? null,
              error: opts.error ?? null,
            }),
          }),
        };
      },
    }),
  };
}

function fakeClientForUnlink(opts: {
  count: number;
  error?: { message: string } | null;
  capture: { calls: FakeDeleteCall[] };
}): any {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const builder: any = {
        delete: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        then: (resolve: (v: any) => void) => {
          opts.capture.calls.push({ table, filters });
          resolve({ count: opts.count, error: opts.error ?? null });
        },
      };
      return builder;
    },
  };
}

function fakeClientForRelated(opts: {
  rpcRows: Array<{ memory_id: string; depth: number; path: string[]; edge_kinds: string[] }>;
  items: Array<{ id: string; content: string; source_type: string; project: string; created_at: string }>;
}): any {
  return {
    rpc: async (name: string, args: { start_id: string; max_depth: number }) => {
      assert.equal(name, 'expand_memory_neighborhood');
      assert.ok(args.start_id, 'rpc called without start_id');
      assert.ok(typeof args.max_depth === 'number', 'rpc called without max_depth');
      return { data: opts.rpcRows, error: null };
    },
    from: (table: string) => {
      assert.equal(table, 'memory_items');
      const builder: any = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        then: (resolve: (v: any) => void) => {
          resolve({ data: opts.items, error: null });
        },
      };
      return builder;
    },
  };
}

// ── memoryLink ───────────────────────────────────────────────────────────

test('memoryLink rejects non-uuid source_id', async () => {
  await assert.rejects(
    () =>
      memoryLink(
        { source_id: 'not-a-uuid', target_id: UUID_B, kind: 'relates_to' },
        { from: () => ({ upsert: () => ({}) }) } as any
      ),
    /source_id must be a UUID/
  );
});

test('memoryLink rejects when source equals target', async () => {
  await assert.rejects(
    () =>
      memoryLink(
        { source_id: UUID_A, target_id: UUID_A, kind: 'relates_to' },
        { from: () => ({ upsert: () => ({}) }) } as any
      ),
    /must differ/
  );
});

test('memoryLink rejects unknown kind', async () => {
  await assert.rejects(
    () =>
      memoryLink(
        { source_id: UUID_A, target_id: UUID_B, kind: 'bogus_kind' as any },
        { from: () => ({ upsert: () => ({}) }) } as any
      ),
    /kind must be one of/
  );
});

test('memoryLink rejects weight outside [0,1]', async () => {
  await assert.rejects(
    () =>
      memoryLink(
        { source_id: UUID_A, target_id: UUID_B, kind: 'relates_to', weight: 1.5 },
        { from: () => ({ upsert: () => ({}) }) } as any
      ),
    /weight must be between 0 and 1/
  );
});

test('memoryLink upserts with correct onConflict tuple and inferred_by stamp', async () => {
  const capture = { calls: [] as FakeUpsertCall[] };
  const ts = new Date().toISOString();
  const fake = fakeClientForLink({
    returnRow: { id: 'edge-1', created_at: ts, inferred_at: ts },
    capture,
  });

  const result = await memoryLink(
    { source_id: UUID_A, target_id: UUID_B, kind: 'inspired_by', weight: 0.85 },
    fake
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'inserted');
  assert.equal(result.id, 'edge-1');

  assert.equal(capture.calls.length, 1);
  const call = capture.calls[0]!;
  assert.equal(call.table, 'memory_relationships');
  assert.equal(call.onConflict, 'source_id,target_id,relationship_type');
  assert.equal(call.row.source_id, UUID_A);
  assert.equal(call.row.target_id, UUID_B);
  assert.equal(call.row.relationship_type, 'inspired_by');
  assert.equal(call.row.weight, 0.85);
  assert.equal(call.row.inferred_by, 'mcp:memory_link');
});

test('memoryLink detects update when created_at predates inferred_at', async () => {
  const capture = { calls: [] as FakeUpsertCall[] };
  const oldTs = '2026-04-01T00:00:00.000Z';
  const newTs = '2026-04-27T18:55:00.000Z';
  const fake = fakeClientForLink({
    returnRow: { id: 'edge-2', created_at: oldTs, inferred_at: newTs },
    capture,
  });

  const result = await memoryLink(
    { source_id: UUID_A, target_id: UUID_B, kind: 'relates_to' },
    fake
  );

  assert.equal(result.action, 'updated');
});

test('memoryLink surfaces Supabase error in result', async () => {
  const capture = { calls: [] as FakeUpsertCall[] };
  const fake = fakeClientForLink({
    error: { message: 'duplicate key value' },
    capture,
  });

  const result = await memoryLink(
    { source_id: UUID_A, target_id: UUID_B, kind: 'relates_to' },
    fake
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /duplicate key/);
});

// ── memoryUnlink ─────────────────────────────────────────────────────────

test('memoryUnlink without kind filter does not constrain on relationship_type', async () => {
  const capture = { calls: [] as FakeDeleteCall[] };
  const fake = fakeClientForUnlink({ count: 3, capture });

  const result = await memoryUnlink({ source_id: UUID_A, target_id: UUID_B }, fake);

  assert.equal(result.ok, true);
  assert.equal(result.removed, 3);
  assert.equal(capture.calls.length, 1);
  const call = capture.calls[0]!;
  assert.equal(call.filters.source_id, UUID_A);
  assert.equal(call.filters.target_id, UUID_B);
  assert.equal('relationship_type' in call.filters, false);
});

test('memoryUnlink with kind filter scopes the delete', async () => {
  const capture = { calls: [] as FakeDeleteCall[] };
  const fake = fakeClientForUnlink({ count: 1, capture });

  const result = await memoryUnlink(
    { source_id: UUID_A, target_id: UUID_B, kind: 'contradicts' },
    fake
  );

  assert.equal(result.removed, 1);
  const call = capture.calls[0]!;
  assert.equal(call.filters.relationship_type, 'contradicts');
});

test('memoryUnlink rejects unknown kind', async () => {
  await assert.rejects(
    () =>
      memoryUnlink(
        { source_id: UUID_A, target_id: UUID_B, kind: 'invalid' as any },
        { from: () => ({}) } as any
      ),
    /kind must be one of/
  );
});

// ── memoryRelated ────────────────────────────────────────────────────────

test('memoryRelated rejects depth out of range', async () => {
  await assert.rejects(
    () => memoryRelated({ id: UUID_A, depth: 0 }, { rpc: async () => ({ data: [], error: null }) } as any),
    /depth must be an integer/
  );
  await assert.rejects(
    () => memoryRelated({ id: UUID_A, depth: 6 }, { rpc: async () => ({ data: [], error: null }) } as any),
    /depth must be an integer/
  );
});

test('memoryRelated drops depth=0 self-row and hydrates content', async () => {
  const fake = fakeClientForRelated({
    rpcRows: [
      { memory_id: UUID_A, depth: 0, path: [UUID_A], edge_kinds: [] },
      { memory_id: UUID_B, depth: 1, path: [UUID_A, UUID_B], edge_kinds: ['relates_to'] },
      { memory_id: UUID_C, depth: 2, path: [UUID_A, UUID_B, UUID_C], edge_kinds: ['relates_to', 'elaborates'] },
    ],
    items: [
      {
        id: UUID_B,
        content: 'B content',
        source_type: 'fact',
        project: 'termdeck',
        created_at: '2026-04-27T00:00:00.000Z',
      },
      {
        id: UUID_C,
        content: 'C content',
        source_type: 'decision',
        project: 'termdeck',
        created_at: '2026-04-27T01:00:00.000Z',
      },
    ],
  });

  const rows = await memoryRelated({ id: UUID_A, depth: 2 }, fake);

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.memory_id, UUID_B);
  assert.equal(rows[0]!.content, 'B content');
  assert.equal(rows[1]!.memory_id, UUID_C);
  assert.equal(rows[1]!.depth, 2);
});

test('memoryRelated kind filter retains only single-kind paths', async () => {
  const fake = fakeClientForRelated({
    rpcRows: [
      { memory_id: UUID_A, depth: 0, path: [UUID_A], edge_kinds: [] },
      { memory_id: UUID_B, depth: 1, path: [UUID_A, UUID_B], edge_kinds: ['relates_to'] },
      { memory_id: UUID_C, depth: 2, path: [UUID_A, UUID_B, UUID_C], edge_kinds: ['relates_to', 'elaborates'] },
    ],
    items: [
      {
        id: UUID_B,
        content: 'B content',
        source_type: 'fact',
        project: 'termdeck',
        created_at: '2026-04-27T00:00:00.000Z',
      },
    ],
  });

  const rows = await memoryRelated({ id: UUID_A, depth: 2, kind: 'relates_to' }, fake);

  // Only the depth-1 path qualifies (its single edge is relates_to).
  // The depth-2 path mixes relates_to + elaborates and is dropped.
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.memory_id, UUID_B);
});

test('memoryRelated returns empty when neighborhood has only the seed', async () => {
  const fake = fakeClientForRelated({
    rpcRows: [{ memory_id: UUID_A, depth: 0, path: [UUID_A], edge_kinds: [] }],
    items: [],
  });

  const rows = await memoryRelated({ id: UUID_A }, fake);
  assert.equal(rows.length, 0);
});
