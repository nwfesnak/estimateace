/**
 * Per-job settings snapshot helpers.
 *
 * Every estimate/invoice snapshots the contractor settings that were in effect
 * when the job was created or explicitly updated for that job. Reading/rendering
 * a saved job (editor, Print/PDF, Send Preview, Dashboard/Reports totals, crew
 * views, and public client approve/pay pages) MUST use that job's saved snapshot
 * and only fall back to the current global SETTINGS for legacy jobs that lack a
 * saved field.
 *
 * Toggling a setting off globally (or on a different job) must never hide or
 * delete another job's saved renderings, media, tax rate, payment options, etc.
 */

import { mergeFilledPaymentSettings, mergePaymentSettings } from '@/lib/client-payment-options';

export type JobSettingsSnapshot = {
  aiJobRenderingEnabled: boolean;
  taxesEnabled: boolean;
  showDiscountOnEstimate: boolean;
  termsDisplayMode: 'link' | 'printed';
  chargeCCFee: boolean;
  ccFeePercentage: number;
  depositPercentage: number;
  showDepositOnApproval: boolean;
  depositMinimumAmount: number;
  thirdPartyEscrowEnabled: boolean;
  escrowMinimumAmount: number;
  paymentSettings: ReturnType<typeof mergePaymentSettings>;
  tradeId: string;
};

export const DEFAULT_JOB_SETTINGS_SNAPSHOT: JobSettingsSnapshot = {
  aiJobRenderingEnabled: true,
  taxesEnabled: true,
  showDiscountOnEstimate: false,
  termsDisplayMode: 'link',
  chargeCCFee: false,
  ccFeePercentage: 3,
  depositPercentage: 10,
  showDepositOnApproval: true,
  depositMinimumAmount: 0,
  thirdPartyEscrowEnabled: false,
  escrowMinimumAmount: 0,
  paymentSettings: mergePaymentSettings(undefined),
  tradeId: '',
};

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function resolveBoolean(
  docProfile: Obj,
  globalProfile: Obj,
  key: string,
  fallback: boolean
): boolean {
  if (typeof docProfile[key] === 'boolean') return docProfile[key] as boolean;
  if (typeof globalProfile[key] === 'boolean') return globalProfile[key] as boolean;
  return fallback;
}

function resolveNonNegNumber(
  docProfile: Obj,
  globalProfile: Obj,
  key: string,
  fallback: number
): number {
  const docVal = docProfile[key];
  if (docVal !== undefined && docVal !== null && docVal !== '' && Number.isFinite(Number(docVal))) {
    return Math.max(0, Number(docVal));
  }
  const globVal = globalProfile[key];
  if (globVal !== undefined && globVal !== null && globVal !== '' && Number.isFinite(Number(globVal))) {
    return Math.max(0, Number(globVal));
  }
  return fallback;
}

/**
 * Resolve whether AI Job Renderings are enabled for a specific job.
 * - If the job's own `profile.aiJobRenderingEnabled` is explicitly stored (boolean),
 *   that job's setting ALWAYS wins over the global SETTINGS value.
 * - Only legacy jobs without `profile.aiJobRenderingEnabled` fall back to
 *   `globalProfile.aiJobRenderingEnabled` (defaulting to true).
 */
export function resolveAiJobRenderingEnabled(
  docProfileRaw: unknown,
  globalProfileRaw?: unknown
): boolean {
  const docProfile = asObj(docProfileRaw);
  const globalProfile = asObj(globalProfileRaw);
  if (typeof docProfile.aiJobRenderingEnabled === 'boolean') {
    return docProfile.aiJobRenderingEnabled;
  }
  if (typeof globalProfile.aiJobRenderingEnabled === 'boolean') {
    return globalProfile.aiJobRenderingEnabled;
  }
  return true;
}

/**
 * Resolve whether sales tax is enabled on a saved document row (for Dashboard / Reports totals).
 * Legacy rows without `profile.taxesEnabled` fall back to the caller's global setting.
 */
export function resolveDocTaxesEnabled(
  doc: Record<string, unknown> | null | undefined,
  globalTaxesEnabled: boolean
): boolean {
  const docProfile = asObj(doc?.profile);
  if (typeof docProfile.taxesEnabled === 'boolean') {
    return docProfile.taxesEnabled;
  }
  return globalTaxesEnabled;
}

/**
 * Resolve a complete JobSettingsSnapshot when opening a saved document.
 * Every field present on `docProfile` wins; missing fields (legacy jobs) fall
 * back to `globalProfile` (server SETTINGS / local cache / profile defaults).
 */
export function resolveJobSettingsFromDoc(
  docProfileRaw: unknown,
  globalProfileRaw?: unknown
): JobSettingsSnapshot {
  const docProfile = asObj(docProfileRaw);
  const globalProfile = asObj(globalProfileRaw);

  const termsRaw =
    docProfile.termsDisplayMode === 'printed' || docProfile.termsDisplayMode === 'link'
      ? docProfile.termsDisplayMode
      : globalProfile.termsDisplayMode === 'printed' || globalProfile.termsDisplayMode === 'link'
        ? globalProfile.termsDisplayMode
        : 'link';

  const docPay =
    docProfile.paymentSettings && typeof docProfile.paymentSettings === 'object'
      ? (docProfile.paymentSettings as Record<string, unknown>)
      : null;
  const hasDocSnapshot =
    typeof docProfile._jobSettingsSnapshottedAt === 'string' ||
    (docPay !== null && Object.keys(docPay).length > 0 && 'chargeCCFee' in docProfile);

  const paymentSettings = hasDocSnapshot && docPay
    ? mergePaymentSettings(docPay as any)
    : mergeFilledPaymentSettings(docPay as any, globalProfile.paymentSettings as any);

  const ccPctDoc = docProfile.ccFeePercentage;
  const ccPctGlob = globalProfile.ccFeePercentage;
  const ccFeePercentage =
    ccPctDoc !== undefined && ccPctDoc !== null && ccPctDoc !== '' && Number.isFinite(Number(ccPctDoc))
      ? Math.max(0, Number(ccPctDoc))
      : ccPctGlob !== undefined && ccPctGlob !== null && ccPctGlob !== '' && Number.isFinite(Number(ccPctGlob))
        ? Math.max(0, Number(ccPctGlob))
        : DEFAULT_JOB_SETTINGS_SNAPSHOT.ccFeePercentage;

  const tradeId = String(docProfile.tradeId || globalProfile.tradeId || '').trim();

  return {
    aiJobRenderingEnabled: resolveAiJobRenderingEnabled(docProfile, globalProfile),
    taxesEnabled: resolveBoolean(docProfile, globalProfile, 'taxesEnabled', true),
    showDiscountOnEstimate: resolveBoolean(docProfile, globalProfile, 'showDiscountOnEstimate', false),
    termsDisplayMode: termsRaw,
    chargeCCFee: resolveBoolean(docProfile, globalProfile, 'chargeCCFee', false),
    ccFeePercentage,
    depositPercentage: resolveNonNegNumber(
      docProfile,
      globalProfile,
      'depositPercentage',
      DEFAULT_JOB_SETTINGS_SNAPSHOT.depositPercentage
    ),
    showDepositOnApproval: resolveBoolean(docProfile, globalProfile, 'showDepositOnApproval', true),
    depositMinimumAmount: resolveNonNegNumber(docProfile, globalProfile, 'depositMinimumAmount', 0),
    thirdPartyEscrowEnabled: resolveBoolean(docProfile, globalProfile, 'thirdPartyEscrowEnabled', false),
    escrowMinimumAmount: resolveNonNegNumber(docProfile, globalProfile, 'escrowMinimumAmount', 0),
    paymentSettings,
    tradeId,
  };
}

/**
 * Snapshot current global settings for a newly created job.
 */
export function buildNewJobSettingsSnapshot(globalProfileRaw: unknown): JobSettingsSnapshot {
  return resolveJobSettingsFromDoc({}, globalProfileRaw);
}
