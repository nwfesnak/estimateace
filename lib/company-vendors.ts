/**
 * Company-scoped saved labor vendors (subs / people paid often).
 * company_id is the workspace owner's auth user id.
 */

export type CompanyVendor = {
  id: string;
  companyId: string;
  name: string;
  trade: string;
  phone: string;
  email: string;
  /** Default hourly rate, or null when the owner has not saved one. */
  rate: number | null;
  createdAt: string;
  updatedAt: string;
};

export type LaborVendorDraft = {
  /** Saved vendor id, or empty when adding a new / one-time vendor. */
  vendorId: string;
  name: string;
  trade: string;
  phone: string;
  email: string;
};

export type LaborVendorSnapshot = {
  vendorId?: string;
  vendorName?: string;
  trade?: string;
  phone?: string;
  email?: string;
};

const trim = (value: unknown) => String(value ?? '').trim();

export function emptyVendorDraft(): LaborVendorDraft {
  return { vendorId: '', name: '', trade: '', phone: '', email: '' };
}

export function normalizeCompanyVendor(row: unknown): CompanyVendor | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const name = trim(r.name);
  if (!name) return null;
  const id = trim(r.id);
  const companyId = trim(r.companyId ?? r.company_id ?? '');
  if (!id || !companyId) return null;
  const rawRate = r.rate;
  const rate =
    rawRate === null || rawRate === undefined || rawRate === ''
      ? null
      : Math.max(0, Number(rawRate) || 0);
  return {
    id,
    companyId,
    name,
    trade: trim(r.trade),
    phone: trim(r.phone),
    email: trim(r.email),
    rate,
    createdAt: String(r.createdAt ?? r.created_at ?? ''),
    updatedAt: String(r.updatedAt ?? r.updated_at ?? ''),
  };
}

export function normalizeCompanyVendors(raw: unknown): CompanyVendor[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeCompanyVendor)
    .filter((v): v is CompanyVendor => Boolean(v))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function vendorToDraft(vendor: CompanyVendor): LaborVendorDraft {
  return {
    vendorId: vendor.id,
    name: vendor.name,
    trade: vendor.trade,
    phone: vendor.phone,
    email: vendor.email,
  };
}

export function draftFromSnapshot(snapshot: LaborVendorSnapshot | null | undefined): LaborVendorDraft {
  if (!snapshot) return emptyVendorDraft();
  return {
    vendorId: trim(snapshot.vendorId),
    name: trim(snapshot.vendorName),
    trade: trim(snapshot.trade),
    phone: trim(snapshot.phone),
    email: trim(snapshot.email),
  };
}

/** Apply a saved vendor's default rate only when one is stored. */
export function applyVendorRate(vendor: CompanyVendor, currentRate: number): number {
  if (vendor.rate == null || !(vendor.rate > 0)) return currentRate;
  return vendor.rate;
}

export function vendorSnapshotFromDraft(draft: LaborVendorDraft): LaborVendorSnapshot {
  const name = trim(draft.name);
  const trade = trim(draft.trade);
  const phone = trim(draft.phone);
  const email = trim(draft.email);
  const vendorId = trim(draft.vendorId);
  const snap: LaborVendorSnapshot = {};
  if (vendorId) snap.vendorId = vendorId;
  if (name) snap.vendorName = name;
  if (trade) snap.trade = trade;
  if (phone) snap.phone = phone;
  if (email) snap.email = email;
  return snap;
}

/** Keep a typed memo; fall back to the vendor name so legacy "who you paid" still fills in. */
export function laborMemoFromVendor(draft: LaborVendorDraft, memo: string): string {
  const typed = trim(memo);
  if (typed) return typed;
  return trim(draft.name);
}

export function canWriteCompanyVendors(isCrew: boolean): boolean {
  return !isCrew;
}

export function shouldSaveNewVendor(opts: {
  canManage: boolean;
  saveVendor: boolean;
  name: string;
  selectedId: string;
}): boolean {
  return Boolean(opts.canManage && opts.saveVendor && trim(opts.name) && !trim(opts.selectedId));
}

export function vendorRowForWrite(
  companyId: string,
  draft: LaborVendorDraft,
  rate?: number | null
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    company_id: companyId,
    name: trim(draft.name),
    trade: trim(draft.trade) || null,
    phone: trim(draft.phone) || null,
    email: trim(draft.email) || null,
    updated_at: new Date().toISOString(),
  };
  if (rate != null && Number(rate) > 0) {
    row.rate = Math.round(Number(rate) * 100) / 100;
  } else if (rate === null) {
    row.rate = null;
  }
  return row;
}

export function formatVendorOptionLabel(vendor: CompanyVendor): string {
  const extras = [vendor.trade, vendor.rate != null && vendor.rate > 0 ? `$${vendor.rate.toFixed(2)}/hr` : '']
    .filter(Boolean)
    .join(' · ');
  return extras ? `${vendor.name} (${extras})` : vendor.name;
}
