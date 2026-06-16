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

describe('attachSceneLinks', () => {
  const scene: Scene = {
    yardsticks: [],
    items: [
      strand('rs1', 'santas-roofline'),
      strand('rg1', 'gingerbread'),
      strand('ww1', 'winter-wonderland'),
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
});
