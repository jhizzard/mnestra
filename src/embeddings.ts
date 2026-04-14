/**
 * Mnemos — OpenAI embedding wrapper
 *
 * Uses text-embedding-3-large at 1536 dimensions. This matches the
 * vector(1536) column in migrations/001_mnemos_tables.sql and the HNSW
 * indexes. If you change the model or dimensions, you must reindex.
 */

interface RetryOpts {
  maxRetries?: number;
  baseDelay?: number;
  label?: string;
}

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, label = 'operation' } = opts;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { status?: number; code?: string };
      const retryable =
        e?.status === 429 ||
        e?.status === 500 ||
        e?.status === 502 ||
        e?.status === 503 ||
        e?.code === 'ECONNRESET' ||
        e?.code === 'ETIMEDOUT';

      if (!retryable || attempt === maxRetries) {
        console.error(`[mnemos-embed] ${label} failed:`, err);
        throw err;
      }

      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`[mnemos-embed] ${label} failed after ${maxRetries} retries`);
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) {
    console.error('[mnemos-embed] missing OPENAI_API_KEY');
    throw new Error('Mnemos: OPENAI_API_KEY is required for embedding generation');
  }

  return withRetry(async () => {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-large',
        input: text,
        dimensions: 1536,
      }),
    });

    if (!response.ok) {
      const err = new Error(`[mnemos-embed] OpenAI embedding error: ${response.status}`) as Error & {
        status?: number;
      };
      err.status = response.status;
      throw err;
    }

    const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = data?.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error('[mnemos-embed] OpenAI returned no embedding');
    }
    return embedding;
  }, { label: 'embedding' });
}

/** Format an embedding as the pgvector string literal Supabase RPCs expect. */
export function formatEmbedding(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
