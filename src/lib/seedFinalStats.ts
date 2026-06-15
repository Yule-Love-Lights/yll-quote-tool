// #8 Stage C (C2) — corpus-wide systematic-bias calibration.
//
// Where C1 (seedFinalDiff) teaches a per-example correction, C2 aggregates the
// seed→final deltas across the WHOLE corpus into a short "you systematically
// tend to X" note injected into the analyzer's system prompt — so the model
// self-corrects its average bias even on a house unlike any single example.
//
// Pure + count/footage-only (coordinate-free), like seedFinalDiff. Returns null
// until there are enough seeded pairs to claim a tendency (MIN_STATS_PAIRS), so
// a tiny/fresh corpus emits nothing rather than noise from one or two houses.

import type { SeedFinalFinal } from './seedFinalDiff';

// Minimum seeded pairs before we'll claim a "tendency" (avoid noise from a tiny
// sample). Tunable.
export const MIN_STATS_PAIRS = 5;

// Below these absolute mean deltas, a metric is treated as "no systematic bias"
// and produces no guidance line. Tunable.
const FT_THRESHOLD = 3; // feet
const COUNT_THRESHOLD = 0.5; // items per house
const STRING_THRESHOLD = 1; // strands per house

type Metrics = {
  santasFootage: number;
  gingerbreadFootage: number;
  miniItems: number;
  miniStrings: number;
  wreaths: number;
  spritzers: number;
  garland: number;
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function len(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}
function strings(v: unknown): number {
  return Array.isArray(v)
    ? v.reduce<number>((s, d) => s + num((d as { stringCount?: unknown })?.stringCount), 0)
    : 0;
}

function seedMetrics(seed: Record<string, unknown>): Metrics {
  return {
    santasFootage: num(seed.santasFootage),
    gingerbreadFootage: num(seed.gingerbreadFootage),
    miniItems: len(seed.miniLightDetections),
    miniStrings: strings(seed.miniLightDetections),
    wreaths: len(seed.wreathDetections),
    spritzers: len(seed.spritzerDetections),
    garland: len(seed.garlandDetections),
  };
}

function finalMetrics(f: SeedFinalFinal): Metrics {
  return {
    santasFootage: num(f.santasFootage),
    gingerbreadFootage: num(f.gingerbreadFootage),
    miniItems: f.miniLightDetections.length,
    miniStrings: f.miniLightDetections.reduce((s, d) => s + num(d.stringCount), 0),
    wreaths: f.wreathDetections.length,
    spritzers: f.spritzerDetections.length,
    garland: f.garlandDetections.length,
  };
}

export type SeedFinalPair = { seed: Record<string, unknown> | null | undefined; final: SeedFinalFinal };

export type BiasSummary = {
  n: number;
  // mean(final - seed) per metric. POSITIVE = AI under-produced (staff added on
  // top) → the AI under-measures / misses; NEGATIVE = AI over-produced.
  deltas: Metrics;
};

// PURE: aggregate the mean signed delta per metric across all seeded pairs.
// Pairs without a seed are ignored. Returns null below MIN_STATS_PAIRS.
export function computeBiasSummary(pairs: SeedFinalPair[]): BiasSummary | null {
  const seeded = pairs.filter((p) => p.seed && typeof p.seed === 'object');
  if (seeded.length < MIN_STATS_PAIRS) return null;

  const acc: Metrics = {
    santasFootage: 0, gingerbreadFootage: 0, miniItems: 0, miniStrings: 0, wreaths: 0, spritzers: 0, garland: 0,
  };
  for (const p of seeded) {
    const s = seedMetrics(p.seed as Record<string, unknown>);
    const f = finalMetrics(p.final);
    acc.santasFootage += f.santasFootage - s.santasFootage;
    acc.gingerbreadFootage += f.gingerbreadFootage - s.gingerbreadFootage;
    acc.miniItems += f.miniItems - s.miniItems;
    acc.miniStrings += f.miniStrings - s.miniStrings;
    acc.wreaths += f.wreaths - s.wreaths;
    acc.spritzers += f.spritzers - s.spritzers;
    acc.garland += f.garland - s.garland;
  }
  const n = seeded.length;
  return {
    n,
    deltas: {
      santasFootage: acc.santasFootage / n,
      gingerbreadFootage: acc.gingerbreadFootage / n,
      miniItems: acc.miniItems / n,
      miniStrings: acc.miniStrings / n,
      wreaths: acc.wreaths / n,
      spritzers: acc.spritzers / n,
      garland: acc.garland / n,
    },
  };
}

// PURE: render the bias summary as a system-prompt calibration block (begins
// with \n\n so it appends cleanly), or null when there's no summary or every
// metric is within its noise threshold.
export function formatBiasNote(summary: BiasSummary | null): string | null {
  if (!summary) return null;
  const { deltas } = summary;
  const lines: string[] = [];

  const ftLine = (label: string, d: number) => {
    if (Math.abs(d) < FT_THRESHOLD) return;
    lines.push(
      d > 0
        ? `- You tend to UNDER-measure ${label} by ~${Math.round(d)}ft — measure a bit longer.`
        : `- You tend to OVER-measure ${label} by ~${Math.round(Math.abs(d))}ft — measure a bit shorter.`,
    );
  };
  ftLine("front (Santa's) roofline", deltas.santasFootage);
  ftLine('ridge+sides (Gingerbread) roofline', deltas.gingerbreadFootage);

  const countLine = (noun: string, d: number) => {
    if (Math.abs(d) < COUNT_THRESHOLD) return;
    lines.push(
      d > 0
        ? `- You tend to MISS ~${d.toFixed(1)} ${noun} per house — look harder for them.`
        : `- You tend to OVER-suggest ~${Math.abs(d).toFixed(1)} ${noun} per house — be more conservative.`,
    );
  };
  countLine('mini-light items (bushes/trees/columns)', deltas.miniItems);
  countLine('wreath placements', deltas.wreaths);
  countLine('spritzer stakes', deltas.spritzers);
  countLine('garland runs', deltas.garland);

  if (Math.abs(deltas.miniStrings) >= STRING_THRESHOLD) {
    lines.push(
      deltas.miniStrings > 0
        ? `- Your mini-light STRING counts run ~${deltas.miniStrings.toFixed(1)} low per house — estimate more strands.`
        : `- Your mini-light STRING counts run ~${Math.abs(deltas.miniStrings).toFixed(1)} high per house — estimate fewer strands.`,
    );
  }

  if (lines.length === 0) return null;
  return `\n\nCALIBRATION FROM YOUR PAST WORK (based on ${summary.n} of this company's houses where your first pass was corrected by staff): your estimates have shown these systematic tendencies — correct for them on this house:\n${lines.join('\n')}`;
}
