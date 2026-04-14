/**
 * Mnemos — memory_recall
 *
 * Smart retrieval. Calls the memory_hybrid_search SQL function (which
 * already applies Fix 1 tiered decay, Fix 3 source_type weighting, and
 * Fix 5 project affinity), then applies:
 *
 *   Fix 2: always return at least min_results (default 5) results if that
 *   many exist, regardless of score threshold. Token budget trimming
 *   happens AFTER the minimum-result guarantee.
 */

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import type { RecallHit, RecallInput } from './types.js';

const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_MIN_RESULTS = 5;
const MAX_CONTENT_LENGTH = 300;

const IMPORTANCE_RANK: Record<string, number> = {
  critical: 3,
  important: 2,
  minor: 1,
};

const TYPE_RANK: Record<string, number> = {
  decision: 5,
  bug_fix: 4,
  preference: 4,
  architecture: 3,
  fact: 3,
  code_context: 2,
  session_summary: 1,
  document_chunk: 0,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen).trimEnd() + '...';
}

function dedupByContent<T extends { content: string }>(results: T[]): T[] {
  const seen: string[] = [];
  return results.filter((m) => {
    const normalized = m.content.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
    for (const prev of seen) {
      const words = new Set(normalized.split(' '));
      const prevWords = prev.split(' ');
      const overlap = prevWords.filter((w) => words.has(w)).length;
      if (overlap / Math.max(words.size, prevWords.length) > 0.7) return false;
    }
    seen.push(normalized);
    return true;
  });
}

function smartRank(results: RecallHit[]): RecallHit[] {
  return [...results].sort((a, b) => {
    const typeDiff = (TYPE_RANK[b.source_type] ?? 1) - (TYPE_RANK[a.source_type] ?? 1);
    if (typeDiff !== 0) return typeDiff;

    const impA = IMPORTANCE_RANK[(a.metadata as { importance?: string })?.importance ?? ''] ?? 1;
    const impB = IMPORTANCE_RANK[(b.metadata as { importance?: string })?.importance ?? ''] ?? 1;
    if (impB !== impA) return impB - impA;

    return (b.score || 0) - (a.score || 0);
  });
}

export interface RecallOutput {
  hits: RecallHit[];
  tokens_used: number;
  text: string;
}

export async function memoryRecall(input: RecallInput): Promise<RecallOutput> {
  const query = input.query.trim();
  if (!query) {
    return { hits: [], tokens_used: 0, text: 'No relevant memories found.' };
  }

  const budget = input.token_budget ?? DEFAULT_TOKEN_BUDGET;
  const minResults = input.min_results ?? DEFAULT_MIN_RESULTS;
  const project = input.project ?? null;

  // Over-fetch so dedup + rank have material to work with.
  const fetchCount = Math.min(Math.max(Math.floor(budget / 50), 10), 40);

  const supabase = getSupabase();
  const embedding = await generateEmbedding(query);

  const { data, error } = await supabase.rpc('memory_hybrid_search', {
    query_text: query,
    query_embedding: formatEmbedding(embedding),
    match_count: fetchCount,
    full_text_weight: 1.0,
    semantic_weight: 1.0,
    rrf_k: 60,
    filter_project: project,
    filter_source_type: null,
  });

  if (error) {
    console.error('[mnemos-search] memory_hybrid_search failed:', error.message);
    return { hits: [], tokens_used: 0, text: `Search error: ${error.message}` };
  }

  const rows = (data ?? []) as RecallHit[];
  if (rows.length === 0) {
    return { hits: [], tokens_used: 0, text: 'No relevant memories found.' };
  }

  // Pipeline: dedup -> rank. Do NOT drop anything on a score threshold here.
  // The SQL function already applies tiered decay + source_type weighting +
  // project affinity; we trust its ordering as a floor.
  const deduped = dedupByContent(rows);
  const ranked = smartRank(deduped);

  // Fix 2: honour min_results first. Build the minimum slice ignoring
  // token budget, then keep adding more hits until the budget is exhausted.
  const lines: string[] = [];
  const kept: RecallHit[] = [];
  let tokensUsed = 0;

  for (let i = 0; i < ranked.length; i++) {
    const m = ranked[i]!;
    const content = truncate(m.content, MAX_CONTENT_LENGTH);
    const projectTag = project ? '' : ` [${m.project}]`;
    const imp = (m.metadata as { importance?: string })?.importance;
    const impTag = imp ? `/${imp}` : '';
    const line = `- (${m.source_type}${impTag})${projectTag} ${content}`;
    const lineTokens = estimateTokens(line);

    const underMinimum = kept.length < minResults;
    const fitsBudget = tokensUsed + lineTokens <= budget;

    if (underMinimum || fitsBudget) {
      lines.push(line);
      kept.push(m);
      tokensUsed += lineTokens;
    } else {
      break;
    }
  }

  const header = `${kept.length} memories (${tokensUsed} tokens${
    project ? `, project: ${project}` : ', all projects'
  }):`;

  return {
    hits: kept,
    tokens_used: tokensUsed,
    text: `${header}\n\n${lines.join('\n')}`,
  };
}
