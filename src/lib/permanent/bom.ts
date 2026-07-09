// Permanent Lighting vertical (#88) — pure BOM (bill-of-materials) engine.
//
// Turns a permanent job's per-side footage/corners/gaps into the ordered
// Ascend/Dauer `APL` material list + wholesale cost. Materials NEVER touch the
// customer price (that's the flat $/ft in pricing.ts) — this is operator-facing
// ordering + margin only. Pure: no UI, no DB, no I/O.
//
// Cost basis + formulas: docs/permanent/BOM-DATA.md (Wave-0, Naldo 2026-07-03).
// The ASCEND APL wholesale list reproduces the OMNI estimator totals to ~0.3%
// (Greg 125ft → $1,286.56 vs sheet $1,290.81). Golden cases live in bom.test.ts.

import type { TrackStyle, TrackColor, PermanentGap } from './types';

export type BomCategory = 'lights' | 'track' | 'power' | 'data' | 'extension' | 'accessory';

export type BomLine = {
  sku: string;
  description: string;
  qty: number;
  unitCost: number;
  extCost: number;
  category: BomCategory;
};

export type PermanentBomInput = {
  footageBySide: { front: number; left: number; right: number; back: number };
  cornersBySide: { front: number; left: number; right: number; back: number };
  trackStyle: TrackStyle;
  trackColor: TrackColor;
  /** Puck housing: true → the -BLK SKUs (same price). */
  blackHousing: boolean;
  /** >10 ft → +1 signal booster (the KIT already bundles one for the run start). */
  controllerToFirstLightFt?: number;
  /** Jumps between runs — drive extensions (sized per gap), splitters, and >50ft boosters. */
  gaps: PermanentGap[];
  /**
   * #140 — the Extensions/Splitters card counts. When present they OVERRIDE the
   * gaps-derived accessories entirely: extension lines come from `extensions`,
   * the splitter line from `splitters`, and long-jump boosters from
   * `jumpBoosters` (the controller>10ft booster rule still applies on top).
   * Callers set this ONLY when the card was actually written (see
   * bomFromQuote's accessoriesSource predicate) — never from a defaulted object.
   */
  accessories?: {
    extensions: { e3: number; e5: number; e10: number; e25: number };
    splitters: number;
    jumpBoosters: number;
  };
};

export type TransformerUnit = { watts: 350 | 600; kit: boolean; lights: number };

export type PermanentBom = {
  lines: BomLine[];
  totals: {
    totalFt: number;
    /** Total lights = run pucks + corner singles (what draws power). */
    puckCount: number;
    cornerSingles: number;
    trackSections: number;
    wholesaleCost: number;
    costPerFt: number;
  };
  flags: string[];
};

// Wholesale costs — 2026 ASCEND by Dauer price list (docs/permanent/BOM-DATA.md).
const C = {
  set5: 15.5156316,
  single: 3.8471736,
  trackSingle: 7.3330644,
  trackParapet: 8.3778552,
  xfmr350: 251.9410488,
  xfmr600: 342.8476128,
  kit350: 345.4449432,
  kit600: 433.7541768,
  booster: 12.6644268,
  splitter: 6.6495564,
  powerT: 5.8488756,
  ext3: 2.9439666,
  ext5: 3.4565976,
  ext10: 4.6087968,
  ext25: 10.7115468,
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const posInt = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const posFt = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

// Waste on ORDERED quantities — 6% on track AND lights (#144, matching the
// estimator sheet's convention + the BOM-DATA reconciliation; the tool
// previously wasted track only). Applied per order line, rounded up.
const WASTE = 0.06;
const withWaste = (qty: number) => (qty > 0 ? Math.ceil(qty * (1 + WASTE)) : 0);

// Power-injection wire (#144): each T-injector beyond the first needs a 16/2
// low-voltage run back to the supply, budgeted at 70 ft per point (the
// estimator sheet's rule, spare-inclusive count). No Ascend SKU/price on the
// 2026 list yet — provisional key + flag, priced at the OMNI list's $0.23/ft
// until Naldo confirms.
const WIRE_SKU = 'APL-WIRE-16-2';
const WIRE_FT_PER_INJECTOR = 70;
const WIRE_COST_PER_FT = 0.23;

/** Pucks for a run: 8" on-center → ceil(ft × 1.5). */
export function puckCountForFeet(ft: number): number {
  if (!Number.isFinite(ft) || ft <= 0) return 0;
  return Math.ceil(ft * 1.5);
}

/** Split a run's pucks into sets-of-5 (APL11012-5) + loose singles (APL11012-1). */
export function splitSetsAndSingles(pucks: number): { sets5: number; singles: number } {
  const p = posInt(pucks);
  return { sets5: Math.floor(p / 5), singles: p % 5 };
}

/** 40" (3.333 ft) track sections + 6% waste. */
export function trackSections(ft: number): number {
  if (!Number.isFinite(ft) || ft <= 0) return 0;
  return Math.ceil(Math.ceil(ft / (40 / 12)) * 1.06);
}

// Transformer sizing binds on PUCKS (Naldo 2026-07-03), not feet, at ≤85% load:
// 350W rated 300 pucks → 255 usable; 600W rated 510 → 433 usable. Applies to both.
const CAP = { 350: Math.floor(300 * 0.85), 600: Math.floor(510 * 0.85) }; // 255, 433

/**
 * Cover `lights` with the CHEAPEST transformer set at ≤85% load. 600W is cheaper
 * per puck for bulk, but two 350W (255 each → 510) can undercut a 600W+350W set
 * in the 256–510-light window, so we enumerate `(n600, n350)` combinations that
 * cover the load and pick the lowest total cost rather than greedily grabbing
 * 600s. The FIRST unit is a KIT (bundles the one system WiFi hub + a booster +
 * adapter); the rest are bare power supplies (one hub per system — Naldo
 * 2026-07-03). The KIT is placed on a 600W when the set has one, else a 350W.
 */
export function sizeTransformers(lights: number): TransformerUnit[] {
  if (!Number.isFinite(lights) || lights <= 0) return [];
  const L = Math.ceil(lights);
  const kitPremium = { 350: C.kit350 - C.xfmr350, 600: C.kit600 - C.xfmr600 };
  let best: { n600: number; n350: number; cost: number } | null = null;
  const maxN600 = Math.ceil(L / CAP[600]);
  for (let n600 = 0; n600 <= maxN600; n600++) {
    const covered = CAP[600] * n600;
    const n350 = covered >= L ? 0 : Math.ceil((L - covered) / CAP[350]);
    if (n600 + n350 === 0) continue;
    // Every unit bare, then upgrade exactly one to a KIT (prefer a 600 if present).
    let cost = n600 * C.xfmr600 + n350 * C.xfmr350;
    cost += n600 > 0 ? kitPremium[600] : kitPremium[350];
    if (best === null || cost < best.cost) best = { n600, n350, cost };
  }
  const { n600, n350 } = best!;
  const order: (350 | 600)[] = [...Array(n600).fill(600 as const), ...Array(n350).fill(350 as const)];
  const units: TransformerUnit[] = [];
  let rem = L;
  order.forEach((watts, i) => {
    const last = i === order.length - 1;
    const lightsForUnit = last ? rem : Math.min(CAP[watts], rem);
    units.push({ watts, kit: i === 0, lights: lightsForUnit });
    rem -= lightsForUnit;
  });
  return units;
}

/** Power-T injectors: one per ~75 lights (segment). */
export function powerInjectionCount(lights: number): number {
  if (!Number.isFinite(lights) || lights <= 0) return 0;
  return Math.ceil(lights / 75);
}

/**
 * Signal boosters: controller >10 ft → 1; long jumps >50 ft → +1 each. Long
 * jumps come from the card's `jumpBoosters` when the accessories override is
 * present (#140), else from the legacy gaps rows.
 */
export function boosterCount(input: PermanentBomInput): number {
  const ctrl = (input.controllerToFirstLightFt ?? 0) > 10 ? 1 : 0;
  const jumpBoost = input.accessories
    ? posInt(input.accessories.jumpBoosters)
    : input.gaps.filter((g) => Number.isFinite(g.lengthFt) && g.lengthFt > 50).length;
  return ctrl + jumpBoost;
}

// Stock extension sizes (#140, Jason S24): 3'/5'/10'/25' ONLY — 50s are dropped
// ("issues in the past with 50s"); anything longer CHAINS (15 = 10+5,
// 30 = 25+5, 60 = 25+25+10).
export const EXT_SIZES = [3, 5, 10, 25] as const;
export type ExtSize = (typeof EXT_SIZES)[number];

/**
 * Bucket one needed length into stock extension pieces (#140, Jason S24):
 *   • >25 ft chains 25s, then the remainder below;
 *   • (15, 25] → a single 25 (overshoot beats a 3-piece chain);
 *   • (10, 15] → 10 + the ≤5 remainder ("a 25 is a large jump from 10");
 *   • (0, 10]  → the smallest covering size.
 * Shared by the legacy gaps path here and the #140 jump-sizing ladder
 * (trackAccessories) so the two can never bucket differently.
 */
export function bucketExtensionLength(lengthFt: number): ExtSize[] {
  let len = Number.isFinite(lengthFt) ? lengthFt : 0;
  if (len <= 0) return [];
  const pieces: ExtSize[] = [];
  while (len > 25) {
    pieces.push(25);
    len -= 25;
  }
  if (len > 15) {
    pieces.push(25);
  } else {
    if (len > 10) {
      pieces.push(10);
      len -= 10;
    }
    if (len > 0) pieces.push(EXT_SIZES.find((s) => s >= len) ?? 25);
  }
  return pieces.sort((a, b) => a - b);
}

/**
 * Extensions per gap (the LEGACY path — pre-#140 stored quotes whose card was
 * never written), bucketed via bucketExtensionLength. Each `splitter` gap adds
 * one 12V splitter.
 */
export function extensionsForGaps(
  gaps: PermanentGap[],
): { extensions: Array<{ ft: ExtSize; qty: number }>; splitters: number } {
  const counts = new Map<ExtSize, number>();
  let splitters = 0;
  for (const g of gaps) {
    if (g.splitter) splitters++;
    for (const size of bucketExtensionLength(g.lengthFt)) {
      counts.set(size, (counts.get(size) ?? 0) + 1);
    }
  }
  const extensions = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ft, qty]) => ({ ft, qty }));
  return { extensions, splitters };
}

/** The card counts → the same shape extensionsForGaps returns (#140 override). */
function extensionsFromAccessories(
  acc: NonNullable<PermanentBomInput['accessories']>,
): { extensions: Array<{ ft: ExtSize; qty: number }>; splitters: number } {
  const byFt: Array<[ExtSize, number]> = [
    [3, posInt(acc.extensions.e3)],
    [5, posInt(acc.extensions.e5)],
    [10, posInt(acc.extensions.e10)],
    [25, posInt(acc.extensions.e25)],
  ];
  return {
    extensions: byFt.filter(([, qty]) => qty > 0).map(([ft, qty]) => ({ ft, qty })),
    splitters: posInt(acc.splitters),
  };
}

const EXT_COST: Record<ExtSize, number> = {
  3: C.ext3,
  5: C.ext5,
  10: C.ext10,
  25: C.ext25,
};

function trackSku(style: TrackStyle, color: TrackColor): string {
  return style === 'parapet' ? `APL11230-90-${color}` : `APL11210-${color}`;
}

/**
 * Build the full permanent BOM. `costOverrides` (SKU → wholesale) lets Phase 7/8
 * feed live `inventory_catalog` costs; absent SKUs fall back to the APL list.
 */
export function buildPermanentBom(
  input: PermanentBomInput,
  costOverrides?: ReadonlyMap<string, number>,
): PermanentBom {
  const cost = (sku: string, fallback: number) => costOverrides?.get(sku) ?? fallback;
  const lines: BomLine[] = [];
  const push = (
    sku: string,
    description: string,
    qty: number,
    unitCost: number,
    category: BomCategory,
  ) => {
    if (qty > 0) lines.push({ sku, description, qty, unitCost, extCost: round2(qty * unitCost), category });
  };

  const sides = ['front', 'left', 'right', 'back'] as const;
  const totalFt = sides.reduce((s, k) => s + posFt(input.footageBySide[k]), 0);
  const runPucks = sides.reduce((s, k) => s + puckCountForFeet(input.footageBySide[k]), 0);
  const cornerSingles = sides.reduce((s, k) => s + posInt(input.cornersBySide[k]) * 3, 0);
  const totalLights = runPucks + cornerSingles;

  // Lights (#144): sets pack PER SIDE/run — a rigid 5-strip can't continue
  // across a run break, so each side takes floor-into-5s plus its own
  // remainder singles (the estimator sheet's per-run packing). Corner lights
  // are always singles. Ordered quantities carry the 6% waste.
  let sets5 = 0;
  let runSingles = 0;
  for (const k of sides) {
    const split = splitSetsAndSingles(puckCountForFeet(input.footageBySide[k]));
    sets5 += split.sets5;
    runSingles += split.singles;
  }
  const totalSingles = runSingles + cornerSingles;
  const blk = input.blackHousing ? '-BLK' : '';
  push(`APL11012-5${blk}`, `RGBW set of 5${blk ? ' (black)' : ''}`, withWaste(sets5), cost(`APL11012-5${blk}`, C.set5), 'lights');
  push(`APL11012-1${blk}`, `RGBW single${blk ? ' (black)' : ''}`, withWaste(totalSingles), cost(`APL11012-1${blk}`, C.single), 'lights');

  // Track.
  const tracks = trackSections(totalFt);
  const tSku = trackSku(input.trackStyle, input.trackColor);
  const tUnit = input.trackStyle === 'parapet' ? C.trackParapet : C.trackSingle;
  push(tSku, `40" ${input.trackStyle === 'parapet' ? 'parapet' : 'single'} track (${input.trackColor})`, tracks, cost(tSku, tUnit), 'track');

  // Transformers (first = KIT with the system hub; rest bare). #125-4: a large
  // job can need 2+ bare supplies of the SAME wattage — emit ONE Qty-N line per
  // wattage, not a Qty-1 line per unit, so the printed order sheet never lists a
  // SKU on duplicate rows (and its `key={l.sku}` never collides). There is only
  // ever one KIT (sizeTransformers puts it on the first unit).
  const units = sizeTransformers(totalLights);
  const kitUnit = units.find((u) => u.kit);
  if (kitUnit) {
    push(`APL11111-${kitUnit.watts}-KIT`, `${kitUnit.watts}W KIT (power + hub + booster + adapter)`, 1, cost(`APL11111-${kitUnit.watts}-KIT`, kitUnit.watts === 350 ? C.kit350 : C.kit600), 'power');
  }
  const bare600 = units.filter((u) => !u.kit && u.watts === 600).length;
  const bare350 = units.filter((u) => !u.kit && u.watts === 350).length;
  push('APL11110-600', '600W power supply', bare600, cost('APL11110-600', C.xfmr600), 'power');
  push('APL11110-350', '350W power supply', bare350, cost('APL11110-350', C.xfmr350), 'power');

  // Power injection — per powered segment (per transformer unit), plus ONE
  // spare (#144, Jason: "a spare would be good"; the P8 ordering layer nets
  // the spare against warehouse on-hand — the BOM itself always lists it).
  const installedInjections = units.reduce((s, u) => s + powerInjectionCount(u.lights), 0);
  const injections = installedInjections > 0 ? installedInjections + 1 : 0;
  push('APL11123', 'Power T-injector 12V (incl. 1 spare)', injections, cost('APL11123', C.powerT), 'power');

  // Injection wire (#144): 70 ft of 16/2 per injector beyond the first
  // (spare-inclusive count — the estimator sheet's rule). Provisional
  // SKU/price until the Ascend list carries it (flagged below).
  const wireFt = injections > 1 ? (injections - 1) * WIRE_FT_PER_INJECTOR : 0;
  push(WIRE_SKU, "Power injection wire 16/2 (ft)", wireFt, cost(WIRE_SKU, WIRE_COST_PER_FT), 'power');

  // Data: extra boosters (beyond the KIT's) + splitters + extensions. The #140
  // card counts override the gaps-derived accessories entirely when present;
  // the controller-run feed (#144) is ADDITIVE on top of either path — the
  // card never counts the cable from the controller to the first light.
  push('APL11121', 'Signal booster', boosterCount(input), cost('APL11121', C.booster), 'data');
  const { extensions, splitters } = input.accessories
    ? extensionsFromAccessories(input.accessories)
    : extensionsForGaps(input.gaps);
  const extCounts = new Map<ExtSize, number>(extensions.map((e) => [e.ft, e.qty]));
  for (const size of bucketExtensionLength(input.controllerToFirstLightFt ?? 0)) {
    extCounts.set(size, (extCounts.get(size) ?? 0) + 1);
  }
  push('APL11122', 'Splitter 12V', splitters, cost('APL11122', C.splitter), 'data');
  for (const [ft, qty] of [...extCounts.entries()].sort((a, b) => a[0] - b[0])) {
    push(`APL11312-${ft}`, `${ft}' extension 12V`, qty, cost(`APL11312-${ft}`, EXT_COST[ft]), 'extension');
  }

  const wholesaleCost = round2(lines.reduce((s, l) => s + l.extCost, 0));
  const flags: string[] = [];
  // Parapet track is stocked only in white (9003) / black (9004).
  if (input.trackStyle === 'parapet' && input.trackColor !== '9003' && input.trackColor !== '9004') {
    flags.push('parapet-track-only-stocked-white-or-black');
  }
  // #144: the wire SKU/price is provisional (not on the 2026 Ascend list) —
  // the order sheet must say so until Naldo confirms the real item.
  if (wireFt > 0) {
    flags.push('verify-injection-wire-sku-and-price-with-ascend');
  }

  return {
    lines,
    totals: {
      totalFt,
      puckCount: totalLights,
      cornerSingles,
      trackSections: tracks,
      wholesaleCost,
      costPerFt: totalFt > 0 ? round2(wholesaleCost / totalFt) : 0,
    },
    flags,
  };
}
