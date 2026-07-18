import { describe, it, expect } from 'vitest';
import { calculateQuote, BUSINESS_RULES, type QuoteInputs } from './pricingEngine';
import { priceSelection } from '@/lib/portal/derivePackages';

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
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'medium',
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
    expect(BUSINESS_RULES.taxRate).toBe(0.0875);
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

  it('Stake Lighting bills independently at its own $6/$7/$8 rates', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',                  // Santa's 1000
      rooflineChoice: 'santas',
      stakeLightingFootage: 100, stakeLightingDifficulty: 'medium',    // 100 × $7 = 700
    }));
    const stake = r.lineItems.find((li) => li.label.startsWith('Stake Lighting –'));
    expect(stake).toBeTruthy();
    expect(stake!.amount).toBe(700);
    // Independent of the roofline choice — Santa's still bills alongside it.
    expect(r.lineItems.map((li) => li.label).join(' | ')).toContain("Santa's Roofline");
  });

  it('Stake Lighting uses $6 easy / $8 hard, distinct from the roofline table', () => {
    const easy = calculateQuote(emptyInputs({ stakeLightingFootage: 100, stakeLightingDifficulty: 'easy' }));
    const hard = calculateQuote(emptyInputs({ stakeLightingFootage: 100, stakeLightingDifficulty: 'hard' }));
    expect(easy.lineItems.find((li) => li.label.startsWith('Stake Lighting –'))!.amount).toBe(600);
    expect(hard.lineItems.find((li) => li.label.startsWith('Stake Lighting –'))!.amount).toBe(800);
  });
});

describe('calculateQuote — stale rooflineChoice whose matching option no longer exists (WT-01)', () => {
  it('falls through to auto-pick instead of silently billing $0 for real footage', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // Santa's 1000 — real footage is present
      gingerbreadFootage: 0,                           // gingerbread option is now null
      rooflineChoice: 'gingerbread',                   // stale — operator's earlier pick
    }));
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems[0].label).toContain("Santa's Roofline");
    expect(r.lineItems[0].amount).toBe(1000); // NOT 0
    expect(r.rooflineChoice).toBe('santas');  // auto-resolved, not the stale value
  });

  it('an explicit choice that is still valid keeps winning over auto-pick', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',          // Santa's 1000 — auto would pick this
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium', // Gingerbread 1400, still a real option
      rooflineChoice: 'gingerbread',
    }));
    expect(r.rooflineChoice).toBe('gingerbread');
    expect(r.lineItems[0].amount).toBe(1400);
  });

  it('an explicit "none" still means no roofline, with no fallback', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // real footage present
      gingerbreadFootage: 0,
      rooflineChoice: 'none',
    }));
    expect(r.lineItems).toHaveLength(0);
    expect(r.rooflineChoice).toBe('none');
  });
});

describe('calculateQuote — custom $/ft override (#102)', () => {
  it("prices Santa's at the custom rate, ignoring the difficulty table", () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'hard', santasCustomRate: 5, // 100 × $5 (NOT 12)
    }));
    const santas = r.lineItems.find((li) => li.label.includes("Santa's Roofline"))!;
    expect(santas.amount).toBe(500);
    expect(santas.label).toContain('$5/ft'); // label shows the rate, not "hard"
  });

  it('prices Gingerbread front + ridge/sides each at its own custom rate', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', santasCustomRate: 5,            // front 100 × $5 = 500
      gingerbreadFootage: 50, gingerbreadDifficulty: 'hard', gingerbreadCustomRate: 9, // ridge 50 × $9 = 450
      rooflineChoice: 'gingerbread',
    }));
    const ging = r.lineItems.find((li) => li.label.includes('Gingerbread'))!;
    expect(ging.amount).toBe(950);
    // both options carry the overridden prices for the portal switch
    expect(r.rooflineOptions.santas).toEqual({ footage: 100, amount: 500 });
    expect(r.rooflineOptions.gingerbread).toEqual({ footage: 150, amount: 950 });
  });

  it('prices Winter Wonderland (C9) at the custom rate', () => {
    const r = calculateQuote(emptyInputs({
      winterWonderlandFootage: 40, winterWonderlandDifficulty: 'easy', winterWonderlandCustomRate: 15, // 40 × $15
    }));
    const ww = r.lineItems.find((li) => li.label.startsWith('Winter Wonderland'))!;
    expect(ww.amount).toBe(600);
    expect(ww.label).toContain('$15/ft');
  });

  it('prices Stake Lighting at the custom rate, ignoring its $6/$7/$8 table', () => {
    const r = calculateQuote(emptyInputs({
      stakeLightingFootage: 100, stakeLightingDifficulty: 'hard', stakeLightingCustomRate: 4, // 100 × $4 (NOT 8)
    }));
    const stake = r.lineItems.find((li) => li.label.startsWith('Stake Lighting –'))!;
    expect(stake.amount).toBe(400);
    expect(stake.label).toContain('$4/ft');
  });

  it('falls back to the difficulty-table rate when the custom rate is absent/≤0/NaN', () => {
    const table = calculateQuote(emptyInputs({ santasFootage: 100, santasDifficulty: 'hard' })); // 1200
    expect(table.lineItems[0].amount).toBe(1200);
    for (const bad of [0, -5, NaN, Infinity]) {
      const r = calculateQuote(emptyInputs({ santasFootage: 100, santasDifficulty: 'hard', santasCustomRate: bad }));
      expect(r.lineItems[0].amount).toBe(1200); // ignores the bad override, uses $12
      expect(r.lineItems[0].label).toContain('hard'); // label stays the difficulty word
    }
  });

  it('handles a fractional custom $/ft (rounds the product, shows the rate in the label)', () => {
    const r = calculateQuote(emptyInputs({
      winterWonderlandFootage: 33, winterWonderlandDifficulty: 'easy', winterWonderlandCustomRate: 7.5, // 247.5 → 248
    }));
    const ww = r.lineItems.find((li) => li.label.startsWith('Winter Wonderland'))!;
    expect(ww.amount).toBe(248);
    expect(ww.label).toContain('$7.5/ft');
  });

  it('rounds Gingerbread front + ridge/sides per-component with fractional custom rates', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 15, santasDifficulty: 'medium', santasCustomRate: 2.5,       // front 15 × 2.5 = 37.5 → 38
      gingerbreadFootage: 15, gingerbreadDifficulty: 'medium', gingerbreadCustomRate: 2.5, // ridge 37.5 → 38
      rooflineChoice: 'gingerbread',
    }));
    // each component is rounded independently: 38 + 38 = 76 (NOT round(75.0) = 75)
    expect(r.rooflineOptions.gingerbread).toEqual({ footage: 30, amount: 76 });
  });

  it('does not change global rates or other types', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', santasCustomRate: 5, // 500
      stakeLightingFootage: 100, stakeLightingDifficulty: 'medium',        // 700 (its table, untouched)
      rooflineChoice: 'santas',
    }));
    expect(r.lineItems.find((li) => li.label.includes("Santa's Roofline"))!.amount).toBe(500);
    expect(r.lineItems.find((li) => li.label.startsWith('Stake Lighting –'))!.amount).toBe(700);
    expect(BUSINESS_RULES.rooflineRates).toEqual({ easy: 8, medium: 10, hard: 12 });
  });
});

describe('calculateQuote — stable line ids (#104 PR1, additive)', () => {
  it('carries the input stable id + sceneItemIds onto per-unit line items', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 2, id: 'mini-x', sceneItemIds: ['x'] }],
      spritzers: [{ size: '24', quantity: 1, id: 'spritzer-y', sceneItemIds: ['y'] }],
    }));
    const bush = r.lineItems.find((li) => li.label.startsWith('Bush'))!;
    expect(bush.id).toBe('mini-x');
    expect(bush.sceneItemIds).toEqual(['x']);
    expect(bush.amount).toBe(70); // 2 × $35 — pricing unchanged
    expect(r.lineItems.find((li) => li.label.includes('Spritzer'))!.id).toBe('spritzer-y');
  });

  it('gives roofline / Winter Wonderland / Stake descriptive stable ids', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', rooflineChoice: 'santas',
      winterWonderlandFootage: 20, winterWonderlandDifficulty: 'easy',
      stakeLightingFootage: 20, stakeLightingDifficulty: 'easy',
    }));
    expect(r.lineItems.find((li) => li.label.includes("Santa's Roofline"))!.id).toBe('roofline-santas');
    expect(r.lineItems.find((li) => li.label.startsWith('Winter Wonderland'))!.id).toBe('winter-wonderland');
    expect(r.lineItems.find((li) => li.label.startsWith('Stake Lighting'))!.id).toBe('stake-lighting');
  });

  it('gives Gingerbread its own stable id', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',
      gingerbreadFootage: 50, gingerbreadDifficulty: 'medium',
      rooflineChoice: 'gingerbread',
    }));
    expect(r.lineItems.find((li) => li.label.includes('Gingerbread'))!.id).toBe('roofline-gingerbread');
  });

  it('carries a custom line item id when present', () => {
    const r = calculateQuote(emptyInputs({
      customLineItems: [{ id: 'custom-1', label: 'Flagpole', amount: 95 }],
    }));
    expect(r.lineItems.find((li) => li.label === 'Flagpole')!.id).toBe('custom-1');
  });

  it('omits id/sceneItemIds for legacy inputs that have none (stays {label,amount})', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 1 }],
    }));
    const bush = r.lineItems.find((li) => li.label.startsWith('Bush'))!;
    expect('id' in bush).toBe(false);
    expect('sceneItemIds' in bush).toBe(false);
  });
});

describe('calculateQuote — per-quote price override (#104 PR3)', () => {
  it('overrides a line to $0 (free spritzers) — presence-keyed, NOT truthy', () => {
    const base = calculateQuote(emptyInputs({ spritzers: [{ size: '24', quantity: 1, id: 'spritzer-a' }] }));
    expect(base.lineItems.find((li) => li.id === 'spritzer-a')!.amount).toBe(95); // 24" = $95

    const r = calculateQuote(emptyInputs({
      spritzers: [{ size: '24', quantity: 1, id: 'spritzer-a' }],
      lineItemPriceOverrides: { 'spritzer-a': { amount: 0 } },
    }));
    expect(r.lineItems.find((li) => li.id === 'spritzer-a')!.amount).toBe(0); // $0 applied, not dropped as falsy
    expect(r.subtotalBeforeDiscount).toBe(0); // totals recompute from the override
    expect(r.total).toBe(0);
    expect(r.depositAmount).toBe(0);
  });

  it('overrides to an arbitrary total and recomputes the subtotal', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 2, id: 'mini-b' }], // $70
      lineItemPriceOverrides: { 'mini-b': { amount: 50, reason: 'goodwill comp' } },
    }));
    expect(r.lineItems.find((li) => li.id === 'mini-b')!.amount).toBe(50);
    expect(r.subtotalBeforeDiscount).toBe(50);
  });

  it('overrides the roofline TOTAL on both the billed line and the portal option', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', rooflineChoice: 'santas', // $1000
      lineItemPriceOverrides: { 'roofline-santas': { amount: 600 } },
    }));
    expect(r.lineItems.find((li) => li.id === 'roofline-santas')!.amount).toBe(600);
    expect(r.rooflineOptions.santas!.amount).toBe(600); // the portal's option row reflects it too
  });

  it('ignores an override whose line id is not present (orphan / deleted item)', () => {
    const r = calculateQuote(emptyInputs({
      spritzers: [{ size: '24', quantity: 1, id: 'spritzer-a' }],
      lineItemPriceOverrides: { 'mini-deleted': { amount: 0 } },
    }));
    expect(r.lineItems.find((li) => li.id === 'spritzer-a')!.amount).toBe(95); // unchanged
  });

  it('falls back to the computed amount for a bad override value (negative / NaN / Infinity)', () => {
    for (const bad of [-5, NaN, Infinity]) {
      const r = calculateQuote(emptyInputs({
        spritzers: [{ size: '24', quantity: 1, id: 'spritzer-a' }],
        lineItemPriceOverrides: { 'spritzer-a': { amount: bad } },
      }));
      expect(r.lineItems.find((li) => li.id === 'spritzer-a')!.amount).toBe(95);
    }
  });

  it('no overrides map → pricing unchanged', () => {
    const r = calculateQuote(emptyInputs({ spritzers: [{ size: '24', quantity: 1, id: 'spritzer-a' }] }));
    expect(r.lineItems.find((li) => li.id === 'spritzer-a')!.amount).toBe(95);
  });

  it('a roofline TOTAL override wins over the #102 custom $/ft (last-write-wins)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', santasCustomRate: 20, // #102 → 100 × $20 = $2000
      rooflineChoice: 'santas',
      lineItemPriceOverrides: { 'roofline-santas': { amount: 600 } }, // #104 total override
    }));
    expect(r.rooflineOptions.santas!.amount).toBe(600); // override wins over the $/ft
    expect(r.lineItems.find((li) => li.id === 'roofline-santas')!.amount).toBe(600);
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

  // #17: non-decorated (bow) prices updated, 60"/72" sizes added, Oregon + the
  // labor tier retired.
  it('prices non-decorated wreaths and the new 60"/72" sizes', () => {
    const small = calculateQuote(emptyInputs({
      wreaths: [{ size: '24noble', tier: 'bow', quantity: 1 }],
    }));
    expect(small.lineItems[0].amount).toBe(200);
    const big = calculateQuote(emptyInputs({
      wreaths: [
        { size: '60noble', tier: 'bow', quantity: 1 },       // 885
        { size: '72noble', tier: 'fullDecor', quantity: 1 }, // 1455
      ],
    }));
    expect(big.lineItems.map((li) => li.amount)).toEqual([885, 1455]);
  });

  it('prices standalone bows at $35 each (#17)', () => {
    const r = calculateQuote(emptyInputs({ bows: [{ quantity: 2 }] }));
    expect(r.lineItems[0].label).toBe('Bows × 2');
    expect(r.lineItems[0].amount).toBe(70);
  });
});

describe('calculateQuote — garland (incl. 4.5ft regression)', () => {
  // #17: `bow` = Non-Decorated, `fullDecor` = Decorated; the `labor` tier retired.
  it('prices 9ft noble garland by tier', () => {
    const r = calculateQuote(emptyInputs({
      garland: [{ type: 'noble', length: '9ft', tier: 'bow', quantity: 1 }],
    }));
    expect(r.lineItems[0].amount).toBe(162);
  });

  // Regression: 4.5ft was a {0,0,0} placeholder that silently priced at $0. Both
  // tiers are now real ($135 / $210); this guards against a reversion.
  it('prices 4.5ft noble garland: non-decorated $135, decorated $210', () => {
    const nonDeco = calculateQuote(emptyInputs({
      garland: [{ type: 'noble', length: '4.5ft', tier: 'bow', quantity: 1 }],
    }));
    expect(nonDeco.lineItems[0].amount).toBe(135);

    const deco = calculateQuote(emptyInputs({
      garland: [{ type: 'noble', length: '4.5ft', tier: 'fullDecor', quantity: 1 }],
    }));
    expect(deco.lineItems[0].amount).toBe(210);
  });
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
    expect(r.taxAmount).toBe(7.44);
    expect(r.total).toBe(92.44);
    expect(r.depositAmount).toBe(46.22);
    expect(r.balanceDue).toBe(46.22);
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
      garland: [{ type: 'noble', length: '9ft', tier: 'bow', quantity: 1 }],  //  162
      rushFee: true,
      takedown: 'premium',
    }));
    expect(r.lineItems).toHaveLength(5);
    expect(r.subtotalBeforeDiscount).toBe(2042);
    expect(r.minimumApplied).toBe(false);
    expect(r.taxableAmount).toBe(2342); // 2042 + 150 + 150
    expect(r.taxAmount).toBe(204.93);
    expect(r.total).toBe(2546.93);
    expect(r.depositAmount).toBe(1273.46);
    expect(r.balanceDue).toBe(1273.47);
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

  // Money-drift regression: a % discount on a non-round subtotal must round to
  // CENTS, matching the portal's priceSelection exactly — not whole dollars.
  // Whole-dollar rounding here vs. cents rounding on the portal/approve path
  // silently drifted quotes.total up to ~54c from what the customer approves.
  it('rounds a percentage discount to cents, matching priceSelection exactly', () => {
    const r = calculateQuote(emptyInputs({
      customLineItems: [{ label: 'Custom item', amount: 1235 }], // non-round subtotal
      discount: { type: 'percentage', amount: 0.15 },
    }));
    expect(r.subtotalBeforeDiscount).toBe(1235);

    const portalDiscount = priceSelection(1235, {
      rushFee: 0,
      takedown: 0,
      taxRate: 0,
      discountRate: 0.15,
    }).discount;

    expect(portalDiscount).toBe(185.25); // 1235 * 0.15, cents-rounded
    expect(r.discountAmount).toBe(185.25); // engine must match, NOT the whole-dollar 185
    expect(r.discountAmount).toBe(portalDiscount);
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

  // Referral program redemption (#41 PR 2): the "2 free spritzers" line the
  // quote builder appends is an ORDINARY $0 custom item — no special-casing.
  it('flows a $0 custom item (e.g. free referral spritzers) through as an ordinary line — zero subtotal/tax impact', () => {
    const withoutFreebie = calculateQuote(emptyInputs({ santasFootage: 50, santasDifficulty: 'medium' }));
    const withFreebie = calculateQuote(emptyInputs({
      santasFootage: 50, santasDifficulty: 'medium',
      customLineItems: [
        { id: 'referral-spritzers', label: '2 Free 16" Spritzers (referral)', amount: 0, quantity: 1 },
      ],
    }));
    expect(withFreebie.lineItems).toHaveLength(2);
    expect(withFreebie.lineItems).toContainEqual({
      label: '2 Free 16" Spritzers (referral)',
      amount: 0,
      id: 'referral-spritzers',
    });
    // Adding the $0 line changes nothing else — same subtotal, tax, and total.
    expect(withFreebie.subtotalBeforeDiscount).toBe(withoutFreebie.subtotalBeforeDiscount);
    expect(withFreebie.taxAmount).toBe(withoutFreebie.taxAmount);
    expect(withFreebie.total).toBe(withoutFreebie.total);
  });
});

// Referral program redemption (#41 PR 2): the builder stores provenance
// (which rows were spent) additively on inputs.referralCredit. The engine
// must be completely blind to it — the discount math runs entirely through
// the existing `discount` field.
describe('calculateQuote — referral credit provenance (#41 PR2, additive, engine-blind)', () => {
  it('produces an IDENTICAL result with or without inputs.referralCredit present', () => {
    const base = emptyInputs({
      santasFootage: 50, santasDifficulty: 'medium',
      discount: { type: 'flat', amount: 125 },
    });
    const withProvenance = { ...base, referralCredit: { amount: 125, consumedRowIds: ['r1', 'r2'] } };
    expect(calculateQuote(withProvenance)).toEqual(calculateQuote(base));
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

  it('prices Curtain Lights at $35/string, no wrap style (like a railing) — #100', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'curtain', wrapStyle: 'trunk', stringCount: 4 }],
    }));
    expect(r.lineItems).toEqual([{ label: 'Curtain Lights – 4 strings', amount: 140 }]); // 4 × $35; trunk ignored
  });

  it('trees STILL vary by wrap style (canopy vs trunk)', () => {
    const r = calculateQuote(emptyInputs({
      miniLightItems: [{ type: 'tree', wrapStyle: 'trunk', stringCount: 2 }],
    }));
    expect(r.lineItems).toEqual([{ label: 'Tree – trunk wrap, 2 strings', amount: 90 }]); // 2 × $45
  });
});

describe('calculateQuote — standalone bows (#28; price TBD by Naldo, $0 for now)', () => {
  it('prices each bow entry as its own line item at the standalone rate', () => {
    const r = calculateQuote(emptyInputs({ bows: [{ quantity: 1 }, { quantity: 1 }] }));
    // Written against the rule (not a literal $0) so this test survives Naldo
    // setting the real price — only the TODO note + config guard change.
    const each = BUSINESS_RULES.standaloneBowPrice;
    expect(r.lineItems).toEqual([
      { label: 'Bow', amount: each },
      { label: 'Bow', amount: each },
    ]);
  });

  it('multiplies quantity within an entry and pluralizes the label', () => {
    const r = calculateQuote(emptyInputs({ bows: [{ quantity: 3 }] }));
    expect(r.lineItems).toEqual([
      { label: 'Bows × 3', amount: 3 * BUSINESS_RULES.standaloneBowPrice },
    ]);
  });

  it('skips malformed entries and stays back-compatible when bows is absent', () => {
    const bad = calculateQuote(emptyInputs({
      bows: [{ quantity: 0 }, { quantity: NaN }, null as never, { quantity: 2.9 }],
    }));
    // Only the 2.9 entry survives, floored to 2 whole bows.
    expect(bad.lineItems).toEqual([
      { label: 'Bows × 2', amount: 2 * BUSINESS_RULES.standaloneBowPrice },
    ]);
    expect(calculateQuote(emptyInputs()).lineItems).toHaveLength(0);
  });
});

describe('calculateQuote — early-install promo (#40)', () => {
  // $1,200 item subtotal (100ft hard roofline) to make the percentages obvious.
  function base(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
    return emptyInputs({ santasFootage: 100, santasDifficulty: 'hard', ...overrides });
  }

  it('takes 15% off the subtotal for a September install', () => {
    const r = calculateQuote(base({ installTiming: 'september' }));
    expect(r.subtotalBeforeDiscount).toBe(1200);
    expect(r.earlyInstallDiscountAmount).toBe(180); // 1200 × 0.15
    expect(r.subtotalAfterDiscount).toBe(1020);
    expect(r.taxableAmount).toBe(1020);
  });

  it('takes 10% off the subtotal for an October install', () => {
    const r = calculateQuote(base({ installTiming: 'october' }));
    expect(r.earlyInstallDiscountAmount).toBe(120); // 1200 × 0.10
    expect(r.subtotalAfterDiscount).toBe(1080);
  });

  it('applies no discount when timing is absent or none (back-compat)', () => {
    expect(calculateQuote(base()).earlyInstallDiscountAmount).toBe(0);
    expect(calculateQuote(base()).subtotalAfterDiscount).toBe(1200);
    expect(calculateQuote(base({ installTiming: 'none' })).earlyInstallDiscountAmount).toBe(0);
  });

  it('suppresses the rush fee when an early-install promo is active (mutually exclusive)', () => {
    expect(calculateQuote(base({ rushFee: true })).rushFeeAmount).toBe(BUSINESS_RULES.rushFeeAmount);
    const both = calculateQuote(base({ rushFee: true, installTiming: 'september' }));
    expect(both.rushFeeAmount).toBe(0);
  });

  it('stacks with a manual percentage discount — each off the subtotal', () => {
    const r = calculateQuote(
      base({ installTiming: 'october', discount: { type: 'percentage', amount: 0.1 } }),
    );
    expect(r.discountAmount).toBe(120); // manual 10% of 1200
    expect(r.earlyInstallDiscountAmount).toBe(120); // early-install 10% of 1200
    expect(r.subtotalAfterDiscount).toBe(960); // 1200 − 120 − 120
  });
});

// Audit 2026-06: a quote total must never be negative, NaN, or Infinity, no
// matter what the inputs are. Discounts are clamped so the item subtotal can't
// go below 0, and every footage/quantity is coerced to a finite, non-negative
// number before it is multiplied by a rate (mirrors the existing bow/custom
// guards). These guard against a malformed scene projection or an over-large
// staff discount silently producing a broken quote.
describe('calculateQuote — money-integrity guards', () => {
  it('never produces a negative total/deposit when a flat discount exceeds the subtotal', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // 1000
      discount: { type: 'flat', amount: 5000 },        // absurd over-discount
    }));
    expect(r.subtotalAfterDiscount).toBe(0);           // floored, not -4000
    expect(r.taxableAmount).toBe(0);
    expect(r.total).toBe(0);
    expect(r.depositAmount).toBe(0);
    expect(r.balanceDue).toBe(0);
  });

  it('never goes negative when a percentage discount exceeds 100%', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // 1000
      discount: { type: 'percentage', amount: 2 },     // 200%
    }));
    expect(r.subtotalAfterDiscount).toBe(0);
    expect(r.total).toBe(0);
    expect(r.depositAmount).toBeGreaterThanOrEqual(0);
  });

  it('still bills fees when an over-large discount zeroes the item subtotal', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // 1000
      discount: { type: 'flat', amount: 5000 },
      takedown: 'premium',                             // +150, still billable
    }));
    expect(r.subtotalAfterDiscount).toBe(0);
    expect(r.takedownAmount).toBe(150);
    expect(r.taxableAmount).toBe(150);
    expect(r.total).toBeGreaterThan(0);
  });

  it('treats a NEGATIVE flat discount as 0 (never INFLATES the subtotal/total)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // 1000
      discount: { type: 'flat', amount: -50 },         // typo path — must not add $50
    }));
    expect(r.discountAmount).toBe(0);
    expect(r.subtotalAfterDiscount).toBe(1000);        // NOT 1050
    expect(r.total).toBe(1087.5);                       // 1000 + 8.75% tax, uninflated
  });

  it('treats a NEGATIVE percentage discount as 0 (never inflates)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // 1000
      discount: { type: 'percentage', amount: -0.1 },  // -10% — must not add 10%
    }));
    expect(r.discountAmount).toBe(0);
    expect(r.subtotalAfterDiscount).toBe(1000);
    expect(r.total).toBe(1087.5);
  });

  it('coerces a non-finite mini-light stringCount to $0 (finite total, no NaN)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // 1000
      miniLightItems: [{ type: 'tree', wrapStyle: 'trunk', stringCount: NaN }],
    }));
    expect(Number.isFinite(r.total)).toBe(true);
    expect(r.total).toBe(1087.5); // 1000 roofline + $0 mini, +8.75% tax
  });

  it('coerces Infinity/negative footage and quantity to 0 (finite, non-negative total)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: Infinity, santasDifficulty: 'medium',
      spritzers: [{ size: '16', quantity: -3 }],
    }));
    expect(Number.isFinite(r.total)).toBe(true);
    expect(r.total).toBe(0);
  });
});

describe('calculateQuote — "Full Yule" ceiling figures (#107)', () => {
  // The headline builder total shows the most-expensive version of the quote:
  // all items + the max roofline (Gingerbread if present, else Santa's). This is
  // additive — the billed `total`/`subtotalBeforeDiscount` stay on the SELECTED
  // roofline; only `fullYule.*` reflects the ceiling.
  it('uses Gingerbread even when Santa\'s is the recommended roofline', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',          // Santa's 1000
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium', // Gingerbread 1400
      rooflineChoice: 'santas',
    }));
    // Billed (selected = Santa's) — unchanged
    expect(r.subtotalBeforeDiscount).toBe(1000);
    expect(r.total).toBe(1087.5);       // 1000 + 8.75% tax
    expect(r.depositAmount).toBe(543.75);
    // Ceiling (Gingerbread)
    expect(r.fullYule?.subtotalBeforeDiscount).toBe(1400);
    expect(r.fullYule?.total).toBe(1522.5);      // 1400 + 8.75% tax
    expect(r.fullYule?.depositAmount).toBe(761.25);
    expect(r.fullYule?.balanceDue).toBe(761.25);
  });

  it('equals the selected figures when Gingerbread IS the selected roofline (no-op)', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium',
      rooflineChoice: 'gingerbread',
    }));
    expect(r.total).toBe(1522.5);
    expect(r.fullYule?.total).toBe(r.total);
    expect(r.fullYule?.subtotalBeforeDiscount).toBe(r.subtotalBeforeDiscount);
  });

  it('falls back to Santa\'s when there is no distinct Gingerbread footage', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium', // Santa's 1000, no gingerbread
      rooflineChoice: 'santas',
    }));
    expect(r.fullYule?.subtotalBeforeDiscount).toBe(1000);
    expect(r.fullYule?.total).toBe(r.total);
  });

  it('equals the selected figures when there is no roofline at all', () => {
    const r = calculateQuote(emptyInputs({
      wreaths: [{ size: '30noble', tier: 'fullDecor', quantity: 1 }], // rest only, 355
    }));
    expect(r.subtotalBeforeDiscount).toBe(355);
    expect(r.fullYule?.subtotalBeforeDiscount).toBe(355);
    expect(r.fullYule?.total).toBe(r.total);
  });

  it('swaps the selected roofline for the max on top of the rest of the quote', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',          // Santa's 1000
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium', // Gingerbread 1400
      rooflineChoice: 'santas',
      wreaths: [{ size: '30noble', tier: 'fullDecor', quantity: 1 }], // rest 355
    }));
    expect(r.subtotalBeforeDiscount).toBe(1355);              // 1000 + 355
    expect(r.fullYule?.subtotalBeforeDiscount).toBe(1755);    // 1400 + 355
  });

  it('uses the TRUE max roofline when a #104 override inverts the natural order', () => {
    // Naturally Gingerbread ($1400) > Santa's ($1000), but a per-quote override
    // makes Santa's $5000. The ceiling must follow the real max (Santa's), not
    // blindly prefer Gingerbread — else it would land BELOW the billed total.
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium',
      rooflineChoice: 'santas',
      lineItemPriceOverrides: { 'roofline-santas': { amount: 5000 } },
    }));
    expect(r.rooflineOptions.santas?.amount).toBe(5000);
    expect(r.subtotalBeforeDiscount).toBe(5000);           // billed = overridden Santa's
    expect(r.fullYule?.subtotalBeforeDiscount).toBe(5000); // ceiling = true max, NOT Gingerbread 1400
  });

  it('applies a percentage discount to the ceiling subtotal, not the selected one', () => {
    const r = calculateQuote(emptyInputs({
      santasFootage: 100, santasDifficulty: 'medium',          // Santa's 1000
      gingerbreadFootage: 40, gingerbreadDifficulty: 'medium', // Gingerbread 1400
      rooflineChoice: 'santas',
      discount: { type: 'percentage', amount: 0.1 },           // 10%
    }));
    expect(r.discountAmount).toBe(100);          // 10% of 1000
    expect(r.fullYule?.discountAmount).toBe(140); // 10% of 1400
    expect(r.fullYule?.total).toBe(1370.25);      // (1400 − 140) × 1.0875
  });
});


describe('calculateQuote — exact half-cent tax rounding', () => {
  it('rounds $1,002.80 at 8.75% to $87.75 tax', () => {
    const r = calculateQuote(emptyInputs({
      customLineItems: [{ label: 'Half-cent boundary', amount: 1002.8 }],
    }));
    expect(r.taxAmount).toBe(87.75);
    expect(r.total).toBe(1090.55);
    expect(r.depositAmount).toBe(545.28);
  });
});
