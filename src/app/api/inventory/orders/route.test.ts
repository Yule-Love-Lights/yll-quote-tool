import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { listOrders } = vi.hoisted(() => ({
  listOrders: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/inventory/orders', () => ({ listOrders }));

import { GET } from './route';

function makeReq(status?: string): NextRequest {
  const url = new URL(`https://x.test/api/inventory/orders${status ? `?status=${status}` : ''}`);
  return { nextUrl: url } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/inventory/orders', () => {
  it('lists all orders when no status filter is given', async () => {
    listOrders.mockResolvedValue([{ id: 'o1' }]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orders: [{ id: 'o1' }] });
    expect(listOrders).toHaveBeenCalledWith(undefined);
  });

  it('filters to status=open when the query param is set', async () => {
    listOrders.mockResolvedValue([]);
    await GET(makeReq('open'));
    expect(listOrders).toHaveBeenCalledWith({ status: 'open' });
  });
});
