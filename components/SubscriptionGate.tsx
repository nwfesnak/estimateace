'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  accessBlockedReason,
  formatPeriodEnd,
  type BillingSnapshot,
} from '@/lib/billing';

type Props = {
  billing: BillingSnapshot;
  enforced: boolean;
  stripeConfigured: boolean;
  onCheckout: (plan?: 'monthly' | 'yearly') => void | Promise<void>;
  onPortal: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  busy?: boolean;
  supportEmail: string;
};

export function SubscriptionGate({
  billing,
  enforced,
  stripeConfigured,
  onCheckout,
  onPortal,
  onRefresh,
  busy,
  supportEmail,
}: Props) {
  const reason = accessBlockedReason(billing);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f4f4f4] p-4">
      <Card className="w-full max-w-lg shadow-lg">
        <CardContent className="p-8 space-y-5">
          <div className="text-center">
            <div className="text-4xl mb-2">🔒</div>
            <h1 className="text-2xl font-bold text-[#1e293b]">Subscribe to EstimateAce</h1>
            <p className="text-sm text-gray-600 mt-2">
              {reason || 'Choose a plan to keep estimating, invoicing, and using AI tools.'}
            </p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-500">Status</span>
              <span className="font-semibold capitalize">{billing.status}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Trial ends</span>
              <span className="font-medium">{formatPeriodEnd(billing.trialEndsAt)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Period ends</span>
              <span className="font-medium">{formatPeriodEnd(billing.currentPeriodEnd)}</span>
            </div>
          </div>

          {!enforced && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              Billing enforcement is off (<code className="text-[10px]">NEXT_PUBLIC_BILLING_ENFORCE</code>
              ). Users can still use the app; this gate only shows when enforcement is on and access is denied.
            </p>
          )}

          {!stripeConfigured && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
              Stripe is not configured on the server. Add <code>STRIPE_SECRET_KEY</code> and{' '}
              <code>STRIPE_PRICE_ID</code> in Vercel.
            </p>
          )}

          <div className="flex flex-col gap-2">
            <Button
              className="w-full bg-[#10b981] hover:bg-[#059669] text-white h-12 text-base"
              onClick={() => void onCheckout('monthly')}
              disabled={busy || !stripeConfigured}
            >
              {busy ? 'Please wait…' : 'Subscribe monthly'}
            </Button>
            <Button
              className="w-full bg-[#0ea5e9] hover:bg-[#0284c7] text-white h-12 text-base"
              onClick={() => void onCheckout('yearly')}
              disabled={busy || !stripeConfigured}
            >
              {busy ? 'Please wait…' : 'Subscribe yearly'}
            </Button>
            {billing.stripeCustomerId && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => void onPortal()}
                disabled={busy || !stripeConfigured}
              >
                Manage billing
              </Button>
            )}
            <Button variant="outline" className="w-full" onClick={() => void onRefresh()} disabled={busy}>
              Refresh status
            </Button>
          </div>

          <p className="text-xs text-center text-gray-500">
            Questions?{' '}
            <a className="text-emerald-700 underline" href={`mailto:${supportEmail}`}>
              {supportEmail}
            </a>
            {' · '}
            <a className="underline" href="/terms">
              Terms
            </a>
            {' · '}
            <a className="underline" href="/privacy">
              Privacy
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
