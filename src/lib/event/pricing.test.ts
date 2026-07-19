import { describe, it, expect } from 'vitest';
import { calculateEventQuote } from './pricing';
import { DEFAULT_EVENT_RATES, type EventRates } from './types';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';

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

const R = DEFAULT_EVENT_RATES;

describe('calculateEventQuote — structure', () => {
  it('empty quote → zero totals, complete QuoteResult shape', () => {
    const r = calculateEventQuote(baseInputs(), R);
    expect(r.lineItems).toEqual([]);
    expect(r.subtotalBeforeDiscount).toBe(0);
    expect(r.total).toBe(0);
    expect(r.depositAmount).toBe(0);
    expect(r.balanceDue).toBe(0);
    expect(r.rooflineChoice).toBe('none');
    expect(r.rooflineOptions).toEqual({ santas: null, gingerbread: null });
    // Event has no such fees — always 0.
    expect(r.rushFeeAmount).toBe(0);
    expect(r.takedownAmount).toBe(0);
    expect(r.earlyInstallDiscountAmount).toBe(0);
    expect(r.minimumApplied).toBe(false);
    expect(r.fullYule).toBeUndefined();
  });

  it('freezes the rate table into eventRatesSnapshot (approve-time rate-drift guard)', () => {
    const r = calculateEventQuote(baseInputs({ santasFootage: 100 }), R);
    expect(r.eventRatesSnapshot).toEqual(R);
  });
});

describe('calculateEventQuote — roofline at EVENT rates', () => {
  it('santas front roofline priced at the event rate, not the holiday rate', () => {
    const r = calculateEventQuote(baseInputs({ santasFootage: 100, santasDifficulty: 'easy' }), R);
    // event easy = 7/ft (holiday would be 8/ft = 800)
    expect(r.rooflineOptions.santas).toEqual({ footage: 100, amount: 700 });
    expect(r.rooflineChoice).toBe('santas');
    const line = r.lineItems.find(l => l.id === 'roofline-santas');
    expect(line?.amount).toBe(700);
    expect(r.subtotalBeforeDiscount).toBe(700);
  });

  it('gingerbread = front + ridge/sides, inferred when ridge footage present', () => {
    const r = calculateEventQuote(
      baseInputs({
        santasFootage: 100,
        santasDifficulty: 'easy',
        gingerbreadFootage: 50,
        gingerbreadDifficulty: 'medium',
      }),
      R,
    );
    // 100*7 + 50*8 = 700 + 400 = 1100
    expect(r.rooflineOptions.gingerbread).toEqual({ footage: 150, amount: 1100 });
    expect(r.rooflineOptions.santas).toEqual({ footage: 100, amount: 700 });
    expect(r.rooflineChoice).toBe('gingerbread');
    expect(r.lineItems.find(l => l.id === 'roofline-gingerbread')?.amount).toBe(1100);
  });

  it('explicit rooflineChoice=santas bills santas even when gingerbread footage exists', () => {
    const r = calculateEventQuote(
      baseInputs({
        santasFootage: 100,
        santasDifficulty: 'easy',
        gingerbreadFootage: 50,
        gingerbreadDifficulty: 'medium',
        rooflineChoice: 'santas',
      }),
      R,
    );
    expect(r.rooflineChoice).toBe('santas');
    expect(r.lineItems.find(l => l.id === 'roofline-santas')?.amount).toBe(700);
    expect(r.lineItems.find(l => l.id === 'roofline-gingerbread')).toBeUndefined();
    expect(r.subtotalBeforeDiscount).toBe(700);
  });
});

describe('calculateEventQuote — minis / curtain / spritzers at event rates', () => {
  it('bush uses wrap rate; curtain + column + railing use canopy rate', () => {
    const r = calculateEventQuote(
      baseInputs({
        miniLightItems: [
          { type: 'bush', wrapStyle: 'canopy', stringCount: 3 }, // 3*35 = 105
          { type: 'tree', wrapStyle: 'trunk', stringCount: 4 }, // 4*45 = 180
          { type: 'curtain', wrapStyle: 'canopy', stringCount: 2 }, // canopy 2*35 = 70
          { type: 'railing', wrapStyle: 'trunk', stringCount: 1 }, // canopy (no wrap) 1*35 = 35
        ],
      }),
      R,
    );
    expect(r.subtotalBeforeDiscount).toBe(105 + 180 + 70 + 35);
    expect(r.lineItems.some(l => /Curtain/.test(l.label))).toBe(true);
  });

  it('spritzers priced at event rates', () => {
    const r = calculateEventQuote(baseInputs({ spritzers: [{ size: '24', quantity: 2 }] }), R);
    expect(r.subtotalBeforeDiscount).toBe(150); // 2 * 75
  });
});

describe('calculateEventQuote — bistro + barrel/box supports', () => {
  it('temporary bistro priced per foot', () => {
    const r = calculateEventQuote(baseInputs({ event: { bistro: [{ footage: 50 }] } }), R);
    expect(r.subtotalBeforeDiscount).toBe(600); // 50 * 12
    expect(r.lineItems.some(l => /Bistro/i.test(l.label))).toBe(true);
  });

  it('barrel/box supports billed flat per unit', () => {
    const r = calculateEventQuote(baseInputs({ event: { barrelBoxes: 2 } }), R);
    expect(r.subtotalBeforeDiscount).toBe(300); // 2 * 150
  });
});

describe('calculateEventQuote — accessories EXCLUDED (allow-list)', () => {
  it('wreaths, garland, and bows never appear on an event quote', () => {
    const r = calculateEventQuote(
      baseInputs({
        santasFootage: 100,
        santasDifficulty: 'easy',
        wreaths: [{ size: '24noble', tier: 'bow', quantity: 1 }],
        garland: [{ length: '9ft', type: 'noble', tier: 'bow', quantity: 1 }],
        bows: [{ quantity: 2 }],
      }),
      R,
    );
    // only the roofline is billed; accessories are dropped entirely
    expect(r.subtotalBeforeDiscount).toBe(700);
    expect(r.lineItems.every(l => !/Wreath|Garland|Bow/i.test(l.label))).toBe(true);
  });
});

describe('calculateEventQuote — custom line items pass through', () => {
  it('a staff-typed custom line is billed as entered', () => {
    const r = calculateEventQuote(
      baseInputs({ customLineItems: [{ label: 'Delivery', amount: 75 }] }),
      R,
    );
    expect(r.subtotalBeforeDiscount).toBe(75);
    expect(r.lineItems.find(l => l.label === 'Delivery')?.amount).toBe(75);
  });
});

describe('calculateEventQuote — totals math (no rush/takedown/early-install)', () => {
  it('tax 8.75% + 50% deposit, mirroring the holiday rounding', () => {
    const r = calculateEventQuote(baseInputs({ santasFootage: 100, santasDifficulty: 'easy' }), R);
    // subtotal 700 → tax 61.25 → total 761.25 → deposit 380.63 → balance 380.62
    expect(r.taxableAmount).toBe(700);
    expect(r.taxAmount).toBeCloseTo(61.25, 2);
    expect(r.total).toBeCloseTo(761.25, 2);
    expect(r.depositAmount).toBeCloseTo(380.63, 2);
    expect(r.balanceDue).toBeCloseTo(380.62, 2);
  });

  it('percentage discount comes off the subtotal before tax', () => {
    const r = calculateEventQuote(
      baseInputs({
        santasFootage: 100,
        santasDifficulty: 'easy',
        discount: { type: 'percentage', amount: 0.1 },
      }),
      R,
    );
    expect(r.discountAmount).toBe(70); // 10% of 700
    expect(r.subtotalAfterDiscount).toBe(630);
    expect(r.taxAmount).toBeCloseTo(55.13, 2);
    expect(r.total).toBeCloseTo(685.13, 2);
  });

  it('flat discount comes off the subtotal before tax (e.g. a referral credit)', () => {
    const r = calculateEventQuote(
      baseInputs({
        santasFootage: 100,
        santasDifficulty: 'easy',
        discount: { type: 'flat', amount: 100 },
      }),
      R,
    );
    expect(r.discountAmount).toBe(100);
    expect(r.subtotalAfterDiscount).toBe(600);
    expect(r.taxAmount).toBeCloseTo(52.5, 2);
    expect(r.total).toBeCloseTo(652.5, 2);
  });

  it('never produces a negative total/deposit when a discount exceeds the subtotal', () => {
    const r = calculateEventQuote(
      baseInputs({
        santasFootage: 100,
        santasDifficulty: 'easy', // subtotal 700
        discount: { type: 'flat', amount: 5000 }, // absurd over-discount
      }),
      R,
    );
    expect(r.subtotalAfterDiscount).toBe(0); // floored, not negative
    expect(r.taxableAmount).toBe(0);
    expect(r.total).toBe(0);
    expect(r.depositAmount).toBe(0);
    expect(r.balanceDue).toBe(0);
  });
});

describe('calculateEventQuote — #104 per-line price overrides', () => {
  it('a roofline override sets the billed roofline amount (e.g. $0 free)', () => {
    const r = calculateEventQuote(
      baseInputs({
        santasFootage: 100,
        santasDifficulty: 'easy',
        lineItemPriceOverrides: { 'roofline-santas': { amount: 0 } },
      }),
      R,
    );
    expect(r.rooflineOptions.santas?.amount).toBe(0);
    expect(r.lineItems.find(l => l.id === 'roofline-santas')?.amount).toBe(0);
    expect(r.subtotalBeforeDiscount).toBe(0);
    expect(r.rooflineChoice).toBe('santas');
  });

  it('a rest-item override (by stable id) sets that line total', () => {
    const r = calculateEventQuote(
      baseInputs({
        miniLightItems: [{ id: 'mini-1', type: 'bush', wrapStyle: 'canopy', stringCount: 3 }],
        lineItemPriceOverrides: { 'mini-1': { amount: 40 } },
      }),
      R,
    );
    // computed 3*35 = 105, overridden to 40
    expect(r.lineItems.find(l => l.id === 'mini-1')?.amount).toBe(40);
    expect(r.subtotalBeforeDiscount).toBe(40);
  });

  it('a $0 override is a valid free item — does NOT trip the $0-rate guardrail', () => {
    expect(() =>
      calculateEventQuote(
        baseInputs({
          spritzers: [{ id: 'spr-1', size: '24', quantity: 1 }],
          lineItemPriceOverrides: { 'spr-1': { amount: 0 } },
        }),
        R,
      ),
    ).not.toThrow();
  });
});

describe('calculateEventQuote — $0 guardrail', () => {
  it('throws when an event rate is zero/missing (never silently bill $0)', () => {
    const badBistro: EventRates = { ...R, bistroPerFt: 0 };
    expect(() => calculateEventQuote(baseInputs({ event: { bistro: [{ footage: 50 }] } }), badBistro)).toThrow();

    const badRoofline: EventRates = { ...R, roofline: { easy: 0, medium: 6, hard: 7 } };
    expect(() => calculateEventQuote(baseInputs({ santasFootage: 100 }), badRoofline)).toThrow();
  });

  it('negative / non-finite rates also throw', () => {
    expect(() => calculateEventQuote(baseInputs(), { ...R, barrelBoxPrice: -5 })).toThrow();
    expect(() =>
      calculateEventQuote(baseInputs(), { ...R, mini: { canopy: NaN, trunk: 30 } }),
    ).toThrow();
  });
});

describe('holiday engine is untouched (both-mode regression)', () => {
  it('calculateQuote still prices a wreath while calculateEventQuote excludes it', () => {
    const inputs = baseInputs({ wreaths: [{ size: '24noble', tier: 'bow', quantity: 1 }] });
    const holiday = calculateQuote(inputs);
    // holiday wreath = $200 (BUSINESS_RULES.wreathPrices['24noble'].bow)
    expect(holiday.lineItems.some(l => /Wreath/.test(l.label))).toBe(true);
    expect(holiday.subtotalBeforeDiscount).toBe(200);

    const event = calculateEventQuote(inputs, R);
    expect(event.lineItems.some(l => /Wreath/.test(l.label))).toBe(false);
    expect(event.subtotalBeforeDiscount).toBe(0);
  });
});

describe('calculateEventQuote — half-cent boundaries', () => {
  it('rounds 8.75% tax and the deposit half-up from integer money units', () => {
    const result = calculateEventQuote(
      baseInputs({ customLineItems: [{ label: 'Boundary event item', amount: 1002.8 }] }),
      R,
    );
    expect(result.taxAmount).toBe(87.75);
    expect(result.total).toBe(1090.55);
    expect(result.depositAmount).toBe(545.28);
    expect(result.balanceDue).toBe(545.27);
  });
});
