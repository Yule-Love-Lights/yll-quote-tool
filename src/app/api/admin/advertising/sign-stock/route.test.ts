import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const { requireAdmin, getSignStock, setSignStockQty } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getSignStock: vi.fn(),
  setSignStockQty: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, requireAdmin };
});
vi.mock('@/lib/advertising/signStock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/signStock')>();
  return { ...actual, getSignStock, setSignStockQty };
});

import { GET, PATCH } from './route';

const ADMIN = { operator: { id: 'admin-1', email: 'n@x.com', role: 'admin', name: 'Naldo' } };
const STOCK = { onHandQty: 40, reorderPoint: 10, acceptedAllTime: 12, pendingReview: 3 };

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  getSignStock.mockResolvedValue(STOCK);
  setSignStockQty.mockResolvedValue({ ...STOCK, onHandQty: 55 });
});

describe('sign stock route', () => {
  it('is admin only', async () => {
    requireAdmin.mockResolvedValue({
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    });
    expect((await GET()).status).toBe(403);
    expect((await PATCH(makeReq({ onHandQty: 5 }))).status).toBe(403);
    expect(setSignStockQty).not.toHaveBeenCalled();
  });

  it('GET returns the reconciliation numbers', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).stock).toEqual(STOCK);
  });

  it('PATCH sets the count with the admin as actor', async () => {
    const res = await PATCH(makeReq({ onHandQty: 55 }));
    expect(res.status).toBe(200);
    expect(setSignStockQty).toHaveBeenCalledWith(55, 'admin-1');
  });

  it('PATCH refuses strings, floats, and negatives without writing', async () => {
    for (const bad of ['55', 5.5, -1, null, undefined]) {
      const res = await PATCH(makeReq({ onHandQty: bad }));
      expect(res.status).toBe(400);
    }
    expect(setSignStockQty).not.toHaveBeenCalled();
  });

  it('a lost CAS race surfaces as 409 with the reload message, and other failures as 500', async () => {
    const { SignStockConflictError } = await import('@/lib/advertising/signStock');
    setSignStockQty.mockRejectedValue(new SignStockConflictError());
    const conflict = await PATCH(makeReq({ onHandQty: 55 }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toMatch(/changed while/);

    setSignStockQty.mockRejectedValue(new Error('db down'));
    const failed = await PATCH(makeReq({ onHandQty: 55 }));
    expect(failed.status).toBe(500);
  });
});
