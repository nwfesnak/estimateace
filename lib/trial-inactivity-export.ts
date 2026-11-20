/**
 * Data export emailed before an inactive trial account is deleted.
 * Pure: turns the account's rows into ZIP entries (README + CSV + JSON) and the photo
 * download list. The runner copies the photos to the private `account-exports` bucket
 * (so they survive the deletion) and signs every link for ~30 days.
 */
import { zipStore } from '@/lib/zip-store';

const enc = new TextEncoder();
/* eslint-disable @typescript-eslint/no-explicit-any -- free-form JSON rows */

export type ExportSource = {
  documents: any[]; // public.estimates rows (estimates, invoices, jobs, settings, recurring plans)
  archives: any[]; // public."archive-est"
  receipts: any[]; // public.receipts
  crew: any[]; // public.crew_members (owner_user_id = user)
  callLog: any[]; // public.receptionist_call_finalizations
  blockedNumbers: any[]; // public.receptionist_blocked_numbers
};

export type ExportedFile = { path: string; url: string; bytes?: number | null };

/** Keys never exported (credentials / internal tokens). */
const SECRET_KEY = /password|secret|token|service_role|otp|auth_token|api[_-]?key|webhook/i;

export function sanitizeForExport(value: any, depth = 0): any {
  if (depth > 40) return null;
  if (Array.isArray(value)) return value.map((v) => sanitizeForExport(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = sanitizeForExport(v, depth + 1);
  }
  return out;
}

function field(row: any, ...keys: string[]) {
  for (const k of keys) if (row?.[k] != null && row[k] !== '') return row[k];
  return undefined;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
}

/** RFC 4180 CSV; also defuses spreadsheet formulas (=, +, -, @ at the start). */
export function toCsv(header: string[], rows: Array<Array<unknown>>): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function isSettingsRow(row: any): boolean {
  return String(row?.id || '').toUpperCase().startsWith('SETTINGS') || String(field(row, 'documentType', 'documenttype') || '') === 'settings';
}

export function documentKind(row: any): string {
  const t = String(field(row, 'documentType', 'documenttype') || '').toLowerCase();
  const num = String(field(row, 'invoiceNumber', 'invoicenumber') || row?.id || '').toUpperCase();
  if (t === 'invoice' || num.startsWith('INV')) return 'invoice';
  if (t === 'recurring_plan') return 'recurring_plan';
  return t || 'estimate';
}

function docTotal(row: any): number {
  const items = Array.isArray(row?.items) ? row.items : [];
  const sum = items.reduce((s: number, it: any) => s + (Number(it?.total) || Number(it?.qty || 0) * Number(it?.price || 0) || 0), 0);
  return Math.round(sum * 100) / 100;
}

export function buildExportEntries(src: ExportSource, files: ExportedFile[], meta: { email: string; generatedAt: string; expiresAt: string }) {
  const docs = (src.documents || []).filter((r) => !isSettingsRow(r));
  const settings = (src.documents || []).find(isSettingsRow);
  const profile = sanitizeForExport(settings?.profile || {});
  const all = [...docs.map((r) => ({ r, archived: false })), ...(src.archives || []).map((r) => ({ r, archived: true }))];

  const documentsCsv = toCsv(
    ['id', 'type', 'archived', 'number', 'date', 'due_date', 'job_or_customer', 'address', 'city', 'state', 'zip', 'emails', 'phones', 'items_total', 'amount_paid', 'payment_status', 'terms', 'notes', 'updated_at'],
    all.map(({ r, archived }) => [
      r.id,
      documentKind(r),
      archived ? 'yes' : 'no',
      field(r, 'invoiceNumber', 'invoicenumber'),
      r.date,
      field(r, 'dueDate', 'duedate'),
      field(r, 'jobName', 'jobname'),
      r.address,
      r.city,
      r.state,
      field(r, 'zipCode', 'zipcode'),
      list(r.emails).join('; '),
      list(r.phones).join('; '),
      docTotal(r),
      field(r, 'amountPaid', 'amountpaid'),
      field(r, 'paymentStatus', 'paymentstatus'),
      r.terms,
      field(r, 'notes'),
      field(r, 'updated_at'),
    ])
  );

  const lineRows: unknown[][] = [];
  for (const { r } of all) {
    const items = Array.isArray(r.items) ? r.items : [];
    items.forEach((it: any, i: number) => {
      const mats = Array.isArray(it?.materialsList) ? it.materialsList : [];
      lineRows.push([
        r.id,
        field(r, 'invoiceNumber', 'invoicenumber'),
        i + 1,
        it?.description,
        it?.qty,
        it?.unit,
        it?.price,
        it?.total,
        it?.optional ? 'yes' : 'no',
        mats.map((m: any) => `${m?.description ?? ''} ${m?.qty ?? ''} ${m?.unit ?? ''} @ ${m?.unitPrice ?? ''}`.trim()).join(' | '),
        it?.laborBreakdown ? `${it.laborBreakdown.hours ?? ''} hr @ ${it.laborBreakdown.rate ?? ''}` : '',
        it?.notes,
      ]);
    });
  }
  const lineItemsCsv = toCsv(
    ['document_id', 'number', 'line', 'description', 'qty', 'unit', 'unit_price', 'total', 'optional', 'materials', 'labor', 'notes'],
    lineRows
  );

  // Customers = unique client details across documents.
  const customers = new Map<string, unknown[]>();
  for (const { r } of all) {
    const name = String(field(r, 'jobName', 'jobname') || '').trim();
    const emails = list(r.emails).join('; ');
    const phones = list(r.phones).join('; ');
    const addr = [r.address, r.city, r.state, field(r, 'zipCode', 'zipcode')].filter(Boolean).join(', ');
    if (!name && !emails && !phones && !addr) continue;
    const key = `${name.toLowerCase()}|${emails.toLowerCase()}|${phones}|${addr.toLowerCase()}`;
    if (!customers.has(key)) customers.set(key, [name, emails, phones, addr]);
  }
  const customersCsv = toCsv(['name_or_job', 'emails', 'phones', 'address'], Array.from(customers.values()));

  const p = profile as Record<string, any>;
  const receptionistLeads = Array.isArray(p.aiReceptionistMessages) ? p.aiReceptionistMessages : [];
  const emailLeads = Array.isArray(p.emailLeadSummaries) ? p.emailLeadSummaries : [];
  const leadsCsv = toCsv(
    ['source', 'created_at', 'name', 'phone_or_email', 'subject', 'summary', 'status'],
    [
      ...receptionistLeads.map((m: any) => ['AI Receptionist', m?.createdAt, m?.callerName, m?.callerPhone, '', m?.summary, m?.status]),
      ...emailLeads.map((m: any) => ['Email', m?.createdAt, m?.fromName, m?.fromEmail, m?.subject, m?.summary, m?.status]),
    ]
  );

  const receiptsCsv = toCsv(
    ['id', 'date', 'vendor', 'amount', 'notes', 'document_id'],
    (src.receipts || []).map((r: any) => [r.id, r.date, r.vendor, r.amount, r.notes, field(r, 'estimate_id', 'document_id', 'invoice_number')])
  );

  const filesCsv = toCsv(['file', 'download_link (valid until ' + meta.expiresAt.slice(0, 10) + ')'], files.map((f) => [f.path, f.url]));

  const readme = [
    'EstimateAce data export',
    `Account: ${meta.email}`,
    `Created: ${meta.generatedAt}`,
    `Photo / file download links valid until: ${meta.expiresAt}`,
    '',
    'CSV files (open in Excel, Numbers or Google Sheets):',
    '  customers.csv   - customers / jobs and their contact details',
    '  documents.csv   - every estimate, invoice, job and recurring plan (including archived)',
    '  line-items.csv  - every line item with qty, unit, price, materials and labor',
    '  leads.csv       - AI Receptionist and email leads',
    '  receipts.csv    - receipts you logged',
    '  files.csv       - your photos and files with download links (also index.html)',
    '',
    'JSON files (complete records, for import into other software):',
    '  settings.json, documents.json, archives.json, receipts.json, crew.json, call-log.json, blocked-numbers.json',
    '',
    'Passwords, login codes and API tokens are never included.',
  ].join('\n');

  const json = (name: string, v: unknown) => ({ name, data: enc.encode(JSON.stringify(sanitizeForExport(v), null, 2)) });
  const text = (name: string, v: string) => ({ name, data: enc.encode(v) });
  return [
    text('README.txt', readme),
    text('customers.csv', '\ufeff' + customersCsv),
    text('documents.csv', '\ufeff' + documentsCsv),
    text('line-items.csv', '\ufeff' + lineItemsCsv),
    text('leads.csv', '\ufeff' + leadsCsv),
    text('receipts.csv', '\ufeff' + receiptsCsv),
    text('files.csv', '\ufeff' + filesCsv),
    text('index.html', filesIndexHtml(files, meta.expiresAt)),
    json('settings.json', settings?.profile || {}),
    json('documents.json', docs),
    json('archives.json', src.archives || []),
    json('receipts.json', src.receipts || []),
    json('crew.json', (src.crew || []).map((c: any) => ({ email: c.email, role: c.role, created_at: c.created_at }))),
    json('call-log.json', src.callLog || []),
    json('blocked-numbers.json', src.blockedNumbers || []),
  ];
}

function escHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function filesIndexHtml(files: ExportedFile[], expiresAt: string): string {
  const rows = files
    .map((f) => `<li><a href="${escHtml(f.url)}">${escHtml(f.path)}</a></li>`)
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EstimateAce files</title>
<body style="font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 12px;line-height:1.5">
<h1 style="font-size:20px">Your EstimateAce photos and files (${files.length})</h1>
<p>Tap a file to download it. Links work until ${escHtml(expiresAt.slice(0, 10))}.</p>
<ol>${rows || '<li>No photos or files.</li>'}</ol></body>`;
}

export function buildExportZip(src: ExportSource, files: ExportedFile[], meta: { email: string; generatedAt: string; expiresAt: string }): Blob {
  return zipStore(buildExportEntries(src, files, meta));
}
