/**
 * Per-contractor blocked caller numbers (table public.receptionist_blocked_numbers).
 * Webhooks use the service role; the UI goes through /api/receptionist/blocklist.
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { normalizeBlockPhone } from '@/lib/receptionist-spam';

export const BLOCKLIST_TABLE = 'receptionist_blocked_numbers';

/** Fail open (not blocked) if the table is missing or the lookup errors. */
export async function isCallerBlocked(userId: string, phone: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  const key = normalizeBlockPhone(phone);
  if (!admin || !userId || !key) return false;
  try {
    const { data, error } = await admin
      .from(BLOCKLIST_TABLE)
      .select('id')
      .eq('user_id', userId)
      .eq('phone_e164', key)
      .limit(1);
    if (error) {
      console.warn('isCallerBlocked:', error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn('isCallerBlocked:', e);
    return false;
  }
}
