import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { cancelOrder } = vi.hoisted(() => ({
  cancelOrder: vi.fn(async () => null as 'cancelled' | 'already-closed' | null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/inventory/orders', () => ({ cancelOrder }));

import { POST } from './route';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = {} as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/inventory/orders/[id]/cancel', () => {
  it('cancels an open order, 200 ok:true', async () => {
    cancelOrder.mockResolvedValue('cancelled');
    const res = await POST(req, params('o1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reports alreadyClosed when it was already closed', async () => {
    cancelOrder.mockResolvedValue('already-closed');
    const res = await POST(req, params('o1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyClosed: true });
  });

  it('404s when the order does not exist', async () => {
    cancelOrder.mockResolvedValue(null);
    const res = await POST(req, params('missing'));
    expect(res.status).toBe(404);
  });
});
