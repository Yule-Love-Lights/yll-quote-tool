// #110 W2-023: PHOTO_ID_RE reimplemented a weak /^(base|[0-9a-f-]{36})$/i
// fragment (accepts e.g. 36 dashes as a "uuid"). Tighten the UUID half to the
// strict dashed-UUID pattern used elsewhere in the codebase (e.g.
// src/lib/portal/loader.ts, src/lib/dashboard/inbox/validate.ts), keeping
// 'base' accepted. lib/designs.ts is owned by a sibling agent in this audit
// wave — not imported from or edited here; the tightened pattern is local to
// this route only.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { removeDesignExtraPhoto, updateDesignExtraPhotoTitle, updateDesignPhotoTitle } = vi.hoisted(() => ({
  removeDesignExtraPhoto: vi.fn(
    async (): Promise<{ ok: boolean; prunedMiniGroups: { surface: string | null; stringCount: number }[] }> => ({
      ok: true,
      prunedMiniGroups: [],
    }),
  ),
  updateDesignExtraPhotoTitle: vi.fn(async () => true),
  updateDesignPhotoTitle: vi.fn(async () => true),
}));

vi.mock('@/lib/designs', () => ({
  removeDesignExtraPhoto,
  updateDesignExtraPhotoTitle,
  updateDesignPhotoTitle,
  isValidDesignId: (id: unknown) =>
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
}));

import { PATCH, DELETE } from './route';

const VALID_DESIGN_ID = '11111111-1111-1111-1111-111111111111';
const VALID_PHOTO_ID = '22222222-2222-2222-2222-222222222222';
const MALFORMED_36_DASHES = '-'.repeat(36); // matches the OLD weak regex, not a real UUID

function makeReq(body: unknown = {}): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  removeDesignExtraPhoto.mockResolvedValue({ ok: true, prunedMiniGroups: [] });
  updateDesignExtraPhotoTitle.mockResolvedValue(true);
  updateDesignPhotoTitle.mockResolvedValue(true);
});

describe('photoId validation — tightened UUID (#110 W2-023)', () => {
  it('accepts "base" for PATCH', async () => {
    const res = await PATCH(makeReq({ title: 'Front' }), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: 'base' }),
    });
    expect(res.status).toBe(200);
    expect(updateDesignPhotoTitle).toHaveBeenCalled();
  });

  it('accepts a strict dashed UUID for DELETE', async () => {
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect(res.status).toBe(200);
    expect(removeDesignExtraPhoto).toHaveBeenCalledWith(VALID_DESIGN_ID, VALID_PHOTO_ID);
  });

  it('400s a malformed 36-dash id that the old weak regex would have accepted', async () => {
    const res = await PATCH(makeReq({ title: 'x' }), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: MALFORMED_36_DASHES }),
    });
    expect(res.status).toBe(400);
    expect(updateDesignExtraPhotoTitle).not.toHaveBeenCalled();
  });
});

// #741 defect 3: removeDesignExtraPhoto's prune of a photo's last-surviving
// mini group used to be entirely silent — the route now passes its report
// straight through so the caller (DesignEditor → QuoteBuilder) can warn staff
// the same way the #255 seed-analysis route already does.
describe('DELETE — reports mini groups the photo delete prune orphaned (#741 defect 3)', () => {
  it('passes through a non-empty prunedMiniGroups from removeDesignExtraPhoto', async () => {
    removeDesignExtraPhoto.mockResolvedValue({
      ok: true,
      prunedMiniGroups: [{ surface: 'curtain', stringCount: 6 }],
    });
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prunedMiniGroups).toEqual([{ surface: 'curtain', stringCount: 6 }]);
  });

  it('404s (not 200 with a stale body) when removeDesignExtraPhoto reports not-ok', async () => {
    removeDesignExtraPhoto.mockResolvedValue({ ok: false, prunedMiniGroups: [] });
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect(res.status).toBe(404);
  });
});
