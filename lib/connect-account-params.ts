import type Stripe from 'stripe';

/**
 * How EstimateAce creates contractor Stripe Connect accounts.
 *
 * Stripe no longer lets platforms create accounts with the legacy `type: 'express'` while the
 * platform is the losses collector. We use Accounts v1 controller properties instead:
 * - losses.payments 'stripe': Stripe Managed Risk owns negative balances (works with our direct charges).
 * - fees.payer 'account': Stripe bills its fees to the contractor's account, as before. We take no
 *   application fee, so platform-paid fees would leave EstimateAce covering every charge.
 * - stripe_dashboard 'express': contractors keep the Express payout dashboard (login links).
 * - requirement_collection 'stripe': Stripe-hosted onboarding (account links) collects KYC.
 * See https://docs.stripe.com/connect/risk-management/managed-risk and
 * https://docs.stripe.com/connect/migrate-to-controller-properties
 */
export const CONNECT_ACCOUNT_CONTROLLER: Stripe.AccountCreateParams.Controller = {
  losses: { payments: 'stripe' },
  fees: { payer: 'account' },
  stripe_dashboard: { type: 'express' },
  requirement_collection: 'stripe',
};

/**
 * Express dashboard + Stripe-owned losses on Accounts v1 is generally available from API version
 * 2026-11-18.endive (it was preview-only on dahlia). The installed SDK pins 2026-05-27.dahlia, so
 * pin just this create call to the version that supports it. We only read `id` from the response.
 */
export const CONNECT_ACCOUNT_CREATE_API_VERSION = '2026-11-18.endive';

/**
 * Value for payment_accounts.account_type. Accounts made with controller properties report
 * `type: 'none'`, so read the dashboard they get instead: 'express' keeps login links working.
 */
export function accountTypeFromStripe(
  acct: Pick<Stripe.Account, 'type' | 'controller'> | null | undefined,
  fallback = 'express'
): string {
  const dash = String(acct?.controller?.stripe_dashboard?.type || '').trim();
  if (dash === 'express') return 'express';
  if (dash === 'full') return 'standard';
  if (dash === 'none') return 'custom';
  const t = String(acct?.type || '').trim();
  return t && t !== 'none' ? t : fallback;
}
