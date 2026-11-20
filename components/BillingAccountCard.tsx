'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { BillingAccountView } from '@/lib/billing-account';

function Row({
  label,
  value,
  breakAll,
  emphasize,
}: {
  label: string;
  value: string;
  breakAll?: boolean;
  emphasize?: boolean;
}) {
  return (
    <div className="min-w-0 grid grid-cols-1 sm:grid-cols-[8.5rem_1fr] gap-0.5 sm:gap-3 py-2 border-b border-slate-100 last:border-b-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd
        className={`min-w-0 text-sm text-[#1e293b] ${breakAll ? 'break-all' : 'break-words'} ${
          emphasize ? 'font-semibold text-base' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

export function BillingAccountCard({ view }: { view: BillingAccountView }) {
  const planValue = view.planLabel
    ? view.trialEndsLabel
      ? `${view.planLabel} · Trial ends ${view.trialEndsLabel}`
      : view.planLabel
    : null;

  return (
    <Card className="mb-8 border-slate-200 w-full max-w-full min-w-0" data-testid="billing-account-card">
      <CardContent className="p-5 sm:p-8 space-y-4">
        <div>
          <h3 className="text-xl sm:text-2xl font-semibold text-[#1e293b]">Account</h3>
          <p className="text-sm text-gray-500 mt-0.5">Signed up as</p>
        </div>
        <p className="text-sm text-gray-600 leading-snug">{view.helper}</p>
        <dl className="min-w-0">
          <Row label="Login email" value={view.loginEmail} breakAll emphasize />
          {view.name ? <Row label="Name" value={view.name} /> : null}
          {view.belongsTo ? <Row label="Crew member of" value={view.belongsTo} /> : null}
          {view.company ? <Row label="Business" value={view.company} /> : null}
          {view.phone ? <Row label="Phone" value={view.phone} /> : null}
          {view.createdLabel ? <Row label="Account created" value={view.createdLabel} /> : null}
          {planValue ? <Row label="Plan" value={planValue} /> : null}
        </dl>
      </CardContent>
    </Card>
  );
}
