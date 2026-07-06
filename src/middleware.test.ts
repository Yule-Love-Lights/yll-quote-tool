// Tests for the perimeter-enforcement wiring in middleware.ts (#81 W6-006).
// operatorGate.test.ts covers isPublicPath()'s classification logic (one input);
// this file covers everything middleware.ts does with that classification:
// the AUTH_GATE_ENABLED dormancy short-circuit, public-path pass-through
// (without touching Supabase), getUser() validation, 401-vs-redirect branching
// (API vs page), fail-closed when Supabase is unconfigured, and returning the
// rotated-cookie `res` (not a fresh NextResponse.next()) on the authed path.
// isPublicPath is real (not mocked); createMiddlewareSupabase is mocked.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { createMiddlewareSupabaseMock } = vi.hoisted(() => ({
  createMiddlewareSupabaseMock: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  createMiddlewareSupabase: createMiddlewareSupabaseMock,
}));

import { middleware } from './middleware';

function makeReq(pathname: string, method = 'GET'): NextRequest {
  const url = `https://ops.example.com${pathname}`;
  return {
    method,
    nextUrl: {
      pathname,
      clone: () => new URL(url),
    },
    url,
  } as unknown as NextRequest;
}

const ORIGINAL_ENV = process.env.AUTH_GATE_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_GATE_ENABLED = 'true';
});

afterEach(() => {
  process.env.AUTH_GATE_ENABLED = ORIGINAL_ENV;
});

describe('middleware — perimeter enforcement (#81 W6-006)', () => {
  it('dormancy short-circuit: gate disabled -> always next(), never touches Supabase', async () => {
    process.env.AUTH_GATE_ENABLED = 'false';
    const res = await middleware(makeReq('/admin/quotes'));
    expect(res.status).toBe(200); // NextResponse.next() default
    expect(createMiddlewareSupabaseMock).not.toHaveBeenCalled();
  });

  it('gate enabled, dormancy value not exactly "true" -> also passes through (no-op)', async () => {
    process.env.AUTH_GATE_ENABLED = undefined as unknown as string;
    delete process.env.AUTH_GATE_ENABLED;
    const res = await middleware(makeReq('/admin/quotes'));
    expect(res.status).toBe(200);
    expect(createMiddlewareSupabaseMock).not.toHaveBeenCalled();
  });

  it('gate enabled + public path -> next() WITHOUT calling Supabase', async () => {
    const res = await middleware(makeReq('/portal/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60'));
    expect(res.status).toBe(200);
    expect(createMiddlewareSupabaseMock).not.toHaveBeenCalled();
  });

  it('gate enabled + unauth + /api path -> 401 JSON (not a redirect)', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await middleware(makeReq('/api/quotes'));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Unauthorized');
  });

  it('gate enabled + unauth + page path -> redirect to /login?from=<path>', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await middleware(makeReq('/admin/quotes'));
    expect(res.status).toBe(307); // NextResponse.redirect default
    const location = res.headers.get('location');
    expect(location).toContain('/login');
    expect(location).toContain('from=%2Fadmin%2Fquotes');
  });

  it('gate enabled + authed -> returns the `res` object carrying rotated cookies, not a fresh next()', async () => {
    const rotatedRes = NextResponse.next();
    rotatedRes.cookies.set('sb-session', 'rotated-token-value');
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } },
      res: rotatedRes,
    });
    const res = await middleware(makeReq('/admin/quotes'));
    expect(res).toBe(rotatedRes);
    expect(res.cookies.get('sb-session')?.value).toBe('rotated-token-value');
  });

  it('fails closed when Supabase is unconfigured (supabase null) on an /api path -> 401, never next()', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({ supabase: null, res: NextResponse.next() });
    const res = await middleware(makeReq('/api/quotes'));
    expect(res.status).toBe(401);
  });

  it('fails closed when Supabase is unconfigured on a page path -> redirect to /login, never next()', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({ supabase: null, res: NextResponse.next() });
    const res = await middleware(makeReq('/admin/quotes'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});
