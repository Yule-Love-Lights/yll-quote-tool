// The worker's own payment history. Two duties beyond returning the rows:
// it is scoped to the SESSION worker with no id accepted from the request,
// and it REDACTS the fields written for the office before they reach the
// worker's browser.
//
// The redaction is the point of this file. The client type declares only the
// fields the screen renders, which keeps nothing off the wire; a worker who
// opens the network tab sees whatever the route actually sends. That gap is
// invisible to TypeScript, so it needs a test (customer lens, PR #1136).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAdvertisingCaller, getWorkerPayoutSummary, listSettlements } = vi.hoisted(() => ({
  getAdvertisingCaller: vi.fn(),
  getWorkerPayoutSummary: vi.fn(),
  listSettlements: vi.fn(),
}));

vi.mock('@/lib/auth/advertisingAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/advertisingAuth')>();
  return { ...actual, getAdvertisingCaller };
});
vi.mock('@/lib/advertising/payouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/payouts')>();
  return { ...actual, getWorkerPayoutSummary, listSettlements };
});

import { GET } from './route';

/** What the data layer hands back: everything, office fields included. */
function fullSettlement(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    workerId: 'worker-1',
    totalCents: 250,
    method: 'cash' as const,
    note: 'week of the 24th',
    paidAt: '2026-08-30T18:00:00.000Z',
    paidBy: '4649d5a0-a549-4ad0-bdc1-43815fe375f6',
    lineCount: 1,
    createdAt: '2026-08-30T18:00:00.000Z',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingCaller.mockResolvedValue({
    ok: true,
    worker: { id: 'worker-1', displayName: 'Joe Signs', isTest: false },
  });
  getWorkerPayoutSummary.mockResolvedValue({
    workerId: 'worker-1',
    earnedCents: 550,
    settledCents: 250,
    unpaidCents: 300,
    lastPaidAt: '2026-08-30T18:00:00.000Z',
    payableCount: 1,
  });
  listSettlements.mockResolvedValue([fullSettlement()]);
});

describe('GET /api/advertising/settlements', () => {
  it('gives the worker what they need to check a payment', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settlements: Array<Record<string, unknown>> };
    expect(body.settlements[0]).toMatchObject({
      id: 's1',
      totalCents: 250,
      method: 'cash',
      note: 'week of the 24th', // the office knowingly writes this for them
      paidAt: '2026-08-30T18:00:00.000Z',
      lineCount: 1,
      voidedAt: null,
    });
  });

  it('never sends the office-only fields to the worker', async () => {
    listSettlements.mockResolvedValue([
      fullSettlement({
        voidedAt: '2026-08-31T10:00:00.000Z',
        voidedBy: '4649d5a0-a549-4ad0-bdc1-43815fe375f6',
        voidReason: 'looks like he faked this one',
      }),
    ]);

    const res = await GET();
    const raw = await res.text();
    const body = JSON.parse(raw) as { settlements: Array<Record<string, unknown>> };

    // The worker learns the payment was undone, and nothing about why or by
    // whom. Asserted against the RAW body, because the wire is what a worker
    // can actually read.
    expect(body.settlements[0].voidedAt).toBe('2026-08-31T10:00:00.000Z');
    expect(body.settlements[0]).not.toHaveProperty('voidReason');
    expect(body.settlements[0]).not.toHaveProperty('voidedBy');
    expect(body.settlements[0]).not.toHaveProperty('paidBy');
    expect(raw).not.toContain('looks like he faked this one');
    expect(raw).not.toContain('4649d5a0-a549-4ad0-bdc1-43815fe375f6');
  });

  it('is scoped to the session worker, with no id taken from the request', async () => {
    await GET();
    expect(getWorkerPayoutSummary).toHaveBeenCalledWith('worker-1');
    expect(listSettlements).toHaveBeenCalledWith('worker-1');
  });

  it('refuses a caller who is not a signed-in worker', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'no-session' });
    const res = await GET();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(listSettlements).not.toHaveBeenCalled();
  });

  it('says the read failed rather than reporting no payments', async () => {
    // A worker reading "$0 paid" because of a database hiccup would think
    // they had been paid nothing.
    listSettlements.mockRejectedValue(new Error('connection reset'));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/could not load/i);
  });
});
