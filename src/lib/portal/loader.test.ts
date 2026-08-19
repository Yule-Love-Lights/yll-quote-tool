// #110 W4-016 — loadPortalQuote starts the linked-design lookup (getDesignByQuote)
// IN PARALLEL with the quote row fetch, instead of strictly after it. Both DB
// calls only need the URL quote id, which is known up front.
//
// Supabase (the quote row) + lib/designs (getDesignByQuote) are mocked. We assert:
//   1. the parallelization itself — both fire before either resolves;
//   2. behavior is unchanged — a resolved design still merges into the portal;
//   3. the best-effort contract is unchanged — a design-lookup rejection never
//      blocks/nulls the quote (matches the pre-existing try/catch around it).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import type { Scene } from '@/lib/design/sceneTypes';
import type { DesignWithPhoto } from '@/lib/designs';

const { sbRef, getDesignByQuoteMock, getJobByQuoteMock, getInvoiceByJobMock, events } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  getDesignByQuoteMock: vi.fn(),
  // FIX4: mocked explicitly (rather than left to fall through to the real
  // implementations against the generic quote-row fake below) so a fixture
  // with `amendments` set can't accidentally reuse the QUOTE row's own shape
  // as a fake job/invoice — see loader.ts's own FIX4 comment for what these
  // feed.
  getJobByQuoteMock: vi.fn(async (): Promise<unknown> => null),
  getInvoiceByJobMock: vi.fn(async (): Promise<unknown> => null),
  // Records the order in which the two DB-backed calls start/finish, to prove
  // they run concurrently rather than the design lookup starting only after
  // the quote fetch resolves.
  events: [] as string[],
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/designs', () => ({ getDesignByQuote: getDesignByQuoteMock }));
vi.mock('@/lib/jobs', () => ({ getJobByQuote: getJobByQuoteMock }));
vi.mock('@/lib/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices')>();
  return { ...actual, getInvoiceByJob: getInvoiceByJobMock };
});

import { loadPortalQuote } from './loader';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function emptyInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    santasFootage: 100,
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

const SCENE: Scene = { yardsticks: [], items: [] };

function makeDesign(): DesignWithPhoto {
  return {
    id: 'design-1',
    quoteId: ID,
    scene: SCENE,
    photoUrl: 'https://example.test/photo.jpg',
    photoW: 800,
    photoH: 600,
    satelliteUrl: null,
    satelliteW: null,
    satelliteH: null,
    satelliteFeetPerPixel: null,
    satelliteLines: null,
    extraPhotos: [],
    photoTitle: null,
  };
}

// A quote-row select builder that records a 'quote:start'/'quote:end' pair
// around a microtask delay, so we can interleave it against the design mock's
// own start/end markers.
function makeSb(row: Record<string, unknown> | null, delayMs = 5) {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    select: () => b,
    eq: () => b,
    maybeSingle: async () => {
      events.push('quote:start');
      await new Promise((r) => setTimeout(r, delayMs));
      events.push('quote:end');
      return { data: row, error: null };
    },
  });
  return b;
}

function baseRow(overrides: Record<string, unknown> = {}) {
  const result = calculateQuote(emptyInputs());
  return {
    id: ID,
    customer_name: 'Test Customer',
    customer_address: '1 Test St, Huntington, NY 11743',
    customer_phone: null,
    customer_email: null,
    result,
    inputs: emptyInputs(),
    total: result.total,
    video_kind: null,
    video_src: null,
    video_poster: null,
    video_title: null,
    video_duration_sec: null,
    customer_approved_at: null,
    approval_snapshot: null,
    deposit_paid_at: null,
    status: null,
    decline_reason: null,
    quote_sent_at: null,
    viewed_at: null,
    is_test: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  sbRef.current = makeSb(baseRow());
});

describe('loadPortalQuote — W4-016 parallel design lookup', () => {
  it('starts getDesignByQuote BEFORE the quote row fetch resolves (parallel, not sequential)', async () => {
    getDesignByQuoteMock.mockImplementation(async () => {
      events.push('design:start');
      await new Promise((r) => setTimeout(r, 1));
      events.push('design:end');
      return null;
    });

    await loadPortalQuote(ID);

    // If the design lookup only started after the quote fetch resolved
    // (the pre-fix behavior), events would read
    // ['quote:start', 'quote:end', 'design:start', 'design:end'].
    // Parallel start means design:start fires before quote:end.
    const designStartIdx = events.indexOf('design:start');
    const quoteEndIdx = events.indexOf('quote:end');
    expect(designStartIdx).toBeGreaterThanOrEqual(0);
    expect(designStartIdx).toBeLessThan(quoteEndIdx);
  });

  it('passes the URL id straight through to getDesignByQuote', async () => {
    getDesignByQuoteMock.mockResolvedValue(null);
    await loadPortalQuote(ID);
    expect(getDesignByQuoteMock).toHaveBeenCalledWith(ID);
  });

  it('still merges a resolved design into the portal (scene, photo, extraPhotos)', async () => {
    getDesignByQuoteMock.mockResolvedValue(makeDesign());

    const portal = await loadPortalQuote(ID);

    expect(portal).not.toBeNull();
    expect(portal!.design).toBeDefined();
    expect(portal!.design!.photoUrl).toBe('https://example.test/photo.jpg');
    expect(portal!.design!.photoW).toBe(800);
    expect(portal!.design!.scene).toEqual(SCENE);
  });

  it('returns the quote with design undefined when no design is linked', async () => {
    getDesignByQuoteMock.mockResolvedValue(null);
    const portal = await loadPortalQuote(ID);
    expect(portal).not.toBeNull();
    expect(portal!.design).toBeUndefined();
  });

  it('best-effort: a design-lookup REJECTION never blocks or nulls the quote', async () => {
    getDesignByQuoteMock.mockRejectedValue(new Error('boom'));
    const portal = await loadPortalQuote(ID);
    expect(portal).not.toBeNull();
    expect(portal!.design).toBeUndefined();
  });

  it('a DB error on the quote fetch still returns null regardless of the design result', async () => {
    sbRef.current = makeSb(null, 1);
    (sbRef.current as { maybeSingle: () => Promise<unknown> }).maybeSingle = async () => ({
      data: null,
      error: { message: 'db down' },
    });
    getDesignByQuoteMock.mockResolvedValue(makeDesign());
    const portal = await loadPortalQuote(ID);
    expect(portal).toBeNull();
  });

  it('a missing quote row (maybeSingle → null data) returns null', async () => {
    sbRef.current = makeSb(null, 1);
    getDesignByQuoteMock.mockResolvedValue(null);
    const portal = await loadPortalQuote(ID);
    expect(portal).toBeNull();
  });
});

describe('loadPortalQuote — legacy rebook skips the "Our Recommendation" rewrite (#155)', () => {
  // A recommended line item normally makes this loader rewrite the holiday 'D'
  // slot into "Our Recommendation" (applyOurRecommendation). On a legacy
  // rebook, 'D' IS the single "Last Year's Design" bundle the adapter emitted —
  // the rewrite must never clobber it (the same clobber class the permanent/
  // event/bistro carve-outs guard against).
  const inputs = emptyInputs({
    customLineItems: [
      { label: 'Full display (from last year)', amount: 2400, recommended: true },
    ],
  });
  const result = calculateQuote(inputs);

  it("keeps the single Last Year's Design package even when an item is flagged recommended", async () => {
    sbRef.current = makeSb(
      baseRow({ inputs, result, total: result.total, legacy_rebook: true }),
    );
    getDesignByQuoteMock.mockResolvedValue(null);
    const portal = await loadPortalQuote(ID);
    expect(portal).not.toBeNull();
    expect(portal!.packages).toHaveLength(1);
    expect(portal!.packages[0].name).toBe("Last Year's Design");
  });

  it('a normal holiday quote still gets the "Our Recommendation" rewrite (unchanged)', async () => {
    sbRef.current = makeSb(baseRow({ inputs, result, total: result.total }));
    getDesignByQuoteMock.mockResolvedValue(null);
    const portal = await loadPortalQuote(ID);
    expect(portal).not.toBeNull();
    const D = portal!.packages.find((p) => p.id === 'D')!;
    expect(D.name).toBe('Our Recommendation');
    expect(D.includedItemIds.length).toBeGreaterThan(0);
  });
});

// #154 interim — Wisetack prequal financing threading. The loader is the ONE
// server seam that turns the two env vars into PortalQuote.financing:
//   - flag exactly 'true' AND a non-blank prequal URL → financing present;
//   - anything else → financing absent (flag-off portal output is unchanged);
//   - approvedBalanceUsd = resolveAgreedTotal(snapshot, result) − the
//     snapshot's currentDepositUsd, or null when unapproved / deposit unknown.
describe('loadPortalQuote — Wisetack financing threading (#154 interim)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.WISETACK_FINANCING_ENABLED;
    delete process.env.WISETACK_PREQUAL_URL;
    getDesignByQuoteMock.mockResolvedValue(null);
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const URL = 'https://wisetack.us/#/example/prequalify';
  function enableFinancing() {
    process.env.WISETACK_FINANCING_ENABLED = 'true';
    process.env.WISETACK_PREQUAL_URL = URL;
  }
  function approvedOverrides(extra: Record<string, unknown> = {}) {
    return {
      customer_approved_at: '2026-07-01T12:00:00Z',
      approval_snapshot: {
        approvedAt: '2026-07-01T12:00:00Z',
        customerSelection: {
          packageId: 'C',
          activeName: 'Package C',
          selectedItemIds: [],
          currentTotalUsd: 5000,
          currentDepositUsd: 2500,
          ...extra,
        },
      },
    };
  }

  it('flag on + URL + approved → financing carries the URL and the snapshot balance', async () => {
    enableFinancing();
    sbRef.current = makeSb(baseRow(approvedOverrides()));
    const portal = await loadPortalQuote(ID);
    expect(portal!.financing).toEqual({
      prequalUrl: URL,
      approvedTotalUsd: 5000,
      approvedBalanceUsd: 2500,
    });
  });

  it('an amendment supersedes the approved total (resolveAgreedTotal precedence)', async () => {
    enableFinancing();
    const overrides = approvedOverrides();
    (overrides.approval_snapshot as Record<string, unknown>).amendments = [{ new_total: 6000 }];
    sbRef.current = makeSb(baseRow(overrides));
    const portal = await loadPortalQuote(ID);
    expect(portal!.financing).toEqual({
      prequalUrl: URL,
      approvedTotalUsd: 6000,
      approvedBalanceUsd: 3500,
    });
  });

  it('unapproved quote → financing present (for the live-selection CTA) with a null approved balance', async () => {
    enableFinancing();
    sbRef.current = makeSb(baseRow());
    const portal = await loadPortalQuote(ID);
    expect(portal!.financing).toEqual({
      prequalUrl: URL,
      approvedTotalUsd: null,
      approvedBalanceUsd: null,
    });
  });

  it('approved but the snapshot has no deposit → null balance (never guess a financed amount)', async () => {
    enableFinancing();
    sbRef.current = makeSb(baseRow(approvedOverrides({ currentDepositUsd: undefined })));
    const portal = await loadPortalQuote(ID);
    expect(portal!.financing).toEqual({
      prequalUrl: URL,
      approvedTotalUsd: null,
      approvedBalanceUsd: null,
    });
  });

  it('flag off → financing absent (portal output unchanged)', async () => {
    process.env.WISETACK_PREQUAL_URL = URL; // URL alone is not enough
    sbRef.current = makeSb(baseRow(approvedOverrides()));
    const portal = await loadPortalQuote(ID);
    expect(portal!.financing).toBeUndefined();
  });

  it('flag on but no URL → financing absent (nothing safe to link to)', async () => {
    process.env.WISETACK_FINANCING_ENABLED = 'true';
    sbRef.current = makeSb(baseRow(approvedOverrides()));
    const portal = await loadPortalQuote(ID);
    expect(portal!.financing).toBeUndefined();
  });
});

// #117 review HIGH — applyOurRecommendation must be HOLIDAY-ONLY (positive
// gate). Permanent, event, and permanent bistro all repurpose package 'D' as a
// real bundle; a staff-recommended custom line item must never collapse that
// bundle into an "Our Recommendation" card that drops the core product.
describe('loadPortalQuote — applyOurRecommendation gate (#117)', () => {
  it('permanent_bistro: a recommended custom item does NOT clobber the single bistro package', async () => {
    const { calculatePermanentBistro } = await import('@/lib/permanentBistro/pricing');
    const inputs = {
      ...emptyInputs({ santasFootage: 0 }),
      permanentBistro: { bistro: [{ id: 'bistro-run-1', footage: 40 }], poles: 2 },
      customLineItems: [{ id: 'custom-1', label: 'Extra swag', amount: 50, recommended: true }],
    } as QuoteInputs;
    const result = calculatePermanentBistro(inputs);
    sbRef.current = makeSb(baseRow({ service_type: 'permanent_bistro', inputs, result, total: result.total }));
    getDesignByQuoteMock.mockResolvedValue(null);

    const portal = await loadPortalQuote(ID);

    expect(portal).not.toBeNull();
    expect(portal!.packages).toHaveLength(1);
    expect(portal!.packages[0].name).toBe('Bistro Lighting');
    // The bundle keeps EVERY line: the run, the poles, and the custom item.
    expect(portal!.packages[0].includedItemIds).toHaveLength(3);
  });

  it('holiday (null service_type): a recommended custom item still populates the D slot', async () => {
    const inputs = emptyInputs({
      customLineItems: [{ id: 'custom-1', label: 'Extra swag', amount: 50, recommended: true }],
    });
    const result = calculateQuote(inputs);
    sbRef.current = makeSb(baseRow({ inputs, result, total: result.total }));
    getDesignByQuoteMock.mockResolvedValue(null);

    const portal = await loadPortalQuote(ID);

    expect(portal).not.toBeNull();
    const d = portal!.packages.find((p) => p.id === 'D');
    expect(d).toBeDefined();
    expect(d!.name).toBe('Our Recommendation');
    expect(d!.includedItemIds).toContain(
      portal!.lineItems.find((li) => li.label.includes('Extra swag'))!.id,
    );
  });
});

// FIX4 (review HIGH, money): the amendment-consent card needs the linked
// invoice's tax_overridden flag to match the SMS/email's basis — fetched
// ONLY when the quote actually has an amendment trail, so the common case
// (no amendments) never pays for the extra round-trip.
describe('loadPortalQuote — invoice tax_overridden threading for the amendment card (FIX4)', () => {
  it('never looks up the job/invoice when the quote has no amendments', async () => {
    sbRef.current = makeSb(baseRow({ approval_snapshot: { amendments: [] } }));
    getDesignByQuoteMock.mockResolvedValue(null);

    await loadPortalQuote(ID);
    expect(getJobByQuoteMock).not.toHaveBeenCalled();
    expect(getInvoiceByJobMock).not.toHaveBeenCalled();
  });

  it('never looks up the job/invoice when approval_snapshot is null', async () => {
    sbRef.current = makeSb(baseRow({ approval_snapshot: null }));
    getDesignByQuoteMock.mockResolvedValue(null);

    await loadPortalQuote(ID);
    expect(getJobByQuoteMock).not.toHaveBeenCalled();
  });

  it('looks up the job/invoice when the quote HAS an amendment, and threads tax_overridden through', async () => {
    sbRef.current = makeSb(
      baseRow({ approval_snapshot: { amendments: [{ new_total: 3000, delta: 1000 }] } }),
    );
    getDesignByQuoteMock.mockResolvedValue(null);
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', tax_overridden: true });

    await loadPortalQuote(ID);
    expect(getJobByQuoteMock).toHaveBeenCalledWith(ID);
    expect(getInvoiceByJobMock).toHaveBeenCalledWith('job-1');
  });

  it('falls back to the trail basis (no crash) when the job exists but has no invoice yet', async () => {
    sbRef.current = makeSb(
      baseRow({ approval_snapshot: { amendments: [{ new_total: 3000, delta: 1000 }] } }),
    );
    getDesignByQuoteMock.mockResolvedValue(null);
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue(null);

    const portal = await loadPortalQuote(ID);
    expect(portal).not.toBeNull();
  });

  it('falls back to the trail basis (no crash, no throw) when the invoice lookup itself fails', async () => {
    sbRef.current = makeSb(
      baseRow({ approval_snapshot: { amendments: [{ new_total: 3000, delta: 1000 }] } }),
    );
    getDesignByQuoteMock.mockResolvedValue(null);
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockRejectedValue(new Error('db down'));

    const portal = await loadPortalQuote(ID);
    expect(portal).not.toBeNull();
  });
});
