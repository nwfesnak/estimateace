/**
 * Smoke-test BuildCalculator.io + EstimationPro.ai (used by AI quote).
 * Run: node scripts/test-bc-ep.mjs
 */
const BC = 'https://buildcalculator.io/api/v1';
const EP = 'https://estimationpro.ai/api/v1';

function scorePaint(name) {
  const blob = String(name || '').toLowerCase();
  let s = 0;
  if (/paint|wall|emulsion/.test(blob)) s += 40;
  if (/water-?emulsion|polyvinyl|wall/.test(blob)) s += 45;
  if (/metal|cornice|firewall/.test(blob)) s -= 60;
  if (/oil-based compounds of previously painted metal/.test(blob)) s -= 80;
  return s;
}

async function main() {
  const desc = 'Interior paint dual coat 1200 SF whole home';
  const paintQ = 'painting of walls interiors water emulsion';

  const bcUrl = new URL(`${BC}/search`);
  bcUrl.searchParams.set('q', paintQ);
  bcUrl.searchParams.set('lang', 'en');
  bcUrl.searchParams.set('top', '8');
  const t0 = Date.now();
  const bcRes = await fetch(bcUrl);
  const bcJson = await bcRes.json();
  const hits = (bcJson.results || [])
    .map((r) => ({
      name: r.original_name,
      total: r.pricing?.total_per_unit,
      unit: r.unit,
      score: scorePaint(r.original_name),
    }))
    .sort((a, b) => b.score - a.score);
  console.log('BuildCalculator', bcRes.status, `${Date.now() - t0}ms`, 'hits', hits.length);
  console.log('  best:', hits[0]?.name?.slice(0, 90), '€', hits[0]?.total, hits[0]?.unit, 'score', hits[0]?.score);
  if (!bcRes.ok || !hits.length || hits[0].score < 20) {
    throw new Error('BuildCalculator paint search failed quality check');
  }

  const t1 = Date.now();
  const epM = await fetch(`${EP}/multipliers?zip=90210`);
  const epMJ = await epM.json();
  const mult = epMJ.data?.multiplier ?? epMJ.multiplier;
  console.log('EstimationPro multipliers', epM.status, `${Date.now() - t1}ms`, '×', mult, epMJ.data?.label || '');
  if (!epM.ok || !(Number(mult) > 0)) throw new Error('EstimationPro multipliers failed');

  const t2 = Date.now();
  const epC = await fetch(`${EP}/costs?trade=paint&zip=90210`);
  const epCJ = await epC.json();
  const items = epCJ.data?.items || epCJ.items || [];
  const labor = items.find((i) => i.id === 'paint-interior-labor');
  console.log('EstimationPro costs', epC.status, `${Date.now() - t2}ms`, 'items', items.length);
  console.log('  interior labor $/SF', labor?.low, labor?.typical, labor?.high);
  if (!epC.ok || !items.length) throw new Error('EstimationPro costs failed');

  // Simulate BC base × EP mult for 1200 SF (approx convert best €/m2 → $/SF floor)
  const EUR_USD = 1.08;
  const M2_TO_SF = 10.7639;
  const surfacePerSf = (Number(hits[0].total) * EUR_USD) / M2_TO_SF;
  const floorPerSf = surfacePerSf * 3.0; // interior walls+ceilings factor
  const qty = 1200;
  const typical = floorPerSf * mult * qty;
  console.log('Sample BC×EP typical job total ~$', Math.round(typical), `($${floorPerSf.toFixed(2)}/SF floor × ${mult} × ${qty})`);
  console.log('OK: BuildCalculator.io + EstimationPro.ai reachable and usable for AI quotes');
}

main().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
