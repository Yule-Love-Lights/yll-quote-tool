// src/lib/inventory/concepts.test.ts
import { describe, it, expect } from 'vitest';
import {
  bulbC9Key, BISTRO_KEY, miniKey,
  wreathBaseKey, wreathBowKey, wreathFeeKey, garlandBaseKey,
  spritzerKey, spritzerPoleKey,
  bulbC9Rows, wreathBaseRows, wreathBowRows, wreathFeeRows, garlandBaseRows, spritzerColorRows,
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
    expect(bulbC9Rows()).toHaveLength(12); // 12 palette colors
    expect(wreathBaseRows()).toHaveLength(6);
    expect(wreathBowRows()).toHaveLength(6);
    expect(wreathFeeRows()).toHaveLength(6);
    expect(garlandBaseRows()).toHaveLength(2);
    expect(spritzerColorRows('16')).toHaveLength(12);
    expect(CLIP_FEATURES).toHaveLength(7);
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
    expect(s['mini:Warm White']).toBe('40056');
    expect(s['spritzer:warm-white:16']).toBe('61001');
    expect(s['spritzer:cool-white:32']).toBe('61103');
  });
  it('buildSeedClipRules pre-fills the clip features', () => {
    expect(buildSeedClipRules().gutter).toEqual({ sku: '14147' });
  });
});
