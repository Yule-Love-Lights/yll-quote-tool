import { describe, it, expect } from 'vitest';
import { priceSelection, chargesFromResult, minimumOrderSubtotal, orderMinimumStatus, installDiscountRate, effectiveCharges, pickInitialPackageId, derivePackages, derivePackagesLegacyRebook, applyOurRecommendation } from './derivePackages';
import { BUSINESS_RULES, type QuoteResult } from '@/lib/pricing/pricingEngine';
import type { PortalCharges, SelectionCharges, PortalLineItem, PortalLineItemKind, PortalPackage, PortalRoofline } from '@/components/portal/types';

// Standard tax, no per-job fees — the common case.
const PLAIN: SelectionCharges = { rushFee: 0, takedown: 0, taxRate: 0.08625 };

// Minimal QuoteResult for chargesFromResult tests — only the fields it
// reads matter; the rest are zeroed.
function resultWith(overrides: Partial<QuoteResult>): QuoteResult {
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

function item(id: string, price: number): PortalLineItem {
  return { id, kind: 'roofline', label: id, detail: '', price };
}

// Kind-varied line item for tier-composition tests.
function li(id: string, kind: PortalLineItemKind, price: number): PortalLineItem {
  return { id, kind, label: id, detail: '', price };
}

const ROOFLINE_GROUP: PortalRoofline = {
  itemIds: ['roofline-santas', 'roofline-gingerbread'],
  recommendedItemId: 'roofline-santas',
};

function pkg(id: PortalPackage['id'], includedItemIds: string[], total: number): PortalPackage {
  return { id, name: id, tagline: '', total, deposit: total / 2, includedItemIds };
}

describe('pickInitialPackageId — fallback default clears the $1,000 minimum (#12)', () => {
  // Roofline $320 + 3 bushes = B $635 (under $1k); + spritzers + wreath = C $1,175.
  const lineItems = [
    item('roofline-santas', 320),
    item('bush-0', 105), item('bush-1', 105), item('bush-2', 105),
    item('spritzer-0', 85), item('spritzer-1', 85), item('spritzer-2', 85),
    item('wreath-0', 285),
  ];
  const B = ['roofline-santas', 'bush-0', 'bush-1', 'bush-2']; // 635
  const C = [...B, 'spritzer-0', 'spritzer-1', 'spritzer-2', 'wreath-0']; // 1175
  const packages = [pkg('A', ['roofline-santas'], 320), pkg('B', B, 635), pkg('C', C, 1175), pkg('D', [], 0)];

  it('escalates to the first tier that clears the minimum (A and B both short)', () => {
    expect(pickInitialPackageId(packages, lineItems, 1000)).toBe('C');
  });

  it('takes the first clearing tier in A→B→C order (skips empty A)', () => {
    const items2 = [item('roofline-santas', 1200)];
    const pkgs2 = [pkg('B', ['roofline-santas'], 1200), pkg('C', ['roofline-santas'], 1200), pkg('D', [], 0)];
    expect(pickInitialPackageId(pkgs2, items2, 1000)).toBe('B');
  });

  it('defaults to Tier 1 (A) when the gate is waived or unspecified (Jason S12)', () => {
    expect(pickInitialPackageId(packages, lineItems, 0)).toBe('A');
    expect(pickInitialPackageId(packages)).toBe('A'); // legacy 1-arg call → Tier 1
  });

  it('picks the largest tier when nothing clears (defensive)', () => {
    expect(pickInitialPackageId(packages, lineItems, 99999)).toBe('C');
  });
});

describe('derivePackages — tier composition (Jason S12)', () => {
  // Charges don't matter for composition (only includedItemIds); a zeroed
  // QuoteResult prices with the business tax rate, which is fine here.
  const result = resultWith({});

  it('Tier 1 = Santa\'s + cheapest spritzers to clear $1,000; Tier 2 swaps in Gingerbread', () => {
    const lineItems = [
      li('roofline-santas', 'roofline', 600),
      li('roofline-gingerbread', 'ridge', 900),
      li('spritzer-0', 'spritzer', 150),
      li('spritzer-1', 'spritzer', 150),
      li('spritzer-2', 'spritzer', 150),
      li('wreath-0', 'wreath', 300),
    ];
    const pkgs = derivePackages(lineItems, result, ROOFLINE_GROUP);
    const A = pkgs.find((p) => p.id === 'A')!;
    const B = pkgs.find((p) => p.id === 'B')!;
    const C = pkgs.find((p) => p.id === 'C')!;
    // 600 + 150 + 150 + 150 = 1050 ≥ 1000 → 3 spritzers (wreath never reached).
    expect(A.includedItemIds).toEqual(['roofline-santas', 'spritzer-0', 'spritzer-1', 'spritzer-2']);
    // Tier 2 inherits Tier 1 with Santa's → Gingerbread.
    expect(B.includedItemIds).toEqual(['roofline-gingerbread', 'spritzer-0', 'spritzer-1', 'spritzer-2']);
    // Tier 3 = everything on Gingerbread (never Santa's, never both).
    expect(C.includedItemIds).toContain('roofline-gingerbread');
    expect(C.includedItemIds).not.toContain('roofline-santas');
    expect(C.includedItemIds).toEqual(
      expect.arrayContaining(['spritzer-0', 'spritzer-1', 'spritzer-2', 'wreath-0']),
    );
    // D is the empty Build-Your-Own slot until applyOurRecommendation runs.
    expect(pkgs.find((p) => p.id === 'D')!.includedItemIds).toEqual([]);
  });

  it('keeps only the spritzers needed when roofline + all spritzers already clears $1,000', () => {
    const lineItems = [
      li('roofline-santas', 'roofline', 800),
      li('roofline-gingerbread', 'ridge', 1200),
      li('spritzer-0', 'spritzer', 150),
      li('spritzer-1', 'spritzer', 150),
      li('spritzer-2', 'spritzer', 150),
    ];
    const A = derivePackages(lineItems, result, ROOFLINE_GROUP).find((p) => p.id === 'A')!;
    // 800 + 150 = 950 (< 1000), + 150 = 1100 (≥ 1000) → 2 spritzers; the 3rd is trimmed.
    expect(A.includedItemIds).toEqual(['roofline-santas', 'spritzer-0', 'spritzer-1']);
  });

  it('is the roofline alone when Santa\'s already clears $1,000', () => {
    const lineItems = [
      li('roofline-santas', 'roofline', 1100),
      li('roofline-gingerbread', 'ridge', 1600),
      li('spritzer-0', 'spritzer', 150),
    ];
    const A = derivePackages(lineItems, result, ROOFLINE_GROUP).find((p) => p.id === 'A')!;
    expect(A.includedItemIds).toEqual(['roofline-santas']);
  });

  it('falls back to extras (cheapest-first) when roofline + all spritzers is under $1,000', () => {
    const lineItems = [
      li('roofline-santas', 'roofline', 400),
      li('roofline-gingerbread', 'ridge', 700),
      li('spritzer-0', 'spritzer', 100),
      li('bush-0', 'bush', 200),
      li('tree-0', 'tree', 350),
    ];
    const A = derivePackages(lineItems, result, ROOFLINE_GROUP).find((p) => p.id === 'A')!;
    // 400 + spritzer 100 = 500 (all spritzers in); extras cheapest-first: + bush 200
    // = 700, + tree 350 = 1050 ≥ 1000.
    expect(A.includedItemIds).toEqual(['roofline-santas', 'spritzer-0', 'bush-0', 'tree-0']);
  });

  it('omits Tier 2 entirely when the quote has no distinct Gingerbread option', () => {
    const lineItems = [
      li('roofline-santas', 'roofline', 1100),
      li('spritzer-0', 'spritzer', 150),
    ];
    const onlySantas: PortalRoofline = { itemIds: ['roofline-santas'], recommendedItemId: 'roofline-santas' };
    const pkgs = derivePackages(lineItems, result, onlySantas);
    // Tier 2 would byte-duplicate Tier 1 (nothing to swap to) and over-promise a
    // Gingerbread upgrade, so it's dropped — the visible tiers stay A, C, D.
    expect(pkgs.map((p) => p.id)).toEqual(['A', 'C', 'D']);
    expect(pkgs.find((p) => p.id === 'B')).toBeUndefined();
    expect(pkgs.find((p) => p.id === 'A')!.includedItemIds).toEqual(['roofline-santas']);
    // Tier 3 still exists and carries everything (roofline + the spritzer).
    expect(pkgs.find((p) => p.id === 'C')!.includedItemIds).toEqual(['roofline-santas', 'spritzer-0']);
  });
});

describe('applyOurRecommendation — the "Our Recommendation" (D) card (#12, Jason S12)', () => {
  const charges: PortalCharges = {
    taxRate: 0, // keep the math simple — total === subtotal
    rush: { amount: 150, defaultOn: false },
    takedown: { amount: 150, defaultOn: false },
  };
  const basePackages: PortalPackage[] = [
    pkg('A', ['roofline-santas'], 0),
    pkg('B', [], 0),
    pkg('C', [], 0),
    { ...pkg('D', [], 0), name: 'Build Your Own' },
  ];

  it('populates D with the recommended items + recommended roofline when staff recommended some', () => {
    const lineItems: PortalLineItem[] = [
      li('roofline-santas', 'roofline', 600),
      { ...li('wreath-0', 'wreath', 300), recommended: true },
      li('bush-0', 'bush', 100),
    ];
    const D = applyOurRecommendation(basePackages, lineItems, ROOFLINE_GROUP, charges).find((p) => p.id === 'D')!;
    expect(D.name).toBe('Our Recommendation');
    expect(D.recommended).toBe(true);
    expect(new Set(D.includedItemIds)).toEqual(new Set(['wreath-0', 'roofline-santas']));
    expect(D.total).toBe(900); // 300 + 600, taxRate 0
  });

  it('leaves D as the empty "Build Your Own" card when nothing is recommended', () => {
    const lineItems: PortalLineItem[] = [
      li('roofline-santas', 'roofline', 600),
      li('wreath-0', 'wreath', 300),
    ];
    const D = applyOurRecommendation(basePackages, lineItems, ROOFLINE_GROUP, charges).find((p) => p.id === 'D')!;
    expect(D.name).toBe('Build Your Own');
    expect(D.includedItemIds).toEqual([]);
    expect(D.recommended).toBeUndefined();
  });
});

describe('derivePackagesLegacyRebook — the single "Last Year\'s Design" package (#155)', () => {
  it('bundles every line item into exactly ONE package named "Last Year\'s Design", priced like the tiers', () => {
    const result = resultWith({});
    const lineItems = [li('custom-0', 'spritzer', 2000)];
    const pkgs = derivePackagesLegacyRebook(lineItems, result);
    expect(pkgs).toHaveLength(1);
    const p = pkgs[0];
    expect(p.id).toBe('D');
    expect(p.name).toBe("Last Year's Design");
    expect(p.tagline).toBe('Everything from last year.');
    expect(p.recommended).toBe(true);
    expect(p.includedItemIds).toEqual(['custom-0']);
    // Same money mechanism as the holiday tiers: staff-default fee toggles
    // (both off on this result) + priceSelection.
    const expected = priceSelection(2000, effectiveCharges(chargesFromResult(result), false, false));
    expect(p.total).toBe(expected.total);
    expect(p.deposit).toBe(expected.deposit);
  });

  it('staff-default fees ride the tile total (rush defaulted on)', () => {
    const result = resultWith({ rushFeeAmount: BUSINESS_RULES.rushFeeAmount });
    const lineItems = [li('custom-0', 'spritzer', 2000)];
    const p = derivePackagesLegacyRebook(lineItems, result)[0];
    const expected = priceSelection(2000, effectiveCharges(chargesFromResult(result), true, false));
    expect(p.total).toBe(expected.total);
  });

  it('never bundles both mutually-exclusive rooflines — Gingerbread wins (no front double-bill)', () => {
    const result = resultWith({});
    const lineItems = [
      li('roofline-santas', 'roofline', 600),
      li('roofline-gingerbread', 'ridge', 900),
      li('wreath-0', 'wreath', 300),
    ];
    const p = derivePackagesLegacyRebook(lineItems, result)[0];
    expect(p.includedItemIds).toEqual(['roofline-gingerbread', 'wreath-0']);
    const expected = priceSelection(1200, effectiveCharges(chargesFromResult(result), false, false));
    expect(p.total).toBe(expected.total);
  });

  it('returns [] for an empty quote (defensive, matches derivePackagesEvent)', () => {
    expect(derivePackagesLegacyRebook([], resultWith({}))).toEqual([]);
  });
});

describe('priceSelection — real price, no $1,000 floor (#18)', () => {
  it('returns an all-zero breakdown for an empty or negative selection', () => {
    expect(priceSelection(0, PLAIN)).toEqual({
      subtotal: 0, discount: 0, rushFee: 0, takedown: 0, taxable: 0, tax: 0, total: 0, deposit: 0,
    });
    expect(priceSelection(-50, PLAIN)).toEqual({
      subtotal: 0, discount: 0, rushFee: 0, takedown: 0, taxable: 0, tax: 0, total: 0, deposit: 0,
    });
  });

  it('prices a sub-$1,000 selection at its REAL value (no floor — minimum is a gate)', () => {
    // $600 of items stays $600 + tax; it is NOT bumped to $1,000.
    const p = priceSelection(600, PLAIN);
    expect(p.subtotal).toBe(600);
    expect(p.taxable).toBe(600);
    expect(p.tax).toBe(51.75);
    expect(p.total).toBe(651.75);
    expect(p.deposit).toBe(325.88);
  });

  it('prices an above-minimum selection (subtotal + tax)', () => {
    const p = priceSelection(2000, PLAIN);
    expect(p.total).toBe(2172.5);
    expect(p.deposit).toBe(1086.25);
  });

  it('adds rush + takedown to the taxable amount, then taxes', () => {
    const charges: SelectionCharges = { rushFee: 150, takedown: 150, taxRate: 0.08625 };
    const p = priceSelection(2000, charges);
    expect(p.rushFee).toBe(150);
    expect(p.takedown).toBe(150);
    expect(p.taxable).toBe(2300);
    expect(p.total).toBe(2498.38); // $198.375 tax rounds half-up to $198.38
  });

  it('Subtotal + fees + Tax tie out to the Total (so the breakdown is honest)', () => {
    const charges: SelectionCharges = { rushFee: 150, takedown: 0, taxRate: 0.08625 };
    const p = priceSelection(1450, charges);
    expect(p.subtotal + p.rushFee + p.takedown).toBe(p.taxable);
    expect(p.taxable + p.tax).toBeCloseTo(p.total, 2);
    expect(p.deposit).toBeCloseTo(p.total * BUSINESS_RULES.depositPercentage, 2);
  });
});

describe('priceSelection — early-install discount (#40)', () => {
  const taxRate = 0.0875;

  it('takes the percentage off the item subtotal before tax', () => {
    // $1,000 of items, 15% September discount → $150 off → $850 taxable.
    const p = priceSelection(1000, { rushFee: 0, takedown: 0, taxRate, discountRate: 0.15 });
    expect(p.subtotal).toBe(1000);
    expect(p.discount).toBe(150);
    expect(p.taxable).toBe(850);
    expect(p.tax).toBe(74.38); // 850 * 0.0875 = 74.375 → 74.38
    expect(p.total).toBe(924.38);
    expect(p.deposit).toBe(462.19);
  });

  it('discounts the items, not the premium-takedown fee (which can coexist)', () => {
    // $1,000 items − 15% ($150) + $150 takedown = $1,000 taxable.
    const p = priceSelection(1000, { rushFee: 0, takedown: 150, taxRate, discountRate: 0.15 });
    expect(p.discount).toBe(150);
    expect(p.takedown).toBe(150);
    expect(p.taxable).toBe(1000);
  });

  it('no discount when the rate is 0 or absent', () => {
    expect(priceSelection(1000, { rushFee: 0, takedown: 0, taxRate, discountRate: 0 }).discount).toBe(0);
    expect(priceSelection(1000, { rushFee: 0, takedown: 0, taxRate }).discount).toBe(0);
  });
});

describe('priceSelection — manual discount flows to the portal', () => {
  const taxRate = 0.0875;

  it('applies a manual percentage off the subtotal (same path as early-install)', () => {
    // $1,000 of items, staff 20% → $200 off → $800 taxable.
    const p = priceSelection(1000, { rushFee: 0, takedown: 0, taxRate, discountRate: 0.2 });
    expect(p.discount).toBe(200);
    expect(p.taxable).toBe(800);
  });

  it('applies a manual flat dollar discount off the subtotal', () => {
    // $1,000 of items, staff $150 flat off → $850 taxable.
    const p = priceSelection(1000, { rushFee: 0, takedown: 0, taxRate, discountFlat: 150 });
    expect(p.discount).toBe(150);
    expect(p.taxable).toBe(850);
  });

  it('never discounts below $0 (a flat discount is capped at the subtotal)', () => {
    const p = priceSelection(100, { rushFee: 0, takedown: 0, taxRate, discountFlat: 250 });
    expect(p.discount).toBe(100); // capped at the $100 subtotal
    expect(p.taxable).toBe(0);
    expect(p.total).toBe(0);
  });
});

describe('installDiscountRate — Sep/Oct early-install rates (#40)', () => {
  it('maps the timing choice to its rate', () => {
    expect(installDiscountRate('september')).toBe(0.15);
    expect(installDiscountRate('october')).toBe(0.10);
    expect(installDiscountRate('none')).toBe(0);
  });
});

describe('minimumOrderSubtotal — the portal approval gate threshold (#18)', () => {
  it('is $1,000 when the quote can reach the minimum', () => {
    const lineItems = [item('a', 700), item('b', 500)]; // sum 1200
    expect(minimumOrderSubtotal(lineItems)).toBe(BUSINESS_RULES.minimumQuoteAmount);
  });

  it('is waived (0) when the whole quote totals under $1,000 (staff override)', () => {
    const lineItems = [item('a', 300), item('b', 250)]; // sum 550 < 1000
    expect(minimumOrderSubtotal(lineItems)).toBe(0);
  });

  it('is waived (0) for an empty quote', () => {
    expect(minimumOrderSubtotal([])).toBe(0);
  });

  it('gates at an explicit minimum when passed (#88 permanent rate-snapshot minimum)', () => {
    const lineItems = [item('permanent-front', 2000), item('permanent-back', 600)]; // sum 2600
    expect(minimumOrderSubtotal(lineItems, 2500)).toBe(2500);
    expect(minimumOrderSubtotal([item('permanent-front', 1000)], 2500)).toBe(0); // 1000 < 2500
  });
});

describe('orderMinimumStatus — the $1,000 gate counts rush + takedown, not just items (#47)', () => {
  const taxRate = 0.0875;

  it('a $1,000 item subtotal alone clears the gate', () => {
    const price = priceSelection(1000, { rushFee: 0, takedown: 0, taxRate });
    expect(orderMinimumStatus(price, 1000)).toEqual({ meetsMinimum: true, amountToMinimum: 0 });
  });

  it('items under $1,000 are pushed over the line by the rush/takedown fees (#47 — the bug)', () => {
    // $950 of items + $50 rush = $1,000 taxable → the gate is met even though
    // the item subtotal alone ($950) is under the minimum.
    const price = priceSelection(950, { rushFee: 50, takedown: 0, taxRate });
    expect(orderMinimumStatus(price, 1000)).toEqual({ meetsMinimum: true, amountToMinimum: 0 });
  });

  it('still short when items + fees fall under the minimum, and reports the remaining amount', () => {
    const price = priceSelection(800, { rushFee: 50, takedown: 25, taxRate }); // taxable 875
    expect(orderMinimumStatus(price, 1000)).toEqual({ meetsMinimum: false, amountToMinimum: 125 });
  });

  it('a fees-only "order" (no items selected) never meets the minimum', () => {
    // priceSelection zeroes everything when the item subtotal is 0, so the
    // fees don't sneak the customer past the gate without picking any items.
    const price = priceSelection(0, { rushFee: 200, takedown: 200, taxRate });
    expect(orderMinimumStatus(price, 1000)).toEqual({ meetsMinimum: false, amountToMinimum: 1000 });
  });

  it('a waived minimum (0) is met by any non-empty selection', () => {
    const price = priceSelection(300, { rushFee: 0, takedown: 0, taxRate });
    expect(orderMinimumStatus(price, 0)).toEqual({ meetsMinimum: true, amountToMinimum: 0 });
  });

  it('an early-install discount does NOT lower the gate (#40 — measured pre-discount)', () => {
    // $1,000 of items with a 15% September discount → $850 taxable, but the gate
    // is measured on the pre-discount $1,000 so the order still qualifies.
    const price = priceSelection(1000, { rushFee: 0, takedown: 0, taxRate, discountRate: 0.15 });
    expect(price.taxable).toBe(850);
    expect(orderMinimumStatus(price, 1000)).toEqual({ meetsMinimum: true, amountToMinimum: 0 });
  });
});

describe('chargesFromResult — per-quote fee config (#4)', () => {
  it('exposes canonical fee amounts + defaults the toggles ON when staff included the fees', () => {
    const charges = chargesFromResult(
      resultWith({ rushFeeAmount: 150, takedownAmount: 150, taxableAmount: 1000, taxAmount: 86.25 }),
    );
    expect(charges.rush).toEqual({ amount: BUSINESS_RULES.rushFeeAmount, defaultOn: true });
    expect(charges.takedown).toEqual({ amount: BUSINESS_RULES.premiumTakedownFee, defaultOn: true });
    // Audit fix (g18): taxRate is the canonical rate, not back-derived from
    // the rounded taxAmount / exact taxableAmount ratio.
    expect(charges.taxRate).toBe(BUSINESS_RULES.taxRate);
  });

  it('defaults the toggles OFF when staff omits the fees (amounts still present to toggle on)', () => {
    const charges = chargesFromResult(resultWith({ rushFeeAmount: 0, takedownAmount: 0, taxableAmount: 100, taxAmount: 8.63 }));
    expect(charges.rush.defaultOn).toBe(false);
    expect(charges.takedown.defaultOn).toBe(false);
    expect(charges.rush.amount).toBe(BUSINESS_RULES.rushFeeAmount);
    expect(charges.takedown.amount).toBe(BUSINESS_RULES.premiumTakedownFee);
  });

  it('coerces a missing fee field to a default-off toggle', () => {
    const charges = chargesFromResult({ taxableAmount: 100, taxAmount: 8.63 } as unknown as QuoteResult);
    expect(charges.rush.defaultOn).toBe(false);
    expect(charges.takedown.defaultOn).toBe(false);
  });

  it('falls back to the business tax rate when the quote had no taxable amount', () => {
    const charges = chargesFromResult(resultWith({ taxableAmount: 0, taxAmount: 0 }));
    expect(charges.taxRate).toBe(BUSINESS_RULES.taxRate);
  });

  // Audit fix (g18): on a near-zero taxable base the rounded taxAmount used to
  // back-derive an inflated rate (e.g. 0.01 / 0.10 = 0.10 ≠ 0.0875) that then
  // got applied to every package/selection total. The canonical rate is used
  // directly now, so a tiny taxable base no longer drifts the rate.
  it('uses the canonical rate (no drift) on a near-zero taxable base', () => {
    const charges = chargesFromResult(resultWith({ taxableAmount: 0.1, taxAmount: 0.01 }));
    expect(charges.taxRate).toBe(BUSINESS_RULES.taxRate);

    // ...and that exact rate is what package/selection totals are priced with.
    const priced = priceSelection(1000, effectiveCharges(charges, false, false));
    expect(priced.tax).toBe(Math.round(1000 * BUSINESS_RULES.taxRate * 100) / 100);
  });

  // Permanent Bistro Lighting: mirrors the event zeroing above — a permanent
  // bistro install never carries a rush/takedown fee (it goes up once), so a
  // stray/forged toggle on the live portal must still price to $0.
  it('zeroes rush/takedown amounts for a permanent bistro result (defense in depth)', () => {
    const charges = chargesFromResult(
      resultWith({
        rushFeeAmount: 0,
        takedownAmount: 0,
        taxableAmount: 100,
        taxAmount: 8.63,
        permanentBistroRatesSnapshot: { perFt: 30, perPole: 100, minimum: 0, maintenancePrice: 0 },
      }),
    );
    expect(charges.rush.amount).toBe(0);
    expect(charges.takedown.amount).toBe(0);
    // Toggling "on" a zero-amount fee still adds nothing.
    expect(effectiveCharges(charges, true, true)).toEqual({
      rushFee: 0,
      takedown: 0,
      taxRate: charges.taxRate,
      discountRate: 0,
      discountFlat: 0,
    });
  });

  // WT-06 (audit): plain permanent (#88) never carries a rush/takedown fee
  // either (year-round track install, no seasonal takedown) — mirrors the
  // permanent bistro zeroing above. Before this fix, `noHolidayFees` only
  // checked isEvent/isPermanentBistro, so a regressed isHoliday UI gate could
  // have shown a phantom $150 rush/takedown fee on a permanent portal that the
  // server never charges.
  it('zeroes rush/takedown amounts for a plain permanent result (defense in depth)', () => {
    const charges = chargesFromResult(
      resultWith({
        rushFeeAmount: 0,
        takedownAmount: 0,
        taxableAmount: 100,
        taxAmount: 8.63,
        permanentRatesSnapshot: {
          frontPerFt: 40,
          sidesPerFt: 35,
          backPerFt: 35,
          minimumJobAmount: 2500,
          maintenancePrice: 0,
        },
      }),
    );
    expect(charges.rush.amount).toBe(0);
    expect(charges.takedown.amount).toBe(0);
    // Toggling "on" a zero-amount fee still adds nothing.
    expect(effectiveCharges(charges, true, true)).toEqual({
      rushFee: 0,
      takedown: 0,
      taxRate: charges.taxRate,
      discountRate: 0,
      discountFlat: 0,
    });
  });
});

describe('effectiveCharges — toggle state → priceSelection input (#4)', () => {
  const config: PortalCharges = {
    taxRate: 0.08625,
    rush: { amount: 150, defaultOn: false },
    takedown: { amount: 200, defaultOn: true },
  };

  it('includes a fee amount only when its toggle is on', () => {
    expect(effectiveCharges(config, true, false)).toEqual({ rushFee: 150, takedown: 0, taxRate: 0.08625, discountRate: 0, discountFlat: 0 });
    expect(effectiveCharges(config, false, true)).toEqual({ rushFee: 0, takedown: 200, taxRate: 0.08625, discountRate: 0, discountFlat: 0 });
    expect(effectiveCharges(config, true, true)).toEqual({ rushFee: 150, takedown: 200, taxRate: 0.08625, discountRate: 0, discountFlat: 0 });
    expect(effectiveCharges(config, false, false)).toEqual({ rushFee: 0, takedown: 0, taxRate: 0.08625, discountRate: 0, discountFlat: 0 });
  });

  it('passes through a discount rate and a flat discount', () => {
    expect(effectiveCharges(config, false, false, 0.15)).toEqual({ rushFee: 0, takedown: 0, taxRate: 0.08625, discountRate: 0.15, discountFlat: 0 });
    expect(effectiveCharges(config, false, false, 0, 100)).toEqual({ rushFee: 0, takedown: 0, taxRate: 0.08625, discountRate: 0, discountFlat: 100 });
  });
});


describe('priceSelection — exact half-cent tax rounding', () => {
  it('matches the pricing engine at the $1,002.80 × 8.75% boundary', () => {
    const p = priceSelection(1002.8, { rushFee: 0, takedown: 0, taxRate: 0.0875 });
    expect(p.tax).toBe(87.75);
    expect(p.total).toBe(1090.55);
    expect(p.deposit).toBe(545.28);
  });
});
