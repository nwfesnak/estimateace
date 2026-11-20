import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { loadReceptionistConfig } from '@/lib/receptionist-store';
import { RECEPTIONIST_CAPS } from '@/lib/receptionist-caps';
import { currentUsagePeriod, loadReceptionistUsage } from '@/lib/receptionist-usage';
import { requireWorkspaceOwner } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

const minutes = (sec: number) => Math.ceil(Math.max(0, sec) / 60);

/**
 * GET /api/receptionist/usage — this billing period's AI Receptionist usage vs the caps
 * (lib/receptionist-caps.ts). `available: false` means usage can't be read right now, in
 * which case calls are forwarded instead of answered by the AI.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const ws = await requireWorkspaceOwner(user.id, undefined, { requireTab: 'receptionist' });
    if (ws.denied) return ws.denied;
    const targetUserId = ws.ownerUserId;
    const [config, period] = await Promise.all([
      loadReceptionistConfig(targetUserId),
      currentUsagePeriod(targetUserId),
    ]);
    const usage = await loadReceptionistUsage(targetUserId, period);
    const caps = RECEPTIONIST_CAPS;
    return NextResponse.json(
      {
        ok: true,
        available: Boolean(usage),
        phoneNumber: config.twilio?.phoneNumber || null,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        aiMinutesUsed: minutes(usage?.monthAiSeconds || 0),
        aiMinutesCap: caps.monthlyAiMinutes,
        aiMinutesToday: minutes(usage?.dayAiSeconds || 0),
        aiMinutesDailyCap: caps.dailyAiMinutes,
        forwardMinutesUsed: minutes(usage?.monthForwardSeconds || 0),
        forwardMinutesCap: caps.monthlyForwardMinutes,
        leadTextsUsed: usage?.monthSms || 0,
        leadTextsCap: caps.monthlyLeadSms,
        maxCallMinutes: caps.maxCallMinutes,
        callsPerCallerPerHour: caps.callsPerCallerPerHour,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
