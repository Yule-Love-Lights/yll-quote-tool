import { describe, it, expect } from 'vitest';
import type { SceneItem, QuoteSpritzerSize } from '@/lib/design/sceneTypes';
import { resolveInstalls, offeredFromBindings, offeredColorLists, offeredIsKnown, resolveColorChoice, colorChoiceFromSnapshot, buildRenderColorMap, type OfferedColors } from './resolveInstalls';
import { miniKey, spritzerKey } from './concepts';
import { matchPattern } from './patternSkus';

const roof = (id: string): SceneItem =>
  ({ kind: 'strand', id, surface: 'santas-roofline', bulbType: 'c9', colorPattern: [], stringCount: 1, points: [0, 0, 1, 1], spacingIn: 12, drawingStyle: 'solid', yardstickId: null }) as unknown as SceneItem;

// ── minimal scene-item factories (cast partials; the resolver only reads a few fields) ──
const sp = (id: string, colors: string[], size: QuoteSpritzerSize = '24'): SceneItem =>
  ({ kind: 'spritzer', id, x: 0, y: 0, sizeIn: 24, colorPattern: colors, quoteSize: size, yardstickId: null }) as unknown as SceneItem;

const mini = (id: string, colors: string[], surface = 'bush'): SceneItem =>
  ({ kind: 'strand', id, surface, colorPattern: colors, stringCount: 1, points: [0, 0, 1, 1], bulbType: 'mini', spacingIn: 6, drawingStyle: 'solid', yardstickId: null }) as unknown as SceneItem;

const area = (id: string, colors: string[], surface = 'bush', groupId?: string): SceneItem =>
  ({ kind: 'miniArea', id, surface, shape: 'box', colorPattern: colors, stringCount: 1, groupId, yardstickId: null }) as unknown as SceneItem;

// build OfferedColors directly for resolver tests
const offered = (minis: string[], spritzers: Partial<Record<QuoteSpritzerSize, string[]>>): OfferedColors => ({
  miniHas: (id) => minis.includes(id),
  spritzerHas: (id, size) => (spritzers[size] ?? []).includes(id),
});

const ALL_MINI = ['warm-white', 'cool-white', 'red', 'green', 'blue', 'orange', 'yellow', 'pink', 'purple', 'teal'];
const SPRITZER_24 = ['warm-white', 'cool-white', 'red', 'green', 'blue', 'pink']; // no orange/yellow/purple/teal

describe('offeredFromBindings', () => {
  it('reads offered solids from the bindings map (mini by label, spritzer by id+size)', () => {
    const bindings = { [miniKey('Pure White')]: '40156', [spritzerKey('blue', '24')]: '61502' };
    const o = offeredFromBindings(bindings);
    expect(o.miniHas('cool-white')).toBe(true); // cool-white → "Pure White"
    expect(o.miniHas('orange')).toBe(false);
    expect(o.spritzerHas('blue', '24')).toBe(true);
    expect(o.spritzerHas('blue', '16')).toBe(false); // not bound at 16"
    expect(o.spritzerHas('orange', '24')).toBe(false);
  });

  // WT-22(a): the sold-out "locked" catalog flag was cosmetic — a locked-but-bound
  // sku still read as "offered", so detectUnfulfillable never flagged it and the
  // portal color picker/round-robin could still hand it out. Threading lockedSkus
  // through makes a locked sku read as NOT bound (not offered).
  it('a bound-but-LOCKED sku is NOT offered, even though the binding still exists', () => {
    const bindings = { [miniKey('Pure White')]: '40156', [spritzerKey('blue', '24')]: '61502' };
    const lockedSkus = new Set(['40156']);
    const o = offeredFromBindings(bindings, lockedSkus);
    expect(o.miniHas('cool-white')).toBe(false); // bound to a LOCKED sku → not offered
    expect(o.spritzerHas('blue', '24')).toBe(true); // different sku, not locked → unaffected
  });

  it('omitting lockedSkus keeps the old bound-is-offered behavior (backward compatible)', () => {
    const bindings = { [miniKey('Pure White')]: '40156' };
    expect(offeredFromBindings(bindings).miniHas('cool-white')).toBe(true);
  });
});

describe('offeredColorLists — forwards lockedSkus to offeredFromBindings (WT-22a)', () => {
  it('drops a locked mini color from the serialized offered list', () => {
    const bindings = { [miniKey('Pure White')]: '40156', [spritzerKey('blue', '24')]: '61502' };
    const lists = offeredColorLists(bindings, new Set(['40156']));
    expect(lists.mini).not.toContain('cool-white');
    expect(lists.spritzer['24']).toContain('blue');
  });
});

describe('resolveInstalls — strand path', () => {
  it('a whole-house pattern with a mini strand → every mini orders the strand (intermixed)', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([mini('b1', []), mini('b2', [])], ['red', 'green', 'cool-white'], o); // = Grinch
    for (const id of ['b1', 'b2']) {
      expect(got.get(id)).toEqual({ kind: 'strand', sku: '43346', colorIds: ['red', 'green', 'cool-white'], patternId: 'grinch' });
    }
  });

  it('an as-designed item whose own colors match a pattern → that strand', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([mini('b1', ['red', 'green', 'cool-white'])], null, o);
    expect(got.get('b1')).toMatchObject({ kind: 'strand', sku: '43346' });
  });
});

// #840 review fix: colorables() skipped a grouped STRAND (`if (item.groupId)
// continue`) but had no such guard for a grouped scattershot (miniArea) —
// letting one leak into the resolver's output, and (worse) consume a
// round-robin cursor slot meant for a real, ungrouped item.
describe('resolveInstalls — scattershot, incl. grouped (#240)', () => {
  it('an ungrouped scattershot resolves like a strand', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([area('a1', ['red', 'green', 'cool-white'])], null, o); // = Grinch
    expect(got.get('a1')).toMatchObject({ kind: 'strand', sku: '43346' });
  });

  it('a GROUPED scattershot gets NO entry at all — it is priced via its MiniGroupItem, not resolved individually', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([area('a1', ['red'], 'bush', 'grp1')], null, o);
    expect(got.has('a1')).toBe(false);
  });

  it('a grouped scattershot does NOT consume a round-robin slot meant for real items', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    // Without the guard, the grouped area would burn cursor index 0 (→ 'red'),
    // shifting b1/b2 to 'blue'/'red' instead of their correct 'red'/'blue'.
    const got = resolveInstalls(
      [area('a1', [], 'bush', 'grp1'), mini('b1', []), mini('b2', [])],
      ['red', 'blue'],
      o,
    );
    expect(got.get('b1')).toEqual({ kind: 'solid', colorId: 'red' });
    expect(got.get('b2')).toEqual({ kind: 'solid', colorId: 'blue' });
  });
});

describe('resolveInstalls — round-robin solids', () => {
  it('a pattern with NO spritzer strand → round-robin offered colors, dropping unavailable ones', () => {
    // Ocean = teal+blue+pure-white; no Ocean spritzer; teal not offered for spritzers.
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([sp('s1', []), sp('s2', []), sp('s3', [])], ['teal', 'blue', 'cool-white'], o);
    expect(got.get('s1')).toEqual({ kind: 'solid', colorId: 'blue' });
    expect(got.get('s2')).toEqual({ kind: 'solid', colorId: 'cool-white' });
    expect(got.get('s3')).toEqual({ kind: 'solid', colorId: 'blue' });
    // teal never appears (not offered for spritzers)
    expect([...got.values()].some((d) => d.kind === 'solid' && d.colorId === 'teal')).toBe(false);
  });

  it('a no-match combo → one solid per item, cycling in scene order', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([mini('b1', []), mini('b2', []), mini('b3', []), mini('b4', [])], ['red', 'blue', 'pink'], o);
    expect(got.get('b1')).toEqual({ kind: 'solid', colorId: 'red' });
    expect(got.get('b2')).toEqual({ kind: 'solid', colorId: 'blue' });
    expect(got.get('b3')).toEqual({ kind: 'solid', colorId: 'pink' });
    expect(got.get('b4')).toEqual({ kind: 'solid', colorId: 'red' }); // cycles
  });

  it('minis and spritzers cycle in separate cursors', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([mini('b1', []), sp('s1', []), mini('b2', []), sp('s2', [])], ['red', 'blue'], o);
    expect(got.get('b1')).toMatchObject({ colorId: 'red' });
    expect(got.get('b2')).toMatchObject({ colorId: 'blue' });
    expect(got.get('s1')).toMatchObject({ colorId: 'red' });
    expect(got.get('s2')).toMatchObject({ colorId: 'blue' });
  });
});

describe('resolveInstalls — as-designed keeps each item its own color', () => {
  it('no shuffle: each single-color item resolves to its own color', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([mini('b1', ['red']), mini('b2', ['blue'])], null, o);
    expect(got.get('b1')).toEqual({ kind: 'solid', colorId: 'red' });
    expect(got.get('b2')).toEqual({ kind: 'solid', colorId: 'blue' });
  });

  it('deterministic: two identical multi-color as-designed items resolve to the SAME solid (no cursor drift)', () => {
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    // {red,blue} is not a known pattern → solid path; as-designed must not round-robin.
    const got = resolveInstalls([mini('b1', ['red', 'blue']), mini('b2', ['red', 'blue'])], null, o);
    expect(got.get('b1')).toEqual({ kind: 'solid', colorId: 'red' });
    expect(got.get('b2')).toEqual({ kind: 'solid', colorId: 'red' }); // both first authored color, not red/blue
  });
});

describe('offeredIsKnown (fail-open guard)', () => {
  it('null / undefined → not known (gate fails open)', () => {
    expect(offeredIsKnown(null)).toBe(false);
    expect(offeredIsKnown(undefined)).toBe(false);
  });
  it('empty mini list (unconfigured bindings) → not known', () => {
    expect(offeredIsKnown({ mini: [], spritzer: { '16': [], '24': [], '32': [] } })).toBe(false);
  });
  it('a real catalog (minis offered) → known', () => {
    expect(offeredIsKnown({ mini: ['red', 'warm-white'], spritzer: { '24': ['red'] } })).toBe(true);
  });
});

describe('resolveColorChoice (snapshot → effective colors)', () => {
  it("'custom' returns the build-your-own colors; empty custom → null (as-designed)", () => {
    expect(resolveColorChoice('custom', ['red', 'green'])).toEqual(['red', 'green']);
    expect(resolveColorChoice('custom', [])).toBeNull();
  });

  it('a named scheme returns its color ids (which can then match a pattern)', () => {
    const ids = resolveColorChoice('christmas', []);
    expect(ids).not.toBeNull();
    expect(matchPattern(ids as string[])?.id).toBe('christmas');
  });

  it("'as-designed' / unknown / absent → null", () => {
    expect(resolveColorChoice('as-designed', [])).toBeNull();
    expect(resolveColorChoice(undefined, undefined)).toBeNull();
    expect(resolveColorChoice('not-a-real-scheme', [])).toBeNull();
  });

  it('resolves against an explicit operator scheme list (#101)', () => {
    const schemes = [
      { id: 'as-designed', label: 'x', colorIds: null },
      { id: 'red-gold', label: 'Red & Gold', colorIds: ['red', 'yellow'] },
    ];
    expect(resolveColorChoice('red-gold', [], schemes)).toEqual(['red', 'yellow']);
  });
});

describe('colorChoiceFromSnapshot (#101 frozen colorIds)', () => {
  it('prefers the frozen colorIds over re-resolving the scheme id', () => {
    // Operator later edited/removed 'christmas', but the order froze what the
    // customer saw → materials use the frozen colors, not a live re-resolve.
    const snap = { customerSelection: { colorSchemeId: 'christmas', customPattern: [], colorIds: ['red', 'green'] } };
    expect(colorChoiceFromSnapshot(snap)).toEqual(['red', 'green']);
  });

  it('frozen null → as-designed (no override)', () => {
    const snap = { customerSelection: { colorSchemeId: 'as-designed', customPattern: [], colorIds: null } };
    expect(colorChoiceFromSnapshot(snap)).toBeNull();
  });

  it('an OLD snapshot without frozen colorIds re-resolves the id (back-compat)', () => {
    const snap = { customerSelection: { colorSchemeId: 'christmas', customPattern: [] } };
    expect(colorChoiceFromSnapshot(snap)).not.toBeNull(); // re-resolved from built-in defaults
  });

  it('missing / un-approved snapshot → null', () => {
    expect(colorChoiceFromSnapshot(null)).toBeNull();
    expect(colorChoiceFromSnapshot({})).toBeNull();
  });
});

describe('buildRenderColorMap (per-item render colors)', () => {
  const o = offered(ALL_MINI, { '24': SPRITZER_24 });

  it('as-designed (null choice) → null (no override)', () => {
    expect(buildRenderColorMap([mini('b1', [])], null, o)).toBeNull();
  });

  it('matched pattern: minis render the strand colors (intermixed); strand-less spritzers render one solid', () => {
    const m = buildRenderColorMap([mini('b1', []), sp('s1', [])], ['red', 'green', 'cool-white'], o); // Grinch
    expect(m?.get('b1')).toEqual(['red', 'green', 'cool-white']); // intermixed strand
    expect(m?.get('s1')).toEqual(['red']); // no Grinch spritzer → one solid (round-robin start)
  });

  it('C9 roofline keeps the full choice cycle (multi-color is installable there)', () => {
    const m = buildRenderColorMap([roof('r1')], ['red', 'green', 'cool-white'], o);
    expect(m?.get('r1')).toEqual(['red', 'green', 'cool-white']);
  });

  it('no-match combo: each bush renders one solid, cycling', () => {
    const m = buildRenderColorMap([mini('b1', []), mini('b2', []), mini('b3', [])], ['red', 'blue', 'pink'], o);
    expect(m?.get('b1')).toEqual(['red']);
    expect(m?.get('b2')).toEqual(['blue']);
    expect(m?.get('b3')).toEqual(['pink']);
  });
});

describe('resolveInstalls — fallback when nothing offered', () => {
  it('a whole-house pick with no offered colors for the item → falls back to its as-designed color', () => {
    // orange+yellow: not a pattern, and neither is offered for spritzers.
    const o = offered(ALL_MINI, { '24': SPRITZER_24 });
    const got = resolveInstalls([sp('s1', ['blue'])], ['orange', 'yellow'], o);
    expect(got.get('s1')).toEqual({ kind: 'solid', colorId: 'blue' }); // kept its authored blue
  });
});
