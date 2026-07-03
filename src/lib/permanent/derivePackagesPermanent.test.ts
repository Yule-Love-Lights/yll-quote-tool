import { describe, it, expect } from 'vitest';
import { derivePackagesPermanent } from './derivePackagesPermanent';
import { priceSelection, chargesFromResult, effectiveCharges } from '@/lib/portal/derivePackages';
import type { QuoteResult } from '@/lib/pricing/pricingEngine';
import type { PortalLineItem } from '@/components/portal/types';

// Minimal QuoteResult — only the fields chargesFromResult reads matter (S12
// test file pattern); permanent quotes always have rushFeeAmount/takedownAmount
// zero (the pricing engine forces those off) and rooflineChoice: 'none'.
function resultWith(overrides: Partial<QuoteResult> = {}): QuoteResult {
  return {
    lineItems: [],
    subtotalBeforeDiscount: 0,
    discountAmount: 0,
    subtotalAfterDiscount: 0,
    minimumApplied: false,
    rushFeeAmount: 0,
    takedownAmount: 0,
    taxableAmount: 0,
    taxAmount: 0,
    total: 0,
    depositAmount: 0,
    balanceDue: 0,
    rooflineChoice: 'none',
    rooflineOptions: { santas: null, gingerbread: null },
    ...overrides,
  } as QuoteResult;
}

function permItem(id: string, price: number, kind: PortalLineItem['kind'] = 'permanent'): PortalLineItem {
  return { id, kind, label: id, detail: '', price };
}

const RESULT = resultWith();
const CHARGES = effectiveCharges(chargesFromResult(RESULT), false, false);

describe('derivePackagesPermanent (#88 P5)', () => {
  it('front-only quote → only package A, and D equals A', () => {
    const lineItems = [permItem('permanent-front', 4000)];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    const ids = packages.map((p) => p.id);
    expect(ids).toEqual(['A', 'D']);

    const a = packages.find((p) => p.id === 'A')!;
    const d = packages.find((p) => p.id === 'D')!;
    expect(a.includedItemIds).toEqual(['permanent-front']);
    expect(d.includedItemIds).toEqual(['permanent-front']);
    expect(d.total).toBe(a.total);
    expect(d.deposit).toBe(a.deposit);
  });

  it('front + back quote → A, C, D (no B — sides absent)', () => {
    const lineItems = [permItem('permanent-front', 4000), permItem('permanent-back', 3500)];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    const ids = packages.map((p) => p.id);
    expect(ids).toEqual(['A', 'C', 'D']);

    const d = packages.find((p) => p.id === 'D')!;
    expect(d.includedItemIds.sort()).toEqual(['permanent-back', 'permanent-front'].sort());

    const expectedD = priceSelection(4000 + 3500, CHARGES);
    expect(d.total).toBe(expectedD.total);
    expect(d.deposit).toBe(expectedD.deposit);
  });

  it('sides-absent quote never includes package B', () => {
    const lineItems = [permItem('permanent-front', 4000), permItem('permanent-back', 3500)];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    expect(packages.some((p) => p.id === 'B')).toBe(false);
  });

  it('all three sides present → A, B, C, D', () => {
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-sides', 5250),
      permItem('permanent-back', 3500),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    expect(packages.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']);

    const d = packages.find((p) => p.id === 'D')!;
    const expectedD = priceSelection(4000 + 5250 + 3500, CHARGES);
    expect(d.total).toBe(expectedD.total);
  });

  it("package A's total matches priceSelection(frontPrice, charges) exactly", () => {
    const lineItems = [permItem('permanent-front', 4000), permItem('permanent-sides', 5250)];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    const a = packages.find((p) => p.id === 'A')!;
    const expected = priceSelection(4000, CHARGES);
    expect(a.total).toBe(expected.total);
    expect(a.deposit).toBe(expected.deposit);
  });

  it('never includes rush/takedown even when the result carries nonzero amounts', () => {
    const lineItems = [permItem('permanent-front', 4000)];
    const dirtyResult = resultWith({ rushFeeAmount: 150, takedownAmount: 200 });
    const packages = derivePackagesPermanent(lineItems, dirtyResult);
    const a = packages.find((p) => p.id === 'A')!;
    // Same as the clean-result price — rush/takedown must never be added.
    const expected = priceSelection(4000, CHARGES);
    expect(a.total).toBe(expected.total);
  });

  it('maintenance line is present but never appears in any package includedItemIds', () => {
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-maintenance', 250, 'permanent-addon'),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    for (const p of packages) {
      expect(p.includedItemIds).not.toContain('permanent-maintenance');
    }
    // And D ("Whole Home") must not silently fold the maintenance price in.
    const d = packages.find((p) => p.id === 'D')!;
    const expected = priceSelection(4000, CHARGES);
    expect(d.total).toBe(expected.total);
  });

  it('empty lineItems → []', () => {
    expect(derivePackagesPermanent([], RESULT)).toEqual([]);
  });
});
