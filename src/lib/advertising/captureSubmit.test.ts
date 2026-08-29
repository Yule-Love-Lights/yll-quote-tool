// Pins the photo-hash wiring in the ONE capture pipeline: the computed
// perceptual hash rides into submitPlacement, and a failed hash (null)
// never blocks the capture.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { submitPlacement, getAdvertisingCampaign, reverseGeocode, computePhotoHash, uploadMock } =
  vi.hoisted(() => ({
    submitPlacement: vi.fn(),
    getAdvertisingCampaign: vi.fn(),
    reverseGeocode: vi.fn(),
    computePhotoHash: vi.fn(),
    uploadMock: vi.fn(),
  }));

vi.mock('@/lib/advertising/placements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/placements')>();
  return { ...actual, submitPlacement };
});
vi.mock('@/lib/advertising/campaigns', () => ({ getAdvertisingCampaign }));
vi.mock('@/lib/advertising/geocode', () => ({ reverseGeocode }));
vi.mock('@/lib/advertising/photoHashCompute', () => ({ computePhotoHash }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    storage: { from: () => ({ upload: uploadMock, remove: vi.fn() }) },
  }),
}));

import { handleCaptureSubmit } from './captureSubmit';

const WORKER = {
  id: 'worker-1',
  displayName: 'Joe Signs',
  authUserId: 'auth-1',
  active: true,
  isTest: false,
  createdAt: 'x',
  updatedAt: 'x',
};

function makeReq(): NextRequest {
  const fd = new FormData();
  fd.set('campaignId', 'campaign-1');
  fd.set('lat', '40.75');
  fd.set('lng', '-73.42');
  fd.set(
    'photo',
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) as unknown as BlobPart], 'p.jpg', {
      type: 'image/jpeg',
    }),
  );
  return { formData: async () => fd } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingCampaign.mockResolvedValue({
    id: 'campaign-1', name: 'Fall', kind: 'yard_sign', rateCents: 250, active: true,
  });
  reverseGeocode.mockResolvedValue(null);
  uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null });
  computePhotoHash.mockResolvedValue('0f0f0f0f0f0f0f0f');
  submitPlacement.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'p1', ...input }));
});

describe('capture photo hashing', () => {
  it('stamps the computed hash onto the placement', async () => {
    const res = await handleCaptureSubmit(makeReq(), WORKER);
    expect(res.status).toBe(201);
    expect(computePhotoHash).toHaveBeenCalledTimes(1);
    expect(submitPlacement.mock.calls[0][0].photoHash).toBe('0f0f0f0f0f0f0f0f');
  });

  it('a failed hash never blocks the capture — it submits with photoHash null', async () => {
    computePhotoHash.mockResolvedValue(null);
    const res = await handleCaptureSubmit(makeReq(), WORKER);
    expect(res.status).toBe(201);
    expect(submitPlacement.mock.calls[0][0].photoHash).toBeNull();
  });
});
