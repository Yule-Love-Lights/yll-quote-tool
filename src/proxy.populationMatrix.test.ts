// Population-by-surface matrix (advertising role hardening).
//
// The auth store now serves FOUR populations: admin/operator, crew,
// advertising, and unauthenticated. Each population may reach exactly one
// surface at the perimeter (operator surface / crew surface / advertising
// surface), and this file is the single place that proves all twelve
// combinations, instead of trusting that per-branch tests in proxy.test.ts
// compose correctly. Complements (does not replace) proxy.test.ts's per-branch
// coverage and operatorGate.test.ts's pure isXPath() coverage.
//
// Modeled on proxy.test.ts's fixture pattern: isPublicPath/
// isAdvertisingPath/isCrewAccount/isAdvertisingAccount/authGateEngaged are all
// REAL (they are the security seam under test); only createMiddlewareSupabase
// is mocked, since it's the one piece that talks to actual Supabase.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { createMiddlewareSupabaseMock } = vi.hoisted(() => ({
  createMiddlewareSupabaseMock: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/supabaseServer')>('@/lib/auth/supabaseServer');
  return {
    createMiddlewareSupabase: createMiddlewareSupabaseMock,
    isCrewAccount: actual.isCrewAccount,
    isAdvertisingAccount: actual.isAdvertisingAccount,
    CREW_ROLE: actual.CREW_ROLE,
    ADVERTISING_ROLE: actual.ADVERTISING_ROLE,
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

// Sessions under test — the four populations.
type SessionKind = 'operator' | 'crew' | 'advertising' | 'unauthenticated';

function wireSession(kind: SessionKind) {
  if (kind === 'unauthenticated') {
    createMiddlewareSupabaseMock.mockReturnValue({
      supabase: { auth: { getUser: async () => ({ data: { user: null } }) } },
      res: NextResponse.next(),
    });
    return;
  }
  const role = kind === 'operator' ? 'operator' : kind === 'crew' ? 'crew' : 'advertising';
  const user = { id: `${kind}-1`, app_metadata: { role } };
  createMiddlewareSupabaseMock.mockReturnValue({
    supabase: { auth: { getUser: async () => ({ data: { user } }) } },
    // A distinct marker object (not a real NextResponse) so "reached the
    // operator surface" is unambiguous: it's whatever proxy() returns
    // UNCHANGED on the authenticated pass-through path, not a fresh next().
    res: { __authedPassthrough: true } as unknown as NextResponse,
  });
}

// Surfaces under test — one representative path each. All three are
// non-public (not in operatorGate.ts's allowlist), so an unauthenticated
// session always 401s regardless of which surface it targets.
const OPERATOR_PATH = '/api/customers';
// The RETIRED crew namespace (row 433 deleted it). Kept as a matrix row so the
// perimeter is pinned to refuse a crew session here too, not merely elsewhere.
const CREW_PATH = '/api/ops/v1/jobs/abc/arrive';
const ADVERTISING_PATH = '/api/advertising/campaigns';

type Outcome = 'reachedSurface' | 'forbidden403' | 'unauthorized401';

async function outcomeFor(kind: SessionKind, path: string): Promise<Outcome> {
  wireSession(kind);
  const res = await proxy(makeReq(path, 'POST'));
  if ((res as unknown as { __authedPassthrough?: boolean }).__authedPassthrough) {
    return 'reachedSurface';
  }
  if (res.status === 403) return 'forbidden403';
  if (res.status === 401) return 'unauthorized401';
  throw new Error(`Unexpected proxy() outcome: status=${res.status}`);
}

// The full 4 (sessions) x 3 (surfaces) = 12 matrix. Each row is independently
// meaningful: a wrong cell here is either a PII leak (a population reaching a
// surface it shouldn't) or a lockout (a population refused its own surface).
describe('population-by-surface matrix (advertising role hardening)', () => {
  it.each<[SessionKind, string, string, Outcome]>([
    // operator — the operator population reaches the operator surface, and
    // is UNAFFECTED by the crew/advertising confinement branches (those only
    // trigger for crew/advertising accounts).
    ['operator', 'operator path', OPERATOR_PATH, 'reachedSurface'],
    ['operator', 'crew path', CREW_PATH, 'reachedSurface'],
    ['operator', 'advertising path', ADVERTISING_PATH, 'reachedSurface'],

    // crew — refused EVERYWHERE since crew logins were retired (row 438).
    // This block read 'reachedSurface' on the crew path until that landed:
    // /api/ops/v1 went with the Operations Hub (row 433), so the namespace a
    // crew session was confined TO no longer exists and the perimeter carries
    // no exception for it. Nothing mints a crew account any more; the refusal
    // stays because roleOf would otherwise read one as an operator.
    ['crew', 'operator path', OPERATOR_PATH, 'forbidden403'],
    ['crew', 'crew path', CREW_PATH, 'forbidden403'],
    ['crew', 'advertising path', ADVERTISING_PATH, 'forbidden403'],

    // advertising — confined to exactly the advertising surface (this PR).
    // The advertising-path cell PASSES the perimeter (isAdvertisingPath's
    // prefix already covers it) even though no actual page/route exists there
    // yet — that gap is a 404 at Next.js's own routing layer, outside
    // proxy.ts's concern, and is the whole point: the population lock (the
    // marker + the perimeter confinement) ships before the surface does, so a
    // real /api/advertising/** route can land later with NO change here.
    ['advertising', 'operator path', OPERATOR_PATH, 'forbidden403'],
    ['advertising', 'crew path', CREW_PATH, 'forbidden403'],
    ['advertising', 'advertising path', ADVERTISING_PATH, 'reachedSurface'],

    // unauthenticated — 401 everywhere; none of these paths are public.
    ['unauthenticated', 'operator path', OPERATOR_PATH, 'unauthorized401'],
    ['unauthenticated', 'crew path', CREW_PATH, 'unauthorized401'],
    ['unauthenticated', 'advertising path', ADVERTISING_PATH, 'unauthorized401'],
  ])('%s session against the %s -> %s', async (kind, _label, path, expected) => {
    expect(await outcomeFor(kind, path)).toBe(expected);
  });
});

// The perimeter already claims the /api/advertising prefix even though no
// actual page or route exists under it yet (ledger: advertising role
// hardening) — that is what makes the matrix row above
// ('advertising' x 'advertising path' -> 'reachedSurface') correct: the
// PERIMETER lets the session through, and a 404 (nothing built there) would
// come from Next.js's own routing layer, a separate concern from the auth
// seam this file tests. This block just re-confirms the representative path
// the matrix uses is inside that (still-unbuilt) prefix, so the matrix row
// above is testing what it claims to test.
describe('the advertising surface prefix is already claimed, even though nothing is built there yet', () => {
  it('isAdvertisingPath already covers the representative path this matrix uses', async () => {
    const { isAdvertisingPath } = await import('@/lib/auth/operatorGate');
    // Sanity only — the prefix logic itself is proven exhaustively in
    // operatorGate.test.ts.
    expect(isAdvertisingPath(ADVERTISING_PATH)).toBe(true);
  });
});
