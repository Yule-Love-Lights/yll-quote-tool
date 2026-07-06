// #110 W6-017: self-service GET/PUT /api/account/hotkeys had no test, unlike
// its sibling account/password route on the identical auth pattern
// (getOperator + createRouteSupabase → auth.updateUser).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

const { getOperator, getUser, updateUser } = vi.hoisted(() => ({
  getOperator: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  getOperator,
  createRouteSupabase: async () => ({ auth: { getUser, updateUser } }),
}));

import { GET, PUT } from './route';

const makeReq = (body: unknown) => ({ json: async () => body } as unknown as NextRequest);

beforeEach(() => {
  vi.clearAllMocks();
  getOperator.mockResolvedValue({ id: 'u1', email: 'o@x.com', role: 'operator' });
  getUser.mockResolvedValue({ data: { user: { user_metadata: {} } }, error: null });
  updateUser.mockResolvedValue({ data: {}, error: null });
});

describe('GET /api/account/hotkeys', () => {
  it('401s when nobody is logged in', async () => {
    getOperator.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('401s when the session lookup fails', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns the normalized keymap with defaults filled', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hotkeys).toBeTruthy();
    expect(typeof json.hotkeys).toBe('object');
  });

  it('reflects stored hotkeys merged with defaults', async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { user_metadata: { hotkeys: {} } } },
      error: null,
    });
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/account/hotkeys', () => {
  it('401s when nobody is logged in (no update)', async () => {
    getOperator.mockResolvedValueOnce(null);
    const res = await PUT(makeReq({ hotkeys: {} }));
    expect(res.status).toBe(401);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('400s invalid JSON', async () => {
    const req = { json: async () => { throw new Error('bad'); } } as unknown as NextRequest;
    const res = await PUT(req);
    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('400s a non-object hotkeys payload', async () => {
    const res = await PUT(makeReq({ hotkeys: 'nope' }));
    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('400s a missing hotkeys field', async () => {
    const res = await PUT(makeReq({}));
    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('sanitizes and merges via auth.updateUser, returning the normalized keymap', async () => {
    const res = await PUT(makeReq({ hotkeys: { unknownAction: [{ key: 'x' }] } }));
    expect(res.status).toBe(200);
    expect(updateUser).toHaveBeenCalledOnce();
    const [[arg]] = updateUser.mock.calls;
    expect(arg.data.hotkeys).toBeTruthy();
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.hotkeys).toEqual(arg.data.hotkeys);
  });

  it('surfaces a Supabase update error as 400', async () => {
    updateUser.mockResolvedValueOnce({ data: {}, error: { message: 'failed' } });
    const res = await PUT(makeReq({ hotkeys: {} }));
    expect(res.status).toBe(400);
  });
});
