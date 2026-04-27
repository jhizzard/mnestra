/**
 * Mnestra — graph relationship operations (Sprint 38 / T1)
 *
 *   memoryLink    — connect two memories with a typed relationship.
 *                   Idempotent on (source_id, target_id, relationship_type).
 *   memoryUnlink  — remove an edge (with optional kind filter).
 *   memoryRelated — return the N-hop neighborhood of a memory, optionally
 *                   filtered by relationship kind. Calls the
 *                   expand_memory_neighborhood RPC (migration 009).
 *
 * Design notes:
 *   - Edges are bidirectional for traversal; the table stores them with
 *     a definite (source_id, target_id) but the recursive CTE walks both
 *     directions. Callers should not assume order.
 *   - All inserts via memoryLink stamp inferred_by = 'mcp:memory_link' so
 *     T2's cron-inference output is distinguishable in audit queries.
 *   - The optional `client` parameter mirrors the convention in status.ts
 *     so tests can inject a fake Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import { RELATIONSHIP_TYPES, type RelationshipType } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RELATED_DEFAULT_DEPTH = 2;
const RELATED_MAX_DEPTH = 5;
const RELATED_MIN_DEPTH = 1;

const INFERRED_BY_TOOL = 'mcp:memory_link';

export interface LinkInput {
  source_id: string;
  target_id: string;
  kind: RelationshipType;
  weight?: number | null;
}

export interface LinkResult {
  ok: boolean;
  action: 'inserted' | 'updated';
  id?: string;
  error?: string;
}

export interface UnlinkInput {
  source_id: string;
  target_id: string;
  /** Omit to remove all kinds between the two memories. */
  kind?: RelationshipType;
}

export interface UnlinkResult {
  ok: boolean;
  removed: number;
  error?: string;
}

export interface RelatedInput {
  id: string;
  depth?: number;
  /** Filter the returned set to rows whose path traversed only this kind. */
  kind?: RelationshipType | null;
}

export interface RelatedNode {
  memory_id: string;
  depth: number;
  path: string[];
  edge_kinds: string[];
  content: string | null;
  source_type: string | null;
  project: string | null;
  created_at: string | null;
}

function assertUuid(value: string, field: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
}

function assertKind(value: string, field: string): asserts value is RelationshipType {
  if (!RELATIONSHIP_TYPES.includes(value as RelationshipType)) {
    throw new Error(
      `${field} must be one of: ${RELATIONSHIP_TYPES.join(', ')} (got "${value}")`
    );
  }
}

function assertWeight(value: number | null | undefined): void {
  if (value == null) return;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error('weight must be a number between 0 and 1');
  }
  if (value < 0 || value > 1) {
    throw new Error('weight must be between 0 and 1 inclusive');
  }
}

export async function memoryLink(
  input: LinkInput,
  client?: SupabaseClient
): Promise<LinkResult> {
  assertUuid(input.source_id, 'source_id');
  assertUuid(input.target_id, 'target_id');
  if (input.source_id === input.target_id) {
    throw new Error('source_id and target_id must differ');
  }
  assertKind(input.kind, 'kind');
  assertWeight(input.weight);

  const supabase = client ?? getSupabase();

  const row = {
    source_id: input.source_id,
    target_id: input.target_id,
    relationship_type: input.kind,
    weight: input.weight ?? null,
    inferred_at: new Date().toISOString(),
    inferred_by: INFERRED_BY_TOOL,
  };

  // Upsert against the (source_id, target_id, relationship_type) unique tuple.
  // PostgREST resolves the conflict target by column list — no need to name
  // the auto-generated unique constraint.
  const { data, error } = await supabase
    .from('memory_relationships')
    .upsert(row, { onConflict: 'source_id,target_id,relationship_type' })
    .select('id, created_at, inferred_at')
    .maybeSingle();

  if (error) {
    console.error('[mnestra-relationships] memory_link failed:', error.message);
    return { ok: false, action: 'inserted', error: error.message };
  }
  if (!data) {
    return { ok: false, action: 'inserted', error: 'upsert returned no row' };
  }

  // Heuristic: when created_at and inferred_at are within 1s of each other,
  // treat as a fresh insert. Otherwise the row pre-existed and we updated weight.
  const created = Date.parse((data as { created_at: string }).created_at);
  const inferred = Date.parse((data as { inferred_at: string }).inferred_at);
  const action: LinkResult['action'] =
    Math.abs(inferred - created) < 1000 ? 'inserted' : 'updated';

  return { ok: true, action, id: (data as { id: string }).id };
}

export async function memoryUnlink(
  input: UnlinkInput,
  client?: SupabaseClient
): Promise<UnlinkResult> {
  assertUuid(input.source_id, 'source_id');
  assertUuid(input.target_id, 'target_id');
  if (input.kind !== undefined) assertKind(input.kind, 'kind');

  const supabase = client ?? getSupabase();

  let query = supabase
    .from('memory_relationships')
    .delete({ count: 'exact' })
    .eq('source_id', input.source_id)
    .eq('target_id', input.target_id);

  if (input.kind !== undefined) {
    query = query.eq('relationship_type', input.kind);
  }

  const { error, count } = await query;

  if (error) {
    console.error('[mnestra-relationships] memory_unlink failed:', error.message);
    return { ok: false, removed: 0, error: error.message };
  }

  return { ok: true, removed: count ?? 0 };
}

export async function memoryRelated(
  input: RelatedInput,
  client?: SupabaseClient
): Promise<RelatedNode[]> {
  assertUuid(input.id, 'id');

  const depth = input.depth ?? RELATED_DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < RELATED_MIN_DEPTH || depth > RELATED_MAX_DEPTH) {
    throw new Error(
      `depth must be an integer in [${RELATED_MIN_DEPTH}, ${RELATED_MAX_DEPTH}]`
    );
  }
  if (input.kind != null) {
    assertKind(input.kind, 'kind');
  }

  const supabase = client ?? getSupabase();

  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    'expand_memory_neighborhood',
    { start_id: input.id, max_depth: depth }
  );

  if (rpcError) {
    console.error('[mnestra-relationships] expand_memory_neighborhood failed:', rpcError.message);
    return [];
  }

  type RawRow = {
    memory_id: string;
    depth: number;
    path: string[];
    edge_kinds: string[];
  };

  let rows = ((rpcRows ?? []) as RawRow[]).filter((r) => r.depth > 0);

  const filterKind = input.kind ?? null;
  if (filterKind != null) {
    rows = rows.filter(
      (r) => r.edge_kinds.length > 0 && r.edge_kinds.every((e) => e === filterKind)
    );
  }

  if (rows.length === 0) return [];

  const ids = Array.from(new Set(rows.map((r) => r.memory_id)));

  const { data: items, error: itemsError } = await supabase
    .from('memory_items')
    .select('id, content, source_type, project, created_at')
    .in('id', ids)
    .eq('archived', false);

  if (itemsError) {
    console.error('[mnestra-relationships] memory_items hydrate failed:', itemsError.message);
    return [];
  }

  type ItemRow = {
    id: string;
    content: string;
    source_type: string;
    project: string;
    created_at: string;
  };

  const itemMap = new Map<string, ItemRow>();
  for (const item of (items ?? []) as ItemRow[]) {
    itemMap.set(item.id, item);
  }

  return rows.map((r) => {
    const item = itemMap.get(r.memory_id);
    return {
      memory_id: r.memory_id,
      depth: r.depth,
      path: r.path,
      edge_kinds: r.edge_kinds,
      content: item?.content ?? null,
      source_type: item?.source_type ?? null,
      project: item?.project ?? null,
      created_at: item?.created_at ?? null,
    };
  });
}
