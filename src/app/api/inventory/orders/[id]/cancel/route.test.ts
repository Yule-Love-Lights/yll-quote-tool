import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { cancelOrder, recordAutoSentSignature } = vi.hoisted(() => ({
  cancelOrder: vi.fn(async () => null as 'cancelled' | 'already-closed' | null),
  recordAutoSentSignature: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/inventory/orders', () => ({ cancelOrder }));
vi.mock('@/lib/inventory/purchaseOrder', () => ({ recordAutoSentSignature }));
// ledger #347: requireOperator is now engaged by default — stub it authorized
// like the other route.ts test suites do; this suite is about cancel logic.
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: vi.fn(async () => null) }));

import { POST } from './route';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = {} as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/inventory/orders/[id]/cancel', () => {
  it('cancels an open order, 200 ok:true, and resets the auto-send signature', async () => {
    cancelOrder.mockResolvedValue('cancelled');
    const res = await POST(req, params('o1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Cancelling re-opens a shortfall that may match a previously-sent delta
    // signature — without the reset the cron would suppress the re-order.
    expect(recordAutoSentSignature).toHaveBeenCalledWith('');
  });

  it('reports alreadyClosed when it was already closed — no signature reset (nothing changed)', async () => {
    cancelOrder.mockResolvedValue('already-closed');
    const res = await POST(req, params('o1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyClosed: true });
    expect(recordAutoSentSignature).not.toHaveBeenCalled();
  });

  it('404s when the order does not exist', async () => {
    cancelOrder.mockResolvedValue(null);
    const res = await POST(req, params('missing'));
    expect(res.status).toBe(404);
  });
});
