// Worker capture + own-placements API. Auth resolver, data layer, storage and
// geocode are mocked; the route's own gates run for real: identity is FORCED
// from the session (a worker can never submit or list as someone else), the
// proof photo is magic-byte checked and size-capped, and refusals carry the
// right status.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  getAdvertisingCaller,
  submitPlacement,
  listPlacements,
  getAdvertisingCampaign,
  reverseGeocode,
  uploadMock,
  createSignedUrlMock,
} = vi.hoisted(() => ({
  getAdvertisingCaller: vi.fn(),
  submitPlacement: vi.fn(),
  listPlacements: vi.fn(),
  getAdvertisingCampaign: vi.fn(),
  reverseGeocode: vi.fn(),
  uploadMock: vi.fn(),
  createSignedUrlMock: vi.fn(),
}));

vi.mock('@/lib/auth/advertisingAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/advertisingAuth')>();
  return { ...actual, getAdvertisingCaller };
});
vi.mock('@/lib/advertising/placements', () => ({ submitPlacement, listPlacements }));
vi.mock('@/lib/advertising/campaigns', () => ({ getAdvertisingCampaign }));
vi.mock('@/lib/advertising/geocode', () => ({ reverseGeocode }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    storage: {
      from: () => ({ upload: uploadMock, createSignedUrl: createSignedUrlMock }),
    },
  }),
}));

import { GET, POST } from './route';

const CALLER = {
  ok: true,
  worker: { id: 'worker-1', displayName: 'Joe Signs', authUserId: 'auth-1', active: true, isTest: false },
};

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

function photoFile(bytes: Uint8Array = JPEG_BYTES, name = 'sign.jpg', type = 'image/jpeg'): File {
  return new File([bytes as unknown as BlobPart], name, { type });
}

function makeFormReq(fields: Record<string, string>, photo?: File | null): NextRequest {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (photo) fd.set('photo', photo);
  return { formData: async () => fd } as unknown as NextRequest;
}

function makeGetReq(query: Record<string, string> = {}): NextRequest {
  const url = new URL('https://x.test/api/advertising/placements');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { nextUrl: url } as unknown as NextRequest;
}

const VALID_FIELDS = {
  campaignId: 'campaign-1',
  kind: 'yard_sign',
  lat: '40.75',
  lng: '-73.42',
  accuracyM: '8',
};

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingCaller.mockResolvedValue(CALLER);
  getAdvertisingCampaign.mockResolvedValue({ id: 'campaign-1', name: 'Fall', rateCents: 250, active: true });
  reverseGeocode.mockResolvedValue('12 Main St, Farmingdale, NY');
  uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null });
  createSignedUrlMock.mockResolvedValue({ data: { signedUrl: 'https://signed.example/x' }, error: null });
  submitPlacement.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'placement-1',
    status: 'pending',
    ...input,
  }));
  listPlacements.mockResolvedValue([]);
});

describe('POST /api/advertising/placements — auth', () => {
  it('401s an unauthenticated caller', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    const res = await POST(makeFormReq(VALID_FIELDS, photoFile()));
    expect(res.status).toBe(401);
    expect(submitPlacement).not.toHaveBeenCalled();
  });

  it('403s an operator/admin session — the capture surface is workers only', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'not_advertising' });
    const res = await POST(makeFormReq(VALID_FIELDS, photoFile()));
    expect(res.status).toBe(403);
    expect(submitPlacement).not.toHaveBeenCalled();
  });

  it('403s a deactivated worker', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'inactive' });
    const res = await POST(makeFormReq(VALID_FIELDS, photoFile()));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/advertising/placements — submit', () => {
  it('forces the worker id from the SESSION, ignoring any workerId in the body', async () => {
    const res = await POST(
      makeFormReq({ ...VALID_FIELDS, workerId: 'someone-else' }, photoFile()),
    );
    expect(res.status).toBe(201);
    expect(submitPlacement).toHaveBeenCalledTimes(1);
    expect(submitPlacement.mock.calls[0][0].workerId).toBe('worker-1');
  });

  it('refuses a missing photo', async () => {
    const res = await POST(makeFormReq(VALID_FIELDS, null));
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(submitPlacement).not.toHaveBeenCalled();
  });

  it('refuses a file whose bytes are not an image, whatever its claimed type', async () => {
    const notAnImage = photoFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]), 'fake.jpg');
    const res = await POST(makeFormReq(VALID_FIELDS, notAnImage));
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('refuses an oversized photo before uploading anything', async () => {
    const big = new Uint8Array(13 * 1024 * 1024);
    big.set([0xff, 0xd8, 0xff], 0);
    const res = await POST(makeFormReq(VALID_FIELDS, photoFile(big)));
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown or inactive campaign', async () => {
    getAdvertisingCampaign.mockResolvedValue(null);
    let res = await POST(makeFormReq(VALID_FIELDS, photoFile()));
    expect(res.status).toBe(400);

    getAdvertisingCampaign.mockResolvedValue({ id: 'campaign-1', name: 'Old', rateCents: 250, active: false });
    res = await POST(makeFormReq(VALID_FIELDS, photoFile()));
    expect(res.status).toBe(400);
    expect(submitPlacement).not.toHaveBeenCalled();
  });

  it('refuses bad GPS and a bad kind', async () => {
    let res = await POST(makeFormReq({ ...VALID_FIELDS, lat: 'nope' }, photoFile()));
    expect(res.status).toBe(400);
    res = await POST(makeFormReq({ ...VALID_FIELDS, kind: 'billboard' }, photoFile()));
    expect(res.status).toBe(400);
  });

  it('uploads the proof, reverse-geocodes, and submits with the stored path', async () => {
    const res = await POST(makeFormReq(VALID_FIELDS, photoFile()));
    expect(res.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const input = submitPlacement.mock.calls[0][0];
    expect(String(input.photoPath)).toMatch(/^placements\/worker-1\//);
    expect(input.suggestedAddress).toBe('12 Main St, Farmingdale, NY');
    expect(input.lat).toBe(40.75);
    expect(input.kind).toBe('yard_sign');
  });

  it('still submits when reverse geocoding fails — the address is a convenience, the GPS is the record', async () => {
    reverseGeocode.mockResolvedValue(null);
    const res = await POST(makeFormReq(VALID_FIELDS, photoFile()));
    expect(res.status).toBe(201);
    expect(submitPlacement.mock.calls[0][0].suggestedAddress).toBeNull();
  });

  it('does not submit when the photo upload fails — a pay claim with no proof must not exist', async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: 'bucket unavailable' } });
    const res = await POST(makeFormReq(VALID_FIELDS, photoFile()));
    expect(res.status).toBe(502);
    expect(submitPlacement).not.toHaveBeenCalled();
  });
});

describe('GET /api/advertising/placements', () => {
  it('lists ONLY the session worker, whatever the query says', async () => {
    listPlacements.mockResolvedValue([
      { id: 'p1', workerId: 'worker-1', status: 'rejected', rejectionReason: 'blurry', photoPath: 'placements/worker-1/a.jpg' },
    ]);
    const res = await GET(makeGetReq({ workerId: 'someone-else', status: 'rejected' }));
    expect(res.status).toBe(200);
    expect(listPlacements).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: 'worker-1', status: 'rejected' }),
    );
    const body = await res.json();
    expect(body.placements[0].rejectionReason).toBe('blurry');
  });

  it('401s logged-out and 403s non-advertising sessions', async () => {
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    expect((await GET(makeGetReq())).status).toBe(401);
    getAdvertisingCaller.mockResolvedValue({ ok: false, reason: 'not_advertising' });
    expect((await GET(makeGetReq())).status).toBe(403);
  });
});
