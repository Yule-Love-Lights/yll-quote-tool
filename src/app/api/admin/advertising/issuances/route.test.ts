import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const { requireAdmin, issueSigns, getWorkerSignBalance, listIssuances, listAdvertisingWorkers } =
  vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    issueSigns: vi.fn(),
    getWorkerSignBalance: vi.fn(),
    listIssuances: vi.fn(),
    listAdvertisingWorkers: vi.fn(),
  }));

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, requireAdmin };
});
vi.mock('@/lib/advertising/signIssuances', () => ({ issueSigns, getWorkerSignBalance, listIssuances }));
vi.mock('@/lib/advertising/workers', () => ({ listAdvertisingWorkers }));

import { GET, POST } from './route';

const ADMIN = { operator: { id: 'admin-1', email: 'n@x.com', role: 'admin', name: 'Naldo' } };
const BALANCE = { workerId: 'worker-1', issuedTotal: 50, signsUsed: 12, remaining: 38 };

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}
function makeGetReq(query: Record<string, string> = {}): NextRequest {
  const url = new URL('https://x.test/api/admin/advertising/issuances');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { nextUrl: url } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  issueSigns.mockResolvedValue({ issuance: { id: 'iss-1' }, issuedQty: 50 });
  getWorkerSignBalance.mockResolvedValue(BALANCE);
  listIssuances.mockResolvedValue([]);
  listAdvertisingWorkers.mockResolvedValue([
    { id: 'worker-1', displayName: 'Joe Signs', active: true, isTest: false, authUserId: null },
  ]);
});

describe('issuances route', () => {
  it('is admin only', async () => {
    requireAdmin.mockResolvedValue({
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    });
    expect((await GET(makeGetReq())).status).toBe(403);
    expect((await POST(makeReq({ workerId: 'worker-1', qty: 50 }))).status).toBe(403);
    expect(issueSigns).not.toHaveBeenCalled();
  });

  it('POST issues with the ADMIN session as issuer, never one from the body', async () => {
    const res = await POST(makeReq({ workerId: 'worker-1', qty: 50, issuedBy: 'someone-else' }));
    expect(res.status).toBe(201);
    // Fifth argument is the idempotency key (row 480); this caller sends none.
    expect(issueSigns).toHaveBeenCalledWith('worker-1', 50, 'admin-1', undefined, undefined);
  });

  it('POST refuses zero, negative, fractional and string quantities', async () => {
    for (const bad of [0, -5, 2.5, '50', null, undefined]) {
      expect((await POST(makeReq({ workerId: 'worker-1', qty: bad }))).status).toBe(400);
    }
    expect(issueSigns).not.toHaveBeenCalled();
  });

  it('GET returns every worker with a balance; scoped GET adds history', async () => {
    const all = await GET(makeGetReq());
    expect(all.status).toBe(200);
    expect((await all.json()).balances[0]).toEqual(
      expect.objectContaining({ displayName: 'Joe Signs', remaining: 38 }),
    );

    const one = await GET(makeGetReq({ workerId: 'worker-1' }));
    const body = await one.json();
    expect(body.balance).toEqual(BALANCE);
    expect(listIssuances).toHaveBeenCalledWith('worker-1');
  });
});

describe('POST idempotency key (ledger row 480)', () => {
  const ID = '55555555-5555-4555-8555-555555555555';

  it('passes a valid request id through to the data layer', async () => {
    const res = await POST(makeReq({ workerId: 'worker-1', qty: 50, requestId: ID }));
    expect(res.status).toBe(201);
    expect(issueSigns).toHaveBeenCalledWith('worker-1', 50, 'admin-1', undefined, ID);
  });

  it('refuses a malformed id instead of storing a key that guards nothing', async () => {
    const res = await POST(makeReq({ workerId: 'worker-1', qty: 50, requestId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(issueSigns).not.toHaveBeenCalled();
  });

  it('still works with no id at all', async () => {
    const res = await POST(makeReq({ workerId: 'worker-1', qty: 50 }));
    expect(res.status).toBe(201);
    expect(issueSigns).toHaveBeenCalledWith('worker-1', 50, 'admin-1', undefined, undefined);
  });
});
