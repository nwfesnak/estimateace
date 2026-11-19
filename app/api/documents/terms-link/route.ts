import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceOwner } from '@/lib/workspace';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { createClientActionToken } from '@/lib/client-action-token';
import { getAppUrl } from '@/lib/stripe-server';
import { enforceAppAccess } from '@/lib/billing-access';

/**
 * Authenticated: build a public link to view this document's terms (not pasted on the PDF).
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;

    const body = await request.json().catch(() => ({}));
    const invoiceNumber = String(body.invoiceNumber || body.id || '').trim();
    const documentType = body.documentType === 'invoice' ? 'invoice' : 'estimate';
    if (!invoiceNumber) {
      return NextResponse.json({ error: 'invoiceNumber is required' }, { status: 400 });
    }

    const admin = getSupabaseAdmin();
    // Seat-aware: inactive crew never act in the owner's workspace.
    const ws = await requireWorkspaceOwner(user.id, admin, { requireFinancials: true });
    if (ws.denied) return ws.denied;
    const ownerUserId = ws.ownerUserId;

    const token = createClientActionToken({
      uid: ownerUserId,
      inv: invoiceNumber,
      typ: documentType,
      expDays: 90,
    });
    const appUrl = getAppUrl(request.url);
    const url = `${appUrl}/client/terms?token=${encodeURIComponent(token)}`;

    return NextResponse.json({ ok: true, url, token });
  } catch (e: any) {
    console.error('terms-link:', e);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
