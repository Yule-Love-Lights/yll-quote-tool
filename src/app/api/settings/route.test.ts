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

  // keep the import referenced so tsc/lint don't flag it
  it('exposes factory defaults', () => {
    expect(DEFAULT_APP_SETTINGS.colors.length).toBeGreaterThan(0);
  });
});
