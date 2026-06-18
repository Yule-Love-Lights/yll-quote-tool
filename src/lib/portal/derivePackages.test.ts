import { describe, it, expect } from 'vitest';
import { priceSelection, chargesFromResult, minimumOrderSubtotal, orderMinimumStatus, installDiscountRate, effectiveCharges, pickInitialPackageId } from './derivePackages';
import { BUSINESS_RULES, type QuoteResult } from '@/lib/pricing/pricingEngine';
import type { PortalCharges, SelectionCharges, PortalLineItem, PortalPackage } from '@/components/portal/types';

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

  it('escalates past B to a tier that clears the minimum', () => {
    expect(pickInitialPackageId(packages, lineItems, 1000)).toBe('C');
  });

  it('keeps B when B already clears the minimum', () => {
    const items2 = [item('roofline-santas', 1200)];
    const pkgs2 = [pkg('B', ['roofline-santas'], 1200), pkg('C', ['roofline-santas'], 1200), pkg('D', [], 0)];
    expect(pickInitialPackageId(pkgs2, items2, 1000)).toBe('B');
  });

  it("keeps today's behavior (B-preferred) when the gate is waived or unspecified", () => {
    expect(pickInitialPackageId(packages, lineItems, 0)).toBe('B');
    expect(pickInitialPackageId(packages)).toBe('B'); // legacy 1-arg call unchanged
  });

  it('picks the largest tier when nothing clears (defensive)', () => {
    expect(pickInitialPackageId(packages, lineItems, 99999)).toBe('C');
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
    expect(p.total).toBe(2498.37); // 2300 * 1.08625, rounded to cents
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
    expect(charges.taxRate).toBeCloseTo(0.08625, 5);
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
});

describe('effectiveCharges — toggle state → priceSelection input (#4)', () => {
  const config: PortalCharges = {
    taxRate: 0.08625,
    rush: { amount: 150, defaultOn: false },
    takedown: { amount: 200, defaultOn: true },
  };

  it('includes a fee amount only when its toggle is on', () => {
    expect(effectiveCharges(config, true, false)).toEqual({ rushFee: 150, takedown: 0, taxRate: 0.08625, discountRate: 0 });
    expect(effectiveCharges(config, false, true)).toEqual({ rushFee: 0, takedown: 200, taxRate: 0.08625, discountRate: 0 });
    expect(effectiveCharges(config, true, true)).toEqual({ rushFee: 150, takedown: 200, taxRate: 0.08625, discountRate: 0 });
    expect(effectiveCharges(config, false, false)).toEqual({ rushFee: 0, takedown: 0, taxRate: 0.08625, discountRate: 0 });
  });

  it('passes through an early-install discount rate (#40)', () => {
    expect(effectiveCharges(config, false, false, 0.15)).toEqual({ rushFee: 0, takedown: 0, taxRate: 0.08625, discountRate: 0.15 });
  });
});
