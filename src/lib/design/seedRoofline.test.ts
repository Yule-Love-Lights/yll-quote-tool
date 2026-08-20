import { describe, it, expect } from 'vitest';
import {
  seedRooflineStrands,
  sanitizeSeedLines,
  seedLinesHaveContent,
  countRooflineStrands,
  RooflineSeedLines,
} from './seedRoofline';
import type { Scene, StrandItem, WreathItem } from './sceneTypes';
import { isStrand } from './sceneTypes';

const W = 640;
const H = 480;

function strand(over: Partial<StrandItem> = {}): StrandItem {
  return {
    id: 'hand-1',
    yardstickId: null,
    kind: 'strand',
    bulbType: 'c9',
    spacingIn: 12,
    drawingStyle: 'strand',
    colorPattern: ['warm-white'],
    points: [0, 0, 10, 10],
    ...over,
  };
}

function wreath(): WreathItem {
  return { id: 'w-1', yardstickId: null, kind: 'wreath', x: 5, y: 5, sizeIn: 36, withLights: true };
}

function emptyScene(): Scene {
  return { yardsticks: [], items: [] };
}

const LINES: RooflineSeedLines = {
  santas: [
    [
      [0, 0.5],
      [0.5, 0.25],
      [1, 0.5],
    ],
  ],
  gingerbread: [
    [
      [0.1, 0.2],
      [0.9, 0.2],
    ],
    [
      [0, 0.4],
      [0.1, 0.45],
    ],
  ],
  winterWonderland: [
    [
      [0.2, 0.8],
      [0.8, 0.8],
    ],
  ],
};

describe('seedRooflineStrands', () => {
  it('converts normalized polylines into tagged C9 strands in photo-pixel space', () => {
    const out = seedRooflineStrands(emptyScene(), LINES, W, H);
    const strands = out.items.filter(isStrand);
    expect(strands).toHaveLength(4); // 1 santas + 2 gingerbread + 1 WW

    const santas = strands.find((s) => s.surface === 'santas-roofline')!;
    expect(santas.points).toEqual([0, 240, 320, 120, 640, 240]); // ×640 / ×480
    expect(santas.bulbType).toBe('c9');
    expect(santas.spacingIn).toBe(15); // Medium preset post-row-248 trim (Jason pick)
    expect(santas.drawingStyle).toBe('strand');
    expect(santas.colorPattern).toEqual(['warm-white']);
    expect(santas.included).toBe(true);

    expect(strands.filter((s) => s.surface === 'gingerbread')).toHaveLength(2);
    expect(strands.filter((s) => s.surface === 'winter-wonderland')).toHaveLength(1);
  });

  it('seeds stake-lighting polylines into tagged C9 strands (own surface + id prefix)', () => {
    const out = seedRooflineStrands(
      emptyScene(),
      { stakeLighting: [[[0.2, 0.9], [0.8, 0.9]]] },
      W,
      H,
    );
    const stakes = out.items.filter(isStrand).filter((s) => s.surface === 'stake-lighting');
    expect(stakes).toHaveLength(1);
    expect(stakes[0].id).toBe('seed-stake-1');
    expect(stakes[0].bulbType).toBe('c9');
    expect(stakes[0].points).toEqual([128, 432, 512, 432]); // ×640 / ×480
    // stake-lighting counts as a roofline-tagged strand (replaced on re-seed).
    expect(countRooflineStrands(out)).toBe(1);
  });

  it('REPLACES all roofline-tagged strands (any origin) but keeps untagged + other items', () => {
    const sceneBefore: Scene = {
      yardsticks: [],
      items: [
        strand({ id: 'hand-tagged', surface: 'santas-roofline' }), // replaced
        strand({ id: 'hand-ww', surface: 'winter-wonderland' }), // replaced
        strand({ id: 'hand-decor' }), // untagged C9 decor — kept
        strand({ id: 'hand-bush', bulbType: 'mini', surface: 'bush' }), // mini wrap — kept
        wreath(), // other kind — kept
      ],
    };
    const out = seedRooflineStrands(sceneBefore, { santas: LINES.santas }, W, H);
    const ids = out.items.map((i) => i.id);
    expect(ids).toContain('hand-decor');
    expect(ids).toContain('hand-bush');
    expect(ids).toContain('w-1');
    expect(ids).not.toContain('hand-tagged');
    expect(ids).not.toContain('hand-ww');
    // Only the new santas seed remains roofline-tagged.
    expect(countRooflineStrands(out)).toBe(1);
  });

  it('is a NO-OP when the lines are empty (a stray sync cannot wipe a design)', () => {
    const sceneBefore: Scene = {
      yardsticks: [],
      items: [strand({ id: 'hand-tagged', surface: 'gingerbread' })],
    };
    expect(seedRooflineStrands(sceneBefore, {}, W, H)).toBe(sceneBefore);
    expect(seedRooflineStrands(sceneBefore, { santas: [] }, W, H)).toBe(sceneBefore);
  });

  it('no-ops on unusable photo dimensions and clamps out-of-range coordinates', () => {
    const sceneBefore = emptyScene();
    expect(seedRooflineStrands(sceneBefore, LINES, 0, H)).toBe(sceneBefore);
    expect(seedRooflineStrands(sceneBefore, LINES, NaN, H)).toBe(sceneBefore);

    const out = seedRooflineStrands(
      emptyScene(),
      { santas: [[[-0.5, 0.5], [1.5, 2]]] },
      W,
      H,
    );
    const s = out.items.filter(isStrand)[0];
    expect(s.points).toEqual([0, 240, 640, 480]); // clamped into the photo
  });

  it('re-seeding is idempotent — same lines twice yields the same strands once', () => {
    const once = seedRooflineStrands(emptyScene(), LINES, W, H);
    const twice = seedRooflineStrands(once, LINES, W, H);
    expect(twice.items).toEqual(once.items);
  });

  it('applies AI-detected roof features (index-aligned) and defaults stake → pathway (#82 2c)', () => {
    const out = seedRooflineStrands(
      emptyScene(),
      {
        santas: [[[0, 0.5], [1, 0.5]]],
        gingerbread: [[[0.1, 0.2], [0.9, 0.2]], [[0, 0.4], [0.1, 0.45]]],
        stakeLighting: [[[0.2, 0.9], [0.8, 0.9]]],
        features: { santas: ['gutter'], gingerbread: ['ridge', 'side'] },
      },
      W,
      H,
    );
    const byId = (id: string) => out.items.filter(isStrand).find((s) => s.id === id)!;
    expect(byId('seed-santas-1').roofFeature).toBe('gutter');
    expect(byId('seed-gingerbread-1').roofFeature).toBe('ridge');
    expect(byId('seed-gingerbread-2').roofFeature).toBe('side');
    expect(byId('seed-stake-1').roofFeature).toBe('pathway'); // default, no AI feature needed
  });

  it('leaves roofFeature unset when no feature is provided (staff sets it)', () => {
    const out = seedRooflineStrands(emptyScene(), { santas: [[[0, 0.5], [1, 0.5]]] }, W, H);
    expect(out.items.filter(isStrand)[0].roofFeature).toBeUndefined();
  });
});

describe('sanitizeSeedLines', () => {
  it('parses a valid payload and drops malformed points/polylines', () => {
    const out = sanitizeSeedLines({
      santas: [
        [
          [0, 0.5],
          ['x', 1], // bad point — dropped
          [0.5, 0.25],
        ],
        [[0.1, 0.1]], // single point after filtering — whole polyline dropped
      ],
      gingerbread: 'nope', // not an array — dropped
      extraneous: true,
    });
    expect(out).toEqual({ santas: [[[0, 0.5], [0.5, 0.25]]] });
    expect(seedLinesHaveContent(out)).toBe(true);
  });

  it('parses the stakeLighting channel', () => {
    const out = sanitizeSeedLines({ stakeLighting: [[[0.2, 0.9], [0.8, 0.9]]] });
    expect(out).toEqual({ stakeLighting: [[[0.2, 0.9], [0.8, 0.9]]] });
    expect(seedLinesHaveContent(out)).toBe(true);
  });

  it('returns an empty object for garbage input', () => {
    expect(sanitizeSeedLines(null)).toEqual({});
    expect(sanitizeSeedLines('hi')).toEqual({});
    expect(seedLinesHaveContent(sanitizeSeedLines(null))).toBe(false);
  });

  it('parses index-aligned features and keeps alignment when a polyline is dropped (#82 2c)', () => {
    const out = sanitizeSeedLines({
      santas: [
        [[0, 0.5], [1, 0.5]],   // valid → 'gutter'
        [[0.1, 0.1]],           // single point → dropped (with its feature)
        [[0.2, 0.3], [0.4, 0.5]], // valid → 'peak'
      ],
      features: { santas: ['gutter', 'metal', 'peak'] },
    });
    expect(out.santas).toHaveLength(2);
    expect(out.features?.santas).toEqual(['gutter', 'peak']); // 'metal' dropped with poly[1]
  });

  it('drops unknown feature values and omits an all-null features array', () => {
    const out = sanitizeSeedLines({
      santas: [[[0, 0.5], [1, 0.5]]],
      features: { santas: ['bogus'] },
    });
    expect(out.santas).toHaveLength(1);
    expect(out.features).toBeUndefined();
  });
});
