import { describe, it, expect } from 'vitest';
import { derivePackagesPermanentBistro } from './packages';
import { calculatePermanentBistro } from './pricing';
import type { PortalLineItem } from '@/components/portal/types';
import type { QuoteInputs } from '@/lib/pricing/pricingEngine';

function baseInputs(): QuoteInputs {
  return {
    santasFootage: 0,
    santasDifficulty: 'easy',
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'easy',
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'easy',
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'easy',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
  };
}

const pli = (id: string, price: number): PortalLineItem => ({ id, kind: 'roofline', label: id, detail: '', price });

describe('derivePackagesPermanentBistro', () => {
  it('bundles every line item into ONE package (tax + 50% deposit)', () => {
    const result = calculatePermanentBistro(baseInputs());
    const pkgs = derivePackagesPermanentBistro([pli('a', 700), pli('b', 300)], result);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0].includedItemIds).toEqual(['a', 'b']);
    expect(pkgs[0].recommended).toBe(true);
    // subtotal 1000 → +8.75% tax = 1087.50 → 50% deposit = 543.75
    expect(pkgs[0].total).toBeCloseTo(1087.5, 2);
    expect(pkgs[0].deposit).toBeCloseTo(543.75, 2);
  });

  it('no line items → no package', () => {
    expect(derivePackagesPermanentBistro([], calculatePermanentBistro(baseInputs()))).toEqual([]);
  });

  it('carries no rush/takedown charges (a permanent install has none)', () => {
    const result = calculatePermanentBistro(baseInputs());
    const pkgs = derivePackagesPermanentBistro([pli('a', 100)], result);
    // 100 → tax 8.75 → total 108.75 (no fees added)
    expect(pkgs[0].total).toBeCloseTo(108.75, 2);
  });

  it('is a single flat package — no A/B/C/D tier ladder', () => {
    const result = calculatePermanentBistro(baseInputs());
    const pkgs = derivePackagesPermanentBistro([pli('a', 100), pli('b', 50)], result);
    expect(pkgs).toHaveLength(1);
  });

  // WT-64: the opt-in maintenance add-on must never ride bundled into the one
  // package — it starts OFF and the customer opts in via its own toggle
  // (mirrors derivePackagesPermanent excluding 'permanent-maintenance' from
  // its Whole Home bundle).
  describe('maintenance add-on exclusion (WT-64)', () => {
    it('the maintenance line is present but never appears in the package includedItemIds', () => {
      const result = calculatePermanentBistro(baseInputs());
      const pkgs = derivePackagesPermanentBistro(
        [pli('a', 700), pli('permanent-bistro-maintenance', 300)],
        result,
      );
      expect(pkgs).toHaveLength(1);
      expect(pkgs[0].includedItemIds).toEqual(['a']);
      expect(pkgs[0].includedItemIds).not.toContain('permanent-bistro-maintenance');
      // And the bundle's price excludes the maintenance amount — 700 → +8.75% tax = 761.25.
      expect(pkgs[0].total).toBeCloseTo(761.25, 2);
    });

    it('a quote whose ONLY billable line is the maintenance add-on offers no package', () => {
      const result = calculatePermanentBistro(baseInputs());
      const pkgs = derivePackagesPermanentBistro([pli('permanent-bistro-maintenance', 300)], result);
      expect(pkgs).toEqual([]);
    });
  });
});
