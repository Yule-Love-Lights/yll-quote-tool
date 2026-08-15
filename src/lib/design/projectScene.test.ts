import { describe, it, expect } from 'vitest';
import { projectScene, applyProjectionToInputs } from './projectScene';
import type { QuoteInputs } from '@/lib/pricing/pricingEngine';
import { calculatePermanentBistro } from '@/lib/permanentBistro/pricing';
import { DEFAULT_PERMANENT_BISTRO_RATES } from '@/lib/permanentBistro/types';
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
  MiniAreaItem,
  MiniGroupItem,
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
function miniArea(over: Partial<MiniAreaItem> = {}): MiniAreaItem {
  return { id: nextId(), yardstickId: null, kind: 'miniArea', shape: 'box', x: 0, y: 0, width: 50, height: 50, ...over };
}
function miniGroup(over: Partial<MiniGroupItem> = {}): MiniGroupItem {
  return { id: nextId(), yardstickId: null, kind: 'miniGroup', memberIds: [], ...over };
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

function baseInputs(over: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    santasFootage: 100,
    santasDifficulty: 'medium',
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'medium',
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'medium',
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'medium',
    miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 9 }], // a "form" item
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
    ...over,
  };
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
  it.each<Surface>(['santas-roofline', 'gingerbread', 'winter-wonderland', 'stake-lighting'])(
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

describe('projectScene — recommended flag (#12)', () => {
  it('carries recommended from each scene item onto its projected line item', () => {
    const p = projectScene(scene([
      strand({ id: 'b1', surface: 'bush', recommended: true }),
      wreath({ id: 'w1', recommended: true }),
      spritzer({ id: 's1' }), // not recommended
      garland({ id: 'g1', recommended: true }),
      bow({ id: 'bo1' }), // not recommended
    ]));
    const byId = Object.fromEntries(p.items.map((i) => [i.id, i.recommended]));
    expect(byId['mini-b1']).toBe(true);
    expect(byId['wreath-w1']).toBe(true);
    expect(byId['spritzer-s1']).toBeUndefined();
    expect(byId['garland-g1']).toBe(true);
    expect(byId['bow-bo1']).toBeUndefined();
  });

  it('does not affect the per-category pricing arrays', () => {
    const p = projectScene(scene([strand({ surface: 'bush', stringCount: 2, recommended: true })]));
    // recommended rides on `items` only — the engine inputs are unchanged.
    expect(p.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 2 }]);
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
  it('uses staff-set quoteSize + tier, IGNORING the drawn visual size', () => {
    const p = projectScene(scene([
      wreath({ sizeIn: 60, quoteSize: '30noble', tier: 'bow' }),
      wreath({ sizeIn: 60, quoteSize: '48noble', tier: 'fullDecor' }),
    ]));
    expect(p.wreaths).toEqual([
      { size: '30noble', tier: 'bow', quantity: 1 },
      { size: '48noble', tier: 'fullDecor', quantity: 1 },
    ]);
  });

  it('defaults to 36" Noble + Non-Decorated when unset', () => {
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
  it('text renders but produces no line item', () => {
    const p = projectScene(scene([text()]));
    expect(p.items).toEqual([]);
  });
});

describe('projectScene — standalone bows (#28)', () => {
  it('projects each drawn bow per-instance: one "Bow" unit, qty 1, linked to its scene item', () => {
    const p = projectScene(scene([bow({ id: 'b1' }), bow({ id: 'b2' })]));
    expect(p.items).toEqual([
      { id: 'bow-b1', category: 'bow', sceneItemIds: ['b1'], input: { quantity: 1 } },
      { id: 'bow-b2', category: 'bow', sceneItemIds: ['b2'], input: { quantity: 1 } },
    ]);
    expect(p.bows).toEqual([{ quantity: 1 }, { quantity: 1 }]);
  });

  it('skips a bow toggled off (included: false)', () => {
    const p = projectScene(scene([bow({ included: false })]));
    expect(p.items).toEqual([]);
    expect(p.bows).toEqual([]);
  });
});

describe('applyProjectionToInputs — design overrides per-unit, else falls back', () => {
  it('replaces the per-unit arrays when the scene HAS per-unit items', () => {
    const s = scene([
      strand({ id: 'b', surface: 'tree', stringCount: 2, wrapStyle: 'trunk' }),
      wreath({ id: 'w', quoteSize: '24noble', tier: 'bow' }),
    ]);
    const out = applyProjectionToInputs(baseInputs(), s);
    // #104: the priced inputs now carry the projected stable id + scene item ids.
    expect(out.miniLightItems).toEqual([
      { type: 'tree', wrapStyle: 'trunk', stringCount: 2, id: 'mini-b', sceneItemIds: ['b'] },
    ]); // not the form's bush/9
    expect(out.wreaths).toEqual([
      { size: '24noble', tier: 'bow', quantity: 1, id: 'wreath-w', sceneItemIds: ['w'] },
    ]);
    expect(out.spritzers).toEqual([]);
    expect(out.garland).toEqual([]);
  });

  it('passes roofline + custom items + fees through untouched', () => {
    const s = scene([strand({ surface: 'bush', stringCount: 1 })]);
    const inputs = baseInputs({
      santasFootage: 180,
      // #102: a per-quote custom $/ft override must survive design projection
      // (the spread preserves it) so a design-linked quote keeps its custom rate.
      santasCustomRate: 7,
      stakeLightingCustomRate: 4.5,
      customLineItems: [{ label: 'Custom', amount: 99 }],
      rushFee: true,
      takedown: 'premium',
    });
    const out = applyProjectionToInputs(inputs, s);
    expect(out.santasFootage).toBe(180);
    expect(out.santasCustomRate).toBe(7); // #102 override preserved
    expect(out.stakeLightingCustomRate).toBe(4.5);
    expect(out.customLineItems).toEqual([{ label: 'Custom', amount: 99 }]);
    expect(out.rushFee).toBe(true);
    expect(out.takedown).toBe('premium');
  });

  it('returns inputs UNCHANGED when the scene has NO per-unit items (form fallback)', () => {
    const rooflineOnly = scene([strand({ bulbType: 'c9', surface: 'santas-roofline' })]);
    const inputs = baseInputs();
    const out = applyProjectionToInputs(inputs, rooflineOnly);
    expect(out).toBe(inputs); // same reference — untouched
  });

  it('returns inputs UNCHANGED for an empty scene', () => {
    const inputs = baseInputs();
    expect(applyProjectionToInputs(inputs, scene([]))).toBe(inputs);
  });

  // Audit fix (Finding #103): an all-excluded design must DROP the stale manual
  // per-unit arrays, not silently resurrect the very items staff toggled off.
  it('replaces per-unit arrays with empties when EVERY per-unit item is excluded', () => {
    const s = scene([
      wreath({ included: false }),
      strand({ surface: 'bush', included: false }),
    ]);
    const inputs = baseInputs({
      miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 3 }],
      wreaths: [{ size: '48noble', tier: 'bow', quantity: 1 }],
    });
    const out = applyProjectionToInputs(inputs, s);
    expect(out).not.toBe(inputs); // replaced, not passed through
    expect(out.miniLightItems).toEqual([]);
    expect(out.wreaths).toEqual([]);
    expect(out.spritzers).toEqual([]);
    expect(out.garland).toEqual([]);
  });
});

describe('projectScene — hasProjectableItems (Finding #103)', () => {
  it('is true when a per-unit item exists even if excluded', () => {
    expect(projectScene(scene([wreath({ included: false })])).hasProjectableItems).toBe(true);
  });
  it('is false for a roofline-only scene', () => {
    expect(projectScene(scene([strand({ surface: 'santas-roofline' })])).hasProjectableItems).toBe(false);
  });
  it('is false for an empty scene', () => {
    expect(projectScene(scene([])).hasProjectableItems).toBe(false);
  });
});

describe('projectScene — needsReview cue for defaulted bindings (Finding #38)', () => {
  it('flags a wreath with undefined quoteSize as needsReview at the default tier', () => {
    const p = projectScene(scene([wreath({ id: 'w', tier: 'bow' })])); // quoteSize undefined
    const w = p.items.find((i) => i.id === 'wreath-w');
    expect(w?.needsReview).toBe(true);
    expect(p.wreaths).toEqual([{ size: '36noble', tier: 'bow', quantity: 1 }]);
  });
  it('a fully-bound wreath has needsReview false', () => {
    const p = projectScene(scene([wreath({ id: 'w', quoteSize: '24noble', tier: 'fullDecor' })]));
    expect(p.items.find((i) => i.id === 'wreath-w')?.needsReview).toBe(false);
  });
  it('flags a spritzer with undefined quoteSize', () => {
    const p = projectScene(scene([spritzer({ id: 's' })]));
    expect(p.items.find((i) => i.id === 'spritzer-s')?.needsReview).toBe(true);
  });
  it('a bound spritzer has needsReview false', () => {
    const p = projectScene(scene([spritzer({ id: 's', quoteSize: '24' })]));
    expect(p.items.find((i) => i.id === 'spritzer-s')?.needsReview).toBe(false);
  });
  it('flags a garland with undefined quoteLength/tier', () => {
    const p = projectScene(scene([garland({ id: 'g' })]));
    expect(p.items.find((i) => i.id === 'garland-g')?.needsReview).toBe(true);
  });
  it('a fully-bound garland has needsReview false', () => {
    const p = projectScene(scene([garland({ id: 'g', quoteLength: '9ft', tier: 'fullDecor' })]));
    expect(p.items.find((i) => i.id === 'garland-g')?.needsReview).toBe(false);
  });
});

describe('projectScene — A2 mini-light areas + grouped railings', () => {
  it('projects a miniArea (bush) as one mini unit, hideable by its own id', () => {
    const p = projectScene(scene([miniArea({ id: 'a1', surface: 'bush', wrapStyle: 'canopy', stringCount: 4 })]));
    expect(p.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 4 }]);
    expect(p.items[0]).toEqual({ id: 'mini-a1', category: 'mini', sceneItemIds: ['a1'], input: { type: 'bush', wrapStyle: 'canopy', stringCount: 4 } });
  });

  it('miniArea defaults wrapStyle→canopy, stringCount→1', () => {
    const p = projectScene(scene([miniArea({ surface: 'tree' })]));
    expect(p.miniLightItems).toEqual([{ type: 'tree', wrapStyle: 'canopy', stringCount: 1 }]);
  });

  it('miniArea without a surface tag is not projected', () => {
    const p = projectScene(scene([miniArea({})]));
    expect(p.items).toEqual([]);
  });

  it('projects a miniGroup as one mini unit; sceneItemIds = the member strands', () => {
    const p = projectScene(scene([
      strand({ id: 's1', surface: 'bush', groupId: 'g1' }),
      strand({ id: 's2', surface: 'bush', groupId: 'g1' }),
      strand({ id: 's3', surface: 'bush', groupId: 'g1' }),
      miniGroup({ id: 'g1', surface: 'bush', stringCount: 3, memberIds: ['s1', 's2', 's3'] }),
    ]));
    expect(p.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 3 }]);
    expect(p.items[0].sceneItemIds).toEqual(['s1', 's2', 's3']);
    expect(p.items[0].id).toBe('mini-g1');
  });

  it('miniGroup with no members falls back to its own id', () => {
    const p = projectScene(scene([miniGroup({ id: 'g0', surface: 'bush', memberIds: [] })]));
    expect(p.items[0].sceneItemIds).toEqual(['g0']);
  });

  it('SKIPS a grouped strand (priced via its group — no double count)', () => {
    const p = projectScene(scene([
      strand({ id: 's1', surface: 'bush', stringCount: 1, groupId: 'g1' }),
      strand({ id: 's2', surface: 'bush', stringCount: 1, groupId: 'g1' }),
      miniGroup({ id: 'g1', surface: 'bush', stringCount: 5, memberIds: ['s1', 's2'] }),
    ]));
    // Only the group prices (the two grouped strands are skipped).
    expect(p.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 5 }]);
    expect(p.items.map((i) => i.id)).toEqual(['mini-g1']);
  });

  it('counts strand-wrap + area + group as exactly one unit each', () => {
    const p = projectScene(scene([
      strand({ id: 'b1', surface: 'bush', stringCount: 1 }),       // ungrouped wrap → 1
      miniArea({ id: 'a1', surface: 'bush', stringCount: 2 }),     // area → 1
      strand({ id: 'm1', surface: 'bush', groupId: 'g1' }),        // grouped → skip
      miniGroup({ id: 'g1', surface: 'bush', memberIds: ['m1'] }), // group → 1
    ]));
    expect(p.miniLightItems).toHaveLength(3);
    expect(p.items.map((i) => i.id)).toEqual(['mini-b1', 'mini-a1', 'mini-g1']);
  });

  it('projects a railing surface (grouped strands) as a mini unit of type railing', () => {
    const p = projectScene(scene([
      strand({ id: 's1', surface: 'railing', groupId: 'rail1' }),
      strand({ id: 's2', surface: 'railing', groupId: 'rail1' }),
      miniGroup({ id: 'rail1', surface: 'railing', stringCount: 7, memberIds: ['s1', 's2'] }),
    ]));
    expect(p.miniLightItems).toEqual([{ type: 'railing', wrapStyle: 'canopy', stringCount: 7 }]);
    expect(p.items[0].sceneItemIds).toEqual(['s1', 's2']); // hides as its member strands
  });

  // #227: a miniGroup whose member strands have ALL been deleted (dangling —
  // unselectable in the editor, zero points to render) must never bill.
  it('#227 SKIPS a fully orphaned miniGroup (all members deleted, none survive)', () => {
    const p = projectScene(scene([
      miniGroup({ id: 'g1', surface: 'bush', stringCount: 8, memberIds: ['dead-1', 'dead-2'] }),
    ]));
    expect(p.items).toEqual([]);
    expect(p.miniLightItems).toEqual([]);
  });

  it('#227 still bills a PARTIALLY orphaned miniGroup normally (at least one member alive)', () => {
    const p = projectScene(scene([
      strand({ id: 's1', surface: 'bush', groupId: 'g1' }), // the one survivor
      miniGroup({ id: 'g1', surface: 'bush', stringCount: 4, memberIds: ['s1', 'dead-2', 'dead-3'] }),
    ]));
    expect(p.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 4 }]);
    // Unchanged shape/ids vs. a healthy group — same as before the #227 fix.
    expect(p.items[0]).toEqual({
      id: 'mini-g1',
      category: 'mini',
      sceneItemIds: ['s1', 'dead-2', 'dead-3'],
      input: { type: 'bush', wrapStyle: 'canopy', stringCount: 4 },
      recommended: undefined,
    });
  });

  it('#227 a zero-member miniGroup is NOT treated as orphaned (falls back to its own id, as before)', () => {
    const p = projectScene(scene([miniGroup({ id: 'g0', surface: 'bush', memberIds: [] })]));
    expect(p.items[0].sceneItemIds).toEqual(['g0']);
  });
});

describe('projectScene — mixed scene preserves order + derived arrays', () => {
  it('items[] order matches scene order; arrays are the per-category slices', () => {
    const p = projectScene(scene([
      strand({ id: 'roof', bulbType: 'c9', surface: 'santas-roofline' }), // skipped (roofline = measurement-driven)
      wreath({ id: 'w', quoteSize: '24noble', tier: 'bow' }),
      strand({ id: 'bush', surface: 'bush', stringCount: 2 }),
      spritzer({ id: 'sp', quoteSize: '16' }),
      garland({ id: 'g', quoteLength: '9ft', quoteSections: 1, tier: 'bow' }),
      bow({ id: 'b' }), // projects as of #28
    ]));
    expect(p.items.map((i) => i.id)).toEqual(['wreath-w', 'mini-bush', 'spritzer-sp', 'garland-g', 'bow-b']);
    expect(p.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 2 }]);
    expect(p.spritzers).toEqual([{ size: '16', quantity: 1 }]);
    expect(p.wreaths).toEqual([{ size: '24noble', tier: 'bow', quantity: 1 }]);
    expect(p.garland).toEqual([{ length: '9ft', type: 'noble', tier: 'bow', quantity: 1 }]);
    expect(p.bows).toEqual([{ quantity: 1 }]);
  });
});

// ─── #13 linked twins — render-only depictions never project ────────────────
describe('projectScene — #13 linked twins', () => {
  it('skips twins in projection and per-unit items; canonical bills once', () => {
    const canonical = wreath({ id: 'w-canon', quoteSize: '24noble', tier: 'bow' });
    const twin = wreath({ id: 'w-twin', quoteSize: '24noble', tier: 'bow', photoId: 'p2', linkedToId: 'w-canon' });
    const p = projectScene(scene([canonical, twin]));
    expect(p.items.map((i) => i.id)).toEqual(['wreath-w-canon']);
    expect(p.wreaths).toEqual([{ size: '24noble', tier: 'bow', quantity: 1 }]);
  });
  it('a twin-only scene has no projectable items (legacy fallback preserved)', () => {
    const twin = wreath({ id: 'w-twin', linkedToId: 'gone' });
    const p = projectScene(scene([twin]));
    expect(p.items).toEqual([]);
    expect(p.hasProjectableItems).toBe(false);
  });
});

describe('bistro projection (event, #96)', () => {
  it('projects a drawn bistro strand to a footage-priced bistro run (not a mini)', () => {
    const p = projectScene(scene([strand({ id: 'b1', bulbType: 'bistro', points: [0, 0, 600, 0] })]));
    expect(p.bistro).toHaveLength(1);
    expect(p.bistro[0].footage).toBeCloseTo(12, 5); // 600px ÷ 50 px/ft fallback
    expect(p.bistro[0].sceneItemIds).toEqual(['b1']);
    expect(p.miniLightItems).toHaveLength(0);
  });

  it('a zero-length bistro strand contributes nothing', () => {
    const p = projectScene(scene([strand({ bulbType: 'bistro', points: [0, 0] })]));
    expect(p.bistro).toHaveLength(0);
  });

  it('applyProjectionToInputs sets inputs.event.bistro, preserving operator-typed event fields', () => {
    const inputs = baseInputs({ event: { barrelBoxes: 2, eventDate: '2026-07-18' } });
    const out = applyProjectionToInputs(inputs, scene([strand({ id: 'b1', bulbType: 'bistro', points: [0, 0, 600, 0] })]));
    expect(out.event?.bistro).toHaveLength(1);
    expect(out.event?.bistro?.[0].footage).toBeCloseTo(12, 5);
    expect(out.event?.barrelBoxes).toBe(2); // preserved
    expect(out.event?.eventDate).toBe('2026-07-18'); // preserved
  });

  it('a holiday design with no bistro/event gets no event block', () => {
    const out = applyProjectionToInputs(baseInputs(), scene([strand({ bulbType: 'c9', surface: 'santas-roofline' })]));
    expect(out.event).toBeUndefined();
  });
});

// ─── Fix #4 regression (commit 23ee261): the guard's added `p.bistro.length ===
// 0` clause made a roofline+bistro scene (no projectable per-unit items) fall
// through to the REPLACE path below, wiping the holiday quote's manual
// miniLightItems/wreaths/garland/spritzers/bows with empty arrays. Bistro must
// never be the reason those manual arrays get overwritten. ───────────────────
describe('applyProjectionToInputs — Fix #4: a detected bistro run must not wipe manual per-unit arrays', () => {
  it('preserves manual miniLightItems/wreaths/garland for a roofline+bistro scene (no projectable per-unit items)', () => {
    const s = scene([
      strand({ bulbType: 'c9', surface: 'santas-roofline' }), // roofline — measurement-driven, not projectable
      strand({ id: 'b1', bulbType: 'bistro', points: [0, 0, 600, 0] }), // bistro — no per-unit representation
    ]);
    // Sanity: this scene truly has no projectable per-unit items.
    expect(projectScene(s).hasProjectableItems).toBe(false);
    expect(projectScene(s).items).toEqual([]);
    expect(projectScene(s).bistro).toHaveLength(1);

    const inputs = baseInputs({
      miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 5 }],
      wreaths: [{ size: '48noble', tier: 'bow', quantity: 1 }],
      garland: [{ length: '9ft', type: 'noble', tier: 'fullDecor', quantity: 2 }],
    });
    const out = applyProjectionToInputs(inputs, s);

    // The manual arrays must survive UNTOUCHED — a bare bistro detection must
    // never trigger the REPLACE-with-empties path.
    expect(out.miniLightItems).toEqual([{ type: 'bush', wrapStyle: 'canopy', stringCount: 5 }]);
    expect(out.wreaths).toEqual([{ size: '48noble', tier: 'bow', quantity: 1 }]);
    expect(out.garland).toEqual([{ length: '9ft', type: 'noble', tier: 'fullDecor', quantity: 2 }]);
    // ...while the detected bistro run is still attached to the event block.
    expect(out.event?.bistro).toHaveLength(1);
    expect(out.event?.bistro?.[0].sceneItemIds).toEqual(['b1']);
  });

  it('control: a scene WITH a projectable per-unit item still REPLACES it, even alongside a bistro run', () => {
    const s = scene([
      strand({ id: 'bush1', surface: 'bush', stringCount: 2 }), // projectable per-unit item
      strand({ id: 'b1', bulbType: 'bistro', points: [0, 0, 600, 0] }), // bistro alongside it
    ]);
    const inputs = baseInputs({
      miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 9 }], // stale manual — must be replaced
    });
    const out = applyProjectionToInputs(inputs, s);
    expect(out.miniLightItems).toEqual([
      { type: 'bush', wrapStyle: 'canopy', stringCount: 2, id: 'mini-bush1', sceneItemIds: ['bush1'] },
    ]);
    expect(out.event?.bistro).toHaveLength(1);
  });
});

// ─── Permanent Bistro (#117) — the bistro TARGET block is serviceType-aware:
// 'permanent_bistro' routes drawn bistro strands to inputs.permanentBistro.bistro
// (calculatePermanentBistro's own input) instead of inputs.event.bistro. Every
// other serviceType (or omitted) keeps the original event target — the whole
// point of this PR is that this widening must NOT change event/holiday behavior
// one bit (every test above this block proves that byte-for-byte). ─────────────
describe('applyProjectionToInputs — serviceType-aware bistro target (#117)', () => {
  it("serviceType 'permanent_bistro' routes drawn bistro strands into inputs.permanentBistro.bistro, leaving inputs.event untouched", () => {
    const s = scene([strand({ id: 'b1', bulbType: 'bistro', points: [0, 0, 600, 0] })]);
    const out = applyProjectionToInputs(baseInputs(), s, 'permanent_bistro');
    expect(out.permanentBistro?.bistro).toHaveLength(1);
    expect(out.permanentBistro?.bistro?.[0].footage).toBeCloseTo(12, 5);
    expect(out.permanentBistro?.bistro?.[0].sceneItemIds).toEqual(['b1']);
    expect(out.event).toBeUndefined();
  });

  it('omitted serviceType still targets inputs.event.bistro (explicit regression lock)', () => {
    const s = scene([strand({ id: 'b1', bulbType: 'bistro', points: [0, 0, 600, 0] })]);
    const out = applyProjectionToInputs(baseInputs(), s);
    expect(out.event?.bistro).toHaveLength(1);
    expect(out.permanentBistro).toBeUndefined();
  });

  it("serviceType 'event' explicitly targets inputs.event.bistro (same as omitted)", () => {
    const s = scene([strand({ id: 'b1', bulbType: 'bistro', points: [0, 0, 600, 0] })]);
    const out = applyProjectionToInputs(baseInputs(), s, 'event');
    expect(out.event?.bistro).toHaveLength(1);
    expect(out.permanentBistro).toBeUndefined();
  });

  it('a bistro quote reopened with strands deleted clears permanentBistro.bistro, preserving poles — parity with the event bistro-clear semantics', () => {
    // A remaining projectable item (unrelated to bistro) pushes this through the
    // REPLACE branch (mirrors the existing "control" test above), where the
    // presence-gated clear lives.
    const s = scene([wreath({ id: 'w1', quoteSize: '24noble', tier: 'bow' })]); // no bistro strand anymore
    const inputs = baseInputs({
      permanentBistro: { bistro: [{ footage: 20, id: 'bistro-old', sceneItemIds: ['old'] }], poles: 3 },
    });
    const out = applyProjectionToInputs(inputs, s, 'permanent_bistro');
    expect(out.permanentBistro?.bistro).toEqual([]); // stale run cleared
    expect(out.permanentBistro?.poles).toBe(3); // preserved, mirrors event's barrel/date preserve
    expect(out.event).toBeUndefined();
  });

  it('end-to-end: a drawn bistro strand prices at $30/ft through calculatePermanentBistro', () => {
    const s = scene([strand({ id: 'b1', bulbType: 'bistro', points: [0, 0, 1500, 0] })]); // 1500px ÷ 50px/ft fallback = 30ft
    const inputs = applyProjectionToInputs(baseInputs(), s, 'permanent_bistro');
    const result = calculatePermanentBistro(inputs, DEFAULT_PERMANENT_BISTRO_RATES);
    expect(result.lineItems).toHaveLength(1);
    expect(result.subtotalBeforeDiscount).toBe(900); // 30ft × $30/ft
  });
});
