/**
 * Mnemos — memory_forget
 *
 * Soft-delete a memory. Sets archived = true and is_active = false. The row
 * stays in the database so relationships and history remain intact.
 */

import { getSupabase } from './db.js';

export async function memoryForget(memoryId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('memory_items')
    .update({ archived: true, is_active: false, updated_at: new Date().toISOString() })
    .eq('id', memoryId);

  if (error) {
    console.error('[mnemos-store] memory_forget failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
