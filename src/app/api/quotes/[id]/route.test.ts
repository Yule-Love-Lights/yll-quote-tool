// Tests for DELETE /api/quotes/[id] (W1-016).
//
// A per-row quote delete cascades away the linked job, invoice, approval snapshot,
// and Valor txn linkage. For a real (non-test) BOOKED or customer-APPROVED quote
// that's irreversible money loss, so the handler requires a confirm-token second
// factor (mirroring the bulk-wipe's x-confirm-delete-all). Draft / test rows keep
// the frictionless one-click delete.
//
// Supabase (the narrow status read) + deleteQuote + the operator gate are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { sbRef, deleteQuoteMock, requireOperatorMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  deleteQuoteMock: vi.fn(async () => {}),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/quotes', () => ({ deleteQuote: deleteQuoteMock }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
// loadPortalQuote is only used by GET — stub the module so importing it is cheap.
vi.mock('@/lib/portal/loader', () => ({
  loadPortalQuote: vi.fn(async () => null),
  isValidQuoteId: (id: string) => /^[0-9a-f-]{36}$/i.test(id),
  PortalConfigError: class PortalConfigError extends Error {},
}));

import { DELETE } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONFIRM = 'DELETE BOOKED QUOTE';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

// A narrow-select fake: from().select().eq().maybeSingle() → the status row.
function makeSb(row: Record<string, unknown> | null) {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    select: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: row, error: null }),
  });
  return b;
}

function makeReq(headers: Record<string, string> = {}): NextRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (k: string) => lower[k.toLowerCase()] ?? null } } as unknown as NextRequest;
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  sbRef.current = makeSb(null);
});

describe('DELETE /api/quotes/[id]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(401);
    expect(deleteQuoteMock).not.toHaveBeenCalled();
  });

  it('deletes a draft quote frictionlessly (no confirm header needed)', async () => {
    sbRef.current = makeSb({ deposit_paid_at: null, customer_approved_at: null, is_test: false });
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(deleteQuoteMock).toHaveBeenCalledWith(ID);
  });

  it('deletes when the quote row is missing (frictionless no-op path)', async () => {
    sbRef.current = makeSb(null);
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(deleteQuoteMock).toHaveBeenCalledWith(ID);
  });

  // W1-016: a BOOKED (deposit-paid) real quote is protected.
  it('428s (confirm-required) on a booked quote with no confirm header', async () => {
    sbRef.current = makeSb({ deposit_paid_at: '2026-06-30T00:00:00Z', customer_approved_at: '2026-06-29T00:00:00Z', is_test: false });
    const res = await DELETE(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(428);
    expect(json.code).toBe('confirm-required');
    expect(deleteQuoteMock).not.toHaveBeenCalled();
  });

  // A customer-approved (not-yet-paid) real quote is also protected.
  it('428s on a customer-approved quote with no confirm header', async () => {
    sbRef.current = makeSb({ deposit_paid_at: null, customer_approved_at: '2026-06-29T00:00:00Z', is_test: false });
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(428);
    expect(deleteQuoteMock).not.toHaveBeenCalled();
  });

  it('deletes a booked quote WHEN the confirm header is present', async () => {
    sbRef.current = makeSb({ deposit_paid_at: '2026-06-30T00:00:00Z', customer_approved_at: null, is_test: false });
    const res = await DELETE(makeReq({ 'x-confirm-delete-booked': CONFIRM }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(deleteQuoteMock).toHaveBeenCalledWith(ID);
  });

  it('does NOT protect a TEST booked quote (test data stays frictionless)', async () => {
    sbRef.current = makeSb({ deposit_paid_at: '2026-06-30T00:00:00Z', customer_approved_at: '2026-06-29T00:00:00Z', is_test: true });
    const res = await DELETE(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(deleteQuoteMock).toHaveBeenCalledWith(ID);
  });
});
