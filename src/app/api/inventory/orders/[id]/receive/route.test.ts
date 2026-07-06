import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { receiveOrder, listOrders, recordAutoSentSignature } = vi.hoisted(() => ({
  receiveOrder: vi.fn(async () => null as { ok: true; alreadyDone?: true } | null),
  listOrders: vi.fn(async () => [] as { id: string }[]),
  recordAutoSentSignature: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/inventory/orders', () => ({ receiveOrder, listOrders }));
vi.mock('@/lib/inventory/purchaseOrder', () => ({ recordAutoSentSignature }));

import { POST } from './route';

function makeReq(body?: unknown): NextRequest {
  return {
    headers: { get: (k: string) => (k === 'content-length' && body === undefined ? '0' : null) },
    json: async () => body,
  } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/inventory/orders/[id]/receive', () => {
  it('receives with no body → full receipt, 200, and resets the auto-send signature', async () => {
    receiveOrder.mockResolvedValue({ ok: true });
    const res = await POST(makeReq(), params('o1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(receiveOrder).toHaveBeenCalledWith('o1', undefined);
    // A short receipt can reproduce an old delta signature — the reset keeps
    // the cron from suppressing the next real shortfall as "unchanged".
    expect(recordAutoSentSignature).toHaveBeenCalledWith('');
  });

  it('passes edited lines through', async () => {
    receiveOrder.mockResolvedValue({ ok: true });
    const res = await POST(makeReq({ lines: [{ sku: 'A', qty: 3 }] }), params('o1'));
    expect(res.status).toBe(200);
    expect(receiveOrder).toHaveBeenCalledWith('o1', [{ sku: 'A', qty: 3 }]);
  });

  it('404s when the order does not exist', async () => {
    receiveOrder.mockResolvedValue(null);
    listOrders.mockResolvedValue([]);
    const res = await POST(makeReq(), params('missing'));
    expect(res.status).toBe(404);
    expect(recordAutoSentSignature).not.toHaveBeenCalled();
  });

  it('400s when the order exists but the lines were rejected (unknown SKU)', async () => {
    receiveOrder.mockResolvedValue(null);
    listOrders.mockResolvedValue([{ id: 'o1' }]);
    const res = await POST(makeReq({ lines: [{ sku: 'ZZZ', qty: 1 }] }), params('o1'));
    expect(res.status).toBe(400);
  });
});
