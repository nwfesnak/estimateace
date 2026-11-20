import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { enforceAppAccess } from '@/lib/billing-access';
import { getCrewAccess, loadCrewRestoreSources, type CrewAccessResult } from '@/lib/crew-access';
import { INJECTED_KEYS, redactRows, restoreRow } from '@/lib/crew-redaction';
import { sanitizeCrewQuery } from '@/lib/crew-query';
import { isReservedDocumentId } from '@/lib/company-profile-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Crew data proxy: the browser's Supabase client sends a restricted crew member's
 * reads/writes of `estimates` / `archive-est` here instead of to the database
 * (lib/supabase/client.ts). RLS no longer lets restricted crew touch those tables
 * directly, so this route is the only way in, and it:
 *   - scopes every query to the crew member's owner workspace
 *   - hides prices / financials the crew member's access level hides in the UI
 *   - restores the owner's real values before any write (no zeroing via redacted copies)
 *   - blocks deletes, settings / reserved rows, and archive access without financials
 *   - only accepts plain queries (lib/crew-query.ts): whole-row selects, filters and
 *     sorting on non-sensitive columns, no PostgREST aliases / JSON paths / embeds, and
 *     no schema-switching profile headers
 */

const TABLES = new Set(['estimates', 'archive-est']);
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'prefer',
  'content-type',
  'range',
  'range-unit',
];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'content-range', 'preference-applied'];
const SENSITIVE_PATCH_KEYS = new Set([
  'items',
  'profile',
  'laborRate',
  'laborrate',
  'laborAmount',
  'laboramount',
  'laborFixedAmount',
  'laborfixedamount',
  'amountPaid',
  'amountpaid',
  'taxAmount',
  'taxamount',
  'receiptDetails',
  'receiptdetails',
  'receiptUrls',
  'receipturls',
]);

type Ctx = { params: Promise<{ table: string }> };

function deny(status: number, message: string, code?: string) {
  return NextResponse.json({ message, error: message, code: code || 'crew_access_denied' }, { status });
}

function restBase(): string {
  return `${(process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/$/, '')}/rest/v1`;
}

function serviceHeaders(request: NextRequest): Headers {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const h = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v) h.set(name, v);
  }
  h.set('apikey', key);
  h.set('authorization', `Bearer ${key}`);
  return h;
}

/** Owner scope + never expose settings/secret rows to crew reads or patches. */
function scopeFilter(ownerId: string, opts: { allowSettingsRead?: boolean } = {}): string {
  const parts = [`user_id.eq.${ownerId}`, 'id.not.like.RECEPTIONIST-SECRETS-*', 'id.not.like.PLATFORM-*'];
  if (!opts.allowSettingsRead) parts.push('id.not.like.SETTINGS-*');
  else parts.push(`or(id.not.like.SETTINGS-*,id.eq.SETTINGS-${ownerId})`);
  return `(${parts.join(',')})`;
}

function stripInjectedColumns(params: URLSearchParams) {
  const cols = params.get('columns');
  if (!cols) return;
  const kept = cols
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && !(INJECTED_KEYS as readonly string[]).includes(c.replace(/"/g, '')));
  params.set('columns', kept.join(','));
}

async function respond(upstream: Response, access: CrewAccessResult): Promise<NextResponse> {
  const headers = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  const text = await upstream.text();
  if (!text) return new NextResponse(null, { status: upstream.status, headers });
  const isJson = /json/i.test(upstream.headers.get('content-type') || '');
  if (upstream.ok && isJson) {
    try {
      const body = redactRows(JSON.parse(text), access);
      return new NextResponse(JSON.stringify(body), { status: upstream.status, headers });
    } catch {
      /* fall through: non-JSON body */
    }
  }
  if (!upstream.ok) {
    // Pass PostgREST error shape through (code/message) so the client's fallbacks still work.
    return new NextResponse(text, { status: upstream.status, headers });
  }
  return new NextResponse(text, { status: upstream.status, headers });
}

async function resolve(request: NextRequest, ctx: Ctx) {
  const { table } = await ctx.params;
  if (!TABLES.has(table)) return { error: deny(404, 'Unknown table') };
  const { user } = await getUserFromRequest(request);
  if (!user) return { error: deny(401, 'Unauthorized', 'unauthorized') };
  const admin = getSupabaseAdmin();
  if (!admin || !(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) {
    return { error: deny(503, 'Server is not configured.', 'not_configured') };
  }
  const access = await getCrewAccess(admin, user.id);
  if (!access) return { error: deny(403, 'This login is not an active crew member.') };
  const paywall = await enforceAppAccess(user.id);
  if (paywall) return { error: paywall };
  return { table, user, admin, access };
}

async function handleRead(request: NextRequest, ctx: Ctx, method: 'GET' | 'HEAD') {
  const r = await resolve(request, ctx);
  if ('error' in r) return r.error;
  const { table, access } = r;
  const q = sanitizeCrewQuery(request.nextUrl.searchParams, 'read');
  if (!q.ok) return deny(400, q.error, 'crew_query_rejected');
  const params = q.params;
  if (table === 'archive-est' && !access.canSeeFinancials) {
    // Paid / archived work is a financial report: hidden at this access level.
    const single = /vnd\.pgrst\.object/i.test(request.headers.get('accept') || '');
    if (single) return deny(406, 'Not available for your crew access level.', 'PGRST116');
    return NextResponse.json([], { headers: { 'content-range': '*/0' } });
  }
  params.set('and', scopeFilter(access.ownerId, { allowSettingsRead: table === 'estimates' }));
  const upstream = await fetch(`${restBase()}/${table}?${params.toString()}`, {
    method,
    headers: serviceHeaders(request),
    cache: 'no-store',
  });
  return respond(upstream, access);
}

export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    return await handleRead(request, ctx, 'GET');
  } catch (e) {
    console.error('crew data GET:', e);
    return deny(500, 'Request failed', 'server_error');
  }
}

export async function HEAD(request: NextRequest, ctx: Ctx) {
  try {
    return await handleRead(request, ctx, 'HEAD');
  } catch (e) {
    console.error('crew data HEAD:', e);
    return deny(500, 'Request failed', 'server_error');
  }
}

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const r = await resolve(request, ctx);
    if ('error' in r) return r.error;
    const { table, admin, access } = r;
    if (table === 'archive-est' && !access.canSeeFinancials) {
      return deny(403, 'Archived and paid work is restricted for your crew access level.');
    }
    const raw = await request.json().catch(() => null);
    if (!raw || typeof raw !== 'object') return deny(400, 'Invalid body.');
    const wasArray = Array.isArray(raw);
    const rows = (wasArray ? raw : [raw]) as Record<string, unknown>[];
    if (rows.length === 0 || rows.length > 200) return deny(400, 'Invalid body.');

    const ids: string[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return deny(400, 'Invalid row.');
      if (row.user_id == null || row.user_id === '') row.user_id = access.ownerId;
      if (String(row.user_id) !== access.ownerId) {
        return deny(403, 'Crew can only save documents in their own workspace.');
      }
      const id = String(row.id ?? '').trim();
      if (!id) return deny(400, 'Document id is required.');
      if (isReservedDocumentId(id)) {
        return deny(403, 'Only the account owner can change workspace settings.');
      }
      ids.push(id);
    }

    // Ids are global primary keys: an existing row must already be this workspace's.
    const { data: existingRows, error: exErr } = await admin.from(table).select('*').in('id', ids);
    if (exErr) {
      console.error('crew data POST existing:', exErr);
      return deny(500, 'Could not verify document ownership.', 'server_error');
    }
    const existingById = new Map<string, Record<string, unknown>>();
    for (const e of (existingRows as Record<string, unknown>[]) || []) {
      if (String(e.user_id) !== access.ownerId) {
        return deny(
          409,
          'That document number is already used by another account. Start a new estimate to get a fresh number.',
          'document_id_taken'
        );
      }
      existingById.set(String(e.id), e);
    }

    const needItemIndex = !access.canSeePricing && rows.some((row) => !existingById.has(String(row.id)));
    const sources = await loadCrewRestoreSources(admin, access, needItemIndex);
    const restored = rows.map((row) =>
      restoreRow(row, access, { ...sources, existing: existingById.get(String(row.id)) || null })
    );

    const q = sanitizeCrewQuery(request.nextUrl.searchParams, 'write');
    if (!q.ok) return deny(400, q.error, 'crew_query_rejected');
    const params = q.params;
    stripInjectedColumns(params);
    const upstream = await fetch(`${restBase()}/${table}?${params.toString()}`, {
      method: 'POST',
      headers: serviceHeaders(request),
      body: JSON.stringify(wasArray ? restored : restored[0]),
      cache: 'no-store',
    });
    return respond(upstream, access);
  } catch (e) {
    console.error('crew data POST:', e);
    return deny(500, 'Save failed', 'server_error');
  }
}

export async function PATCH(request: NextRequest, ctx: Ctx) {
  try {
    const r = await resolve(request, ctx);
    if ('error' in r) return r.error;
    const { table, admin, access } = r;
    if (table === 'archive-est' && !access.canSeeFinancials) {
      return deny(403, 'Archived and paid work is restricted for your crew access level.');
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return deny(400, 'Invalid body.');
    const patch = { ...(body as Record<string, unknown>) };
    for (const k of INJECTED_KEYS) delete patch[k];
    if ('id' in patch) return deny(400, 'Document id cannot be changed.');
    if ('user_id' in patch && String(patch.user_id) !== access.ownerId) {
      return deny(403, 'Document owner cannot be changed.');
    }

    const q = sanitizeCrewQuery(request.nextUrl.searchParams, 'write');
    if (!q.ok) return deny(400, q.error, 'crew_query_rejected');
    const params = q.params;
    params.delete('on_conflict');
    params.set('and', scopeFilter(access.ownerId));
    stripInjectedColumns(params);
    const base = `${restBase()}/${table}`;

    const sensitive = Object.keys(patch).some((k) => SENSITIVE_PATCH_KEYS.has(k));
    if (!sensitive) {
      const upstream = await fetch(`${base}?${params.toString()}`, {
        method: 'PATCH',
        headers: serviceHeaders(request),
        body: JSON.stringify(patch),
        cache: 'no-store',
      });
      return respond(upstream, access);
    }

    // Patch touches hidden fields: restore per matching row, then update each by id.
    const sel = new URLSearchParams(params);
    sel.set('select', '*');
    sel.set('limit', '100');
    const readHeaders = serviceHeaders(request);
    readHeaders.set('accept', 'application/json');
    readHeaders.delete('prefer');
    readHeaders.delete('content-type');
    const matchRes = await fetch(`${base}?${sel.toString()}`, { headers: readHeaders, cache: 'no-store' });
    if (!matchRes.ok) return respond(matchRes, access);
    const matches = ((await matchRes.json().catch(() => [])) as Record<string, unknown>[]) || [];
    const sources = await loadCrewRestoreSources(admin, access, false);
    const updated: unknown[] = [];
    for (const row of matches) {
      const restored = restoreRow(patch, access, { ...sources, existing: row });
      const one = new URLSearchParams();
      one.set('id', `eq.${String(row.id)}`);
      one.set('and', scopeFilter(access.ownerId));
      const h = serviceHeaders(request);
      h.set('accept', 'application/json');
      h.set('content-type', 'application/json');
      h.set('prefer', 'return=representation');
      const res = await fetch(`${base}?${one.toString()}`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify(restored),
        cache: 'no-store',
      });
      if (!res.ok) return respond(res, access);
      const out = await res.json().catch(() => []);
      if (Array.isArray(out)) updated.push(...out);
    }
    const wantsRows = /return=representation/i.test(request.headers.get('prefer') || '');
    if (!wantsRows) return new NextResponse(null, { status: 204 });
    const single = /vnd\.pgrst\.object/i.test(request.headers.get('accept') || '');
    const redacted = redactRows(updated, access) as unknown[];
    return NextResponse.json(single ? redacted[0] ?? null : redacted);
  } catch (e) {
    console.error('crew data PATCH:', e);
    return deny(500, 'Save failed', 'server_error');
  }
}

export async function DELETE() {
  return deny(403, 'Only the account owner can delete documents.');
}
