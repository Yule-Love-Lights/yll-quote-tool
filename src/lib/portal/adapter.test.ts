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
