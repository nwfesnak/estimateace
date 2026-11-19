/**
 * Query-string guard for the crew data proxy (/api/crew/data/[table]).
 *
 * The proxy forwards PostgREST queries with the service-role key and then hides
 * prices / financials by top-level column name (lib/crew-redaction.ts). PostgREST can
 * rename (`x:items`), drill into JSON (`items->0->>price`) or embed related rows
 * (`x(*)`), and it can filter / sort on any column, which would let a restricted crew
 * member read or infer hidden values. So the proxy only accepts a small, plain query
 * shape: every read returns whole rows (`select=*`), and filters / sorting may only
 * use plain, non-sensitive columns.
 */

/** Plain columns a crew member's app may filter or sort on (never prices / money). */
export const CREW_FILTER_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'user_id',
  'invoiceNumber',
  'invoicenumber',
  'documentType',
  'documenttype',
  'jobName',
  'jobname',
  'date',
  'dueDate',
  'duedate',
  'updated_at',
  'archived_at',
  'created_at',
]);

/** Columns a write may list in PostgREST's `columns=` (plain identifiers only). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']);

/** Query keys PostgREST treats as instructions rather than column filters. */
const CONTROL_KEYS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'and', 'or']);

export type CrewQueryResult = { ok: true; params: URLSearchParams } | { ok: false; error: string };

function hasForbiddenSyntax(s: string): boolean {
  return s.includes('->') || s.includes(':') || s.includes('!');
}

/** `op.value` or `not.op.value`, with an allowed operator. */
function validFilterValue(value: string): boolean {
  let v = value;
  if (v.startsWith('not.')) v = v.slice(4);
  const dot = v.indexOf('.');
  if (dot <= 0) return false;
  const op = v.slice(0, dot);
  if (!FILTER_OPS.has(op)) return false;
  const rest = v.slice(dot + 1);
  if (op === 'in') return /^\(.*\)$/.test(rest);
  return true;
}

/** `or=(a.eq.1,b.ilike.x*)`: flat list of allowed-column conditions, no nesting. */
function validOrGroup(value: string): boolean {
  const m = /^\((.*)\)$/.exec(value);
  if (!m) return false;
  const inner = m[1];
  if (!inner || /[()"]/.test(inner)) return false;
  return inner.split(',').every((cond) => {
    const dot = cond.indexOf('.');
    if (dot <= 0) return false;
    const col = cond.slice(0, dot);
    if (!CREW_FILTER_COLUMNS.has(col)) return false;
    return validFilterValue(cond.slice(dot + 1));
  });
}

/** `order=updated_at.desc,archived_at.asc.nullslast` with allowed columns only. */
function validOrder(value: string): boolean {
  return value.split(',').every((part) => {
    const bits = part.trim().split('.');
    if (!bits[0] || !CREW_FILTER_COLUMNS.has(bits[0])) return false;
    return bits.slice(1).every((b) => ['asc', 'desc', 'nullsfirst', 'nullslast'].includes(b));
  });
}

/**
 * Validate and normalise a crew proxy query string.
 *  - `select` is always forced to `*` (whole rows, so redaction sees every column)
 *  - filters / `or` / `order` may only reference CREW_FILTER_COLUMNS
 *  - `and` is reserved for the server's own workspace scope
 *  - writes may pass `columns` (plain names) and `on_conflict=id`
 */
export function sanitizeCrewQuery(
  input: URLSearchParams,
  mode: 'read' | 'write'
): CrewQueryResult {
  const out = new URLSearchParams();
  for (const [rawKey, value] of input.entries()) {
    const key = rawKey.trim();
    if (key === 'select') {
      // Plain column lists are widened to whole rows (`*`) so redaction always sees
      // the real column names. Aliases, JSON paths, casts and embeds are refused.
      const parts = value.replace(/\s+/g, '').split(',');
      if (!parts.every((c) => c === '*' || IDENT.test(c.replace(/^"|"$/g, '')))) {
        return { ok: false, error: 'Only plain column selects are supported.' };
      }
      continue;
    }
    if (key === 'and') return { ok: false, error: 'Unsupported query.' };
    if (key === 'limit' || key === 'offset') {
      if (!/^\d{1,6}$/.test(value)) return { ok: false, error: `Invalid ${key}.` };
      out.set(key, value);
      continue;
    }
    if (key === 'order') {
      if (!validOrder(value)) return { ok: false, error: 'Sorting on that column is not allowed.' };
      out.set(key, value);
      continue;
    }
    if (key === 'or') {
      if (!validOrGroup(value)) return { ok: false, error: 'Filtering on that column is not allowed.' };
      out.set(key, value);
      continue;
    }
    if (key === 'on_conflict') {
      if (mode !== 'write' || value !== 'id') return { ok: false, error: 'Unsupported query.' };
      out.set(key, value);
      continue;
    }
    if (key === 'columns') {
      if (mode !== 'write') return { ok: false, error: 'Unsupported query.' };
      const cols = value.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      if (!cols.every((c) => IDENT.test(c))) return { ok: false, error: 'Invalid columns.' };
      out.set(key, value);
      continue;
    }
    if (CONTROL_KEYS.has(key)) return { ok: false, error: 'Unsupported query.' };
    // Column filter: plain allowed column + allowed operator.
    if (hasForbiddenSyntax(key) || !CREW_FILTER_COLUMNS.has(key)) {
      return { ok: false, error: 'Filtering on that column is not allowed.' };
    }
    if (!validFilterValue(value)) return { ok: false, error: 'Unsupported filter.' };
    out.append(key, value);
  }
  out.set('select', '*');
  return { ok: true, params: out };
}
