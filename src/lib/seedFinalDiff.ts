// #8 Stage C (C1) — the "learn from your own mistakes" signal.
//
// Stage A captures BOTH the AI's first-pass analysis (original_analysis /
// seed_analysis) AND the staff's corrected final scene, but the few-shot only
// ever showed the model the FINAL answer. This builds a compact "you guessed X,
// staff shipped Y" note from that seed→final pair so each design example teaches
// the correction, not just the destination.
//
// It compares COUNTS + FOOTAGES ONLY (never coordinates), so it is immune to the
// seed-vs-final coordinate-scale drift (the seed may be 0-1 or 0-1000; the final
// comes from a different pipeline). Both sides are already in the analyzer's own
// vocabulary — the seed is a raw PhotoAnalysisResult and the final is the scene
// converted by sceneToFewShotPieces — so this is an apples-to-apples comparison
// of what the analyzer can actually express.

import type {
  MiniLightDetection,
  WreathDetection,
  SpritzerDetection,
  GarlandDetection,
} from './photoAnalysis';

// The corrected (staff-final) side of the comparison, already in analyzer
// vocabulary. Footages come from the priced inputs; detections from
// sceneToFewShotPieces. Satellite footages are present only when the example
// actually teaches a satellite image (else undefined → skipped).
export type SeedFinalFinal = {
  santasFootage: number;
  gingerbreadFootage: number;
  santasDifficulty: 'easy' | 'medium' | 'hard';
  gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
  garlandDetections: GarlandDetection[];
  satelliteSantasFootage?: number;
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// Sum of stringCount across a (possibly malformed) detection array.
function totalStrings(dets: unknown[]): number {
  return dets.reduce<number>((s, d) => s + num((d as { stringCount?: unknown })?.stringCount), 0);
}

/**
 * Build the seed→final teaching note for a captured design example, or null
 * when there is no seed to learn from (older / fully-manual designs).
 */
export function summarizeSeedFinalDiff(
  seed: Record<string, unknown> | null | undefined,
  final: SeedFinalFinal,
): string | null {
  if (!seed || typeof seed !== 'object') return null;

  const parts: string[] = [];

  // Roofline footage (front = Santa's, ridge+sides = Gingerbread).
  const seedSantas = Math.round(num(seed.santasFootage));
  const finalSantas = Math.round(num(final.santasFootage));
  if (seedSantas !== finalSantas) parts.push(`front footage ${seedSantas}→${finalSantas}ft`);

  const seedGinger = Math.round(num(seed.gingerbreadFootage));
  const finalGinger = Math.round(num(final.gingerbreadFootage));
  if (seedGinger !== finalGinger) parts.push(`ridge+sides footage ${seedGinger}→${finalGinger}ft`);

  // Difficulty tiers.
  if (typeof seed.santasDifficulty === 'string' && seed.santasDifficulty !== final.santasDifficulty) {
    parts.push(`front difficulty ${seed.santasDifficulty}→${final.santasDifficulty}`);
  }
  if (typeof seed.gingerbreadDifficulty === 'string' && seed.gingerbreadDifficulty !== final.gingerbreadDifficulty) {
    parts.push(`ridge+sides difficulty ${seed.gingerbreadDifficulty}→${final.gingerbreadDifficulty}`);
  }

  // Mini lights — phantom/missed items show in the count; string-count
  // overrides show in the strand total. Report whichever moved.
  const seedMini = asArray(seed.miniLightDetections);
  const seedMiniCount = seedMini.length;
  const finalMiniCount = final.miniLightDetections.length;
  const seedStrings = totalStrings(seedMini);
  const finalStrings = totalStrings(final.miniLightDetections);
  if (seedMiniCount !== finalMiniCount) {
    parts.push(`mini-light items ${seedMiniCount}→${finalMiniCount} (strings ${seedStrings}→${finalStrings})`);
  } else if (seedStrings !== finalStrings) {
    parts.push(`mini-light strings ${seedStrings}→${finalStrings}`);
  }

  // Wreaths / spritzers / garland — counts.
  const seedWreaths = asArray(seed.wreathDetections).length;
  if (seedWreaths !== final.wreathDetections.length) {
    parts.push(`wreaths ${seedWreaths}→${final.wreathDetections.length}`);
  }
  const seedSpritzers = asArray(seed.spritzerDetections).length;
  if (seedSpritzers !== final.spritzerDetections.length) {
    parts.push(`spritzers ${seedSpritzers}→${final.spritzerDetections.length}`);
  }
  const seedGarland = asArray(seed.garlandDetections).length;
  if (seedGarland !== final.garlandDetections.length) {
    parts.push(`garland runs ${seedGarland}→${final.garlandDetections.length}`);
  }

  // Satellite front footage — only when this example actually teaches satellite
  // (orientation flips + tracing are the weakest area; surfacing the delta helps).
  if (typeof final.satelliteSantasFootage === 'number') {
    const seedSat = Math.round(num(seed.satelliteSantasFootage));
    const finalSat = Math.round(num(final.satelliteSantasFootage));
    if (seedSat !== finalSat) parts.push(`satellite front footage ${seedSat}→${finalSat}ft`);
  }

  if (parts.length === 0) {
    return 'Your first automated pass on this house already matched the staff-corrected ground truth below — this is the kind of house you read correctly.';
  }
  return `Your first automated pass on this house was corrected by staff: ${parts.join('; ')}. The JSON below is the staff-corrected ground truth — learn from these corrections.`;
}
