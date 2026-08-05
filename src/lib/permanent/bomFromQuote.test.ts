import { describe, it, expect } from 'vitest';
import {
  permanentBomInputFromFields,
  permanentBomFromQuote,
  includedPermanentSidesFromSnapshot,
} from './bomFromQuote';
import { makeDefaultPermanentFields } from './types';

describe('permanentBomInputFromFields', () => {
  it('maps per-side footage/corners + track/gap fields onto the BOM input', () => {
    const p = {
      ...makeDefaultPermanentFields(),
      frontFootage: 60,
      leftFootage: 20,
      rightFootage: 25,
      backFootage: 40,
      frontCorners: 4,
      leftCorners: 1,
      rightCorners: 1,
      backCorners: 2,
      trackStyle: 'parapet' as const,
      trackColor: '9004' as const,
      blackHousing: true,
      controllerToFirstLightFt: 12,
    };
    const input = permanentBomInputFromFields(p);
    expect(input.footageBySide).toEqual({ front: 60, left: 20, right: 25, back: 40 });
    expect(input.cornersBySide).toEqual({ front: 4, left: 1, right: 1, back: 2 });
    // No trackStyleBySide map set — every side falls back to the legacy scalar.
    expect(input.trackStyleBySide).toEqual({ front: 'parapet', left: 'parapet', right: 'parapet', back: 'parapet' });
    expect(input.trackColor).toBe('9004');
    expect(input.blackHousing).toBe(true);
    expect(input.controllerToFirstLightFt).toBe(12);
    expect(input.gaps).toBe(p.gaps); // same array reference — BOM reads gaps as-is
  });

  it('#192 — a per-side trackStyleBySide entry wins over the legacy scalar for that side only', () => {
    const p = {
      ...makeDefaultPermanentFields(),
      trackStyle: 'single' as const,
      trackStyleBySide: { front: 'parapet' as const, back: 'parapet' as const },
    };
    const input = permanentBomInputFromFields(p);
    expect(input.trackStyleBySide).toEqual({
      front: 'parapet', // overridden
      left: 'single', // falls back to scalar (absent from the map)
      right: 'single', // falls back to scalar (absent from the map)
      back: 'parapet', // overridden
    });
  });
});

describe('permanentBomInputFromFields — #192 approved-sides scoping', () => {
  const p = {
    ...makeDefaultPermanentFields(),
    frontFootage: 60,
    leftFootage: 20,
    rightFootage: 25,
    backFootage: 40,
    frontCorners: 4,
    leftCorners: 1,
    rightCorners: 1,
    backCorners: 2,
  };

  it('no includedSides arg (undefined) → unscoped, every side present (today\'s behavior)', () => {
    const input = permanentBomInputFromFields(p);
    expect(input.footageBySide).toEqual({ front: 60, left: 20, right: 25, back: 40 });
    expect(input.cornersBySide).toEqual({ front: 4, left: 1, right: 1, back: 2 });
  });

  it('includedSides === null → unscoped, same as undefined', () => {
    const input = permanentBomInputFromFields(p, null);
    expect(input.footageBySide).toEqual({ front: 60, left: 20, right: 25, back: 40 });
    expect(input.cornersBySide).toEqual({ front: 4, left: 1, right: 1, back: 2 });
  });

  it('a Set of included sides zeroes footage/corners for the excluded sides', () => {
    const input = permanentBomInputFromFields(p, new Set(['front']));
    expect(input.footageBySide).toEqual({ front: 60, left: 0, right: 0, back: 0 });
    expect(input.cornersBySide).toEqual({ front: 4, left: 0, right: 0, back: 0 });
  });

  it('scoping never touches gaps/controllerToFirstLightFt/accessories — those stay whole-job (documented limitation)', () => {
    const withAcc = {
      ...p,
      gaps: [{ lengthFt: 10 }],
      controllerToFirstLightFt: 15,
      accessoriesSource: 'manual' as const,
      extensions: { e3: 1, e5: 0, e10: 0, e25: 0 },
      splittersNeeded: 1,
      jumpBoosters: 1,
    };
    const scoped = permanentBomInputFromFields(withAcc, new Set(['front']));
    const unscoped = permanentBomInputFromFields(withAcc);
    expect(scoped.gaps).toEqual(unscoped.gaps);
    expect(scoped.controllerToFirstLightFt).toBe(unscoped.controllerToFirstLightFt);
    expect(scoped.accessories).toEqual(unscoped.accessories);
  });
});

describe('permanentBomInputFromFields — #140 accessories precedence predicate', () => {
  it('NO accessoriesSource → no accessories on the input, even when count objects exist', () => {
    // The predicate keys on accessoriesSource, never on object presence — a
    // defaulted zero object must not suppress the legacy gaps path.
    const p = {
      ...makeDefaultPermanentFields(),
      extensions: { e3: 0, e5: 0, e10: 0, e25: 0 },
      splittersNeeded: 0,
    };
    expect(permanentBomInputFromFields(p).accessories).toBeUndefined();
  });

  it('accessoriesSource set → accessories built with clamped counts', () => {
    const p = {
      ...makeDefaultPermanentFields(),
      accessoriesSource: 'manual' as const,
      extensions: { e3: 2, e5: -1, e10: 3.7, e25: Number.NaN },
      splittersNeeded: 2,
      jumpBoosters: 1,
    };
    expect(permanentBomInputFromFields(p).accessories).toEqual({
      extensions: { e3: 2, e5: 0, e10: 3, e25: 0 }, // negatives/NaN clamp, floats floor
      splitters: 2,
      jumpBoosters: 1,
    });
  });

  it("accessoriesSource 'auto' with missing count objects → all-zero accessories (untyped DB JSON)", () => {
    const p = { ...makeDefaultPermanentFields(), accessoriesSource: 'auto' as const };
    expect(permanentBomInputFromFields(p).accessories).toEqual({
      extensions: { e3: 0, e5: 0, e10: 0, e25: 0 },
      splitters: 0,
      jumpBoosters: 0,
    });
  });
});

describe('permanentBomFromQuote', () => {
  it('returns null when the quote has no permanent block', () => {
    expect(permanentBomFromQuote(null)).toBeNull();
    expect(permanentBomFromQuote(undefined)).toBeNull();
    expect(permanentBomFromQuote({})).toBeNull();
  });

  it('builds a BOM from the permanent block', () => {
    const p = { ...makeDefaultPermanentFields(), frontFootage: 60, backFootage: 40 };
    const bom = permanentBomFromQuote({ permanent: p });
    expect(bom).not.toBeNull();
    expect(bom!.totals.totalFt).toBe(100);
    expect(bom!.lines.length).toBeGreaterThan(0);
    expect(bom!.totals.wholesaleCost).toBeGreaterThan(0);
    // Every line carries a positive quantity + a matching ext cost.
    for (const l of bom!.lines) {
      expect(l.qty).toBeGreaterThan(0);
      expect(l.extCost).toBeCloseTo(Math.round(l.qty * l.unitCost * 100) / 100, 2);
    }
  });

  it('legacy scalar-only quote (no trackStyleBySide) → BOM identical to before #192 (regression lock)', () => {
    const p = {
      ...makeDefaultPermanentFields(),
      frontFootage: 60,
      backFootage: 40,
      trackStyle: 'parapet' as const,
    };
    delete (p as { trackStyleBySide?: unknown }).trackStyleBySide; // simulate a pre-#192 stored row
    const bom = permanentBomFromQuote({ permanent: p });
    expect(bom).not.toBeNull();
    // The whole 100ft orders as ONE parapet track line (uniform scalar style),
    // exactly as it did before per-side track style existed.
    const trackLines = bom!.lines.filter((l) => l.category === 'track');
    expect(trackLines).toHaveLength(1);
    expect(trackLines[0].sku).toBe('APL11230-90-9003');
  });

  it('#192 — threads includedSides through to zero excluded-side footage in the built BOM', () => {
    const p = { ...makeDefaultPermanentFields(), frontFootage: 60, backFootage: 40 };
    const full = permanentBomFromQuote({ permanent: p });
    const frontOnly = permanentBomFromQuote({ permanent: p }, undefined, new Set(['front']));
    expect(full!.totals.totalFt).toBe(100);
    expect(frontOnly!.totals.totalFt).toBe(60);
  });
});

describe('includedPermanentSidesFromSnapshot (#192 — approved-sides scoping)', () => {
  it('missing snapshot → null (fail open, unscoped)', () => {
    expect(includedPermanentSidesFromSnapshot(null)).toBeNull();
    expect(includedPermanentSidesFromSnapshot(undefined)).toBeNull();
  });

  it('no customerSelection → null', () => {
    expect(includedPermanentSidesFromSnapshot({})).toBeNull();
  });

  it('empty/missing selectedItemIds → null', () => {
    expect(includedPermanentSidesFromSnapshot({ customerSelection: {} })).toBeNull();
    expect(includedPermanentSidesFromSnapshot({ customerSelection: { selectedItemIds: [] } })).toBeNull();
  });

  it('maps the four per-side line-item ids to their sides', () => {
    const sides = includedPermanentSidesFromSnapshot({
      customerSelection: { selectedItemIds: ['permanent-front', 'permanent-back'] },
    });
    expect(sides).toEqual(new Set(['front', 'back']));
  });

  it('legacy combined permanent-sides id maps to BOTH left + right', () => {
    const sides = includedPermanentSidesFromSnapshot({
      customerSelection: { selectedItemIds: ['permanent-sides'] },
    });
    expect(sides).toEqual(new Set(['left', 'right']));
  });

  it('a selection with no recognizable permanent side id → null (fail open)', () => {
    const sides = includedPermanentSidesFromSnapshot({
      customerSelection: { selectedItemIds: ['custom-0', 'permanent-maintenance'] },
    });
    expect(sides).toBeNull();
  });

  it('a corrupted/foreign snapshot shape → null (fail open, never under-order)', () => {
    expect(includedPermanentSidesFromSnapshot('not an object')).toBeNull();
    expect(includedPermanentSidesFromSnapshot({ customerSelection: { selectedItemIds: 'not-an-array' } })).toBeNull();
    expect(
      includedPermanentSidesFromSnapshot({ customerSelection: { selectedItemIds: [1, 2, null] } }),
    ).toBeNull();
  });

  it('mixed known + unknown ids → keeps only the known sides', () => {
    const sides = includedPermanentSidesFromSnapshot({
      customerSelection: { selectedItemIds: ['permanent-front', 'custom-0', 'unknown-id'] },
    });
    expect(sides).toEqual(new Set(['front']));
  });
});
