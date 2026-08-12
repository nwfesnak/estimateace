/**
 * Mid-market installed job totals for common residential tasks.
 * Used to keep AI quotes inside realistic customer-charge ranges.
 */
import type { RegionalPricing } from './ai-quote-region';

const roundMoney = (n: number) => Math.round(n * 100) / 100;

export type TaskMarketBand = {
  id: string;
  label: string;
  /** National mid-market installed total (materials + labor, no OH/profit pad). */
  minTotal: number;
  midTotal: number;
  maxTotal: number;
  /** Typical total crew-hours for the described scope. */
  typicalHours: number;
  minHours: number;
  maxHours: number;
};

type TaskRule = {
  id: string;
  label: string;
  pattern: RegExp;
  /** Skip when this matches (larger remodel / multi-room). */
  exclude?: RegExp;
  minTotal: number;
  midTotal: number;
  maxTotal: number;
  typicalHours: number;
  minHours: number;
  maxHours: number;
};

/**
 * Ordered first-match rules. More specific patterns first.
 * Totals are mid-grade installed contractor prices (US 2025–2026 national).
 */
const TASK_RULES: TaskRule[] = [
  // —— Hardware / small fixtures (also covered by small-job-pricing; bands reinforce) ——
  {
    id: 'door_handle',
    label: 'door / screen door handle',
    pattern: /screen\s*door|storm\s*door|door\s*(?:handle|knob|latch|lever|lockset|deadbolt)|handle\s*(?:on|for)\s*(?:the\s*)?(?:screen|storm|entry)?\s*door/i,
    exclude: /full\s+door|prehung|new\s+entry|entire\s+door\s+unit/i,
    minTotal: 140,
    midTotal: 265,
    maxTotal: 450,
    typicalHours: 1.5,
    minHours: 0.75,
    maxHours: 3,
  },
  {
    id: 'outlet_switch',
    label: 'outlet / switch replace',
    pattern: /(?:outlet|receptacle|switch|dimmer|gfci|gfi)\s*(?:replac|repair|install|swap)|replac(?:e|ing)\s+(?:an?\s+)?(?:outlet|receptacle|switch|dimmer)/i,
    exclude: /panel|rewire|whole[\s-]?house|circuit\s*run|sub[\s-]?panel/i,
    minTotal: 145,
    midTotal: 275,
    maxTotal: 520,
    typicalHours: 1.5,
    minHours: 0.75,
    maxHours: 3.5,
  },
  {
    id: 'faucet_repair',
    label: 'faucet repair / cartridge',
    pattern: /faucet\s*(?:cartridge|aerator|handle|repair|fix)|leak(?:ing)?\s*(?:faucet|tap)|replac(?:e|ing)\s+(?:a\s+)?(?:faucet\s*)?(?:cartridge|aerator)/i,
    exclude: /new\s+kitchen|whole\s+bath|remodel/i,
    minTotal: 150,
    midTotal: 295,
    maxTotal: 550,
    typicalHours: 1.75,
    minHours: 0.75,
    maxHours: 3.5,
  },
  {
    id: 'toilet_replace',
    label: 'toilet replacement',
    pattern: /(?:replac(?:e|ing)|install(?:ing)?)\s+(?:a\s+)?(?:new\s+)?toilet|toilet\s+(?:replac|install|swap|change)/i,
    exclude: /rough[\s-]?in|move\s+toilet|relocate|bathroom\s+remodel/i,
    minTotal: 320,
    midTotal: 520,
    maxTotal: 850,
    typicalHours: 2.5,
    minHours: 1.5,
    maxHours: 5,
  },
  {
    id: 'faucet_install',
    label: 'faucet install',
    pattern: /(?:replac(?:e|ing)|install(?:ing)?)\s+(?:a\s+)?(?:new\s+)?(?:kitchen\s+|bathroom\s+|bath\s+|lavatory\s+)?faucet|faucet\s+(?:replac|install)/i,
    exclude: /remodel|new\s+kitchen|new\s+bath/i,
    minTotal: 220,
    midTotal: 380,
    maxTotal: 650,
    typicalHours: 2,
    minHours: 1,
    maxHours: 4,
  },
  {
    id: 'garbage_disposal',
    label: 'garbage disposal',
    pattern: /garbage\s*disposal|food\s*waste\s*disposer|disposal\s+(?:replac|install)/i,
    minTotal: 280,
    midTotal: 450,
    maxTotal: 720,
    typicalHours: 2,
    minHours: 1.25,
    maxHours: 4,
  },
  {
    id: 'water_heater',
    label: 'water heater replace',
    pattern: /water\s*heater|hot\s*water\s*tank|hwt\b/i,
    exclude: /tankless\s+whole|boiler|hydronic/i,
    minTotal: 1200,
    midTotal: 1850,
    maxTotal: 3200,
    typicalHours: 5,
    minHours: 3,
    maxHours: 10,
  },
  {
    id: 'ceiling_fan',
    label: 'ceiling fan install',
    pattern: /ceiling\s*fan/i,
    exclude: /whole[\s-]?house|all\s+fans|every\s+room/i,
    minTotal: 220,
    midTotal: 380,
    maxTotal: 650,
    typicalHours: 2.25,
    minHours: 1.25,
    maxHours: 4.5,
  },
  {
    id: 'light_fixture',
    label: 'light fixture swap',
    pattern: /(?:light|lighting)\s*fixture|chandelier|pendant\s*light|vanity\s*light|flush\s*mount/i,
    exclude: /rewire|new\s+circuit|whole[\s-]?house|recessed\s+can\s+pack|10\+|dozen/i,
    minTotal: 160,
    midTotal: 295,
    maxTotal: 550,
    typicalHours: 1.75,
    minHours: 0.75,
    maxHours: 4,
  },
  {
    id: 'smoke_co',
    label: 'smoke / CO detector',
    pattern: /smoke\s*(?:detector|alarm)|carbon\s*monoxide|co\s*detector/i,
    minTotal: 95,
    midTotal: 165,
    maxTotal: 280,
    typicalHours: 0.75,
    minHours: 0.4,
    maxHours: 2,
  },
  {
    id: 'interior_door',
    label: 'interior door install',
    pattern: /interior\s*door|prehung\s*door|hollow[\s-]?core\s*door|bedroom\s*door|closet\s*door/i,
    exclude: /entry\s*door|exterior\s*door|french\s*door\s*set|double\s*door/i,
    minTotal: 280,
    midTotal: 450,
    maxTotal: 750,
    typicalHours: 2.5,
    minHours: 1.5,
    maxHours: 5,
  },
  {
    id: 'entry_door',
    label: 'entry / exterior door',
    pattern: /entry\s*door|exterior\s*door|front\s*door\s*(?:replac|install)|prehung\s*exterior/i,
    minTotal: 900,
    midTotal: 1600,
    maxTotal: 3200,
    typicalHours: 6,
    minHours: 3.5,
    maxHours: 12,
  },
  {
    id: 'window_replace',
    label: 'window replacement (each)',
    pattern: /(?:replac(?:e|ing)|install(?:ing)?)\s+(?:a\s+)?(?:new\s+)?window|window\s+(?:replac|install)/i,
    exclude: /whole[\s-]?house|all\s+windows|every\s+window|\b1[0-9]\s*windows|\b[2-9]\d\s*windows/i,
    minTotal: 550,
    midTotal: 950,
    maxTotal: 1800,
    typicalHours: 3.5,
    minHours: 2,
    maxHours: 7,
  },
  {
    id: 'drywall_patch',
    label: 'drywall patch / repair',
    pattern: /drywall\s*(?:patch|repair|hole|fix)|patch(?:ing)?\s+(?:a\s+)?(?:drywall|wall|hole)|hole\s+in\s+(?:the\s+)?(?:wall|drywall)/i,
    exclude: /whole\s+room|entire\s+(?:home|house)|hang\s+drywall|\d{3,}\s*(?:sq|sf)|ceiling\s+drywall/i,
    minTotal: 175,
    midTotal: 320,
    maxTotal: 650,
    typicalHours: 2.5,
    minHours: 1,
    maxHours: 6,
  },
  {
    id: 'drywall_ceiling_area',
    label: 'ceiling drywall replace (area)',
    pattern: /ceiling[\s\S]{0,40}drywall|drywall[\s\S]{0,40}ceiling|sheetrock[\s\S]{0,30}ceiling/i,
    exclude: /patch|small\s+hole|hand[\s-]?size/i,
    // 150–300 SF typical room ceiling, demo+hang+tape+paint
    minTotal: 900,
    midTotal: 1800,
    maxTotal: 3500,
    typicalHours: 16,
    minHours: 10,
    maxHours: 28,
  },
  {
    id: 'drywall_area',
    label: 'drywall hang / finish (area)',
    pattern: /(?:hang|install|replace)[\s\S]{0,20}drywall|drywall[\s\S]{0,20}(?:hang|install|finish|tape)|\d{2,4}\s*(?:sq\.?\s*ft|sqft|sf)[\s\S]{0,30}drywall|drywall[\s\S]{0,30}\d{2,4}\s*(?:sq\.?\s*ft|sqft|sf)/i,
    exclude: /patch|small\s+hole|hand[\s-]?size/i,
    minTotal: 700,
    midTotal: 1500,
    maxTotal: 4000,
    typicalHours: 14,
    minHours: 8,
    maxHours: 30,
  },
  {
    id: 'disposal_appliance',
    label: 'dishwasher install',
    pattern: /dishwasher/i,
    minTotal: 280,
    midTotal: 450,
    maxTotal: 750,
    typicalHours: 2.5,
    minHours: 1.5,
    maxHours: 5,
  },
  {
    id: 'range_hood',
    label: 'range hood',
    pattern: /range\s*hood|vent\s*hood|microwave\s*hood/i,
    minTotal: 250,
    midTotal: 420,
    maxTotal: 800,
    typicalHours: 2.5,
    minHours: 1.5,
    maxHours: 5,
  },
  {
    id: 'gutter_clean',
    label: 'gutter cleaning',
    pattern: /clean(?:ing)?\s+(?:the\s+)?gutters?|gutter\s*clean|debris\s+from\s+gutter/i,
    minTotal: 150,
    midTotal: 275,
    maxTotal: 500,
    typicalHours: 2.5,
    minHours: 1.5,
    maxHours: 5,
  },
  {
    id: 'pressure_wash',
    label: 'pressure washing',
    pattern: /pressure\s*wash|power\s*wash|soft\s*wash/i,
    minTotal: 200,
    midTotal: 400,
    maxTotal: 900,
    typicalHours: 3,
    minHours: 1.5,
    maxHours: 8,
  },
  {
    id: 'deck_stain',
    label: 'deck stain / seal',
    pattern: /deck\s*(?:stain|seal|sealing|refinish)|stain(?:ing)?\s+(?:the\s+)?deck/i,
    minTotal: 450,
    midTotal: 900,
    maxTotal: 2200,
    typicalHours: 8,
    minHours: 4,
    maxHours: 20,
  },
  {
    id: 'fence_repair',
    label: 'fence repair section',
    pattern: /fence\s*(?:repair|fix|post|panel|picket)|repair(?:ing)?\s+(?:a\s+)?fence/i,
    exclude: /new\s+fence|install\s+(?:a\s+)?(?:new\s+)?fence|\d{2,}\s*(?:lf|ft|feet)/i,
    minTotal: 200,
    midTotal: 450,
    maxTotal: 1200,
    typicalHours: 3,
    minHours: 1.5,
    maxHours: 10,
  },
  {
    id: 'vanity_install',
    label: 'bathroom vanity',
    pattern: /vanity/i,
    exclude: /light\s*only|vanity\s*light/i,
    minTotal: 450,
    midTotal: 850,
    maxTotal: 1800,
    typicalHours: 4,
    minHours: 2.5,
    maxHours: 8,
  },
  {
    id: 'shower_valve',
    label: 'shower valve / cartridge',
    pattern: /shower\s*(?:valve|cartridge|stem|handle)|tub\s*(?:valve|cartridge)/i,
    exclude: /full\s+remodel|tile\s+shower\s+rebuild/i,
    minTotal: 280,
    midTotal: 520,
    maxTotal: 1100,
    typicalHours: 3,
    minHours: 1.5,
    maxHours: 6,
  },
  {
    id: 'sump_pump',
    label: 'sump pump',
    pattern: /sump\s*pump/i,
    minTotal: 350,
    midTotal: 650,
    maxTotal: 1200,
    typicalHours: 2.5,
    minHours: 1.5,
    maxHours: 5,
  },
  {
    id: 'garage_door_opener',
    label: 'garage door opener',
    pattern: /garage\s*door\s*opener|gdo\b/i,
    minTotal: 350,
    midTotal: 550,
    maxTotal: 950,
    typicalHours: 2.5,
    minHours: 1.5,
    maxHours: 5,
  },
  {
    id: 'locksmith_rekey',
    label: 'rekey / lock change',
    pattern: /re[\s-]?key|change\s*(?:the\s+)?locks?|lock\s*change/i,
    minTotal: 120,
    midTotal: 220,
    maxTotal: 450,
    typicalHours: 1.25,
    minHours: 0.5,
    maxHours: 3,
  },
  {
    id: 'appliance_install_general',
    label: 'appliance install',
    pattern: /(?:install|replac)(?:e|ing)?\s+(?:a\s+)?(?:new\s+)?(?:fridge|refrigerator|washer|dryer|range|stove|oven|microwave)(?!\s*hood)/i,
    minTotal: 150,
    midTotal: 280,
    maxTotal: 550,
    typicalHours: 1.75,
    minHours: 1,
    maxHours: 4,
  },
];

export function detectTaskMarketBand(description: string): TaskMarketBand | null {
  const text = description.trim();
  if (!text || text.length < 6) return null;

  for (const rule of TASK_RULES) {
    if (!rule.pattern.test(text)) continue;
    if (rule.exclude?.test(text)) continue;
    return {
      id: rule.id,
      label: rule.label,
      minTotal: rule.minTotal,
      midTotal: rule.midTotal,
      maxTotal: rule.maxTotal,
      typicalHours: rule.typicalHours,
      minHours: rule.minHours,
      maxHours: rule.maxHours,
    };
  }
  return null;
}

/** Regionalize national band using labor/material multipliers (labor-weighted). */
export function regionalizeTaskBand(
  band: TaskMarketBand,
  regional: RegionalPricing
): TaskMarketBand {
  // Installed jobs are ~60–70% labor-sensitive for fixtures, ~50/50 for materials-heavy.
  const blend =
    regional.materialMultiplier * 0.38 + regional.laborMultiplier * 0.62;
  const scale = (n: number) => roundMoney(n * blend);
  return {
    ...band,
    minTotal: scale(band.minTotal),
    midTotal: scale(band.midTotal),
    maxTotal: scale(band.maxTotal),
  };
}

/**
 * Pull a quoted total into the realistic market band for this task.
 * Returns null when description has no known band.
 */
export function clampTotalToTaskMarket(
  description: string,
  regional: RegionalPricing,
  total: number
): { total: number; band: TaskMarketBand; adjusted: boolean } | null {
  const raw = detectTaskMarketBand(description);
  if (!raw) return null;
  const band = regionalizeTaskBand(raw, regional);
  const t = roundMoney(total);
  if (t >= band.minTotal && t <= band.maxTotal) {
    return { total: t, band, adjusted: false };
  }
  // Soft pull: if slightly outside, clamp; if far outside, snap toward mid
  if (t < band.minTotal) {
    const pulled =
      t < band.minTotal * 0.55
        ? roundMoney(band.minTotal * 0.92 + band.midTotal * 0.08)
        : band.minTotal;
    return { total: pulled, band, adjusted: true };
  }
  // too high
  const pulled =
    t > band.maxTotal * 1.45
      ? roundMoney(band.maxTotal * 0.88 + band.midTotal * 0.12)
      : band.maxTotal;
  return { total: pulled, band, adjusted: true };
}

/**
 * Blend AI total with market mid when we know the task type.
 * Weight favors market mid for known tasks (AI often over/under shoots).
 */
export function blendWithTaskMarket(
  description: string,
  regional: RegionalPricing,
  aiOrBuiltTotal: number
): { total: number; band: TaskMarketBand | null; method: string } {
  const clamped = clampTotalToTaskMarket(description, regional, aiOrBuiltTotal);
  if (!clamped) {
    return { total: roundMoney(aiOrBuiltTotal), band: null, method: 'raw' };
  }
  const { band } = clamped;
  // 55% market mid + 45% (clamped input) keeps local AI signal without wild misses
  const blended = roundMoney(band.midTotal * 0.55 + clamped.total * 0.45);
  const final = roundMoney(
    Math.min(band.maxTotal, Math.max(band.minTotal, blended))
  );
  return {
    total: final,
    band,
    method: clamped.adjusted ? 'market_clamp_blend' : 'market_blend',
  };
}

/** Realistic unit-job labor hours when no sqft/lf is in the description. */
export function estimateUnitJobLaborHours(description: string): {
  minHours: number;
  expectedHours: number;
  maxHours: number;
  label: string;
} | null {
  const band = detectTaskMarketBand(description);
  if (band) {
    return {
      minHours: band.minHours,
      expectedHours: band.typicalHours,
      maxHours: band.maxHours,
      label: band.label,
    };
  }

  const text = description.toLowerCase();

  // Generic complexity tiers for unit jobs without a specific band
  if (
    /repair|fix|patch|adjust|tighten|re[\s-]?hang|lubricat|clean|service|tune[\s-]?up/i.test(
      text
    ) &&
    !/remodel|renovat|addition|whole|entire/i.test(text)
  ) {
    return { minHours: 0.75, expectedHours: 2, maxHours: 5, label: 'general repair' };
  }
  if (/install|replac|swap|change\s+out/i.test(text) && !/remodel|whole|entire/i.test(text)) {
    return { minHours: 1, expectedHours: 2.5, maxHours: 6, label: 'general install' };
  }
  if (/remodel|renovat|addition|build|frame|demo/i.test(text)) {
    return { minHours: 8, expectedHours: 24, maxHours: 80, label: 'remodel scope' };
  }

  return { minHours: 1, expectedHours: 3, maxHours: 8, label: 'general task' };
}
