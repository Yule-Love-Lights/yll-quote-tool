import { describe, it, expect } from 'vitest';
import { calculatePermanentQuote } from './pricing';
import { DEFAULT_PERMANENT_RATES, type PermanentQuoteFields, type PermanentRates } from './types';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';

function permField(over: Partial<PermanentQuoteFields> = {}): PermanentQuoteFields {
  return {
    frontFootage: 0,
    leftFootage: 0,
    rightFootage: 0,
    backFootage: 0,
    gaps: [],
    controllerToFirstLightFt: 0,
    frontCorners: 0,
    leftCorners: 0,
    rightCorners: 0,
    backCorners: 0,
    trackStyle: 'single',
    trackColor: '9003',
    blackHousing: false,
    maintenanceAddOn: false,
    ...over,
  };
}

function inputs(perm: Partial<PermanentQuoteFields> = {}, over: Partial<QuoteInputs> = {}): QuoteInputs {
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
    permanent: permField(perm),
    ...over,
  };
}

const amt = (r: ReturnType<typeof calculatePermanentQuote>, id: string) =>
  r.lineItems.find((l) => l.id === id)?.amount;

describe('calculatePermanentQuote', () => {
  it('prices per-side footage; each side its own line (#132); totals via the shared tail', () => {
    const r = calculatePermanentQuote(inputs({ frontFootage: 120, leftFootage: 50, rightFootage: 40, backFootage: 60 }));
    expect(amt(r, 'permanent-front')).toBe(4800); // 120 * 40
    expect(amt(r, 'permanent-left')).toBe(1750); // 50 * 35
    expect(amt(r, 'permanent-right')).toBe(1400); // 40 * 35
    expect(amt(r, 'permanent-back')).toBe(2100); // 60 * 35
    expect(r.lineItems.map((l) => l.id)).toEqual([
      'permanent-front', 'permanent-left', 'permanent-right', 'permanent-back',
    ]);
    expect(r.subtotalBeforeDiscount).toBe(10050);
    expect(r.taxAmount).toBe(879.38); // 10050 * 0.0875
    expect(r.total).toBe(10929.38);
    expect(r.depositAmount).toBe(5464.69); // 50%
    expect(r.balanceDue).toBe(5464.69);
    // holiday-shape fields present + inert
    expect(r.rooflineChoice).toBe('none');
    expect(r.rooflineOptions).toEqual({ santas: null, gingerbread: null });
    expect(r.minimumApplied).toBe(false);
    expect(r.fullYule).toBeUndefined();
  });

  it('emits no line for a zero-footage side; NaN/negative footage → 0', () => {
    const r = calculatePermanentQuote(inputs({ frontFootage: 100 })); // sides + back are 0
    expect(amt(r, 'permanent-front')).toBe(4000);
    expect(r.lineItems.map((l) => l.id)).toEqual(['permanent-front']);

    const bad = calculatePermanentQuote(inputs({ frontFootage: Number.NaN, leftFootage: -20, rightFootage: 30 }));
    expect(bad.lineItems.find((l) => l.id === 'permanent-front')).toBeUndefined(); // NaN → 0 → no line
    expect(bad.lineItems.find((l) => l.id === 'permanent-left')).toBeUndefined(); // -20 clamps to 0 → no line
    expect(amt(bad, 'permanent-right')).toBe(30 * 35);
    expect(bad.lineItems.map((l) => l.id)).toEqual(['permanent-right']);
  });

  it('honors a per-quote custom $/ft only when positive-finite', () => {
    const custom = calculatePermanentQuote(inputs({ frontFootage: 120, frontCustomRate: 50 }));
    expect(amt(custom, 'permanent-front')).toBe(6000); // 120 * 50 (override)

    const zero = calculatePermanentQuote(inputs({ frontFootage: 120, frontCustomRate: 0 }));
    expect(amt(zero, 'permanent-front')).toBe(4800); // 0 → falls back to $40 table

    const sidesCustom = calculatePermanentQuote(inputs({ leftFootage: 50, rightFootage: 50, sidesCustomRate: 30 }));
    expect(amt(sidesCustom, 'permanent-left')).toBe(1500); // 50 * 30 — one custom rate covers both sides
    expect(amt(sidesCustom, 'permanent-right')).toBe(1500);
  });

  it('applies a #104 line-item total override (presence-keyed — 0 is honored)', () => {
    const r = calculatePermanentQuote(
      inputs({ frontFootage: 120 }, { lineItemPriceOverrides: { 'permanent-front': { amount: 0 } } }),
    );
    expect(amt(r, 'permanent-front')).toBe(0);
    expect(r.subtotalBeforeDiscount).toBe(0);
    expect(r.total).toBe(0);
  });

  it('shows the maintenance add-on only when enabled AND a price is set', () => {
    const rates: PermanentRates = { ...DEFAULT_PERMANENT_RATES, maintenancePrice: 500 };
    const on = calculatePermanentQuote(inputs({ frontFootage: 100, maintenanceAddOn: true }), rates);
    expect(amt(on, 'permanent-maintenance')).toBe(500);

    const priceZero = calculatePermanentQuote(inputs({ frontFootage: 100, maintenanceAddOn: true })); // default price 0
    expect(priceZero.lineItems.find((l) => l.id === 'permanent-maintenance')).toBeUndefined();

    const flagOff = calculatePermanentQuote(inputs({ frontFootage: 100, maintenanceAddOn: false }), rates);
    expect(flagOff.lineItems.find((l) => l.id === 'permanent-maintenance')).toBeUndefined();
  });

  it('never charges rush / takedown / early-install, even if those inputs are set', () => {
    const r = calculatePermanentQuote(
      inputs({ frontFootage: 100 }, { rushFee: true, takedown: 'premium', installTiming: 'september' }),
    );
    expect(r.rushFeeAmount).toBe(0);
    expect(r.takedownAmount).toBe(0);
    expect(r.earlyInstallDiscountAmount).toBe(0);
    // total is just subtotal + 8.75% tax, no fees
    expect(r.total).toBe(4000 + 350); // 4000 + round(4000*0.0875)=350
  });

  it('honors a staff discount through the shared tail', () => {
    const r = calculatePermanentQuote(
      inputs({ frontFootage: 100 }, { discount: { type: 'flat', amount: 400 } }),
    );
    expect(r.discountAmount).toBe(400);
    expect(r.subtotalAfterDiscount).toBe(3600);
    expect(r.total).toBe(3600 + 315); // 3600 + round(3600*0.0875)=315
  });

  it('freezes the passed rates into permanentRatesSnapshot (the rate-drift guard)', () => {
    const r1: PermanentRates = { frontPerFt: 42, sidesPerFt: 37, backPerFt: 37, minimumJobAmount: 3000, maintenancePrice: 0 };
    const r = calculatePermanentQuote(inputs({ frontFootage: 100 }), r1);
    expect(amt(r, 'permanent-front')).toBe(4200); // priced at the passed rate, not the default 40
    expect(r.permanentRatesSnapshot).toEqual(r1);
  });

  it('is a structurally complete QuoteResult (every field the adapter/approve read is populated)', () => {
    const r = calculatePermanentQuote(inputs({ frontFootage: 120, leftFootage: 40 }));
    for (const k of [
      'lineItems', 'subtotalBeforeDiscount', 'discountAmount', 'earlyInstallDiscountAmount',
      'subtotalAfterDiscount', 'minimumApplied', 'rushFeeAmount', 'takedownAmount',
      'taxableAmount', 'taxAmount', 'total', 'depositAmount', 'balanceDue',
      'rooflineChoice', 'rooflineOptions', 'permanentRatesSnapshot',
    ] as const) {
      expect(r[k], `missing ${k}`).not.toBeUndefined();
    }
  });
});

describe('holiday regression — the holiday engine ignores a permanent block', () => {
  it('calculateQuote produces the same result with or without inputs.permanent present', () => {
    const holiday: QuoteInputs = inputs(
      {},
      { santasFootage: 100, santasDifficulty: 'medium', permanent: undefined },
    );
    const withPerm: QuoteInputs = { ...holiday, permanent: permField({ frontFootage: 999 }) };
    expect(calculateQuote(withPerm)).toEqual(calculateQuote(holiday));
  });
});
