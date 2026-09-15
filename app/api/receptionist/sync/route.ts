import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import {
  RECEPTIONIST_ADDON_AMOUNT_DISPLAY,
  loadReceptionistBilling,
  syncReceptionistAddonForUser,
  syncReceptionistAddonFromCheckoutSession,
} from '@/lib/receptionist-billing';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receptionist/sync
 * Body: { sessionId? } — pull Stripe subscription into app after checkout.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const sessionId = String(body.sessionId || '').trim();

    let result;
    if (sessionId) {
      result = await syncReceptionistAddonFromCheckoutSession(sessionId, user.id);
    } else {
      result = await syncReceptionistAddonForUser(user.id);
    }

    const billing =
      ('billing' in result && result.billing) || (await loadReceptionistBilling(user.id));

    return NextResponse.json({
      ok: result.ok,
      addonActive: result.active,
      subscribed: result.active,
      amountDisplay: RECEPTIONIST_ADDON_AMOUNT_DISPLAY,
      billing,
      error: result.error || null,
      message: result.active
        ? 'AI Receptionist add-on is active (Subscribed).'
        : 'No active AI Receptionist subscription found yet. If you just paid, wait a moment and tap Refresh.',
    });
  } catch (e: any) {
    console.error('receptionist/sync:', e);
    return NextResponse.json({ error: e?.message || 'Sync failed' }, { status: 500 });
  }
}
