import { describe, it, expect } from 'vitest';
import {
  buildPermanentBom,
  puckCountForFeet,
  splitSetsAndSingles,
  trackSections,
  sizeTransformers,
  powerInjectionCount,
  boosterCount,
  extensionsForGaps,
  type PermanentBomInput,
} from './bom';

// A minimal single-front-run input; override per test.
function input(over: Partial<PermanentBomInput> = {}): PermanentBomInput {
  return {
    footageBySide: { front: 0, left: 0, right: 0, back: 0 },
    cornersBySide: { front: 0, left: 0, right: 0, back: 0 },
    trackStyle: 'single',
    trackColor: '9003',
    blackHousing: false,
    controllerToFirstLightFt: 0,
    gaps: [],
    ...over,
  };
}

const line = (bom: ReturnType<typeof buildPermanentBom>, sku: string) =>
  bom.lines.find((l) => l.sku === sku);

describe('permanent BOM — unit formulas', () => {
  it('puckCountForFeet: 8" OC = ceil(ft*1.5); guards non-positive', () => {
    expect(puckCountForFeet(0)).toBe(0);
    expect(puckCountForFeet(1)).toBe(2);
    expect(puckCountForFeet(100)).toBe(150);
    expect(puckCountForFeet(125)).toBe(188);
    expect(puckCountForFeet(-5)).toBe(0);
    expect(puckCountForFeet(NaN)).toBe(0);
  });

  it('splitSetsAndSingles: sets of 5 + remainder', () => {
    expect(splitSetsAndSingles(188)).toEqual({ sets5: 37, singles: 3 });
    expect(splitSetsAndSingles(150)).toEqual({ sets5: 30, singles: 0 });
    expect(splitSetsAndSingles(153)).toEqual({ sets5: 30, singles: 3 });
    expect(splitSetsAndSingles(0)).toEqual({ sets5: 0, singles: 0 });
  });

  it('trackSections: 40" sections + 6% waste', () => {
    expect(trackSections(0)).toBe(0);
    expect(trackSections(40)).toBe(13); // ceil(ceil(40/3.333)=12 * 1.06)=13
    expect(trackSections(100)).toBe(32);
    expect(trackSections(125)).toBe(41);
  });

  it('sizeTransformers: binds on pucks at ≤85% (350→255, 600→433); first is a KIT', () => {
    expect(sizeTransformers(0)).toEqual([]);
    expect(sizeTransformers(188)).toEqual([{ watts: 350, kit: true, lights: 188 }]);
    expect(sizeTransformers(255)).toEqual([{ watts: 350, kit: true, lights: 255 }]);
    expect(sizeTransformers(300)).toEqual([{ watts: 600, kit: true, lights: 300 }]); // 300>255 → one 600 ($433.75) beats 2×350
    // Min-cost, NOT greedy: 434/500 are just over one 600's 85% cap, but two 350s
    // (255+rest, $597.38) undercut a 600+350 set ($685.69).
    expect(sizeTransformers(434)).toEqual([
      { watts: 350, kit: true, lights: 255 },
      { watts: 350, kit: false, lights: 179 },
    ]);
    expect(sizeTransformers(500)).toEqual([
      { watts: 350, kit: true, lights: 255 },
      { watts: 350, kit: false, lights: 245 },
    ]);
    // 1050 (Andrew's 350-corner job) → 600+600+350 is cheapest here
    expect(sizeTransformers(1050)).toEqual([
      { watts: 600, kit: true, lights: 433 },
      { watts: 600, kit: false, lights: 433 },
      { watts: 350, kit: false, lights: 184 },
    ]);
  });

  it('powerInjectionCount: one per ~75 lights', () => {
    expect(powerInjectionCount(0)).toBe(0);
    expect(powerInjectionCount(75)).toBe(1);
    expect(powerInjectionCount(76)).toBe(2);
    expect(powerInjectionCount(150)).toBe(2);
    expect(powerInjectionCount(188)).toBe(3);
  });

  it('boosterCount: controller >10ft → 1; each gap >50ft → +1', () => {
    expect(boosterCount(input({ controllerToFirstLightFt: 12 }))).toBe(1);
    expect(boosterCount(input({ controllerToFirstLightFt: 5 }))).toBe(0);
    expect(boosterCount(input({ gaps: [{ lengthFt: 60 }, { lengthFt: 20 }] }))).toBe(1);
    expect(boosterCount(input({ controllerToFirstLightFt: 35, gaps: [{ lengthFt: 60 }] }))).toBe(2);
  });

  it('extensionsForGaps: smallest covering size; >50 combines; splitter counted', () => {
    expect(extensionsForGaps([{ lengthFt: 10 }, { lengthFt: 25, splitter: true }])).toEqual({
      extensions: [{ ft: 10, qty: 1 }, { ft: 25, qty: 1 }],
      splitters: 1,
    });
    expect(extensionsForGaps([{ lengthFt: 60 }])).toEqual({
      extensions: [{ ft: 10, qty: 1 }, { ft: 50, qty: 1 }],
      splitters: 0,
    });
    expect(extensionsForGaps([{ lengthFt: 3 }])).toEqual({ extensions: [{ ft: 3, qty: 1 }], splitters: 0 });
    expect(extensionsForGaps([{ lengthFt: 0 }])).toEqual({ extensions: [], splitters: 0 });
  });
});

describe('permanent BOM — buildPermanentBom', () => {
  it('corner rule: each corner = 3 singles (Andrew W: 350 corners → 1050 singles ≈ $4,040)', () => {
    // Andrew's degenerate all-corners entry validates the corner→3-singles rule
    // against his $4,043.08 sheet (diff = adapter + rounding).
    const bom = buildPermanentBom(input({ cornersBySide: { front: 350, left: 0, right: 0, back: 0 } }));
    expect(bom.totals.cornerSingles).toBe(1050);
    expect(line(bom, 'APL11012-1')!.qty).toBe(1050);
    expect(line(bom, 'APL11012-1')!.extCost).toBeCloseTo(4039.53, 1);
    expect(bom.totals.trackSections).toBe(0); // no footage → no track
  });

  it('zero footage/corners → empty-ish BOM, no divide-by-zero', () => {
    const bom = buildPermanentBom(input());
    expect(bom.totals.wholesaleCost).toBe(0);
    expect(bom.totals.costPerFt).toBe(0);
    expect(bom.lines).toHaveLength(0);
  });

  it('blackHousing swaps the -BLK light SKUs (same price)', () => {
    const bom = buildPermanentBom(input({ footageBySide: { front: 20, left: 0, right: 0, back: 0 }, blackHousing: true }));
    expect(line(bom, 'APL11012-5-BLK')).toBeTruthy();
    expect(line(bom, 'APL11012-5')).toBeFalsy();
  });

  it('parapet track uses the 90 SKU + flags a non-stock color', () => {
    const bom = buildPermanentBom(input({ footageBySide: { front: 40, left: 0, right: 0, back: 0 }, trackStyle: 'parapet', trackColor: '9012' }));
    expect(line(bom, 'APL11230-90-9012')).toBeTruthy();
    expect(bom.flags).toContain('parapet-track-only-stocked-white-or-black');
  });

  it('costOverrides replaces a SKU unit cost (P7/P8 live catalog path)', () => {
    const bom = buildPermanentBom(
      input({ footageBySide: { front: 20, left: 0, right: 0, back: 0 } }),
      new Map([['APL11012-5', 99]]),
    );
    expect(line(bom, 'APL11012-5')!.unitCost).toBe(99);
  });

  it('GOLDEN — Greg M 125ft single-white → ≈ $1,286.56 (sheet w/waste $1,290.81, ~0.3%)', () => {
    const bom = buildPermanentBom(
      input({
        footageBySide: { front: 125, left: 0, right: 0, back: 0 },
        gaps: [{ lengthFt: 10 }, { lengthFt: 10 }, { lengthFt: 25 }, { lengthFt: 25, splitter: true }],
      }),
    );
    expect(bom.totals.puckCount).toBe(188);
    expect(bom.totals.trackSections).toBe(41);
    expect(line(bom, 'APL11111-350-KIT')).toBeTruthy(); // one 350 KIT
    expect(bom.totals.wholesaleCost).toBeCloseTo(1286.56, 2);
    expect(bom.totals.wholesaleCost).toBeGreaterThan(1250);
    expect(bom.totals.wholesaleCost).toBeLessThan(1330); // ±3% of the $1,290.81 sheet
  });

  it('GOLDEN — Melissa North 100ft single-white, controller 35 → ≈ $1,107.22 (sheet $1,084–$1,126)', () => {
    const bom = buildPermanentBom(
      input({
        footageBySide: { front: 100, left: 0, right: 0, back: 0 },
        controllerToFirstLightFt: 35,
        gaps: [{ lengthFt: 10 }, { lengthFt: 10 }, { lengthFt: 25 }, { lengthFt: 25, splitter: true }],
      }),
    );
    expect(bom.totals.puckCount).toBe(150);
    expect(bom.totals.trackSections).toBe(32);
    expect(line(bom, 'APL11121')!.qty).toBe(1); // controller 35>10 → 1 booster
    expect(bom.totals.wholesaleCost).toBeCloseTo(1107.22, 2);
    expect(bom.totals.wholesaleCost).toBeLessThan(1160);
  });

  it('left+right footage sums into the light/track totals (sides billed together upstream)', () => {
    const bom = buildPermanentBom(input({ footageBySide: { front: 0, left: 50, right: 40, back: 60 } }));
    // per-side puck ceil: 75 + 60 + 90 = 225 lights
    expect(bom.totals.puckCount).toBe(225);
    expect(bom.totals.totalFt).toBe(150);
  });
});
