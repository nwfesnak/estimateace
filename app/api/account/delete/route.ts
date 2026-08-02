import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe-server';

/**
 * Permanently delete the signed-in owner's account data + auth user.
 * Optionally cancels Stripe subscription if linked.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const confirm = String(body.confirm || '').trim().toUpperCase();
    if (confirm !== 'DELETE') {
      return NextResponse.json(
        { error: 'Send { "confirm": "DELETE" } to confirm permanent deletion.' },
        { status: 400 }
      );
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY — cannot delete account.' },
        { status: 503 }
      );
    }

    const uid = user.id;

    // Cancel Stripe subscription if we have one (best effort)
    try {
      const stripe = getStripe();
      const { data: subRow } = await admin
        .from('subscriptions')
        .select('stripe_subscription_id, stripe_customer_id')
        .eq('user_id', uid)
        .maybeSingle();
      if (stripe && subRow?.stripe_subscription_id) {
        try {
          await stripe.subscriptions.cancel(subRow.stripe_subscription_id);
        } catch (e) {
          console.warn('Stripe cancel on account delete:', e);
        }
      }
    } catch (e) {
      console.warn('Stripe cleanup skipped:', e);
    }

    // Delete app data (order: archives, estimates, subscriptions)
    await admin.from('archive-est').delete().eq('user_id', uid);
    await admin.from('estimates').delete().eq('user_id', uid);
    await admin.from('subscriptions').delete().eq('user_id', uid);

    // Storage files under {user_id}/
    try {
      const { data: files } = await admin.storage.from('media').list(uid, { limit: 1000 });
      if (files && files.length > 0) {
        const paths = files.map((f) => `${uid}/${f.name}`);
        // Also try nested folders one level
        for (const f of files) {
          if (f.id === null || f.name) {
            const { data: nested } = await admin.storage.from('media').list(`${uid}/${f.name}`, {
              limit: 500,
            });
            if (nested?.length) {
              await admin.storage
                .from('media')
                .remove(nested.map((n) => `${uid}/${f.name}/${n.name}`));
            }
          }
        }
        await admin.storage.from('media').remove(paths);
      }
    } catch (e) {
      console.warn('Storage cleanup partial:', e);
    }

    const { error: delAuthErr } = await admin.auth.admin.deleteUser(uid);
    if (delAuthErr) {
      console.error('deleteUser:', delAuthErr);
      return NextResponse.json(
        {
          error:
            'Data removed but auth user delete failed: ' +
            delAuthErr.message +
            '. Contact support.',
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('account/delete:', e);
    return NextResponse.json({ error: e?.message || 'Delete failed' }, { status: 500 });
  }
}
