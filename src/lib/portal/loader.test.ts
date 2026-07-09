// #110 W4-016 — loadPortalQuote starts the linked-design lookup (getDesignByQuote)
// IN PARALLEL with the quote row fetch, instead of strictly after it. Both DB
// calls only need the URL quote id, which is known up front.
//
// Supabase (the quote row) + lib/designs (getDesignByQuote) are mocked. We assert:
//   1. the parallelization itself — both fire before either resolves;
//   2. behavior is unchanged — a resolved design still merges into the portal;
//   3. the best-effort contract is unchanged — a design-lookup rejection never
//      blocks/nulls the quote (matches the pre-existing try/catch around it).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import type { Scene } from '@/lib/design/sceneTypes';
import type { DesignWithPhoto } from '@/lib/designs';

const { sbRef, getDesignByQuoteMock, events } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  getDesignByQuoteMock: vi.fn(),
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
