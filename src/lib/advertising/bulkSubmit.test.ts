// Pins the admin bulk-upload handler in the ONE capture pipeline
// (captureSubmit.ts): photos land instantly ACCEPTED at the campaign's
// current rate (Naldo's ruling for backfilling pre-tool work), GPS is
// optional (camera-roll files may carry none), and the shared intake rules
// (magic bytes, size cap, upload-before-row, orphan cleanup) still hold.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { submitAcceptedPlacement, findAcceptedByPhotoHash, getAdvertisingCampaign, reverseGeocode, computePhotoHash, uploadMock, removeMock } =
  vi.hoisted(() => ({
    submitAcceptedPlacement: vi.fn(),
    findAcceptedByPhotoHash: vi.fn(),
    getAdvertisingCampaign: vi.fn(),
    reverseGeocode: vi.fn(),
    computePhotoHash: vi.fn(),
    uploadMock: vi.fn(),
    removeMock: vi.fn(),
  }));

vi.mock('@/lib/advertising/placements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/advertising/placements')>();
  return { ...actual, submitAcceptedPlacement, findAcceptedByPhotoHash };
});
vi.mock('@/lib/advertising/campaigns', () => ({ getAdvertisingCampaign }));
vi.mock('@/lib/advertising/geocode', () => ({ reverseGeocode }));
vi.mock('@/lib/advertising/photoHashCompute', () => ({ computePhotoHash }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    storage: { from: () => ({ upload: uploadMock, remove: removeMock }) },
  }),
}));

import { handleBulkAcceptedSubmit } from './captureSubmit';

const WORKER = {
  id: 'worker-1',
  displayName: 'Joe Signs',
  authUserId: 'auth-1',
  active: true,
  isTest: false,
  createdAt: 'x',
  updatedAt: 'x',
};

const ADMIN_ID = 'admin-user-9';

function makeForm(overrides: Record<string, string | null> = {}): FormData {
  const fd = new FormData();
  fd.set('campaignId', 'campaign-1');
  fd.set(
    'photo',
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) as unknown as BlobPart], 'roll.jpg', {
      type: 'image/jpeg',
    }),
  );
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdvertisingCampaign.mockResolvedValue({
    id: 'campaign-1', name: 'Fall', kind: 'yard_sign', rateCents: 250, active: true,
  });
  reverseGeocode.mockResolvedValue('12 Main St, Farmingdale, NY');
  uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null });
  computePhotoHash.mockResolvedValue('0f0f0f0f0f0f0f0f');
  findAcceptedByPhotoHash.mockResolvedValue(null);
  submitAcceptedPlacement.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'p1',
    status: 'accepted',
    ...input,
  }));
});

describe('handleBulkAcceptedSubmit', () => {
  it('lands accepted at the campaign rate, reviewed by the admin, kind from the campaign', async () => {
    const res = await handleBulkAcceptedSubmit(makeForm(), WORKER, ADMIN_ID);
    expect(res.status).toBe(201);
    const input = submitAcceptedPlacement.mock.calls[0][0];
    expect(input.workerId).toBe('worker-1');
    expect(input.kind).toBe('yard_sign');
    expect(input.rateCents).toBe(250);
    expect(input.reviewedBy).toBe(ADMIN_ID);
  });

  it('no GPS fields: lat/lng null, and reverse geocoding is never attempted', async () => {
    const res = await handleBulkAcceptedSubmit(makeForm(), WORKER, ADMIN_ID);
    expect(res.status).toBe(201);
    const input = submitAcceptedPlacement.mock.calls[0][0];
    expect(input.lat).toBeNull();
    expect(input.lng).toBeNull();
    expect(reverseGeocode).not.toHaveBeenCalled();
  });

  it('with EXIF GPS: coordinates pass through and get a reverse-geocoded address', async () => {
    const res = await handleBulkAcceptedSubmit(makeForm({ lat: '40.75', lng: '-73.42' }), WORKER, ADMIN_ID);
    expect(res.status).toBe(201);
    const input = submitAcceptedPlacement.mock.calls[0][0];
    expect(input.lat).toBe(40.75);
    expect(input.lng).toBe(-73.42);
    expect(input.suggestedAddress).toBe('12 Main St, Farmingdale, NY');
  });

  it('malformed GPS (one side only, or junk) is refused rather than silently dropped', async () => {
    const res = await handleBulkAcceptedSubmit(makeForm({ lat: '40.75' }), WORKER, ADMIN_ID);
    expect(res.status).toBe(400);
    expect(submitAcceptedPlacement).not.toHaveBeenCalled();
  });

  it('the taken date rides through as capturedAt', async () => {
    await handleBulkAcceptedSubmit(makeForm({ capturedAt: '2026-07-04T15:00:00.000Z' }), WORKER, ADMIN_ID);
    expect(submitAcceptedPlacement.mock.calls[0][0].capturedAt).toBe('2026-07-04T15:00:00.000Z');
  });

  it('an inactive campaign is refused', async () => {
    getAdvertisingCampaign.mockResolvedValue({ id: 'campaign-1', name: 'Old', kind: 'yard_sign', rateCents: 250, active: false });
    const res = await handleBulkAcceptedSubmit(makeForm(), WORKER, ADMIN_ID);
    expect(res.status).toBe(400);
    expect(submitAcceptedPlacement).not.toHaveBeenCalled();
  });

  it('a non-image file is refused by the magic-byte sniff', async () => {
    const fd = makeForm();
    fd.set('photo', new File([new Uint8Array([0x00, 0x01, 0x02, 0x03]) as unknown as BlobPart], 'x.bin'));
    const res = await handleBulkAcceptedSubmit(fd, WORKER, ADMIN_ID);
    expect(res.status).toBe(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('a failed storage upload means nothing is submitted (502)', async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await handleBulkAcceptedSubmit(makeForm(), WORKER, ADMIN_ID);
    expect(res.status).toBe(502);
    expect(submitAcceptedPlacement).not.toHaveBeenCalled();
  });

  it('a failed insert cleans up the orphaned photo (500)', async () => {
    submitAcceptedPlacement.mockRejectedValue(new Error('db down'));
    const res = await handleBulkAcceptedSubmit(makeForm(), WORKER, ADMIN_ID);
    expect(res.status).toBe(500);
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it('a test worker rides is_test through', async () => {
    await handleBulkAcceptedSubmit(makeForm(), { ...WORKER, isTest: true }, ADMIN_ID);
    expect(submitAcceptedPlacement.mock.calls[0][0].isTest).toBe(true);
  });

  it('an exact re-upload is SKIPPED, not paid twice: same hash already accepted for this worker+campaign returns duplicate, no new row, orphan removed', async () => {
    findAcceptedByPhotoHash.mockResolvedValue({ id: 'existing-1', status: 'accepted' });
    const res = await handleBulkAcceptedSubmit(makeForm(), WORKER, ADMIN_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { duplicate?: boolean };
    expect(body.duplicate).toBe(true);
    expect(submitAcceptedPlacement).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it('a photo whose hash could not compute still uploads (dedupe is best-effort, never a blocker)', async () => {
    computePhotoHash.mockResolvedValue(null);
    const res = await handleBulkAcceptedSubmit(makeForm(), WORKER, ADMIN_ID);
    expect(res.status).toBe(201);
    expect(findAcceptedByPhotoHash).not.toHaveBeenCalled();
    expect(submitAcceptedPlacement).toHaveBeenCalledTimes(1);
  });
});
