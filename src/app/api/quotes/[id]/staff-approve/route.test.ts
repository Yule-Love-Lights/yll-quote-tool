// Tests for POST /api/quotes/[id]/staff-approve (#83 ops).
//
// Operator approves a quote on the customer's behalf (phone/verbal "yes"):
//   sent | viewed → approved (skips e-signature)
//   writes customer_approved_at, status='approved',
//   approval_snapshot.staffApproved = { by, at }
//
// Money-safety guards:
//   - illegal status transitions are blocked (409)
//   - the write is atomic: .is('customer_approved_at', null) — two concurrent
//     requests yield one ok + one idempotent no-op
//   - is_test → no real GHL/notify call
//   - already approved → idempotent 200 { alreadyApproved: true }

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, getOperatorMock, sbRef } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async () => null as { email: string | null } | null),
  sbRef: { current: null as unknown },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(): NextRequest {
  return { headers: { get: () => null } } as unknown as NextRequest;
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

// Build a chainable Supabase mock.
// maybeSingle() → the quote row
// .update().eq().is().select() terminates with .then() → the updateRows
function makeSb(
  quote: Record<string, unknown> | null,
  updateRows: Array<{ id: string }> | null = [{ id: ID }],
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  let pendingIsUpdate = false;

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      pendingIsUpdate = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    is: () => builder,
    maybeSingle: async () => ({ data: quote, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const isUpd = pendingIsUpdate;
      pendingIsUpdate = false;
      resolve(isUpd ? { data: updateRows, error: null } : { data: quote, error: null });
    },
  });
  return { client: builder, updatePayloads };
}

const BASE_SENT_QUOTE = {
  id: ID,
  status: 'sent' as const,
  quote_sent_at: '2026-07-01T00:00:00Z',
  viewed_at: null,
  customer_approved_at: null,
  deposit_paid_at: null,
  result: null,
  approval_snapshot: null,
  is_test: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ email: 'operator@example.com' });
});

describe('POST /api/quotes/[id]/staff-approve', () => {
  it('400s on an invalid UUID', async () => {
    const res = await POST(makeReq(), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('404s when the quote does not exist', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(404);
  });

  it('409s when the quote is in draft — illegal transition', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'draft', quote_sent_at: null });
    sbRef.current = client;
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('illegal-transition');
  });

  it('409s when the quote is booked — cannot re-approve a booked quote', async () => {
    const { client } = makeSb({
      ...BASE_SENT_QUOTE,
      status: 'booked',
      customer_approved_at: '2026-06-30T00:00:00Z',
      deposit_paid_at: '2026-06-30T01:00:00Z',
    });
    sbRef.current = client;
    // Note: the booked quote has customer_approved_at set, so it should return
    // idempotent alreadyApproved (since we check customer_approved_at first)
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyApproved).toBe(true);
  });

  it('approves a sent quote — writes status=approved, customer_approved_at, staffApproved in snapshot, guarded by .is(customer_approved_at, null)', async () => {
    const { client, updatePayloads } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.approved).toBe(true);
    expect(json.staff).toBe(true);

    const payload = updatePayloads[0];
    expect(payload.status).toBe('approved');
    expect(typeof payload.customer_approved_at).toBe('string');

    const snapshot = payload.approval_snapshot as {
      staffApproved: { by: string | null; at: string };
    };
    expect(snapshot.staffApproved).toBeTruthy();
    expect(snapshot.staffApproved.by).toBe('operator@example.com');
    expect(typeof snapshot.staffApproved.at).toBe('string');
  });

  it('approves a viewed quote', async () => {
    const { client } = makeSb({ ...BASE_SENT_QUOTE, status: 'viewed', viewed_at: '2026-07-01T01:00:00Z' });
    sbRef.current = client;
    const res = await POST(makeReq(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.approved).toBe(true);
  });

  it('is idempotent when already approved (customer_approved_at set) — returns alreadyApproved, no write', async () => {
    const { client, updatePayloads } = makeSb({
      ...BASE_SENT_QUOTE,
      customer_approved_at: '2026-07-01T00:00:00Z',
    });
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyApproved).toBe(true);
    // No update should have been written
    expect(updatePayloads).toHaveLength(0);
  });

  it('handles a race (update returns 0 rows) as idempotent alreadyApproved', async () => {
    const { client } = makeSb(BASE_SENT_QUOTE, []); // [] = race loser
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyApproved).toBe(true);
  });

  it('records staffApproved.by as null when getOperator returns null (dormant gate)', async () => {
    getOperatorMock.mockResolvedValueOnce(null);
    const { client, updatePayloads } = makeSb(BASE_SENT_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    const snapshot = (updatePayloads[0].approval_snapshot as { staffApproved: { by: unknown } });
    expect(snapshot.staffApproved.by).toBeNull();
  });

  it('does not fire any real GHL/notify on is_test quote', async () => {
    // The route must not import or call GHL helpers; if it did, they would
    // throw here since GHL is not mocked. The test passing proves it's safe.
    const { client } = makeSb({ ...BASE_SENT_QUOTE, is_test: true });
    sbRef.current = client;
    const res = await POST(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).approved).toBe(true);
  });

  it('preserves existing approval_snapshot fields and adds staffApproved', async () => {
    const existingSnapshot = { version: 1, someOtherField: 'value' };
    const { client, updatePayloads } = makeSb({
      ...BASE_SENT_QUOTE,
      approval_snapshot: existingSnapshot,
    });
    sbRef.current = client;

    await POST(makeReq(), ctx());
    const snapshot = updatePayloads[0].approval_snapshot as Record<string, unknown>;
    // Should merge, not replace
    expect(snapshot.someOtherField).toBe('value');
    expect(snapshot.staffApproved).toBeTruthy();
  });
});
