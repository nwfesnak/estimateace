/**
 * Crew data redaction (server-only, pure functions).
 *
 * Crew members whose owner has NOT ticked both "See pricing" and
 * "See estimates & financials" no longer read the owner's documents straight from
 * the database (RLS only lets fully-permitted crew do that). Their reads and writes
 * go through /api/crew/data/*, which uses these helpers to:
 *   - redactRow():   hide what the crew member's access level hides in the UI
 *   - restoreRow():  put the owner's real values back before saving, so a redacted
 *                    copy can never overwrite (zero out) the owner's prices/financials
 */

import { computeDocumentGrandTotal } from '@/lib/document-totals';
import { allCrewTabsAllowed, crewHasTab, type CrewTabAccess } from '@/lib/crew-tab-access';

export type CrewAccess = {
  ownerId: string;
  canSeePricing: boolean;
  canSeeFinancials: boolean;
  tabAccess?: CrewTabAccess;
};

/** Fully-permitted crew read/write directly (RLS); everyone else is proxied. */
export function crewHasFullDataAccess(a: Pick<CrewAccess, 'canSeePricing' | 'canSeeFinancials'>): boolean {
  return a.canSeePricing && a.canSeeFinancials;
}

/** Keys we add to redacted rows that are not real table columns (strip before writes). */
export const INJECTED_KEYS = ['grandTotal'] as const;

const MONEY_KEY_EXACT = new Set([
  'price',
  'unitprice',
  'unit_price',
  'total',
  'linetotal',
  'subtotal',
  'cost',
  'unitcost',
  'amount',
  'rate',
  'hourlyrate',
  'wage',
  'markup',
  'margin',
  'profit',
  'grandtotal',
  'discountvalue',
  'discountamount',
]);
const MONEY_KEY_EXCLUDE = new Set(['taxrate', 'tax_rate']);

/** True for keys whose numeric value is a price / cost / money amount. */
export function isMoneyKey(key: string): boolean {
  const k = String(key || '');
  const lower = k.toLowerCase();
  if (MONEY_KEY_EXCLUDE.has(lower)) return false;
  if (MONEY_KEY_EXACT.has(lower)) return true;
  return /(Price|Cost|Total|Amount|Rate|Wage|Markup|Margin|Profit)$/.test(k);
}

function isNumberLike(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '' && Number.isFinite(Number(v));
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively set every money value to 0 (structure and non-money data kept). */
export function maskMoneyDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => maskMoneyDeep(v)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isMoneyKey(k) && isNumberLike(v)) out[k] = 0;
    else if (Array.isArray(v) || isPlainObject(v)) out[k] = maskMoneyDeep(v);
    else out[k] = v;
  }
  return out as T;
}

function isMaskedPlaceholder(v: unknown): boolean {
  return v === 0 || v === '0' || v === null || v === undefined || v === '';
}

function matchKey(el: unknown): string | null {
  if (!isPlainObject(el)) return null;
  const id = el.id ?? el._id ?? el.key;
  return id === undefined || id === null || id === '' ? null : String(id);
}

/**
 * Inverse of maskMoneyDeep: wherever `incoming` holds a masked money placeholder (0/empty)
 * and `source` (the owner's stored copy) holds a real value, use the stored value.
 * Arrays of objects are matched by id (fallback: index). Non-money data from
 * `incoming` (descriptions, quantities, new rows) is kept.
 */
export function restoreMoneyDeep<T>(incoming: T, source: unknown): T {
  if (source === undefined || source === null) return incoming;
  if (Array.isArray(incoming)) {
    const srcArr = Array.isArray(source) ? source : [];
    const byId = new Map<string, unknown>();
    for (const s of srcArr) {
      const k = matchKey(s);
      if (k) byId.set(k, s);
    }
    return incoming.map((el, i) => {
      const k = matchKey(el);
      const src = k ? byId.get(k) : srcArr[i];
      return restoreMoneyDeep(el, src);
    }) as unknown as T;
  }
  if (!isPlainObject(incoming) || !isPlainObject(source)) return incoming;
  const out: Record<string, unknown> = { ...incoming };
  for (const [k, v] of Object.entries(incoming)) {
    const s = source[k];
    if (isMoneyKey(k) && isMaskedPlaceholder(v) && isNumberLike(s)) out[k] = s;
    else if (Array.isArray(v) || isPlainObject(v)) out[k] = restoreMoneyDeep(v, s);
  }
  return out as T;
}

// Internal translation fields on items JSONB are not money keys — maskMoneyDeep
// leaves translation, translationLang, translatedAt, and translationSource intact
// so restricted crew still see the owner's line-item translations.
function parseItems(items: unknown): { list: unknown[]; wasString: boolean } {
  if (typeof items === 'string') {
    try {
      const parsed = JSON.parse(items);
      return { list: Array.isArray(parsed) ? parsed : [], wasString: true };
    } catch {
      return { list: [], wasString: true };
    }
  }
  return { list: Array.isArray(items) ? items : [], wasString: false };
}

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Top-level labor money columns (both camelCase and lowercase schemas). */
const LABOR_MONEY_COLUMNS = [
  'laborRate',
  'laborrate',
  'laborAmount',
  'laboramount',
  'laborFixedAmount',
  'laborfixedamount',
];
/** Top-level financial columns hidden without "See estimates & financials". */
const FINANCIAL_NUMBER_COLUMNS = ['amountPaid', 'amountpaid', 'taxAmount', 'taxamount'];
/** Profile keys hidden without pricing (price memory / saved price lists). */
const PRICING_PROFILE_HIDDEN = ['aiPriceMemory'];
/** Profile keys hidden without financials. */
const FINANCIAL_PROFILE_HIDDEN = ['paymentSettings', 'receptionistBilling'];
/** Profile keys never shown to restricted crew (owner's private contact / security data). */
const ALWAYS_PROFILE_HIDDEN = ['twoFactorPhone'];

const CALENDAR_PROFILE_HIDDEN = ['_appointments', 'appointmentReminderEnabled'];
const RECEPTIONIST_PROFILE_HIDDEN = [
  'aiReceptionist',
  'aiReceptionistSettings',
  'aiReceptionistMessages',
  'aiReceptionistArchivedMessages',
  'receptionistConfig',
  'receptionistBilling',
  'aiReceptionistAddonActive',
  'aiReceptionistDashboardEnabled',
];
const DASHBOARD_PROFILE_HIDDEN = ['emailLeadSummaries', 'emailLeadSummariesEnabled', 'monitoredEmail'];

function hiddenTabProfileKeys(a: CrewAccess): string[] {
  if (!a.tabAccess) return [];
  const keys: string[] = [];
  if (!crewHasTab(a.tabAccess, 'calendar')) keys.push(...CALENDAR_PROFILE_HIDDEN);
  if (!crewHasTab(a.tabAccess, 'receptionist')) keys.push(...RECEPTIONIST_PROFILE_HIDDEN);
  if (!crewHasTab(a.tabAccess, 'dashboard')) keys.push(...DASHBOARD_PROFILE_HIDDEN);
  return keys;
}

function hiddenProfileKeys(a: CrewAccess): string[] {
  const fullData = crewHasFullDataAccess(a);
  return [
    ...(fullData ? [] : ALWAYS_PROFILE_HIDDEN),
    ...(a.canSeePricing ? [] : PRICING_PROFILE_HIDDEN),
    ...(a.canSeeFinancials ? [] : FINANCIAL_PROFILE_HIDDEN),
    ...hiddenTabProfileKeys(a),
  ];
}

function redactProfile(profile: unknown, a: CrewAccess): unknown {
  if (!isPlainObject(profile)) return profile;
  let p: Record<string, unknown> = { ...profile };
  for (const k of hiddenProfileKeys(a)) delete p[k];
  if (!a.canSeePricing) p = maskMoneyDeep(p);
  if (!a.canSeeFinancials && 'mileageRatePerMile' in p) p.mileageRatePerMile = 0;
  return p;
}

/**
 * Redact one estimates / archive-est row for a restricted crew member.
 * When financials are visible but unit pricing is not, the real grand total is
 * injected as `grandTotal` so lists and reports still show correct totals.
 */
export function redactRow(row: unknown, a: CrewAccess): unknown {
  if (!isPlainObject(row)) return row;
  const fullData = crewHasFullDataAccess(a);
  const tabRestricted = Boolean(a.tabAccess && !allCrewTabsAllowed(a.tabAccess));
  if (fullData && !tabRestricted) return row;
  const out: Record<string, unknown> = { ...row };

  if (!a.canSeePricing) {
    if (a.canSeeFinancials && 'items' in row && !String(row.id || '').startsWith('SETTINGS-')) {
      const { list } = parseItems(row.items);
      out.grandTotal = computeDocumentGrandTotal({ ...row, items: list });
    }
    if ('items' in row) {
      const { list, wasString } = parseItems(row.items);
      const masked = maskMoneyDeep(list);
      out.items = wasString ? JSON.stringify(masked) : masked;
    }
    for (const c of LABOR_MONEY_COLUMNS) if (c in out && out[c] !== null) out[c] = 0;
  }

  if (!a.canSeeFinancials) {
    for (const c of FINANCIAL_NUMBER_COLUMNS) if (c in out && out[c] !== null) out[c] = 0;
    if ('receiptDetails' in out) out.receiptDetails = null;
    if ('receiptdetails' in out) out.receiptdetails = null;
    if ('receiptUrls' in out) out.receiptUrls = [];
    if ('receipturls' in out) out.receipturls = [];
  }

  if ('profile' in out) out.profile = redactProfile(out.profile, a);
  return out;
}

export function redactRows(body: unknown, a: CrewAccess): unknown {
  if (Array.isArray(body)) return body.map((r) => redactRow(r, a));
  return redactRow(body, a);
}

function unionStrings(a: unknown, b: unknown): string[] {
  const list = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
    .map((x) => String(x || ''))
    .filter(Boolean);
  return [...new Set(list)];
}

export type RestoreSources = {
  /** The owner's stored row with the same id (null when the crew member is creating it). */
  existing: Record<string, unknown> | null;
  /** Owner's SETTINGS profile — source of hidden profile keys for brand-new documents. */
  ownerSettingsProfile: Record<string, unknown> | null;
  /** Owner's stored line items by item id — restores prices on copied/converted docs. */
  itemIndex: Map<string, Record<string, unknown>>;
};

/**
 * Before a restricted crew member's write: put back every value they could not see,
 * so redacted placeholders never overwrite the owner's real data. Values the crew
 * member could not see cannot be zeroed or erased from their side.
 */
export function restoreRow(
  incoming: Record<string, unknown>,
  a: CrewAccess,
  src: RestoreSources
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const k of INJECTED_KEYS) delete out[k];
  const fullData = crewHasFullDataAccess(a);
  const tabRestricted = Boolean(a.tabAccess && !allCrewTabsAllowed(a.tabAccess));
  if (fullData && !tabRestricted) return out;
  const existing = src.existing;

  if (!a.canSeePricing) {
    if ('items' in incoming) {
      const { list, wasString } = parseItems(incoming.items);
      const stored = existing ? parseItems(existing.items).list : [];
      const storedById = new Map<string, Record<string, unknown>>();
      for (const s of stored) {
        const k = matchKey(s);
        if (k && isPlainObject(s)) storedById.set(k, s);
      }
      const restored = list.map((el, i) => {
        if (!isPlainObject(el)) return el;
        const k = matchKey(el);
        const source =
          (k && (storedById.get(k) || src.itemIndex.get(k))) ||
          (!k && isPlainObject(stored[i]) ? (stored[i] as Record<string, unknown>) : undefined);
        if (!source) return el;
        const merged = restoreMoneyDeep(el, source) as Record<string, unknown>;
        // Quantity changed by crew: keep the owner's unit price, recompute the line total.
        const qty = Number(merged.qty ?? merged.quantity);
        const srcQty = Number(source.qty ?? source.quantity);
        const price = Number(merged.price);
        if (Number.isFinite(qty) && Number.isFinite(srcQty) && qty !== srcQty && Number.isFinite(price)) {
          merged.total = roundMoney(qty * price);
        }
        return merged;
      });
      out.items = wasString ? JSON.stringify(restored) : restored;
    }
    for (const c of LABOR_MONEY_COLUMNS) {
      if (c in out && isMaskedPlaceholder(out[c]) && existing && isNumberLike(existing[c])) {
        out[c] = existing[c];
      }
    }
  }

  if (!a.canSeeFinancials) {
    for (const c of FINANCIAL_NUMBER_COLUMNS) {
      if (c in out && isMaskedPlaceholder(out[c]) && existing && isNumberLike(existing[c])) {
        out[c] = existing[c];
      }
    }
    for (const c of ['receiptDetails', 'receiptdetails']) {
      if (c in out && existing && existing[c] != null) out[c] = existing[c];
    }
    for (const c of ['receiptUrls', 'receipturls']) {
      if (c in out && existing) out[c] = unionStrings(existing[c], out[c]);
    }
  }

  if ('profile' in out && isPlainObject(out.profile)) {
    const storedProfile = isPlainObject(existing?.profile)
      ? (existing!.profile as Record<string, unknown>)
      : src.ownerSettingsProfile || {};
    let p: Record<string, unknown> = { ...(out.profile as Record<string, unknown>) };
    if (!a.canSeePricing) p = restoreMoneyDeep(p, storedProfile);
    if (!a.canSeeFinancials && isMaskedPlaceholder(p.mileageRatePerMile) && isNumberLike(storedProfile.mileageRatePerMile)) {
      p.mileageRatePerMile = storedProfile.mileageRatePerMile;
    }
    for (const k of hiddenProfileKeys(a)) {
      if (k in storedProfile) p[k] = storedProfile[k];
      else delete p[k];
    }
    out.profile = p;
  }
  return out;
}

/** Item-id index over the owner's stored documents (restores prices on converted copies). */
export function buildItemIndex(rows: Array<{ items?: unknown }>): Map<string, Record<string, unknown>> {
  const idx = new Map<string, Record<string, unknown>>();
  for (const r of rows || []) {
    for (const it of parseItems(r?.items).list) {
      const k = matchKey(it);
      if (k && isPlainObject(it) && !idx.has(k)) idx.set(k, it);
    }
  }
  return idx;
}
