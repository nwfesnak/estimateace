import type { BillingSnapshot, SubscriptionStatus } from '@/lib/billing';
import { formatPeriodEnd } from '@/lib/billing';

export const ACCOUNT_EMAIL_HELPER =
  'This is the email you sign in with and where account emails (including trial reminders) are sent.';

export type BillingAccountView = {
  loginEmail: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  createdLabel: string | null;
  planLabel: string | null;
  trialEndsLabel: string | null;
  belongsTo: string | null;
  isCrew: boolean;
  helper: string;
};

const PLAN_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  none: 'No subscription',
  trialing: 'Free trial',
  active: 'Active subscription',
  past_due: 'Past due',
  canceled: 'Canceled',
  unpaid: 'Unpaid',
  incomplete: 'Incomplete',
  incomplete_expired: 'Expired',
  paused: 'Paused',
};

function clean(value: unknown): string | null {
  const s = String(value || '').trim();
  return s ? s : null;
}

export function planStatusLabel(
  status: SubscriptionStatus | string | null | undefined,
  opts?: { cancelAtPeriodEnd?: boolean }
): string {
  const key = (status || 'none') as SubscriptionStatus;
  const base = PLAN_STATUS_LABEL[key] || 'No subscription';
  if (key === 'active' && opts?.cancelAtPeriodEnd) return 'Active (cancels at period end)';
  return base;
}

export function buildBillingAccountView(input: {
  loginEmail?: string | null;
  createdAt?: string | null;
  /** The signed-in person's own name (never the workspace owner's, for crew). */
  name?: string | null;
  /** The signed-in person's own business name (owners only). */
  company?: string | null;
  /** The signed-in person's own phone (never the owner's, for crew). */
  phone?: string | null;
  isCrew?: boolean;
  /** Owner/company the crew member belongs to (already visible in the workspace). */
  ownerCompany?: string | null;
  billing?: Pick<BillingSnapshot, 'status' | 'trialEndsAt' | 'cancelAtPeriodEnd'> | null;
}): BillingAccountView {
  const isCrew = Boolean(input.isCrew);
  const trialEndsLabel =
    !isCrew && input.billing?.status === 'trialing'
      ? formatPeriodEnd(input.billing.trialEndsAt)
      : null;
  return {
    loginEmail: clean(input.loginEmail) || '—',
    name: isCrew ? clean(input.name) : clean(input.name),
    company: isCrew ? null : clean(input.company),
    phone: clean(input.phone),
    createdLabel: input.createdAt ? formatPeriodEnd(input.createdAt) : null,
    planLabel: isCrew ? null : planStatusLabel(input.billing?.status, input.billing || undefined),
    trialEndsLabel: trialEndsLabel && trialEndsLabel !== '—' ? trialEndsLabel : null,
    belongsTo: isCrew ? clean(input.ownerCompany) : null,
    isCrew,
    helper: ACCOUNT_EMAIL_HELPER,
  };
}
