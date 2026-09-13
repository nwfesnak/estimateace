import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import {
  loadReceptionistConfig,
  loadReceptionistSecrets,
  saveReceptionistConfig,
} from '@/lib/receptionist-store';
import { toPublicReceptionistConfig } from '@/lib/receptionist-config';
import { releaseContractorNumber } from '@/lib/twilio-receptionist-provision';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receptionist/disable
 * Body: { releaseNumber?: boolean }
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const releaseNumber = body.releaseNumber === true;

    const config = await loadReceptionistConfig(user.id);
    if (!config.twilio?.phoneNumber) {
      return NextResponse.json({
        ok: true,
        status: 'none',
        config: toPublicReceptionistConfig({ ...config, enabled: false, status: 'none' }),
        message: 'No receptionist line to disable.',
      });
    }

    if (releaseNumber && config.twilio.numberSid && config.twilio.subaccountSid) {
      const secrets = await loadReceptionistSecrets(user.id);
      if (secrets?.subaccountAuthToken) {
        try {
          await releaseContractorNumber({
            subaccountSid: config.twilio.subaccountSid,
            subaccountAuthToken: secrets.subaccountAuthToken,
            numberSid: config.twilio.numberSid,
          });
        } catch (e: any) {
          console.warn('receptionist/disable release:', e?.message || e);
        }
      }
    }

    const next = {
      ...config,
      enabled: false,
      status: (releaseNumber ? 'none' : 'disabled') as 'none' | 'disabled',
      twilio: releaseNumber ? null : config.twilio,
      provisionError: undefined,
    };
    await saveReceptionistConfig(user.id, next);

    return NextResponse.json({
      ok: true,
      status: next.status,
      phoneNumber: next.twilio?.phoneNumber || null,
      config: toPublicReceptionistConfig(next),
      message: releaseNumber
        ? 'Receptionist disabled and number released.'
        : 'Receptionist disabled. Number kept for later.',
    });
  } catch (e: any) {
    console.error('receptionist/disable:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
