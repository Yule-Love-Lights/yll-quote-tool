// Admin review — the door that moves money. requireAdmin gates it (only
// Naldo/Jason accept or reject; an office operator gets 403, and an
// advertising session never reaches this path at the perimeter). Accept
// stamps through the data layer's CAS; this route's own duties are: actor =
// the ADMIN session (never the body), reasons required on reject, and bulk
// accept isolating per-id failures instead of failing the batch.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const {
  requireAdmin,
  listPlacements,
  acceptPlacement,
  rejectPlacement,
  voidPlacement,
  listAdvertisingWorkers,
  listAdvertisingCampaigns,
  createSignedUrlMock,
} = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listPlacements: vi.fn(),
  acceptPlacement: vi.fn(),
  rejectPlacement: vi.fn(),
  voidPlacement: vi.fn(),
  listAdvertisingWorkers: vi.fn(),
  listAdvertisingCampaigns: vi.fn(),
  createSignedUrlMock: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, requireAdmin };
});
vi.mock('@/lib/advertising/placements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/placements')>();
  return { ...actual, listPlacements, acceptPlacement, rejectPlacement, voidPlacement };
});
vi.mock('@/lib/advertising/workers', () => ({ listAdvertisingWorkers }));
vi.mock('@/lib/advertising/campaigns', () => ({ listAdvertisingCampaigns }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    storage: { from: () => ({ createSignedUrl: createSignedUrlMock }) },
  }),
}));

import { GET, POST } from './route';

const ADMIN = { operator: { id: 'admin-1', email: 'n@x.com', role: 'admin', name: 'Naldo' } };

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function pendingPlacement(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    campaignId: 'campaign-1',
    workerId: 'worker-1',
    kind: 'yard_sign',
    status: 'pending',
    lat: 40.75,
    lng: -73.42,
    accuracyM: 8,
    capturedAt: '2026-08-24T15:00:00.000Z',
    photoPath: `placements/worker-1/${id}.jpg`,
    suggestedAddress: '12 Main St',
    route: null,
    neighborhood: null,
    propertyId: null,
    rejectionReason: null,
    acceptedRateCents: null,
    reviewedBy: null,
    reviewedAt: null,
    isTest: false,
    createdAt: '2026-08-24T15:00:00.000Z',
    updatedAt: '2026-08-24T15:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  listPlacements.mockResolvedValue([]);
  listAdvertisingWorkers.mockResolvedValue([
    { id: 'worker-1', displayName: 'Joe Signs', authUserId: null, active: true, isTest: false },
  ]);
  listAdvertisingCampaigns.mockResolvedValue([
    { id: 'campaign-1', name: 'Fall', rateCents: 250, active: true, notes: null, isTest: false },
  ]);
  createSignedUrlMock.mockResolvedValue({ data: { signedUrl: 'https://signed.example/x' }, error: null });
  acceptPlacement.mockImplementation(async (id: string) =>
    pendingPlacement(id, { status: 'accepted', acceptedRateCents: 250, reviewedBy: 'admin-1' }),
  );
  rejectPlacement.mockImplementation(async (id: string, _by: string, reason: string) =>
    pendingPlacement(id, { status: 'rejected', rejectionReason: reason, reviewedBy: 'admin-1' }),
  );
  voidPlacement.mockImplementation(async (id: string, by: string, reason: string) =>
    pendingPlacement(id, { voidedAt: '2026-08-29T18:00:00.000Z', voidedBy: by, voidReason: reason }),
  );
});

describe('auth', () => {
  it('401/403s straight from requireAdmin — operators never review pay', async () => {
    requireAdmin.mockResolvedValue({
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    });
    expect((await GET()).status).toBe(403);
    expect((await POST(makeReq({ action: 'accept', placementId: 'p1' }))).status).toBe(403);
    expect(acceptPlacement).not.toHaveBeenCalled();
  });
});

describe('GET queue', () => {
  it('returns pending + resubmitted with names, signed photos, and duplicate flags', async () => {
    const a = pendingPlacement('pa');
    const b = pendingPlacement('pb', { status: 'resubmitted', rejectionReason: 'blurry' });
    // near-identical GPS in the same campaign -> duplicate flag
    const near = pendingPlacement('pc', { lat: 40.7503, workerId: 'worker-2' });
    listPlacements.mockImplementation(async (opts?: { status?: string }) => {
      if (opts?.status === 'pending') return [a, near];
      if (opts?.status === 'resubmitted') return [b];
      return [a, b, near];
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queue).toHaveLength(3);
    const first = body.queue.find((q: { id: string }) => q.id === 'pa');
    expect(first.workerName).toBe('Joe Signs');
    expect(first.campaignName).toBe('Fall');
    expect(first.photoUrl).toBe('https://signed.example/x');
    expect(first.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(first.duplicates[0].reasons.join(' ')).toMatch(/m away/);
  });
});

describe('POST accept / reject', () => {
  it('accepts with the ADMIN session as reviewer — the body cannot name one', async () => {
    const res = await POST(makeReq({ action: 'accept', placementId: 'p1', reviewedBy: 'someone-else' }));
    expect(res.status).toBe(200);
    expect(acceptPlacement).toHaveBeenCalledWith('p1', 'admin-1');
  });

  it('requires a reason to reject', async () => {
    const res = await POST(makeReq({ action: 'reject', placementId: 'p1', reason: '   ' }));
    expect(res.status).toBe(400);
    expect(rejectPlacement).not.toHaveBeenCalled();

    const ok = await POST(makeReq({ action: 'reject', placementId: 'p1', reason: 'blurry photo' }));
    expect(ok.status).toBe(200);
    expect(rejectPlacement).toHaveBeenCalledWith('p1', 'admin-1', 'blurry photo');
  });

  it('surfaces a data-layer state refusal as 409, not 500', async () => {
    acceptPlacement.mockRejectedValue(new Error("placement p1 moved to 'rejected' before this accept landed"));
    const res = await POST(makeReq({ action: 'accept', placementId: 'p1' }));
    expect(res.status).toBe(409);
  });

  it('400s an unknown action and a missing placementId', async () => {
    expect((await POST(makeReq({ action: 'destroy', placementId: 'p1' }))).status).toBe(400);
    expect((await POST(makeReq({ action: 'accept' }))).status).toBe(400);
  });
});

describe('POST void', () => {
  it('voids with the ADMIN session as actor and requires a reason', async () => {
    const res = await POST(makeReq({ action: 'void', placementId: 'p1', reason: 'duplicate submission' }));
    expect(res.status).toBe(200);
    expect(voidPlacement).toHaveBeenCalledWith('p1', 'admin-1', 'duplicate submission');

    const bad = await POST(makeReq({ action: 'void', placementId: 'p1', reason: '  ' }));
    expect(bad.status).toBe(400);
    expect(voidPlacement).toHaveBeenCalledTimes(1);
  });
});

describe('POST bulk-accept', () => {
  it('accepts each id with the admin as reviewer and isolates per-id failures', async () => {
    acceptPlacement.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error("placement bad moved to 'rejected' before this accept landed");
      return pendingPlacement(id, { status: 'accepted', acceptedRateCents: 250 });
    });

    const res = await POST(makeReq({ action: 'bulk-accept', placementIds: ['p1', 'bad', 'p2'] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      expect.objectContaining({ id: 'p1', ok: true }),
      expect.objectContaining({ id: 'bad', ok: false }),
      expect.objectContaining({ id: 'p2', ok: true }),
    ]);
    expect(acceptPlacement).toHaveBeenCalledTimes(3);
    expect(acceptPlacement).toHaveBeenNthCalledWith(2, 'bad', 'admin-1');
  });

  it('a RETRIED bulk accept is harmless: the data layer returns the already-accepted rows unchanged', async () => {
    // The idempotency itself is the data layer's CAS (its own tests + probes);
    // this pins that the route treats an already-accepted result as ok, so a
    // double-tapped Accept All reads as success rather than a wall of errors.
    const res1 = await POST(makeReq({ action: 'bulk-accept', placementIds: ['p1', 'p2'] }));
    const res2 = await POST(makeReq({ action: 'bulk-accept', placementIds: ['p1', 'p2'] }));
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it('caps and validates the id list', async () => {
    expect((await POST(makeReq({ action: 'bulk-accept', placementIds: [] }))).status).toBe(400);
    expect((await POST(makeReq({ action: 'bulk-accept', placementIds: 'p1' }))).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => `p${i}`);
    expect((await POST(makeReq({ action: 'bulk-accept', placementIds: tooMany }))).status).toBe(400);
  });
});
