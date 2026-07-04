import { describe, it, expect } from 'vitest';
import { permanentBomInputFromFields, permanentBomFromQuote } from './bomFromQuote';
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
    expect(input.trackStyle).toBe('parapet');
    expect(input.trackColor).toBe('9004');
    expect(input.blackHousing).toBe(true);
    expect(input.controllerToFirstLightFt).toBe(12);
    expect(input.gaps).toBe(p.gaps); // same array reference — BOM reads gaps as-is
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
});
