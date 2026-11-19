/**
 * Sales-tax helpers for estimates.
 * Prefer a known city ZIP, then the job or business state.
 * Returns 0 when neither is known — never a misleading 7% default.
 */

export const ZIP_TAX_RATES: Record<string, number> = {
  '33101': 7.0,
  '33139': 7.0,
  '90210': 9.5,
  '10001': 8.875,
  '60601': 10.25,
  '77001': 8.25,
  '75201': 8.25,
  '94102': 8.5,
  '30303': 8.9,
  '33131': 7.0,
};

export const STATE_TAX_RATES: Record<string, number> = {
  AL: 4,
  AK: 0,
  AZ: 5.6,
  AR: 6.5,
  CA: 7.25,
  CO: 2.9,
  CT: 6.35,
  DE: 0,
  FL: 6,
  GA: 4,
  HI: 4,
  ID: 6,
  IL: 6.25,
  IN: 7,
  IA: 6,
  KS: 6.5,
  KY: 6,
  LA: 4.45,
  ME: 5.5,
  MD: 6,
  MA: 6.25,
  MI: 6,
  MN: 6.875,
  MS: 7,
  MO: 4.225,
  MT: 0,
  NE: 5.5,
  NV: 6.85,
  NH: 0,
  NJ: 6.625,
  NM: 5.125,
  NY: 4,
  NC: 4.75,
  ND: 5,
  OH: 5.75,
  OK: 4.5,
  OR: 0,
  PA: 6,
  RI: 7,
  SC: 6,
  SD: 4.5,
  TN: 7,
  TX: 6.25,
  UT: 4.85,
  VT: 6,
  VA: 4.3,
  WA: 6.5,
  WV: 6,
  WI: 5,
  WY: 4,
};

export function getTaxRateFromZip(zip: string, fallbackState: string): number {
  const cleanZip = String(zip || '')
    .trim()
    .replace(/\D/g, '')
    .slice(0, 5);
  if (cleanZip && ZIP_TAX_RATES[cleanZip] != null) return ZIP_TAX_RATES[cleanZip];

  const state = String(fallbackState || '')
    .trim()
    .toUpperCase();
  if (state && STATE_TAX_RATES[state] != null) return STATE_TAX_RATES[state];
  return 0;
}
