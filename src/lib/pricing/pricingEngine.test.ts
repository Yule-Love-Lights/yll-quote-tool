import { describe, it, expect } from 'vitest';
import { calculateQuote, BUSINESS_RULES, type QuoteInputs } from './pricingEngine';

// A fully-zeroed quote. Each test overrides only the fields it exercises, so
// every assertion is about exactly one behavior.
function emptyInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    santasFootage: 0,
    santasDifficulty: 'medium',
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'medium',
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'medium',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
    ...overrides,
  };
}

describe('BUSINESS_RULES — config guard', () => {
  // Locks the core money constants so an accidental edit fails loudly.
  it('holds the expected core constants', () => {
    expect(BUSINESS_RULES.minimumQuoteAmount).toBe(1000);
    expect(BUSINESS_RULES.taxRate).toBe(0.08625);
    expect(BUSINESS_RULES.depositPercentage).toBe(0.5);
    expect(BUSINESS_RULES.rushFeeAmount).toBe(150);
    expect(BUSINESS_RULES.premiumTakedownFee).toBe(150);
  });
});

describe('calculateQuote — empty quote', () => {
  it('returns all zeros and applies no minimum when there are no items', () => {
    const r = calculateQuote(emptyInputs());
    expect(r.lineItems).toHaveLength(0);
    expect(r.subtotalBeforeDiscount).toBe(0);
    expect(r.minimumApplied).toBe(false); // minimum only applies when subtotal > 0
    expect(r.subtotalAfterDiscount).toBe(0);
    expect(r.taxAmount).toBe(0);
    expect(r.total).toBe(0);
    expect(r.depositAmount).toBe(0);
    expect(r.balanceDue).toBe(0);
  });
});

describe('calculateQuote — roofline', () => {
  it('prices a roofline at footage × difficulty rate', () => {
    const r = calculateQuote(emptyInputs({ santasFootage: 100, santasDifficulty: 'hard' })); // 100 × 12
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems[0].label).toContain("Santa's Roofline");
    expect(r.lineItems[0].amount).toBe(1200);
  });

  it('omits a roofline whose footage is 0', () => {
    const r = calculateQuote(emptyInputs({ gingerbreadFootage: 50, gingerbreadDifficulty: 'easy' })); // 50 × 8
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems[0].label).toContain('Gingerbread Ridge');
    expect(r.lineItems[0].amount).toBe(400);
  });
});

describe('calculateQuote — line-item categories', () => {
  it('prices mini lights by string count and wrap style', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'tree', wrapStyle: 'trunk', stringCount: 3 }], // 3 × 45
    }));
    expect(r.lineItems[0].amount).toBe(135);
  });

  it('prices spritzers by size and quantity', () => {
    const r = calculateQuote(emptyInputs({
      spritzers: [{ size: '24', quantity: 2 }], // 2 × 95
    }));
    expect(r.lineItems[0].amount).toBe(190);
  });

  it('prices wreaths by size and tier', () => {
    const r = calculateQuote(emptyInputs({
      wreaths: [{ size: '30noble', tier: 'fullDecor', quantity: 1 }],
    }));
    expect(r.lineItems[0].amount).toBe(355);
  });
});

describe('calculateQuote — garland (incl. 4.5ft regression)', () => {
  it('prices 9ft noble garland by tier', () => {
    const r = calculateQuote(emptyInputs({
      garland: [{ type: 'noble', length: '9ft', tier: 'labor', quantity: 1 }],
    }));
    expect(r.lineItems[0].amount).toBe(165);
  });

  // Regression: 4.5ft was a {0,0,0} placeholder that silently priced at $0.
  // labor + fullDecor are now real; this guards against a reversion.
  it('prices 4.5ft noble garland: labor $135, fullDecor $210', () => {
    const labor = calculateQuote(emptyInputs({
      garland: [{ type: 'noble', length: '4.5ft', tier: 'labor', quantity: 1 }],
    }));
    expect(labor.lineItems[0].amount).toBe(135);

    const full = calculateQuote(emptyInputs({
      garland: [{ type: 'noble', length: '4.5ft', tier: 'fullDecor', quantity: 1 }],
    }));
    expect(full.lineItems[0].amount).toBe(210);
  });

  // The 4.5ft "with bow" price is still pending from Naldo (currently $0).
  it.todo("set + assert 4.5ft 'with bow' garland price once Naldo confirms it");
});

describe('calculateQuote — minimum, fees, tax, deposit', () => {
  it('bumps a small quote up to the $1000 minimum and flags it', () => {
    const r = calculateQuote(emptyInputs({ spritzers: [{ size: '16', quantity: 1 }] })); // 85
    expect(r.subtotalBeforeDiscount).toBe(85);
    expect(r.minimumApplied).toBe(true);
    expect(r.subtotalAfterDiscount).toBe(1000);
    expect(r.taxableAmount).toBe(1000);
    expect(r.taxAmount).toBe(86.25);
    expect(r.total).toBe(1086.25);
    expect(r.depositAmount).toBe(543.13); // 543.125 rounds up
    expect(r.balanceDue).toBe(543.12);
    // deposit + balance must always reconstruct the total exactly
    expect(r.depositAmount + r.balanceDue).toBeCloseTo(r.total, 2);
  });

  it('adds rush + premium takedown to the taxable amount', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'hard', // 1200
      rushFee: true,
      takedown: 'premium',
    }));
    expect(r.rushFeeAmount).toBe(150);
    expect(r.takedownAmount).toBe(150);
    expect(r.taxableAmount).toBe(1500); // 1200 + 150 + 150
  });

  it('computes a full multi-category quote end to end', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'hard',                          // 1200
      miniLightItems: [{ type: 'tree', wrapStyle: 'trunk', stringCount: 3 }], //  135
      spritzers: [{ size: '24', quantity: 2 }],                               //  190
      wreaths: [{ size: '30noble', tier: 'fullDecor', quantity: 1 }],         //  355
      garland: [{ type: 'noble', length: '9ft', tier: 'bow', quantity: 1 }],  //  195
      rushFee: true,
      takedown: 'premium',
    }));
    expect(r.lineItems).toHaveLength(5);
    expect(r.subtotalBeforeDiscount).toBe(2075);
    expect(r.minimumApplied).toBe(false);
    expect(r.taxableAmount).toBe(2375); // 2075 + 150 + 150
    expect(r.taxAmount).toBe(204.84);
    expect(r.total).toBe(2579.84);
    expect(r.depositAmount).toBe(1289.92);
    expect(r.balanceDue).toBe(1289.92);
  });
});

describe('calculateQuote — discounts', () => {
  it('applies a percentage discount (rounded)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 200, santasDifficulty: 'medium', // 2000
      discount: { type: 'percentage', amount: 0.1 },  // 10% -> 200
    }));
    expect(r.discountAmount).toBe(200);
    expect(r.subtotalAfterDiscount).toBe(1800);
    expect(r.minimumApplied).toBe(false);
  });

  it('applies a flat discount', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 200, santasDifficulty: 'medium', // 2000
      discount: { type: 'flat', amount: 300 },
    }));
    expect(r.discountAmount).toBe(300);
    expect(r.subtotalAfterDiscount).toBe(1700);
  });

  it('still enforces the minimum when a discount drops the subtotal below it', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 110, santasDifficulty: 'medium', // 1100
      discount: { type: 'flat', amount: 300 },        // -> 800, below $1000
    }));
    expect(r.subtotalBeforeDiscount).toBe(1100);
    expect(r.discountAmount).toBe(300);
    expect(r.minimumApplied).toBe(true);
    expect(r.subtotalAfterDiscount).toBe(1000);
  });
});
