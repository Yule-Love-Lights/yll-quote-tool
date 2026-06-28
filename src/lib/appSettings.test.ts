import { describe, it, expect } from 'vitest';
import { isBulbColor, normalizeColors, sanitizeRender, sanitizePortal } from './appSettings';

const red = { id: 'red', label: 'Red', hex: '#ff0000', glow: '#ff8888' };

describe('isBulbColor', () => {
  it('accepts a well-formed color', () => {
    expect(isBulbColor(red)).toBe(true);
  });
  it('rejects bad hex, missing fields, non-objects', () => {
    expect(isBulbColor({ ...red, hex: 'red' })).toBe(false);
    expect(isBulbColor({ ...red, hex: '#fff' })).toBe(false); // must be 6-digit
    expect(isBulbColor({ ...red, id: '' })).toBe(false);
    expect(isBulbColor({ id: 'x', label: 'X', hex: '#ffffff' })).toBe(false); // no glow
    expect(isBulbColor(null)).toBe(false);
    expect(isBulbColor('red')).toBe(false);
  });
});

describe('normalizeColors', () => {
  it('returns a cleaned list for valid input', () => {
    const out = normalizeColors([red, { id: 'green', label: 'Green', hex: '#00ff00', glow: '#88ff88' }]);
    expect(out).toHaveLength(2);
    expect(out?.[0].id).toBe('red');
  });
  it('preserves the builtin flag and drops duplicate ids', () => {
    const out = normalizeColors([{ ...red, builtin: true }, { ...red, label: 'Red 2' }]);
    expect(out).toHaveLength(1);
    expect(out?.[0].builtin).toBe(true);
  });
  it('returns null for empty / non-array / any-invalid-entry', () => {
    expect(normalizeColors([])).toBeNull();
    expect(normalizeColors('nope')).toBeNull();
    expect(normalizeColors([red, { ...red, id: 'bad', hex: 'nope' }])).toBeNull();
  });
});

describe('sanitizeRender', () => {
  it('keeps a valid spritzer density, clamped to range', () => {
    expect(sanitizeRender({ spritzerRayDensity: 0.8 })).toEqual({ spritzerRayDensity: 0.8 });
    expect(sanitizeRender({ spritzerRayDensity: 99 })).toEqual({ spritzerRayDensity: 1.5 });
    expect(sanitizeRender({ spritzerRayDensity: 0.001 })).toEqual({ spritzerRayDensity: 0.1 });
  });
  it('drops invalid / unknown fields', () => {
    expect(sanitizeRender({ spritzerRayDensity: NaN })).toEqual({});
    expect(sanitizeRender({ spritzerRayDensity: -1 })).toEqual({});
    expect(sanitizeRender({ other: 5 })).toEqual({});
    expect(sanitizeRender(null)).toEqual({});
    expect(sanitizeRender('x')).toEqual({});
  });
});

describe('sanitizePortal', () => {
  it('keeps the hide-early-install boolean (either value)', () => {
    expect(sanitizePortal({ hideEarlyInstallDiscounts: true })).toEqual({
      hideEarlyInstallDiscounts: true,
    });
    expect(sanitizePortal({ hideEarlyInstallDiscounts: false })).toEqual({
      hideEarlyInstallDiscounts: false,
    });
  });
  it('drops non-boolean / unknown / non-object', () => {
    expect(sanitizePortal({ hideEarlyInstallDiscounts: 'yes' })).toEqual({});
    expect(sanitizePortal({ hideEarlyInstallDiscounts: 1 })).toEqual({});
    expect(sanitizePortal({ other: true })).toEqual({});
    expect(sanitizePortal(null)).toEqual({});
    expect(sanitizePortal('x')).toEqual({});
  });
});
