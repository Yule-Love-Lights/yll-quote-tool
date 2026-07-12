import { describe, it, expect } from 'vitest';
import {
  compareKnownVsAi,
  knownAiPairToSeedFinal,
  BIG_MISS_COUNT,
  BIG_MISS_FOOTAGE_FT,
  type AiSnapshot,
  type KnownNumbers,
} from './knownVsAi';
import { computeBiasSummary, FT_THRESHOLD, COUNT_THRESHOLD, MIN_STATS_PAIRS } from '../seedFinalStats';

const AI: AiSnapshot = {
  miniLights: 5,
  wreaths: 2,
  spritzers: 1,
  garland: 0,
  santasFootage: 40,
  gingerbreadFootage: 20,
};

describe('compareKnownVsAi', () => {
  it('returns [] when there is no aiSnapshot (Auto-Analyze never run)', () => {
    expect(compareKnownVsAi({ wreaths: 5 }, null)).toEqual([]);
    expect(compareKnownVsAi({ wreaths: 5 }, undefined)).toEqual([]);
  });

  it('returns [] when known is absent (byte-for-byte: nothing to score)', () => {
    expect(compareKnownVsAi(null, AI)).toEqual([]);
    expect(compareKnownVsAi(undefined, AI)).toEqual([]);
  });

  it('scores only the fields the operator actually filled in (partial known)', () => {
    const misses = compareKnownVsAi({ wreaths: 5 }, AI); // AI guessed 2 wreaths, off by 3
    expect(misses).toHaveLength(1);
    expect(misses[0]).toEqual({ type: 'wreaths', ai: 2, known: 5, big: true });
  });

  it('a count delta below COUNT_THRESHOLD is a match, not a miss', () => {
    // AI wreaths=2, known=2 → delta 0 < 0.5
    expect(compareKnownVsAi({ wreaths: 2 }, AI)).toEqual([]);
  });

  it('a count delta at/above COUNT_THRESHOLD but below BIG_MISS_COUNT is a small (non-big) miss', () => {
    // AI garland=0, known=1 → delta 1, >= COUNT_THRESHOLD(0.5), < BIG_MISS_COUNT(2)
    const misses = compareKnownVsAi({ garland: 1 }, AI);
    expect(misses).toEqual([{ type: 'garland', ai: 0, known: 1, big: false }]);
    expect(1).toBeGreaterThanOrEqual(COUNT_THRESHOLD);
    expect(1).toBeLessThan(BIG_MISS_COUNT);
  });

  it('a count delta at/above BIG_MISS_COUNT is flagged big', () => {
    // AI miniLights=5, known=7 → delta 2 === BIG_MISS_COUNT
    const misses = compareKnownVsAi({ miniLights: 7 }, AI);
    expect(misses).toEqual([{ type: 'miniLights', ai: 5, known: 7, big: true }]);
  });

  it('a footage delta below FT_THRESHOLD is a match', () => {
    // AI santasFootage=40, known=42 → delta 2 < FT_THRESHOLD(3)
    expect(compareKnownVsAi({ santasFootage: 42 }, AI)).toEqual([]);
  });

  it('a footage delta at/above FT_THRESHOLD but below BIG_MISS_FOOTAGE_FT is a small miss', () => {
    // AI santasFootage=40, known=45 → delta 5, >= FT_THRESHOLD(3), < BIG_MISS_FOOTAGE_FT(10)
    const misses = compareKnownVsAi({ santasFootage: 45 }, AI);
    expect(misses).toEqual([{ type: 'santasFootage', ai: 40, known: 45, big: false }]);
  });

  it('a footage delta at/above BIG_MISS_FOOTAGE_FT is flagged big', () => {
    // AI gingerbreadFootage=20, known=32 → delta 12 >= 10
    const misses = compareKnownVsAi({ gingerbreadFootage: 32 }, AI);
    expect(misses).toEqual([{ type: 'gingerbreadFootage', ai: 20, known: 32, big: true }]);
  });

  it('a field the AI never assessed (wwFootage/stakeFootage absent from aiSnapshot) is never scored, even when known has it', () => {
    // AI snapshot has no wwFootage/stakeFootage at all (analyzer doesn't return them).
    const misses = compareKnownVsAi({ wwFootage: 100, stakeFootage: 50 }, AI);
    expect(misses).toEqual([]);
  });

  it('scores multiple filled-in fields together, preserving big-four-then-footage order', () => {
    const known: KnownNumbers = { miniLights: 8, wreaths: 2, santasFootage: 60 };
    const misses = compareKnownVsAi(known, AI);
    expect(misses.map((m) => m.type)).toEqual(['miniLights', 'santasFootage']);
  });

  it('handles a fully-matching known/aiSnapshot pair (no misses)', () => {
    const known: KnownNumbers = {
      miniLights: 5, wreaths: 2, spritzers: 1, garland: 0, santasFootage: 40, gingerbreadFootage: 20,
    };
    expect(compareKnownVsAi(known, AI)).toEqual([]);
  });
});

describe('knownAiPairToSeedFinal + computeBiasSummary fold-in math', () => {
  it('produces a seed/final pair whose metrics match the raw known/aiSnapshot counts', () => {
    const known: KnownNumbers = { miniLights: 8, wreaths: 4 };
    const pair = knownAiPairToSeedFinal(known, AI);
    expect(pair.seed).toMatchObject({ santasFootage: 40, gingerbreadFootage: 20 });
    expect((pair.seed as { miniLightDetections: unknown[] }).miniLightDetections).toHaveLength(5); // AI's guess
    expect(pair.final.miniLightDetections).toHaveLength(8); // known truth
    expect(pair.final.wreathDetections).toHaveLength(4);
    // Fields the operator never recorded fall back to the AI's own guess (0 delta).
    expect(pair.final.spritzerDetections).toHaveLength(AI.spritzers);
    expect(pair.final.garlandDetections).toHaveLength(AI.garland);
    expect(pair.final.santasFootage).toBe(AI.santasFootage);
    expect(pair.final.gingerbreadFootage).toBe(AI.gingerbreadFootage);
  });

  it('folds into computeBiasSummary like any other seed/final pair (reaches MIN_STATS_PAIRS, produces a real average)', () => {
    // 5 identical houses where the operator always says 3 more mini-light
    // items than the AI guessed — computeBiasSummary should read that back
    // as a systematic +3 miniItems delta.
    const pairs = Array.from({ length: MIN_STATS_PAIRS }, () =>
      knownAiPairToSeedFinal({ miniLights: AI.miniLights + 3 }, AI));
    const summary = computeBiasSummary(pairs);
    expect(summary).not.toBeNull();
    expect(summary!.n).toBe(MIN_STATS_PAIRS);
    expect(summary!.deltas.miniItems).toBeCloseTo(3);
    // Untouched metrics (operator never recorded them) contribute a 0 delta.
    expect(summary!.deltas.wreaths).toBeCloseTo(0);
  });

  it('below MIN_STATS_PAIRS still returns null (unchanged corpus-size gate)', () => {
    const pairs = Array.from({ length: MIN_STATS_PAIRS - 1 }, () =>
      knownAiPairToSeedFinal({ miniLights: AI.miniLights + 3 }, AI));
    expect(computeBiasSummary(pairs)).toBeNull();
  });
});

// Sanity check that the comparator really does reuse seedFinalStats.ts's own
// constants, not a re-typed copy that could silently drift.
describe('threshold reuse', () => {
  it('FT_THRESHOLD/COUNT_THRESHOLD match the documented values', () => {
    expect(FT_THRESHOLD).toBe(3);
    expect(COUNT_THRESHOLD).toBe(0.5);
  });

  it('BIG_MISS_COUNT/BIG_MISS_FOOTAGE_FT match the documented big-miss bars', () => {
    expect(BIG_MISS_COUNT).toBe(2);
    expect(BIG_MISS_FOOTAGE_FT).toBe(10);
  });
});
