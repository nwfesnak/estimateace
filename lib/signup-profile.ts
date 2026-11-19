/**
 * Company / name / phone entered on /trial are stored in auth user_metadata
 * at signup. When email confirmation is on, start-trial never runs with a
 * session, so SETTINGS stays empty until we copy those fields on first login.
 */

export type SignupProfileFields = {
  company: string;
  name: string;
  phone: string;
  email: string;
  preferredPlan: string;
  promo: string;
};

export function signupFieldsFromMetadata(
  user:
    | {
        email?: string | null;
        user_metadata?: Record<string, unknown> | null;
      }
    | null
    | undefined
): SignupProfileFields {
  const meta = (user?.user_metadata || {}) as Record<string, unknown>;
  return {
    company: String(meta.company || '').trim(),
    name: String(meta.full_name || meta.name || '').trim(),
    phone: String(meta.phone || '').trim(),
    email: String(user?.email || meta.email || '').trim(),
    preferredPlan: String(meta.preferred_plan || '').trim(),
    promo: String(meta.promo || '').trim(),
  };
}

function filled(value: unknown): string {
  return String(value || '').trim();
}

/**
 * Copy company / name / phone / email from auth user_metadata onto the
 * SETTINGS profile when those fields are still empty. Crew logins are skipped.
 * Returns true if SETTINGS was written.
 */
type SettingsRow = { profile?: unknown } | null;

type SettingsTable = {
  select: (columns: string) => {
    eq: (
      column: string,
      value: string
    ) => {
      maybeSingle: () => PromiseLike<{ data?: SettingsRow }>;
    };
  };
  upsert: (
    row: Record<string, unknown>
  ) => PromiseLike<{ error?: { message: string } | null }>;
};

export async function seedSettingsFromSignupMetadata(
  admin: { from: (table: string) => unknown },
  user: {
    id: string;
    email?: string | null;
    user_metadata?: Record<string, unknown> | null;
    app_metadata?: Record<string, unknown> | null;
  }
): Promise<boolean> {
  if (!admin || !user?.id) return false;
  if ((user.app_metadata as { is_crew?: boolean } | null)?.is_crew === true) return false;

  const meta = signupFieldsFromMetadata(user);
  if (!meta.company && !meta.name && !meta.phone && !meta.email) return false;

  const settingsId = `SETTINGS-${user.id}`;
  const table = admin.from('estimates') as SettingsTable;
  const { data: settings } = await table
    .select('profile')
    .eq('id', settingsId)
    .maybeSingle();

  const prev =
    settings?.profile && typeof settings.profile === 'object'
      ? (settings.profile as Record<string, unknown>)
      : {};

  const company = filled(prev.company) || meta.company;
  const name = filled(prev.name) || meta.name;
  const phone = filled(prev.phone) || meta.phone;
  const email = filled(prev.email) || meta.email;
  const plan =
    filled(prev.preferredBillingPlan) ||
    (meta.preferredPlan === 'yearly' ? 'yearly' : meta.preferredPlan === 'monthly' ? 'monthly' : '');

  const changed =
    company !== filled(prev.company) ||
    name !== filled(prev.name) ||
    phone !== filled(prev.phone) ||
    email !== filled(prev.email) ||
    (plan && plan !== filled(prev.preferredBillingPlan));

  if (!changed) return false;

  const profile: Record<string, unknown> = {
    ...prev,
    company,
    name,
    phone,
    email,
  };
  if (plan) profile.preferredBillingPlan = plan;

  const { error } = await table.upsert({
    id: settingsId,
    user_id: user.id,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    profile,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.warn('seedSettingsFromSignupMetadata:', error.message);
    return false;
  }
  return true;
}
