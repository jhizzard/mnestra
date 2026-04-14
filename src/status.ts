/**
 * Mnemos — memory_status
 *
 * Returns total active memory count plus breakdowns by project,
 * source_type, and category.
 */

import { getSupabase } from './db.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StatusReport } from './types.js';

interface AggregationRow {
  total_active: number | string;
  sessions: number | string;
  by_project: Record<string, number> | null;
  by_source_type: Record<string, number> | null;
  by_category: Record<string, number> | null;
}

function toNumber(v: number | string | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

function normalizeBuckets(
  b: Record<string, number> | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!b) return out;
  for (const [k, v] of Object.entries(b)) out[k] = toNumber(v as number | string);
  return out;
}

export async function memoryStatus(client?: SupabaseClient): Promise<StatusReport> {
  const supabase = client ?? getSupabase();

  // Prefer the server-side aggregation RPC (migration 006). It does the
  // GROUP BY in Postgres so we don't hit PostgREST's default 1000-row cap
  // when streaming rows into a JS histogram.
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    'memory_status_aggregation'
  );

  if (!rpcError && rpcRows) {
    const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
      | AggregationRow
      | undefined;
    if (row) {
      return {
        total_active: toNumber(row.total_active),
        sessions: toNumber(row.sessions),
        by_project: normalizeBuckets(row.by_project),
        by_source_type: normalizeBuckets(row.by_source_type),
        by_category: normalizeBuckets(row.by_category),
      };
    }
  }

  if (rpcError) {
    // Migration 006 not applied yet, or RPC permission missing. Fall back
    // to the legacy approach — correct for ≤1000 active rows, capped above
    // that. A one-time warning tells the operator to apply migration 006.
    console.error(
      '[mnemos] memory_status_aggregation RPC unavailable, falling back to legacy client-side aggregation (apply migrations/006_memory_status_rpc.sql to fix):',
      rpcError.message
    );
  }

  const { count: totalActive, error: countError } = await supabase
    .from('memory_items')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .eq('archived', false);

  if (countError) {
    console.error('[mnemos] status count failed:', countError.message);
  }

  const { data: items, error: itemsError } = await supabase
    .from('memory_items')
    .select('project, source_type, category')
    .eq('is_active', true)
    .eq('archived', false);

  if (itemsError) {
    console.error('[mnemos] status breakdown fetch failed:', itemsError.message);
  }

  const { count: sessionCount, error: sessionError } = await supabase
    .from('memory_sessions')
    .select('id', { count: 'exact', head: true });

  if (sessionError) {
    console.error('[mnemos] status session count failed:', sessionError.message);
  }

  const byProject: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byCategory: Record<string, number> = {};

  for (const item of items ?? []) {
    const row = item as { project: string; source_type: string; category: string | null };
    byProject[row.project] = (byProject[row.project] || 0) + 1;
    byType[row.source_type] = (byType[row.source_type] || 0) + 1;
    const cat = row.category || 'uncategorized';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  return {
    total_active: totalActive ?? 0,
    sessions: sessionCount ?? 0,
    by_project: byProject,
    by_source_type: byType,
    by_category: byCategory,
  };
}

export function formatStatus(report: StatusReport): string {
  const lines = [
    `Total active memories: ${report.total_active}`,
    `Sessions processed: ${report.sessions}`,
    '',
    'By Project:',
    ...Object.entries(report.by_project)
      .sort((a, b) => b[1] - a[1])
      .map(([p, c]) => `  ${p}: ${c}`),
    '',
    'By Type:',
    ...Object.entries(report.by_source_type)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `  ${t}: ${c}`),
    '',
    'By Category:',
    ...Object.entries(report.by_category)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `  ${c}: ${n}`),
  ];
  return lines.join('\n');
}
