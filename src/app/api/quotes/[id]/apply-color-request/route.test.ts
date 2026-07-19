// Tests for POST /api/quotes/[id]/apply-color-request (ledger #163 Slice B).
// Operator-gated. Staff APPLY (re-freeze the booked colour) or DISMISS a pending
// colour request. Supabase + auth + getAppSettings are mocked; amend.ts,
// agreedTotal, resolveColorChoice + the colour helpers run for real — the
// total-invariant + re-validation are what we verify.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { sbRef, requireOperatorMock, getOperatorMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ name: 'naldo' })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/appSettings', async () => {
  const { DEFAULT_COLOR_SCHEMES, DEFAULT_BUILDABLE_COLOR_IDS } = await import('@/lib/design/colorSchemes');
  return {
    getAppSettings: async () => ({
      swatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
      permanentSwatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
    }),
  };
});

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = (body: unknown) =>
  ({ json: async () => body, nextUrl: { origin: 'https://test.local' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;
function makeSb(quote: Row | null, fresh: Row | null = quote) {
  const updates: { quotes: Row[]; inbox_items: Row[] } = { quotes: [], inbox_items: [] };
  let table = '';
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: (t: string) => {
      table = t;
      return b;
    },
    select: () => b,
    update: (payload: Row) => {
      (updates as Record<string, Row[]>)[table]?.push(payload);
      return b;
    },
    insert: () => b,
    eq: () => b,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => (table === 'inbox_items' ? { data: null, error: null } : { data: fresh, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
  });
  return { client: b, updates };
}

function bookedQuote(overrides: Row = {}, pending: Row | null = {
  colorSchemeId: 'custom',
  customPattern: ['red', 'green'],
  colorIds: ['red', 'green'],
  label: 'Custom pattern (2 colours)',
}) {
  const snapshot: Row = {
    customerSelection: {
      packageId: 'C',
      selectedItemIds: ['x'],
      colorSchemeId: 'as-designed',
      customPattern: [],
      colorIds: null,
      currentTotalUsd: 2000,
    },
    amendments: [],
    ...(pending ? { pendingColorRequest: pending } : {}),
  };
  return {
    id: ID,
    status: 'booked',
    customer_approved_at: '2026-01-01T00:00:00Z',
    deposit_paid_at: '2026-01-02T00:00:00Z',
    deposit_amount_usd: 1000,
    total: 2000,
    result: { total: 2000 },
    service_type: 'holiday',
    approval_snapshot: snapshot,
    ...overrides,
  } as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ name: 'naldo' });
  sbRef.current = null;
});

describe('POST /api/quotes/[id]/apply-color-request', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(401);
  });

  it('409s when there is no pending colour request', async () => {
    sbRef.current = makeSb(bookedQuote({}, null)).client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(409);
  });

  it('400s a dismiss with no reason', async () => {
    sbRef.current = makeSb(bookedQuote()).client;
    const res = await POST(req({ action: 'dismiss' }), ctx());
    expect(res.status).toBe(400);
  });

  it('dismiss clears the pending request', async () => {
    const { client, updates } = makeSb(bookedQuote());
    sbRef.current = client;
    const res = await POST(req({ action: 'dismiss', reason: 'we already discussed by phone' }), ctx());
    expect(res.status).toBe(200);
    const snap = updates.quotes[0].approval_snapshot as Row;
    expect(snap.pendingColorRequest).toBeUndefined();
    expect(snap.customerSelection).toBeDefined(); // selection untouched
  });

  it('apply re-freezes the colour, clears pending, records a ZERO-delta amendment, total invariant', async () => {
    const { client, updates } = makeSb(bookedQuote());
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const snap = updates.quotes[0].approval_snapshot as {
      customerSelection: { colorSchemeId: string; customPattern: string[]; currentTotalUsd: number };
      pendingColorRequest?: unknown;
      amendments: Array<{ delta: number }>;
    };
    // re-frozen onto the signed selection
    expect(snap.customerSelection.colorSchemeId).toBe('custom');
    expect(snap.customerSelection.customPattern).toEqual(['red', 'green']);
    // pending cleared
    expect(snap.pendingColorRequest).toBeUndefined();
    // zero-delta amendment appended
    expect(snap.amendments).toHaveLength(1);
    expect(snap.amendments[0].delta).toBe(0);
    // money invariant: the agreed total is untouched
    expect(snap.customerSelection.currentTotalUsd).toBe(2000);
  });

  it('apply RE-VALIDATES against the live swatch list — an unknown scheme degrades to as-designed', async () => {
    const { client, updates } = makeSb(
      bookedQuote({}, { colorSchemeId: 'scheme-deleted-since', customPattern: [], colorIds: ['x'], label: 'Gone' }),
    );
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(200);
    const snap = updates.quotes[0].approval_snapshot as {
      customerSelection: { colorSchemeId: string; customPattern: string[] };
    };
    expect(snap.customerSelection.colorSchemeId).toBe('as-designed');
    expect(snap.customerSelection.customPattern).toEqual([]);
  });

  it('409s when the order is terminal (cancelled)', async () => {
    sbRef.current = makeSb(bookedQuote({ status: 'cancelled' })).client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(409);
  });
});
