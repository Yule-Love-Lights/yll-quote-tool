// src/lib/inventory/concepts.test.ts
import { describe, it, expect } from 'vitest';
import {
  bulbC9Key, BISTRO_KEY, miniKey,
  wreathBaseKey, wreathBowKey, wreathFeeKey, garlandBaseKey,
  spritzerKey, spritzerPoleKey,
  bulbC9Rows, wreathBaseRows, wreathBowRows, wreathFeeRows, garlandBaseRows, spritzerColorRows,
  CLIP_FEATURES, DEFAULT_CLIP_SKUS, DEFAULT_WREATH_FEE_SKUS, DEFAULT_GARLAND_FEE_SKU,
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
