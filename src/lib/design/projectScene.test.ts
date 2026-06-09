import { describe, it, expect } from 'vitest';
import { projectScene } from './projectScene';
import type {
  Scene,
  SceneItem,
  StrandItem,
  WreathItem,
  GarlandItem,
  SpritzerItem,
  BowItem,
  TextItem,
  Surface,
} from './sceneTypes';

// ── Minimal valid item builders (only the fields the projection reads matter;
// the rest satisfy the type). The `sizeIn` values are deliberately set to
// VISUAL-only numbers unrelated to the billed `quote*` fields, to prove the
// projection ignores the drawn size. ────────────────────────────────────────
let n = 0;
const nextId = () => `item-${++n}`;

function strand(over: Partial<StrandItem> = {}): StrandItem {
  return {
    id: nextId(),
    yardstickId: null,
    kind: 'strand',
    bulbType: 'mini',
    spacingIn: 6,
    drawingStyle: 'strand',
    colorPattern: ['warm'],
    points: [0, 0, 100, 0],
    ...over,
  };
}
function wreath(over: Partial<WreathItem> = {}): WreathItem {
  return { id: nextId(), yardstickId: null, kind: 'wreath', x: 0, y: 0, sizeIn: 60, withLights: true, ...over };
}
function garland(over: Partial<GarlandItem> = {}): GarlandItem {
  return {
    id: nextId(),
    yardstickId: null,
    kind: 'garland',
    points: [0, 0, 100, 0],
    drawingStyle: 'strand',
    withLights: true,
    ...over,
  };
}
function spritzer(over: Partial<SpritzerItem> = {}): SpritzerItem {
  return { id: nextId(), yardstickId: null, kind: 'spritzer', x: 0, y: 0, sizeIn: 48, colorPattern: ['warm'], ...over };
}
function bow(over: Partial<BowItem> = {}): BowItem {
  return { id: nextId(), yardstickId: null, kind: 'bow', x: 0, y: 0, sizeIn: 24, ...over };
}
function text(over: Partial<TextItem> = {}): TextItem {
  return { id: nextId(), yardstickId: null, kind: 'text', x: 0, y: 0, text: 'JOY', fontFamily: 'serif', sizeIn: 12, colorId: 'warm', ...over };
}
function scene(items: SceneItem[]): Scene {
  return { yardsticks: [], items };
}

describe('projectScene — basics', () => {
  it('empty scene → all empty', () => {
    const p = projectScene(scene([]));
    expect(p.items).toEqual([]);
    expect(p.miniLightItems).toEqual([]);
    expect(p.spritzers).toEqual([]);
    expect(p.wreaths).toEqual([]);
    expect(p.garland).toEqual([]);
  });

  it('tolerates a malformed scene (no items array)', () => {
    // @ts-expect-error — exercising the defensive guard
    const p = projectScene({ yardsticks: [] });
    expect(p.items).toEqual([]);
  });
});

describe('projectScene — mini-light wraps (strand + surface bush/tree/column)', () => {
  it('projects a bush wrap per-instance with stringCount + wrapStyle', () => {
    const s = strand({ id: 'bush-a', surface: 'bush', stringCount: 3, wrapStyle: 'canopy' });
    const p = projectScene(scene([s]));
    expect(p.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 3 }]);
    expect(p.items).toEqual([
      { id: 'mini-bush-a', category: 'mini', sceneItemIds: ['bush-a'], input: { type: 'bush', wrapStyle: 'canopy', stringCount: 3 } },
    ]);
  });

  it('defaults stringCount→1 and wrapStyle→canopy when unset', () => {
    const p = projectScene(scene([strand({ surface: 'tree' })]));
    expect(p.miniLightItems).toEqual([{ type: 'tree', wrapStyle: 'canopy', stringCount: 1 }]);
  });

  it('honors trunk wrapStyle and column surface', () => {
    const p = projectScene(scene([strand({ surface: 'column', wrapStyle: 'trunk', stringCount: 2 })]));
    expect(p.miniLightItems).toEqual([{ type: 'column', wrapStyle: 'trunk', stringCount: 2 }]);
  });

  it('clamps a fractional / zero stringCount to ≥1', () => {
    const p = projectScene(scene([strand({ surface: 'bush', stringCount: 0 })]));
    expect(p.miniLightItems[0].stringCount).toBe(1);
  });

  it('is per-instance: two bushes → two line items (NOT merged)', () => {
    const p = projectScene(scene([
      strand({ id: 'b1', surface: 'bush', stringCount: 1 }),
      strand({ id: 'b2', surface: 'bush', stringCount: 1 }),
    ]));
    expect(p.items.map((i) => i.id)).toEqual(['mini-b1', 'mini-b2']);
    expect(p.miniLightItems).toHaveLength(2);
  });
});

describe('projectScene — roofline + unmapped strands are NOT projected', () => {
  it.each<Surface>(['santas-roofline', 'gingerbread', 'winter-wonderland'])(
    'skips roofline strand surface=%s (measurement-driven)',
    (surface) => {
      const p = projectScene(scene([strand({ bulbType: 'c9', surface })]));
      expect(p.items).toEqual([]);
      expect(p.miniLightItems).toEqual([]);
    },
  );

  it('skips a strand with no surface tag', () => {
    const p = projectScene(scene([strand({ surface: null }), strand({})]));
    expect(p.items).toEqual([]);
  });
});

describe('projectScene — included flag', () => {
  it('excludes items with included:false', () => {
    const p = projectScene(scene([
      strand({ surface: 'bush', included: false }),
      wreath({ included: false }),
      spritzer({ included: false }),
    ]));
    expect(p.items).toEqual([]);
  });

  it('includes items with included:true or undefined', () => {
    const p = projectScene(scene([
      strand({ surface: 'bush', included: true }),
      wreath({}),
    ]));
    expect(p.items).toHaveLength(2);
  });
});

describe('projectScene — spritzers (per-instance, billed size from quoteSize)', () => {
  it('uses the staff-set quoteSize, IGNORING the visual sizeIn', () => {
    // Visual 48", billed 32" — proves the drawn size is irrelevant to price.
    const p = projectScene(scene([spritzer({ sizeIn: 48, quoteSize: '32' })]));
    expect(p.spritzers).toEqual([{ size: '32', quantity: 1 }]);
  });

  it('defaults billed size to 24" when quoteSize unset', () => {
    const p = projectScene(scene([spritzer({ sizeIn: 16 })]));
    expect(p.spritzers).toEqual([{ size: '24', quantity: 1 }]);
  });

  it('is per-instance: two spritzers → two entries', () => {
    const p = projectScene(scene([
      spritzer({ id: 's1', quoteSize: '16' }),
      spritzer({ id: 's2', quoteSize: '24' }),
    ]));
    expect(p.items.map((i) => i.id)).toEqual(['spritzer-s1', 'spritzer-s2']);
    expect(p.spritzers).toEqual([{ size: '16', quantity: 1 }, { size: '24', quantity: 1 }]);
  });
});

describe('projectScene — wreaths (billed size + tier, ignoring visual size)', () => {
  it('uses staff-set quoteSize (incl. Oregon variety), IGNORING the drawn 60"', () => {
    const p = projectScene(scene([
      wreath({ sizeIn: 60, quoteSize: '30noble', tier: 'labor' }),
      wreath({ sizeIn: 60, quoteSize: '36oregon', tier: 'fullDecor' }),
    ]));
    expect(p.wreaths).toEqual([
      { size: '30noble', tier: 'labor', quantity: 1 },
      { size: '36oregon', tier: 'fullDecor', quantity: 1 },
    ]);
  });

  it('defaults to 36" Noble + With Bow when unset', () => {
    const p = projectScene(scene([wreath({})]));
    expect(p.wreaths).toEqual([{ size: '36noble', tier: 'bow', quantity: 1 }]);
  });

  it('explicit tier wins over the default', () => {
    const p = projectScene(scene([wreath({ quoteSize: '24noble', tier: 'fullDecor' })]));
    expect(p.wreaths[0].tier).toBe('fullDecor');
  });
});

describe('projectScene — garland (length + sections + tier, all staff-set)', () => {
  it('uses quoteLength + quoteSections; defaults tier to Full Decor', () => {
    const p = projectScene(scene([garland({ quoteLength: '9ft', quoteSections: 3 })]));
    expect(p.garland).toEqual([{ length: '9ft', type: 'noble', tier: 'fullDecor', quantity: 3 }]);
  });

  it('defaults to one 9ft section, Full Decor, when unset', () => {
    const p = projectScene(scene([garland({})]));
    expect(p.garland).toEqual([{ length: '9ft', type: 'noble', tier: 'fullDecor', quantity: 1 }]);
  });

  it('honors 4.5ft length and an explicit bow tier', () => {
    const p = projectScene(scene([garland({ quoteLength: '4.5ft', quoteSections: 2, tier: 'bow' })]));
    expect(p.garland).toEqual([{ length: '4.5ft', type: 'noble', tier: 'bow', quantity: 2 }]);
  });

  it('clamps a fractional / zero section count to ≥1', () => {
    const p = projectScene(scene([garland({ quoteSections: 0 })]));
    expect(p.garland[0].quantity).toBe(1);
  });
});

describe('projectScene — unmapped item kinds', () => {
  it('bow and text render but produce no line item', () => {
    const p = projectScene(scene([bow(), text()]));
    expect(p.items).toEqual([]);
  });
});

describe('projectScene — mixed scene preserves order + derived arrays', () => {
  it('items[] order matches scene order; arrays are the per-category slices', () => {
    const p = projectScene(scene([
      strand({ id: 'roof', bulbType: 'c9', surface: 'santas-roofline' }), // skipped
      wreath({ id: 'w', quoteSize: '24noble', tier: 'bow' }),
      strand({ id: 'bush', surface: 'bush', stringCount: 2 }),
      spritzer({ id: 'sp', quoteSize: '16' }),
      garland({ id: 'g', quoteLength: '9ft', quoteSections: 1, tier: 'labor' }),
      bow({ id: 'b' }), // skipped
    ]));
    expect(p.items.map((i) => i.id)).toEqual(['wreath-w', 'mini-bush', 'spritzer-sp', 'garland-g']);
    expect(p.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 2 }]);
    expect(p.spritzers).toEqual([{ size: '16', quantity: 1 }]);
    expect(p.wreaths).toEqual([{ size: '24noble', tier: 'bow', quantity: 1 }]);
    expect(p.garland).toEqual([{ length: '9ft', type: 'noble', tier: 'labor', quantity: 1 }]);
  });
});
