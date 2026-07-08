import { describe, it, expect } from 'vitest';
import {
  sizeJumpExtensions,
  deriveSatelliteCutsAndJumps,
  deriveStreetPeakCuts,
  deriveTrackAccessories,
  hasAccessorySignal,
  type SatLinesBySide,
} from './trackAccessories';

const emptySides = (): SatLinesBySide => ({ front: [], left: [], right: [], back: [] });

// 0.1 ft/px on the 640px satellite → 1 normalized unit = 64 ft; aspect 1.
const FPP = 0.1;
const FT = (f: number) => f / (640 * FPP); // feet → normalized distance

describe('sizeJumpExtensions — the locked Jason S24 ladder', () => {
  it('sizes generously per the ladder', () => {
    expect(sizeJumpExtensions(0)).toEqual([]);
    expect(sizeJumpExtensions(2)).toEqual([5]); // 3' reaches → order 5'
    expect(sizeJumpExtensions(3)).toEqual([5]);
    expect(sizeJumpExtensions(4)).toEqual([10]); // 5' reaches → order 10'
    expect(sizeJumpExtensions(5)).toEqual([10]);
    expect(sizeJumpExtensions(8)).toEqual([5, 10]); // "if a 10 reaches order 10+5"
    expect(sizeJumpExtensions(10)).toEqual([5, 10]);
    expect(sizeJumpExtensions(18)).toEqual([5, 25]); // 25 reaches → 25+5
    expect(sizeJumpExtensions(25)).toEqual([5, 25]);
    expect(sizeJumpExtensions(30)).toEqual([5, 5, 25]); // chain 25+5 covers, +5 slack
    expect(sizeJumpExtensions(60)).toEqual([5, 10, 25, 25]); // 25+25+10 + 5 slack
  });
});

describe('deriveSatelliteCutsAndJumps', () => {
  it('every interior vertex of a drawn side line is a cut; endpoints are not', () => {
    const lines = emptySides();
    // An L-shaped front (3 points → 1 interior vertex) + a straight left (2 points → 0).
    lines.front = [{ points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]] }];
    lines.left = [{ points: [[0.6, 0.1], [0.9, 0.1]] }];
    const r = deriveSatelliteCutsAndJumps(lines, FPP, 1);
    expect(r.cuts).toBe(1);
    expect(r.jumpsFt).toEqual([]);
  });

  it('adjacent side endpoints (≤2 ft) form a side-transition cut', () => {
    const lines = emptySides();
    // Front ends at (0.5, 0.1); left starts 1 ft away (FT(1) ≈ 0.0156).
    lines.front = [{ points: [[0.1, 0.1], [0.5, 0.1]] }];
    lines.left = [{ points: [[0.5 + FT(1), 0.1], [0.5 + FT(1), 0.4]] }];
    const r = deriveSatelliteCutsAndJumps(lines, FPP, 1);
    expect(r.cuts).toBe(1); // the junction; no interior vertices
  });

  it('two separated runs on ONE side chain through a measured jump', () => {
    const lines = emptySides();
    // Two front runs whose nearest endpoints are 8 ft apart (a garage jog).
    lines.front = [
      { points: [[0.1, 0.1], [0.3, 0.1]] },
      { points: [[0.3 + FT(8), 0.1], [0.6, 0.1]] },
    ];
    const r = deriveSatelliteCutsAndJumps(lines, FPP, 1);
    expect(r.cuts).toBe(0);
    expect(r.jumpsFt).toHaveLength(1);
    expect(r.jumpsFt[0]).toBeCloseTo(8, 5);
  });

  it('with NO satellite scale, only interior vertices count (no guessed links)', () => {
    const lines = emptySides();
    lines.front = [
      { points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]] }, // 1 interior vertex
      { points: [[0.35, 0.1], [0.6, 0.1]] },
    ];
    const r = deriveSatelliteCutsAndJumps(lines, null, 1);
    expect(r.cuts).toBe(1);
    expect(r.jumpsFt).toEqual([]);
  });

  it('aspect correction applies to vertical link distances', () => {
    const lines = emptySides();
    // Vertical Δy 0.05 on a 2:1 image → 0.025 normalized → 1.6 ft (≤2 → cut).
    lines.front = [{ points: [[0.1, 0.1], [0.4, 0.1]] }];
    lines.left = [{ points: [[0.4, 0.15], [0.4, 0.5]] }];
    const r = deriveSatelliteCutsAndJumps(lines, FPP, 2);
    expect(r.cuts).toBe(1);
  });
});

describe('deriveStreetPeakCuts — elevation cuts only (satellite owns plan corners)', () => {
  it("a gable = 3 cuts (up-transition, apex, down-transition) — Jason's example", () => {
    // flat → rake up → rake down → flat (scene px; y up = smaller).
    const strand = { points: [0, 100, 100, 100, 150, 40, 200, 100, 300, 100] };
    expect(deriveStreetPeakCuts([strand])).toBe(3);
  });

  it('a flat∧flat vertex (plan corner in elevation) is skipped', () => {
    const strand = { points: [0, 100, 100, 100, 200, 104] }; // slight jitter stays flat
    expect(deriveStreetPeakCuts([strand])).toBe(0);
  });

  it('a dead-end rake (no continuation) contributes its transitions only', () => {
    // flat → rake up, line ENDS at the apex: 1 interior vertex (the transition).
    const strand = { points: [0, 100, 100, 100, 150, 40] };
    expect(deriveStreetPeakCuts([strand])).toBe(1);
  });
});

describe('deriveTrackAccessories — the card counts', () => {
  it('cuts land on the 5\' row; jumps size via the ladder; long jumps add boosters', () => {
    const lines = emptySides();
    lines.front = [
      { points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]] }, // 1 cut
      { points: [[0.3 + FT(8), 0.3], [0.6, 0.3]] }, // 8 ft jump → 10+5
    ];
    const acc = deriveTrackAccessories({
      satelliteLines: lines,
      satelliteFeetPerPixel: FPP,
      satelliteAspect: 1,
      extras: { splitters: 2, jumpsFt: [60] }, // AI extras: 60ft jump → 25+25+10+5 + booster
    });
    expect(acc).toEqual({
      e3: 0,
      e5: 3, // 1 cut + the 8ft jump's 5 + the 60ft jump's slack 5
      e10: 2, // 8ft jump's 10 + 60ft chain's 10
      e25: 2, // 60ft chain
      splitters: 2,
      jumpBoosters: 1, // only the 60ft jump exceeds 50
    });
  });

  it('street peak cuts add to the 5\' row alongside satellite cuts', () => {
    const lines = emptySides();
    lines.front = [{ points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.4]] }]; // 1 plan cut
    const gable = { points: [0, 100, 100, 100, 150, 40, 200, 100, 300, 100] }; // 3 cuts
    const acc = deriveTrackAccessories({
      satelliteLines: lines,
      satelliteFeetPerPixel: FPP,
      satelliteAspect: 1,
      streetStrandPoints: [gable],
    });
    expect(acc.e5).toBe(4);
    expect(acc.splitters).toBe(0);
  });
});

describe('hasAccessorySignal', () => {
  it('false on a blank quote; true once a satellite line or street strand exists', () => {
    expect(hasAccessorySignal(emptySides())).toBe(false);
    expect(hasAccessorySignal(emptySides(), [{ points: [0, 0] }])).toBe(false); // 1 point = not a strand
    expect(hasAccessorySignal(emptySides(), [{ points: [0, 0, 10, 10] }])).toBe(true);
    const lines = emptySides();
    lines.back = [{ points: [[0.1, 0.1], [0.2, 0.2]] }];
    expect(hasAccessorySignal(lines)).toBe(true);
  });
});
