import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceOwner } from '@/lib/workspace';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { enforceAppAccess } from '@/lib/billing-access';
import { isReservedDocumentId } from '@/lib/company-profile-access';
import {
  canDiscardBlankDraft,
  defaultTermsFromSettingsProfile,
  isWorkspaceDocumentId,
} from '@/lib/blank-estimate';

/**
 * Delete a blank draft estimate/invoice that is still empty, still a draft,
 * and owned by this workspace. Refuses reserved rows, sent/approved/paid docs,
 * anything with real content, and rows older than 48 hours.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: 'Server is not configured to save documents.' }, { status: 503 });
    }

    const body = await request.json().catch(() => ({}));
    const id = String(body.id || body.invoiceNumber || '').trim();
    if (!id) {
      return NextResponse.json({ error: 'Document id is required' }, { status: 400 });
    }
    if (isReservedDocumentId(id) || !isWorkspaceDocumentId(id)) {
      return NextResponse.json({ ok: true, deleted: false, reason: 'not_a_document', id });
    }

    const ws = await requireWorkspaceOwner(user.id, admin);
    if (ws.denied) return ws.denied;
    const workspaceUserId = ws.ownerUserId;

    const { data: row, error: loadErr } = await admin
      .from('estimates')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (loadErr) {
      console.error('documents/discard-blank load:', loadErr);
      return NextResponse.json({ error: 'Could not load document.' }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json({ ok: true, deleted: false, reason: 'missing', id });
    }

    let defaultTerms = '';
    {
      const { data: settings } = await admin
        .from('estimates')
        .select('profile')
        .eq('id', `SETTINGS-${workspaceUserId}`)
        .maybeSingle();
      defaultTerms = defaultTermsFromSettingsProfile(settings?.profile);
    }

    const decision = canDiscardBlankDraft(row, {
      ownerUserId: workspaceUserId,
      defaultTerms,
    });
    if (!decision.ok) {
      return NextResponse.json({ ok: true, deleted: false, reason: decision.reason, id });
    }

    const { error: delErr } = await admin
      .from('estimates')
      .delete()
      .eq('id', id)
      .eq('user_id', workspaceUserId);
    if (delErr) {
      console.error('documents/discard-blank delete:', delErr);
      return NextResponse.json({ error: 'Could not delete blank draft.' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deleted: true, id });
  } catch (e) {
    console.error('documents/discard-blank:', e);
    return NextResponse.json({ error: 'Discard failed' }, { status: 500 });
  }
}
