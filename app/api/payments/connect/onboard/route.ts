import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { createConnectOnboardingLink } from '@/lib/job-payments';

/**
 * Start Stripe Connect Express onboarding for job payments.
 * Does not affect SaaS subscription billing.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const result = await createConnectOnboardingLink(
      user.id,
      user.email || undefined,
      request.url
    );

    if (!result.ok || !result.url) {
      return NextResponse.json(
        {
          error:
            result.error ||
            'Could not start Stripe Connect. In Stripe Dashboard enable Connect (Settings → Connect).',
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, url: result.url });
  } catch (e: any) {
    console.error('connect onboard:', e);
    return NextResponse.json({ error: e?.message || 'Onboard failed' }, { status: 500 });
  }
}
