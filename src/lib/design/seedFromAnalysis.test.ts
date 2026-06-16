import { describe, it, expect } from 'vitest';
import {
  seedSceneFromAnalysis,
  sanitizeAnalysisSeed,
  analysisSeedHasContent,
  countSeededItems,
  AnalysisSeed,
} from './seedFromAnalysis';
import type { Scene, StrandItem, MiniAreaItem, WreathItem, SpritzerItem, GarlandItem } from './sceneTypes';
import { isStrand, isWreath, isSpritzer, isGarland, isMiniArea } from './sceneTypes';

const W = 1000;
const H = 500;

function emptyScene(): Scene {
  return { yardsticks: [], items: [] };
}

const FULL_SEED: AnalysisSeed = {
  lines: {
    santas: [
      [
        [0.1, 0.4],
        [0.9, 0.4],
      ],
    ],
  },
  detections: {
    miniLights: [
      { type: 'bush', wrapStyle: 'canopy', stringCount: 3, box: [0.1, 0.6, 0.2, 0.2] },
      { type: 'column', wrapStyle: 'canopy', stringCount: 1, box: [0.5, 0.5, 0.04, 0.3] },
    ],
    wreaths: [{ size: '30noble', tier: 'bow', box: [0.4, 0.3, 0.1, 0.2] }],
    spritzers: [{ size: '24', box: [0.7, 0.7, 0.1, 0.1] }],
    garland: [{ length: '9ft', tier: 'fullDecor', box: [0.2, 0.5, 0.4, 0.05] }],
  },
};

describe('seedSceneFromAnalysis — conversion', () => {
  const out = seedSceneFromAnalysis(emptyScene(), FULL_SEED, W, H);

  it('seeds the roofline as tagged C9 strands (via the #33 lib)', () => {
    const roof = out.items.filter((i) => isStrand(i) && i.surface === 'santas-roofline');
    expect(roof).toHaveLength(1);
  });

  it('bush → a Scattershot mini-area at the pixel box with the AI string count', () => {
    const area = out.items.find(isMiniArea) as MiniAreaItem;
    expect(area).toBeTruthy();
    expect(area.shape).toBe('box');
    expect([area.x, area.y, area.width, area.height]).toEqual([100, 300, 200, 100]);
    expect(area.surface).toBe('bush');
    expect(area.wrapStyle).toBe('canopy');
    expect(area.stringCount).toBe(3);
    expect(area.included).toBe(true);
    expect(area.id).toBe('seed-mini-1');
  });

  it('column → a vertical mini strand through the box center', () => {
    const col = out.items.find((i) => isStrand(i) && i.surface === 'column') as StrandItem;
    expect(col).toBeTruthy();
    expect(col.bulbType).toBe('mini');
    expect(col.points).toEqual([520, 250, 520, 400]); // cx=0.52*1000; y 0.5..0.8 * 500
    expect(col.stringCount).toBe(1);
  });

  it('wreath / spritzer at box centers with the BILLED spec from the AI', () => {
    const wreath = out.items.find(isWreath) as WreathItem;
    expect([wreath.x, wreath.y]).toEqual([450, 200]);
    expect(wreath.quoteSize).toBe('30noble');
    expect(wreath.tier).toBe('bow');
    const spritzer = out.items.find(isSpritzer) as SpritzerItem;
    expect([spritzer.x, spritzer.y]).toEqual([750, 375]);
    expect(spritzer.quoteSize).toBe('24');
  });

  it('garland → a run across the box; quoteSections falls back to 1 with no scale (FULL_SEED has no calibration)', () => {
    const garland = out.items.find(isGarland) as GarlandItem;
    expect(garland.points).toEqual([200, 262.5, 600, 262.5]);
    expect(garland.quoteLength).toBe('9ft');
    expect(garland.quoteSections).toBe(1);
    expect(garland.tier).toBe('fullDecor');
  });

  it('counts seeded items for feedback', () => {
    expect(countSeededItems(out)).toEqual({ roofline: 1, perUnit: 5 });
  });
});

describe('seedSceneFromAnalysis — replacement rules', () => {
  it('replaces seed-* per-unit items but never staff-drawn items', () => {
    const first = seedSceneFromAnalysis(emptyScene(), FULL_SEED, W, H);
    const staffWreath: WreathItem = {
      id: 'staff-wreath',
      yardstickId: null,
      kind: 'wreath',
      x: 10,
      y: 10,
      sizeIn: 48,
      withLights: true,
    };
    const withStaff: Scene = { ...first, items: [...first.items, staffWreath] };

    const reseed: AnalysisSeed = {
      detections: { wreaths: [{ size: '48noble', tier: 'bow', box: [0.5, 0.5, 0.1, 0.1] }] },
    };
    const out = seedSceneFromAnalysis(withStaff, reseed, W, H);

    // All prior seed-* per-unit items are gone; the one new wreath is in.
    expect(countSeededItems(out).perUnit).toBe(1);
    const seededWreath = out.items.find((i) => i.id === 'seed-wreath-1') as WreathItem;
    expect(seededWreath.quoteSize).toBe('48noble');
    // Staff item untouched.
    expect(out.items.some((i) => i.id === 'staff-wreath')).toBe(true);
    // No lines in the reseed → the roofline strand from the first seed survives.
    expect(countSeededItems(out).roofline).toBe(1);
  });

  it('empty seed is a NO-OP; bad photo dims are a NO-OP', () => {
    const populated = seedSceneFromAnalysis(emptyScene(), FULL_SEED, W, H);
    expect(seedSceneFromAnalysis(populated, {}, W, H)).toBe(populated);
    expect(seedSceneFromAnalysis(populated, FULL_SEED, 0, H)).toBe(populated);
  });
});

describe('seedSceneFromAnalysis — scale yardstick', () => {
  // Horizontal santas line 0.1→0.9 on a 1000px-wide photo = 800px; the AI says
  // that run is 40ft → 20 px/ft → a 6ft yardstick is 120px wide.
  const CAL_SEED: AnalysisSeed = {
    lines: { santas: [[[0.1, 0.4], [0.9, 0.4]]] },
    calibration: { santasFootage: 40 },
  };

  it('derives px-per-foot from the AI roofline and seeds a 5 ft yardstick', () => {
    const out = seedSceneFromAnalysis(emptyScene(), CAL_SEED, W, H);
    expect(out.yardsticks).toHaveLength(1);
    const ys = out.yardsticks[0];
    expect(ys.id).toBe('seed-yardstick-1');
    expect(ys.realFeet).toBe(5);
    expect(ys.width).toBe(100); // 5ft × 20px/ft
  });

  it('NEVER touches staff yardsticks (staff calibration wins)', () => {
    const staff = { id: 'ys-door', realFeet: 6, x: 1, y: 2, width: 90, height: 40 };
    const sceneBefore: Scene = { yardsticks: [staff], items: [] };
    const out = seedSceneFromAnalysis(sceneBefore, CAL_SEED, W, H);
    expect(out.yardsticks).toEqual([staff]);
  });

  it('replaces its OWN seed yardstick on re-seed (fresh calibration)', () => {
    const first = seedSceneFromAnalysis(emptyScene(), CAL_SEED, W, H);
    const reseed: AnalysisSeed = {
      lines: { santas: [[[0.1, 0.4], [0.9, 0.4]]] },
      calibration: { santasFootage: 80 }, // same line, double footage → 10 px/ft
    };
    const out = seedSceneFromAnalysis(first, reseed, W, H);
    expect(out.yardsticks).toHaveLength(1);
    expect(out.yardsticks[0].width).toBe(50); // 5ft × 10px/ft
  });

  it('skips the yardstick without usable calibration (no footage / implausible)', () => {
    const noCal = seedSceneFromAnalysis(emptyScene(), FULL_SEED, W, H);
    expect(noCal.yardsticks).toHaveLength(0);
    const absurd = seedSceneFromAnalysis(
      emptyScene(),
      { lines: CAL_SEED.lines, calibration: { santasFootage: 0.001 } }, // 800000 px/ft
      W,
      H,
    );
    expect(absurd.yardsticks).toHaveLength(0);
  });

  it('falls back to the gingerbread line when santas has no calibration pair', () => {
    const out = seedSceneFromAnalysis(
      emptyScene(),
      { lines: { gingerbread: [[[0, 0.2], [0.5, 0.2]]] }, calibration: { gingerbreadFootage: 25 } },
      W,
      H,
    ); // 500px / 25ft = 20 px/ft
    expect(out.yardsticks[0]?.width).toBe(100); // 5ft × 20px/ft
  });
});

describe('garland sections from scale (#8 Stage C / C4)', () => {
  // santas line 0.1→0.9 on W=1000 = 800px; AI says 40ft → 20 px/ft.
  const base = { lines: { santas: [[[0.1, 0.4], [0.9, 0.4]]] as [number, number][][] }, calibration: { santasFootage: 40 } };

  it('derives quoteSections from box width × scale (9ft sections, ceil)', () => {
    const seed: AnalysisSeed = { ...base, detections: { garland: [{ length: '9ft', tier: 'bow', box: [0.2, 0.5, 0.4, 0.05] }] } };
    const g = seedSceneFromAnalysis(emptyScene(), seed, W, H).items.find(isGarland) as GarlandItem;
    // box width 0.4×1000 = 400px ÷ 20px/ft = 20ft; ceil(20/9) = 3
    expect(g.quoteSections).toBe(3);
    expect(g.quoteLength).toBe('9ft');
  });

  it('uses the 4.5ft section length when the detection is 4.5ft', () => {
    const seed: AnalysisSeed = { ...base, detections: { garland: [{ length: '4.5ft', tier: 'bow', box: [0.2, 0.5, 0.4, 0.05] }] } };
    const g = seedSceneFromAnalysis(emptyScene(), seed, W, H).items.find(isGarland) as GarlandItem;
    // 20ft ÷ 4.5 = 4.44 → ceil = 5
    expect(g.quoteSections).toBe(5);
  });

  it('a short run still bills at least 1 section', () => {
    const seed: AnalysisSeed = { ...base, detections: { garland: [{ length: '9ft', tier: 'bow', box: [0.2, 0.5, 0.1, 0.05] }] } };
    const g = seedSceneFromAnalysis(emptyScene(), seed, W, H).items.find(isGarland) as GarlandItem;
    // 100px ÷ 20 = 5ft; ceil(5/9) = 1
    expect(g.quoteSections).toBe(1);
  });

  it('falls back to 1 section when there is no scale (no calibration)', () => {
    const seed: AnalysisSeed = { detections: { garland: [{ length: '9ft', tier: 'bow', box: [0.2, 0.5, 0.4, 0.05] }] } };
    const g = seedSceneFromAnalysis(emptyScene(), seed, W, H).items.find(isGarland) as GarlandItem;
    expect(g.quoteSections).toBe(1);
  });
});

describe('sanitizeAnalysisSeed', () => {
  it('keeps valid calibration numbers, drops non-positive/garbage ones', () => {
    const out = sanitizeAnalysisSeed({
      lines: { santas: [[[0, 0.5], [1, 0.5]]] },
      calibration: { santasFootage: 50, gingerbreadFootage: -3 },
    });
    expect(out.calibration).toEqual({ santasFootage: 50 });
    expect(sanitizeAnalysisSeed({ calibration: { santasFootage: 'big' } }).calibration).toBeUndefined();
  });

  it('keeps valid entries, drops malformed boxes and unknown enums', () => {
    const out = sanitizeAnalysisSeed({
      lines: { santas: [[[0, 0.5], [1, 0.5]]] },
      detections: {
        miniLights: [
          { type: 'bush', wrapStyle: 'canopy', stringCount: 2, box: [0.1, 0.1, 0.2, 0.2] },
          { type: 'shrubbery', wrapStyle: 'canopy', stringCount: 2, box: [0.1, 0.1, 0.2, 0.2] }, // bad type
          { type: 'bush', wrapStyle: 'canopy', stringCount: 2, box: [0.1, 0.1, 0, 0.2] }, // zero-width box
        ],
        wreaths: [{ size: '99noble', tier: 'bow', box: [0.1, 0.1, 0.1, 0.1] }], // bad size
        garland: 'nope',
      },
    });
    expect(out.detections?.miniLights).toHaveLength(1);
    expect(out.detections?.wreaths).toBeUndefined();
    expect(out.detections?.garland).toBeUndefined();
    expect(out.lines?.santas).toHaveLength(1);
    expect(analysisSeedHasContent(out)).toBe(true);
  });

  it('returns an empty seed for garbage', () => {
    expect(analysisSeedHasContent(sanitizeAnalysisSeed(null))).toBe(false);
    expect(analysisSeedHasContent(sanitizeAnalysisSeed({ detections: {} }))).toBe(false);
  });
});
