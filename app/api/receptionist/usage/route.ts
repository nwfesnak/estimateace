import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { loadReceptionistConfig } from '@/lib/receptionist-store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/receptionist/usage?from=&to=
 * Phase 1 stub — returns zeros until UsageMeter pulls Twilio subaccount usage.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const config = await loadReceptionistConfig(user.id);
    const from = request.nextUrl.searchParams.get('from') || '';
    const to = request.nextUrl.searchParams.get('to') || '';
    return NextResponse.json({
      ok: true,
      from: from || null,
      to: to || null,
      phoneNumber: config.twilio?.phoneNumber || null,
      voiceMinutes: 0,
      smsCount: 0,
      numberRent: 0,
      estimatedCost: 0,
      note: 'Usage metering connects in a later phase (Twilio subaccount usage API).',
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
