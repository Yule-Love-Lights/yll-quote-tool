import { describe, it, expect, vi } from 'vitest';
import {
  quoteRowToPortalQuote,
  resolveApprovalSelectionSeed,
  BILLED_ROOFLINE_IDS,
  type QuoteRowForPortal,
} from './adapter';
import { computeInitialSelection } from '@/components/portal/SelectionContext';
import { calculateQuote, type QuoteInputs, type QuoteResult } from '@/lib/pricing/pricingEngine';
import { calculatePermanentQuote } from '@/lib/permanent/pricing';
import { DEFAULT_PERMANENT_RATES } from '@/lib/permanent/types';
import { calculatePermanentBistro } from '@/lib/permanentBistro/pricing';
import { DEFAULT_PERMANENT_BISTRO_RATES } from '@/lib/permanentBistro/types';
import type { ServiceType } from '@/lib/serviceType';
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

  it('#140: BOM accessories (extensions/splitters) never reach the customer line items', () => {
    // Materials are operator-facing cost only — pricing.ts never imports the BOM.
    // This locks the boundary: a permanent quote with card counts set still
    // exposes only the per-side price lines on the portal.
    const permInputs = emptyInputs({
      permanent: {
        frontFootage: 50, leftFootage: 0, rightFootage: 0, backFootage: 0,
        gaps: [], controllerToFirstLightFt: 0,
        frontCorners: 0, leftCorners: 0, rightCorners: 0, backCorners: 0,
        trackStyle: 'single', trackColor: '9003', blackHousing: false, maintenanceAddOn: false,
        extensions: { e3: 2, e5: 4, e10: 1, e25: 1 },
        splittersNeeded: 2,
        jumpBoosters: 1,
        accessoriesSource: 'auto',
      },
    });
    const permResult = calculatePermanentQuote(permInputs);
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(permResult, permInputs), service_type: 'permanent' },
      photos: PHOTOS,
    })!;
    expect(portal.lineItems.map((li) => li.id)).toEqual(['permanent-front']);
    expect(portal.lineItems[0].price).toBe(2000); // 50 × $40 — accessories cost the customer nothing
    expect(JSON.stringify(portal.lineItems)).not.toMatch(/extension|splitter|APL/i);
  });

  it('#138: the Winter Wonderland card shows just the product name (footage/difficulty stripped)', () => {
    const result = calculateQuote(
      emptyInputs({ winterWonderlandFootage: 41, winterWonderlandDifficulty: 'easy' }),
    );
    const portal = portalFrom(result)!;
    const ww = portal.lineItems.find((li) => li.kind === 'ridge')!;
    expect(ww.label).toBe('Winter Wonderland'); // engine label was "Winter Wonderland – 41ft (easy)"
    expect(ww.detail).toBe('');
    expect(ww.price).toBe(41 * 8); // easy $8/ft — the price itself is untouched
  });

  // S30 live bug: a staff-typed CUSTOM item starting with "Winter Wonderland"
  // was truncated to just "Winter Wonderland" on the portal (the #138 strip
  // matched by bare prefix). The strip now requires the ENGINE's exact label
  // shape, so freeform custom names survive whole.
  it('S30: a CUSTOM item starting with "Winter Wonderland" keeps its full label', () => {
    const customLabel = "Winter Wonderland Display Package · Trees · 5 Point Star 36'H Sparkle RGB";
    const result = calculateQuote(
      emptyInputs({ customLineItems: [{ label: customLabel, amount: 2435.99, quantity: 1 }] }),
    );
    const portal = portalFrom(result)!;
    const custom = portal.lineItems.find((li) => li.price === 2435.99)!;
    expect(custom.label).toBe(customLabel);
  });

  it('S30: a CUSTOM item starting with "Stake Lighting" keeps its full label', () => {
    const customLabel = 'Stake Lighting Premium Pathway Bundle';
    const result = calculateQuote(
      emptyInputs({ customLineItems: [{ label: customLabel, amount: 500, quantity: 1 }] }),
    );
    const portal = portalFrom(result)!;
    const custom = portal.lineItems.find((li) => li.price === 500)!;
    expect(custom.label).toBe(customLabel);
  });

  it('is undefined for legacy rows priced before Phase 1 (no rooflineOptions field)', () => {
    const result = calculateQuote(emptyInputs({ santasFootage: 100, rooflineChoice: 'santas' }));
    const legacy = { ...result, rooflineOptions: undefined } as unknown as QuoteResult;
    const portal = portalFrom(legacy)!;
    expect(portal.roofline).toBeUndefined();
    // The single roofline stays a normal line item, with its footage label intact.
    expect(portal.lineItems.some((li) => li.kind === 'roofline')).toBe(true);
  });

  // ── #110 W1-005: drop the billed roofline by IDENTITY, not label ──────────
  // A staff-typed CUSTOM line item whose freeform label contains "Roofline"/
  // "Gingerbread" must NOT be mistaken for the engine's billed roofline and
  // deleted from the portal, tiers, and gate. The billed roofline now carries a
  // stable id ('roofline-santas'/'roofline-gingerbread', #104) — filter on that.

  it('keeps a custom item labeled "Gingerbread house display" (W1-005) while still splitting the billed roofline', () => {
    const inputs = emptyInputs({
      santasFootage: 100, // front 100×10 = 1000 (Santa's)
      gingerbreadFootage: 40, // ridge/sides 40×10 = 400 → Gingerbread 1400
      rooflineChoice: 'santas',
      customLineItems: [{ label: 'Gingerbread house display', amount: 250, quantity: 1 }],
    });
    const result = calculateQuote(inputs);
    const portal = portalFrom(result, inputs)!;

    // The custom row survives verbatim (its label matches /Gingerbread/i but it
    // is NOT the billed roofline — it carries no billed-roofline stable id).
    const custom = portal.lineItems.find((li) => li.label === 'Gingerbread house display');
    expect(custom).toBeDefined();
    expect(custom!.price).toBe(250);

    // The billed roofline is still correctly split into the two toggle options,
    // and the engine's single footage-bearing roofline line is gone.
    expect(portal.lineItems.some((li) => li.id === 'roofline-santas')).toBe(true);
    expect(portal.lineItems.some((li) => li.id === 'roofline-gingerbread')).toBe(true);
    expect(portal.lineItems.some((li) => /ft \(/i.test(li.label))).toBe(false);
    expect(portal.roofline).toEqual({
      itemIds: ['roofline-santas', 'roofline-gingerbread'],
      recommendedItemId: 'roofline-santas',
    });
  });

  it('includes the roofline-worded custom item in the tier + $1,000 gate math (W1-005)', () => {
    // A sub-$1,000 selection where the custom item is what tips it over the gate:
    // Santa's 50×8 (easy) = 400; a $700 custom item → 1100 total for tier A.
    const inputs = emptyInputs({
      santasFootage: 50,
      santasDifficulty: 'easy',
      rooflineChoice: 'santas',
      customLineItems: [{ label: 'Extra roofline strip, back of house', amount: 700, quantity: 1 }],
    });
    const result = calculateQuote(inputs);
    const portal = portalFrom(result, inputs)!;

    // The custom item is present …
    const custom = portal.lineItems.find(
      (li) => li.label === 'Extra roofline strip, back of house',
    );
    expect(custom).toBeDefined();
    expect(custom!.price).toBe(700);

    // … bundled into the package tiers (not silently dropped) …
    const tierA = portal.packages.find((p) => p.id === 'A')!;
    expect(tierA.includedItemIds).toContain(custom!.id);

    // … and it lifts the selection past the $1,000 minimum-order gate.
    expect(portal.minimumOrderSubtotal).toBe(1000);
  });

  it('legacy pre-#104 result (billed roofline has NO stable id) still drops the billed roofline via the label fallback', () => {
    // Simulate a pre-#104 saved result: strip the stable ids off the engine's
    // line items so the billed roofline carries only its footage label. The
    // label fallback must still recognize + drop it.
    const inputs = emptyInputs({ santasFootage: 100, gingerbreadFootage: 40, rooflineChoice: 'santas' });
    const fresh = calculateQuote(inputs);
    const legacy = {
      ...fresh,
      lineItems: fresh.lineItems.map((li) => {
        const copy = { ...li };
        delete (copy as { id?: string }).id;
        return copy;
      }),
    } as unknown as QuoteResult;
    const portal = portalFrom(legacy, inputs)!;

    // Options still synthesized; the footage-bearing billed roofline is gone.
    expect(portal.lineItems.some((li) => li.id === 'roofline-santas')).toBe(true);
    expect(portal.lineItems.some((li) => li.id === 'roofline-gingerbread')).toBe(true);
    expect(portal.lineItems.some((li) => /ft \(/i.test(li.label))).toBe(false);
    expect(portal.roofline).toEqual({
      itemIds: ['roofline-santas', 'roofline-gingerbread'],
      recommendedItemId: 'roofline-santas',
    });
  });
});

// ── Portal-only label detail strip: Stake Lighting + mini lights ───────────
// (Jason, jason/portal-label-detail-strip) The customer card must show just
// the product name — the engine's footage/difficulty (stake) or wrap-style/
// string-count (mini lights) suffix is operator detail. Same portal-only
// pattern as the #138 Winter Wonderland strip above; the operator builder
// breakdown renders result.lineItems directly and keeps the full label.

describe('quoteRowToPortalQuote — Stake Lighting + mini-light label detail strip', () => {
  it('strips the Stake Lighting footage/difficulty suffix — customer sees just the product name', () => {
    const result = calculateQuote(
      emptyInputs({ stakeLightingFootage: 30, stakeLightingDifficulty: 'easy' }),
    );
    const engineItem = result.lineItems.find((li) => li.id === 'stake-lighting')!;
    expect(engineItem.label).toBe('Stake Lighting – 30ft (easy)'); // sanity on the format we're stripping
    const portal = portalFrom(result)!;
    const stake = portal.lineItems.find((li) => li.kind === 'stake-lighting')!;
    expect(stake.label).toBe('Stake Lighting');
    expect(stake.detail).toBe('');
    expect(stake.id).toBe('stake-lighting-1'); // portal id — untouched
    expect(stake.stableId).toBe('stake-lighting'); // engine stable id — untouched
    expect(stake.price).toBe(engineItem.amount); // price itself is untouched
  });

  it('strips the wrap-style + string-count suffix from a Bush (canopy wrap) label', () => {
    const inputs = emptyInputs({
      miniLightItems: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 2, id: 'mini-bush-1' }],
    });
    const result = calculateQuote(inputs);
    const engineItem = result.lineItems.find((li) => li.id === 'mini-bush-1')!;
    expect(engineItem.label).toBe('Bush – canopy wrap, 2 strings');
    const portal = portalFrom(result, inputs)!;
    const bush = portal.lineItems.find((li) => li.kind === 'bush')!;
    expect(bush.label).toBe('Bush');
    expect(bush.detail).toBe('');
    expect(bush.id).toBe('bush-1');
    expect(bush.stableId).toBe('mini-bush-1');
    expect(bush.price).toBe(engineItem.amount);
  });

  it('strips the wrap-style + string-count suffix from a Tree (trunk wrap) label', () => {
    const inputs = emptyInputs({
      miniLightItems: [{ type: 'tree', wrapStyle: 'trunk', stringCount: 4 }],
    });
    const result = calculateQuote(inputs);
    const engineItem = result.lineItems.find((li) => li.label.startsWith('Tree'))!;
    expect(engineItem.label).toBe('Tree – trunk wrap, 4 strings');
    const portal = portalFrom(result, inputs)!;
    const tree = portal.lineItems.find((li) => li.kind === 'tree')!;
    expect(tree.label).toBe('Tree');
    expect(tree.detail).toBe('');
    expect(tree.price).toBe(engineItem.amount);
  });

  it('strips the no-wrap string-count suffix from a Column label', () => {
    const inputs = emptyInputs({
      miniLightItems: [{ type: 'column', wrapStyle: 'canopy', stringCount: 3 }],
    });
    const result = calculateQuote(inputs);
    const engineItem = result.lineItems.find((li) => li.label.startsWith('Column'))!;
    expect(engineItem.label).toBe('Column – 3 strings');
    const portal = portalFrom(result, inputs)!;
    const column = portal.lineItems.find((li) => li.kind === 'column')!;
    expect(column.label).toBe('Column');
    expect(column.detail).toBe('');
    expect(column.price).toBe(engineItem.amount);
  });

  it('strips "Curtain Lights – 3 strings" down to "Curtain Lights"', () => {
    const inputs = emptyInputs({
      miniLightItems: [{ type: 'curtain', wrapStyle: 'canopy', stringCount: 3 }],
    });
    const result = calculateQuote(inputs);
    const engineItem = result.lineItems.find((li) => li.label.startsWith('Curtain'))!;
    expect(engineItem.label).toBe('Curtain Lights – 3 strings');
    const portal = portalFrom(result, inputs)!;
    const curtain = portal.lineItems.find((li) => li.kind === 'curtain')!;
    expect(curtain.label).toBe('Curtain Lights');
    expect(curtain.detail).toBe('');
  });

  it('strips the singular "1 string" suffix (Railing, no-wrap kind)', () => {
    const inputs = emptyInputs({
      miniLightItems: [{ type: 'railing', wrapStyle: 'trunk', stringCount: 1 }],
    });
    const result = calculateQuote(inputs);
    const engineItem = result.lineItems.find((li) => li.label.startsWith('Railing'))!;
    expect(engineItem.label).toBe('Railing – 1 string');
    const portal = portalFrom(result, inputs)!;
    const railing = portal.lineItems.find((li) => li.kind === 'railing')!;
    expect(railing.label).toBe('Railing');
    expect(railing.detail).toBe('');
  });

  it('never touches a CUSTOM line item whose free-text label happens to contain "strings"', () => {
    const inputs = emptyInputs({
      customLineItems: [{ label: 'Special garland – 2 strings look', amount: 75, quantity: 1 }],
    });
    const result = calculateQuote(inputs);
    const portal = portalFrom(result, inputs)!;
    const custom = portal.lineItems.find((li) => li.label === 'Special garland – 2 strings look');
    expect(custom).toBeDefined(); // label untouched — not stripped down to "Special garland"
    expect(custom!.kind).toBe('garland'); // parseLineItem's own classification, unrelated to this fix
    expect(custom!.price).toBe(75);
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

// ── Bug 3: portal status + decline_reason surfacing ───────────────────────
// The loader must select status + decline_reason and thread them into PortalQuote
// so the portal can gate the approve+pay UI for terminal/branch quotes.

function rowWithStatus(
  result: QuoteResult,
  status: string | null,
  decline_reason: string | null = null,
): QuoteRowForPortal {
  return {
    ...rowWith(result),
    status: status as QuoteRowForPortal['status'],
    decline_reason,
  };
}

describe('quoteRowToPortalQuote — quoteStatus + declineReason (Bug 3)', () => {
  const result = calculateQuote(emptyInputs({ santasFootage: 100, rooflineChoice: 'santas' }));

  it('exposes quoteStatus on a normal sent/active quote (null persisted status)', () => {
    const portal = quoteRowToPortalQuote({ row: rowWithStatus(result, null), photos: PHOTOS })!;
    // No persisted status → deriveStatus yields 'draft' (no timestamps on this row)
    expect(portal.quoteStatus).toBeDefined();
    expect(typeof portal.quoteStatus).toBe('string');
  });

  it('exposes quoteStatus="declined" on a declined quote', () => {
    const portal = quoteRowToPortalQuote({
      row: rowWithStatus(result, 'declined', 'Too expensive'),
      photos: PHOTOS,
    })!;
    expect(portal.quoteStatus).toBe('declined');
    expect(portal.declineReason).toBe('Too expensive');
  });

  it('exposes quoteStatus="cancelled" on a cancelled quote', () => {
    const portal = quoteRowToPortalQuote({
      row: rowWithStatus(result, 'cancelled'),
      photos: PHOTOS,
    })!;
    expect(portal.quoteStatus).toBe('cancelled');
    expect(portal.declineReason).toBeNull();
  });

  it('exposes quoteStatus="changes_requested" on an under-revision quote', () => {
    const portal = quoteRowToPortalQuote({
      row: rowWithStatus(result, 'changes_requested'),
      photos: PHOTOS,
    })!;
    expect(portal.quoteStatus).toBe('changes_requested');
  });

  it('a normal quote (sent, no persisted status) does not expose a terminal quoteStatus', () => {
    const rowSent: QuoteRowForPortal = {
      ...rowWith(result),
      quote_sent_at: '2026-06-25T00:00:00Z',
      status: null,
      decline_reason: null,
    };
    const portal = quoteRowToPortalQuote({ row: rowSent, photos: PHOTOS })!;
    // deriveStatus → 'sent' (timestamp-based), not a terminal/branch state
    expect(['declined', 'cancelled', 'lost', 'changes_requested']).not.toContain(portal.quoteStatus);
  });
});

describe('BILLED_ROOFLINE_IDS (#110 W3-003)', () => {
  it('exposes exactly the two stable roofline ids other UIs (e.g. the staff Quote Breakdown) must filter by', () => {
    // Locks the contract so the staff breakdown's id-based filter and this
    // adapter's own id-based drop (above) cannot silently drift apart again —
    // the whole point of switching off the old fragile label-prefix match.
    expect(BILLED_ROOFLINE_IDS.has('roofline-santas')).toBe(true);
    expect(BILLED_ROOFLINE_IDS.has('roofline-gingerbread')).toBe(true);
    expect(BILLED_ROOFLINE_IDS.size).toBe(2);
  });
});

describe('quoteRowToPortalQuote — legacy_rebook mapping (#155)', () => {
  const result = calculateQuote(emptyInputs({ santasFootage: 100, rooflineChoice: 'santas' }));

  it('maps legacy_rebook: true to legacyRebook: true', () => {
    const row: QuoteRowForPortal = { ...rowWith(result), legacy_rebook: true };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;
    expect(portal.legacyRebook).toBe(true);
  });

  it('maps legacy_rebook: false to legacyRebook: false', () => {
    const row: QuoteRowForPortal = { ...rowWith(result), legacy_rebook: false };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;
    expect(portal.legacyRebook).toBe(false);
  });

  it('defaults legacyRebook to false when the column is absent (legacy/back-compat row)', () => {
    const portal = quoteRowToPortalQuote({ row: rowWith(result), photos: PHOTOS })!;
    expect(portal.legacyRebook).toBe(false);
  });

  it('legacy_rebook: true derives exactly ONE package, "Last Year\'s Design", bundling the quote\'s items (#155 r2)', () => {
    // The migrated shape: one bundled custom line item carrying the quote.
    const inputs = emptyInputs({
      customLineItems: [{ label: 'Full display (from last year)', amount: 2400 }],
    });
    const legacyResult = calculateQuote(inputs);
    const row: QuoteRowForPortal = { ...rowWith(legacyResult, inputs), legacy_rebook: true };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;
    expect(portal.packages).toHaveLength(1);
    expect(portal.packages[0].name).toBe("Last Year's Design");
    expect(portal.packages[0].includedItemIds).toEqual(portal.lineItems.map((li) => li.id));
    expect(portal.packages[0].total).toBeGreaterThan(0);
  });

  it('a non-legacy quote keeps the holiday tier ladder + the empty "Build Your Own" slot (unchanged)', () => {
    const portal = quoteRowToPortalQuote({ row: rowWith(result), photos: PHOTOS })!;
    expect(portal.packages.length).toBeGreaterThan(1);
    expect(portal.packages.some((p) => p.name === "Last Year's Design")).toBe(false);
    const D = portal.packages.find((p) => p.id === 'D')!;
    expect(D.name).toBe('Build Your Own');
    expect(D.includedItemIds).toEqual([]);
  });
});

describe('quoteRowToPortalQuote — view_only mapping (#176)', () => {
  const result = calculateQuote(emptyInputs({ santasFootage: 100, rooflineChoice: 'santas' }));

  it('maps view_only: true to viewOnly: true', () => {
    const row: QuoteRowForPortal = { ...rowWith(result), view_only: true };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;
    expect(portal.viewOnly).toBe(true);
  });

  it('maps view_only: false to viewOnly: false', () => {
    const row: QuoteRowForPortal = { ...rowWith(result), view_only: false };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;
    expect(portal.viewOnly).toBe(false);
  });

  it('defaults viewOnly to false when the column is absent (legacy/back-compat row)', () => {
    const portal = quoteRowToPortalQuote({ row: rowWith(result), photos: PHOTOS })!;
    expect(portal.viewOnly).toBe(false);
  });
});

describe('event schedule (#96)', () => {
  const evInputs = emptyInputs({
    santasFootage: 100,
    event: { installDate: '2026-07-11', eventDate: '2026-07-18', takedownDate: '2026-07-31' },
  });

  it('surfaces the staff-entered dates on an event quote', () => {
    const row: QuoteRowForPortal = { ...rowWith(calculateQuote(evInputs), evInputs), service_type: 'event' };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;
    expect(portal.serviceType).toBe('event');
    expect(portal.eventSchedule).toEqual({
      installDate: '2026-07-11',
      eventDate: '2026-07-18',
      takedownDate: '2026-07-31',
    });
  });

  it('omits eventSchedule for a non-event quote', () => {
    const row: QuoteRowForPortal = { ...rowWith(calculateQuote(evInputs), evInputs), service_type: 'holiday' };
    expect(quoteRowToPortalQuote({ row, photos: PHOTOS })!.eventSchedule).toBeUndefined();
  });

  it('omits eventSchedule when the event quote set no dates', () => {
    const inputs = emptyInputs({ santasFootage: 100, event: { barrelBoxes: 2 } });
    const row: QuoteRowForPortal = { ...rowWith(calculateQuote(inputs), inputs), service_type: 'event' };
    expect(quoteRowToPortalQuote({ row, photos: PHOTOS })!.eventSchedule).toBeUndefined();
  });

  it('surfaces soft add-on suggestions on an event quote (excluding what is already on it)', () => {
    // santasFootage 100 → a roofline line is present, so roofline is NOT suggested.
    const row: QuoteRowForPortal = { ...rowWith(calculateQuote(evInputs), evInputs), service_type: 'event' };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;
    expect(portal.eventSuggestions?.length).toBeGreaterThan(0);
    expect(portal.eventSuggestions!.map((s) => s.key)).not.toContain('roofline');
  });

  it('omits eventSuggestions for a non-event quote', () => {
    const row: QuoteRowForPortal = { ...rowWith(calculateQuote(evInputs), evInputs), service_type: 'holiday' };
    expect(quoteRowToPortalQuote({ row, photos: PHOTOS })!.eventSuggestions).toBeUndefined();
  });
});

// ── Frozen permanent warranty back-compat (#88 P6b-2) ──────────────────────
describe('quoteRowToPortalQuote — frozen warranty on PortalApproval (#88 P6b-2)', () => {
  const result = calculateQuote(emptyInputs({ santasFootage: 100 }));
  function approvedRow(snapshot: unknown): QuoteRowForPortal {
    return {
      ...rowWith(result),
      customer_approved_at: '2026-07-04T00:00:00Z',
      approval_snapshot: snapshot as QuoteRowForPortal['approval_snapshot'],
    };
  }

  it('populates approval.permanentWarranty from a well-formed frozen snapshot', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow({
        approvedAt: '2026-07-04T00:00:00Z',
        customerSelection: { packageId: 'A' },
        permanentWarranty: { eyebrow: 'Your Protection', heading: 'H', bullets: ['a', 'b'], version: 3 },
      }),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.permanentWarranty).toEqual({
      eyebrow: 'Your Protection',
      heading: 'H',
      bullets: ['a', 'b'],
      version: 3,
    });
  });

  // #163 — the frozen colour (approved with, or staff-applied via a colour
  // change) flows through to PortalApproval so the booked portal opens on it.
  it('passes the frozen colorSchemeId + customPattern through to approval', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow({
        approvedAt: '2026-07-04T00:00:00Z',
        customerSelection: { packageId: 'A', colorSchemeId: 'multicolor', customPattern: [] },
      }),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.colorSchemeId).toBe('multicolor');
    expect(portal.approval?.customPattern).toEqual([]);
  });

  it('omits the colour fields for an older snapshot that predates the colour freeze', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow({ approvedAt: '2026-07-04T00:00:00Z', customerSelection: { packageId: 'A' } }),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.colorSchemeId).toBeUndefined();
    expect(portal.approval?.customPattern).toBeUndefined();
  });

  it('falls back to null for an OLD approved snapshot with no permanentWarranty (must not crash)', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow({ approvedAt: '2026-07-04T00:00:00Z', customerSelection: { packageId: 'A' } }),
      photos: PHOTOS,
    })!;
    expect(portal.approval).toBeTruthy(); // the quote still loads
    expect(portal.approval?.permanentWarranty).toBeNull(); // → portal renders live copy
  });

  it('returns null for a malformed frozen warranty (bad version / non-array bullets)', () => {
    const bad1 = quoteRowToPortalQuote({
      row: approvedRow({ customerSelection: {}, permanentWarranty: { version: 'x', bullets: ['a'] } }),
      photos: PHOTOS,
    })!;
    expect(bad1.approval?.permanentWarranty).toBeNull();
    const bad2 = quoteRowToPortalQuote({
      row: approvedRow({ customerSelection: {}, permanentWarranty: { version: 2, bullets: 'nope' } }),
      photos: PHOTOS,
    })!;
    expect(bad2.approval?.permanentWarranty).toBeNull();
  });
});

describe('quoteRowToPortalQuote — fallback deposit rounds to CENTS (legacy / staff-approved snapshot)', () => {
  const result = calculateQuote(emptyInputs({ santasFootage: 100 }));
  function approvedRow(snapshot: unknown): QuoteRowForPortal {
    return {
      ...rowWith(result),
      customer_approved_at: '2026-07-04T00:00:00Z',
      approval_snapshot: snapshot as QuoteRowForPortal['approval_snapshot'],
    };
  }

  it('a snapshot with no currentDepositUsd derives the deposit as HALF the total to the cent, not whole dollars', () => {
    const portal = quoteRowToPortalQuote({
      // No currentDepositUsd → buildApproval derives it. 3389.06 / 2 = 1694.53 exactly;
      // the old Math.round(total * 0.5) rounded to the WHOLE dollar (1695), so a legacy/
      // staff-approved snapshot's PDF/portal showed a deposit up to ~49¢ off the true half.
      row: approvedRow({ approvedAt: '2026-07-04T00:00:00Z', customerSelection: { packageId: 'A', currentTotalUsd: 3389.06 } }),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.totalUsd).toBe(3389.06);
    expect(portal.approval?.depositUsd).toBe(1694.53);
  });

  // #177 — the same fallback must read the quote's OWN deposit percent
  // (inputs.depositPercent), not always assume 50%.
  it('a per-quote depositPercent override is honored by the fallback derivation', () => {
    const portal = quoteRowToPortalQuote({
      row: {
        ...approvedRow({ approvedAt: '2026-07-04T00:00:00Z', customerSelection: { packageId: 'A', currentTotalUsd: 400 } }),
        inputs: emptyInputs({ depositPercent: 25 }),
      },
      photos: PHOTOS,
    })!;
    expect(portal.approval?.totalUsd).toBe(400);
    expect(portal.approval?.depositUsd).toBe(100); // 400 * 0.25, not 400 * 0.5
  });
});

// #199 F1 (wrap-review HIGH): the PRE-approval live portal — package tiles +
// SelectionContext's live total (both sourced from portal.charges /
// jobCharges = chargesFromResult(row.result, row.inputs?.depositPercent)) —
// must reflect the quote's CURRENT inputs.depositPercent even when result was
// priced BEFORE it changed. The admin NCE toggle route and rebook.ts both
// patch ONLY inputs.depositPercent, never result, so trusting result.depositRate
// alone left the NCE 40% inert on exactly this path (a customer browsing
// pre-approval saw 50%, unaffected by staff tagging NCE from the admin page).
describe('quoteRowToPortalQuote — PRE-approval charges reflect a live depositPercent over a stale result (#199 F1)', () => {
  it('portal.charges.depositRate follows the live inputs.depositPercent, not the (stale) result.depositRate baked in at calculateQuote time', () => {
    // A real priced result — computed with NO depositPercent override, so
    // result.depositRate === 0.5 (BUSINESS_RULES default), exactly like a
    // quote priced before an NCE tag existed.
    const result = calculateQuote(emptyInputs({ santasFootage: 100 }));
    expect(result.depositRate).toBe(0.5);

    // The row's CURRENT inputs say NCE (40%) — simulating the admin toggle
    // route / rebook having patched inputs.depositPercent after that price.
    const portal = portalFrom(result, emptyInputs({ santasFootage: 100, depositPercent: 40 }))!;
    expect(portal.charges.depositRate).toBe(0.4);
  });

  it('the package tile deposit dollar amounts are priced at the live 40%, not the stale 50%', () => {
    const result = calculateQuote(emptyInputs({ santasFootage: 100 }));
    const staleDeposit = portalFrom(result, emptyInputs({ santasFootage: 100 }))!.packages.find(
      (p) => p.id === 'A',
    )!.deposit;
    const liveDeposit = portalFrom(
      result,
      emptyInputs({ santasFootage: 100, depositPercent: 40 }),
    )!.packages.find((p) => p.id === 'A')!.deposit;
    // 40% of the same total must be LESS than 50% of it, and the ratio must
    // be exact (not just "different").
    expect(liveDeposit).toBeCloseTo(staleDeposit * 0.8, 2); // 0.40 / 0.50 = 0.8
  });
});

// #177 fix 2 — buildApproval must expose the FROZEN depositRate (what the
// customer actually approved with), preferring the snapshot's own depositRate
// over the live inputs.depositPercent, so a later staff edit can't retro-change
// what a post-approval surface displays.
describe('quoteRowToPortalQuote — approval.depositRate (#177 fix 2)', () => {
  const result = calculateQuote(emptyInputs({ santasFootage: 100 }));
  function approvedRow(snapshot: unknown, inputs: QuoteInputs | null = null): QuoteRowForPortal {
    return {
      ...rowWith(result, inputs),
      customer_approved_at: '2026-07-04T00:00:00Z',
      approval_snapshot: snapshot as QuoteRowForPortal['approval_snapshot'],
    };
  }

  it('prefers the FROZEN snapshot depositRate over a DIFFERENT live inputs.depositPercent', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow(
        { approvedAt: '2026-07-04T00:00:00Z', customerSelection: { packageId: 'A', depositRate: 0.25 } },
        emptyInputs({ depositPercent: 40 }), // staff changed it AFTER approval — must not win
      ),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.depositRate).toBe(0.25);
  });

  it('falls back to the live inputs.depositPercent for a pre-#177 snapshot with no frozen rate', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow(
        { approvedAt: '2026-07-04T00:00:00Z', customerSelection: { packageId: 'A' } }, // no depositRate field
        emptyInputs({ depositPercent: 30 }),
      ),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.depositRate).toBe(0.3);
  });

  it('falls back to 50% when neither the snapshot nor inputs carry a rate', () => {
    const portal = quoteRowToPortalQuote({
      row: approvedRow({ approvedAt: '2026-07-04T00:00:00Z', customerSelection: { packageId: 'A' } }),
      photos: PHOTOS,
    })!;
    expect(portal.approval?.depositRate).toBe(0.5);
  });
});

// ── #134: packages under the approval gate are hidden ───────────────────────
describe('quoteRowToPortalQuote — hides packages below the approval minimum (#134)', () => {
  // Permanent quote at the default $2,500 gate: front $1,520 · left $1,085 ·
  // right $1,085 · back $1,365 (the Jason S24 screenshot shape post-#132/#133).
  const permInputs = emptyInputs({
    permanent: {
      frontFootage: 38, leftFootage: 31, rightFootage: 31, backFootage: 39,
      gaps: [], controllerToFirstLightFt: 0,
      frontCorners: 0, leftCorners: 0, rightCorners: 0, backCorners: 0,
      trackStyle: 'single', trackColor: '9003', blackHousing: false, maintenanceAddOn: false,
    },
  });
  const permResult = calculatePermanentQuote(permInputs);
  function permPortal(inputs: QuoteInputs = permInputs) {
    return quoteRowToPortalQuote({
      row: { ...rowWith(permResult, inputs), service_type: 'permanent' },
      photos: PHOTOS,
    })!;
  }

  it('hides tiles whose pre-tax selection is under the gate; keeps the approvable ones', () => {
    const portal = permPortal();
    expect(portal.minimumOrderSubtotal).toBe(2500);
    const ids = portal.packages.map((p) => p.id);
    // A (front $1,520) and C (back $1,365) can't clear $2,500 → hidden.
    expect(ids).not.toContain('A');
    expect(ids).not.toContain('C');
    // B (Front & Sides $3,690) and D (Whole Home $5,055) clear it → shown.
    expect(ids).toContain('B');
    expect(ids).toContain('D');
  });

  it('staff-waived minimum (gate 0) hides nothing', () => {
    const portal = permPortal({ ...permInputs, waiveMinimum: true });
    expect(portal.minimumOrderSubtotal).toBe(0);
    expect(portal.packages.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('auto-waive (whole quote under the minimum) hides nothing — tiles never ALL vanish', () => {
    const smallInputs = emptyInputs({
      permanent: {
        frontFootage: 20, leftFootage: 10, rightFootage: 0, backFootage: 0,
        gaps: [], controllerToFirstLightFt: 0,
        frontCorners: 0, leftCorners: 0, rightCorners: 0, backCorners: 0,
        trackStyle: 'single', trackColor: '9003', blackHousing: false, maintenanceAddOn: false,
      },
    });
    const smallResult = calculatePermanentQuote(smallInputs); // $800 + $350 — under $2,500
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(smallResult, smallInputs), service_type: 'permanent' },
      photos: PHOTOS,
    })!;
    expect(portal.minimumOrderSubtotal).toBe(0); // auto-waived
    expect(portal.packages.length).toBeGreaterThan(0);
  });

  // ── S24 adversarial-review regressions (the 3 confirmed #134 findings) ────

  it("REVIEW FIX: holiday's EMPTY 'D' recommendation slot survives the filter (applyOurRecommendation populates it later)", () => {
    // Pre-fix the filter summed D's empty includedItemIds to $0 < gate and
    // dropped it — the loader's applyOurRecommendation then found no D, so the
    // whole #12 staff-recommendation flow + the "Build Your Own" card silently
    // vanished on every holiday quote ≥ $1,000.
    const result = calculateQuote(
      emptyInputs({ santasFootage: 150, rooflineChoice: 'santas' }), // $1,500 → gate active
    );
    const portal = portalFrom(result)!;
    expect(portal.minimumOrderSubtotal).toBe(1000);
    const d = portal.packages.find((p) => p.id === 'D');
    expect(d).toBeDefined();
    expect(d!.includedItemIds).toEqual([]); // still the empty placeholder
  });

  it('REVIEW FIX: default-ON rush fee counts toward the tile basis (same basis the approve gate uses)', () => {
    // Gingerbread recommended → tierLineItems = $900 + $250 = $1,150 → gate
    // active at $1,000. Entry tier A (always Santa's) = $700 + $250 = $950
    // items-only — but the staff-seeded rush fee (+$150) makes it approvable
    // as tapped ($1,100 ≥ $1,000), so it must NOT be hidden.
    const inputs = emptyInputs({
      santasFootage: 70, // $700 medium
      gingerbreadFootage: 20, // gingerbread option $900
      rooflineChoice: 'gingerbread',
      rushFee: true,
      customLineItems: [{ label: 'Extra décor', amount: 250, quantity: 1 }],
    });
    const result = calculateQuote(inputs);
    const portal = portalFrom(result, inputs)!;
    expect(portal.minimumOrderSubtotal).toBe(1000);
    expect(portal.charges.rush.defaultOn).toBe(true);
    expect(portal.packages.some((p) => p.id === 'A')).toBe(true);
  });

  it('REVIEW FIX: maintenance-triggered gate cannot empty the tile row (fallback keeps all packages)', () => {
    // Front-only $2,000 + maintenance $600: whole-quote $2,600 ≥ $2,500 so the
    // gate does NOT auto-waive, but maintenance sits in NO package — pre-fix
    // the lone A ($2,000 < $2,500) was filtered and the tile row went EMPTY.
    const inputs = emptyInputs({
      permanent: {
        frontFootage: 50, leftFootage: 0, rightFootage: 0, backFootage: 0,
        gaps: [], controllerToFirstLightFt: 0,
        frontCorners: 0, leftCorners: 0, rightCorners: 0, backCorners: 0,
        trackStyle: 'single', trackColor: '9003', blackHousing: false, maintenanceAddOn: true,
      },
    });
    const result = calculatePermanentQuote(inputs, { ...DEFAULT_PERMANENT_RATES, maintenancePrice: 600 });
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(result, inputs), service_type: 'permanent' },
      photos: PHOTOS,
    })!;
    expect(portal.minimumOrderSubtotal).toBe(2500); // NOT auto-waived ($2,600 ≥ $2,500)
    expect(portal.packages.map((p) => p.id)).toEqual(['A']); // fallback kept it
  });

  it('holiday regression: a tier meeting the $1,000 gate exactly is kept (>=, not >)', () => {
    const result = calculateQuote(emptyInputs({ santasFootage: 100, rooflineChoice: 'santas' })); // $1,000
    const portal = portalFrom(result)!;
    expect(portal.minimumOrderSubtotal).toBe(1000);
    expect(portal.packages.length).toBeGreaterThan(0);
  });
});

// ── Same-price tier dedupe: hide a LATER preset tier that price-ties an ─────
// EARLIER still-visible one (operator screenshot: Tier 2 "Full Festive" and
// Tier 3 "The Full Yule" both $2,185.88 — two identical-looking cards).
// Scoped to the A/B/C preset ladder only; package D never hidden.
describe('quoteRowToPortalQuote — hides a later preset tier that price-ties an earlier one', () => {
  it('B===C hides C, keeps A/B/D', () => {
    // Santa's alone clears the $1,000 minimum (100ft × $10 medium), so Tier A
    // is just the roofline with no spritzers/extras added. With no other line
    // items on the quote, Tier B (Santa's swapped for Gingerbread) and Tier C
    // (everything, minus Santa's) both collapse to the SAME single item — the
    // Gingerbread option — so they price-tie exactly.
    const result = calculateQuote(
      emptyInputs({ santasFootage: 100, gingerbreadFootage: 10, rooflineChoice: 'santas' }),
    );
    const portal = portalFrom(result)!;
    const a = portal.packages.find((p) => p.id === 'A')!;
    const b = portal.packages.find((p) => p.id === 'B')!;
    // Totals are tax-inclusive (8.75%): A = $1,000 × 1.0875; B = ($1,000 +
    // ridge/sides 10×$10 = $1,100) × 1.0875.
    expect(a.total).toBe(1087.5);
    expect(b.total).toBe(1196.25);
    expect(a.total).not.toBe(b.total);

    expect(portal.packages.map((p) => p.id)).toEqual(['A', 'B', 'D']); // C hidden
  });

  it('A===B===C keeps only A (+D)', () => {
    // Force the Gingerbread option's price to exactly match Santa's (a
    // same-price roofline swap) so all three preset tiers collapse to one
    // price — the natural engine can't produce this directly (Gingerbread
    // always costs strictly more once it exists), so the tie is forced on the
    // computed result the same way the file's other hand-edited-result tests
    // do (see the "legacy pre-#104" roofline test above).
    const base = calculateQuote(
      emptyInputs({ santasFootage: 100, gingerbreadFootage: 10, rooflineChoice: 'santas' }),
    );
    const tied: QuoteResult = {
      ...base,
      rooflineOptions: {
        ...base.rooflineOptions,
        gingerbread: { ...base.rooflineOptions.gingerbread!, amount: base.rooflineOptions.santas!.amount },
      },
    };
    const portal = portalFrom(tied)!;
    const a = portal.packages.find((p) => p.id === 'A')!;
    expect(a.total).toBe(1087.5); // $1,000 × 1.0875 tax-inclusive

    expect(portal.packages.map((p) => p.id)).toEqual(['A', 'D']); // B and C both hidden
  });

  it('all-distinct prices → nothing hidden', () => {
    // Santa's alone ($1,000) clears the minimum, so the extra custom item is
    // never pulled into Tier A/B (only into Tier C, "everything") — keeping
    // all three preset totals distinct.
    const inputs = emptyInputs({
      santasFootage: 100, // Tier A: $1,000
      gingerbreadFootage: 40, // Tier B: $1,000 + 40×$10 = $1,400
      rooflineChoice: 'santas',
      customLineItems: [{ label: 'Extra décor', amount: 500, quantity: 1 }], // only in Tier C
    });
    const result = calculateQuote(inputs);
    const portal = portalFrom(result, inputs)!;
    const [a, b, c] = (['A', 'B', 'C'] as const).map((id) => portal.packages.find((p) => p.id === id)!);
    // Tax-inclusive (×1.0875): A = $1,000; B = $1,400 (+ ridge/sides 40×$10);
    // C = $1,900 (+ the $500 custom item, only in "everything").
    expect(a.total).toBe(1087.5);
    expect(b.total).toBe(1522.5);
    expect(c.total).toBe(2066.25);

    expect(portal.packages.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']); // nothing hidden
  });

  it('D equal in price to a kept preset (permanent Whole Home) is still shown — D is never hidden', () => {
    // Force the front line to $0 so permanent's Whole Home (front + back)
    // collapses to exactly the Back-of-Home total — proving D survives even
    // when it price-ties a kept A/B/C tile. waiveMinimum keeps the #134 gate
    // filter a no-op so only the new dedupe is under test.
    const permInputs = emptyInputs({
      waiveMinimum: true,
      permanent: {
        frontFootage: 10, leftFootage: 0, rightFootage: 0, backFootage: 20,
        gaps: [], controllerToFirstLightFt: 0,
        frontCorners: 0, leftCorners: 0, rightCorners: 0, backCorners: 0,
        trackStyle: 'single', trackColor: '9003', blackHousing: false, maintenanceAddOn: false,
      },
    });
    const rawResult = calculatePermanentQuote(permInputs);
    const tied: QuoteResult = {
      ...rawResult,
      lineItems: rawResult.lineItems.map((li) => (li.id === 'permanent-front' ? { ...li, amount: 0 } : li)),
    };
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(tied, permInputs), service_type: 'permanent' },
      photos: PHOTOS,
    })!;
    const c = portal.packages.find((p) => p.id === 'C')!;
    const d = portal.packages.find((p) => p.id === 'D')!;
    expect(c.total).toBeGreaterThan(0);
    expect(c.total).toBe(d.total);

    expect(portal.packages.map((p) => p.id)).toEqual(['A', 'C', 'D']); // D survives despite the tie
  });

  it('the empty "Build Your Own" (D) placeholder still always survives the dedupe', () => {
    const result = calculateQuote(
      emptyInputs({ santasFootage: 100, gingerbreadFootage: 10, rooflineChoice: 'santas' }),
    );
    const portal = portalFrom(result)!;
    const d = portal.packages.find((p) => p.id === 'D')!;
    expect(d).toBeDefined();
    expect(d.total).toBe(0);
    expect(d.includedItemIds).toEqual([]);
  });

  it('permanent surfaces are NEVER deduped — a symmetric house ties Front and Back legitimately', () => {
    // Permanent reuses the A/B/C letter ids for mutually-exclusive SURFACES
    // (A "Front of Home", C "Back of Home"), not a cumulative ladder — front
    // 35ft × $40 and back 40ft × $35 both bill $1,400, price-tying two
    // genuinely different products. The dedupe's positive holiday-only gate
    // must leave both visible.
    const permInputs = emptyInputs({
      waiveMinimum: true,
      permanent: {
        frontFootage: 35, leftFootage: 0, rightFootage: 0, backFootage: 40,
        gaps: [], controllerToFirstLightFt: 0,
        frontCorners: 0, leftCorners: 0, rightCorners: 0, backCorners: 0,
        trackStyle: 'single', trackColor: '9003', blackHousing: false, maintenanceAddOn: false,
      },
    });
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(calculatePermanentQuote(permInputs), permInputs), service_type: 'permanent' },
      photos: PHOTOS,
    })!;
    const a = portal.packages.find((p) => p.id === 'A')!;
    const c = portal.packages.find((p) => p.id === 'C')!;
    expect(a.total).toBeGreaterThan(0);
    expect(a.total).toBe(c.total); // the tie is real…
    expect(portal.packages.some((p) => p.id === 'A')).toBe(true);
    expect(portal.packages.some((p) => p.id === 'C')).toBe(true); // …and C still renders
  });

  it("the customer's APPROVED package is never hidden by the dedupe", () => {
    // Same B===C tie as the first test, but the customer already approved on C
    // (frozen in the approval snapshot). Hiding C would strand the approval
    // seed on a missing package id → the empty-selection $0 portal. C must
    // survive; the un-approved B stays too (it isn't a duplicate of anything
    // still eligible for hiding).
    const result = calculateQuote(
      emptyInputs({ santasFootage: 100, gingerbreadFootage: 10, rooflineChoice: 'santas' }),
    );
    const portal = quoteRowToPortalQuote({
      row: {
        ...rowWith(result),
        customer_approved_at: '2026-07-04T00:00:00Z',
        approval_snapshot: {
          approvedAt: '2026-07-04T00:00:00Z',
          customerSelection: { packageId: 'C' },
        } as QuoteRowForPortal['approval_snapshot'],
      },
      photos: PHOTOS,
    })!;
    expect(portal.packages.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D']); // C kept for the approval
    expect(portal.approval?.packageId).toBe('C');
  });
});

// ── #131: permanent per-side recommend flags reach the portal line items ────
describe('quoteRowToPortalQuote — permanent recommended sides (#131)', () => {
  function permInputsWith(over: Record<string, boolean> = {}): QuoteInputs {
    return emptyInputs({
      permanent: {
        frontFootage: 38, leftFootage: 31, rightFootage: 31, backFootage: 39,
        gaps: [], controllerToFirstLightFt: 0,
        frontCorners: 0, leftCorners: 0, rightCorners: 0, backCorners: 0,
        trackStyle: 'single', trackColor: '9003', blackHousing: false, maintenanceAddOn: false,
        ...over,
      },
    });
  }

  it('marks exactly the flagged sides recommended (front + left here)', () => {
    const inputs = permInputsWith({ frontRecommended: true, leftRecommended: true });
    const result = calculatePermanentQuote(inputs);
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(result, inputs), service_type: 'permanent' },
      photos: PHOTOS,
    })!;
    const recById = Object.fromEntries(portal.lineItems.map((li) => [li.id, !!li.recommended]));
    expect(recById['permanent-front']).toBe(true);
    expect(recById['permanent-left']).toBe(true);
    expect(recById['permanent-right']).toBe(false);
    expect(recById['permanent-back']).toBe(false);
  });

  it('no flags → no permanent line is recommended (portal keeps the Whole Home default)', () => {
    const inputs = permInputsWith();
    const result = calculatePermanentQuote(inputs);
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(result, inputs), service_type: 'permanent' },
      photos: PHOTOS,
    })!;
    expect(portal.lineItems.some((li) => li.recommended)).toBe(false);
  });
});

// ── Permanent Bistro Lighting — portal package derivation + own gate ───────
// (mirrors permanent/event's own-vertical wiring; the seam bug this locks:
// the approval gate must read the bistro quote's OWN frozen rate-snapshot
// minimum, never silently fall back to the holiday $1,000 default.)
describe('quoteRowToPortalQuote — permanent bistro (single package + own gate, never rush/takedown)', () => {
  function bistroInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
    return emptyInputs({
      permanentBistro: { bistro: [{ footage: 40 }], poles: 2 },
      ...overrides,
    } as Partial<QuoteInputs>);
  }

  it("derives a single bundled package (event's model), not the holiday tier ladder", () => {
    const inputs = bistroInputs();
    const result = calculatePermanentBistro(inputs, { ...DEFAULT_PERMANENT_BISTRO_RATES, minimum: 0 });
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(result, inputs), service_type: 'permanent_bistro' },
      photos: PHOTOS,
    })!;
    expect(portal.packages).toHaveLength(1);
    expect(portal.packages[0].id).toBe('D');
    expect(portal.packages[0].includedItemIds).toHaveLength(portal.lineItems.length);
  });

  it('gives the bistro run + poles their own dedicated bistro kind (#117), not the plain permanent kind', () => {
    const inputs = bistroInputs();
    const result = calculatePermanentBistro(inputs, { ...DEFAULT_PERMANENT_BISTRO_RATES, minimum: 0 });
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(result, inputs), service_type: 'permanent_bistro' },
      photos: PHOTOS,
    })!;
    expect(portal.lineItems.map((li) => li.kind)).toEqual(['bistro', 'bistro']);
    // ids stay exactly what the pricing engine stamped — selection/approval
    // snapshots key on these, so they must NOT change with the kind.
    expect(portal.lineItems.map((li) => li.id)).toEqual(['permanent-bistro-0', 'permanent-bistro-poles']);
  });

  it('approvalGate is 0 (gate off) when the bistro rate snapshot minimum is 0', () => {
    const inputs = bistroInputs();
    const result = calculatePermanentBistro(inputs, { ...DEFAULT_PERMANENT_BISTRO_RATES, minimum: 0 });
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(result, inputs), service_type: 'permanent_bistro' },
      photos: PHOTOS,
    })!;
    expect(portal.minimumOrderSubtotal).toBe(0);
  });

  it('approvalGate equals the bistro snapshot minimum when set — never the holiday $1,000 default', () => {
    // 40ft × $30/ft = $1,200 + 2 poles × $100 = $1,400 — clears a $500 bistro
    // minimum. Pre-fix, `isPermanent ? … : undefined` made this default to
    // BUSINESS_RULES.minimumQuoteAmount ($1,000), which would ALSO happen to
    // read as "met" here — the regression is locked by asserting the exact
    // gate VALUE the portal shows (500), not just pass/fail.
    const inputs = bistroInputs();
    const result = calculatePermanentBistro(inputs, { ...DEFAULT_PERMANENT_BISTRO_RATES, minimum: 500 });
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(result, inputs), service_type: 'permanent_bistro' },
      photos: PHOTOS,
    })!;
    expect(portal.minimumOrderSubtotal).toBe(500);
  });

  it('carries no rush/takedown charges on the live portal (defense in depth)', () => {
    const inputs = bistroInputs();
    const result = calculatePermanentBistro(inputs, { ...DEFAULT_PERMANENT_BISTRO_RATES, minimum: 0 });
    const portal = quoteRowToPortalQuote({
      row: { ...rowWith(result, inputs), service_type: 'permanent_bistro' },
      photos: PHOTOS,
    })!;
    expect(portal.charges.rush.amount).toBe(0);
    expect(portal.charges.takedown.amount).toBe(0);
  });
});

// -- PS-C1/WT-L1: a staff-approved quote must never seed an EMPTY portal
// selection ($0 total, every item off, the minimum-gate wall) just because
// its vertical's packages have no lettered 'C' tier. Reproduces the exact
// downstream pipeline page.tsx drives: quoteRowToPortalQuote,
// resolveApprovalSelectionSeed, computeInitialSelection (in order).
describe('staff-approved portal selection seeds non-empty (PS-C1/WT-L1)', () => {
  // Mirrors a PRE-FIX staff-approve write (and any already-approved legacy
  // row): only the staffApproved audit marker, no customerSelection at all.
  // This isolates the buildApproval FALLBACK (adapter.ts) as the thing under
  // test, independent of the staff-approve route's own new write.
  function staffApprovedRowWithNoSelection(
    result: QuoteResult,
    inputs: QuoteInputs,
    serviceType: ServiceType,
  ): QuoteRowForPortal {
    return {
      ...rowWith(result, inputs),
      service_type: serviceType,
      customer_approved_at: '2026-07-12T00:00:00Z',
      // `staffApproved` is a real field the route writes but isn't modeled on
      // the adapter's narrow ApprovalSnapshotJson type (it's display-irrelevant
      // there) — cast via `unknown`, mirroring the `approvedRow` helper above.
      approval_snapshot: {
        staffApproved: { by: 'staff@yll.test', at: '2026-07-12T00:00:00Z' },
      } as unknown as QuoteRowForPortal['approval_snapshot'],
    };
  }

  // Drives the full seed pipeline the portal page actually uses, so the
  // assertion is on the REAL end-to-end behavior, not just one function.
  function seedSelection(portal: NonNullable<ReturnType<typeof quoteRowToPortalQuote>>) {
    const seed = resolveApprovalSelectionSeed(portal.approval, {
      // Irrelevant here: resolveApprovalSelectionSeed always prefers the real
      // `approval` over this fallback once the quote is approved.
      initialPackageId: 'A',
      initialSelectedItemIds: undefined,
    });
    return computeInitialSelection(portal.packages, seed.initialPackageId, seed.initialSelectedItemIds);
  }

  it('EVENT quote (single "D" package): seeds the FULL bundle, not empty', () => {
    const inputs = emptyInputs({ santasFootage: 100 });
    const result = calculateQuote(inputs);
    const row = staffApprovedRowWithNoSelection(result, inputs, 'event');
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;

    expect(portal.packages).toHaveLength(1);
    expect(portal.packages[0].id).toBe('D');
    expect(portal.packages[0].total).toBeGreaterThan(0);
    // The old bug: buildApproval hardcoded 'C', a package id that doesn't
    // exist on an event quote, so the seed below came up empty.
    expect(portal.approval!.packageId).toBe('D');

    const selection = seedSelection(portal);
    expect(selection.selectedItemIds.length).toBeGreaterThan(0);
    expect(selection.selectedItemIds).toEqual(portal.packages[0].includedItemIds);
  });

  it('PERMANENT BISTRO quote (single "D" package): seeds the FULL bundle, not empty', () => {
    const inputs = emptyInputs({ permanentBistro: { bistro: [{ footage: 40 }], poles: 2 } });
    const result = calculatePermanentBistro(inputs, { ...DEFAULT_PERMANENT_BISTRO_RATES, minimum: 0 });
    const row = staffApprovedRowWithNoSelection(result, inputs, 'permanent_bistro');
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;

    expect(portal.packages).toHaveLength(1);
    expect(portal.packages[0].id).toBe('D');
    expect(portal.approval!.packageId).toBe('D');

    const selection = seedSelection(portal);
    expect(selection.selectedItemIds.length).toBeGreaterThan(0);
    expect(selection.selectedItemIds).toEqual(portal.packages[0].includedItemIds);
  });

  it('NO-BACK PERMANENT quote (front + sides only, no "C", no "D"): seeds the biggest real package, not empty', () => {
    const inputs = emptyInputs({
      permanent: {
        frontFootage: 38, leftFootage: 31, rightFootage: 31, backFootage: 0,
        gaps: [], controllerToFirstLightFt: 0,
        frontCorners: 0, leftCorners: 0, rightCorners: 0, backCorners: 0,
        trackStyle: 'single', trackColor: '9003', blackHousing: false, maintenanceAddOn: false,
      },
    });
    const result = calculatePermanentQuote(inputs);
    const row = staffApprovedRowWithNoSelection(result, inputs, 'permanent');
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;

    // No back, so no 'C'. Front+sides equals the whole-home id set, so 'D' is
    // suppressed as redundant (derivePackagesPermanent), leaving only 'B'
    // (front + sides). The OLD hardcoded 'C' fallback matched NEITHER 'B' nor 'D'.
    expect(portal.packages.map((p) => p.id)).toEqual(['B']);
    const tierB = portal.packages.find((p) => p.id === 'B')!;
    expect(tierB.total).toBeGreaterThan(0);
    expect(portal.approval!.packageId).toBe('B'); // the bigger real package (front + sides)

    const selection = seedSelection(portal);
    expect(selection.selectedItemIds.length).toBeGreaterThan(0);
    expect(selection.selectedItemIds).toEqual(tierB.includedItemIds);
  });

  it('logs a regression tripwire when an approved snapshot has no customerSelection', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const inputs = emptyInputs({ santasFootage: 100 });
    const result = calculateQuote(inputs);
    const row = staffApprovedRowWithNoSelection(result, inputs, 'event');
    quoteRowToPortalQuote({ row, photos: PHOTOS });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no customerSelection.packageId'),
    );
    errorSpy.mockRestore();
  });

  // Now the OTHER half of the fix: the staff-approve ROUTE itself no longer
  // omits customerSelection, so a NEWLY staff-approved quote never even hits
  // the fallback above; buildApproval reads a real, non-empty selection
  // straight off the snapshot the route wrote. Simulated here (rather than
  // hitting the actual API route, which needs Supabase) by writing the same
  // shape the route now produces and asserting the adapter honors it as-is.
  it('a route-written customerSelection (packageId D + every billed item) seeds the full bundle', () => {
    const inputs = emptyInputs({ santasFootage: 100, gingerbreadFootage: 40, rooflineChoice: 'santas' });
    const result = calculateQuote(inputs);
    const preview = quoteRowToPortalQuote({ row: rowWith(result, inputs), photos: PHOTOS })!;
    // What the fixed staff-approve route now freezes: every BILLED item
    // (never both mutually-exclusive roofline options).
    const billedIds = preview.lineItems
      .filter((li) => !preview.roofline || !preview.roofline.itemIds.includes(li.id) || li.id === preview.roofline.recommendedItemId)
      .map((li) => li.id);
    expect(billedIds).toContain('roofline-santas');
    expect(billedIds).not.toContain('roofline-gingerbread'); // never both

    const row: QuoteRowForPortal = {
      ...rowWith(result, inputs),
      customer_approved_at: '2026-07-12T00:00:00Z',
      approval_snapshot: {
        staffApproved: { by: 'staff@yll.test', at: '2026-07-12T00:00:00Z' },
        customerSelection: { packageId: 'D', selectedItemIds: billedIds },
      } as unknown as QuoteRowForPortal['approval_snapshot'],
    };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS })!;
    expect(portal.approval!.packageId).toBe('D');

    const selection = seedSelection(portal);
    expect(selection.selectedItemIds.length).toBeGreaterThan(0);
    expect(new Set(selection.selectedItemIds)).toEqual(new Set(billedIds));
    // Never both mutually-exclusive roofline options selected at once.
    expect(selection.selectedItemIds).not.toEqual(
      expect.arrayContaining(['roofline-santas', 'roofline-gingerbread']),
    );
  });
});


describe('quoteRowToPortalQuote — pending booked amendment consent', () => {
  function amendedPortal(consent: { status: 'pending' } | { status: 'accepted'; accepted_at: string; signature: { name: string; kind: 'typed'; value: string; signed_at: string; ip: null } }, trailingCosmetic = false) {
    const inputs = emptyInputs({ customLineItems: [{ label: 'Lighting', amount: 2400 }] });
    const result = calculateQuote(inputs);
    const row = rowWith(result, inputs);
    row.customer_approved_at = '2026-07-01T00:00:00.000Z';
    row.deposit_paid_at = '2026-07-01T00:10:00.000Z';
    row.status = 'booked';
    row.approval_snapshot = {
      approvedAt: '2026-07-01T00:00:00.000Z',
      customerSelection: {
        packageId: 'A',
        activeName: 'Original order',
        selectedItemIds: ['custom-0'],
        currentTotalUsd: 2000,
        currentDepositUsd: 1000,
      },
      amendments: [{
        amended_at: '2026-07-18T12:00:00.000Z',
        by: 'staff:ops',
        reason: 'Added front wreaths',
        previous_total: 2000,
        new_total: 2400,
        previous_balance: 1000,
        new_balance: 1400,
        deposit_applied: 1000,
        delta: 400,
        line_item_changes: [],
        consent,
      }, ...(trailingCosmetic ? [{
        amended_at: '2026-07-18T12:10:00.000Z',
        by: 'staff:ops',
        reason: 'Added free spritzers',
        previous_total: 2400,
        new_total: 2400,
        previous_balance: 1400,
        new_balance: 1400,
        deposit_applied: 1000,
        delta: 0,
        line_item_changes: [{ id: 'free-spritzers', label: 'Free spritzers', change: 'added' as const, price: 0 }],
      }] : [])],
    };
    return quoteRowToPortalQuote({ row, photos: PHOTOS })!;
  }

  it('exposes the latest unsigned amendment with its money comparison', () => {
    const approval = amendedPortal({ status: 'pending' }).approval;
    expect(approval?.totalUsd).toBe(2000);
    expect(approval?.depositUsd).toBe(1000);
    expect(approval?.pendingAmendment).toEqual({
      amendedAt: '2026-07-18T12:00:00.000Z',
      reason: 'Added front wreaths',
      previousTotalUsd: 2000,
      newTotalUsd: 2400,
      deltaUsd: 400,
      depositAppliedUsd: 1000,
      newBalanceUsd: 1400,
    });
  });

  it('uses the accepted amendment as the durable booked total', () => {
    const approval = amendedPortal({
      status: 'accepted',
      accepted_at: '2026-07-18T12:05:00.000Z',
      signature: {
        name: 'Jordan Smith',
        kind: 'typed',
        value: 'Jordan Smith',
        signed_at: '2026-07-18T12:05:00.000Z',
        ip: null,
      },
    }).approval;
    expect(approval?.pendingAmendment).toBeUndefined();
    expect(approval?.totalUsd).toBe(2400);
    expect(approval?.depositUsd).toBe(1000);
  });

  it('keeps pending consent visible after a later zero-dollar edit', () => {
    const approval = amendedPortal({ status: 'pending' }, true).approval;
    expect(approval?.pendingAmendment?.amendedAt).toBe('2026-07-18T12:00:00.000Z');
    expect(approval?.pendingAmendment?.newTotalUsd).toBe(2400);
    expect(approval?.totalUsd).toBe(2000);
  });

  it('keeps the accepted amended total after a later zero-dollar edit', () => {
    const approval = amendedPortal({
      status: 'accepted',
      accepted_at: '2026-07-18T12:05:00.000Z',
      signature: {
        name: 'Jordan Smith',
        kind: 'typed',
        value: 'Jordan Smith',
        signed_at: '2026-07-18T12:05:00.000Z',
        ip: null,
      },
    }, true).approval;
    expect(approval?.pendingAmendment).toBeUndefined();
    expect(approval?.totalUsd).toBe(2400);
    expect(approval?.depositUsd).toBe(1000);
  });
});
