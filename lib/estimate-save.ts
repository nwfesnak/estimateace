/**
 * Build estimate row payloads for Supabase upsert.
 * Production DBs may use camelCase or lowercase column names depending on how schema was created.
 */

export type EstimateSaveInput = {
  id: string;
  user_id: string;
  jobName?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  phones?: string[];
  emails?: string[];
  date?: string;
  invoiceNumber?: string;
  items?: unknown;
  terms?: string;
  profile?: unknown;
  documentType?: string;
  dueDate?: string;
  paymentStatus?: string;
  amountPaid?: number;
  paymentMethod?: string;
  photoUrls?: string[];
  videoUrls?: string[];
  receiptUrls?: string[];
  receiptDetails?: unknown;
  laborHours?: number;
  laborRate?: number;
  laborFixedAmount?: number;
  useHourlyLabor?: boolean;
  laborAmount?: number;
  taxRate?: number;
  taxAmount?: number;
  isTaxExempt?: boolean;
  taxLabor?: boolean;
  updated_at?: string;
};

const PASSTHROUGH = new Set(['id', 'user_id', 'updated_at', 'created_at', 'profile', 'items', 'terms', 'phones', 'emails', 'address', 'city', 'state', 'date']);

export function toCamelEstimateRow(input: EstimateSaveInput): Record<string, unknown> {
  return {
    id: input.id,
    user_id: input.user_id,
    jobName: input.jobName ?? '',
    address: input.address ?? '',
    city: input.city ?? '',
    state: input.state ?? '',
    zipCode: input.zipCode ?? '',
    phones: Array.isArray(input.phones) ? input.phones : [],
    emails: Array.isArray(input.emails) ? input.emails : [],
    date: input.date ?? '',
    invoiceNumber: input.invoiceNumber || input.id,
    items: input.items ?? [],
    terms: input.terms ?? '',
    profile: input.profile ?? {},
    documentType: input.documentType || 'estimate',
    dueDate: input.dueDate ?? '',
    paymentStatus: input.paymentStatus || 'pending',
    amountPaid: Number(input.amountPaid) || 0,
    paymentMethod: input.paymentMethod ?? '',
    photoUrls: Array.isArray(input.photoUrls) ? input.photoUrls : [],
    videoUrls: Array.isArray(input.videoUrls) ? input.videoUrls : [],
    receiptUrls: Array.isArray(input.receiptUrls) ? input.receiptUrls : [],
    receiptDetails: input.receiptDetails ?? [],
    laborHours: Number(input.laborHours) || 0,
    laborRate: Number(input.laborRate) || 0,
    laborFixedAmount: Number(input.laborFixedAmount) || 0,
    useHourlyLabor: input.useHourlyLabor !== false,
    laborAmount: Number(input.laborAmount) || 0,
    taxRate: Number(input.taxRate) || 0,
    taxAmount: Number(input.taxAmount) || 0,
    isTaxExempt: !!input.isTaxExempt,
    taxLabor: input.taxLabor !== false,
    updated_at: input.updated_at || new Date().toISOString(),
  };
}

export function toLowerEstimateRow(input: EstimateSaveInput): Record<string, unknown> {
  const camel = toCamelEstimateRow(input);
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(camel)) {
    if (PASSTHROUGH.has(k) || k === 'user_id' || k === 'id') {
      lower[k] = v;
    } else {
      lower[k.toLowerCase()] = v;
    }
  }
  return lower;
}

/** Minimal columns almost every estimates table has */
export function toMinimalEstimateRow(input: EstimateSaveInput): Record<string, unknown> {
  return {
    id: input.id,
    user_id: input.user_id,
    jobname: input.jobName ?? '',
    address: input.address ?? '',
    city: input.city ?? '',
    state: input.state ?? '',
    zipcode: input.zipCode ?? '',
    phones: Array.isArray(input.phones) ? input.phones : [],
    emails: Array.isArray(input.emails) ? input.emails : [],
    date: input.date ?? '',
    invoicenumber: input.invoiceNumber || input.id,
    items: input.items ?? [],
    terms: input.terms ?? '',
    profile: input.profile ?? {},
    documenttype: input.documentType || 'estimate',
    updated_at: input.updated_at || new Date().toISOString(),
  };
}

export function formatSaveError(err: any): string {
  if (!err) return 'Unknown save error';
  return [err.code, err.message, err.details, err.hint].filter(Boolean).join(' | ') || String(err);
}
