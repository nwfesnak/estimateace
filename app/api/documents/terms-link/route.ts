import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { createClientActionToken } from '@/lib/client-action-token';
import { getAppUrl } from '@/lib/stripe-server';

/**
 * Authenticated: build a public link to view this document's terms (not pasted on the PDF).
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const invoiceNumber = String(body.invoiceNumber || body.id || '').trim();
    const documentType = body.documentType === 'invoice' ? 'invoice' : 'estimate';
    if (!invoiceNumber) {
      return NextResponse.json({ error: 'invoiceNumber is required' }, { status: 400 });
    }

    let ownerUserId = user.id;
    const admin = getSupabaseAdmin();
    if (admin) {
      try {
        const { data: crew } = await admin
          .from('crew_members')
          .select('owner_user_id')
          .eq('crew_user_id', user.id)
          .maybeSingle();
        if (crew?.owner_user_id) ownerUserId = crew.owner_user_id;
      } catch {
        /* optional */
      }
    }

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
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
