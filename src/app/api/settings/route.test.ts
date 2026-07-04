// Audit fix (#85): PUT /api/settings must validate colors/defaults/render at the
// boundary and 400 on bad input — putAppSettings silently skips a malformed key
// and still returns 200, so a bad palette would look saved while keeping the old
// values. We mock putAppSettings (so a 200 path doesn't touch Supabase) but keep
// the REAL validators (normalizeColors / sanitizeRender / isPlainObject), which is
// exactly what the route now calls before persisting.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_APP_SETTINGS } from '@/lib/appSettings';

const { putSpy } = vi.hoisted(() => ({
  putSpy: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  // #101: the swatches validation path reads the live palette via getAppSettings;
  // no client → getAppSettings returns DEFAULT_APP_SETTINGS (built-in palette).
  getSupabaseServiceClient: () => null,
}));

vi.mock('@/lib/appSettings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/appSettings')>('@/lib/appSettings');
  return { ...actual, putAppSettings: putSpy };
});

import { PUT } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const red = { id: 'red', label: 'Red', hex: '#ff0000', glow: '#ff8888' };

beforeEach(() => {
  putSpy.mockClear();
});

describe('PUT /api/settings — boundary validation (#85)', () => {
  it('400s on an invalid hex and never calls putAppSettings', async () => {
    const res = await PUT(makeReq({ colors: [{ ...red, hex: 'nope' }] }));
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('400s on an empty colors array', async () => {
    const res = await PUT(makeReq({ colors: [] }));
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('400s when defaults is not a plain object', async () => {
    const res = await PUT(makeReq({ defaults: [1, 2, 3] }));
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('400s when render has no recognized fields', async () => {
    const res = await PUT(makeReq({ render: { bogus: 1 } }));
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('persists a valid palette (200, putAppSettings called)', async () => {
    const res = await PUT(makeReq({ colors: [red] }));
    expect(res.status).toBe(200);
    expect(putSpy).toHaveBeenCalledOnce();
  });

  it('still 400s when nothing is provided', async () => {
    const res = await PUT(makeReq({}));
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('persists a valid swatches patch (#101)', async () => {
    const res = await PUT(
      makeReq({ swatches: { schemes: [{ id: 'as-designed', label: 'x', colorIds: null }], buildableColorIds: ['red'] } }),
    );
    expect(res.status).toBe(200);
    expect(putSpy).toHaveBeenCalledOnce();
  });

  it('400s on a swatches patch with no recognized fields (#101)', async () => {
    const res = await PUT(makeReq({ swatches: { schemes: 'nope', buildableColorIds: 'nope' } }));
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  // Permanent warranty copy (#88 P6b-2) — the boundary validation.
  it('persists a valid warranty patch (200, putAppSettings called)', async () => {
    const res = await PUT(makeReq({ permanentWarranty: { heading: 'Rock solid.' } }));
    expect(res.status).toBe(200);
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('400s on a version-only warranty patch (no editable field, version is server-managed)', async () => {
    const res = await PUT(makeReq({ permanentWarranty: { version: 99 } }));
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('400s (GAP 5 foot-gun guard) when the heading is blanked', async () => {
    const res = await PUT(makeReq({ permanentWarranty: { heading: '   ' } }));
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('400s (GAP 5) when every bullet is blank', async () => {
    const res = await PUT(
      makeReq({ permanentWarranty: { heading: 'ok', bullets: ['', '  ', ''] } }),
    );
    expect(res.status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('allows individual blank bullet slots as long as one is non-blank', async () => {
    const res = await PUT(
      makeReq({ permanentWarranty: { heading: 'ok', bullets: ['kept', '', ''] } }),
    );
    expect(res.status).toBe(200);
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  // keep the import referenced so tsc/lint don't flag it
  it('exposes factory defaults', () => {
    expect(DEFAULT_APP_SETTINGS.colors.length).toBeGreaterThan(0);
  });
});
