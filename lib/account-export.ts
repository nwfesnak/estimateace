import { extractMediaStoragePath } from '@/lib/media-url';
import { zipStore } from '@/lib/zip-store';

export type AccountExportOptions = {
  estimates: boolean;
  invoices: boolean;
  archives: boolean;
  photos: boolean;
  videos: boolean;
};

const textEncoder = new TextEncoder();

function jsonFile(name: string, value: unknown) {
  return { name, data: textEncoder.encode(JSON.stringify(value, null, 2)) };
}

function rowField(row: any, ...keys: string[]) {
  for (const key of keys) {
    if (row?.[key] != null) return row[key];
  }
  return undefined;
}

function isSettingsRow(row: any) {
  return String(row?.id || '').toUpperCase().startsWith('SETTINGS');
}

function isInvoiceRow(row: any) {
  const type = String(rowField(row, 'documentType', 'documenttype') || '').toLowerCase();
  const num = String(rowField(row, 'invoiceNumber', 'invoicenumber') || row?.id || '');
  return type === 'invoice' || num.toUpperCase().startsWith('INV');
}

/** Drop passwords and tokens. The rest of the account stays in the file. */
function sanitize(value: any): any {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/password|secret|token|service_role|otp/i.test(key)) continue;
    out[key] = sanitize(child);
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || '').trim()).filter(Boolean);
}

function mediaRefs(row: any): { photos: string[]; videos: string[]; receipts: string[] } {
  const photos = stringList(rowField(row, 'photoUrls', 'photourls'));
  const videos = stringList(rowField(row, 'videoUrls', 'videourls'));
  const receipts = stringList(rowField(row, 'receiptUrls', 'receipturls'));
  const profile = row?.profile && typeof row.profile === 'object' ? row.profile : {};
  const renders = Array.isArray(profile._jobRenderings) ? profile._jobRenderings : [];
  for (const render of renders) {
    if (render?.sourcePath) photos.push(String(render.sourcePath));
    if (render?.resultPath) photos.push(String(render.resultPath));
  }
  if (profile.logoUrl) photos.push(String(profile.logoUrl));
  if (profile.certificateUrl) photos.push(String(profile.certificateUrl));
  const qr = profile.paymentSettings?.zelle?.qrUrl;
  if (qr) photos.push(String(qr));
  return { photos, videos, receipts };
}

function fileNameFromRef(ref: string, index: number) {
  const path = extractMediaStoragePath(ref) || ref;
  const base = path.split('/').pop() || `file-${index}`;
  return base.replace(/[^\w.\-]+/g, '_').slice(0, 80);
}

export async function buildAccountExportZip(input: {
  documents: any[];
  archives: any[];
  options: AccountExportOptions;
  fetchMedia: (storagePath: string) => Promise<Uint8Array | null>;
  onProgress?: (message: string) => void;
}): Promise<{ blob: Blob; mediaFiles: number; missing: string[] }> {
  const active = (input.documents || []).filter((row) => !isSettingsRow(row));
  const settings = (input.documents || []).find((row) => isSettingsRow(row));
  const estimates = input.options.estimates ? active.filter((row) => !isInvoiceRow(row)) : [];
  const invoices = input.options.invoices ? active.filter((row) => isInvoiceRow(row)) : [];
  const archives = input.options.archives ? input.archives || [] : [];

  const files = [
    jsonFile('account.json', sanitize(settings?.profile || {})),
    jsonFile('estimates.json', sanitize(estimates)),
    jsonFile('invoices.json', sanitize(invoices)),
    jsonFile('archives.json', sanitize(archives)),
  ];

  const missing: string[] = [];
  let mediaFiles = 0;
  const seen = new Set<string>();
  const groups: Array<{ folder: string; refs: string[]; enabled: boolean }> = [];

  const pushGroup = (folder: string, rows: any[], pick: 'photos' | 'videos' | 'receipts', enabled: boolean) => {
    const refs: string[] = [];
    for (const row of rows) refs.push(...mediaRefs(row)[pick]);
    groups.push({ folder, refs, enabled });
  };

  const allRows = [...estimates, ...invoices, ...archives];
  pushGroup('photos', allRows, 'photos', input.options.photos);
  pushGroup('receipts', allRows, 'receipts', input.options.photos);
  pushGroup('videos', allRows, 'videos', input.options.videos);

  for (const group of groups) {
    if (!group.enabled) continue;
    let n = 0;
    for (const ref of group.refs) {
      const storagePath = extractMediaStoragePath(ref);
      if (!storagePath || seen.has(storagePath)) continue;
      seen.add(storagePath);
      n += 1;
      input.onProgress?.(`Downloading ${group.folder} ${n}…`);
      const bytes = await input.fetchMedia(storagePath);
      if (!bytes) {
        missing.push(storagePath);
        continue;
      }
      mediaFiles += 1;
      files.push({
        name: `${group.folder}/${String(mediaFiles).padStart(3, '0')}-${fileNameFromRef(storagePath, mediaFiles)}`,
        data: bytes.slice(),
      });
    }
  }

  if (missing.length) {
    files.push({
      name: 'missing-files.txt',
      data: textEncoder.encode(
        `These files could not be downloaded:\n${missing.join('\n')}\n`
      ),
    });
  }

  return { blob: zipStore(files), mediaFiles, missing };
}
