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

  it('WT-05: one drawn side only (left) → B names the specific side, not "Both/Front & Sides"', () => {
    // A townhome/corner-lot quote where only the left side was measured must
    // NOT be presented as covering both sides — name it honestly.
    const lineItems = [
      permItem('permanent-front', 4000),
      permItem('permanent-left', 2750),
      permItem('permanent-back', 3500),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    const b = packages.find((p) => p.id === 'B')!;
    expect(b.name).toBe('Front & Left Side');
    expect(b.tagline).toBe('The front plus the left side.');
    expect(b.includedItemIds.sort()).toEqual(['permanent-front', 'permanent-left']);
    expect(b.total).toBe(priceSelection(4000 + 2750, CHARGES).total);
  });

  it('WT-05: one drawn side only (right), no front → B is "Right Side"', () => {
    const lineItems = [permItem('permanent-right', 2500), permItem('permanent-back', 3500)];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    const b = packages.find((p) => p.id === 'B')!;
    expect(b.name).toBe('Right Side');
    expect(b.tagline).toBe('The right side.');
    expect(b.includedItemIds).toEqual(['permanent-right']);
  });

  it('WT-05: front + right side only → B is "Front & Right Side"', () => {
    const lineItems = [permItem('permanent-front', 4000), permItem('permanent-right', 2500)];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    const b = packages.find((p) => p.id === 'B')!;
    expect(b.name).toBe('Front & Right Side');
    expect(b.tagline).toBe('The front plus the right side.');
    expect(b.includedItemIds.sort()).toEqual(['permanent-front', 'permanent-right']);
  });

  it('WT-05: left-only, no front → B is "Left Side"', () => {
    const lineItems = [permItem('permanent-left', 2750)];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    const b = packages.find((p) => p.id === 'B')!;
    expect(b.name).toBe('Left Side');
    expect(b.tagline).toBe('The left side.');
    expect(b.includedItemIds).toEqual(['permanent-left']);
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

// ---------------------------------------------------------------------------
// Staff recommendation card (package 'E') — permanent quotes only.
//
// Before this, a permanent quote had no way to show the customer "this is the
// set we picked for your home". The recommend ticks only pre-selected a tier
// when the ticked set happened to equal that tier exactly; any other mix opened
// on an unlabelled custom selection. Quote #1303 is the live example.
// ---------------------------------------------------------------------------
describe('derivePackagesPermanent — staff recommendation', () => {
  function recItem(id: string, price: number): PortalLineItem {
    return { ...permItem(id, price), recommended: true };
  }

  it('no recommendations → no E card and the tier list is unchanged', () => {
    const lineItems = [
      permItem('permanent-front', 1400),
      permItem('permanent-left', 900),
      permItem('permanent-right', 900),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    expect(packages.map((p) => p.id)).toEqual(['A', 'B']);
    expect(packages.some((p) => p.recommended)).toBe(false);
  });

  it('a recommended set that is a custom mix → its own labelled E card, FIRST', () => {
    // Front + back is no offered tier (A is front, C is back, D is everything),
    // so the recommendation needs a card of its own.
    const lineItems = [
      recItem('permanent-front', 1400),
      permItem('permanent-left', 900),
      permItem('permanent-right', 900),
      recItem('permanent-back', 1050),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    // First, not last: on a phone a fifth card lands behind the sticky
    // Approve bar at rest, and this is the card the portal pre-selects.
    expect(packages.map((p) => p.id)).toEqual(['E', 'A', 'B', 'C', 'D']);
    const e = packages.find((p) => p.id === 'E')!;
    expect(e.name).toBe('Our Recommendation');
    expect(e.recommended).toBe(true);
    expect(e.includedItemIds.slice().sort()).toEqual(['permanent-back', 'permanent-front']);
    const expected = priceSelection(1400 + 1050, CHARGES);
    expect(e.total).toBe(expected.total);
    expect(e.deposit).toBe(expected.deposit);
  });

  it('a recommended set equal to an offered tier → that tier is badged, no duplicate card', () => {
    // Front + both sides IS package B, so adding an E card would put two
    // identical-priced tiles in front of the customer.
    const lineItems = [
      recItem('permanent-front', 1400),
      recItem('permanent-left', 900),
      recItem('permanent-right', 900),
      permItem('permanent-back', 1050),
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    expect(packages.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(packages.find((p) => p.id === 'B')!.recommended).toBe(true);
    expect(packages.filter((p) => p.recommended).map((p) => p.id)).toEqual(['B']);
  });

  it('quote #1303: every surface plus a recommended custom line badges Whole Home', () => {
    // The live quote that prompted this work. All four surfaces and the Garage
    // custom line are ticked, which is exactly the Whole Home bundle.
    const lineItems = [
      recItem('permanent-front', 1400),
      recItem('permanent-left', 900),
      recItem('permanent-right', 900),
      recItem('permanent-back', 1050),
      { ...permItem('custom-0', 550, 'roofline'), recommended: true },
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    expect(packages.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(packages.find((p) => p.id === 'D')!.recommended).toBe(true);
    expect(packages.find((p) => p.id === 'D')!.total).toBe(
      priceSelection(1400 + 900 + 900 + 1050 + 550, CHARGES).total,
    );
  });

  it('the maintenance add-on never rides the E card even if flagged', () => {
    const lineItems = [
      recItem('permanent-front', 1400),
      permItem('permanent-back', 1050),
      { ...permItem('permanent-maintenance', 250, 'permanent-addon'), recommended: true },
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    for (const p of packages) expect(p.includedItemIds).not.toContain('permanent-maintenance');
    // Front alone IS package A, so it badges A rather than minting an E card.
    expect(packages.find((p) => p.id === 'E')).toBeUndefined();
    expect(packages.find((p) => p.id === 'A')!.recommended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Custom line bundling — staff choose per line whether a custom item rides
// every package or only Whole Home. Whole Home only stays the default so no
// existing quote's cards or prices move.
// ---------------------------------------------------------------------------
describe('derivePackagesPermanent — custom line bundling', () => {
  const SURFACES = [
    permItem('permanent-front', 1400),
    permItem('permanent-left', 900),
    permItem('permanent-right', 900),
    permItem('permanent-back', 1050),
  ];

  it('default (no flag) → the custom line rides Whole Home only, prices unchanged', () => {
    const lineItems = [...SURFACES, permItem('custom-0', 550, 'roofline')];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    expect(packages.find((p) => p.id === 'A')!.includedItemIds).toEqual(['permanent-front']);
    expect(packages.find((p) => p.id === 'A')!.total).toBe(priceSelection(1400, CHARGES).total);
    expect(packages.find((p) => p.id === 'C')!.includedItemIds).toEqual(['permanent-back']);
    expect(packages.find((p) => p.id === 'D')!.includedItemIds).toContain('custom-0');
  });

  it('bundleInAllTiers → the custom line rides every surface package and is priced into each', () => {
    const lineItems = [
      ...SURFACES,
      { ...permItem('custom-0', 550, 'roofline'), bundleInAllTiers: true },
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);

    const a = packages.find((p) => p.id === 'A')!;
    expect(a.includedItemIds).toEqual(['permanent-front', 'custom-0']);
    expect(a.total).toBe(priceSelection(1400 + 550, CHARGES).total);

    const b = packages.find((p) => p.id === 'B')!;
    expect(b.includedItemIds).toEqual([
      'permanent-front',
      'permanent-left',
      'permanent-right',
      'custom-0',
    ]);
    expect(b.total).toBe(priceSelection(1400 + 900 + 900 + 550, CHARGES).total);

    const c = packages.find((p) => p.id === 'C')!;
    expect(c.includedItemIds).toEqual(['permanent-back', 'custom-0']);
    expect(c.total).toBe(priceSelection(1050 + 550, CHARGES).total);

    // Whole Home already carried every custom line — its price must not move.
    const d = packages.find((p) => p.id === 'D')!;
    expect(d.total).toBe(priceSelection(1400 + 900 + 900 + 1050 + 550, CHARGES).total);
  });

  it('an all-tiers custom line never duplicates itself inside Whole Home', () => {
    const lineItems = [
      permItem('permanent-front', 1400),
      permItem('permanent-back', 1050),
      { ...permItem('custom-0', 550, 'roofline'), bundleInAllTiers: true },
    ];
    const d = derivePackagesPermanent(lineItems, RESULT).find((p) => p.id === 'D')!;
    expect(d.includedItemIds.filter((id) => id === 'custom-0')).toHaveLength(1);
    expect(d.total).toBe(priceSelection(1400 + 1050 + 550, CHARGES).total);
  });

  it('the maintenance add-on is never treated as an all-tiers custom line', () => {
    const lineItems = [
      permItem('permanent-front', 1400),
      permItem('permanent-back', 1050),
      { ...permItem('permanent-maintenance', 250, 'permanent-addon'), bundleInAllTiers: true },
    ];
    const packages = derivePackagesPermanent(lineItems, RESULT);
    for (const p of packages) expect(p.includedItemIds).not.toContain('permanent-maintenance');
  });
});
