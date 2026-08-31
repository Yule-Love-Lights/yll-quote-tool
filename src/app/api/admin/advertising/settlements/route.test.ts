// The admin pay door: the one route that records money leaving the business.
// Its own duties, separate from the data layer's: the payer is the ADMIN
// SESSION and never the body, the photos being paid are chosen SERVER-side,
// the amount the screen showed is honoured or the write is refused, and the
// one failure that needs a person is named as such instead of "try again".
// Every sibling admin advertising route has a test file; this one shipped
// without one (delta-verify round 2, PR #1130).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  requireAdmin,
  listPayablePlacements,
  listPayoutSummaries,
  listSettlements,
  recordSettlement,
  listAdvertisingWorkers,
} = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listPayablePlacements: vi.fn(),
  listPayoutSummaries: vi.fn(),
  listSettlements: vi.fn(),
  recordSettlement: vi.fn(),
  listAdvertisingWorkers: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, requireAdmin };
});
vi.mock('@/lib/advertising/payouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/payouts')>();
  return { ...actual, listPayablePlacements, listPayoutSummaries, listSettlements, recordSettlement };
});
vi.mock('@/lib/advertising/workers', () => ({ listAdvertisingWorkers }));

import { GET, POST } from './route';

const ADMIN = { operator: { id: 'admin-1', email: 'n@x.com', role: 'admin', name: 'Naldo' } };

function postReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function getReq(search = ''): NextRequest {
  return { nextUrl: new URL(`http://x/api/admin/advertising/settlements${search}`) } as unknown as NextRequest;
}

function payable(id: string, amountCents: number) {
  return { id, workerId: 'worker-1', campaignId: 'camp-1', amountCents, capturedAt: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  listAdvertisingWorkers.mockResolvedValue([
    { id: 'worker-1', displayName: 'Joe Signs', active: true, isTest: false },
  ]);
  listPayoutSummaries.mockResolvedValue([
    {
      workerId: 'worker-1',
      earnedCents: 550,
      settledCents: 0,
      unpaidCents: 550,
      lastPaidAt: null,
      payableCount: 2,
    },
  ]);
  listPayablePlacements.mockResolvedValue([payable('p1', 250), payable('p2', 300)]);
  listSettlements.mockResolvedValue([]);
  recordSettlement.mockResolvedValue({
    id: 's1',
    workerId: 'worker-1',
    totalCents: 550,
    method: 'cash',
    note: null,
    paidAt: '2026-08-30T18:00:00.000Z',
    paidBy: 'admin-1',
    lineCount: 2,
    createdAt: '2026-08-30T18:00:00.000Z',
  });
});

describe('GET', () => {
  it('reports earned, paid, unpaid and what is payable right now', async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workers: Array<Record<string, unknown>> };
    expect(body.workers[0]).toMatchObject({
      workerId: 'worker-1',
      displayName: 'Joe Signs',
      earnedCents: 550,
      settledCents: 0,
      unpaidCents: 550,
      payableTotalCents: 550, // summed from the payable photos, not a stored number
    });
  });

  it('says a money read failed instead of answering with zeros', async () => {
    // An empty list here would read as "nobody is owed anything", which is
    // the worst possible lie on this screen.
    listPayoutSummaries.mockRejectedValue(new Error('payouts: could not read'));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not load pay.' });
  });
});

describe('POST', () => {
  it('records the payment with the ADMIN SESSION as payer and the server-chosen photos', async () => {
    const res = await POST(postReq({ workerId: 'worker-1', method: 'cash', expectedTotalCents: 550 }));
    expect(res.status).toBe(201);
    // Never a payer from the body, and never a photo list from the body.
    expect(recordSettlement).toHaveBeenCalledWith('worker-1', ['p1', 'p2'], 'admin-1', {
      method: 'cash',
      note: undefined,
    });
  });

  it('ignores a payer supplied in the body', async () => {
    await POST(
      postReq({ workerId: 'worker-1', method: 'cash', expectedTotalCents: 550, paidBy: 'someone-else' }),
    );
    expect(recordSettlement).toHaveBeenCalledWith('worker-1', ['p1', 'p2'], 'admin-1', expect.anything());
  });

  it('refuses when the amount moved while the screen was open, and writes nothing', async () => {
    const res = await POST(postReq({ workerId: 'worker-1', method: 'cash', expectedTotalCents: 500 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/amount changed/i);
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  it('refuses an unknown payment method and a missing worker', async () => {
    const badMethod = await POST(
      postReq({ workerId: 'worker-1', method: 'bitcoin', expectedTotalCents: 550 }),
    );
    expect(badMethod.status).toBe(400);
    const noWorker = await POST(postReq({ method: 'cash', expectedTotalCents: 550 }));
    expect(noWorker.status).toBe(400);
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  it('refuses when nothing is outstanding, and says THAT rather than blaming the amount', async () => {
    listPayablePlacements.mockResolvedValue([]);
    const res = await POST(postReq({ workerId: 'worker-1', method: 'cash', expectedTotalCents: 550 }));
    expect(res.status).toBe(409);
    // Asserting the MESSAGE, not just the status: an empty payable set also
    // trips the amount-changed branch below, so a status-only assertion
    // passes with this guard removed and pins nothing.
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/nothing outstanding/i);
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  // The ordering that matters: this message also contains the word "voided",
  // which the broader conflict regex below it matches. If the branches were
  // swapped, the admin would be told to reload and try again for a state that
  // retrying cannot fix.
  it('names the reconcile-by-hand failure instead of folding it into a retry', async () => {
    recordSettlement.mockRejectedValue(
      new Error(
        'recordSettlement: settlement s1 was recorded and could NOT be removed after a photo was voided mid-payment — paid and earned will disagree until settlement s1 is reconciled by hand',
      ),
    );
    const res = await POST(postReq({ workerId: 'worker-1', method: 'cash', expectedTotalCents: 550 }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/reconciled by hand/i);
    expect(body.error).toMatch(/settlement s1/);
    expect(body.error).not.toMatch(/try again/i);
    expect(body.error).not.toMatch(/^recordSettlement:/); // no function name at the admin
  });

  it('turns an ordinary race into a 409 telling the admin to reload', async () => {
    recordSettlement.mockRejectedValue(
      new Error('recordSettlement: one of these photos was paid a moment ago, reload the pay screen'),
    );
    const res = await POST(postReq({ workerId: 'worker-1', method: 'cash', expectedTotalCents: 550 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/reload/i);
  });

  it('requires an admin', async () => {
    requireAdmin.mockResolvedValue({ response: new Response('no', { status: 403 }) });
    const res = await POST(postReq({ workerId: 'worker-1', method: 'cash', expectedTotalCents: 550 }));
    expect(res.status).toBe(403);
    expect(recordSettlement).not.toHaveBeenCalled();
  });
});
