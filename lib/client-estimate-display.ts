/**
 * Client Estimate Display and Show Discount on Estimate are independent
 * toggles. Each one is stored on the company profile JSON (and snapshotted
 * onto each job) and is applied on its own in the customer approve page,
 * the Print/PDF preview, and the estimate email.
 *
 * Why they were linked before:
 * - On Company Profile they lived in a single card: "Client Estimate Display"
 *   was only a heading, and the only switch was "Show Discount on Estimate".
 * - Customer view and email ignored showDiscountOnEstimate and always showed
 *   a discount line when the amount was > $0.00. PDF honored the discount
 *   flag but still leaked "Subtotal before discount" when the line was hidden.
 * - Material/labor/cost breakdowns (the "Client Estimate Display" intent)
 *   appeared on Print/PDF only. Email and the customer page never showed them,
 *   and email even ignored the breakdownSettings payload.
 */

import type { EmailBreakdownSettings } from '@/lib/email-document-breakdown';
import {
  formatItemBreakdownHtml,
  formatItemBreakdownText,
} from '@/lib/email-document-breakdown';

export const DEFAULT_SHOW_CLIENT_ESTIMATE_DISPLAY = true;

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

function pickBoolean(profile: Obj, key: string): boolean | undefined {
  const val = profile[key];
  return typeof val === 'boolean' ? val : undefined;
}

/**
 * Master switch for showing material/labor/cost breakdowns on client surfaces.
 * Missing field defaults to true so existing jobs keep today's PDF behavior
 * (breakdowns follow the per-job editor flags).
 */
export function resolveShowClientEstimateDisplay(
  docProfileRaw?: unknown,
  globalProfileRaw?: unknown
): boolean {
  const doc = pickBoolean(asObj(docProfileRaw), 'showClientEstimateDisplay');
  if (doc !== undefined) return doc;
  const glob = pickBoolean(asObj(globalProfileRaw), 'showClientEstimateDisplay');
  if (glob !== undefined) return glob;
  return DEFAULT_SHOW_CLIENT_ESTIMATE_DISPLAY;
}

/**
 * Show the discount line on client surfaces. Explicit booleans win (job, then
 * company profile). If neither has the field, default true so customer view
 * and email keep showing a discount that already exists — those surfaces used
 * to ignore the toggle and always showed the line when the amount was > 0.
 */
export function resolveShowDiscountOnEstimate(
  docProfileRaw?: unknown,
  globalProfileRaw?: unknown
): boolean {
  const doc = pickBoolean(asObj(docProfileRaw), 'showDiscountOnEstimate');
  if (doc !== undefined) return doc;
  const glob = pickBoolean(asObj(globalProfileRaw), 'showDiscountOnEstimate');
  if (glob !== undefined) return glob;
  return true;
}

export function getClientFacingBreakdownSettings(
  showClientEstimateDisplay: boolean,
  breakdown?: EmailBreakdownSettings | null
): EmailBreakdownSettings {
  if (!showClientEstimateDisplay) {
    return {
      showMaterialBreakdownOnEstimate: false,
      showLaborBreakdownOnEstimate: false,
      showCostBreakdownOnEstimate: false,
    };
  }
  return {
    showMaterialBreakdownOnEstimate: !!breakdown?.showMaterialBreakdownOnEstimate,
    showLaborBreakdownOnEstimate: !!breakdown?.showLaborBreakdownOnEstimate,
    showCostBreakdownOnEstimate: !!breakdown?.showCostBreakdownOnEstimate,
  };
}

export type ClientEstimatePresentation = {
  showDiscountLine: boolean;
  /** Only when the discount line itself is shown — never leak a hidden discount. */
  showSubtotalBeforeDiscount: boolean;
  showItemBreakdowns: boolean;
  breakdownSettings: EmailBreakdownSettings;
};

export function presentClientEstimate(input: {
  showClientEstimateDisplay: boolean;
  showDiscountOnEstimate: boolean;
  discountAmount?: number;
  breakdownSettings?: EmailBreakdownSettings | null;
}): ClientEstimatePresentation {
  const hasDiscount = (Number(input.discountAmount) || 0) > 0.005;
  const showDiscountLine = hasDiscount && input.showDiscountOnEstimate === true;
  const breakdownSettings = getClientFacingBreakdownSettings(
    input.showClientEstimateDisplay === true,
    input.breakdownSettings
  );
  const showItemBreakdowns =
    input.showClientEstimateDisplay === true &&
    !!(
      breakdownSettings.showMaterialBreakdownOnEstimate ||
      breakdownSettings.showLaborBreakdownOnEstimate ||
      breakdownSettings.showCostBreakdownOnEstimate
    );
  return {
    showDiscountLine,
    showSubtotalBeforeDiscount: showDiscountLine,
    showItemBreakdowns,
    breakdownSettings,
  };
}

export function moneyUsd(n: number): string {
  return `$${Number(n || 0).toFixed(2)}`;
}

export function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Discount + subtotal rows for the email Summary table (empty when hidden). */
export function renderEmailDiscountRowsHtml(input: {
  showDiscountLine: boolean;
  subtotalBeforeDiscount: number;
  discountAmount: number;
  discountDescription?: string;
}): string {
  if (!input.showDiscountLine) return '';
  const label = escapeHtml((input.discountDescription || 'Discount').trim() || 'Discount');
  return `<tr><td style="padding:4px 0;font-size:13px;color:#64748b;">Subtotal</td><td style="padding:4px 0;font-size:13px;text-align:right;">${moneyUsd(input.subtotalBeforeDiscount)}</td></tr>
                <tr><td style="padding:4px 0;font-size:13px;color:#b91c1c;">${label}</td><td style="padding:4px 0;font-size:13px;text-align:right;color:#b91c1c;">−${moneyUsd(input.discountAmount)}</td></tr>`;
}

/** Plain-text discount lines for the estimate email. */
export function renderEmailDiscountText(input: {
  showDiscountLine: boolean;
  subtotalBeforeDiscount: number;
  discountAmount: number;
  discountDescription?: string;
}): string {
  if (!input.showDiscountLine) return '';
  const label = (input.discountDescription || 'Discount').trim() || 'Discount';
  return `Subtotal: ${moneyUsd(input.subtotalBeforeDiscount)}\n${label}: −${moneyUsd(input.discountAmount)}`;
}

/**
 * Append a compact materials/labor/cost breakdown under an email line.
 * Empty string when Client Estimate Display is off or no flags/data apply.
 */
export function itemBreakdownForEmailHtml(
  item: unknown,
  presentation: ClientEstimatePresentation
): string {
  if (!presentation.showItemBreakdowns) return '';
  return formatItemBreakdownHtml(item, presentation.breakdownSettings);
}

export function itemBreakdownForEmailText(
  item: unknown,
  presentation: ClientEstimatePresentation
): string {
  if (!presentation.showItemBreakdowns) return '';
  return formatItemBreakdownText(item, presentation.breakdownSettings);
}

export function itemBreakdownForCustomerHtml(
  item: unknown,
  presentation: ClientEstimatePresentation
): string {
  if (!presentation.showItemBreakdowns) return '';
  return formatItemBreakdownHtml(item, presentation.breakdownSettings);
}

/** Labels used in proof HTML + tests so all 3 surfaces share the same markers. */
export const PROOF_MARKERS = {
  discountLine: 'data-proof="discount-line"',
  subtotalBeforeDiscount: 'data-proof="subtotal-before-discount"',
  itemBreakdown: 'data-proof="item-breakdown"',
  lineItems: 'data-proof="line-items"',
  grandTotal: 'data-proof="grand-total"',
} as const;

export type ProofSurface = 'customer' | 'pdf' | 'email';

export type ProofEstimateFixture = {
  company: string;
  invoiceNumber: string;
  jobName: string;
  date: string;
  items: Array<{
    id?: string | number;
    description: string;
    qty: number;
    unit?: string;
    price: number;
    total: number;
    materialBreakdown?: unknown;
    materialsList?: unknown[];
    laborBreakdown?: unknown;
    costBreakdown?: unknown;
    [key: string]: unknown;
  }>;
  subtotalBeforeDiscount: number;
  discountAmount: number;
  discountDescription: string;
  discountType?: 'percent' | 'dollar';
  discountValue?: number;
  taxAmount: number;
  grandTotal: number;
  breakdownSettings: EmailBreakdownSettings;
};

/**
 * Deterministic HTML for a client surface (customer page, PDF, or email)
 * using the same presentation rules. Used by unit tests and screenshot proof.
 */
export function renderClientEstimateSurfaceHtml(
  surface: ProofSurface,
  fixture: ProofEstimateFixture,
  flags: { showClientEstimateDisplay: boolean; showDiscountOnEstimate: boolean }
): string {
  const presentation = presentClientEstimate({
    showClientEstimateDisplay: flags.showClientEstimateDisplay,
    showDiscountOnEstimate: flags.showDiscountOnEstimate,
    discountAmount: fixture.discountAmount,
    breakdownSettings: fixture.breakdownSettings,
  });

  const lines = fixture.items
    .map((it, i) => {
      const breakdown =
        surface === 'email'
          ? itemBreakdownForEmailHtml(it, presentation)
          : itemBreakdownForCustomerHtml(it, presentation);
      const breakdownBlock = breakdown
        ? `<div ${PROOF_MARKERS.itemBreakdown} class="item-breakdown">${breakdown}</div>`
        : '';
      const qtyPrice =
        surface === 'pdf'
          ? `<td class="num">${it.qty}</td><td class="num">${escapeHtml(String(it.unit || '—'))}</td><td class="num">${moneyUsd(it.price)}</td>`
          : '';
      return `<tr>
        <td>Line ${i + 1}: ${escapeHtml(it.description)}${breakdownBlock}</td>
        ${qtyPrice}
        <td class="num">${moneyUsd(it.total)}</td>
      </tr>`;
    })
    .join('');

  const discountRows = presentation.showDiscountLine
    ? `<div ${PROOF_MARKERS.subtotalBeforeDiscount} class="row">Subtotal before discount: ${moneyUsd(fixture.subtotalBeforeDiscount)}</div>
         <div ${PROOF_MARKERS.discountLine} class="row discount">${escapeHtml(fixture.discountDescription)}: −${moneyUsd(fixture.discountAmount)}</div>`
    : '';

  const title =
    surface === 'customer'
      ? 'Customer view'
      : surface === 'pdf'
        ? 'Print / PDF'
        : 'Estimate email';

  const tableHead =
    surface === 'pdf'
      ? `<tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Unit price</th><th class="num">Total</th></tr>`
      : `<tr><th>Description</th><th class="num">Total</th></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} — ${escapeHtml(fixture.invoiceNumber)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
    .sheet { max-width: 720px; margin: 24px auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px 36px; }
    .kicker { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #64748b; margin: 0 0 4px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .meta { color: #64748b; font-size: 13px; margin: 0 0 20px; }
    table { width: 100%; border-collapse: collapse; margin: 0 0 16px; }
    th { text-align: left; font-size: 12px; color: #64748b; border-bottom: 2px solid #0f172a; padding: 8px 6px; }
    td { border-bottom: 1px solid #e2e8f0; padding: 10px 6px; font-size: 14px; vertical-align: top; }
    .num { text-align: right; white-space: nowrap; }
    .item-breakdown { margin-top: 6px; font-size: 12px; color: #475569; }
    .totals { text-align: right; }
    .row { font-size: 15px; margin: 4px 0; }
    .discount { color: #b91c1c; font-weight: 600; }
    .grand { font-size: 22px; font-weight: 800; margin-top: 8px; color: #047857; }
    .flags { font-size: 11px; color: #64748b; margin: 16px 0 0; }
  </style>
</head>
<body>
  <div class="sheet">
    <p class="kicker">${escapeHtml(title)}</p>
    <h1>${escapeHtml(fixture.company)}</h1>
    <p class="meta">${escapeHtml(fixture.invoiceNumber)} · ${escapeHtml(fixture.jobName)} · ${escapeHtml(fixture.date)}</p>
    <table ${PROOF_MARKERS.lineItems}>
      <thead>${tableHead}</thead>
      <tbody>${lines}</tbody>
    </table>
    <div class="totals">
      ${discountRows}
      ${
        fixture.taxAmount > 0.009
          ? `<div class="row">Tax: ${moneyUsd(fixture.taxAmount)}</div>`
          : ''
      }
      <div ${PROOF_MARKERS.grandTotal} class="grand">Grand total: ${moneyUsd(fixture.grandTotal)}</div>
    </div>
    <p class="flags">Client Estimate Display: ${flags.showClientEstimateDisplay ? 'ON' : 'OFF'} · Show Discount on Estimate: ${flags.showDiscountOnEstimate ? 'ON' : 'OFF'}</p>
  </div>
</body>
</html>`;
}

/** Settings-page proof: two independent toggle cards (after) vs one combined card (before). */
export function renderSettingsTogglesHtml(mode: 'before' | 'after', flags: {
  showClientEstimateDisplay: boolean;
  showDiscountOnEstimate: boolean;
}): string {
  const knob = (on: boolean) =>
    `<span class="knob ${on ? 'on' : 'off'}"><span class="dot"></span></span>`;

  const after = `
    <div class="card" data-proof="client-estimate-display-card">
      <div class="row-toggle">
        <div>
          <p class="title">Client Estimate Display</p>
          <p class="help">Show material, labor, and cost breakdowns on the customer estimate, PDF, and email. Use the breakdown buttons on the estimate editor (above Add Line Item) to choose which parts appear.</p>
        </div>
        ${knob(flags.showClientEstimateDisplay)}
      </div>
    </div>
    <div class="card" data-proof="show-discount-card">
      <div class="row-toggle">
        <div>
          <p class="title">Show Discount on Estimate</p>
          <p class="help">Show discount line to clients when a discount name and amount are entered</p>
        </div>
        ${knob(flags.showDiscountOnEstimate)}
      </div>
    </div>`;

  const before = `
    <div class="card" data-proof="linked-card">
      <div>
        <p class="title">Client Estimate Display</p>
        <p class="help">Material, labor, and cost breakdown buttons are on the estimate editor (above Add Line Item).</p>
      </div>
      <div class="row-toggle" style="margin-top:16px;">
        <div>
          <p class="title">Show Discount on Estimate</p>
          <p class="help">Show discount line to clients when a discount name and amount are entered</p>
        </div>
        ${knob(flags.showDiscountOnEstimate)}
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Company Profile — ${mode}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
    .page { max-width: 640px; margin: 24px auto; padding: 0 16px 32px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .sub { color: #64748b; font-size: 13px; margin: 0 0 20px; }
    .card { border: 1px solid #e2e8f0; border-radius: 16px; padding: 16px; background: #f8fafc; margin-bottom: 16px; }
    .title { font-weight: 700; margin: 0 0 4px; }
    .help { font-size: 13px; color: #64748b; margin: 0; line-height: 1.45; }
    .row-toggle { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .knob { width: 44px; height: 24px; border-radius: 999px; display: inline-flex; align-items: center; flex-shrink: 0; }
    .knob.on { background: #10b981; justify-content: flex-end; }
    .knob.off { background: #e5e7eb; justify-content: flex-start; }
    .dot { width: 20px; height: 20px; background: #fff; border-radius: 50%; margin: 2px; box-shadow: 0 1px 2px rgba(0,0,0,.15); }
  </style>
</head>
<body>
  <div class="page">
    <h1>Company Profile</h1>
    <p class="sub">${mode === 'before' ? 'Before: one card, Client Estimate Display is only a heading, and the discount switch is the only control.' : 'After: two separate, independent toggles. Each one saves and applies on its own.'}</p>
    ${mode === 'before' ? before : after}
  </div>
</body>
</html>`;
}

export const SAMPLE_PROOF_FIXTURE: ProofEstimateFixture = {
  company: 'EstimateAce Demo Co.',
  invoiceNumber: 'EST-1001',
  jobName: 'Smith residence — interior paint',
  date: 'Nov 27, 2026',
  items: [
    {
      id: 1,
      description: 'Interior paint — living room and hallway',
      qty: 1,
      unit: 'job',
      price: 2000,
      total: 2000,
      breakdownUserEdited: true,
      materialsList: [
        { description: 'Interior latex paint', qty: 2, unit: 'gal', unitPrice: 35, total: 70 },
        { description: "Painter's tape", qty: 1, unit: 'roll', unitPrice: 8, total: 8 },
      ],
      laborBreakdown: { description: 'Prep and two coats', hours: 8, rate: 240, total: 1920 },
    },
    {
      id: 2,
      description: 'Trim and baseboard paint',
      qty: 1,
      unit: 'job',
      price: 500,
      total: 500,
      breakdownUserEdited: true,
      materialsList: [{ description: 'Enamel trim paint', qty: 1, unit: 'gal', unitPrice: 42, total: 42 }],
      laborBreakdown: { description: 'Cut-in and brush work', hours: 3, rate: 152.67, total: 458 },
    },
  ],
  subtotalBeforeDiscount: 2500,
  discountAmount: 250,
  discountDescription: 'Military',
  discountType: 'percent',
  discountValue: 10,
  taxAmount: 0,
  grandTotal: 2250,
  breakdownSettings: {
    showMaterialBreakdownOnEstimate: true,
    showLaborBreakdownOnEstimate: true,
    showCostBreakdownOnEstimate: true,
  },
};
