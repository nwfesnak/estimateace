import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  DEFAULT_RECEPTIONIST_CONFIG,
  normalizeReceptionistConfig,
  toPublicReceptionistConfig,
} from '@/lib/receptionist-config';
import { loadReceptionistConfig, saveReceptionistConfig } from '@/lib/receptionist-store';
import { provisionContractorReceptionistLine } from '@/lib/twilio-receptionist-provision';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receptionist/enable
 * Creates Twilio subaccount + buys a local number, saves config.
 * Requires paid add-on flag OR allow first provision to activate add-on (Phase 1).
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const areaCode = String(body.areaCode || '').replace(/\D/g, '').slice(0, 3);

    // Company name from SETTINGS
    const { data: settings } = await admin
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${user.id}`)
      .maybeSingle();
    const profile = (settings?.profile || {}) as any;
    const businessName = String(profile.company || profile.name || user.email || 'Contractor').slice(
      0,
      80
    );

    const existing = await loadReceptionistConfig(user.id, businessName);
    if (existing.twilio?.phoneNumber && existing.status === 'active') {
      return NextResponse.json({
        ok: true,
        status: 'active',
        phoneNumber: existing.twilio.phoneNumber,
        config: toPublicReceptionistConfig({ ...existing, enabled: true }),
        message: 'Receptionist line already provisioned.',
      });
    }

    let provisioned;
    try {
      provisioned = await provisionContractorReceptionistLine({
        contractorId: user.id,
        friendlyName: businessName,
        areaCode: areaCode || undefined,
      });
    } catch (e: any) {
      const failed = {
        ...DEFAULT_RECEPTIONIST_CONFIG(user.id, businessName),
        ...existing,
        status: 'error' as const,
        enabled: false,
        provisionError: e?.message || 'Twilio provision failed',
      };
      await saveReceptionistConfig(user.id, failed);
      return NextResponse.json(
        { error: e?.message || 'Could not provision Twilio number', status: 'error' },
        { status: 502 }
      );
    }

    const config = normalizeReceptionistConfig(
      {
        ...existing,
        contractorId: user.id,
        enabled: true,
        status: 'active',
        twilio: provisioned.twilio,
        branding: {
          businessName,
          greeting: existing.branding?.greeting || profile.aiReceptionist?.greeting || '',
        },
        transferNumber: existing.transferNumber || profile.phone || '',
        provisionError: undefined,
      },
      user.id,
      businessName
    );

    await saveReceptionistConfig(user.id, config, provisioned.secrets);

    // Mirror On into classic aiReceptionist toggle (reload after save so we don't clobber)
    const { data: refreshed } = await admin
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${user.id}`)
      .maybeSingle();
    const refreshedProfile = (refreshed?.profile || profile || {}) as any;
    await admin.from('estimates').upsert({
      id: `SETTINGS-${user.id}`,
      user_id: user.id,
      jobName: '__settings__',
      documentType: 'settings',
      items: [],
      profile: {
        ...refreshedProfile,
        receptionistConfig: config,
        aiReceptionistAddonActive: true,
        aiReceptionist: {
          ...(refreshedProfile.aiReceptionist || {}),
          enabled: true,
          notifyPhone:
            refreshedProfile.aiReceptionist?.notifyPhone || refreshedProfile.phone || '',
        },
      },
      updated_at: new Date().toISOString(),
    });

    return NextResponse.json({
      ok: true,
      status: 'active',
      phoneNumber: provisioned.twilio.phoneNumber,
      config: toPublicReceptionistConfig(config),
      message: `Your AI line is ready: ${provisioned.twilio.phoneNumber}`,
    });
  } catch (e: any) {
    console.error('receptionist/enable:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
