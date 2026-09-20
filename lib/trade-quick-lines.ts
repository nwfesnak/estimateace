/**
 * Trade → common quick-line templates (description + starter price).
 * Prices are rough US mid-market starters — always editable by the user.
 */

export type TradeQuickLineTemplate = {
  description: string;
  qty: number;
  unit: string;
  price: number;
};

export type TradeQuickLinesCatalog = {
  id: string;
  name: string;
  lines: TradeQuickLineTemplate[];
};

export const TRADE_QUICK_LINES: TradeQuickLinesCatalog[] = [
  {
    id: 'painting',
    name: 'Painting',
    lines: [
      { description: 'Interior walls — prep, prime, 2 coats', qty: 1, unit: 'SF', price: 2.75 },
      { description: 'Ceilings — prep and 2 coats flat', qty: 1, unit: 'SF', price: 2.25 },
      { description: 'Trim / doors / baseboards — paint', qty: 1, unit: 'LF', price: 3.5 },
      { description: 'Exterior siding — scrape, prime, 2 coats', qty: 1, unit: 'SF', price: 3.75 },
      { description: 'Cabinet painting (kitchen) — spray finish', qty: 1, unit: 'LS', price: 3500 },
      { description: 'Deck / fence stain or paint', qty: 1, unit: 'SF', price: 2.5 },
    ],
  },
  {
    id: 'pressure-washing',
    name: 'Pressure washing',
    lines: [
      { description: 'House wash — soft wash / pressure wash', qty: 1, unit: 'SF', price: 0.45 },
      { description: 'Driveway / concrete cleaning', qty: 1, unit: 'SF', price: 0.35 },
      { description: 'Deck / patio cleaning', qty: 1, unit: 'SF', price: 0.55 },
      { description: 'Roof soft wash', qty: 1, unit: 'SF', price: 0.65 },
      { description: 'Fence cleaning', qty: 1, unit: 'LF', price: 1.25 },
      { description: 'Fleet / equipment wash (flat rate)', qty: 1, unit: 'LS', price: 175 },
    ],
  },
  {
    id: 'landscaping',
    name: 'Landscaping',
    lines: [
      { description: 'Sod installation', qty: 1, unit: 'SF', price: 1.85 },
      { description: 'Mulch install', qty: 1, unit: 'CY', price: 85 },
      { description: 'Bush / shrub trimming', qty: 1, unit: 'EA', price: 45 },
      { description: 'Tree trimming (standard)', qty: 1, unit: 'EA', price: 350 },
      { description: 'Lawn mowing — weekly', qty: 1, unit: 'LS', price: 55 },
      { description: 'Irrigation repair (per zone)', qty: 1, unit: 'EA', price: 125 },
    ],
  },
  {
    id: 'handyman',
    name: 'Handyman / general',
    lines: [
      { description: 'General labor — hourly', qty: 1, unit: 'HR', price: 85 },
      { description: 'Drywall patch and texture blend', qty: 1, unit: 'EA', price: 175 },
      { description: 'Door install / adjustment', qty: 1, unit: 'EA', price: 225 },
      { description: 'Fixture install (light / ceiling fan)', qty: 1, unit: 'EA', price: 150 },
      { description: 'Caulk / weatherproofing', qty: 1, unit: 'LF', price: 4.5 },
      { description: 'Furniture assembly / mounting', qty: 1, unit: 'LS', price: 125 },
    ],
  },
  {
    id: 'remodeling',
    name: 'Remodeling / GC',
    lines: [
      { description: 'Demo and haul-off', qty: 1, unit: 'LS', price: 850 },
      { description: 'Framing labor', qty: 1, unit: 'SF', price: 8.5 },
      { description: 'Drywall hang, tape, finish', qty: 1, unit: 'SF', price: 3.75 },
      { description: 'Interior door + trim package', qty: 1, unit: 'EA', price: 425 },
      { description: 'Flooring install (LVP / laminate)', qty: 1, unit: 'SF', price: 4.5 },
      { description: 'Project management / supervision', qty: 1, unit: 'DAY', price: 450 },
    ],
  },
  {
    id: 'roofing',
    name: 'Roofing',
    lines: [
      { description: 'Asphalt shingle reroof', qty: 1, unit: 'SQ', price: 425 },
      { description: 'Roof tear-off', qty: 1, unit: 'SQ', price: 85 },
      { description: 'Flashing / chimney work', qty: 1, unit: 'LS', price: 650 },
      { description: 'Gutter install', qty: 1, unit: 'LF', price: 12 },
      { description: 'Roof leak repair (spot)', qty: 1, unit: 'LS', price: 450 },
      { description: 'Roof inspection + report', qty: 1, unit: 'LS', price: 175 },
    ],
  },
  {
    id: 'flooring',
    name: 'Flooring',
    lines: [
      { description: 'LVP / vinyl plank install', qty: 1, unit: 'SF', price: 4.25 },
      { description: 'Hardwood refinish', qty: 1, unit: 'SF', price: 4.75 },
      { description: 'Tile install (floor)', qty: 1, unit: 'SF', price: 12 },
      { description: 'Carpet install', qty: 1, unit: 'SF', price: 3.5 },
      { description: 'Floor prep / leveling', qty: 1, unit: 'SF', price: 2.25 },
      { description: 'Baseboard remove & replace', qty: 1, unit: 'LF', price: 6.5 },
    ],
  },
  {
    id: 'plumbing',
    name: 'Plumbing',
    lines: [
      { description: 'Toilet replace', qty: 1, unit: 'EA', price: 385 },
      { description: 'Faucet install / replace', qty: 1, unit: 'EA', price: 225 },
      { description: 'Water heater replace (standard)', qty: 1, unit: 'EA', price: 1850 },
      { description: 'Drain clearing', qty: 1, unit: 'EA', price: 175 },
      { description: 'Supply line / shutoff repair', qty: 1, unit: 'EA', price: 195 },
      { description: 'Service call / diagnosis', qty: 1, unit: 'LS', price: 125 },
    ],
  },
  {
    id: 'electrical',
    name: 'Electrical',
    lines: [
      { description: 'Outlet / switch replace', qty: 1, unit: 'EA', price: 125 },
      { description: 'Ceiling fan / light install', qty: 1, unit: 'EA', price: 185 },
      { description: 'Panel / breaker work (standard)', qty: 1, unit: 'LS', price: 650 },
      { description: 'EV charger install (labor)', qty: 1, unit: 'LS', price: 1200 },
      { description: 'Troubleshoot / service call', qty: 1, unit: 'LS', price: 145 },
      { description: 'Smoke / CO detector install', qty: 1, unit: 'EA', price: 95 },
    ],
  },
  {
    id: 'hvac',
    name: 'HVAC',
    lines: [
      { description: 'AC tune-up / maintenance', qty: 1, unit: 'LS', price: 129 },
      { description: 'Furnace tune-up', qty: 1, unit: 'LS', price: 129 },
      { description: 'Thermostat install', qty: 1, unit: 'EA', price: 175 },
      { description: 'Duct cleaning (per system)', qty: 1, unit: 'LS', price: 450 },
      { description: 'Filter change / service call', qty: 1, unit: 'LS', price: 99 },
      { description: 'System diagnosis', qty: 1, unit: 'LS', price: 125 },
    ],
  },
  {
    id: 'cleaning',
    name: 'Cleaning',
    lines: [
      { description: 'Standard house clean', qty: 1, unit: 'LS', price: 175 },
      { description: 'Deep clean', qty: 1, unit: 'LS', price: 325 },
      { description: 'Move-out clean', qty: 1, unit: 'LS', price: 375 },
      { description: 'Carpet cleaning (per room)', qty: 1, unit: 'EA', price: 65 },
      { description: 'Window cleaning (interior)', qty: 1, unit: 'EA', price: 8 },
      { description: 'Office clean — recurring', qty: 1, unit: 'LS', price: 150 },
    ],
  },
  {
    id: 'concrete',
    name: 'Concrete / flatwork',
    lines: [
      { description: 'Concrete slab / patio', qty: 1, unit: 'SF', price: 9.5 },
      { description: 'Sidewalk / walkway', qty: 1, unit: 'SF', price: 8.75 },
      { description: 'Driveway pour', qty: 1, unit: 'SF', price: 10.5 },
      { description: 'Concrete removal', qty: 1, unit: 'SF', price: 3.5 },
      { description: 'Crack repair / resurfacing', qty: 1, unit: 'SF', price: 4.25 },
      { description: 'Curb / gutter section', qty: 1, unit: 'LF', price: 28 },
    ],
  },
  {
    id: 'fencing',
    name: 'Fencing',
    lines: [
      { description: 'Wood privacy fence install', qty: 1, unit: 'LF', price: 45 },
      { description: 'Chain-link fence install', qty: 1, unit: 'LF', price: 28 },
      { description: 'Fence repair (panel / post)', qty: 1, unit: 'EA', price: 185 },
      { description: 'Gate install', qty: 1, unit: 'EA', price: 450 },
      { description: 'Fence staining / sealing', qty: 1, unit: 'LF', price: 6.5 },
      { description: 'Fence removal / haul-off', qty: 1, unit: 'LF', price: 8 },
    ],
  },
  {
    id: 'carpentry',
    name: 'Carpentry / trim',
    lines: [
      { description: 'Baseboard install', qty: 1, unit: 'LF', price: 6.5 },
      { description: 'Crown molding install', qty: 1, unit: 'LF', price: 9.5 },
      { description: 'Custom shelving / closet', qty: 1, unit: 'LS', price: 650 },
      { description: 'Deck board replace', qty: 1, unit: 'SF', price: 12 },
      { description: 'Stair / railing work', qty: 1, unit: 'LS', price: 850 },
      { description: 'Finish carpentry — hourly', qty: 1, unit: 'HR', price: 95 },
    ],
  },
  {
    id: 'windows-doors',
    name: 'Windows & doors',
    lines: [
      { description: 'Window replace (standard)', qty: 1, unit: 'EA', price: 650 },
      { description: 'Exterior door replace', qty: 1, unit: 'EA', price: 950 },
      { description: 'Sliding glass door', qty: 1, unit: 'EA', price: 1850 },
      { description: 'Window / door trim', qty: 1, unit: 'EA', price: 175 },
      { description: 'Weatherstripping / seal', qty: 1, unit: 'EA', price: 95 },
      { description: 'Screen repair / replace', qty: 1, unit: 'EA', price: 75 },
    ],
  },
  {
    id: 'insulation',
    name: 'Insulation',
    lines: [
      { description: 'Attic insulation (blown)', qty: 1, unit: 'SF', price: 1.85 },
      { description: 'Wall insulation', qty: 1, unit: 'SF', price: 2.25 },
      { description: 'Spray foam (open cell)', qty: 1, unit: 'SF', price: 1.65 },
      { description: 'Crawlspace encapsulation (labor)', qty: 1, unit: 'SF', price: 4.5 },
      { description: 'Air sealing package', qty: 1, unit: 'LS', price: 650 },
      { description: 'Insulation removal', qty: 1, unit: 'SF', price: 1.25 },
    ],
  },
  {
    id: 'masonry',
    name: 'Masonry',
    lines: [
      { description: 'Brick repair / tuckpoint', qty: 1, unit: 'SF', price: 18 },
      { description: 'Block wall', qty: 1, unit: 'SF', price: 22 },
      { description: 'Chimney repair', qty: 1, unit: 'LS', price: 950 },
      { description: 'Stone veneer', qty: 1, unit: 'SF', price: 28 },
      { description: 'Retaining wall', qty: 1, unit: 'SF', price: 35 },
      { description: 'Masonry service call', qty: 1, unit: 'LS', price: 175 },
    ],
  },
  {
    id: 'siding',
    name: 'Siding',
    lines: [
      { description: 'Vinyl siding install', qty: 1, unit: 'SF', price: 7.5 },
      { description: 'Fiber cement siding', qty: 1, unit: 'SF', price: 11 },
      { description: 'Siding repair (spot)', qty: 1, unit: 'LS', price: 450 },
      { description: 'Soffit / fascia', qty: 1, unit: 'LF', price: 18 },
      { description: 'House wrap / weather barrier', qty: 1, unit: 'SF', price: 1.25 },
      { description: 'Siding tear-off', qty: 1, unit: 'SF', price: 1.75 },
    ],
  },
  {
    id: 'pest',
    name: 'Pest control',
    lines: [
      { description: 'General pest treatment', qty: 1, unit: 'LS', price: 175 },
      { description: 'Termite inspection', qty: 1, unit: 'LS', price: 125 },
      { description: 'Termite treatment', qty: 1, unit: 'LS', price: 850 },
      { description: 'Rodent exclusion', qty: 1, unit: 'LS', price: 450 },
      { description: 'Mosquito / yard treatment', qty: 1, unit: 'LS', price: 95 },
      { description: 'Quarterly service plan', qty: 1, unit: 'LS', price: 99 },
    ],
  },
  {
    id: 'pool',
    name: 'Pool / spa',
    lines: [
      { description: 'Weekly pool service', qty: 1, unit: 'LS', price: 150 },
      { description: 'Pool opening / closing', qty: 1, unit: 'LS', price: 275 },
      { description: 'Filter clean / repair', qty: 1, unit: 'LS', price: 185 },
      { description: 'Pump replace (labor)', qty: 1, unit: 'LS', price: 450 },
      { description: 'Tile / grout repair', qty: 1, unit: 'LF', price: 28 },
      { description: 'Green-to-clean recovery', qty: 1, unit: 'LS', price: 350 },
    ],
  },
  {
    id: 'appliance',
    name: 'Appliance repair',
    lines: [
      { description: 'Service call / diagnosis', qty: 1, unit: 'LS', price: 125 },
      { description: 'Washer / dryer repair', qty: 1, unit: 'LS', price: 185 },
      { description: 'Refrigerator repair', qty: 1, unit: 'LS', price: 225 },
      { description: 'Dishwasher repair', qty: 1, unit: 'LS', price: 175 },
      { description: 'Oven / range repair', qty: 1, unit: 'LS', price: 195 },
      { description: 'Appliance install', qty: 1, unit: 'EA', price: 150 },
    ],
  },
  {
    id: 'moving',
    name: 'Moving / junk',
    lines: [
      { description: 'Local move — 2 movers', qty: 1, unit: 'HR', price: 145 },
      { description: 'Junk removal (truck load)', qty: 1, unit: 'LS', price: 450 },
      { description: 'Furniture move / rearrange', qty: 1, unit: 'LS', price: 175 },
      { description: 'Packing labor', qty: 1, unit: 'HR', price: 65 },
      { description: 'Storage unit load/unload', qty: 1, unit: 'LS', price: 250 },
      { description: 'Appliance haul-away', qty: 1, unit: 'EA', price: 85 },
    ],
  },
  {
    id: 'auto-detail',
    name: 'Auto detailing',
    lines: [
      { description: 'Exterior wash & wax', qty: 1, unit: 'EA', price: 125 },
      { description: 'Full detail (interior + exterior)', qty: 1, unit: 'EA', price: 225 },
      { description: 'Interior deep clean', qty: 1, unit: 'EA', price: 150 },
      { description: 'Paint correction / polish', qty: 1, unit: 'EA', price: 450 },
      { description: 'Ceramic coating (labor)', qty: 1, unit: 'EA', price: 650 },
      { description: 'Fleet wash (per vehicle)', qty: 1, unit: 'EA', price: 45 },
    ],
  },
  {
    id: 'solar',
    name: 'Solar',
    lines: [
      { description: 'Solar panel cleaning', qty: 1, unit: 'LS', price: 175 },
      { description: 'Panel install labor (per panel)', qty: 1, unit: 'EA', price: 125 },
      { description: 'Inverter install / replace', qty: 1, unit: 'LS', price: 850 },
      { description: 'System inspection', qty: 1, unit: 'LS', price: 225 },
      { description: 'Roof mount / racking labor', qty: 1, unit: 'LS', price: 1200 },
      { description: 'Troubleshooting / service call', qty: 1, unit: 'LS', price: 175 },
    ],
  },
  {
    id: 'garage',
    name: 'Garage doors',
    lines: [
      { description: 'Garage door spring replace', qty: 1, unit: 'LS', price: 285 },
      { description: 'Opener install / replace', qty: 1, unit: 'EA', price: 350 },
      { description: 'Door panel replace', qty: 1, unit: 'EA', price: 425 },
      { description: 'Track / roller repair', qty: 1, unit: 'LS', price: 195 },
      { description: 'Full door install', qty: 1, unit: 'EA', price: 1450 },
      { description: 'Service call / tune-up', qty: 1, unit: 'LS', price: 125 },
    ],
  },
];

export function getTradeById(id: string): TradeQuickLinesCatalog | undefined {
  return TRADE_QUICK_LINES.find((t) => t.id === id);
}

export function tradeQuickLinesToSaved(
  trade: TradeQuickLinesCatalog,
  startId = Date.now()
): Array<{
  id: number;
  description: string;
  qty: number;
  unit: string;
  price: number;
  tradeId: string;
  tradeName: string;
}> {
  return trade.lines.map((line, i) => ({
    id: startId + i,
    description: line.description,
    qty: line.qty,
    unit: line.unit,
    price: line.price,
    tradeId: trade.id,
    tradeName: trade.name,
  }));
}
