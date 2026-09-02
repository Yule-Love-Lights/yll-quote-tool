// POST /api/referrals/pending-lookup — the quote builder's "did this lead come
// from a referral link?" probe.
//
// Two properties matter more than the happy path and are pinned here: the
// route is operator-only (it hands back a lead's referral history, so an
// anonymous caller must get nothing), and it never puts the caller's phone or
// email anywhere except the request body.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { requireOperatorMock, findMock, configuredMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  findMock: vi.fn(async () => null as unknown),
  configuredMock: vi.fn(() => true),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: configuredMock }));
vi.mock('@/lib/referrals', () => ({ findPendingLinkReferralForContact: findMock }));

import { POST } from './route';

const makeReq = (body: unknown) =>
  new NextRequest('https://quote.yulelovelights.com/api/referrals/pending-lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const MATCH = {
  referralId: 'r1',
  referrerCustomerId: 'c-referrer',
  referrerName: 'Dana Whitfield',
  refereeName: 'Sam Friend',
  createdAt: '2026-03-10T10:00:00Z',
  matchedOn: 'phone' as const,
};

beforeEach(() => {
  requireOperatorMock.mockReset();
  requireOperatorMock.mockResolvedValue(null);
  findMock.mockReset();
  findMock.mockResolvedValue(null);
  configuredMock.mockReturnValue(true);
});

describe('POST /api/referrals/pending-lookup', () => {
  it('is operator-only: a denial from requireOperator is returned untouched and nothing is looked up', async () => {
    const denial = new Response('nope', { status: 401 });
    requireOperatorMock.mockResolvedValue(denial);
    const res = await POST(makeReq({ phone: '5165550123' }));
    expect(res.status).toBe(401);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('503s when Supabase is not configured, naming the problem', async () => {
    configuredMock.mockReturnValue(false);
    const res = await POST(makeReq({ phone: '5165550123' }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('Supabase') });
  });

  it('400s on a body that is not JSON', async () => {
    const res = await POST(makeReq('not json at all'));
    expect(res.status).toBe(400);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('answers "no referral" without querying when there is nothing to match on', async () => {
    // A walk-in quote with no contact details typed yet is a normal state,
    // not an error, and must not cost a database round trip.
    const res = await POST(makeReq({ phone: '   ', email: '' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ match: null });
    expect(findMock).not.toHaveBeenCalled();
  });

  it('passes trimmed phone, email and the self-referral exclusion through', async () => {
    findMock.mockResolvedValue(MATCH);
    const res = await POST(
      makeReq({ phone: '  5165550123 ', email: ' Sam@Example.com ', excludeCustomerId: ' c-self ' }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ match: MATCH });
    expect(findMock).toHaveBeenCalledWith({
      phone: '5165550123',
      email: 'Sam@Example.com',
      excludeCustomerId: 'c-self',
    });
  });

  it('returns a null match plainly when the lead did not come from a link', async () => {
    findMock.mockResolvedValue(null);
    const res = await POST(makeReq({ phone: '5169999999' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ match: null });
  });

  it('ignores non-string fields rather than passing junk to the lookup', async () => {
    findMock.mockResolvedValue(null);
    await POST(makeReq({ phone: 5165550123, email: { nope: true }, excludeCustomerId: [] }));
    // Every field cleaned to null means nothing to match on, so the route
    // short-circuits before the lookup.
    expect(findMock).not.toHaveBeenCalled();
  });
});
