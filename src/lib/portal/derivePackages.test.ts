import { describe, it, expect } from 'vitest';
import { priceSelection, chargesFromResult, minimumOrderSubtotal, effectiveCharges } from './derivePackages';
import { BUSINESS_RULES, type QuoteResult } from '@/lib/pricing/pricingEngine';
import type { PortalCharges, SelectionCharges, PortalLineItem } from '@/components/portal/types';

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
    ...overrides,
  } as QuoteResult;
}

function item(id: string, price: number): PortalLineItem {
  return { id, kind: 'roofline', label: id, detail: '', price };
}

describe('priceSelection — real price, no $1,000 floor (#18)', () => {
  it('returns an all-zero breakdown for an empty or negative selection', () => {
    expect(priceSelection(0, PLAIN)).toEqual({
      subtotal: 0, rushFee: 0, takedown: 0, taxable: 0, tax: 0, total: 0, deposit: 0,
    });
    expect(priceSelection(-50, PLAIN)).toEqual({
      subtotal: 0, rushFee: 0, takedown: 0, taxable: 0, tax: 0, total: 0, deposit: 0,
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
    expect(effectiveCharges(config, true, false)).toEqual({ rushFee: 150, takedown: 0, taxRate: 0.08625 });
    expect(effectiveCharges(config, false, true)).toEqual({ rushFee: 0, takedown: 200, taxRate: 0.08625 });
    expect(effectiveCharges(config, true, true)).toEqual({ rushFee: 150, takedown: 200, taxRate: 0.08625 });
    expect(effectiveCharges(config, false, false)).toEqual({ rushFee: 0, takedown: 0, taxRate: 0.08625 });
  });
});
