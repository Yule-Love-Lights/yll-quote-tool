import { describe, it, expect } from 'vitest';
import { normalizeBindings, normalizeClipRules } from './bindings';

describe('normalizeBindings', () => {
  it('keeps string SKU values and trims them', () => {
    expect(normalizeBindings({ 'bulb:warm-white:c9': ' 20009-SPK ' })).toEqual({
      'bulb:warm-white:c9': '20009-SPK',
    });
  });

  it('keeps bundle (object) values with trimmed string SKUs', () => {
    expect(normalizeBindings({ 'spritzer:24': { spritzerSku: '23099', stakeMetalSku: ' 14355 ' } })).toEqual({
      'spritzer:24': { spritzerSku: '23099', stakeMetalSku: '14355' },
    });
  });

  it('drops empty strings, non-string/non-object values, and empty bundles', () => {
    expect(normalizeBindings({ a: '', b: 5, c: null, d: {}, e: { x: '' }, f: '14147' })).toEqual({
      f: '14147',
    });
  });

  it('returns null for a non-object input', () => {
    expect(normalizeBindings(null)).toBeNull();
    expect(normalizeBindings('x')).toBeNull();
    expect(normalizeBindings([1, 2])).toBeNull();
  });
});

describe('normalizeClipRules', () => {
  it('keeps a rule object with a string sku and numeric spacing', () => {
    expect(normalizeClipRules({ gutter: { sku: '14147', perFt: 1 } })).toEqual({
      gutter: { sku: '14147', perFt: 1 },
    });
  });

  it('drops non-object rules, empty rules, and bad field values', () => {
    expect(
      normalizeClipRules({ gutter: { sku: '14147', perFt: 'x' }, peak: 'nope', ridge: {} }),
    ).toEqual({ gutter: { sku: '14147' } });
  });

  it('returns null for a non-object input', () => {
    expect(normalizeClipRules(42)).toBeNull();
  });
});
