import { describe, it, expect } from 'vitest';
import { calculatePermanentBistro } from './pricing';
import { DEFAULT_PERMANENT_BISTRO_RATES, type PermanentBistroRates } from './types';
import type { QuoteInputs } from '@/lib/pricing/pricingEngine';

function baseInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
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
    ...overrides,
  };
}

const R = DEFAULT_PERMANENT_BISTRO_RATES;

describe('calculatePermanentBistro — structure', () => {
  it('empty quote → zero totals, complete QuoteResult shape, never throws', () => {
    const r = calculatePermanentBistro(baseInputs(), R);
    expect(r.lineItems).toEqual([]);
    expect(r.subtotalBeforeDiscount).toBe(0);
    expect(r.total).toBe(0);
    expect(r.depositAmount).toBe(0);
    expect(r.balanceDue).toBe(0);
    expect(r.rooflineChoice).toBe('none');
    expect(r.rooflineOptions).toEqual({ santas: null, gingerbread: null });
    expect(r.rushFeeAmount).toBe(0);
    expect(r.takedownAmount).toBe(0);
    expect(r.earlyInstallDiscountAmount).toBe(0);
    expect(r.minimumApplied).toBe(false);
    expect(r.fullYule).toBeUndefined();
  });

  it('freezes the rate table into permanentBistroRatesSnapshot (approve-time rate-drift guard)', () => {
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { bistro: [{ footage: 10 }] } }), R);
    expect(r.permanentBistroRatesSnapshot).toEqual(R);
  });
});

describe('calculatePermanentBistro — bistro runs at DEFAULT rates', () => {
  it('100 ft of bistro at the default $30/ft → $3,000', () => {
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { bistro: [{ footage: 100 }] } }), R);
    expect(r.subtotalBeforeDiscount).toBe(3000);
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems[0].amount).toBe(3000);
  });

  it('multiple bistro lines are each priced and summed', () => {
    const r = calculatePermanentBistro(
      baseInputs({ permanentBistro: { bistro: [{ footage: 40 }, { footage: 60 }, { footage: 25 }] } }),
      R,
    );
    // 40*30 + 60*30 + 25*30 = 1200 + 1800 + 750 = 3750
    expect(r.subtotalBeforeDiscount).toBe(3750);
    expect(r.lineItems).toHaveLength(3);
    expect(r.lineItems.map((l) => l.amount)).toEqual([1200, 1800, 750]);
  });

  it('a zero/negative/non-finite footage line contributes nothing (never NaN/negative)', () => {
    const r = calculatePermanentBistro(
      baseInputs({ permanentBistro: { bistro: [{ footage: 0 }, { footage: -5 }, { footage: NaN }, { footage: 20 }] } }),
      R,
    );
    expect(r.lineItems).toHaveLength(1);
    expect(r.subtotalBeforeDiscount).toBe(600); // only the 20ft line
  });

  it('sceneItemIds + id are carried through from the input onto the priced line', () => {
    const r = calculatePermanentBistro(
      baseInputs({
        permanentBistro: { bistro: [{ id: 'bistro-1', sceneItemIds: ['scene-a', 'scene-b'], footage: 30 }] },
      }),
      R,
    );
    const line = r.lineItems[0];
    expect(line.id).toBe('bistro-1');
    expect(line.sceneItemIds).toEqual(['scene-a', 'scene-b']);
  });

  it('a bistro line with no input id gets a synthesized permanent-bistro-prefixed id', () => {
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { bistro: [{ footage: 15 }] } }), R);
    expect(r.lineItems[0].id).toMatch(/^permanent-bistro/);
  });
});

describe('calculatePermanentBistro — poles', () => {
  it('3 poles at the default $100/pole → $300', () => {
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 3 } }), R);
    expect(r.subtotalBeforeDiscount).toBe(300);
    const line = r.lineItems.find((l) => l.id === 'permanent-bistro-poles');
    expect(line?.amount).toBe(300);
  });

  it('poles = 0 or absent → no poles line', () => {
    expect(calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 0 } }), R).lineItems).toHaveLength(0);
    expect(calculatePermanentBistro(baseInputs({ permanentBistro: {} }), R).lineItems).toHaveLength(0);
  });

  it('bistro + poles combine on one quote', () => {
    const r = calculatePermanentBistro(
      baseInputs({ permanentBistro: { bistro: [{ footage: 50 }], poles: 2 } }),
      R,
    );
    // 50*30 + 2*100 = 1500 + 200 = 1700
    expect(r.subtotalBeforeDiscount).toBe(1700);
    expect(r.lineItems).toHaveLength(2);
  });
});

describe('calculatePermanentBistro — job minimum is a GATE, not a pricing floor (mirrors permanent #18)', () => {
  // permanent/pricing.ts never applies rates.minimumJobAmount as a price floor
  // or adjustment line inside the engine — it freezes it into the snapshot and
  // the PORTAL enforces it as an approval gate (minimumOrderSubtotal, #18
  // "minimum is a gate, not a floor"). This module mirrors that exactly: no
  // floor logic lives here, for minimum=0 OR minimum>0.
  it('a subtotal below a POSITIVE minimum is NOT bumped up — no adjustment line, no floor', () => {
    const highMin: PermanentBistroRates = { ...R, minimum: 5000 };
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { bistro: [{ footage: 10 }] } }), highMin);
    expect(r.subtotalBeforeDiscount).toBe(300); // 10 * 30, untouched by the 5000 minimum
    expect(r.lineItems).toHaveLength(1);
    expect(r.minimumApplied).toBe(false);
  });

  it('minimum=0 is an exact no-op — identical pricing to a positive minimum on the same inputs', () => {
    const zeroMin: PermanentBistroRates = { ...R, minimum: 0 };
    const posMin: PermanentBistroRates = { ...R, minimum: 5000 };
    const inputs = baseInputs({ permanentBistro: { bistro: [{ footage: 10 }] } });
    const rZero = calculatePermanentBistro(inputs, zeroMin);
    const rPos = calculatePermanentBistro(inputs, posMin);
    expect(rZero.subtotalBeforeDiscount).toBe(rPos.subtotalBeforeDiscount);
    expect(rZero.total).toBe(rPos.total);
    expect(rZero.lineItems).toHaveLength(rPos.lineItems.length);
  });

  it('the minimum value is still frozen into the snapshot for a later portal gate to read', () => {
    const highMin: PermanentBistroRates = { ...R, minimum: 2500 };
    const r = calculatePermanentBistro(baseInputs(), highMin);
    expect(r.permanentBistroRatesSnapshot?.minimum).toBe(2500);
  });
});

describe('calculatePermanentBistro — custom line items pass through', () => {
  it('a staff-typed custom line is billed as entered', () => {
    const r = calculatePermanentBistro(baseInputs({ customLineItems: [{ label: 'Delivery', amount: 75 }] }), R);
    expect(r.subtotalBeforeDiscount).toBe(75);
    expect(r.lineItems.find((l) => l.label === 'Delivery')?.amount).toBe(75);
  });
});

describe('calculatePermanentBistro — totals math (no rush/takedown/early-install)', () => {
  it('tax 8.75% + 50% deposit, mirroring event/holiday rounding', () => {
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { bistro: [{ footage: 100 }] } }), R);
    // subtotal 3000 → tax 262.50 → total 3262.50 → deposit 1631.25 → balance 1631.25
    expect(r.taxableAmount).toBe(3000);
    expect(r.taxAmount).toBeCloseTo(262.5, 2);
    expect(r.total).toBeCloseTo(3262.5, 2);
    expect(r.depositAmount).toBeCloseTo(1631.25, 2);
    expect(r.balanceDue).toBeCloseTo(1631.25, 2);
  });

  it('percentage discount comes off the subtotal before tax', () => {
    const r = calculatePermanentBistro(
      baseInputs({
        permanentBistro: { bistro: [{ footage: 100 }] },
        discount: { type: 'percentage', amount: 0.1 },
      }),
      R,
    );
    expect(r.discountAmount).toBe(300); // 10% of 3000
    expect(r.subtotalAfterDiscount).toBe(2700);
    expect(r.taxAmount).toBeCloseTo(236.25, 2);
  });
});

describe('calculatePermanentBistro — #104 per-line price overrides', () => {
  it('a bistro-line override (by stable id) sets that line total', () => {
    const r = calculatePermanentBistro(
      baseInputs({
        permanentBistro: { bistro: [{ id: 'bistro-1', footage: 100 }] },
        lineItemPriceOverrides: { 'bistro-1': { amount: 500 } },
      }),
      R,
    );
    // computed 100*30 = 3000, overridden to 500
    expect(r.lineItems.find((l) => l.id === 'bistro-1')?.amount).toBe(500);
    expect(r.subtotalBeforeDiscount).toBe(500);
  });

  it('a poles-line override sets the billed poles total', () => {
    const r = calculatePermanentBistro(
      baseInputs({
        permanentBistro: { poles: 3 },
        lineItemPriceOverrides: { 'permanent-bistro-poles': { amount: 0 } },
      }),
      R,
    );
    expect(r.lineItems.find((l) => l.id === 'permanent-bistro-poles')?.amount).toBe(0);
    expect(r.subtotalBeforeDiscount).toBe(0);
  });

  it('a $0 override is a valid free item — does NOT trip the $0-rate guardrail', () => {
    expect(() =>
      calculatePermanentBistro(
        baseInputs({
          permanentBistro: { bistro: [{ id: 'b-1', footage: 10 }] },
          lineItemPriceOverrides: { 'b-1': { amount: 0 } },
        }),
        R,
      ),
    ).not.toThrow();
  });
});

describe('calculatePermanentBistro — $0 guardrail', () => {
  it('throws when perFt is zero/negative/NaN (never silently bill $0)', () => {
    expect(() =>
      calculatePermanentBistro(baseInputs({ permanentBistro: { bistro: [{ footage: 10 }] } }), { ...R, perFt: 0 }),
    ).toThrow();
    expect(() =>
      calculatePermanentBistro(baseInputs(), { ...R, perFt: -1 }),
    ).toThrow();
    expect(() =>
      calculatePermanentBistro(baseInputs(), { ...R, perFt: NaN }),
    ).toThrow();
  });

  it('throws when perPole is zero (never silently bill $0)', () => {
    expect(() => calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 2 } }), { ...R, perPole: 0 })).toThrow();
  });

  it('does NOT throw when minimum is 0 (the valid gate-off value)', () => {
    expect(() => calculatePermanentBistro(baseInputs(), { ...R, minimum: 0 })).not.toThrow();
  });

  it('throws when minimum is negative or non-finite (a misconfigured rate table)', () => {
    expect(() => calculatePermanentBistro(baseInputs(), { ...R, minimum: -1 })).toThrow();
    expect(() => calculatePermanentBistro(baseInputs(), { ...R, minimum: NaN })).toThrow();
  });
});
