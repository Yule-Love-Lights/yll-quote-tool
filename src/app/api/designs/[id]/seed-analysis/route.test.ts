// #255: re-analyze is the ONE seed site that calls pruneOrphanedMiniGroups with
// no notice at all (editor.ts's own strand-removal call sites all wrap it in
// pruneOrphanedMiniGroupsNotify; this route runs server-side and the caller
// remounts the editor around it, so that toast machinery never gets a chance
// to fire). Prove the route reports which miniGroup(s) got orphaned by diffing
// the design's miniGroups before vs. after seedSceneFromAnalysis, so the
// builder can surface a real warning instead of a quote total that silently
// dropped a billed line.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { DesignRow, UpdateSceneOutcome } from '@/lib/designs';
import type { MiniGroupItem, StrandItem } from '@/lib/design/sceneTypes';

const { getDesign, updateDesignSceneGuarded } = vi.hoisted(() => ({
  getDesign: vi.fn(),
  updateDesignSceneGuarded: vi.fn(async (): Promise<UpdateSceneOutcome> => ({ ok: true, version: 2 })),
}));

vi.mock('@/lib/designs', () => ({
  getDesign,
  updateDesignSceneGuarded,
  isValidDesignId: (id: unknown) =>
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  EMPTY_SCENE: { yardsticks: [], items: [] },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
}));

import { POST } from './route';

const VALID_DESIGN_ID = '11111111-1111-1111-1111-111111111111';
const W = 1000;
const H = 800;

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

// A minimal, sanitizeAnalysisSeed-valid detection — enough to reach the
// pruneOrphanedMiniGroups call in seedSceneFromAnalysis on every test below.
const MINI_DETECTION_SEED = {
  detections: { miniLights: [{ type: 'bush', wrapStyle: 'canopy', stringCount: 1, box: [0.4, 0.4, 0.2, 0.2] }] },
};

function mkStrand(over: Partial<StrandItem> = {}): StrandItem {
  return {
    id: 'seed-mini-1', yardstickId: null, kind: 'strand', bulbType: 'mini', spacingIn: 6,
    drawingStyle: 'strand', colorPattern: ['warm'], points: [10, 10, 20, 10],
    ...over,
  };
}
function mkGroup(over: Partial<MiniGroupItem> = {}): MiniGroupItem {
  return { id: 'g1', yardstickId: null, kind: 'miniGroup', memberIds: [], surface: 'railing', stringCount: 3, ...over };
}

function baseRow(scene: DesignRow['scene']): DesignRow {
  return {
    id: VALID_DESIGN_ID,
    quote_id: null,
    scene,
    photo_path: 'p',
    photo_w: W,
    photo_h: H,
    satellite_path: null,
    satellite_w: null,
    satellite_h: null,
    satellite_feet_per_pixel: null,
    satellite_lines: null,
    extra_photos: null,
    photo_title: null,
    version: 1,
  } as unknown as DesignRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateDesignSceneGuarded.mockResolvedValue({ ok: true, version: 2 });
});

describe('POST /api/designs/[id]/seed-analysis — pruned mini-group reporting (#255)', () => {
  it('reports a miniGroup orphaned when re-analyze drops its last member strand', async () => {
    // g1's only member is seed-mini-2 (a THIRD stale detection from a prior
    // re-analyze); this re-analyze's MINI_DETECTION_SEED has exactly one
    // detection, so detectionItems only ever regenerates seed-mini-1 — the
    // seed-mini-2 id is never reproduced (#240: it also can't be reattached
    // as a scattershot for the same reason — nothing fresh carries that id),
    // so g1 genuinely loses its only member and gets pruned.
    const before = {
      yardsticks: [],
      items: [mkStrand({ id: 'seed-mini-2' }), mkGroup({ id: 'g1', memberIds: ['seed-mini-2'] })],
    };
    getDesign.mockResolvedValue(baseRow(before));

    const res = await POST(
      makeReq({ seed: MINI_DETECTION_SEED }),
      { params: Promise.resolve({ id: VALID_DESIGN_ID }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prunedMiniGroups).toEqual([{ surface: 'railing', stringCount: 3 }]);
  });

  it('reports nothing when no miniGroup is orphaned', async () => {
    const before = { yardsticks: [], items: [] };
    getDesign.mockResolvedValue(baseRow(before));

    const res = await POST(
      makeReq({ seed: MINI_DETECTION_SEED }),
      { params: Promise.resolve({ id: VALID_DESIGN_ID }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prunedMiniGroups).toEqual([]);
  });

  it('keeps a miniGroup that still has a surviving member (not reported as pruned)', async () => {
    const before = {
      yardsticks: [],
      items: [
        mkStrand({ id: 'staff-strand', bulbType: 'mini' }), // staff-drawn, non-seed id — always survives
        mkGroup({ id: 'g1', memberIds: ['staff-strand', 'seed-mini-1'] }),
      ],
    };
    getDesign.mockResolvedValue(baseRow(before));

    const res = await POST(
      makeReq({ seed: MINI_DETECTION_SEED }),
      { params: Promise.resolve({ id: VALID_DESIGN_ID }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prunedMiniGroups).toEqual([]);
  });

  it('reports multiple pruned groups by one re-analyze', async () => {
    const before = {
      yardsticks: [],
      items: [
        mkGroup({ id: 'g1', memberIds: ['gone-1'], surface: 'railing', stringCount: 3 }),
        mkGroup({ id: 'g2', memberIds: ['gone-2'], surface: 'curtain', stringCount: 1 }),
      ],
    };
    getDesign.mockResolvedValue(baseRow(before));

    const res = await POST(
      makeReq({ seed: MINI_DETECTION_SEED }),
      { params: Promise.resolve({ id: VALID_DESIGN_ID }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prunedMiniGroups).toEqual(
      expect.arrayContaining([
        { surface: 'railing', stringCount: 3 },
        { surface: 'curtain', stringCount: 1 },
      ]),
    );
    expect(data.prunedMiniGroups).toHaveLength(2);
  });
});

// Ledger row 260: this route's write goes through the version this SAME call
// already read via getDesign() — not a bare overwrite — and a lost race comes
// back as a distinguishable 409, not a generic 500.
describe('POST /api/designs/[id]/seed-analysis — scene compare-and-swap (ledger row 260)', () => {
  it('CAS-writes with the version this call read', async () => {
    const before = { yardsticks: [], items: [] };
    getDesign.mockResolvedValue(baseRow(before));

    const res = await POST(
      makeReq({ seed: MINI_DETECTION_SEED }),
      { params: Promise.resolve({ id: VALID_DESIGN_ID }) },
    );
    expect(res.status).toBe(200);
    expect(updateDesignSceneGuarded).toHaveBeenCalledWith(VALID_DESIGN_ID, expect.anything(), 1);
  });

  it('409s a scene conflict instead of silently overwriting', async () => {
    const before = { yardsticks: [], items: [] };
    getDesign.mockResolvedValue(baseRow(before));
    updateDesignSceneGuarded.mockResolvedValueOnce({ ok: false, reason: 'conflict' });

    const res = await POST(
      makeReq({ seed: MINI_DETECTION_SEED }),
      { params: Promise.resolve({ id: VALID_DESIGN_ID }) },
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.conflict).toBe(true);
  });
});
