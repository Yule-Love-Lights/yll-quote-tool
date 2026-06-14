import { describe, it, expect } from 'vitest';
import { sceneToFewShotPieces } from './sceneToFewShot';
import type { Scene, StrandItem, MiniAreaItem, WreathItem, SpritzerItem, GarlandItem } from './sceneTypes';

// 1000×500 photo keeps the normalized math easy to eyeball.
const W = 1000;
const H = 500;

function c9(id: string, surface: StrandItem['surface'], points: number[]): StrandItem {
  return {
    id, yardstickId: null, kind: 'strand', bulbType: 'c9', spacingIn: 12,
    drawingStyle: 'strand', colorPattern: ['warm-white'], points, surface, included: true,
  };
}

function miniStrand(id: string, surface: StrandItem['surface'], points: number[], extra?: Partial<StrandItem>): StrandItem {
  return {
    id, yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6,
    drawingStyle: 'strand', colorPattern: ['warm-white'], points, surface, included: true, ...extra,
  };
}

const scene = (items: Scene['items'], yardsticks: Scene['yardsticks'] = []): Scene => ({ yardsticks, items });

describe('sceneToFewShotPieces', () => {
  it('returns empty pieces for degenerate photo dims', () => {
    const out = sceneToFewShotPieces(scene([c9('a', 'santas-roofline', [0, 0, 100, 0])]), 0, H);
    expect(out.santasLines).toEqual([]);
  });

  it('converts tagged C9 strands into normalized roofline polylines, skipping winter-wonderland', () => {
    const out = sceneToFewShotPieces(
      scene([
        c9('seed-santas-1', 'santas-roofline', [100, 100, 600, 100]),
        c9('staff-drawn', 'gingerbread', [0, 250, 1000, 250]),
        c9('ww', 'winter-wonderland', [0, 0, 50, 50]),
      ]),
      W, H,
    );
    expect(out.santasLines).toHaveLength(1);
    expect(out.santasLines[0].points).toEqual([[0.1, 0.2], [0.6, 0.2]]);
    expect(out.gingerbreadLines).toHaveLength(1);
    expect(out.gingerbreadLines[0].points).toEqual([[0, 0.5], [1, 0.5]]);
    expect(out.miniLightDetections).toHaveLength(0);
  });

  it('converts surface-tagged mini strands to detections; skips grouped + railing strands', () => {
    const out = sceneToFewShotPieces(
      scene([
        miniStrand('m1', 'bush', [100, 400, 300, 450], { stringCount: 3, wrapStyle: 'canopy' }),
        miniStrand('m2', 'bush', [0, 0, 10, 10], { groupId: 'grp-1' }), // grouped → skip
        miniStrand('m3', 'railing', [0, 0, 10, 10]), // railing → no analyzer vocab
      ]),
      W, H,
    );
    expect(out.miniLightDetections).toHaveLength(1);
    const d = out.miniLightDetections[0];
    expect(d.type).toBe('bush');
    expect(d.stringCount).toBe(3);
    expect(d.box).toEqual([0.1, 0.8, 0.2, 0.1]);
    expect(d.label).toBe('bush — 3 strings');
  });

  it('converts box and polygon mini-areas, defaulting wrapStyle/stringCount', () => {
    const box: MiniAreaItem = {
      id: 'a1', yardstickId: null, kind: 'miniArea', shape: 'box',
      x: 200, y: 100, width: 100, height: 50, surface: 'tree', included: true,
    };
    const poly: MiniAreaItem = {
      id: 'a2', yardstickId: null, kind: 'miniArea', shape: 'polygon',
      points: [500, 200, 700, 200, 700, 300], surface: 'bush', included: true, stringCount: 2,
    };
    const untagged: MiniAreaItem = {
      id: 'a3', yardstickId: null, kind: 'miniArea', shape: 'box',
      x: 0, y: 0, width: 10, height: 10, surface: null, included: true,
    };
    const out = sceneToFewShotPieces(scene([box, poly, untagged]), W, H);
    expect(out.miniLightDetections).toHaveLength(2);
    expect(out.miniLightDetections[0]).toMatchObject({
      type: 'tree', wrapStyle: 'canopy', stringCount: 1, box: [0.2, 0.2, 0.1, 0.1],
    });
    expect(out.miniLightDetections[1]).toMatchObject({
      type: 'bush', stringCount: 2, box: [0.5, 0.4, 0.2, 0.2],
    });
  });

  it('sizes wreath/spritzer boxes from the scene yardstick (visual inches × ppf)', () => {
    // 5 ft yardstick drawn 100 px wide → 20 px/ft. A 36in (3 ft) wreath → 60 px side.
    const wreath: WreathItem = {
      id: 'w1', yardstickId: null, kind: 'wreath', x: 500, y: 250, sizeIn: 36,
      withLights: true, quoteSize: '30noble', tier: 'fullDecor', included: true,
    };
    const out = sceneToFewShotPieces(
      scene([wreath], [{ id: 'ys', realFeet: 5, x: 0, y: 0, width: 100, height: 45 }]),
      W, H,
    );
    expect(out.wreathDetections).toHaveLength(1);
    const d = out.wreathDetections[0];
    expect(d.size).toBe('30noble');
    expect(d.tier).toBe('fullDecor');
    // centered 60px box on (500, 250): x 470/1000=0.47, y 220/500=0.44, w 0.06, h 0.12
    expect(d.box).toEqual([0.47, 0.44, 0.06, 0.12]);
  });

  it('falls back to an 8%-of-width box when there is no yardstick, and defaults quote sizes', () => {
    const spritzer: SpritzerItem = {
      id: 's1', yardstickId: null, kind: 'spritzer', x: 500, y: 250, sizeIn: 24,
      colorPattern: [], included: true,
    };
    const out = sceneToFewShotPieces(scene([spritzer]), W, H);
    expect(out.spritzerDetections).toHaveLength(1);
    const d = out.spritzerDetections[0];
    expect(d.size).toBe('24'); // default quoteSize
    // fallback side = 80px: x 460/1000=0.46, w 0.08, y 210/500=0.42, h 0.16
    expect(d.box).toEqual([0.46, 0.42, 0.08, 0.16]);
  });

  it('converts garland runs to bounding-box detections with section-aware labels', () => {
    const garland: GarlandItem = {
      id: 'g1', yardstickId: null, kind: 'garland', points: [100, 300, 400, 320],
      drawingStyle: 'strand', withLights: true, quoteLength: '9ft', quoteSections: 2,
      tier: 'bow', included: true,
    };
    const out = sceneToFewShotPieces(scene([garland]), W, H);
    expect(out.garlandDetections).toHaveLength(1);
    const d = out.garlandDetections[0];
    expect(d).toMatchObject({ length: '9ft', tier: 'bow' });
    expect(d.label).toBe('garland 9ft × 2');
    expect(d.box).toEqual([0.1, 0.6, 0.3, 0.04]);
  });

  it('pads a straight (zero-extent) garland run so it still converts (L3)', () => {
    // A perfectly horizontal railing garland → zero-height bounding box; must
    // be padded (MIN 2%) instead of dropped.
    const garland: GarlandItem = {
      id: 'g1', yardstickId: null, kind: 'garland', points: [100, 250, 500, 250],
      drawingStyle: 'strand', withLights: true, quoteLength: '9ft', tier: 'fullDecor', included: true,
    };
    const out = sceneToFewShotPieces(scene([garland]), W, H);
    expect(out.garlandDetections).toHaveLength(1);
    const [, , , bh] = out.garlandDetections[0].box;
    expect(bh).toBeGreaterThan(0); // padded, not collapsed
    expect(bh).toBeCloseTo(0.02, 5); // 2% of height, centered on y=0.5
  });

  it('clamps out-of-photo geometry into 0–1', () => {
    const out = sceneToFewShotPieces(
      scene([c9('s', 'santas-roofline', [-50, -50, 2000, 100])]),
      W, H,
    );
    expect(out.santasLines[0].points).toEqual([[0, 0], [1, 0.2]]);
  });
});
