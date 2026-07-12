export type QuoteLocationInput = {
  city?: string;
  state?: string;
  zipCode?: string;
  address?: string;
};

export type RegionalPricing = {
  label: string;
  city: string;
  state: string;
  zipCode: string;
  source: 'job' | 'company' | 'default';
  materialMultiplier: number;
  laborMultiplier: number;
  costTier: 'low' | 'average' | 'high' | 'very_high';
};

const STATE_PROFILES: Record<
  string,
  { material: number; labor: number; tier: RegionalPricing['costTier'] }
> = {
  AK: { material: 1.14, labor: 1.18, tier: 'high' },
  AL: { material: 0.94, labor: 0.88, tier: 'low' },
  AR: { material: 0.92, labor: 0.86, tier: 'low' },
  AZ: { material: 0.98, labor: 0.96, tier: 'average' },
  CA: { material: 1.14, labor: 1.32, tier: 'very_high' },
  CO: { material: 1.04, labor: 1.08, tier: 'high' },
  CT: { material: 1.08, labor: 1.18, tier: 'high' },
  DC: { material: 1.10, labor: 1.22, tier: 'very_high' },
  DE: { material: 1.02, labor: 1.02, tier: 'average' },
  FL: { material: 0.98, labor: 0.94, tier: 'average' },
  GA: { material: 0.96, labor: 0.92, tier: 'average' },
  HI: { material: 1.18, labor: 1.35, tier: 'very_high' },
  IA: { material: 0.94, labor: 0.88, tier: 'low' },
  ID: { material: 0.96, labor: 0.90, tier: 'low' },
  IL: { material: 1.02, labor: 1.06, tier: 'average' },
  IN: { material: 0.94, labor: 0.90, tier: 'low' },
  KS: { material: 0.94, labor: 0.88, tier: 'low' },
  KY: { material: 0.92, labor: 0.88, tier: 'low' },
  LA: { material: 0.96, labor: 0.90, tier: 'low' },
  MA: { material: 1.10, labor: 1.24, tier: 'very_high' },
  MD: { material: 1.06, labor: 1.12, tier: 'high' },
  ME: { material: 1.02, labor: 1.00, tier: 'average' },
  MI: { material: 0.98, labor: 0.96, tier: 'average' },
  MN: { material: 1.00, labor: 1.02, tier: 'average' },
  MO: { material: 0.94, labor: 0.90, tier: 'low' },
  MS: { material: 0.90, labor: 0.84, tier: 'low' },
  MT: { material: 0.98, labor: 0.92, tier: 'low' },
  NC: { material: 0.96, labor: 0.94, tier: 'average' },
  ND: { material: 0.96, labor: 0.90, tier: 'low' },
  NE: { material: 0.94, labor: 0.90, tier: 'low' },
  NH: { material: 1.04, labor: 1.06, tier: 'average' },
  NJ: { material: 1.08, labor: 1.20, tier: 'high' },
  NM: { material: 0.96, labor: 0.92, tier: 'low' },
  NV: { material: 1.02, labor: 1.04, tier: 'average' },
  NY: { material: 1.12, labor: 1.28, tier: 'very_high' },
  OH: { material: 0.96, labor: 0.92, tier: 'average' },
  OK: { material: 0.92, labor: 0.86, tier: 'low' },
  OR: { material: 1.06, labor: 1.10, tier: 'high' },
  PA: { material: 1.00, labor: 1.00, tier: 'average' },
  RI: { material: 1.06, labor: 1.12, tier: 'high' },
  SC: { material: 0.94, labor: 0.90, tier: 'low' },
  SD: { material: 0.94, labor: 0.88, tier: 'low' },
  TN: { material: 0.94, labor: 0.92, tier: 'low' },
  TX: { material: 0.96, labor: 0.94, tier: 'average' },
  UT: { material: 1.00, labor: 0.98, tier: 'average' },
  VA: { material: 1.02, labor: 1.04, tier: 'average' },
  VT: { material: 1.04, labor: 1.04, tier: 'average' },
  WA: { material: 1.10, labor: 1.18, tier: 'high' },
  WI: { material: 0.98, labor: 0.96, tier: 'average' },
  WV: { material: 0.90, labor: 0.86, tier: 'low' },
  WY: { material: 0.96, labor: 0.90, tier: 'low' },
};

/** Known high cost-of-living ZIP codes — small bump on top of state factors. */
const METRO_ZIP_BONUS: Record<string, number> = {
  '10001': 1.08,
  '10019': 1.08,
  '11201': 1.06,
  '02108': 1.07,
  '02116': 1.06,
  '20001': 1.06,
  '20009': 1.05,
  '33101': 1.05,
  '33139': 1.06,
  '33131': 1.05,
  '60601': 1.05,
  '60611': 1.05,
  '77001': 1.03,
  '75201': 1.03,
  '85001': 1.03,
  '89101': 1.03,
  '90012': 1.08,
  '90210': 1.10,
  '94102': 1.09,
  '94107': 1.07,
  '98101': 1.06,
  '80202': 1.04,
  '30303': 1.04,
  '19102': 1.04,
  '97201': 1.05,
};

const cleanZip = (zip?: string) => (zip || '').trim().replace(/\D/g, '').slice(0, 5);
const cleanState = (state?: string) => (state || '').trim().toUpperCase().slice(0, 2);

function pickLocation(job?: QuoteLocationInput, company?: QuoteLocationInput) {
  const jobZip = cleanZip(job?.zipCode);
  const jobState = cleanState(job?.state);
  const companyZip = cleanZip(company?.zipCode);
  const companyState = cleanState(company?.state);

  if (jobZip || jobState) {
    return {
      city: (job?.city || '').trim(),
      state: jobState,
      zipCode: jobZip,
      address: (job?.address || '').trim(),
      source: 'job' as const,
    };
  }

  if (companyZip || companyState) {
    return {
      city: (company?.city || '').trim(),
      state: companyState,
      zipCode: companyZip,
      address: (company?.address || '').trim(),
      source: 'company' as const,
    };
  }

  return {
    city: '',
    state: '',
    zipCode: '',
    address: '',
    source: 'default' as const,
  };
}

export function resolveRegionalPricing(
  jobLocation?: QuoteLocationInput,
  companyLocation?: QuoteLocationInput
): RegionalPricing {
  const loc = pickLocation(jobLocation, companyLocation);
  const profile = STATE_PROFILES[loc.state] || {
    material: 1,
    labor: 1,
    tier: 'average' as const,
  };

  const zipBonus = loc.zipCode ? METRO_ZIP_BONUS[loc.zipCode] || 1 : 1;
  const materialMultiplier = Math.round(profile.material * zipBonus * 100) / 100;
  const laborMultiplier = Math.round(profile.labor * zipBonus * 100) / 100;

  const placeParts = [loc.city, loc.state, loc.zipCode].filter(Boolean);
  const label =
    placeParts.length > 0
      ? placeParts.join(', ')
      : 'US national average';

  return {
    label,
    city: loc.city,
    state: loc.state,
    zipCode: loc.zipCode,
    source: loc.source,
    materialMultiplier,
    laborMultiplier,
    costTier: profile.tier,
  };
}

export function buildRegionalPromptSection(regional: RegionalPricing): string {
  if (regional.source === 'default') {
    return `LOCATION: No job or company ZIP/state provided — use US national average mid-market pricing.`;
  }

  const tierNotes: Record<RegionalPricing['costTier'], string> = {
    low: 'Lower cost market — use competitive local pricing below US average where appropriate.',
    average: 'Average US cost market — standard mid-grade retail and labor.',
    high: 'Higher cost market — adjust materials and labor upward vs national average.',
    very_high: 'Very high cost market (major metro / coastal) — price for local big-box retail and prevailing skilled labor in this area.',
  };

  const laborBands = getRegionalLaborBands(regional);

  return `LOCATION (price for THIS area — critical):
- Job market: ${regional.label} (${regional.source === 'job' ? 'from estimate job address' : 'from company profile'})
- Cost tier: ${regional.costTier.replace('_', ' ')} — ${tierNotes[regional.costTier]}
- Regional material factor vs US average: ${regional.materialMultiplier}x
- Regional labor factor vs US average: ${regional.laborMultiplier}x
- Local labor rate targets (${regional.state || 'region'}): ${laborBands}
- Use stores and supply houses typical for ${regional.city || regional.state || 'this state'} (Home Depot / Lowe's / local supplier pricing in this market, not national luxury pricing).`;
}

export function getRegionalLaborBands(regional: RegionalPricing): string {
  const base = {
    general: { low: 50, high: 65 },
    paint: { low: 55, high: 72 },
    floor: { low: 58, high: 78 },
    trade: { low: 72, high: 95 },
  };

  const m = regional.laborMultiplier;
  const fmt = (n: number) => Math.round(n * m);
  return (
    `general/handyman $${fmt(base.general.low)}–$${fmt(base.general.high)}/hr, ` +
    `paint/drywall $${fmt(base.paint.low)}–$${fmt(base.paint.high)}/hr, ` +
    `flooring $${fmt(base.floor.low)}–$${fmt(base.floor.high)}/hr, ` +
    `plumbing/electrical $${fmt(base.trade.low)}–$${fmt(base.trade.high)}/hr`
  );
}

export type QuoteLineContext = {
  qty?: number;
  unit?: string;
};

export function buildQuoteUserMessage(
  description: string,
  regional: RegionalPricing,
  lineContext?: QuoteLineContext,
  jobLocation?: QuoteLocationInput
): string {
  const parts = [`Line item to estimate:\n${description.trim()}`];

  if (jobLocation?.address?.trim()) {
    parts.push(`Job address: ${jobLocation.address.trim()}`);
  }
  parts.push(`Pricing region: ${regional.label || 'US national average'}`);

  const qty = Number(lineContext?.qty);
  const unit = (lineContext?.unit || '').trim();
  if (Number.isFinite(qty) && qty > 0 && unit) {
    parts.push(
      `User already set quantity: ${qty} ${unit} — use this qty and unit unless the description clearly requires a different measure.`
    );
  } else if (Number.isFinite(qty) && qty > 0) {
    parts.push(`User already set quantity: ${qty} — respect this in suggestedQty when appropriate.`);
  }

  return parts.join('\n');
}