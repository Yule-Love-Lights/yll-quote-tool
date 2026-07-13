import { describe, it, expect } from 'vitest';
import {
  isBulbColor,
  normalizeColors,
  sanitizeRender,
  sanitizePortal,
  normalizeSchemes,
  normalizeBuildable,
  sanitizeSwatches,
  sanitizePermanentRates,
  sanitizePermanentWarranty,
  sanitizeHolidayWarranty,
  sanitizeEventWarranty,
  sanitizeBistroWarranty,
} from './appSettings';

// A representative palette id set (mirrors the built-in DEFAULT_COLORS ids used
// by the swatch validators).
const PALETTE = new Set(['warm-white', 'cool-white', 'red', 'green', 'blue', 'yellow', 'black']);

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

describe('sanitizePermanentRates (#88)', () => {
  it('keeps valid finite numbers >= 0 (incl. 0 for maintenance)', () => {
    expect(
      sanitizePermanentRates({
        frontPerFt: 40,
        sidesPerFt: 35,
        backPerFt: 35,
        minimumJobAmount: 2500,
        maintenancePrice: 0,
      }),
    ).toEqual({
      frontPerFt: 40,
      sidesPerFt: 35,
      backPerFt: 35,
      minimumJobAmount: 2500,
      maintenancePrice: 0,
    });
  });
  it('accepts a partial patch (only the fields present)', () => {
    expect(sanitizePermanentRates({ frontPerFt: 45 })).toEqual({ frontPerFt: 45 });
  });
  it('drops negative / NaN / non-number / unknown fields', () => {
    expect(sanitizePermanentRates({ frontPerFt: -5 })).toEqual({});
    expect(sanitizePermanentRates({ sidesPerFt: NaN })).toEqual({});
    expect(sanitizePermanentRates({ backPerFt: '35' })).toEqual({});
    expect(sanitizePermanentRates({ bogus: 10 })).toEqual({});
    expect(sanitizePermanentRates(null)).toEqual({});
    expect(sanitizePermanentRates('x')).toEqual({});
  });
});

describe('sanitizePermanentWarranty (#88 P6b-2)', () => {
  it('trims strings and preserves bullet SLOT positions (blank slots kept)', () => {
    const out = sanitizePermanentWarranty({
      eyebrow: '  Your Protection  ',
      heading: '  Built to last.  ',
      bullets: ['first', '   ', 'third'],
    });
    expect(out.eyebrow).toBe('Your Protection');
    expect(out.heading).toBe('Built to last.');
    // the blank middle slot is preserved (so its fixed icon drops with it, and the
    // remaining bullets keep their icon pairing) — NOT filtered out.
    expect(out.bullets).toEqual(['first', '', 'third']);
  });

  it('caps bullets at 6 slots and coerces a non-string slot to blank', () => {
    const out = sanitizePermanentWarranty({
      bullets: ['a', 42 as unknown as string, 'c', 'd', 'e', 'f', 'g'],
    });
    expect(out.bullets).toHaveLength(6); // 'g' dropped
    expect(out.bullets![1]).toBe(''); // the 42 became a blank slot
  });

  it('accepts a partial patch (only the fields present)', () => {
    expect(sanitizePermanentWarranty({ heading: 'Just the heading' })).toEqual({
      heading: 'Just the heading',
    });
  });

  it('keeps a valid stored version but drops junk versions', () => {
    expect(sanitizePermanentWarranty({ version: 4 }).version).toBe(4);
    expect(sanitizePermanentWarranty({ version: 2.9 }).version).toBe(2); // floored
    expect(sanitizePermanentWarranty({ version: 0 }).version).toBeUndefined();
    expect(sanitizePermanentWarranty({ version: -1 }).version).toBeUndefined();
    expect(sanitizePermanentWarranty({ version: 'x' }).version).toBeUndefined();
  });

  it('returns {} for non-objects', () => {
    expect(sanitizePermanentWarranty(null)).toEqual({});
    expect(sanitizePermanentWarranty('x')).toEqual({});
    expect(sanitizePermanentWarranty([1, 2])).toEqual({});
  });
});

// WT-56/65/07 — same mechanism as permanent's, generalized to the other three
// verticals, each with its own bullet-slot cap (matching its fixed icon count
// in RiskReversal.tsx: holiday/event 5, bistro 4).
describe('sanitizeHolidayWarranty / sanitizeEventWarranty / sanitizeBistroWarranty (WT-56/65/07)', () => {
  it('caps holiday + event bullets at 5 slots', () => {
    const bullets = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(sanitizeHolidayWarranty({ bullets }).bullets).toHaveLength(5);
    expect(sanitizeEventWarranty({ bullets }).bullets).toHaveLength(5);
  });

  it('caps bistro bullets at 4 slots', () => {
    expect(sanitizeBistroWarranty({ bullets: ['a', 'b', 'c', 'd', 'e'] }).bullets).toHaveLength(4);
  });

  it('trims strings and preserves bullet SLOT positions (blank slots kept)', () => {
    const out = sanitizeHolidayWarranty({
      eyebrow: '  Your Protection  ',
      heading: '  Take the risk out.  ',
      bullets: ['first', '   ', 'third'],
    });
    expect(out.eyebrow).toBe('Your Protection');
    expect(out.heading).toBe('Take the risk out.');
    expect(out.bullets).toEqual(['first', '', 'third']);
  });

  it('accepts a partial patch (only the fields present)', () => {
    expect(sanitizeEventWarranty({ heading: 'Just the heading' })).toEqual({
      heading: 'Just the heading',
    });
  });

  it('keeps a valid stored version but drops junk versions', () => {
    expect(sanitizeBistroWarranty({ version: 4 }).version).toBe(4);
    expect(sanitizeBistroWarranty({ version: 0 }).version).toBeUndefined();
    expect(sanitizeBistroWarranty({ version: 'x' }).version).toBeUndefined();
  });

  it('returns {} for non-objects', () => {
    expect(sanitizeHolidayWarranty(null)).toEqual({});
    expect(sanitizeEventWarranty('x')).toEqual({});
    expect(sanitizeBistroWarranty([1, 2])).toEqual({});
  });
});

describe('normalizeSchemes (#101)', () => {
  it('keeps valid schemes, dropping junk + dup ids, and pins as-designed first', () => {
    const out = normalizeSchemes(
      [
        { id: 'red-gold', label: 'Red & Gold', colorIds: ['red', 'yellow'] },
        { id: 'as-designed', label: "Team's look", colorIds: null },
        { id: 'red-gold', label: 'dup', colorIds: ['red'] }, // dup id → dropped
        { id: '', label: 'blank id', colorIds: null }, // invalid → dropped
        { id: 'x', label: 'x', colorIds: 'nope' }, // bad colorIds → dropped
      ],
      PALETTE,
    );
    expect(out).not.toBeNull();
    expect(out![0].id).toBe('as-designed'); // pinned first
    expect(out!.map((s) => s.id)).toEqual(['as-designed', 'red-gold']);
  });

  it('filters colorIds to real palette ids; drops a scheme left with none', () => {
    const out = normalizeSchemes(
      [{ id: 'mix', label: 'Mix', colorIds: ['red', 'not-a-color'] }, { id: 'ghost', label: 'Ghost', colorIds: ['not-a-color'] }],
      PALETTE,
    );
    expect(out!.find((s) => s.id === 'mix')?.colorIds).toEqual(['red']); // junk id filtered
    expect(out!.find((s) => s.id === 'ghost')).toBeUndefined(); // no valid color → dropped
  });

  it('adds as-designed even to an empty/all-invalid list; returns null for non-array', () => {
    expect(normalizeSchemes([], PALETTE)!.map((s) => s.id)).toEqual(['as-designed']);
    expect(normalizeSchemes('nope', PALETTE)).toBeNull();
  });
});

describe('normalizeBuildable (#101)', () => {
  it('keeps real non-black palette ids, unique + in order', () => {
    expect(normalizeBuildable(['red', 'black', 'green', 'red', 'nope', 5], PALETTE)).toEqual(['red', 'green']);
  });
  it('returns null for a non-array', () => {
    expect(normalizeBuildable('x', PALETTE)).toBeNull();
    expect(normalizeBuildable(undefined, PALETTE)).toBeNull();
  });
});

describe('sanitizeSwatches (#101)', () => {
  it('normalizes both fields; omits a field that is absent/invalid', () => {
    const out = sanitizeSwatches({ buildableColorIds: ['red', 'blue'] }, PALETTE);
    expect(out.buildableColorIds).toEqual(['red', 'blue']);
    expect('schemes' in out).toBe(false); // no schemes provided → not merged
  });
  it('returns {} for a non-object (→ 400 at the route)', () => {
    expect(sanitizeSwatches(null, PALETTE)).toEqual({});
    expect(sanitizeSwatches('x', PALETTE)).toEqual({});
  });
});
