import { describe, it, expect, vi, beforeEach } from 'vitest';

// Audit fix (#22): the upload helpers must reject an oversized decoded buffer
// BEFORE sharp() ever touches it. We mock the supabase service client so
// getSb() returns truthy (otherwise the functions short-circuit on
// "not configured"), and mock sharp so we can assert it is never invoked on
// the oversized path.

const { sharpMock } = vi.hoisted(() => ({
  sharpMock: vi.fn(() => ({
    metadata: vi.fn(async () => ({ width: 1, height: 1 })),
    jpeg: vi.fn(() => ({ toBuffer: vi.fn(async () => Buffer.alloc(0)) })),
  })),
}));

vi.mock('sharp', () => ({ default: sharpMock }));

vi.mock('./supabase', () => ({
  // A truthy stub is enough — the size guard runs before any storage/DB call.
  getSupabaseServiceClient: () => ({}),
}));

import { uploadDesignPhoto, uploadDesignSatellite } from './designs';

// 11MB of raw bytes → base64 of an over-the-cap image.
const oversizedBase64 = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');

describe('design upload size cap (audit #22)', () => {
  beforeEach(() => {
    sharpMock.mockClear();
  });

  it('uploadDesignPhoto rejects a >10MB image before sharp runs', async () => {
    await expect(
      uploadDesignPhoto('11111111-1111-1111-1111-111111111111', oversizedBase64, 'image/jpeg'),
    ).rejects.toThrow(/too large/i);
    expect(sharpMock).not.toHaveBeenCalled();
  });

  it('uploadDesignSatellite rejects a >10MB image before sharp runs', async () => {
    await expect(
      uploadDesignSatellite('11111111-1111-1111-1111-111111111111', oversizedBase64, 'image/jpeg', null),
    ).rejects.toThrow(/too large/i);
    expect(sharpMock).not.toHaveBeenCalled();
  });
});
