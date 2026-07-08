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
  it('front-only quote → only package A (no redundant Whole Home D)', () => {
    // #125-2: a single lit surface makes D "Whole Home" byte-identical to A —
    // a redundant tier. Suppress D when there is only one billable line.
    const lineItems = [permItem('permanent-front', 4000)];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    expect(packages.map((p) => p.id)).toEqual(['A']);
    const a = packages.find((p) => p.id === 'A')!;
    expect(a.includedItemIds).toEqual(['permanent-front']);
  });

  it('#125-3: a custom/manual line item lands in Whole Home D so it gets billed', () => {
    // Custom (#27) line items carry a non-'permanent-' id, so they sit in NO
    // A/B/C surface package. Without them in D they default OFF on the portal
    // and go silently UNBILLED at approval. D must bundle them.
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-sides', 5250),
      permItem('custom-0', 300, 'roofline'),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    const d = packages.find((p) => p.id === 'D')!;
    expect(d.includedItemIds).toContain('custom-0');
    // A/B stay single-surface — the custom item only rides Whole Home.
    expect(packages.find((p) => p.id === 'A')!.includedItemIds).toEqual(['permanent-front']);
    const expectedD = priceSelection(4000 + 5250 + 300, CHARGES);
    expect(d.total).toBe(expectedD.total);
  });

  it('#125-3: front + custom only (one surface) → D present because it adds the custom line', () => {
    // A single surface PLUS a custom item still needs D — D (front + custom)
    // differs from A (front only), so it is NOT redundant.
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('custom-0', 300, 'roofline'),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    expect(packages.map((p) => p.id)).toEqual(['A', 'D']);
    const d = packages.find((p) => p.id === 'D')!;
    expect(d.includedItemIds.sort()).toEqual(['custom-0', 'permanent-front']);
    const expectedD = priceSelection(4000 + 300, CHARGES);
    expect(d.total).toBe(expectedD.total);
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

  it('all sides present (split left/right, #132) → A, B, C, D; B = Front & Sides (#133)', () => {
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-left', 2750),
      permItem('permanent-right', 2500),
      permItem('permanent-back', 3500),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    expect(packages.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']);

    const b = packages.find((p) => p.id === 'B')!;
    expect(b.name).toBe('Front & Sides');
    expect(b.includedItemIds.sort()).toEqual(['permanent-front', 'permanent-left', 'permanent-right']);
    const expectedB = priceSelection(4000 + 2750 + 2500, CHARGES);
    expect(b.total).toBe(expectedB.total);

    const d = packages.find((p) => p.id === 'D')!;
    const expectedD = priceSelection(4000 + 2750 + 2500 + 3500, CHARGES);
    expect(d.total).toBe(expectedD.total);
  });

  it('one drawn side only (left) → B = Front & Sides with front + that side', () => {
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-left', 2750),
      permItem('permanent-back', 3500),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    const b = packages.find((p) => p.id === 'B')!;
    expect(b.name).toBe('Front & Sides');
    expect(b.includedItemIds.sort()).toEqual(['permanent-front', 'permanent-left']);
    expect(b.total).toBe(priceSelection(4000 + 2750, CHARGES).total);
  });

  it('front + sides and no back → B (Front & Sides) without a byte-identical Whole Home D', () => {
    // B = front+left+right IS the whole home here — the set-equality guard
    // suppresses the duplicate D tile.
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-left', 2750),
      permItem('permanent-right', 2500),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    expect(packages.map((p) => p.id)).toEqual(['A', 'B']);
    expect(packages.find((p) => p.id === 'B')!.name).toBe('Front & Sides');
  });

  it('left+right-only quote (no front) → B degrades to "Both Sides", no duplicate D', () => {
    // Post-#132 a sides-only quote has TWO lines, so the old ">1 line" guard
    // alone would emit a D identical to B. The set-equality guard suppresses it.
    const lineItems = [permItem('permanent-left', 2750), permItem('permanent-right', 2500)];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    expect(packages.map((p) => p.id)).toEqual(['B']);
    expect(packages[0].name).toBe('Both Sides');
    expect(packages[0].includedItemIds.sort()).toEqual(['permanent-left', 'permanent-right']);
  });

  it('LEGACY: a pre-#132 stored result with the combined sides line keeps A, B, C, D', () => {
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-sides', 5250),
      permItem('permanent-back', 3500),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    expect(packages.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']);

    const b = packages.find((p) => p.id === 'B')!;
    expect(b.name).toBe('Front & Sides');
    expect(b.includedItemIds.sort()).toEqual(['permanent-front', 'permanent-sides']);
    expect(b.total).toBe(priceSelection(4000 + 5250, CHARGES).total);

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
    // Multi-surface so Whole Home D exists; the opt-in maintenance add-on must
    // still never fold into any package's default selection.
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-back', 3500),
      permItem('permanent-maintenance', 250, 'permanent-addon'),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    for (const p of packages) {
      expect(p.includedItemIds).not.toContain('permanent-maintenance');
    }
    // And D ("Whole Home") must not silently fold the maintenance price in.
    const d = packages.find((p) => p.id === 'D')!;
    const expected = priceSelection(4000 + 3500, CHARGES);
    expect(d.total).toBe(expected.total);
  });

  it('empty lineItems → []', () => {
    expect(derivePackagesPermanent([], RESULT)).toEqual([]);
  });
});
