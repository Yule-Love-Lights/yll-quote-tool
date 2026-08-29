// Tests for the perimeter-enforcement wiring in proxy.ts (#81 W6-006; renamed
// from middleware.ts for the Next.js 16 proxy convention, #110 W6-013).
// operatorGate.test.ts covers isPublicPath()'s classification logic (one input);
// this file covers everything proxy.ts does with that classification:
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

vi.mock('@/lib/auth/supabaseServer', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/supabaseServer')>('@/lib/auth/supabaseServer');
  return {
    createMiddlewareSupabase: createMiddlewareSupabaseMock,
    // REAL isCrewAccount: it is the security seam the crew tests below exercise,
    // so stubbing it would make them prove nothing.
    isCrewAccount: actual.isCrewAccount,
    CREW_ROLE: actual.CREW_ROLE,
    // REAL isAdvertisingAccount, same reason as isCrewAccount above — it's the
    // seam the advertising tests below exercise.
    isAdvertisingAccount: actual.isAdvertisingAccount,
    ADVERTISING_ROLE: actual.ADVERTISING_ROLE,
    // REAL authGateEngaged (ledger #347): it's a pure process.env.AUTH_GATE_ENABLED
    // read, and every test below manipulates that env var directly to drive it —
    // stubbing it would make those tests prove nothing.
    authGateEngaged: actual.authGateEngaged,
  };
});

import { proxy } from './proxy';

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

describe('proxy — perimeter enforcement (#81 W6-006)', () => {
  it('dormancy short-circuit: gate explicitly opted out (AUTH_GATE_ENABLED=false) -> always next(), never touches Supabase', async () => {
    process.env.AUTH_GATE_ENABLED = 'false';
    const res = await proxy(makeReq('/admin/quotes'));
    expect(res.status).toBe(200); // NextResponse.next() default
    expect(createMiddlewareSupabaseMock).not.toHaveBeenCalled();
  });

  // Ledger #347: the flag flipped meaning. It used to be dormant-by-default
  // (engaged only when exactly 'true'); now it's ENGAGED by default, and
  // dormant only on the explicit 'false' opt-out above. Unset must enforce.
  it('gate flag unset -> ENGAGED BY DEFAULT, not a no-op (ledger #347)', async () => {
    process.env.AUTH_GATE_ENABLED = undefined as unknown as string;
    delete process.env.AUTH_GATE_ENABLED;
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await proxy(makeReq('/admin/quotes'));
    expect(res.status).toBe(307); // redirected to /login, not passed through
    expect(createMiddlewareSupabaseMock).toHaveBeenCalled();
  });

  it('gate enabled + public path -> next() WITHOUT calling Supabase', async () => {
    const res = await proxy(makeReq('/portal/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60'));
    expect(res.status).toBe(200);
    expect(createMiddlewareSupabaseMock).not.toHaveBeenCalled();
  });

  it('gate enabled + unauth + /api path -> 401 JSON (not a redirect)', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await proxy(makeReq('/api/quotes'));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Unauthorized');
  });

  it('gate enabled + unauth + page path -> redirect to /login?from=<path>', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await proxy(makeReq('/admin/quotes'));
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
    const res = await proxy(makeReq('/admin/quotes'));
    expect(res).toBe(rotatedRes);
    expect(res.cookies.get('sb-session')?.value).toBe('rotated-token-value');
  });

  it('fails closed when Supabase is unconfigured (supabase null) on an /api path -> 401, never next()', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({ supabase: null, res: NextResponse.next() });
    const res = await proxy(makeReq('/api/quotes'));
    expect(res.status).toBe(401);
  });

  it('fails closed when Supabase is unconfigured on a page path -> redirect to /login, never next()', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({ supabase: null, res: NextResponse.next() });
    const res = await proxy(makeReq('/admin/quotes'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});

// ---------------------------------------------------------------------------
// Role-aware perimeter. Crew logins shared the operator auth store, so "has a
// session" never implied "may see the operator surface" — and that surface holds
// customer PII. Crew logins were RETIRED (row 438) and nothing mints one, but
// this refusal is now UNCONDITIONAL rather than deleted: roleOf collapses every
// non-admin role to 'operator', so a crew account created by hand later would
// otherwise be silently promoted. These tests pin the fail-closed behaviour.
// ---------------------------------------------------------------------------

describe('proxy — crew sessions are refused everywhere (row 438)', () => {
  const crewUser = { id: 'crew-auth-1', app_metadata: { role: 'crew' } };
  const operatorUser = { id: 'op-1', app_metadata: { role: 'operator' } };

  function withUser(user: unknown) {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user } }) } },
      res: { __res: true } as unknown as NextResponse,
    });
  }

  beforeEach(() => {
    process.env.AUTH_GATE_ENABLED = 'true';
  });

  it('refuses a crew session on the RETIRED crew API too — there is no allowed path left', async () => {
    // This asserted the opposite before row 438. `/api/ops/v1` was deleted with
    // the Operations Hub, so the one namespace a crew login could reach is gone
    // and the gate no longer carries an exception.
    withUser(crewUser);
    const res = await proxy(makeReq('/api/ops/v1/jobs/abc/arrive', 'POST'));
    expect(res.status).toBe(403);
  });

  it('403s a crew session on an operator API — this is the PII boundary', async () => {
    withUser(crewUser);
    const res = await proxy(makeReq('/api/customers'));
    expect(res.status).toBe(403);
  });

  it('redirects a crew session away from an operator PAGE', async () => {
    // Pages that lean on the perimeter rather than calling requireOperator
    // themselves are covered ONLY by this branch.
    withUser(crewUser);
    const res = await proxy(makeReq('/customers'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('location')).toContain('crew-account');
  });

  it('does NOT confine an operator session — it still reaches the operator surface', async () => {
    withUser(operatorUser);
    const res = await proxy(makeReq('/api/customers'));
    expect((res as unknown as { __res?: boolean }).__res).toBe(true);
  });

  it('does not treat the CRON path as crew-reachable', async () => {
    // /api/ops/midnight-close is public-allowlisted for the cron, so it short
    // circuits before any session check. A crew session must not gain anything
    // from that: the route's own CRON_SECRET check is the real gate.
    withUser(crewUser);
    const res = await proxy(makeReq('/api/ops/midnight-close', 'POST'));
    // Allowlisted → plain next(), not the authed `res` object.
    expect((res as unknown as { __res?: boolean }).__res).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Advertising-role hardening: the same shape as the crew block above, for the
// advertising population (Naldo's 2026-08-27 ruling). No advertising page or
// API exists yet — isAdvertisingPath() is empty — so these tests confirm the
// population lock lands BEFORE the surface does: an advertising session is
// confined to nothing right now, and refused everywhere else.
// ---------------------------------------------------------------------------

describe('proxy — advertising sessions are confined to the advertising surface', () => {
  const advertisingUser = { id: 'adv-auth-1', app_metadata: { role: 'advertising' } };
  const operatorUser = { id: 'op-1', app_metadata: { role: 'operator' } };

  function withUser(user: unknown) {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user } }) } },
      res: { __res: true } as unknown as NextResponse,
    });
  }

  beforeEach(() => {
    process.env.AUTH_GATE_ENABLED = 'true';
  });

  it('403s an advertising session on an operator API — this is the PII boundary', async () => {
    withUser(advertisingUser);
    const res = await proxy(makeReq('/api/customers'));
    expect(res.status).toBe(403);
  });

  it('redirects an advertising session away from an operator PAGE', async () => {
    withUser(advertisingUser);
    const res = await proxy(makeReq('/customers'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('location')).toContain('advertising-account');
  });

  it('403s an advertising session on the crew API too — no surface exists for it yet', async () => {
    withUser(advertisingUser);
    const res = await proxy(makeReq('/api/ops/v1/jobs/abc/arrive', 'POST'));
    expect(res.status).toBe(403);
  });

  it('does NOT confine an operator session — it still reaches the operator surface', async () => {
    withUser(operatorUser);
    const res = await proxy(makeReq('/api/customers'));
    expect((res as unknown as { __res?: boolean }).__res).toBe(true);
  });

  it('does not treat the CRON path as advertising-reachable', async () => {
    withUser(advertisingUser);
    const res = await proxy(makeReq('/api/ops/midnight-close', 'POST'));
    // Allowlisted → plain next(), not the authed `res` object.
    expect((res as unknown as { __res?: boolean }).__res).toBeUndefined();
  });

  it('does not confine a crew session under the advertising branch, and vice versa', async () => {
    // The two branches must be independent: an advertising account is not a
    // crew account and must not accidentally satisfy isCrewAccount (or the
    // reverse). Both are refused on the operator surface, but for their OWN
    // reason, and the advertising branch must never widen to admit crew.
    withUser({ id: 'crew-1', app_metadata: { role: 'crew' } });
    const crewRes = await proxy(makeReq('/api/customers'));
    expect(crewRes.status).toBe(403);
    const crewLocation = (await proxy(makeReq('/customers'))).headers.get('location');
    expect(crewLocation).toContain('crew-account');
    expect(crewLocation).not.toContain('advertising-account');
  });
});

// ---------------------------------------------------------------------------
// Self-serve referral link perimeter wiring (naldo/referral-self-serve).
// operatorGate.test.ts already proves isPublicPath() classifies /referral-link
// and POST /api/referrals/request-link correctly as pure boolean logic. These
// tests prove proxy() actually wires that classification to a real signed-out
// request: that each public path is let through before Supabase is ever
// touched, and that the cases right next to it (a wrong method, a sub-path, an
// unrelated operator page) are not accidentally opened by the same allowlist
// entry.
// ---------------------------------------------------------------------------

describe('proxy: referral-link self-serve perimeter (naldo/referral-self-serve)', () => {
  it('lets a signed-out GET /referral-link through without a redirect to /login', async () => {
    const res = await proxy(makeReq('/referral-link'));
    expect(res.status).toBe(200); // NextResponse.next() default, not a redirect
    expect(createMiddlewareSupabaseMock).not.toHaveBeenCalled();
  });

  it('lets a signed-out POST /api/referrals/request-link through without a 401', async () => {
    const res = await proxy(makeReq('/api/referrals/request-link', 'POST'));
    expect(res.status).toBe(200); // NextResponse.next() default, not 401
    expect(createMiddlewareSupabaseMock).not.toHaveBeenCalled();
  });

  it('does not open GET on /api/referrals/request-link: signed-out returns 401', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await proxy(makeReq('/api/referrals/request-link', 'GET'));
    expect(res.status).toBe(401);
  });

  it('does not open DELETE on /api/referrals/request-link: signed-out returns 401', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await proxy(makeReq('/api/referrals/request-link', 'DELETE'));
    expect(res.status).toBe(401);
  });

  it('does not extend the /referral-link allowlist entry to a sub-path: redirects to /login', async () => {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await proxy(makeReq('/referral-link/anything'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('negative control: signed-out GET /settings still redirects to /login under the same setup', async () => {
    // Proves the harness above is honest: if the gate were accidentally
    // dormant in these tests, every assertion above would pass for the wrong
    // reason. This unrelated operator page must still be denied.
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    const res = await proxy(makeReq('/settings'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});
