import { describe, it, expect } from 'vitest';
import { sceneToFewShotPieces, sceneAuxiliaryC9Lines } from './sceneToFewShot';
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

  it('converts surface-tagged mini strands to detections (incl. railings); skips grouped members', () => {
    const out = sceneToFewShotPieces(
      scene([
        miniStrand('m1', 'bush', [100, 400, 300, 450], { stringCount: 3, wrapStyle: 'canopy' }),
        miniStrand('m2', 'bush', [0, 0, 10, 10], { groupId: 'grp-1' }), // grouped member → skip (emitted via its group)
        miniStrand('m3', 'railing', [100, 200, 500, 200], { stringCount: 2 }), // railing → NOW taught
      ]),
      W, H,
    );
    expect(out.miniLightDetections).toHaveLength(2);
    const bush = out.miniLightDetections.find((d) => d.type === 'bush')!;
    expect(bush).toMatchObject({ type: 'bush', stringCount: 3, box: [0.1, 0.8, 0.2, 0.1], label: 'bush — 3 strings' });
    const rail = out.miniLightDetections.find((d) => d.type === 'railing')!;
    expect(rail).toMatchObject({ type: 'railing', stringCount: 2, label: 'railing — 2 strings' });
  });

  it('emits ONE railing detection for a grouped railing (boxing its member strands); skips curtains', () => {
    const out = sceneToFewShotPieces(
      scene([
        miniStrand('rm1', 'railing', [100, 200, 300, 200], { groupId: 'rg' }),
        miniStrand('rm2', 'railing', [300, 200, 500, 200], { groupId: 'rg' }),
        { id: 'rg', yardstickId: null, kind: 'miniGroup', surface: 'railing', stringCount: 4, memberIds: ['rm1', 'rm2'] },
        miniStrand('cur', 'curtain', [0, 0, 100, 0], { stringCount: 5 }), // curtain → NOT taught
      ]),
      W, H,
    );
    expect(out.miniLightDetections).toHaveLength(1);
    expect(out.miniLightDetections[0]).toMatchObject({ type: 'railing', stringCount: 4 });
    // box spans both members: x 100→500, y 200 (padded height) → [0.1, …, 0.4, …]
    expect(out.miniLightDetections[0].box[0]).toBeCloseTo(0.1, 5);
    expect(out.miniLightDetections[0].box[2]).toBeCloseTo(0.4, 5);
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

  it('sizes wreath/spritzer boxes axis-aware for a height-axis yardstick (#110 W5-001)', () => {
    // A vertical (height-axis) yardstick: 10 ft tall reference drawn 20px wide
    // × 200px tall. True ppf must come from HEIGHT: 200/10 = 20 px/ft (same
    // ppf as the width-axis test above) — NOT width/realFeet (20/10 = 2 px/ft,
    // ~10x too small), which is the bug this test guards against.
    const wreath: WreathItem = {
      id: 'w1', yardstickId: null, kind: 'wreath', x: 500, y: 250, sizeIn: 36,
      withLights: true, quoteSize: '30noble', tier: 'fullDecor', included: true,
    };
    const out = sceneToFewShotPieces(
      scene([wreath], [{ id: 'ys', realFeet: 10, x: 0, y: 0, width: 20, height: 200, axis: 'height' }]),
      W, H,
    );
    expect(out.wreathDetections).toHaveLength(1);
    // Same 60px centered box as the width-axis equivalent test (20 px/ft × 3ft).
    expect(out.wreathDetections[0].box).toEqual([0.47, 0.44, 0.06, 0.12]);
  });

  it('emits a railing detection via memberIds fallback when groupId has diverged (#110 W5-006)', () => {
    // The strands' groupId no longer matches the group's own id (corrupt
    // scene / deleted-and-recreated members), but the group's memberIds still
    // names them — the railing must still emit, not silently vanish.
    const out = sceneToFewShotPieces(
      scene([
        miniStrand('rm1', 'railing', [100, 200, 300, 200], { groupId: 'stale-group-id' }),
        miniStrand('rm2', 'railing', [300, 200, 500, 200], { groupId: 'stale-group-id' }),
        { id: 'rg', yardstickId: null, kind: 'miniGroup', surface: 'railing', stringCount: 4, memberIds: ['rm1', 'rm2'] },
      ]),
      W, H,
    );
    expect(out.miniLightDetections).toHaveLength(1);
    expect(out.miniLightDetections[0]).toMatchObject({ type: 'railing', stringCount: 4 });
    expect(out.miniLightDetections[0].box[0]).toBeCloseTo(0.1, 5);
    expect(out.miniLightDetections[0].box[2]).toBeCloseTo(0.4, 5);
  });

  it('still drops a railing group when NEITHER groupId NOR memberIds resolves any strand', () => {
    const out = sceneToFewShotPieces(
      scene([
        { id: 'rg', yardstickId: null, kind: 'miniGroup', surface: 'railing', stringCount: 4, memberIds: ['missing-1', 'missing-2'] },
      ]),
      W, H,
    );
    expect(out.miniLightDetections).toHaveLength(0);
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

// #109 Phase 1: the /training/new pre-fill affordance needs the two C9
// surfaces sceneToFewShotPieces intentionally skips (winter-wonderland +
// stake-lighting) — sceneAuxiliaryC9Lines is the separate, additive export
// that maps them.
describe('sceneAuxiliaryC9Lines', () => {
  it('returns empty lines for degenerate photo dims', () => {
    const out = sceneAuxiliaryC9Lines(scene([c9('a', 'winter-wonderland', [0, 0, 100, 0])]), 0, H);
    expect(out).toEqual({ c9Lines: [], stakeLines: [] });
  });

  it('maps winter-wonderland C9 runs to c9Lines and stake-lighting runs to stakeLines', () => {
    const out = sceneAuxiliaryC9Lines(
      scene([
        c9('ww1', 'winter-wonderland', [100, 100, 600, 100]),
        c9('st1', 'stake-lighting', [0, 400, 1000, 400]),
      ]),
      W, H,
    );
    expect(out.c9Lines).toHaveLength(1);
    expect(out.c9Lines[0].points).toEqual([[0.1, 0.2], [0.6, 0.2]]);
    expect(out.stakeLines).toHaveLength(1);
    expect(out.stakeLines[0].points).toEqual([[0, 0.8], [1, 0.8]]);
  });

  it('ignores santas-roofline/gingerbread C9 runs and non-c9 bulb types', () => {
    const out = sceneAuxiliaryC9Lines(
      scene([
        c9('s', 'santas-roofline', [0, 0, 500, 0]),
        c9('g', 'gingerbread', [0, 250, 1000, 250]),
        miniStrand('m', 'bush', [100, 400, 300, 450]),
      ]),
      W, H,
    );
    expect(out.c9Lines).toEqual([]);
    expect(out.stakeLines).toEqual([]);
  });

  it('drops a degenerate single-point run (needs at least 2 points)', () => {
    const out = sceneAuxiliaryC9Lines(scene([c9('a', 'winter-wonderland', [100, 100])]), W, H);
    expect(out.c9Lines).toEqual([]);
  });
});
