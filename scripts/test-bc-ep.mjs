import { buildCalculatorQuoteAnchor } from '../lib/buildcalculator.ts';
import {
  fetchEstimationProMultiplier,
  fetchEstimationProTradeCosts,
  pickPaintLaborBand,
  applyEpMultiplierToBuildCalcBase,
  detectEstimationProTrade,
} from '../lib/estimationpro.ts';

const desc =
  'Exterior/interior painting of 1,200 sq ft home; dual-coat application for full, even coverage and lasting finish protection.';

const bc = await buildCalculatorQuoteAnchor(desc, { regionalUsdBlend: 1 });
const ep = await fetchEstimationProMultiplier({ zipCode: '28210' });
const costs = await fetchEstimationProTradeCosts({
  trade: detectEstimationProTrade(desc),
  zipCode: '28210',
});
const band = pickPaintLaborBand(costs, desc);
const range = applyEpMultiplierToBuildCalcBase({
  baseUnitCostUsd: bc?.baseUnitCostUsd || 0,
  quantity: bc?.billingQuantity || 1200,
  epMultiplier: ep?.multiplier || 1,
  epLaborPerSf: band,
});

console.log(
  JSON.stringify(
    {
      base: bc?.baseUnitCostUsd,
      qty: bc?.billingQuantity,
      epMult: ep?.multiplier,
      epLabel: ep?.label,
      band,
      range,
    },
    null,
    2
  )
);
