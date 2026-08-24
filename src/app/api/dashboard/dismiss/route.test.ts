// Tests for POST /api/dashboard/dismiss.
//
// Row 387, and the direct sibling of handled/route.test.ts (row 320(c)): the
// "Not a lead" button only ever renders on a listOpenItems row (bucket
// 'needs_reply', status==='unresponded' — InboxList.tsx / store.ts's
// applyBucketFilter), and it is the ONLY dismiss control in the app.
//
// This file exists because the first cut of row 387 passed
// ['unresponded','handled'] and NOTHING caught it — the route's status set had
// no test at all. 'handled' is precisely the status the guard exists to refuse
// (a row a colleague answered in the read/write gap IS 'handled'), so including
// it reopened the very race the row was written to close: an answered lead
// flipped to dismissed, and addSuppressedSenders silently filtering that real
// customer's future messages. Two review lenses converged on it independently.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, getOperatorMock, dismissItemMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ id: 'op-1', email: 'op@yulelovelights.com', role: 'operator', name: 'Op' })),
  // Typed with the REAL 4-arg signature: a bare vi.fn(async () => ...) infers a
  // zero-arg call tuple, so mock.calls[0][3] is a tsc error even though the test
  // passes at runtime.
  dismissItemMock: vi.fn(
    async (
      _itemId: string,
      _operatorId: string | null,
      _now: Date,
      _opts?: { expectedStatus?: string | string[] },
    ): Promise<unknown> => ({ ok: true }),
  ),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/dashboard/inbox/store', () => ({ dismissItem: dismissItemMock }));

import { POST } from './route';

const ITEM_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const makeReq = (body: unknown): NextRequest => ({ json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'op@yulelovelights.com', role: 'operator', name: 'Op' });
  dismissItemMock.mockResolvedValue({ ok: true });
});

describe('POST /api/dashboard/dismiss', () => {
  it('dismisses with a POSITIVE unresponded-only CAS', async () => {
    const res = await POST(makeReq({ itemId: ITEM_ID }));
    expect(res.status).toBe(200);
    expect(dismissItemMock).toHaveBeenCalledTimes(1);
    const opts = dismissItemMock.mock.calls[0][3];
    expect(opts?.expectedStatus).toBe('unresponded');
  });

  // THE regression this file was created for. 'handled' must never be
  // dismissable: that is the exact state a stale click races into, and letting
  // it through both mis-marks an answered lead AND suppresses a real customer.
  it('never allows handled as a dismissable source status', async () => {
    await POST(makeReq({ itemId: ITEM_ID }));
    const opts = dismissItemMock.mock.calls[0][3];
    const raw = opts?.expectedStatus;
    const set: (string | undefined)[] = Array.isArray(raw) ? raw : [raw];
    expect(set).not.toContain('handled');
    expect(set).not.toContain('completed');
    expect(set).not.toContain('dismissed');
  });

  // A lost race is not an outage: the client can tell "someone else already
  // dealt with this" from "the backend is down" only if these differ.
  it('answers 409 on a refused CAS and 503 on a genuine failure', async () => {
    dismissItemMock.mockResolvedValueOnce({ ok: false, error: 'Item not found or no longer unresponded', refused: true });
    const refused = await POST(makeReq({ itemId: ITEM_ID }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/no longer unresponded/);

    dismissItemMock.mockResolvedValueOnce({ ok: false, error: 'Supabase service role not configured' });
    const broken = await POST(makeReq({ itemId: ITEM_ID }));
    expect(broken.status).toBe(503);
  });

  it('rejects a non-uuid itemId before touching the store', async () => {
    const res = await POST(makeReq({ itemId: 'nope' }));
    expect(res.status).toBe(400);
    expect(dismissItemMock).not.toHaveBeenCalled();
  });

  it('passes a null operator id through rather than a sentinel string', async () => {
    getOperatorMock.mockResolvedValueOnce(null);
    await POST(makeReq({ itemId: ITEM_ID }));
    expect(dismissItemMock.mock.calls[0][1]).toBeNull();
  });
});
