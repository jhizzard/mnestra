/**
 * Mnemos — memory_remember
 *
 * Store a memory with embedding-based deduplication.
 *
 * Fix 4 (loosened dedup): the similarity threshold for "this is the same
 * thing, don't insert twice" is 0.88. The original internal system used
 * 0.92, which let too many near-duplicates through. Consolidation
 * (src/consolidate.ts) sweeps the remaining overlap later.
 */

import { getSupabase } from './db.js';
import { generateEmbedding, formatEmbedding } from './embeddings.js';
import { stripPrivate } from './privacy.js';
import type { RememberInput, RememberResult, SourceType } from './types.js';

const DEDUP_SIMILARITY_THRESHOLD = 0.88;
const DEDUP_EXACT_SKIP_THRESHOLD = 0.95;

export async function memoryRemember(input: RememberInput): Promise<RememberResult> {
  const rawContent = input.content.trim();
  if (!rawContent) {
    console.error('[mnemos-store] empty content rejected');
    return 'skipped';
  }

  // Strip <private>...</private> blocks BEFORE embedding or storage so
  // no private content ever reaches OpenAI or Supabase.
  const { text: content, hadPrivate } = stripPrivate(rawContent);
  if (!content) {
    console.error('[mnemos-store] content empty after redaction');
    return 'skipped';
  }

  const project = input.project || 'global';
  const sourceType: SourceType = input.source_type || 'fact';
  const category = input.category ?? null;
  const metadata: Record<string, unknown> = { ...(input.metadata || {}) };
  if (hadPrivate) metadata.had_private_content = true;

  const supabase = getSupabase();
  const embedding = await generateEmbedding(content);
  const embeddingLiteral = formatEmbedding(embedding);

  // Look for near-duplicates in the same project.
  const { data: similar, error: matchError } = await supabase.rpc('match_memories', {
    query_embedding: embeddingLiteral,
    match_threshold: DEDUP_SIMILARITY_THRESHOLD,
    match_count: 3,
    filter_project: project,
  });

  if (matchError) {
    console.error('[mnemos-store] match_memories rpc failed:', matchError.message);
  }

  if (similar && similar.length > 0) {
    const top = similar[0];
    if (top.similarity > DEDUP_EXACT_SKIP_THRESHOLD) {
      return 'skipped';
    }

    // Update the existing near-duplicate in place (keeps the id stable
    // for anything that already linked to it).
    const { error: updateError } = await supabase
      .from('memory_items')
      .update({
        content,
        embedding: embeddingLiteral,
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', top.id);

    if (updateError) {
      console.error('[mnemos-store] update failed:', updateError.message);
      return 'skipped';
    }
    return 'updated';
  }

  const { error: insertError } = await supabase.from('memory_items').insert({
    content,
    embedding: embeddingLiteral,
    source_type: sourceType,
    category,
    project,
    metadata,
  });

  if (insertError) {
    console.error('[mnemos-store] insert failed:', insertError.message);
    return 'skipped';
  }

  return 'inserted';
}
