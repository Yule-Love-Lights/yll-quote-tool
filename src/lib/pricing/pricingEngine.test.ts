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
    expect(r.lineItems[0].label).toContain('Gingerbread');
    expect(r.lineItems[0].amount).toBe(400);
  });
});

describe('calculateQuote — Santa\'s vs Gingerbread (mutually exclusive, #17)', () => {
  it('bills exactly ONE roofline, but exposes BOTH options for the portal/builder', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',          // front 1000
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium', // ridge+sides 400
    }));
    const roofItems = r.lineItems.filter((li) => /Santa's Roofline|Gingerbread/.test(li.label));
    expect(roofItems).toHaveLength(1);
    expect(r.rooflineOptions.santas).toEqual({ footage: 100, amount: 1000 });
    expect(r.rooflineOptions.gingerbread).toEqual({ footage: 140, amount: 1400 });
  });

  it('Gingerbread includes the front (front + ridge + sides)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',          // 1000
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium', // 400
      rooflineChoice: 'gingerbread',
    }));
    expect(r.lineItems[0].label).toContain('140ft'); // 100 + 40
    expect(r.lineItems[0].amount).toBe(1400);        // 1000 + 400
  });

  it('Santa\'s bills the front only, ignoring ridge/sides', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium', // ignored when Santa's
      rooflineChoice: 'santas',
    }));
    expect(r.lineItems[0].label).toContain("Santa's Roofline");
    expect(r.lineItems[0].amount).toBe(1000);
    expect(r.rooflineChoice).toBe('santas'); // explicit choice overrides auto
  });

  describe('auto-default (no staff recommendation) — closest to $1,000 without going under', () => {
    it('picks the cheaper Santa\'s when both options clear the minimum', () => {
      const r = calculateQuote(emptyInputs({
        santasFootage: 100, santasDifficulty: 'medium',          // Santa's 1000
        gingerbreadFootage: 40, gingerbreadDifficulty: 'medium', // Gingerbread 1400
      }));
      expect(r.rooflineChoice).toBe('santas');
      expect(r.lineItems[0].amount).toBe(1000);
    });

    it('picks Gingerbread when Santa\'s alone would fall under the minimum', () => {
      const r = calculateQuote(emptyInputs({
        santasFootage: 90, santasDifficulty: 'medium',           // Santa's 900 (< 1000)
        gingerbreadFootage: 20, gingerbreadDifficulty: 'medium', // Gingerbread 1100
      }));
      expect(r.rooflineChoice).toBe('gingerbread');
      expect(r.lineItems[0].amount).toBe(1100);
    });

    it('picks the larger Gingerbread when NEITHER reaches the minimum', () => {
      const r = calculateQuote(emptyInputs({
        santasFootage: 30, santasDifficulty: 'medium',           // Santa's 300
        gingerbreadFootage: 30, gingerbreadDifficulty: 'medium', // Gingerbread 600
      }));
      expect(r.rooflineChoice).toBe('gingerbread');
    });

    it('factors the rest of the quote in — rest pushes Santa\'s over the minimum, so Santa\'s wins', () => {
      // $710 of "rest" (two $355 wreaths). Santa's 350 -> 1060, Gingerbread 650 -> 1360.
      const r = calculateQuote(emptyInputs({
        santasFootage: 35, santasDifficulty: 'medium',           // Santa's 350
        gingerbreadFootage: 30, gingerbreadDifficulty: 'medium', // Gingerbread 650
        wreaths: [{ size: '30noble', tier: 'fullDecor', quantity: 2 }], // 710
      }));
      expect(r.rooflineChoice).toBe('santas');
    });

    it('without that rest, the SAME options default to Gingerbread (neither clears the min alone)', () => {
      const r = calculateQuote(emptyInputs({
        santasFootage: 35, santasDifficulty: 'medium',           // Santa's 350 (< 1000)
        gingerbreadFootage: 30, gingerbreadDifficulty: 'medium', // Gingerbread 650 (< 1000)
      }));
      expect(r.rooflineChoice).toBe('gingerbread');
    });
  });

  it('rooflineChoice "none" bills no roofline even with footage (options still exposed)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium',
      rooflineChoice: 'none',
    }));
    expect(r.lineItems).toHaveLength(0);
    expect(r.rooflineChoice).toBe('none');
    expect(r.rooflineOptions.gingerbread).toEqual({ footage: 140, amount: 1400 });
  });

  it('Winter Wonderland (C9) bills independently of the roofline choice', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',                  // Santa's 1000
      rooflineChoice: 'santas',
      winterWonderlandFootage: 30, winterWonderlandDifficulty: 'easy', // 240
    }));
    const labels = r.lineItems.map((li) => li.label).join(' | ');
    expect(labels).toContain("Santa's Roofline");
    expect(labels).toContain('Winter Wonderland');
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
  it('does NOT auto-apply the $1000 minimum — staff can send sub-$1000 quotes', () => {
    // The minimum is now a customer-side approval gate on the portal, not an
    // engine floor. A small quote prices through at its real (sub-$1000) value.
    const r = calculateQuote(emptyInputs({ spritzers: [{ size: '16', quantity: 1 }] })); // 85
    expect(r.subtotalBeforeDiscount).toBe(85);
    expect(r.minimumApplied).toBe(false);
    expect(r.subtotalAfterDiscount).toBe(85);
    expect(r.taxableAmount).toBe(85);
    expect(r.taxAmount).toBe(7.33);
    expect(r.total).toBe(92.33);
    expect(r.depositAmount).toBe(46.17);
    expect(r.balanceDue).toBe(46.16);
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

  it('does NOT floor when a discount drops the subtotal below $1000', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 110, santasDifficulty: 'medium', // 1100
      discount: { type: 'flat', amount: 300 },        // -> 800, below $1000
    }));
    expect(r.subtotalBeforeDiscount).toBe(1100);
    expect(r.discountAmount).toBe(300);
    expect(r.minimumApplied).toBe(false);
    expect(r.subtotalAfterDiscount).toBe(800); // real value, not floored to 1000
  });
});

describe('calculateQuote — custom / manual line items (#27 escape hatch)', () => {
  it('passes custom items straight through as line items at the entered price', () => {
    const r = calculateQuote(emptyInputs({
      customLineItems: [
        { label: 'Custom monogram display', amount: 450 },
        { label: 'Extra ladder fee', amount: 75, description: 'tall peak' },
      ],
    }));
    expect(r.lineItems).toHaveLength(2);
    expect(r.lineItems.map((li) => li.label)).toEqual(['Custom monogram display', 'Extra ladder fee']);
    expect(r.subtotalBeforeDiscount).toBe(525);
  });

  it('includes custom items in the taxable total and toward the minimum/auto-roofline', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 50, santasDifficulty: 'medium', // 500
      gingerbreadFootage: 60, gingerbreadDifficulty: 'medium', // +600 = ginger 1100
      customLineItems: [{ label: 'Custom', amount: 600 }],
    }));
    // rest (custom 600) + santas 500 = 1100 ≥ 1000 → auto-picks Santa's (closest
    // to the minimum without going under), proving custom items count toward it.
    expect(r.rooflineChoice).toBe('santas');
    expect(r.taxableAmount).toBe(1100); // 500 roofline + 600 custom
  });

  it('skips malformed custom entries (blank label, non-finite/negative amount)', () => {
    const r = calculateQuote(emptyInputs({
      customLineItems: [
        { label: '   ', amount: 100 },
        { label: 'NaN amount', amount: Number.NaN },
        { label: 'Negative', amount: -50 },
        { label: 'Valid', amount: 120 },
      ],
    }));
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems[0]).toEqual({ label: 'Valid', amount: 120 });
  });

  it('treats a missing customLineItems field as none (back-compat)', () => {
    const r = calculateQuote(emptyInputs({ santasFootage: 50, santasDifficulty: 'medium' }));
    expect(r.lineItems).toHaveLength(1); // just the roofline
  });

  it('multiplies a custom item by its quantity and shows × N in the label', () => {
    const r = calculateQuote(emptyInputs({
      customLineItems: [{ label: 'Yard stake', amount: 25, quantity: 4 }],
    }));
    expect(r.lineItems).toEqual([{ label: 'Yard stake × 4', amount: 100 }]);
  });

  it('treats a missing / <1 quantity as 1 (no × suffix)', () => {
    const r = calculateQuote(emptyInputs({
      customLineItems: [
        { label: 'A', amount: 50 },
        { label: 'B', amount: 30, quantity: 0 },
      ],
    }));
    expect(r.lineItems).toEqual([
      { label: 'A', amount: 50 },
      { label: 'B', amount: 30 },
    ]);
  });
});

describe('calculateQuote — railing + column mini-lights (no wrap style, #27 A2)', () => {
  it('prices a railing at the canopy/standard rate, no wrap style in the label', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'railing', wrapStyle: 'canopy', stringCount: 7 }],
    }));
    expect(r.lineItems).toEqual([{ label: 'Railing – 7 strings', amount: 245 }]); // 7 × $35
  });

  it('ignores wrapStyle for railings (always $35/string) and singularizes "1 string"', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'railing', wrapStyle: 'trunk', stringCount: 1 }],
    }));
    expect(r.lineItems).toEqual([{ label: 'Railing – 1 string', amount: 35 }]); // trunk ignored
  });

  it('prices a column at the canopy rate with no wrap style (columns = $35/string like bushes)', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'column', wrapStyle: 'trunk', stringCount: 3 }],
    }));
    expect(r.lineItems).toEqual([{ label: 'Column – 3 strings', amount: 105 }]); // 3 × $35; trunk ignored
  });

  it('trees STILL vary by wrap style (canopy vs trunk)', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'tree', wrapStyle: 'trunk', stringCount: 2 }],
    }));
    expect(r.lineItems).toEqual([{ label: 'Tree – trunk wrap, 2 strings', amount: 90 }]); // 2 × $45
  });
});
