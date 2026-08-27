// #110 W2-023: PHOTO_ID_RE reimplemented a weak /^(base|[0-9a-f-]{36})$/i
// fragment (accepts e.g. 36 dashes as a "uuid"). Tighten the UUID half to the
// strict dashed-UUID pattern used elsewhere in the codebase (e.g.
// src/lib/portal/loader.ts, src/lib/dashboard/inbox/validate.ts), keeping
// 'base' accepted. lib/designs.ts is owned by a sibling agent in this audit
// wave — not imported from or edited here; the tightened pattern is local to
// this route only.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const { removeDesignExtraPhoto, updateDesignExtraPhotoTitle, updateDesignPhotoTitle, refuseIfFrozen } = vi.hoisted(() => ({
  // Row 367/427: the shared pre-flight refusal. Mocked here (rather than
  // mocking Supabase) so these tests stay about the ROUTE's ordering
  // guarantee: a frozen or unverifiable design must be refused before ANY of
  // the three writes a delete performs (storage object, extra_photos, scene
  // prune).
  refuseIfFrozen: vi.fn(async (): Promise<unknown> => null),
  removeDesignExtraPhoto: vi.fn(
    // Row 371: `version` is the post-prune CAS version the route hands back.
    async (): Promise<{
      ok: boolean;
      prunedMiniGroups: { surface: string | null; stringCount: number }[];
      version: number | null;
      // Row 367: set when the scene prune did not happen, and why.
      sceneNotPruned?: 'locked' | 'unverified';
    }> => ({
      ok: true,
      prunedMiniGroups: [],
      version: null,
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

vi.mock('@/lib/design/sceneFreeze', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/design/sceneFreeze')>()),
  refuseIfFrozen,
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
  removeDesignExtraPhoto.mockResolvedValue({ ok: true, prunedMiniGroups: [], version: null });
  updateDesignExtraPhotoTitle.mockResolvedValue(true);
  updateDesignPhotoTitle.mockResolvedValue(true);
  refuseIfFrozen.mockResolvedValue(null);
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
// Row 371 fix round: the route must also hand back the version the prune
// wrote. The editor learns a new version ONLY from its own save response, so
// without this a delete of an inactive tab left the still-mounted editor a
// version behind and its next save died on the CAS ("Save blocked — reload"),
// taking an unrelated in-progress edit with it.
describe('DELETE — reports the post-prune version (row 371)', () => {
  it('passes the version through so the client can adopt it', async () => {
    removeDesignExtraPhoto.mockResolvedValue({ ok: true, prunedMiniGroups: [], version: 7 });
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(7);
  });

  it('passes null through when the delete wrote no scene change', async () => {
    removeDesignExtraPhoto.mockResolvedValue({ ok: true, prunedMiniGroups: [], version: null });
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect((await res.json()).version).toBeNull();
  });
});

describe('DELETE — reports mini groups the photo delete prune orphaned (#741 defect 3)', () => {
  it('passes through a non-empty prunedMiniGroups from removeDesignExtraPhoto', async () => {
    removeDesignExtraPhoto.mockResolvedValue({
      ok: true,
      prunedMiniGroups: [{ surface: 'curtain', stringCount: 6 }],
      version: 7,
    });
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prunedMiniGroups).toEqual([{ surface: 'curtain', stringCount: 6 }]);
  });

  it('404s (not 200 with a stale body) when removeDesignExtraPhoto reports not-ok', async () => {
    removeDesignExtraPhoto.mockResolvedValue({ ok: false, prunedMiniGroups: [], version: null });
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect(res.status).toBe(404);
  });
});

// ── Row 367: the design's post-approval freeze, PRE-FLIGHT on this route ─────
// A delete is three writes (storage object → extra_photos → scene prune) and
// only the last goes through the shared guarded scene writer. Refusing at that
// last step would leave the photo already gone from storage and from the tab
// strip, so these pin the ORDERING: a refusal changes nothing at all.
describe('post-approval freeze (row 367)', () => {
  const ctx = { params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }) };
  const baseCtx = { params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: 'base' }) };

  it('DELETE on a locked design 409s with the shared code and removes NOTHING', async () => {
    refuseIfFrozen.mockResolvedValue(NextResponse.json({ error: 'locked', code: 'design-locked' }, { status: 409 }));
    const res = await DELETE(makeReq(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('design-locked');
    expect(removeDesignExtraPhoto).not.toHaveBeenCalled();
  });

  it('PATCH (rename) on a locked design 409s and renames NOTHING', async () => {
    refuseIfFrozen.mockResolvedValue(NextResponse.json({ error: 'locked', code: 'design-locked' }, { status: 409 }));
    const res = await PATCH(makeReq({ title: 'Left side' }), baseCtx);
    expect(res.status).toBe(409);
    expect(updateDesignPhotoTitle).not.toHaveBeenCalled();
    expect(updateDesignExtraPhotoTitle).not.toHaveBeenCalled();
  });

  it('an unverifiable freeze read is a retryable 500, and still removes NOTHING', async () => {
    // Neither direction is safe to guess: writing anyway is the drift row 367
    // closes, and a 409 would tell staff a live quote is approved.
    refuseIfFrozen.mockResolvedValue(NextResponse.json({ error: 'unverified' }, { status: 500 }));
    const res = await DELETE(makeReq(), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBeUndefined();
    expect(removeDesignExtraPhoto).not.toHaveBeenCalled();
  });

  it('lets both verbs through on an unlocked design', async () => {
    expect((await DELETE(makeReq(), ctx)).status).toBe(200);
    expect(removeDesignExtraPhoto).toHaveBeenCalledTimes(1);
    expect((await PATCH(makeReq({ title: 'Front' }), baseCtx)).status).toBe(200);
    expect(updateDesignPhotoTitle).toHaveBeenCalledTimes(1);
  });
});

// Row 367 delta-verify HIGH: the mid-request freeze race. The photo is gone,
// its scene items are not — the route must SAY so rather than answer a clean
// success (the client alerts staff on this flag; a silent 200 would leave
// invisible items still billing).
describe('DELETE — surfaces a scene prune blocked by the freeze (row 367)', () => {
  it("passes sceneNotPruned:'locked' through on the 200", async () => {
    removeDesignExtraPhoto.mockResolvedValueOnce({
      ok: true,
      prunedMiniGroups: [],
      version: null,
      sceneNotPruned: 'locked' as const,
    });
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).sceneNotPruned).toBe('locked');
  });

  it("passes sceneNotPruned:'unverified' through too", async () => {
    // Delta-verify round 2 MED: the unverified cause must reach staff as well,
    // not be folded into the pre-existing silent path.
    removeDesignExtraPhoto.mockResolvedValueOnce({
      ok: true,
      prunedMiniGroups: [],
      version: null,
      sceneNotPruned: 'unverified' as const,
    });
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect((await res.json()).sceneNotPruned).toBe('unverified');
  });

  it('omits the flag entirely on an ordinary delete', async () => {
    const res = await DELETE(makeReq(), {
      params: Promise.resolve({ id: VALID_DESIGN_ID, photoId: VALID_PHOTO_ID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).sceneNotPruned).toBeUndefined();
  });
});
