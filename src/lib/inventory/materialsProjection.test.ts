// src/lib/inventory/materialsProjection.test.ts
import { describe, it, expect } from 'vitest';
import { projectMaterials, aggregateMaterials } from './materialsProjection';
import type { Scene, SceneItem } from '@/lib/design/sceneTypes';
import type { Bindings } from './bindings';

const scene = (items: SceneItem[]): Scene => ({ yardsticks: [], items });

// Minimal item factories — the projector only reads the fields set here.
const W = (id: string, quoteSize?: string, tier?: string, included = true): SceneItem =>
  ({ kind: 'wreath', id, quoteSize, tier, included }) as unknown as SceneItem;
const G = (id: string, quoteLength?: string, quoteSections?: number, tier?: string): SceneItem =>
  ({ kind: 'garland', id, quoteLength, quoteSections, tier, included: true }) as unknown as SceneItem;
const SP = (id: string, quoteSize?: string, colorPattern?: string[]): SceneItem =>
  ({ kind: 'spritzer', id, quoteSize, colorPattern, included: true }) as unknown as SceneItem;
const MINI = (id: string, surface?: string, stringCount?: number, colorPattern?: string[], groupId?: string): SceneItem =>
  ({ kind: 'strand', id, surface, stringCount, colorPattern, groupId, included: true }) as unknown as SceneItem;
const AREA = (id: string, surface: string, stringCount: number, colorPattern: string[]): SceneItem =>
  ({ kind: 'miniArea', id, surface, stringCount, colorPattern, included: true }) as unknown as SceneItem;
const GROUP = (id: string, surface: string, stringCount: number): SceneItem =>
  ({ kind: 'miniGroup', id, surface, stringCount, memberIds: [], included: true }) as unknown as SceneItem;
const ROOF = (id: string, surface?: string): SceneItem =>
  ({ kind: 'strand', id, surface, included: true }) as unknown as SceneItem;

const B: Bindings = {
  'wreath:36noble': 'W36',
  'wreath-bow:36noble': 'BOW36',
  'wreath-fee:36noble': '1102',
  'garland:9ft': 'G9',
  'garland-bow': 'GBOW',
  'garland-fee': '1106',
  'spritzer:red:24': 'SP24RED',
  'spritzer-pole:24': 'POLE24',
  'mini:Warm White': 'MINIWW',
};

describe('projectMaterials — wreaths', () => {
  it('decorated wreath → base + bow + fee', () => {
    const lines = projectMaterials(scene([W('w1', '36noble', 'fullDecor')]), B);
    expect(lines).toEqual([
      { sku: 'W36', qty: 1, category: 'wreath', conceptKey: 'wreath:36noble', label: '36" Noble wreath', sceneItemId: 'w1' },
      { sku: 'BOW36', qty: 1, category: 'wreath-bow', conceptKey: 'wreath-bow:36noble', label: '36" Noble wreath bow', sceneItemId: 'w1' },
      { sku: '1102', qty: 1, category: 'wreath-fee', conceptKey: 'wreath-fee:36noble', label: '36" Noble wreath decoration', sceneItemId: 'w1' },
    ]);
  });
  it('non-decorated wreath → base + bow (a bow ships with every wreath), no fee', () => {
    const lines = projectMaterials(scene([W('w1', '36noble', 'bow')]), B);
    expect(lines.map((l) => l.category)).toEqual(['wreath', 'wreath-bow']);
  });
  it('unset size/tier default to 36noble/bow; both unbound → sku null', () => {
    const lines = projectMaterials(scene([W('w1')]), {});
    expect(lines.map((l) => [l.category, l.sku])).toEqual([
      ['wreath', null],
      ['wreath-bow', null],
    ]);
  });
});

describe('projectMaterials — garland / spritzer / mini', () => {
  it('decorated garland scales base by sections; bow + fee ×1', () => {
    const lines = projectMaterials(scene([G('g1', '9ft', 2, 'fullDecor')]), B);
    expect(lines).toEqual([
      { sku: 'G9', qty: 2, category: 'garland', conceptKey: 'garland:9ft', label: '9ft garland × 2', sceneItemId: 'g1' },
      { sku: 'GBOW', qty: 1, category: 'garland-bow', conceptKey: 'garland-bow', label: 'garland bow', sceneItemId: 'g1' },
      { sku: '1106', qty: 1, category: 'garland-fee', conceptKey: 'garland-fee', label: 'garland decoration', sceneItemId: 'g1' },
    ]);
  });
  it('spritzer → spritzer (color×size) + pole', () => {
    const lines = projectMaterials(scene([SP('s1', '24', ['red'])]), B);
    expect(lines.map((l) => [l.category, l.sku])).toEqual([
      ['spritzer', 'SP24RED'],
      ['spritzer-pole', 'POLE24'],
    ]);
  });
  it('mini strand → mini SKU × stringCount, color label mapped from palette', () => {
    const lines = projectMaterials(scene([MINI('m1', 'tree', 3, ['warm-white'])]), B);
    expect(lines).toEqual([
      { sku: 'MINIWW', qty: 3, category: 'mini', conceptKey: 'mini:Warm White', label: 'Warm White mini (tree) × 3', sceneItemId: 'm1' },
    ]);
  });
  it('mini palette cool-white maps to catalog "Pure White" key', () => {
    const lines = projectMaterials(scene([MINI('m1', 'bush', 1, ['cool-white'])]), B);
    expect(lines[0].conceptKey).toBe('mini:Pure White');
  });
  it('mini-area projects like a strand', () => {
    const lines = projectMaterials(scene([AREA('a1', 'bush', 2, ['warm-white'])]), B);
    expect(lines).toEqual([
      { sku: 'MINIWW', qty: 2, category: 'mini', conceptKey: 'mini:Warm White', label: 'Warm White mini (bush) × 2', sceneItemId: 'a1' },
    ]);
  });
  it('mini-group has no colorPattern → defaults to the warm-white key', () => {
    const lines = projectMaterials(scene([GROUP('g1', 'railing', 4)]), B);
    expect(lines).toEqual([
      { sku: 'MINIWW', qty: 4, category: 'mini', conceptKey: 'mini:Warm White', label: 'Warm White mini (railing) × 4', sceneItemId: 'g1' },
    ]);
  });
});

describe('projectMaterials — skips', () => {
  it('skips excluded items and grouped strands', () => {
    const excluded = { ...(W('w1', '36noble', 'bow') as object), included: false } as unknown as SceneItem;
    const grouped = MINI('m1', 'tree', 2, ['warm-white'], 'grp1');
    expect(projectMaterials(scene([excluded, grouped]), B)).toEqual([]);
  });
  it('does not project roofline / unmapped strands (the 2a/2b seam)', () => {
    expect(projectMaterials(scene([ROOF('r1', 'santas-roofline'), ROOF('r2')]), B)).toEqual([]);
  });
});

describe('aggregateMaterials', () => {
  it('sums by sku, drops unbound, sorts', () => {
    const lines = projectMaterials(scene([W('a', '36noble', 'fullDecor'), W('b', '36noble', 'fullDecor')]), B);
    // two decorated 36" wreaths → W36 ×2, BOW36 ×2, 1102 ×2
    expect(aggregateMaterials(lines)).toEqual([
      { sku: '1102', qty: 2 },
      { sku: 'BOW36', qty: 2 },
      { sku: 'W36', qty: 2 },
    ]);
  });
  it('drops null skus', () => {
    const lines = projectMaterials(scene([W('w1', '24noble', 'bow')]), B); // 24noble unbound
    expect(aggregateMaterials(lines)).toEqual([]);
  });
});
