// Tests for POST /api/quotes/[id]/color-change-request (ledger #163). A booked
// customer requests a colour change; the route sanitizes the colour, records it
// on the quote (approval_snapshot.pendingColorRequest), and pings the inbox. It
// does NOT alter the booked order. Supabase + getAppSettings + ingestTouch are
// mocked; the colour sanitize helpers run for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';
import { DEFAULT_COLOR_SCHEMES, DEFAULT_BUILDABLE_COLOR_IDS } from '@/lib/design/colorSchemes';

const { sbRef, ingestTouchMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  ingestTouchMock: vi.fn(async (_touch: unknown, _now: unknown) => ({ ok: true })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/appSettings', () => ({
  getAppSettings: async () => ({
    swatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
    permanentSwatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
  }),
}));
vi.mock('@/lib/dashboard/inbox/store', () => ({ ingestTouch: ingestTouchMock }));

import { POST, colorChangeLabel } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const req = (body: unknown) =>
  ({ json: async () => body, nextUrl: { origin: 'https://test.local' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;
function makeSb(quote: Row | null, fresh: Row | null = quote, quoteUpdateRows: Row[] = [{ id: ID }]) {
  const updates: Row[] = [];
  let table = '';
  let updating = false;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: (t: string) => {
      table = t;
      return b;
    },
    select: () => b,
    update: (payload: Row) => {
      updating = true;
      updates.push(payload);
      return b;
    },
    eq: () => b,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => ({ data: fresh, error: null }),
    // Models the CAS write: a quotes UPDATE resolves to the rows that matched the
    // .eq('approval_snapshot', ...) filter — [] simulates a lost concurrency race.
    then: (resolve: (v: unknown) => void) => {
      const data = updating && table === 'quotes' ? quoteUpdateRows : null;
      updating = false;
      resolve({ data, error: null });
    },
  });
  return { client: b, updates };
}

function bookedQuote(overrides: Row = {}) {
  return {
    id: ID,
    customer_name: 'Test Person',
    customer_email: 'test@example.com',
    customer_phone: '+16315551212',
    service_type: 'holiday',
    highlevel_contact_id: 'hl-1',
    customer_approved_at: '2026-01-01T00:00:00Z',
    deposit_paid_at: '2026-01-02T00:00:00Z',
    quote_sent_at: '2025-12-01T00:00:00Z',
    status: 'booked',
    total: 2000,
    approval_snapshot: { customerSelection: { packageId: 'C', selectedItemIds: ['x'] } },
    ...overrides,
  } as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  sbRef.current = null;
});

describe('colorChangeLabel', () => {
  it('labels a custom pattern by its colour count', () => {
    expect(colorChangeLabel('custom', ['red', 'green'])).toBe('Custom pattern (2 colours)');
    expect(colorChangeLabel('custom', ['red'])).toBe('Custom pattern (1 colour)');
  });

  it('labels a preset scheme with its display name', () => {
    expect(typeof colorChangeLabel('as-designed', [])).toBe('string');
    expect(colorChangeLabel('as-designed', []).length).toBeGreaterThan(0);
  });
});

describe('POST /api/quotes/[id]/color-change-request', () => {
  it('409s when the order is not booked (no approval snapshot)', async () => {
    sbRef.current = makeSb(
      bookedQuote({ customer_approved_at: null, approval_snapshot: null }),
    ).client;
    const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
    expect(res.status).toBe(409);
  });

  it('records the requested colour on the quote and pings the inbox', async () => {
    const { client, updates } = makeSb(bookedQuote());
    sbRef.current = client;

    const res = await POST(req({ colorSchemeId: 'custom', customPattern: ['red', 'green'] }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.label).toBe('Custom pattern (2 colours)');

    // pendingColorRequest recorded; the signed customerSelection is untouched.
    expect(updates).toHaveLength(1);
    const snap = (updates[0].approval_snapshot as {
      customerSelection: unknown;
      pendingColorRequest: { colorSchemeId: string; customPattern: string[]; label: string };
    });
    expect(snap.customerSelection).toEqual({ packageId: 'C', selectedItemIds: ['x'] });
    expect(snap.pendingColorRequest.colorSchemeId).toBe('custom');
    expect(snap.pendingColorRequest.customPattern).toEqual(['red', 'green']);
    expect(snap.pendingColorRequest.label).toBe('Custom pattern (2 colours)');

    // inbox notified with a distinct external_id (never collides with quote-sent).
    expect(ingestTouchMock).toHaveBeenCalledTimes(1);
    const touch = ingestTouchMock.mock.calls[0][0] as { source: string; externalId: string };
    expect(touch.source).toBe('quotetool');
    expect(touch.externalId).toBe(`${ID}:color-request`);
  });

  it('still succeeds (request saved) when the inbox ping throws', async () => {
    ingestTouchMock.mockRejectedValueOnce(new Error('inbox down'));
    const { client, updates } = makeSb(bookedQuote());
    sbRef.current = client;
    const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1); // the request was still recorded
  });

  // ── the #163 CAS-race + terminal fixes ─────────────────────────────────────
  it('409s (concurrent-edit) when the CAS write matches no rows — never clobbers a racing amend', async () => {
    const q = bookedQuote();
    const { client } = makeSb(q, q, []); // [] = the CAS lost the race to a concurrent write
    sbRef.current = client;
    const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('concurrent-edit');
    // inbox is NOT pinged when the request did not persist
    expect(ingestTouchMock).not.toHaveBeenCalled();
  });

  it('409s (not-editable) on a terminal order — a cancelled order takes no colour requests', async () => {
    sbRef.current = makeSb(bookedQuote({ status: 'cancelled' })).client;
    const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('not-editable');
  });
});
