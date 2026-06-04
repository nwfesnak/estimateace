import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');   // this is the user ID we sent

  if (!code || !state) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/profile?error=missing_params`);
  }

  try {
    const oauthToken = await stripe.oauth.token({
      grant_type: 'authorization_code',
      code,
    });

    const stripeAccountId = oauthToken.stripe_user_id;

    // Update the user's profile with the connected Stripe account
    await supabase
      .from('estimates')
      .update({
        profile: {
          ... (await supabase.from('estimates').select('profile').eq('user_id', state).single()).data?.profile || {}),
          paymentSettings: {
            ... (await supabase.from('estimates').select('profile').eq('user_id', state).single()).data?.profile?.paymentSettings || {},
            stripe: {
              enabled: true,
              connected: true,
              stripe_account_id: stripeAccountId
            }
          }
        }
      })
      .eq('user_id', state);

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/profile?success=stripe_connected`);
  } catch (error: any) {
    console.error('Stripe OAuth error:', error);
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/profile?error=stripe_connect_failed`);
  }
}