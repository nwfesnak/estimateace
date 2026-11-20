/**
 * Per-tab crew permissions.
 *
 * Every main app tab/section can be allowed or denied per crew member by the owner:
 *   dashboard, estimates, invoices, newEstimate, reports, calendar, recurring, receptionist
 *
 * Invariants (never toggleable):
 *   - Company Profile is ALWAYS owner-only (PR #51).
 *   - Account (own login email + "Crew member of {company}") is ALWAYS available to crew
 *     so a crew login is never stranded if all workspace tabs are denied.
 */

export const CREW_TAB_KEYS = [
  'dashboard',
  'estimates',
  'invoices',
  'newEstimate',
  'reports',
  'calendar',
  'recurring',
  'receptionist',
] as const;

export type CrewTabKey = (typeof CREW_TAB_KEYS)[number];

export type CrewTabAccess = Record<CrewTabKey, boolean>;

export type CrewTabMeta = {
  key: CrewTabKey;
  label: string;
  icon: string;
  description: string;
};

export const CREW_TABS: readonly CrewTabMeta[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    icon: '📊',
    description: 'Overview, YTD sales, and email leads box',
  },
  {
    key: 'estimates',
    label: 'Estimates',
    icon: '📋',
    description: 'View and edit existing estimates',
  },
  {
    key: 'invoices',
    label: 'Invoices',
    icon: '💰',
    description: 'View, edit, and convert invoices',
  },
  {
    key: 'newEstimate',
    label: 'New Estimate',
    icon: '📄',
    description: 'Create new estimates in the editor',
  },
  {
    key: 'reports',
    label: 'Reports',
    icon: '📈',
    description: 'Profit, paid invoices, archives, and tax/mileage',
  },
  {
    key: 'calendar',
    label: 'Calendar',
    icon: '📅',
    description: 'Schedule, appointments, and reminders',
  },
  {
    key: 'recurring',
    label: 'Recurring',
    icon: '🔁',
    description: 'Manage recurring client billing plans',
  },
  {
    key: 'receptionist',
    label: 'AI Receptionist',
    icon: '📞',
    description: 'AI phone receptionist leads and settings',
  },
] as const;

/**
 * Legacy-compatible defaults: when tab_access is NULL or omitted (existing crew rows
 * created before per-tab toggles), every workspace tab remains allowed so existing
 * crew keep their current behavior until the owner turns specific tabs off.
 */
export const DEFAULT_CREW_TAB_ACCESS: CrewTabAccess = {
  dashboard: true,
  estimates: true,
  invoices: true,
  newEstimate: true,
  reports: true,
  calendar: true,
  recurring: true,
  receptionist: true,
};

export function createUniformCrewTabAccess(allowed: boolean): CrewTabAccess {
  return {
    dashboard: allowed,
    estimates: allowed,
    invoices: allowed,
    newEstimate: allowed,
    reports: allowed,
    calendar: allowed,
    recurring: allowed,
    receptionist: allowed,
  };
}

export function normalizeCrewTabAccess(raw: unknown): CrewTabAccess {
  const base: CrewTabAccess = { ...DEFAULT_CREW_TAB_ACCESS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const obj = raw as Record<string, unknown>;
  for (const key of CREW_TAB_KEYS) {
    if (typeof obj[key] === 'boolean') {
      base[key] = obj[key] as boolean;
    }
  }
  return base;
}

export function parseCrewTabAccessPatch(raw: unknown): Partial<CrewTabAccess> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const patch: Partial<CrewTabAccess> = {};
  let hasAny = false;
  for (const key of CREW_TAB_KEYS) {
    if (typeof obj[key] === 'boolean') {
      patch[key] = obj[key] as boolean;
      hasAny = true;
    }
  }
  return hasAny ? patch : null;
}

export function mergeCrewTabAccess(
  existing: unknown,
  patch: Partial<CrewTabAccess> | null | undefined
): CrewTabAccess {
  const base = normalizeCrewTabAccess(existing);
  if (!patch) return base;
  for (const key of CREW_TAB_KEYS) {
    if (typeof patch[key] === 'boolean') {
      base[key] = patch[key] as boolean;
    }
  }
  return base;
}

export function crewHasTab(
  access: Partial<CrewTabAccess> | CrewTabAccess | null | undefined,
  tab: CrewTabKey
): boolean {
  if (!access) return true;
  const val = access[tab];
  return val !== false;
}

export function allCrewTabsAllowed(
  access: Partial<CrewTabAccess> | CrewTabAccess | null | undefined
): boolean {
  if (!access) return true;
  return CREW_TAB_KEYS.every((k) => access[k] !== false);
}

export function countAllowedCrewTabs(
  access: Partial<CrewTabAccess> | CrewTabAccess | null | undefined
): number {
  const norm = normalizeCrewTabAccess(access);
  return CREW_TAB_KEYS.filter((k) => norm[k]).length;
}

const LANDING_ORDER: readonly CrewTabKey[] = [
  'dashboard',
  'estimates',
  'invoices',
  'newEstimate',
  'reports',
  'recurring',
  'receptionist',
  'calendar',
];

/**
 * First allowed landing view for a crew member.
 * Note: 'calendar' opens as a modal on top of a screen, so when only 'calendar'
 * (or zero tabs) is allowed, the crew member lands on 'account' and can still
 * open Calendar from the bottom nav if allowed.
 */
export function firstAllowedCrewTab(
  access: Partial<CrewTabAccess> | CrewTabAccess | null | undefined
): CrewTabKey | 'account' {
  const norm = normalizeCrewTabAccess(access);
  for (const k of LANDING_ORDER) {
    if (k === 'calendar') continue;
    if (norm[k]) return k;
  }
  return 'account';
}

export type WorkspaceRowKind = 'settings' | 'secret' | 'recurring' | 'invoice' | 'estimate';

export function classifyWorkspaceDocumentRow(
  row: Record<string, unknown> | null | undefined
): WorkspaceRowKind {
  const id = String(row?.id ?? '').trim();
  if (/^SETTINGS-/i.test(id)) return 'settings';
  if (/^(RECEPTIONIST-SECRETS-|PLATFORM-)/i.test(id)) return 'secret';
  const docType = String(row?.documentType ?? row?.documenttype ?? '')
    .trim()
    .toLowerCase();
  if (docType === 'recurring_plan' || /^REC-/i.test(id)) return 'recurring';
  if (docType === 'invoice' || /^INV-/i.test(id)) return 'invoice';
  return 'estimate';
}

export function crewCanReadDocumentRow(
  access: CrewTabAccess,
  row: Record<string, unknown> | null | undefined,
  table: 'estimates' | 'archive-est' = 'estimates'
): boolean {
  if (table === 'archive-est' && !access.reports) return false;
  const kind = classifyWorkspaceDocumentRow(row);
  if (kind === 'secret') return false;
  if (kind === 'settings') return table === 'estimates';
  if (kind === 'recurring') return access.recurring || access.reports;
  if (kind === 'invoice') return access.invoices;
  return access.estimates;
}

export function crewCanWriteDocumentRow(
  access: CrewTabAccess,
  row: Record<string, unknown> | null | undefined,
  opts?: { isNew?: boolean }
): boolean {
  const kind = classifyWorkspaceDocumentRow(row);
  if (kind === 'secret' || kind === 'settings') return false;
  if (kind === 'recurring') return access.recurring;
  if (kind === 'invoice') return access.invoices;
  if (opts?.isNew) return access.newEstimate;
  return access.estimates || access.newEstimate;
}

export function crewCanUseEditorTool(access: CrewTabAccess): boolean {
  return access.estimates || access.invoices || access.newEstimate;
}

export const CREW_TAB_DENIED_MESSAGE =
  'You do not have access to this tab. Ask the account owner to allow it.';
