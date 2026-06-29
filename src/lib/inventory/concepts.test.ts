// src/lib/inventory/concepts.test.ts
import { describe, it, expect } from 'vitest';
import {
  bulbC9Key, BISTRO_KEY, miniKey,
  wreathBaseKey, wreathBowKey, wreathFeeKey, garlandBaseKey,
  spritzerKey, spritzerPoleKey,
  bulbC9Rows, wreathBaseRows, wreathBowRows, wreathFeeRows, garlandBaseRows,
  miniRows, MINI_LIGHTS, SPRITZERS, spritzerRows,
  CLIP_FEATURES, DEFAULT_CLIP_SKUS, DEFAULT_WREATH_FEE_SKUS, DEFAULT_GARLAND_FEE_SKU,
  buildSeedBindings, buildSeedClipRules,
} from './concepts';

describe('concept key builders', () => {
  it('builds namespaced keys', () => {
    expect(bulbC9Key('warm-white')).toBe('bulb:warm-white:c9');
    expect(BISTRO_KEY).toBe('bulb:warm-white:bistro');
    expect(miniKey(' Warm White ')).toBe('mini:Warm White'); // trims
    expect(wreathBaseKey('24noble')).toBe('wreath:24noble');
    expect(wreathBowKey('24noble')).toBe('wreath-bow:24noble');
    expect(wreathFeeKey('24noble')).toBe('wreath-fee:24noble');
    expect(garlandBaseKey('9ft')).toBe('garland:9ft');
    expect(spritzerKey('red', '24')).toBe('spritzer:red:24');
    expect(spritzerPoleKey('24')).toBe('spritzer-pole:24');
  });
});

describe('concept row generators', () => {
  it('produces the right rows per group', () => {
    expect(bulbC9Rows()).toHaveLength(11); // 12 palette colors minus Black (no black bulb)
    expect(wreathBaseRows()).toHaveLength(6);
    expect(wreathBowRows()).toHaveLength(6);
    expect(wreathFeeRows()).toHaveLength(6);
    expect(garlandBaseRows()).toHaveLength(2);
    expect(CLIP_FEATURES).toHaveLength(6); // gutter/peak/side/ridge/pathway/flat — metal dropped (= magnetic wire)
  });

  it('omits Black from the bulb product rows', () => {
    expect(bulbC9Rows().some((r) => r.key === bulbC9Key('black'))).toBe(false);
    expect(bulbC9Rows().some((r) => r.label === 'Black')).toBe(false);
  });

  it('drops the redundant "Metal roof" clip row (metal = magnetic wire, no clip)', () => {
    expect(CLIP_FEATURES.some((f) => f.id === 'metal')).toBe(false);
  });

  it('rows carry the right key + label; bow rows carry the chart hint', () => {
    expect(bulbC9Rows().find((r) => r.key === 'bulb:warm-white:c9')?.label).toBe('Warm White');
    expect(wreathBaseRows()[0]).toEqual({ key: 'wreath:24noble', label: '24" Noble' });
    expect(wreathBowRows().find((r) => r.key === 'wreath-bow:48noble')?.hint).toBe('24" bow');
  });

  it('pre-fill maps cover the known SKUs', () => {
    expect(DEFAULT_CLIP_SKUS.gutter).toBe('14147');
    expect(DEFAULT_WREATH_FEE_SKUS['24noble']).toBe('1101');
    expect(DEFAULT_WREATH_FEE_SKUS['30noble']).toBe('1108');
    expect(DEFAULT_GARLAND_FEE_SKU).toBe('1106');
  });
});

describe('mini lights (curated list — the strands YLL carries)', () => {
  it('lists the 28 strands by friendly name', () => {
    expect(MINI_LIGHTS).toHaveLength(28);
    expect(miniRows()).toHaveLength(28);
    // friendly names, not the messy catalog color strings
    expect(MINI_LIGHTS.find((m) => m.sku === '43136')?.name).toBe('Candy Cane');
    expect(MINI_LIGHTS.find((m) => m.sku === '43156')?.name).toBe('Frozen');
    expect(MINI_LIGHTS.find((m) => m.sku === '43346')?.name).toBe('Grinch');
  });

  it('has unique SKUs and unique names (keys must not collide)', () => {
    expect(new Set(MINI_LIGHTS.map((m) => m.sku)).size).toBe(MINI_LIGHTS.length);
    expect(new Set(MINI_LIGHTS.map((m) => m.name)).size).toBe(MINI_LIGHTS.length);
  });

  it('solid colors keep design-palette-label keys so the projection still resolves them', () => {
    // colorLabel(paletteId) in materialsProjection yields these exact labels.
    expect(miniRows().find((r) => r.key === miniKey('Warm White'))?.label).toBe('Warm White');
    expect(miniRows().find((r) => r.key === miniKey('Red'))?.label).toBe('Red');
    expect(miniRows().some((r) => r.key === miniKey('Cool White'))).toBe(true);
  });
});

describe('spritzers (curated list — the strands YLL carries)', () => {
  it('lists all 31 spritzers; 32" is Warm White + Pure White only', () => {
    expect(SPRITZERS).toHaveLength(31);
    expect(spritzerRows('16')).toHaveLength(14);
    expect(spritzerRows('24')).toHaveLength(15);
    expect(spritzerRows('32')).toHaveLength(2);
  });

  it('has unique SKUs and unique binding keys', () => {
    expect(new Set(SPRITZERS.map((s) => s.sku)).size).toBe(31);
    const keys = (['16', '24', '32'] as const).flatMap((sz) => spritzerRows(sz).map((r) => r.key));
    expect(new Set(keys).size).toBe(31);
  });

  it('solid colors keep projection-resolvable spritzer:<paletteId>:<size> keys', () => {
    expect(spritzerRows('16').some((r) => r.key === spritzerKey('warm-white', '16'))).toBe(true);
    expect(spritzerRows('24').some((r) => r.key === spritzerKey('cool-white', '24'))).toBe(true);
    expect(spritzerRows('16').some((r) => r.key === spritzerKey('red', '16'))).toBe(true);
  });

  it('omits Black (no black spritzer product)', () => {
    expect(SPRITZERS.some((s) => /black/i.test(s.name))).toBe(false);
  });

  it('reads strands by friendly name (Candy-Cane style), not the messy catalog color', () => {
    expect(SPRITZERS.find((s) => s.sku === '61341')?.name).toBe('Red / Green');
    expect(SPRITZERS.find((s) => s.sku === '61671')?.name).toBe('Orange / Purple');
    expect(SPRITZERS.find((s) => s.sku === '61201')?.name).toBe('Multi');
  });
});

describe('autofill seeds', () => {
  it('buildSeedBindings covers wreath/garland/mini/spritzer + fees', () => {
    const s = buildSeedBindings();
    expect(s['wreath:24noble']).toBe('50024-30');
    expect(s['wreath-bow:24noble']).toBe('30812'); // 12" Red/Gold bow
    expect(s['wreath-bow:30noble']).toBeUndefined(); // chart skips 30"
    expect(s['wreath-fee:24noble']).toBe('1101');
    expect(s['garland:4.5ft']).toBe('50045-30');
    expect(s['garland-bow']).toBe('30812');
    expect(s['garland-fee']).toBe('1106');
    expect(s['mini:Warm White']).toBe('40056'); // solid — projection-resolvable key
    expect(s['mini:Candy Cane']).toBe('43136'); // specialty — pre-seeded for manual ordering
    expect(s['spritzer:warm-white:16']).toBe('61001'); // solid — projection key
    expect(s['spritzer:cool-white:32']).toBe('61103'); // solid — projection key
    expect(s['spritzer:61341']).toBe('61341'); // specialty (Red/Green 16") — sku-keyed
  });
  it('buildSeedClipRules pre-fills the clip features', () => {
    expect(buildSeedClipRules().gutter).toEqual({ sku: '14147' });
  });
});
