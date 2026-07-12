// #109 Phase 2 — operator ground truth vs the AI's own snapshot.
//
// On /training/new the operator can now record what they ACTUALLY installed
// (ground truth) alongside the AI's counts captured at Auto-Analyze time (the
// AI snapshot). This module is the pure scoring layer between the two: given
// one house's known counts/footage and its AI snapshot, produce the per-type
// misses — reusing the SAME base "does this count as a miss" thresholds
// seedFinalStats.ts already uses for the corpus-wide bias note, so a "miss"
// means one consistent thing across the app. No I/O, no Supabase — safe to
// import from the client page too.

import { FT_THRESHOLD, COUNT_THRESHOLD } from '../seedFinalStats';
import type { SeedFinalPair } from '../seedFinalStats';
import type { SeedFinalFinal } from '../seedFinalDiff';
import type {
  MiniLightDetection,
  WreathDetection,
  SpritzerDetection,
  GarlandDetection,
} from '../photoAnalysis';

// What the operator says they actually installed. Every field is optional —
// the operator fills in only what they know; an absent field is simply never
// scored (see compareKnownVsAi).
export type KnownNumbers = {
  miniLights?: number;
  wreaths?: number;
  spritzers?: number;
  garland?: number;
  santasFootage?: number;
  gingerbreadFootage?: number;
  wwFootage?: number;
  stakeFootage?: number;
};

// The AI's own counts, captured at Auto-Analyze time. The big four detection
// counts + the two footages the analyzer actually returns are required
// (present whenever Auto-Analyze ran at all); wwFootage/stakeFootage stay
// optional since the analyzer doesn't currently detect those two categories.
export type AiSnapshot = {
  miniLights: number;
  wreaths: number;
  spritzers: number;
  garland: number;
  santasFootage: number;
  gingerbreadFootage: number;
  wwFootage?: number;
  stakeFootage?: number;
};

export type KnownVsAiField = keyof KnownNumbers;

export type KnownVsAiMiss = {
  type: KnownVsAiField;
  ai: number;
  known: number;
  big: boolean;
};

// Persisted shape (training_houses.operator_known_numbers jsonb).
export type OperatorKnownNumbers = {
  known?: KnownNumbers;
  aiSnapshot?: AiSnapshot;
  misses?: KnownVsAiMiss[];
};

const COUNT_FIELDS: readonly KnownVsAiField[] = ['miniLights', 'wreaths', 'spritzers', 'garland'];
const FOOTAGE_FIELDS: readonly KnownVsAiField[] = ['santasFootage', 'gingerbreadFootage', 'wwFootage', 'stakeFootage'];

// BIG MISS bars (#109 Phase 2, new — a stricter bar than the base "counts as
// a miss at all" thresholds above): a count off by 2+ items, or a footage off
// by 10ft+, is worth flagging red on the save-time readout rather than just
// noting as a small miss.
export const BIG_MISS_COUNT = 2;
export const BIG_MISS_FOOTAGE_FT = 10;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// PURE: compare what the operator recorded (known) against the AI's own
// counts at Auto-Analyze time (aiSnapshot).
//  - A type absent from `known` is never scored — a partial ground-truth
//    record (e.g. only wreaths filled in) scores only what's known.
//  - A type absent from `aiSnapshot` (only possible for wwFootage/
//    stakeFootage, which the analyzer doesn't currently return) is also
//    never scored — there's no AI opinion to compare against, so it isn't a
//    "miss", it's an unscored field.
//  - Returns [] when there's no aiSnapshot at all (Auto-Analyze never ran).
export function compareKnownVsAi(
  known: KnownNumbers | null | undefined,
  aiSnapshot: AiSnapshot | null | undefined,
): KnownVsAiMiss[] {
  if (!known || !aiSnapshot) return [];
  const misses: KnownVsAiMiss[] = [];

  for (const type of COUNT_FIELDS) {
    const knownVal = known[type];
    const aiVal = aiSnapshot[type];
    if (!isFiniteNumber(knownVal) || !isFiniteNumber(aiVal)) continue;
    const delta = Math.abs(aiVal - knownVal);
    if (delta < COUNT_THRESHOLD) continue;
    misses.push({ type, ai: aiVal, known: knownVal, big: delta >= BIG_MISS_COUNT });
  }

  for (const type of FOOTAGE_FIELDS) {
    const knownVal = known[type];
    const aiVal = aiSnapshot[type];
    if (!isFiniteNumber(knownVal) || !isFiniteNumber(aiVal)) continue;
    const delta = Math.abs(aiVal - knownVal);
    if (delta < FT_THRESHOLD) continue;
    misses.push({ type, ai: aiVal, known: knownVal, big: delta >= BIG_MISS_FOOTAGE_FT });
  }

  return misses;
}

// Build N placeholder detections of the given type — only `.length` (and,
// for minis, `.stringCount`) is ever read off these by seedFinalStats.ts, so
// a minimal-but-valid placeholder is enough to represent "N items" without
// claiming per-item detail (box/label) we don't have from an aggregate count.
function fakeMini(n: number): MiniLightDetection[] {
  return Array.from({ length: Math.max(0, Math.round(n)) }, () => ({
    type: 'bush', wrapStyle: 'canopy', stringCount: 0, box: [0, 0, 0.01, 0.01], label: '',
  }));
}
function fakeWreath(n: number): WreathDetection[] {
  return Array.from({ length: Math.max(0, Math.round(n)) }, () => ({
    size: '24noble', tier: 'bow', box: [0, 0, 0.01, 0.01], label: '',
  }));
}
function fakeSpritzer(n: number): SpritzerDetection[] {
  return Array.from({ length: Math.max(0, Math.round(n)) }, () => ({
    size: '16', box: [0, 0, 0.01, 0.01], label: '',
  }));
}
function fakeGarland(n: number): GarlandDetection[] {
  return Array.from({ length: Math.max(0, Math.round(n)) }, () => ({
    length: '9ft', tier: 'bow', box: [0, 0, 0.01, 0.01], label: '',
  }));
}

// #109 Phase 2 bias fold-in — turn one training_house's (known, aiSnapshot)
// ground-truth pair into the SAME seed→final shape the example-based bias
// corpus already uses (seedFinalStats.computeBiasSummary), so operator
// ground truth teaches the same calibration note the staff-corrected design
// examples do. A metric the operator never recorded contributes NO signal
// for this row: `final` falls back to the AI's own guess for that metric (a
// zero delta), rather than guessing at a truth we don't have — only the
// fields the operator actually confirmed move the corpus average.
export function knownAiPairToSeedFinal(known: KnownNumbers, aiSnapshot: AiSnapshot): SeedFinalPair {
  const seed: Record<string, unknown> = {
    santasFootage: aiSnapshot.santasFootage,
    gingerbreadFootage: aiSnapshot.gingerbreadFootage,
    miniLightDetections: fakeMini(aiSnapshot.miniLights),
    wreathDetections: fakeWreath(aiSnapshot.wreaths),
    spritzerDetections: fakeSpritzer(aiSnapshot.spritzers),
    garlandDetections: fakeGarland(aiSnapshot.garland),
  };

  const final: SeedFinalFinal = {
    santasFootage: known.santasFootage ?? aiSnapshot.santasFootage,
    gingerbreadFootage: known.gingerbreadFootage ?? aiSnapshot.gingerbreadFootage,
    // Unused by computeBiasSummary/formatBiasNote (counts + footage only) —
    // required by the shared type, stubbed since ground truth doesn't carry
    // a difficulty rating.
    santasDifficulty: 'medium',
    gingerbreadDifficulty: 'medium',
    miniLightDetections: fakeMini(known.miniLights ?? aiSnapshot.miniLights),
    wreathDetections: fakeWreath(known.wreaths ?? aiSnapshot.wreaths),
    spritzerDetections: fakeSpritzer(known.spritzers ?? aiSnapshot.spritzers),
    garlandDetections: fakeGarland(known.garland ?? aiSnapshot.garland),
  };

  return { seed, final };
}
