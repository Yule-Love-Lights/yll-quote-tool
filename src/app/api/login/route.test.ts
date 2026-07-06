// Tests for POST /api/login (#81 operator auth entry point / W6-004). Must:
// rate-limit before doing anything else (W6-GAP-1), 400 on invalid JSON / missing
// creds, 503 when Supabase isn't configured, return a GENERIC 401 on a failed
// sign-in (no account enumeration — never leak user-not-found vs wrong-password),
// and 200 on success. Rate limit + Supabase mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

const { rateLimitResponseMock, signInWithPassword, createRouteSupabaseMock } = vi.hoisted(() => ({
  rateLimitResponseMock: vi.fn((): unknown => null),
  signInWithPassword: vi.fn(),
  createRouteSupabaseMock: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: rateLimitResponseMock }));
vi.mock('@/lib/auth/supabaseServer', () => ({ createRouteSupabase: createRouteSupabaseMock }));

import { POST } from './route';

function makeReq(body: unknown | (() => unknown)): NextRequest {
  return {
    json: async () => {
      if (typeof body === 'function') return (body as () => unknown)();
      return body;
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitResponseMock.mockReturnValue(null);
  createRouteSupabaseMock.mockResolvedValue({ auth: { signInWithPassword } });
  signInWithPassword.mockResolvedValue({ error: null });
});

describe('POST /api/login', () => {
  it('#81 W6-GAP-1: checks the rate limit BEFORE touching the body or Supabase', async () => {
    const NextResponse = (await import('next/server')).NextResponse;
    const limited = NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    rateLimitResponseMock.mockReturnValueOnce(limited);
    const res = await POST(makeReq({ email: 'a@b.com', password: 'secret' }));
    expect(res.status).toBe(429);
    expect(createRouteSupabaseMock).not.toHaveBeenCalled();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON body', async () => {
    const res = await POST(makeReq(() => { throw new Error('bad json'); }));
    expect(res.status).toBe(400);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('400s when email is missing', async () => {
    const res = await POST(makeReq({ password: 'secret' }));
    expect(res.status).toBe(400);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('400s when password is missing', async () => {
    const res = await POST(makeReq({ email: 'a@b.com' }));
    expect(res.status).toBe(400);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('503s when Supabase auth is not configured', async () => {
    createRouteSupabaseMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ email: 'a@b.com', password: 'secret' }));
    expect(res.status).toBe(503);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('returns a GENERIC 401 on sign-in failure — no account enumeration', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: { message: 'User not found' } });
    const res = await POST(makeReq({ email: 'nobody@x.com', password: 'wrong' }));
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json.error).toBe('Incorrect email or password');
    expect(json.error).not.toMatch(/not found/i);
  });

  it('returns the SAME generic 401 whether the email exists or the password is wrong', async () => {
    signInWithPassword.mockResolvedValueOnce({ error: { message: 'Invalid login credentials' } });
    const res1 = await POST(makeReq({ email: 'exists@x.com', password: 'wrong' }));
    const json1 = await res1.json();

    signInWithPassword.mockResolvedValueOnce({ error: { message: 'User not found' } });
    const res2 = await POST(makeReq({ email: 'ghost@x.com', password: 'whatever' }));
    const json2 = await res2.json();

    expect(res1.status).toBe(res2.status);
    expect(json1.error).toBe(json2.error);
  });

  it('200s and signs in on success', async () => {
    const res = await POST(makeReq({ email: 'a@b.com', password: 'secret' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret' });
  });

  it('trims the email but not the password before sign-in', async () => {
    await POST(makeReq({ email: '  a@b.com  ', password: 'secret' }));
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret' });
  });
});
