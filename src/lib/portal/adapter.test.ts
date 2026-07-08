import { describe, it, expect } from 'vitest';
import { quoteRowToPortalQuote, BILLED_ROOFLINE_IDS, type QuoteRowForPortal } from './adapter';
import { calculateQuote, type QuoteInputs, type QuoteResult } from '@/lib/pricing/pricingEngine';
import { calculatePermanentQuote } from '@/lib/permanent/pricing';
import { DEFAULT_PERMANENT_RATES } from '@/lib/permanent/types';
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
