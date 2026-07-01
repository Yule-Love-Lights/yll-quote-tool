import { describe, it, expect } from 'vitest';
import { quoteRowToPortalQuote, type QuoteRowForPortal } from './adapter';
import { calculateQuote, type QuoteInputs, type QuoteResult } from '@/lib/pricing/pricingEngine';
import type { PortalPhotos } from './photos';

// ── Test scaffolding ──────────────────────────────────────────────────────

const PHOTOS: PortalPhotos = {
  beforeUrl: null,
  afterUrl: null,
  alt: null,
};

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

function rowWith(result: QuoteResult | null, inputs: QuoteInputs | null = null): QuoteRowForPortal {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    customer_name: 'Test Customer',
    customer_address: '1 Test St, Huntington, NY 11743',
    customer_phone: null,
    customer_email: null,
    result,
    inputs,
    total: result?.total ?? null,
    video_kind: null,
    video_src: null,
    video_poster: null,
    video_title: null,
    video_duration_sec: null,
    customer_approved_at: null,
    approval_snapshot: null,
  };
}

function portalFrom(result: QuoteResult | null, inputs: QuoteInputs | null = null) {
  return quoteRowToPortalQuote({ row: rowWith(result, inputs), photos: PHOTOS });
}

// ── Mutually-exclusive roofline as line items (#17 Phase 2) ────────────────

describe('quoteRowToPortalQuote — roofline as mutually-exclusive line items (#17 Phase 2)', () => {
  it('shows BOTH options as ordinary line items (no footage) plus the either/or group', () => {
    // front 100×10 = 1000 (Santa's); ridge/sides 40×10 = 400 → Gingerbread 1400.
    const result = calculateQuote(
      emptyInputs({ santasFootage: 100, gingerbreadFootage: 40, rooflineChoice: 'santas' }),
    );
    const portal = portalFrom(result)!;

    const santas = portal.lineItems.find((li) => li.id === 'roofline-santas')!;
    const ginger = portal.lineItems.find((li) => li.id === 'roofline-gingerbread')!;
    expect(santas).toMatchObject({ kind: 'roofline', label: "Santa's Roofline", detail: '', price: 1000 });
    expect(ginger).toMatchObject({ kind: 'ridge', label: 'Gingerbread', detail: '', price: 1400 });

    // The original billed roofline line item (with footage) is gone — replaced
    // by the two options above.
    expect(portal.lineItems.some((li) => /ft \(/i.test(li.label))).toBe(false);

    expect(portal.roofline).toEqual({
      itemIds: ['roofline-santas', 'roofline-gingerbread'],
      recommendedItemId: 'roofline-santas',
    });
  });

  it('recommends the Gingerbread option when staff picked Gingerbread', () => {
    const result = calculateQuote(
      emptyInputs({ santasFootage: 100, gingerbreadFootage: 40, rooflineChoice: 'gingerbread' }),
    );
    expect(portalFrom(result)!.roofline!.recommendedItemId).toBe('roofline-gingerbread');
  });

  it('bundles ONLY the recommended roofline into the package tiers (never both)', () => {
    const result = calculateQuote(
      emptyInputs({ santasFootage: 100, gingerbreadFootage: 40, rooflineChoice: 'santas' }),
    );
    const tierA = portalFrom(result)!.packages.find((p) => p.id === 'A')!;
    expect(tierA.includedItemIds).toContain('roofline-santas');
    expect(tierA.includedItemIds).not.toContain('roofline-gingerbread');
  });

  it('waives the $1,000 gate when neither single roofline reaches it (no double-count)', () => {
    // Santa's 50×8 = 400; Gingerbread 400 + 50×8 = 800. Both as line items sum
    // to 1200, but the customer can only ever select ONE — and neither clears
    // $1,000 — so the gate must be waived, not falsely active.
    const result = calculateQuote(
      emptyInputs({
        santasFootage: 50,
        santasDifficulty: 'easy',
        gingerbreadFootage: 50,
        gingerbreadDifficulty: 'easy',
        rooflineChoice: 'santas',
      }),
    );
    expect(portalFrom(result)!.minimumOrderSubtotal).toBe(0);
  });

  it('keeps the gate active when the recommended roofline alone clears $1,000', () => {
    const result = calculateQuote(
      emptyInputs({ santasFootage: 150, gingerbreadFootage: 40, rooflineChoice: 'santas' }), // front 1500
    );
    expect(portalFrom(result)!.minimumOrderSubtotal).toBe(1000);
  });

  it('produces a single-option group when only the front roofline has footage', () => {
    const result = calculateQuote(emptyInputs({ santasFootage: 100, rooflineChoice: 'santas' }));
    const portal = portalFrom(result)!;
    expect(portal.roofline!.itemIds).toEqual(['roofline-santas']);
    expect(portal.lineItems.some((li) => li.id === 'roofline-gingerbread')).toBe(false);
  });

  it('is undefined (legacy line-item path) when the quote has no billed roofline', () => {
    const result = calculateQuote(emptyInputs({ winterWonderlandFootage: 50 }));
    const portal = portalFrom(result)!;
    expect(portal.roofline).toBeUndefined();
    // Winter Wonderland survives as an ordinary line item (it is NOT the roofline).
    expect(portal.lineItems.some((li) => /Wonderland/.test(li.label))).toBe(true);
  });

  it('is undefined for legacy rows priced before Phase 1 (no rooflineOptions field)', () => {
    const result = calculateQuote(emptyInputs({ santasFootage: 100, rooflineChoice: 'santas' }));
    const legacy = { ...result, rooflineOptions: undefined } as unknown as QuoteResult;
    const portal = portalFrom(legacy)!;
    expect(portal.roofline).toBeUndefined();
    // The single roofline stays a normal line item, with its footage label intact.
    expect(portal.lineItems.some((li) => li.kind === 'roofline')).toBe(true);
  });
});

// ── Per-item `recommended` flag on portal line items (#12) ─────────────────

describe('quoteRowToPortalQuote — recommended flag on custom line items (#12)', () => {
  it('carries recommended from inputs.customLineItems onto the matching portal row', () => {
    const inputs = emptyInputs({
      customLineItems: [
        { label: 'Pathway stakes', amount: 200, quantity: 1, recommended: true },
        { label: 'Timer upgrade', amount: 50, quantity: 1 }, // not recommended
      ],
    });
    const result = calculateQuote(inputs);
    const portal = portalFrom(result, inputs)!;

    const stakes = portal.lineItems.find((li) => li.label === 'Pathway stakes')!;
    const timer = portal.lineItems.find((li) => li.label === 'Timer upgrade')!;
    expect(stakes.recommended).toBe(true);
    expect(timer.recommended).toBeUndefined();
  });

  it('matches the engine label for a quantity > 1 custom item', () => {
    const inputs = emptyInputs({
      customLineItems: [{ label: 'Wreath hook', amount: 10, quantity: 3, recommended: true }],
    });
    const result = calculateQuote(inputs);
    const portal = portalFrom(result, inputs)!;
    // Engine label is "<label> × <qty>".
    const row = portal.lineItems.find((li) => li.label === 'Wreath hook × 3')!;
    expect(row.recommended).toBe(true);
  });

  it('marks no rows recommended when inputs are absent (legacy rows)', () => {
    const inputs = emptyInputs({
      customLineItems: [{ label: 'Pathway stakes', amount: 200, recommended: true }],
    });
    const result = calculateQuote(inputs);
    // No inputs passed (the loader couldn't supply them) → no recommendation.
    const portal = portalFrom(result, null)!;
    const stakes = portal.lineItems.find((li) => li.label === 'Pathway stakes')!;
    expect(stakes.recommended).toBeUndefined();
  });

  it('carries WW/Stake recommend from the quote inputs onto their portal rows (#12)', () => {
    const inputs = emptyInputs({
      winterWonderlandFootage: 50,
      winterWonderlandRecommended: true,
      stakeLightingFootage: 40,
      // stakeLightingRecommended left false
    });
    const result = calculateQuote(inputs);
    const portal = portalFrom(result, inputs)!;
    const ww = portal.lineItems.find((li) => /Wonderland/.test(li.label))!;
    const stake = portal.lineItems.find((li) => li.kind === 'stake-lighting')!;
    expect(ww.recommended).toBe(true); // flag honored
    expect(stake.recommended).toBeUndefined(); // not flagged
  });
});
