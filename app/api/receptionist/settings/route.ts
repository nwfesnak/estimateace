import { crewPermissionDeniedResponse, requireWorkspaceOwner } from '@/lib/workspace';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  receptionistAddonPaymentRequiredPayload,
  resolveReceptionistAddonAccess,
} from '@/lib/receptionist-billing';
import { loadReceptionistConfig, saveReceptionistConfig } from '@/lib/receptionist-store';

export const dynamic = 'force-dynamic';

/**
 * POST /api/receptionist/settings
 * Server-side SETTINGS write for AI Receptionist (toggle, knowledge, inbox).
 * Never persists enabled:true without an active paid add-on. Turning OFF is always allowed.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const ws = await requireWorkspaceOwner(user.id, undefined, { requireTab: 'receptionist' });
    if (ws.denied) return ws.denied;
    if (ws.isCrew) return crewPermissionDeniedResponse();

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const settingsIn = body.settings && typeof body.settings === 'object' ? body.settings : {};
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, 200) : [];
    const archived = Array.isArray(body.archived) ? body.archived.slice(0, 500) : [];

    const requestedEnabled = settingsIn.enabled === true;
    let enabled = requestedEnabled;
    let needsPayment = false;
    if (enabled) {
      const { entitled } = await resolveReceptionistAddonAccess(user.id);
      if (!entitled) {
        enabled = false;
        needsPayment = true;
      }
    }

    const settings = { ...settingsIn, enabled };

    const { data: existing } = await admin
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${user.id}`)
      .maybeSingle();
    const prev = (existing?.profile && typeof existing.profile === 'object' ? existing.profile : {}) as any;

    const { error } = await admin.from('estimates').upsert({
      id: `SETTINGS-${user.id}`,
      user_id: user.id,
      jobName: '__settings__',
      documentType: 'settings',
      items: [],
      invoiceNumber: `SETTINGS-${user.id}`,
      profile: {
        ...prev,
        aiReceptionist: settings,
        aiReceptionistMessages: messages,
        aiReceptionistArchivedMessages: archived,
      },
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error('receptionist/settings upsert:', error);
      return NextResponse.json({ error: 'Could not save AI Receptionist.' }, { status: 500 });
    }

    // Keep the line-config enabled flag in sync with the classic toggle.
    try {
      const config = await loadReceptionistConfig(user.id);
      if (Boolean(config.enabled) !== enabled) {
        const next = {
          ...config,
          enabled,
          status: (config.twilio?.phoneNumber
            ? (enabled ? 'active' : 'disabled')
            : config.status) as typeof config.status,
        };
        // Don't mark a line active if there is no number.
        if (enabled && !config.twilio?.phoneNumber) {
          next.enabled = false;
        }
        await saveReceptionistConfig(user.id, next);
      }
    } catch (e) {
      console.warn('receptionist/settings config sync:', e);
    }

    if (needsPayment) {
      return NextResponse.json(
        {
          ...receptionistAddonPaymentRequiredPayload(),
          settings,
        },
        { status: 402 }
      );
    }

    return NextResponse.json({ ok: true, settings });
  } catch (e: any) {
    console.error('receptionist/settings:', e);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
