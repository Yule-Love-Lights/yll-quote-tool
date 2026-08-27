// #110 W2-021/W2-022:
//  - W2-022: `analysis` jsonb must be size-bounded like satelliteBase64 is —
//    an arbitrarily large operator-supplied object shouldn't be persisted verbatim.
//  - W2-021: the existence check must not pull the full row (scene/seed_analysis/
//    extra_photos) — no behavior change, existing 404 semantics must still hold.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { setDesignAnalysis, uploadDesignSatellite, singleResult } = vi.hoisted(() => ({
  setDesignAnalysis: vi.fn(async () => true),
  uploadDesignSatellite: vi.fn(async () => ({ path: 'd1/satellite.jpg' })),
  singleResult: { current: { data: { id: 'd1' }, error: null } as { data: unknown; error: unknown } },
}));

vi.mock('@/lib/designs', () => ({
  setDesignAnalysis,
  uploadDesignSatellite,
  isValidDesignId: (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => singleResult.current,
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
}));


// Row 427: every design write route shares ONE post-approval refusal.
const { refuseIfFrozenMock } = vi.hoisted(() => ({
  refuseIfFrozenMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/design/sceneFreeze', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/design/sceneFreeze')>()),
  refuseIfFrozen: refuseIfFrozenMock,
}));

import { POST } from './route';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  refuseIfFrozenMock.mockResolvedValue(null);
  vi.clearAllMocks();
  setDesignAnalysis.mockResolvedValue(true);
  uploadDesignSatellite.mockResolvedValue({ path: 'd1/satellite.jpg' });
  singleResult.current = { data: { id: 'd1' }, error: null };
});

describe('POST /api/designs/[id]/analysis-context — analysis size bound (#110 W2-022)', () => {
  it('400s an oversized analysis object without persisting it', async () => {
    const huge = { blob: 'x'.repeat(600 * 1024) }; // ~600KB, over a "few hundred KB" cap
    const res = await POST(makeReq({ analysis: huge }), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/large/i);
    expect(setDesignAnalysis).not.toHaveBeenCalled();
  });

  it('accepts a normal-sized analysis object', async () => {
    const res = await POST(
      makeReq({ analysis: { rooflines: [{ x: 1, y: 2 }] } }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(res.status).toBe(200);
    expect(setDesignAnalysis).toHaveBeenCalled();
  });
});

describe('POST /api/designs/[id]/analysis-context — narrowed existence check (#110 W2-021)', () => {
  it('still 404s when the design row does not exist (no behavior change)', async () => {
    singleResult.current = { data: null, error: null };
    const res = await POST(
      makeReq({ analysis: { rooflines: [{ x: 1, y: 2 }] } }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
    expect(setDesignAnalysis).not.toHaveBeenCalled();
  });
});

// Row 427: this route swaps the SATELLITE IMAGE the portal renders under the
// customer's roofline trace. It was the one route frozen in this PR without a
// freeze test of its own — flagged by the premerge staff lens, which is exactly
// the kind of gap an untested guard hides in.
describe('POST /api/designs/[id]/analysis-context — post-approval freeze (row 427)', () => {
  it('refuses a frozen design before writing anything', async () => {
    refuseIfFrozenMock.mockResolvedValueOnce(
      NextResponse.json({ error: 'locked', code: 'design-locked' }, { status: 409 }),
    );
    const res = await POST(
      makeReq({ satelliteBase64: 'data:image/jpeg;base64,AAA' }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('design-locked');
  });
});
