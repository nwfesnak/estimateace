/**
 * Golden checks for template-first quotes.
 * Run: npx tsx scripts/test-quote-templates.ts
 */
import { extractScopeDeterministic } from '../lib/quote-extractor';
import { priceTemplate } from '../lib/quote-templates';
import { parsePrimaryFloorSqft } from '../lib/quote-units';
import type { RegionalPricing } from '../lib/ai-quote-region';

const regional: RegionalPricing = {
  label: 'US average',
  state: '',
  city: '',
  zipCode: '',
  materialMultiplier: 1,
  laborMultiplier: 1,
  costTier: 'average',
  source: 'default',
};

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const desc =
  'Prime one 8-by-30-foot interior wall (240 sq ft). Repair and blend wall texture throughout the 1,567 sq ft, 3-bedroom, 2-bath home. Apply two full coats of matching paint to all interior walls.';

const floor = parsePrimaryFloorSqft(desc);
assert(floor === 1567, `primary floor SF expected 1567 got ${floor}`);

const scope = extractScopeDeterministic(desc);
assert(
  scope.templateId === 'paint_interior_whole_home',
  `template expected paint_interior_whole_home got ${scope.templateId}`
);
assert(scope.facts.floorSqft === 1567, `facts.floorSqft ${scope.facts.floorSqft}`);

const quote = priceTemplate(
  'paint_interior_whole_home',
  { floorSqft: 1567, coats: 2, ceilingFt: 8 },
  regional,
  desc
);

assert(quote.suggestedQty === 1567, `qty ${quote.suggestedQty}`);
assert(quote.unit === 'SF', `unit ${quote.unit}`);
assert(quote.unitPrice > 1.5 && quote.unitPrice < 6, `unitPrice ${quote.unitPrice}`);
assert(quote.laborBreakdown.hours < 100, `hours too high: ${quote.laborBreakdown.hours}`);
assert(quote.laborBreakdown.hours > 20, `hours too low: ${quote.laborBreakdown.hours}`);
const built = Math.round((quote.materialsCostTotal + quote.laborCostTotal) * 100) / 100;
assert(Math.abs(built - quote.total) < 0.03, `identity fail built=${built} total=${quote.total}`);
const paintGal = quote.materials.find((m) => /paint/i.test(m.description) && /gal/i.test(m.unit));
assert(!!paintGal && paintGal.qty >= 8, `paint gallons too low: ${paintGal?.qty}`);

const desc2 =
  'Repair and blend wall texture. Paint the 1,567 sq. ft., 3-bedroom, 2-bath interior. Two full coats of matching paint on all interior walls.';
const scope2 = extractScopeDeterministic(desc2);
assert(scope2.templateId === 'paint_interior_whole_home', scope2.templateId);
const q2 = priceTemplate(
  'paint_interior_whole_home',
  { floorSqft: 1567, coats: 2 },
  regional,
  desc2
);
assert(q2.laborBreakdown.hours < 100, `desc2 hours ${q2.laborBreakdown.hours}`);

// Multi-trade smoke checks
const fence = extractScopeDeterministic('Install 120 lf of privacy fence along the backyard');
assert(fence.templateId === 'fencing', `fence template ${fence.templateId}`);
assert(fence.facts.linearFeet === 120, `fence lf ${fence.facts.linearFeet}`);
const fenceQ = priceTemplate('fencing', { linearFeet: 120 }, regional, 'Install 120 lf privacy fence');
assert(fenceQ.unit === 'LF', fenceQ.unit);
assert(Math.abs(fenceQ.materialsCostTotal + fenceQ.laborCostTotal - fenceQ.total) < 0.03, 'fence identity');

const toilet = extractScopeDeterministic('Replace toilet in master bath');
assert(toilet.templateId === 'plumbing_fixture' || toilet.templateId === 'unit_task', toilet.templateId);
const toiletQ = priceTemplate('plumbing_fixture', {}, regional, 'Replace toilet in master bath');
assert(toiletQ.total > 200 && toiletQ.total < 2000, `toilet total ${toiletQ.total}`);
assert(toiletQ.laborBreakdown.hours < 20, `toilet hours ${toiletQ.laborBreakdown.hours}`);

const sod = extractScopeDeterministic('Install sod on 2000 sq ft front lawn');
assert(sod.templateId === 'landscaping_sod', sod.templateId);
const sodQ = priceTemplate('landscaping_sod', { areaSqft: 2000 }, regional, 'Install sod 2000 sq ft');
assert(sodQ.suggestedQty === 2000, String(sodQ.suggestedQty));

console.log('OK', {
  qty: quote.suggestedQty,
  unitPrice: quote.unitPrice,
  total: quote.total,
  hours: quote.laborBreakdown.hours,
  rate: quote.laborBreakdown.rate,
  paintGal: paintGal?.qty,
  mat: quote.materialsCostTotal,
  lab: quote.laborCostTotal,
  fenceTotal: fenceQ.total,
  toiletTotal: toiletQ.total,
  sodTotal: sodQ.total,
});
