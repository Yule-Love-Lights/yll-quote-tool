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
  ext50: 21.1008684,
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const posInt = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const posFt = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

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

/** Signal boosters: controller >10 ft → 1; each gap run >50 ft → +1. */
export function boosterCount(input: PermanentBomInput): number {
  const ctrl = (input.controllerToFirstLightFt ?? 0) > 10 ? 1 : 0;
  const gapBoost = input.gaps.filter((g) => Number.isFinite(g.lengthFt) && g.lengthFt > 50).length;
  return ctrl + gapBoost;
}

const EXT_SIZES = [3, 5, 10, 25, 50] as const;
type ExtSize = (typeof EXT_SIZES)[number];

/**
 * Extensions per gap: the smallest stock size that covers it; a run over 50 ft is
 * combined (60 → 50' + 10'). Each `splitter` gap adds one 12V splitter.
 */
export function extensionsForGaps(
  gaps: PermanentGap[],
): { extensions: Array<{ ft: ExtSize; qty: number }>; splitters: number } {
  const counts = new Map<ExtSize, number>();
  let splitters = 0;
  for (const g of gaps) {
    if (g.splitter) splitters++;
    let len = Number.isFinite(g.lengthFt) ? g.lengthFt : 0;
    if (len <= 0) continue;
    while (len > 50) {
      counts.set(50, (counts.get(50) ?? 0) + 1);
      len -= 50;
    }
    const size = EXT_SIZES.find((s) => s >= len) ?? 50;
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  const extensions = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ft, qty]) => ({ ft, qty }));
  return { extensions, splitters };
}

const EXT_COST: Record<ExtSize, number> = {
  3: C.ext3,
  5: C.ext5,
  10: C.ext10,
  25: C.ext25,
  50: C.ext50,
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

  // Lights: run pucks come as sets-of-5 + loose singles; corner lights are singles.
  const { sets5, singles: runSingles } = splitSetsAndSingles(runPucks);
  const totalSingles = runSingles + cornerSingles;
  const blk = input.blackHousing ? '-BLK' : '';
  push(`APL11012-5${blk}`, `RGBW set of 5${blk ? ' (black)' : ''}`, sets5, cost(`APL11012-5${blk}`, C.set5), 'lights');
  push(`APL11012-1${blk}`, `RGBW single${blk ? ' (black)' : ''}`, totalSingles, cost(`APL11012-1${blk}`, C.single), 'lights');

  // Track.
  const tracks = trackSections(totalFt);
  const tSku = trackSku(input.trackStyle, input.trackColor);
  const tUnit = input.trackStyle === 'parapet' ? C.trackParapet : C.trackSingle;
  push(tSku, `40" ${input.trackStyle === 'parapet' ? 'parapet' : 'single'} track (${input.trackColor})`, tracks, cost(tSku, tUnit), 'track');

  // Transformers (first = KIT with the system hub; rest bare).
  const units = sizeTransformers(totalLights);
  for (const u of units) {
    if (u.kit) {
      push(`APL11111-${u.watts}-KIT`, `${u.watts}W KIT (power + hub + booster + adapter)`, 1, cost(`APL11111-${u.watts}-KIT`, u.watts === 350 ? C.kit350 : C.kit600), 'power');
    } else {
      push(`APL11110-${u.watts}`, `${u.watts}W power supply`, 1, cost(`APL11110-${u.watts}`, u.watts === 350 ? C.xfmr350 : C.xfmr600), 'power');
    }
  }

  // Power injection — per powered segment (per transformer unit).
  const injections = units.reduce((s, u) => s + powerInjectionCount(u.lights), 0);
  push('APL11123', 'Power T-injector 12V', injections, cost('APL11123', C.powerT), 'power');

  // Data: extra boosters (beyond the KIT's) + splitters + extensions.
  push('APL11121', 'Signal booster', boosterCount(input), cost('APL11121', C.booster), 'data');
  const { extensions, splitters } = extensionsForGaps(input.gaps);
  push('APL11122', 'Splitter 12V', splitters, cost('APL11122', C.splitter), 'data');
  for (const e of extensions) {
    push(`APL11312-${e.ft}`, `${e.ft}' extension 12V`, e.qty, cost(`APL11312-${e.ft}`, EXT_COST[e.ft]), 'extension');
  }

  const wholesaleCost = round2(lines.reduce((s, l) => s + l.extCost, 0));
  const flags: string[] = [];
  // Parapet track is stocked only in white (9003) / black (9004).
  if (input.trackStyle === 'parapet' && input.trackColor !== '9003' && input.trackColor !== '9004') {
    flags.push('parapet-track-only-stocked-white-or-black');
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
