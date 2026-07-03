// #110 W5-003/W5-004: POST /api/references validated only assetType. Two
// distinct problems:
//  - W5-004 (bug): an unvalidated mediaType/base64 is re-injected as a Claude
//    vision image block on EVERY analyze call — a non-image mediaType makes
//    Anthropic reject the whole request, taking the analyzer down corpus-wide.
//  - W5-003 (consistency): size/tier/caption were written unvalidated even
//    though they're interpolated raw into the model prompt as a product label;
//    applyItemCorrections (sceneCorrections.ts) already validates the same
//    size/tier families before writing a scene, this route should match.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ReferenceAssetPayload } from '@/lib/referenceAssets';

const { saveReferenceAsset } = vi.hoisted(() => ({
  saveReferenceAsset: vi.fn(async (_payload: ReferenceAssetPayload) => ({ id: 'r1' })),
}));

vi.mock('@/lib/referenceAssets', () => ({
  saveReferenceAsset,
  listReferenceAssets: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: async () => null }));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    assetType: 'wreath',
    size: '30noble',
    base64: 'AAAA',
    mediaType: 'image/jpeg',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveReferenceAsset.mockResolvedValue({ id: 'r1' });
});

describe('POST /api/references — mediaType/base64 validation (#110 W5-004)', () => {
  it('400s a non-image mediaType instead of writing it to the corpus', async () => {
    const res = await POST(makeReq(basePayload({ mediaType: 'application/pdf' })));
    expect(res.status).toBe(400);
    expect(saveReferenceAsset).not.toHaveBeenCalled();
  });

  it('400s a non-string / empty base64', async () => {
    const res = await POST(makeReq(basePayload({ base64: '' })));
    expect(res.status).toBe(400);
    expect(saveReferenceAsset).not.toHaveBeenCalled();
  });

  it('400s base64 that is not well-formed base64', async () => {
    const res = await POST(makeReq(basePayload({ base64: 'not-valid-base64!!! ***' })));
    expect(res.status).toBe(400);
    expect(saveReferenceAsset).not.toHaveBeenCalled();
  });

  it('accepts a well-formed image reference', async () => {
    const res = await POST(makeReq(basePayload()));
    expect(res.status).toBe(200);
    expect(saveReferenceAsset).toHaveBeenCalled();
  });
});

describe('POST /api/references — size/tier/caption validation (#110 W5-003)', () => {
  it('400s a size not in the allowed set for the assetType', async () => {
    const res = await POST(makeReq(basePayload({ assetType: 'wreath', size: '30nobl' })));
    expect(res.status).toBe(400);
    expect(saveReferenceAsset).not.toHaveBeenCalled();
  });

  it('accepts a valid wreath size', async () => {
    const res = await POST(makeReq(basePayload({ assetType: 'wreath', size: '36noble' })));
    expect(res.status).toBe(200);
  });

  it('accepts a valid spritzer size', async () => {
    const res = await POST(makeReq(basePayload({ assetType: 'spritzer', size: '24' })));
    expect(res.status).toBe(200);
  });

  it('accepts a valid garland size', async () => {
    const res = await POST(makeReq(basePayload({ assetType: 'garland', size: '9ft' })));
    expect(res.status).toBe(200);
  });

  it('400s a spritzer size that is actually a wreath size', async () => {
    const res = await POST(makeReq(basePayload({ assetType: 'spritzer', size: '30noble' })));
    expect(res.status).toBe(400);
    expect(saveReferenceAsset).not.toHaveBeenCalled();
  });

  it('400s a tier outside the fixed set', async () => {
    const res = await POST(makeReq(basePayload({ tier: 'ultra-deluxe' })));
    expect(res.status).toBe(400);
    expect(saveReferenceAsset).not.toHaveBeenCalled();
  });

  it('accepts a valid tier and passes it through', async () => {
    const res = await POST(makeReq(basePayload({ tier: 'bow' })));
    expect(res.status).toBe(200);
    const saved = saveReferenceAsset.mock.calls[0][0];
    expect(saved.tier).toBe('bow');
  });

  it('trims and length-caps an oversized caption', async () => {
    const longCaption = 'x'.repeat(1000);
    const res = await POST(makeReq(basePayload({ caption: `  ${longCaption}  ` })));
    expect(res.status).toBe(200);
    const saved = saveReferenceAsset.mock.calls[0][0];
    expect(saved.caption!.length).toBeLessThanOrEqual(300);
  });

  it('omits tier/caption cleanly when absent', async () => {
    const res = await POST(makeReq(basePayload()));
    expect(res.status).toBe(200);
    expect(saveReferenceAsset).toHaveBeenCalled();
  });
});
