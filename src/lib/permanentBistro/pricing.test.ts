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

describe('calculatePermanentBistro — annual maintenance add-on (mirrors permanent)', () => {
  it('a nonzero maintenance price adds the line at that price', () => {
    const rates: PermanentBistroRates = { ...R, maintenancePrice: 500 };
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 1 } }), rates);
    const line = r.lineItems.find((l) => l.id === 'permanent-bistro-maintenance');
    expect(line?.label).toBe('Annual Maintenance Plan');
    expect(line?.amount).toBe(500);
  });

  it('maintenancePrice = 0 (the default) hides the add-on entirely', () => {
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 1 } }), R);
    expect(r.lineItems.find((l) => l.id === 'permanent-bistro-maintenance')).toBeUndefined();
  });

  it('an unset maintenancePrice (absent from a partial rate object, sanitized to default) hides the add-on', () => {
    const rates: PermanentBistroRates = { ...DEFAULT_PERMANENT_BISTRO_RATES };
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 1 } }), rates);
    expect(r.lineItems.find((l) => l.id === 'permanent-bistro-maintenance')).toBeUndefined();
  });

  it('the maintenance line is billed on top of bistro/poles lines, not in place of them', () => {
    const rates: PermanentBistroRates = { ...R, maintenancePrice: 250 };
    const r = calculatePermanentBistro(
      baseInputs({ permanentBistro: { bistro: [{ footage: 50 }], poles: 2 } }),
      rates,
    );
    // 50*30 + 2*100 + 250 = 1500 + 200 + 250 = 1950
    expect(r.subtotalBeforeDiscount).toBe(1950);
    expect(r.lineItems).toHaveLength(3);
  });

  it('a negative/non-finite maintenancePrice never throws — it just hides the add-on (never never a $0/NaN line)', () => {
    // Unlike perFt/perPole/minimum, maintenancePrice is NOT asserted: a
    // permanentBistroRatesSnapshot frozen before this field existed has no
    // maintenancePrice key at all (reads as undefined) and must keep pricing.
    expect(() => calculatePermanentBistro(baseInputs(), { ...R, maintenancePrice: -1 })).not.toThrow();
    expect(() => calculatePermanentBistro(baseInputs(), { ...R, maintenancePrice: NaN })).not.toThrow();
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 1 } }), { ...R, maintenancePrice: -1 });
    expect(r.lineItems.find((l) => l.id === 'permanent-bistro-maintenance')).toBeUndefined();
  });

  it('does NOT throw when maintenancePrice is 0 (the valid hidden-add-on value)', () => {
    expect(() => calculatePermanentBistro(baseInputs(), { ...R, maintenancePrice: 0 })).not.toThrow();
  });

  it('a legacy rate object with maintenancePrice entirely absent (pre-dates this field) hides the add-on, never throws', () => {
    const legacyRates = { perFt: 30, perPole: 100, minimum: 0 } as PermanentBistroRates;
    expect(() => calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 1 } }), legacyRates)).not.toThrow();
    const r = calculatePermanentBistro(baseInputs({ permanentBistro: { poles: 1 } }), legacyRates);
    expect(r.lineItems.find((l) => l.id === 'permanent-bistro-maintenance')).toBeUndefined();
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
    expect(r.depositRate).toBe(0.5); // default, absent depositPercent
  });

  // #177 — permanent bistro honors the same per-quote deposit override as
  // holiday/permanent/event.
  it('honors a per-quote depositPercent override (#177)', () => {
    const r = calculatePermanentBistro(
      baseInputs({ permanentBistro: { bistro: [{ footage: 100 }] }, depositPercent: 25 }),
      R,
    );
    expect(r.total).toBeCloseTo(3262.5, 2);
    expect(r.depositAmount).toBeCloseTo(815.63, 2);
    expect(r.balanceDue).toBeCloseTo(2446.87, 2);
    expect(r.depositRate).toBe(0.25);
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

  // #212: early-install is a holiday-seasonal promo, not a general discount —
  // permanent bistro never carries it. This engine never even reads
  // inputs.installTiming (mirrors calculateEventQuote), so a forged/stale
  // 'september' pick can't sneak a discount in, same guarantee
  // lib/permanent/pricing.ts asserts explicitly for rush/takedown/early-install.
  it('never applies an early-install discount, even if installTiming is set', () => {
    const r = calculatePermanentBistro(
      baseInputs({ permanentBistro: { bistro: [{ footage: 100 }] }, installTiming: 'september' }),
      R,
    );
    expect(r.earlyInstallDiscountAmount).toBe(0);
    expect(r.total).toBeCloseTo(3262.5, 2); // same as the plain $3000-subtotal case above
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

// #117 live-E2E find: design-projected footage is a raw float (e.g.
// 9.048375887738986) and leaked into the customer-visible label. Labels show
// 1 decimal; the billed amount keeps the exact footage.
describe('calculatePermanentBistro — float footage label formatting', () => {
  it('rounds the label to 1 decimal while billing the exact footage', () => {
    const result = calculatePermanentBistro({
      permanentBistro: { bistro: [{ footage: 9.048375887738986 }] },
    } as QuoteInputs);
    const line = result.lineItems[0];
    expect(line.label).toBe('Permanent Bistro Lighting – 9ft');
    expect(line.amount).toBe(Math.round(9.048375887738986 * 30)); // 271, exact footage billed
  });

  it('keeps a meaningful decimal (17.37... shows as 17.4)', () => {
    const result = calculatePermanentBistro({
      permanentBistro: { bistro: [{ footage: 17.372831692319867 }] },
    } as QuoteInputs);
    expect(result.lineItems[0].label).toBe('Permanent Bistro Lighting – 17.4ft');
  });
});

describe('calculatePermanentBistro — half-cent boundaries', () => {
  it('rounds 8.75% tax and the deposit half-up from integer money units', () => {
    const result = calculatePermanentBistro(
      baseInputs({ customLineItems: [{ label: 'Boundary bistro item', amount: 1002.8 }] }),
      R,
    );
    expect(result.taxAmount).toBe(87.75);
    expect(result.total).toBe(1090.55);
    expect(result.depositAmount).toBe(545.28);
    expect(result.balanceDue).toBe(545.27);
  });
});
