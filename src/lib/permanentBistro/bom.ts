// Permanent Bistro Lighting (#117) — pure BOM (bill-of-materials) engine.
//
// Turns a permanent-bistro job's per-run footage + pole count into the ordered
// Thunder Lighting Supply / Home Depot / Amazon material list. Materials NEVER
// touch the customer price (that's the flat $/ft + $/pole in permanentBistro/
// pricing.ts) — this is operator-facing ordering only. Pure: no UI, no DB, no I/O.
//
// Mirrors src/lib/permanent/bom.ts's architecture (push-omits-zero-qty lines,
// a costOverrides hook, round2/posFt/posInt guards) — see that file's header
// for the shared conventions. The exact SKU list + formulas are Naldo's spec
// (2026-07-11, not derived from a supplier estimator sheet the way permanent's
// ASCEND numbers were): cord/bulb/wire quantities scale off total run footage,
// hardware scales off strand COUNT, posts/concrete off pole count, and the
// timer is one per job. Golden cases live in bom.test.ts.

export type BistroSupplier = 'thunder' | 'home-depot' | 'amazon';

export type BistroBomLine = {
  sku: string;
  description: string;
  qty: number;
  unitCost: number;
  extCost: number;
  supplier: BistroSupplier;
  url: string;
  /**
   * The SPT-2 zip wire (power feed to the outlet) — Naldo: "no way for you to
   * calculate this." Always qty 0; the print sheet renders "as needed" in the
   * qty cell instead of "0" for this line.
   */
  asNeeded?: boolean;
};

export type BistroBomInput = {
  /** One entry per bistro run's footage (raw; non-positive/invalid entries are dropped). */
  runs: number[];
  /** Pole/support count (raw; floored, non-positive/invalid reads 0). */
  poles: number;
};

export type BistroBom = {
  lines: BistroBomLine[];
  totals: {
    totalFootage: number;
    /** Count of runs with footage > 0 — drives the per-strand hardware lines. */
    strands: number;
    poles: number;
    unitsBySupplier: Record<BistroSupplier, number>;
    extCostTotal: number;
  };
  flags: string[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const posFt = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
const posInt = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

// Bulb waste — the same 6% waste convention as permanent's bom.ts:93-94
// withWaste, applied ONLY to bulbs (Naldo 2026-07-11 spec — cord/wire are NOT
// wasted; they're ordered by whole 330/250 ft sections, which already overshoot).
const BULB_WASTE = 1.06;

const THUNDER_URL = 'https://thunderlightingsupply.com/landscape-lighting/bistro-landscape-lighting/';
const HD_POST_URL =
  'https://www.homedepot.com/p/6-in-x-6-in-x-12-ft-2-Pressure-Treated-Ground-Contact-Southern-Pine-Timber-Wood-Post-6330254/100010238';
const HD_CONCRETE_URL = 'https://www.homedepot.com/p/SAKRETE-60-lb-Gray-Concrete-Mix-65200940/100321247';
const AMAZON_TIMER_URL = 'https://www.amazon.com/dp/B0F5M2S8VJ';

// Every Thunder SKU except the eye screw has no confirmed wholesale cost yet
// (Naldo 2026-07-11; the Amazon timer was confirmed at $24 the same day) —
// their fallback is $0 and the BOM carries ONE flag warning about it (mirrors
// the #144 provisional-flag pattern; flags[] renders as an amber warning on
// the print sheet).
const UNCONFIRMED_COST_SKUS = new Set([
  '80324', '80011', '80002', '80005', '80004', '80308', '80307', '80305',
]);
const UNCONFIRMED_COST_FLAG =
  'Thunder unit costs not confirmed yet — quantities are exact, costs show $0 until set.';

/**
 * Build the full permanent-bistro BOM. `costOverrides` (SKU → wholesale) lets
 * a future live `inventory_catalog` price feed in without a code change (see
 * src/lib/inventory/bistroCatalog.ts).
 */
export function buildBistroBom(
  input: BistroBomInput,
  costOverrides?: ReadonlyMap<string, number>,
): BistroBom {
  const cost = (sku: string, fallback: number) => costOverrides?.get(sku) ?? fallback;
  const lines: BistroBomLine[] = [];
  const push = (
    sku: string,
    description: string,
    qty: number,
    unitCost: number,
    supplier: BistroSupplier,
    url: string,
    asNeeded = false,
  ) => {
    // Zero-qty lines are omitted, EXCEPT the as-needed zip-wire row (qty is
    // always 0 for that line by definition — it still must print).
    if (qty <= 0 && !asNeeded) return;
    lines.push({
      sku,
      description,
      qty,
      unitCost,
      extCost: round2(qty * unitCost),
      supplier,
      url,
      ...(asNeeded ? { asNeeded: true } : {}),
    });
  };

  const runs = input.runs.map(posFt).filter((ft) => ft > 0);
  const totalFootage = runs.reduce((s, ft) => s + ft, 0);
  const strands = runs.length;
  const poles = posInt(input.poles);

  // Cord / bulbs / guide wire — scale off TOTAL run footage, ordered in whole
  // sections/spools (no partial sections). Bulbs alone carry the 6% waste.
  if (totalFootage > 0) {
    push(
      '80324',
      `E26 Bistro Cord 330ft, 24in spacing (covers ${Math.round(totalFootage * 10) / 10} ft needed)`,
      Math.ceil(totalFootage / 330),
      cost('80324', 0),
      'thunder',
      THUNDER_URL,
    );
    push(
      '80011',
      'Double Filament Bulb Warm White 120V',
      Math.ceil((totalFootage / 2) * BULB_WASTE),
      cost('80011', 0),
      'thunder',
      THUNDER_URL,
    );
    push(
      '80002',
      `3/32in Pro Guide Wire (covers ${Math.round(totalFootage * 10) / 10} ft needed)`,
      Math.ceil(totalFootage / 250),
      cost('80002', 0),
      'thunder',
      THUNDER_URL,
    );
  }

  // Per-strand hardware (2 eye screws / quick links / grippers, 1 male + 1
  // female plug per strand) + the as-needed zip-wire power feed — gated on
  // STRAND count, not footage, since a strand needs its end hardware even if
  // the total run is short.
  if (strands > 0) {
    push('93571', '3.75in L Eye Screw', strands * 2, cost('93571', 0.99), 'thunder', THUNDER_URL);
    push('80005', 'Quick Link', strands * 2, cost('80005', 0), 'thunder', THUNDER_URL);
    push('80004', 'Looping Gripper 3/32', strands * 2, cost('80004', 0), 'thunder', THUNDER_URL);
    push('80308', 'Slide Plug SPT2 Black Male', strands, cost('80308', 0), 'thunder', THUNDER_URL);
    push('80307', 'Slide Plug SPT2 Black Female', strands, cost('80307', 0), 'thunder', THUNDER_URL);
    push('80305', 'SPT-2 Zip Wire 500ft Black', 0, cost('80305', 0), 'thunder', THUNDER_URL, true);
  }

  // Poles: 1 post + 1 bag of concrete each.
  if (poles > 0) {
    push('100010238', '6x6x12ft Pressure-Treated Post', poles, cost('100010238', 56), 'home-depot', HD_POST_URL);
    push('100321247', 'SAKRETE 60 lb Gray Concrete Mix', poles, cost('100321247', 6), 'home-depot', HD_CONCRETE_URL);
  }

  // Timer: one per job, whenever there's anything to order at all.
  if (totalFootage > 0 || poles > 0) {
    push(
      'B0F5M2S8VJ',
      'Tapo P430M Smart Outdoor Plug (timer)',
      1,
      cost('B0F5M2S8VJ', 24),
      'amazon',
      AMAZON_TIMER_URL,
    );
  }

  const unitsBySupplier: Record<BistroSupplier, number> = { thunder: 0, 'home-depot': 0, amazon: 0 };
  for (const l of lines) unitsBySupplier[l.supplier] = round2(unitsBySupplier[l.supplier] + l.extCost);
  const extCostTotal = round2(lines.reduce((s, l) => s + l.extCost, 0));

  const flags: string[] = [];
  if (lines.some((l) => UNCONFIRMED_COST_SKUS.has(l.sku) && l.unitCost === 0)) {
    flags.push(UNCONFIRMED_COST_FLAG);
  }

  return {
    lines,
    totals: { totalFootage, strands, poles, unitsBySupplier, extCostTotal },
    flags,
  };
}
