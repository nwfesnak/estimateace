/**
 * Shared definition of "meaningful input" on a new estimate or invoice.
 *
 * Defaults do not count: tax rate, company terms / template text, today's date,
 * an auto-assigned document number, empty placeholder line items, and profile
 * display settings. A new document must not be inserted until this helper is
 * true, and a blank draft created in the current session may be deleted on exit
 * only when the server-side guard below also agrees.
 */

import { isReservedDocumentId } from '@/lib/company-profile-access';
import { isEstimateApproved } from '@/lib/estimate-approval';
import { readInvoiceSentAt } from '@/lib/invoice-sent';
import { laborLogsFromDoc, normalizeLaborLogs } from '@/lib/labor-logs';
import { getLinePhotos } from '@/lib/line-item-photos';

/** Session-created blank drafts older than this are left alone (safer than deleting stale rows). */
export const BLANK_DRAFT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export const BLANK_NOTHING_TO_SAVE_MESSAGE =
  'Nothing to save yet. Add a client, line item, photo, or note first.';

export type MeaningfulInputOptions = {
  /** Company disclosure / terms template. Matching or empty terms are not meaningful. */
  defaultTerms?: string | null;
};

export type DiscardBlankOptions = {
  ownerUserId: string;
  defaultTerms?: string | null;
  now?: Date | number;
  maxAgeMs?: number;
  /** When provided (client), the id must have been created in this session. */
  sessionCreatedIds?: Iterable<string>;
};

export type DiscardDecision = {
  ok: boolean;
  reason?:
    | 'missing'
    | 'reserved'
    | 'not_a_document'
    | 'not_owned'
    | 'not_draft'
    | 'has_content'
    | 'too_old'
    | 'not_in_session';
};

function isBlankValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function pick(row: Record<string, unknown> | null | undefined, ...keys: string[]): unknown {
  if (!row || typeof row !== 'object') return undefined;
  const lowerMap: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lowerMap[k.toLowerCase()] = v;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k) && !isBlankValue(row[k])) return row[k];
    const lk = k.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(lowerMap, lk) && !isBlankValue(lowerMap[lk])) {
      return lowerMap[lk];
    }
  }
  return undefined;
}

function asTime(value: Date | number | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = new Date(value).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function textOf(value: unknown): string {
  return String(value ?? '').trim();
}

function hasText(value: unknown): boolean {
  return textOf(value).length > 0;
}

/** Collapse whitespace so company terms match the snapshot written on a new document. */
export function normalizeTermsText(value: unknown): string {
  return textOf(value).replace(/\s+/g, ' ');
}

function isNonEmptyMediaRef(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasMediaList(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isNonEmptyMediaRef);
  return isNonEmptyMediaRef(value);
}

function contactValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return hasText(value) ? [textOf(value)] : [];
  }
  return value.map((v) => textOf(v)).filter(Boolean);
}

function hasReceiptDetails(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some((row) => {
    const rec = asRecord(row);
    if (!rec) return false;
    if (hasText(rec.vendor) || hasText(rec.notes) || hasText(rec.date)) return true;
    if (Number(rec.amount) > 0) return true;
    return false;
  });
}

function hasMileageLogs(profile: Record<string, unknown> | null, row: Record<string, unknown>): boolean {
  const raw =
    (profile && (profile._mileageLogs ?? profile.mileageLogs ?? profile.jobMileageLogs)) ??
    pick(row, 'mileageLogs', 'mileagelogs');
  if (!Array.isArray(raw) || raw.length === 0) return false;
  return raw.some((entry) => {
    const rec = asRecord(entry);
    if (!rec) return false;
    const miles = Number(rec.miles);
    if (Number.isFinite(miles) && miles > 0) return true;
    return (
      hasText(rec.purpose) ||
      hasText(rec.fromLocation) ||
      hasText(rec.from) ||
      hasText(rec.toLocation) ||
      hasText(rec.to) ||
      hasText(rec.notes)
    );
  });
}

function hasLaborContent(row: Record<string, unknown>): boolean {
  const logs = laborLogsFromDoc(row);
  if (logs.length > 0) return true;
  const profile = asRecord(row.profile);
  const fromProfile = normalizeLaborLogs(
    profile?._laborLogs ?? profile?.laborLogs ?? pick(row, 'laborLogs', 'laborlogs')
  );
  if (fromProfile.length > 0) return true;
  const hours = Number(pick(row, 'laborHours', 'laborhours')) || 0;
  const amount = Number(pick(row, 'laborAmount', 'laboramount')) || 0;
  const fixed = Number(pick(row, 'laborFixedAmount', 'laborfixedamount')) || 0;
  return hours > 0 || amount > 0 || fixed > 0;
}

function hasDiscount(row: Record<string, unknown>, profile: Record<string, unknown> | null): boolean {
  const stored = asRecord(profile?._discount) || {};
  const value =
    Number(pick(row, 'discountValue', 'discountvalue') ?? stored.discountValue) || 0;
  const amount =
    Number(pick(row, 'discountAmount', 'discountamount') ?? stored.discountAmount) || 0;
  if (value > 0 || amount > 0) return true;
  return hasText(pick(row, 'discountDescription', 'discountdescription') ?? stored.discountDescription);
}

function hasJobRenderings(profile: Record<string, unknown> | null, row: Record<string, unknown>): boolean {
  const raw =
    (profile && (profile._jobRenderings ?? profile.jobRenderings)) ??
    pick(row, 'jobRenderings', 'jobrenderings');
  return Array.isArray(raw) && raw.length > 0;
}

function hasMeaningfulLineItem(item: unknown): boolean {
  const rec = asRecord(item);
  if (!rec) return false;
  if (hasText(rec.description) || hasText(rec.notes) || hasText(rec.memo) || hasText(rec.unit)) {
    return true;
  }
  if (getLinePhotos(rec).length > 0) return true;
  if (hasMediaList(rec.photos) || hasMediaList(rec.photoUrls) || hasMediaList(rec.images)) return true;
  const price = Number(rec.price);
  const total = Number(rec.total);
  if ((Number.isFinite(price) && price !== 0) || (Number.isFinite(total) && total !== 0)) return true;
  if (rec.qty !== undefined && rec.qty !== null && rec.qty !== '') {
    const qty = Number(rec.qty);
    if (Number.isFinite(qty) && qty !== 1) return true;
  }
  for (const key of ['materials', 'labor', 'materialLines', 'laborLines']) {
    const list = rec[key];
    if (Array.isArray(list) && list.length > 0) return true;
  }
  if (rec.optional === true || rec.isOptional === true) return true;
  return false;
}

/**
 * True when the document has real contractor input beyond new-document defaults.
 * Accepts editor state or a database row (camelCase or lowercase columns).
 */
export function hasMeaningfulEstimateInput(
  input: unknown,
  options?: MeaningfulInputOptions
): boolean {
  const row = asRecord(input);
  if (!row) return false;
  const profile = asRecord(row.profile);

  if (hasText(pick(row, 'jobName', 'jobname'))) return true;
  if (hasText(pick(row, 'address'))) return true;
  if (hasText(pick(row, 'city'))) return true;
  if (hasText(pick(row, 'state'))) return true;
  if (hasText(pick(row, 'zipCode', 'zipcode', 'zip'))) return true;
  if (contactValues(pick(row, 'phones')).length > 0) return true;
  if (contactValues(pick(row, 'emails')).length > 0) return true;

  const items = pick(row, 'items');
  if (Array.isArray(items) && items.some(hasMeaningfulLineItem)) return true;

  if (hasMediaList(pick(row, 'photoUrls', 'photourls'))) return true;
  if (hasMediaList(pick(row, 'videoUrls', 'videourls'))) return true;
  if (hasMediaList(pick(row, 'receiptUrls', 'receipturls'))) return true;
  if (hasReceiptDetails(pick(row, 'receiptDetails', 'receiptdetails'))) return true;

  if (hasJobRenderings(profile, row)) return true;
  if (hasMileageLogs(profile, row)) return true;
  if (hasLaborContent(row)) return true;
  if (hasDiscount(row, profile)) return true;

  if (hasText(pick(row, 'dueDate', 'duedate'))) return true;
  if (row.isTaxExempt === true || row.istaxexempt === true) return true;

  const amountPaid = Number(pick(row, 'amountPaid', 'amountpaid')) || 0;
  if (amountPaid > 0) return true;
  if (hasText(pick(row, 'paymentMethod', 'paymentmethod'))) return true;

  const terms = normalizeTermsText(pick(row, 'terms'));
  const defaultTerms = normalizeTermsText(options?.defaultTerms);
  if (terms && terms !== defaultTerms) return true;

  return false;
}

export function isWorkspaceDocumentId(id: unknown): boolean {
  const raw = textOf(id);
  if (!raw || isReservedDocumentId(raw)) return false;
  if (/^(REC-|INV-REC-)/i.test(raw)) return false;
  return /^(EST|INV)(-|$)/i.test(raw);
}

export function documentTypeOf(row: unknown): string {
  const rec = asRecord(row);
  return textOf(pick(rec, 'documentType', 'documenttype') || rec?.id).toLowerCase();
}

/**
 * A document is a live (non-draft) record once it has been sent, approved,
 * marked paid, or is a reserved / recurring / settings row — those must never
 * be auto-deleted.
 */
export function isSentOrNonDraftDocument(row: unknown): boolean {
  const rec = asRecord(row);
  if (!rec) return true;
  const id = textOf(pick(rec, 'id', 'invoiceNumber', 'invoicenumber'));
  if (!isWorkspaceDocumentId(id)) return true;
  const docType = documentTypeOf(rec);
  if (docType === 'recurring_plan' || docType === 'settings') return true;
  if (isEstimateApproved(rec)) return true;
  if (readInvoiceSentAt(rec)) return true;
  const status = textOf(pick(rec, 'paymentStatus', 'paymentstatus')).toLowerCase();
  if (status && status !== 'pending' && status !== 'draft' && status !== 'unpaid') return true;
  const amountPaid = Number(pick(rec, 'amountPaid', 'amountpaid')) || 0;
  if (amountPaid > 0) return true;
  return false;
}

export function isOwnedByWorkspace(row: unknown, ownerUserId: string): boolean {
  const rec = asRecord(row);
  if (!rec || !ownerUserId) return false;
  return String(pick(rec, 'user_id', 'userId') || '') === String(ownerUserId);
}

function createdAtMs(row: Record<string, unknown>): number | null {
  const raw = pick(row, 'created_at', 'createdAt');
  if (!raw) return null;
  const ms = new Date(String(raw)).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Server + client guard: delete only when the row is still a blank draft, owned
 * by this workspace, looks like an EST/INV document, and (when a session set is
 * provided) was created in this session. The server also rejects rows older
 * than BLANK_DRAFT_MAX_AGE_MS and rows with no created_at.
 */
export function canDiscardBlankDraft(
  row: unknown,
  options: DiscardBlankOptions
): DiscardDecision {
  const rec = asRecord(row);
  if (!rec) return { ok: false, reason: 'missing' };
  const id = textOf(pick(rec, 'id', 'invoiceNumber', 'invoicenumber'));
  if (!id) return { ok: false, reason: 'missing' };
  if (isReservedDocumentId(id)) return { ok: false, reason: 'reserved' };
  if (!isWorkspaceDocumentId(id)) return { ok: false, reason: 'not_a_document' };
  if (!isOwnedByWorkspace(rec, options.ownerUserId)) return { ok: false, reason: 'not_owned' };
  if (isSentOrNonDraftDocument(rec)) return { ok: false, reason: 'not_draft' };
  if (hasMeaningfulEstimateInput(rec, { defaultTerms: options.defaultTerms })) {
    return { ok: false, reason: 'has_content' };
  }
  if (options.sessionCreatedIds) {
    const allowed = new Set(Array.from(options.sessionCreatedIds, (v) => String(v)));
    if (!allowed.has(id)) return { ok: false, reason: 'not_in_session' };
  } else {
    const created = createdAtMs(rec);
    if (created == null) return { ok: false, reason: 'too_old' };
    const now = asTime(options.now);
    const maxAge = options.maxAgeMs ?? BLANK_DRAFT_MAX_AGE_MS;
    if (!Number.isFinite(now) || now - created > maxAge) return { ok: false, reason: 'too_old' };
  }
  return { ok: true };
}

/** Default terms / disclosure stored on the workspace SETTINGS row. */
export function defaultTermsFromSettingsProfile(profile: unknown): string {
  const rec = asRecord(profile);
  return textOf(rec?.disclosure ?? rec?.terms ?? '');
}

/** New unsaved documents should not be inserted until this is true. */
export function shouldInsertNewDocument(input: unknown, options?: MeaningfulInputOptions): boolean {
  const rec = asRecord(input);
  const id = textOf(pick(rec, 'id', 'invoiceNumber', 'invoicenumber'));
  if (id && (isReservedDocumentId(id) || !isWorkspaceDocumentId(id))) return false;
  return hasMeaningfulEstimateInput(input, options);
}
