/**
 * Mnemos — Supabase client factory
 *
 * Reads credentials from environment variables only. Never hardcode URLs
 * or keys in this file — if your deployment needs them baked in, pass them
 * via a wrapper script, not by editing source.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!url || !key) {
    console.error(
      '[mnemos] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — set them in your MCP client env'
    );
    throw new Error('Mnemos: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return cached;
}

/**
 * Reset the cached client. Intended for tests only.
 */
export function resetSupabaseClient(): void {
  cached = null;
}
