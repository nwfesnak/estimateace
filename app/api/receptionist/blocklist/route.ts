import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { BLOCKLIST_TABLE } from '@/lib/receptionist-blocklist';
import { normalizeBlockPhone } from '@/lib/receptionist-spam';

export const dynamic = 'force-dynamic';

/** Supabase client acting as the signed-in owner, so RLS (owner-only) applies. */
function userClient(request: NextRequest) {
  const token = (request.headers.get('authorization') || '').slice(7);
  return createClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim(),
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim(),
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}

/** GET /api/receptionist/blocklist — numbers this owner blocked */
export async function GET(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
  const { data, error: dbError } = await userClient(request)
    .from(BLOCKLIST_TABLE)
    .select('phone_e164, reason, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(500);
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  return NextResponse.json({ numbers: data || [] });
}

/** POST /api/receptionist/blocklist { phone, reason?, leadId? } — "Mark as spam" */
export async function POST(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizeBlockPhone(String(body?.phone || ''));
  if (!phone || phone.replace(/\D/g, '').length < 7) {
    return NextResponse.json({ error: 'A valid caller phone number is required.' }, { status: 400 });
  }
  const { error: dbError } = await userClient(request)
    .from(BLOCKLIST_TABLE)
    .upsert(
      {
        user_id: user.id,
        phone_e164: phone,
        reason: String(body?.reason || 'Marked as spam').slice(0, 200),
        source_lead_id: body?.leadId ? String(body.leadId).slice(0, 80) : null,
      },
      { onConflict: 'user_id,phone_e164', ignoreDuplicates: true }
    );
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  return NextResponse.json({ ok: true, phone });
}

/** DELETE /api/receptionist/blocklist { phone } — unblock */
export async function DELETE(request: NextRequest) {
  const { user, error } = await getUserFromRequest(request);
  if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const phone = normalizeBlockPhone(String(body?.phone || ''));
  if (!phone) return NextResponse.json({ error: 'phone is required' }, { status: 400 });
  const { error: dbError } = await userClient(request)
    .from(BLOCKLIST_TABLE)
    .delete()
    .eq('user_id', user.id)
    .eq('phone_e164', phone);
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  return NextResponse.json({ ok: true, phone });
}
