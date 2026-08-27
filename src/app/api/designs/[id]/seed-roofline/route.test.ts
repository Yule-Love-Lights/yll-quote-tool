// Row 367 delta-verify LOW: this route had NO test file at all, so its share of
// row 367's outcome mapping (and its pre-existing CAS-conflict mapping) shipped
// with zero regression cover, unlike its sibling seed-analysis. These pin the
// three answers a caller can get back from the shared scene writer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { getDesign, updateDesignSceneGuarded } = vi.hoisted(() => ({
  getDesign: vi.fn(),
  updateDesignSceneGuarded: vi.fn(),
}));

vi.mock('@/lib/designs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/designs')>()),
  getDesign,
  updateDesignSceneGuarded,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
}));

import { POST } from './route';

const VALID_DESIGN_ID = '11111111-1111-1111-1111-111111111111';
const ctx = { params: Promise.resolve({ id: VALID_DESIGN_ID }) };

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

// One real roofline polyline, so sanitizeSeedLines/seedLinesHaveContent pass
// and the request actually reaches the scene write.
const BODY = { seedLines: { santas: [[[0.1, 0.1], [0.9, 0.1]]] } };

beforeEach(() => {
  vi.clearAllMocks();
  getDesign.mockResolvedValue({
    id: VALID_DESIGN_ID,
    scene: { yardsticks: [], items: [] },
    photo_w: 1000,
    photo_h: 800,
    version: 3,
  });
  updateDesignSceneGuarded.mockResolvedValue({ ok: true, version: 4 });
});

describe('POST /api/designs/[id]/seed-roofline — scene-write outcome mapping', () => {
  it('200s on a normal seed', async () => {
    const res = await POST(makeReq(BODY), ctx);
    expect(res.status).toBe(200);
    expect(updateDesignSceneGuarded).toHaveBeenCalledTimes(1);
  });

  it('maps a locked write to a 409 carrying the shared design-locked code (row 367)', async () => {
    // This route was one of the three bypasses four premerge lenses found: the
    // first cut of row 367 gated only PUT /api/designs/[id], so a re-sync could
    // silently rewrite a signed-off design's rooflines.
    updateDesignSceneGuarded.mockResolvedValueOnce({ ok: false, reason: 'locked' });
    const res = await POST(makeReq(BODY), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('design-locked');
    expect(body.error).toContain('already approved');
  });

  it('maps an unverified freeze read to a retryable 500 with no lock code (row 367)', async () => {
    updateDesignSceneGuarded.mockResolvedValueOnce({ ok: false, reason: 'unverified' });
    const res = await POST(makeReq(BODY), ctx);
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBeUndefined();
  });

  it('still maps a CAS conflict to its own 409 shape, unchanged', async () => {
    // Regression guard on the row-260 contract: a second kind of 409 must not
    // blur the first. `conflict: true` and NO `code`.
    updateDesignSceneGuarded.mockResolvedValueOnce({ ok: false, reason: 'conflict' });
    const res = await POST(makeReq(BODY), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflict).toBe(true);
    expect(body.code).toBeUndefined();
  });
});
