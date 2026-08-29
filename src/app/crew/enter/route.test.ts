// The crew entry door (row 466): a signed 15-minute link becomes a session
// cookie, or it becomes a refusal. Nothing in between.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getCrewMember, consumeCrewLinkJti, logCrewAccess } = vi.hoisted(() => ({
  getCrewMember: vi.fn(),
  consumeCrewLinkJti: vi.fn(),
  logCrewAccess: vi.fn(),
}));
vi.mock('@/lib/crewMembers', () => ({ getCrewMember, consumeCrewLinkJti }));
vi.mock('@/lib/crew/accessEvents', () => ({ logCrewAccess }));

import { GET } from './route';
import { mintCrewToken, verifyCrewToken, CREW_LINK_TTL_MS } from '@/lib/auth/crewLink';
import { CREW_COOKIE_NAME } from '@/lib/auth/crewSession';

const CREW = 'crew-1';
const member = (over: Record<string, unknown> = {}) => ({
  id: CREW,
  displayName: 'Field Crew One',
  active: true,
  telegramUserId: '900001',
  ...over,
});
const req = (token: string | null) =>
  new NextRequest(`https://quote.example.com/crew/enter${token === null ? '' : `?t=${encodeURIComponent(token)}`}`);

let prev: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  prev = process.env.CREW_LINK_SECRET;
  process.env.CREW_LINK_SECRET = 'test-secret-value-for-crew-links';
  getCrewMember.mockResolvedValue(member());
  consumeCrewLinkJti.mockResolvedValue(true);
  logCrewAccess.mockResolvedValue(undefined);
});
afterEach(() => {
  if (prev === undefined) delete process.env.CREW_LINK_SECRET;
  else process.env.CREW_LINK_SECRET = prev;
});

describe('GET /crew/enter', () => {
  it('exchanges a valid link for a session cookie and sends them to My Day', async () => {
    const res = await GET(req(mintCrewToken('link', CREW, Date.now(), '900001', 'jti-1')));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/crew');
    const cookie = res.cookies.get(CREW_COOKIE_NAME);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
  });

  it('never leaves the link token in the URL it redirects to', async () => {
    const res = await GET(req(mintCrewToken('link', CREW, Date.now(), '900001', 'jti-1')));
    expect(new URL(res.headers.get('location')!).search).toBe('');
  });

  it('sets a session cookie, not a copy of the link', async () => {
    const link = mintCrewToken('link', CREW, Date.now(), '900001', 'jti-1');
    const res = await GET(req(link));
    expect(res.cookies.get(CREW_COOKIE_NAME)?.value).not.toBe(link);
  });

  const denied = (res: { headers: Headers }) => new URL(res.headers.get('location')!).searchParams.get('denied');

  it('refuses an expired link and says so', async () => {
    const stale = mintCrewToken('link', CREW, Date.now() - CREW_LINK_TTL_MS - 1000, '900001', 'jti-1');
    const res = await GET(req(stale));
    expect(denied(res)).toBe('expired');
    expect(res.cookies.get(CREW_COOKIE_NAME)).toBeUndefined();
  });

  it.each([
    ['no token', null],
    ['a garbage token', 'not-a-token'],
  ])('refuses %s without setting a cookie', async (_label, token) => {
    const res = await GET(req(token));
    expect(denied(res)).toBe('invalid');
    expect(res.cookies.get(CREW_COOKIE_NAME)).toBeUndefined();
  });

  it('refuses a SESSION token replayed at the entry door', async () => {
    const res = await GET(req(mintCrewToken('session', CREW, Date.now())));
    expect(denied(res)).toBe('invalid');
    expect(res.cookies.get(CREW_COOKIE_NAME)).toBeUndefined();
  });

  it.each([
    ['deactivated', { active: false }],
    ['unlinked from Telegram', { telegramUserId: null }],
  ])('refuses a link for a %s crew member even while the signature is still valid', async (_l, over) => {
    getCrewMember.mockResolvedValue(member(over));
    const res = await GET(req(mintCrewToken('link', CREW, Date.now(), '900001', 'jti-1')));
    expect(denied(res)).toBe('invalid');
    expect(res.cookies.get(CREW_COOKIE_NAME)).toBeUndefined();
  });

  it('refuses when the crew row is gone', async () => {
    getCrewMember.mockResolvedValue(null);
    const res = await GET(req(mintCrewToken('link', CREW, Date.now(), '900001', 'jti-1')));
    expect(denied(res)).toBe('invalid');
  });

  // Single use. Two taps on the same link race at the compare-and-set, and the
  // loser is told plainly rather than shown an empty page.
  it('refuses a link whose single-use id has already been spent', async () => {
    consumeCrewLinkJti.mockResolvedValue(false);
    const res = await GET(req(mintCrewToken('link', CREW, Date.now(), '900001', 'jti-1')));
    expect(denied(res)).toBe('used');
    expect(res.cookies.get(CREW_COOKIE_NAME)).toBeUndefined();
  });

  it('refuses a link carrying no single-use id at all', async () => {
    const res = await GET(req(mintCrewToken('link', CREW, Date.now(), '900001')));
    expect(denied(res)).toBe('used');
    expect(consumeCrewLinkJti).not.toHaveBeenCalled();
  });

  it('binds the session cookie to the Telegram account it was minted for', async () => {
    const res = await GET(req(mintCrewToken('link', CREW, Date.now(), '900001', 'jti-1')));
    const cookie = res.cookies.get(CREW_COOKIE_NAME)!.value;
    expect(verifyCrewToken('session', cookie, Date.now())).toMatchObject({ ok: true, binding: '900001' });
  });

  it('records the entry, and records a refusal as a refusal', async () => {
    await GET(req(mintCrewToken('link', CREW, Date.now(), '900001', 'jti-1')));
    expect(logCrewAccess).toHaveBeenCalledWith(expect.objectContaining({ action: 'entered', crewMemberId: CREW }));

    logCrewAccess.mockClear();
    await GET(req('not-a-token'));
    expect(logCrewAccess).toHaveBeenCalledWith(expect.objectContaining({ action: 'entry_refused' }));
  });
});
