import { describe, it, expect } from 'vitest';
import { attachSceneLinks } from './sceneLinks';
import type { Scene, SceneItem } from '@/lib/design/sceneTypes';
import type { PortalLineItem } from '@/components/portal/types';

function strand(id: string, surface: SceneItem['surface'], over: Partial<Extract<SceneItem, { kind: 'strand' }>> = {}) {
  return {
    id,
    yardstickId: null,
    kind: 'strand' as const,
    bulbType: surface && ['bush', 'tree', 'column'].includes(surface) ? ('mini' as const) : ('c9' as const),
    spacingIn: 6,
    drawingStyle: 'strand' as const,
    colorPattern: ['warm'],
    points: [0, 0, 10, 0],
    surface,
    ...over,
  };
}
function wreath(id: string) {
  return { id, yardstickId: null, kind: 'wreath' as const, x: 0, y: 0, sizeIn: 30, withLights: true };
}
function spritzer(id: string) {
  return { id, yardstickId: null, kind: 'spritzer' as const, x: 0, y: 0, sizeIn: 24, colorPattern: ['warm'] };
}
function garland(id: string) {
  return { id, yardstickId: null, kind: 'garland' as const, points: [0, 0, 10, 0], drawingStyle: 'strand' as const, withLights: true };
}

const li = (id: string, kind: PortalLineItem['kind']): PortalLineItem => ({ id, kind, label: id, detail: '', price: 10 });
// #104 PR2: a line item carrying the engine's stable id (post-#104 saved results).
const liId = (
  id: string,
  kind: PortalLineItem['kind'],
  stableId: string,
  over: Partial<PortalLineItem> = {},
): PortalLineItem => ({ id, kind, label: id, detail: '', price: 10, stableId, ...over });

describe('attachSceneLinks', () => {
  const scene: Scene = {
    yardsticks: [],
    items: [
      strand('rs1', 'santas-roofline'),
      strand('rg1', 'gingerbread'),
      strand('ww1', 'winter-wonderland'),
      strand('stk1', 'stake-lighting'),
      strand('b1', 'bush', { stringCount: 2 }),
      strand('b2', 'bush', { stringCount: 1 }),
      spritzer('sp1'),
      wreath('wr1'),
      garland('g1'),
    ] as SceneItem[],
  };

  const lineItems: PortalLineItem[] = [
    li('roofline-santas', 'roofline'),
    li('roofline-gingerbread', 'ridge'),
    li('ridge-2', 'ridge'), // Winter Wonderland
    li('stake-lighting-1', 'stake-lighting'),
    li('bush-1', 'bush'),
    li('bush-2', 'bush'),
    li('spritzer-1', 'spritzer'),
    li('wreath-1', 'wreath'),
    li('garland-1', 'garland'),
    li('roofline-3', 'roofline'), // a custom/unknown fallback item → no link
  ];

  const out = attachSceneLinks(lineItems, scene);
  const byId = Object.fromEntries(out.map((l) => [l.id, l.sceneItemIds]));

  it("Santa's roofline links to the santas-roofline strands", () => {
    expect(byId['roofline-santas']).toEqual(['rs1']);
  });

  it('Gingerbread links to santas + gingerbread strands (superset)', () => {
    expect(byId['roofline-gingerbread']).toEqual(['rs1', 'rg1']);
  });

  it('Winter Wonderland links to winter-wonderland strands', () => {
    expect(byId['ridge-2']).toEqual(['ww1']);
  });

  it('Stake Lighting links to stake-lighting strands by its own kind', () => {
    expect(byId['stake-lighting-1']).toEqual(['stk1']);
  });

  it('per-unit items link by category order', () => {
    expect(byId['bush-1']).toEqual(['b1']);
    expect(byId['bush-2']).toEqual(['b2']);
    expect(byId['spritzer-1']).toEqual(['sp1']);
    expect(byId['wreath-1']).toEqual(['wr1']);
    expect(byId['garland-1']).toEqual(['g1']);
  });

  it('leaves unmatched / custom items without scene links', () => {
    expect(byId['roofline-3']).toBeUndefined();
  });

  it('does not mutate the input array', () => {
    expect(lineItems[0].sceneItemIds).toBeUndefined();
  });
});

describe('attachSceneLinks — carries recommended (#12)', () => {
  const scene: Scene = {
    yardsticks: [],
    items: [
      strand('b1', 'bush', { stringCount: 1, recommended: true }),
      strand('b2', 'bush', { stringCount: 1 }), // not recommended
      wreath('wr1'),
    ] as SceneItem[],
  };
  // mark the wreath recommended
  (scene.items[2] as { recommended?: boolean }).recommended = true;

  const lineItems: PortalLineItem[] = [
    li('bush-1', 'bush'),
    li('bush-2', 'bush'),
    li('wreath-1', 'wreath'),
  ];

  const out = attachSceneLinks(lineItems, scene);
  const byId = Object.fromEntries(out.map((l) => [l.id, l]));

  it('sets recommended on the rows whose scene item is recommended', () => {
    expect(byId['bush-1'].recommended).toBe(true);
    expect(byId['wreath-1'].recommended).toBe(true);
  });

  it('leaves recommended unset on rows whose scene item is not recommended', () => {
    expect(byId['bush-2'].recommended).toBeUndefined();
  });

  it('never marks roofline option rows recommended (own mechanism)', () => {
    const rfScene: Scene = {
      yardsticks: [],
      items: [strand('rs1', 'santas-roofline', { recommended: true })] as SceneItem[],
    };
    const rfOut = attachSceneLinks([li('roofline-santas', 'roofline')], rfScene);
    // roofline strands aren't projected, so no recommended leaks onto the option row.
    expect(rfOut[0].recommended).toBeUndefined();
  });

  it('carries recommended onto the Winter Wonderland (ridge) row from its strands (Jason S12)', () => {
    const wwScene: Scene = {
      yardsticks: [],
      items: [strand('ww1', 'winter-wonderland', { recommended: true })] as SceneItem[],
    };
    const wwOut = attachSceneLinks([li('ridge-2', 'ridge')], wwScene);
    expect(wwOut[0].sceneItemIds).toEqual(['ww1']);
    expect(wwOut[0].recommended).toBe(true);
  });

  it('leaves Winter Wonderland un-recommended when its strands are not flagged', () => {
    const wwScene: Scene = {
      yardsticks: [],
      items: [strand('ww1', 'winter-wonderland')] as SceneItem[],
    };
    const wwOut = attachSceneLinks([li('ridge-2', 'ridge')], wwScene);
    expect(wwOut[0].recommended).toBeUndefined();
  });

  it('carries recommended onto the Stake Lighting row from its strands', () => {
    const stakeScene: Scene = {
      yardsticks: [],
      items: [strand('stk1', 'stake-lighting', { recommended: true })] as SceneItem[],
    };
    const stakeOut = attachSceneLinks([li('stake-lighting-1', 'stake-lighting')], stakeScene);
    expect(stakeOut[0].sceneItemIds).toEqual(['stk1']);
    expect(stakeOut[0].recommended).toBe(true);
  });
});

// AUDIT FIX (#33) — count-mismatch guard. If the design is edited after the last
// Calculate, the frozen per-category line-item count can diverge from the live
// projection count. The positional zip would otherwise mis-link; the guard skips
// per-unit linking for any category whose counts don't match (rows stay priced +
// visible), without affecting roofline (linked by surface tag) or other categories.
describe('attachSceneLinks — count-mismatch guard (#33)', () => {
  it('skips per-unit linking when a frozen 3-item category meets a live 2-item projection', () => {
    // Scene was edited down to 2 bushes after a 3-bush quote was frozen.
    const scene: Scene = {
      yardsticks: [],
      items: [strand('b1', 'bush', { stringCount: 1 }), strand('b2', 'bush', { stringCount: 1 })] as SceneItem[],
    };
    const lineItems: PortalLineItem[] = [li('bush-1', 'bush'), li('bush-2', 'bush'), li('bush-3', 'bush')];
    const out = attachSceneLinks(lineItems, scene);
    const byId = Object.fromEntries(out.map((l) => [l.id, l.sceneItemIds]));
    // None mis-linked — all three stay unlinked rather than zipping b1/b2 onto the wrong rows.
    expect(byId['bush-1']).toBeUndefined();
    expect(byId['bush-2']).toBeUndefined();
    expect(byId['bush-3']).toBeUndefined();
  });

  it('never carries recommended across a count mismatch', () => {
    const scene: Scene = {
      yardsticks: [],
      items: [strand('b1', 'bush', { stringCount: 1, recommended: true })] as SceneItem[],
    };
    // Frozen 2 bush rows vs live 1 projected bush → mismatch → no recommended leak.
    const out = attachSceneLinks([li('bush-1', 'bush'), li('bush-2', 'bush')], scene);
    const byId = Object.fromEntries(out.map((l) => [l.id, l]));
    expect(byId['bush-1'].recommended).toBeUndefined();
    expect(byId['bush-1'].sceneItemIds).toBeUndefined();
  });

  it('only the mismatched category is skipped — matched categories still link', () => {
    // bush mismatches (2 frozen vs 1 live), wreath matches (1 frozen vs 1 live).
    const scene: Scene = {
      yardsticks: [],
      items: [strand('b1', 'bush', { stringCount: 1 }), wreath('wr1')] as SceneItem[],
    };
    const out = attachSceneLinks([li('bush-1', 'bush'), li('bush-2', 'bush'), li('wreath-1', 'wreath')], scene);
    const byId = Object.fromEntries(out.map((l) => [l.id, l.sceneItemIds]));
    expect(byId['bush-1']).toBeUndefined();
    expect(byId['bush-2']).toBeUndefined();
    expect(byId['wreath-1']).toEqual(['wr1']); // unaffected category still links
  });

  it('roofline links by surface tag even when a per-unit category mismatches', () => {
    const scene: Scene = {
      yardsticks: [],
      items: [strand('rs1', 'santas-roofline'), strand('b1', 'bush', { stringCount: 1 })] as SceneItem[],
    };
    // bush mismatch (2 frozen vs 1 live) must not affect roofline-by-surface.
    const out = attachSceneLinks([li('roofline-santas', 'roofline'), li('bush-1', 'bush'), li('bush-2', 'bush')], scene);
    const byId = Object.fromEntries(out.map((l) => [l.id, l.sceneItemIds]));
    expect(byId['roofline-santas']).toEqual(['rs1']);
    expect(byId['bush-1']).toBeUndefined();
  });
});

// #104 PR2 — id-based linkage closes the #90 residual: a same-count reorder/swap
// (which slipped past the #33 count guard and mis-linked positionally) now links
// by the stable scene-item id instead. Legacy (no stableId) rows keep the zip.
describe('attachSceneLinks — id-based linkage (#104 PR2, closes #90)', () => {
  it('links by stable id, NOT list position — reorder/swap-proof', () => {
    // Frozen at scene order [b1, b2]; the scene was later REORDERED to [b2, b1]
    // (same count → the old positional zip mis-linked bush-1 → b2).
    const scene: Scene = {
      yardsticks: [],
      items: [strand('b2', 'bush', { stringCount: 1 }), strand('b1', 'bush', { stringCount: 2 })] as SceneItem[],
    };
    const out = attachSceneLinks([liId('bush-1', 'bush', 'mini-b1'), liId('bush-2', 'bush', 'mini-b2')], scene);
    const byId = Object.fromEntries(out.map((l) => [l.id, l.sceneItemIds]));
    expect(byId['bush-1']).toEqual(['b1']); // correct despite the reorder (was ['b2'] positionally)
    expect(byId['bush-2']).toEqual(['b2']);
  });

  it('drops a deleted item’s link but keeps survivors linked (vs the old skip-all)', () => {
    // b1 deleted; only b2 remains. The #33 count guard would skip the WHOLE category.
    const scene: Scene = {
      yardsticks: [],
      items: [strand('b2', 'bush', { stringCount: 1 })] as SceneItem[],
    };
    const out = attachSceneLinks([liId('bush-1', 'bush', 'mini-b1'), liId('bush-2', 'bush', 'mini-b2')], scene);
    const byId = Object.fromEntries(out.map((l) => [l.id, l.sceneItemIds]));
    expect(byId['bush-1']).toBeUndefined(); // its scene item is gone → link dropped
    expect(byId['bush-2']).toEqual(['b2']); // survivor still links
  });

  it('carries recommended by id even after a reorder', () => {
    const scene: Scene = {
      yardsticks: [],
      items: [
        strand('b2', 'bush', { stringCount: 1 }),
        strand('b1', 'bush', { stringCount: 1, recommended: true }),
      ] as SceneItem[],
    };
    const out = attachSceneLinks([liId('bush-1', 'bush', 'mini-b1'), liId('bush-2', 'bush', 'mini-b2')], scene);
    const byId = Object.fromEntries(out.map((l) => [l.id, l]));
    expect(byId['bush-1'].recommended).toBe(true); // b1 is recommended, matched by id
    expect(byId['bush-2'].recommended).toBeUndefined();
  });

  it('strips a stale sceneItemIds when the stable-id item is gone', () => {
    const scene: Scene = { yardsticks: [], items: [] as SceneItem[] };
    const out = attachSceneLinks([liId('bush-1', 'bush', 'mini-gone', { sceneItemIds: ['old'] })], scene);
    expect(out[0].sceneItemIds).toBeUndefined();
  });

  it('legacy rows (no stableId) still use the positional zip unchanged', () => {
    const scene: Scene = {
      yardsticks: [],
      items: [strand('b1', 'bush', { stringCount: 1 }), strand('b2', 'bush', { stringCount: 1 })] as SceneItem[],
    };
    const out = attachSceneLinks([li('bush-1', 'bush'), li('bush-2', 'bush')], scene);
    const byId = Object.fromEntries(out.map((l) => [l.id, l.sceneItemIds]));
    expect(byId['bush-1']).toEqual(['b1']);
    expect(byId['bush-2']).toEqual(['b2']);
  });
});

// ─── #13 linked twins — portal toggle reaches every depiction ────────────────
describe('attachSceneLinks — #13 linked twins', () => {
  it('expands a per-unit line\'s sceneItemIds with its canonical\'s twins', () => {
    const canonical = wreath('w-canon');
    const twin = { ...wreath('w-twin'), photoId: 'p2', linkedToId: 'w-canon' };
    const scene = { yardsticks: [], items: [canonical, twin] as SceneItem[] };
    const out = attachSceneLinks([li('wreath-1', 'wreath')], scene);
    expect(out[0].sceneItemIds).toEqual(['w-canon', 'w-twin']);
  });
  it('expands tag-linked roofline lines with strand twins too', () => {
    const canonical = strand('s-canon', 'santas-roofline');
    const twin = { ...strand('s-twin', 'santas-roofline'), photoId: 'p2', linkedToId: 's-canon' };
    const scene = { yardsticks: [], items: [canonical, twin] as SceneItem[] };
    const out = attachSceneLinks([li('roofline-santas', 'roofline')], scene);
    expect(out[0].sceneItemIds).toEqual(expect.arrayContaining(['s-canon', 's-twin']));
  });
});
