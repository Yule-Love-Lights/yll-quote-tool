import { describe, it, expect } from 'vitest';
import {
  buildPermanentBom,
  puckCountForFeet,
  splitSetsAndSingles,
  trackSections,
  sizeTransformers,
  powerInjectionCount,
  boosterCount,
  bucketExtensionLength,
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

  it('boosterCount: controller >10ft → 1; each legacy gap >50ft → +1', () => {
    expect(boosterCount(input({ controllerToFirstLightFt: 12 }))).toBe(1);
    expect(boosterCount(input({ controllerToFirstLightFt: 5 }))).toBe(0);
    expect(boosterCount(input({ gaps: [{ lengthFt: 60 }, { lengthFt: 20 }] }))).toBe(1);
    expect(boosterCount(input({ controllerToFirstLightFt: 35, gaps: [{ lengthFt: 60 }] }))).toBe(2);
  });

  it('boosterCount (#140): the accessories override supplies jump boosters; gaps are ignored', () => {
    const acc = { extensions: { e3: 0, e5: 0, e10: 0, e25: 0 }, splitters: 0, jumpBoosters: 2 };
    expect(boosterCount(input({ accessories: acc, gaps: [{ lengthFt: 60 }] }))).toBe(2); // NOT 3
    expect(boosterCount(input({ controllerToFirstLightFt: 35, accessories: acc }))).toBe(3); // ctrl rule stacks
    expect(boosterCount(input({ accessories: { ...acc, jumpBoosters: 0 }, gaps: [{ lengthFt: 60 }] }))).toBe(0);
  });

  it('bucketExtensionLength (#140): the Jason S24 chaining rules, exhaustively', () => {
    expect(bucketExtensionLength(0)).toEqual([]);
    expect(bucketExtensionLength(-4)).toEqual([]);
    expect(bucketExtensionLength(Number.NaN)).toEqual([]);
    expect(bucketExtensionLength(2)).toEqual([3]);
    expect(bucketExtensionLength(3)).toEqual([3]);
    expect(bucketExtensionLength(4)).toEqual([5]);
    expect(bucketExtensionLength(7)).toEqual([10]);
    expect(bucketExtensionLength(10)).toEqual([10]);
    expect(bucketExtensionLength(12)).toEqual([3, 10]); // 10 + ≤5 remainder
    expect(bucketExtensionLength(15)).toEqual([5, 10]); // "15 = 10+5"
    expect(bucketExtensionLength(20)).toEqual([25]); // (15,25] → single 25
    expect(bucketExtensionLength(25)).toEqual([25]);
    expect(bucketExtensionLength(30)).toEqual([5, 25]); // "30 = 25+5"
    expect(bucketExtensionLength(60)).toEqual([10, 25, 25]); // "60 = 25+25+10"
    expect(bucketExtensionLength(105)).toEqual([5, 25, 25, 25, 25]); // 100 + 5
  });

  it('extensionsForGaps (#140 sizes): smallest covering size from 3/5/10/25; >25 chains 25s; splitter counted', () => {
    expect(extensionsForGaps([{ lengthFt: 10 }, { lengthFt: 25, splitter: true }])).toEqual({
      extensions: [{ ft: 10, qty: 1 }, { ft: 25, qty: 1 }],
      splitters: 1,
    });
    // 50s are gone (Jason S24: "issues in the past") — 60 chains 25+25+10.
    expect(extensionsForGaps([{ lengthFt: 60 }])).toEqual({
      extensions: [{ ft: 10, qty: 1 }, { ft: 25, qty: 2 }],
      splitters: 0,
    });
    // 15 = 10 + 5 (no 15' SKU); 30 = 25 + 5.
    expect(extensionsForGaps([{ lengthFt: 15 }])).toEqual({
      extensions: [{ ft: 5, qty: 1 }, { ft: 10, qty: 1 }],
      splitters: 0,
    });
    expect(extensionsForGaps([{ lengthFt: 30 }])).toEqual({
      extensions: [{ ft: 5, qty: 1 }, { ft: 25, qty: 1 }],
      splitters: 0,
    });
    // (15, 25] takes the single 25 — overshoot beats a 3-piece chain.
    expect(extensionsForGaps([{ lengthFt: 20 }])).toEqual({ extensions: [{ ft: 25, qty: 1 }], splitters: 0 });
    expect(extensionsForGaps([{ lengthFt: 3 }])).toEqual({ extensions: [{ ft: 3, qty: 1 }], splitters: 0 });
    expect(extensionsForGaps([{ lengthFt: 0 }])).toEqual({ extensions: [], splitters: 0 });
  });

  it('buildPermanentBom (#140): card accessories override the gaps path for extensions + splitters', () => {
    const bom = buildPermanentBom(
      input({
        footageBySide: { front: 50, left: 0, right: 0, back: 0 },
        gaps: [{ lengthFt: 60, splitter: true }], // would give 25×2+10 + 1 splitter
        accessories: {
          extensions: { e3: 2, e5: 1, e10: 0, e25: 4 },
          splitters: 3,
          jumpBoosters: 1,
        },
      }),
    );
    expect(line(bom, 'APL11312-3')!.qty).toBe(2);
    expect(line(bom, 'APL11312-5')!.qty).toBe(1);
    expect(line(bom, 'APL11312-10')).toBeFalsy(); // zero count → no line
    expect(line(bom, 'APL11312-25')!.qty).toBe(4);
    expect(line(bom, 'APL11122')!.qty).toBe(3); // card splitters, not the gap's 1
    expect(line(bom, 'APL11121')!.qty).toBe(1); // card jumpBoosters, not the gap's >50 rule
  });

  it('buildPermanentBom (#140): NO accessories → the legacy gaps path still orders', () => {
    const bom = buildPermanentBom(
      input({
        footageBySide: { front: 50, left: 0, right: 0, back: 0 },
        gaps: [{ lengthFt: 60, splitter: true }],
      }),
    );
    expect(line(bom, 'APL11312-25')!.qty).toBe(2);
    expect(line(bom, 'APL11312-10')!.qty).toBe(1);
    expect(line(bom, 'APL11122')!.qty).toBe(1);
    expect(line(bom, 'APL11121')!.qty).toBe(1); // 60ft gap > 50 → legacy jump booster
  });
});

describe('permanent BOM — buildPermanentBom', () => {
  it('corner rule: each corner = 3 singles (Andrew W: 350 corners → 1050 singles, ordered w/6% waste)', () => {
    // Andrew's degenerate all-corners entry validates the corner→3-singles rule
    // against his $4,043.08 sheet (diff = adapter + rounding). #144: the ORDER
    // qty carries the 6% waste — ceil(1050 × 1.06) = 1113; totals still report
    // the raw 1050 corner singles.
    const bom = buildPermanentBom(input({ cornersBySide: { front: 350, left: 0, right: 0, back: 0 } }));
    expect(bom.totals.cornerSingles).toBe(1050);
    expect(line(bom, 'APL11012-1')!.qty).toBe(1113);
    expect(line(bom, 'APL11012-1')!.extCost).toBeCloseTo(4281.9, 1);
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

  it('GOLDEN — Greg M 125ft single-white → ≈ $1,391.11 (sheet w/waste $1,290.81 + the #144 rules)', () => {
    // Re-anchored S25 (#144): the pre-#144 tool total was $1,286.56 (~0.3% off
    // the sheet's $1,290.81). The reconciliation added, on this job exactly:
    // light waste 6% (sets 37→40, singles 3→4, +$50.40) + the spare injector
    // (+$5.85) + injection wire 210 ft @ $0.23 (+$48.30) = +$104.55 → $1,391.11.
    const bom = buildPermanentBom(
      input({
        footageBySide: { front: 125, left: 0, right: 0, back: 0 },
        gaps: [{ lengthFt: 10 }, { lengthFt: 10 }, { lengthFt: 25 }, { lengthFt: 25, splitter: true }],
      }),
    );
    expect(bom.totals.puckCount).toBe(188);
    expect(bom.totals.trackSections).toBe(41);
    expect(line(bom, 'APL11111-350-KIT')).toBeTruthy(); // one 350 KIT
    expect(line(bom, 'APL11123')!.qty).toBe(4); // ceil(188/75)=3 installed + 1 spare
    expect(line(bom, 'APL-WIRE-16-2')!.qty).toBe(210); // (4-1)×70 ft
    expect(bom.totals.wholesaleCost).toBeCloseTo(1391.11, 2);
  });

  it('GOLDEN — Melissa North 100ft single-white, controller 35 → ≈ $1,191.62 (sheet $1,084–$1,126 + the #144 rules)', () => {
    // Re-anchored S25 (#144): pre-#144 total $1,107.22. Added on this job:
    // light waste (sets 30→32, +$31.03) + spare injector (+$5.85) + wire
    // 140 ft (+$32.20) + the controller-run feed bucketed 35 ft → 25'+10'
    // (+$15.32) = +$84.40 → $1,191.62.
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
    expect(line(bom, 'APL11312-25')!.qty).toBe(3); // 2 from gaps + 1 controller feed
    expect(line(bom, 'APL11312-10')!.qty).toBe(3); // 2 from gaps + 1 controller feed
    expect(bom.totals.wholesaleCost).toBeCloseTo(1191.62, 2);
  });

  it('#144: light sets pack PER SIDE — a 5-strip never crosses a run break', () => {
    // Two 12-ft sides: 18 pucks each → 3 sets + 3 singles PER SIDE (pooled
    // packing would have said 7 sets + 1 single). Ordered w/6% waste:
    // sets ceil(6×1.06)=7, singles ceil(6×1.06)=7.
    const bom = buildPermanentBom(input({ footageBySide: { front: 12, left: 12, right: 0, back: 0 } }));
    expect(line(bom, 'APL11012-5')!.qty).toBe(7);
    expect(line(bom, 'APL11012-1')!.qty).toBe(7);
  });

  it('#144: injector spare + wire line + provisional flag; absent on a zero job', () => {
    const bom = buildPermanentBom(input({ footageBySide: { front: 100, left: 0, right: 0, back: 0 } }));
    expect(line(bom, 'APL11123')!.qty).toBe(3); // ceil(150/75)=2 installed + 1 spare
    expect(line(bom, 'APL11123')!.description).toContain('spare');
    expect(line(bom, 'APL-WIRE-16-2')!.qty).toBe(140); // (3-1)×70
    expect(bom.flags).toContain('verify-injection-wire-sku-and-price-with-ascend');

    const empty = buildPermanentBom(input());
    expect(line(empty, 'APL11123')).toBeFalsy();
    expect(line(empty, 'APL-WIRE-16-2')).toBeFalsy();
    expect(empty.flags).not.toContain('verify-injection-wire-sku-and-price-with-ascend');
  });

  it('#144: the controller-run feed is ADDITIVE on the card-override path too', () => {
    const bom = buildPermanentBom(
      input({
        footageBySide: { front: 50, left: 0, right: 0, back: 0 },
        controllerToFirstLightFt: 30, // buckets to 25'+5'
        accessories: { extensions: { e3: 0, e5: 2, e10: 0, e25: 1 }, splitters: 0, jumpBoosters: 0 },
      }),
    );
    expect(line(bom, 'APL11312-5')!.qty).toBe(3); // card 2 + controller 1
    expect(line(bom, 'APL11312-25')!.qty).toBe(2); // card 1 + controller 1
  });

  it('#125-4: consolidates duplicate bare power supplies into one Qty-N line', () => {
    // 800 ft → 1200 pucks → sizeTransformers picks 3×600 (one KIT + two bare).
    // The two bare 600W supplies must collapse into a single APL11110-600 Qty-2
    // line — else the printed order sheet lists the SKU on multiple Qty-1 rows
    // (and the print page's `key={l.sku}` collides on duplicate keys).
    const bom = buildPermanentBom(input({ footageBySide: { front: 800, left: 0, right: 0, back: 0 } }));
    const bare600 = bom.lines.filter((l) => l.sku === 'APL11110-600');
    expect(bare600).toHaveLength(1);
    expect(bare600[0]!.qty).toBe(2);
    // Every BOM line has a UNIQUE sku (safe as a stable React key on the sheet).
    const skus = bom.lines.map((l) => l.sku);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it('left+right footage sums into the light/track totals (sides billed together upstream)', () => {
    const bom = buildPermanentBom(input({ footageBySide: { front: 0, left: 50, right: 40, back: 60 } }));
    // per-side puck ceil: 75 + 60 + 90 = 225 lights
    expect(bom.totals.puckCount).toBe(225);
    expect(bom.totals.totalFt).toBe(150);
  });
});
