import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CrewMember } from '@/lib/crewMembers';

const state: { member: CrewMember | null } = { member: null };
vi.mock('@/lib/crewMembers', () => ({
  getCrewMember: async (id: string) => (state.member && state.member.id === id ? state.member : null),
}));

const { resolveCrewCaller, CREW_COOKIE_NAME } = await import('./crewSession');
const { mintCrewToken } = await import('./crewLink');

const CREW = '11111111-2222-3333-4444-555555555555';
const NOW = Date.parse('2026-08-29T12:00:00Z');
const member = (over: Partial<CrewMember> = {}): CrewMember =>
  ({
    id: CREW,
    hubEmployeeId: null,
    telegramUserId: '900001',
    sessionEpoch: 'epoch-1',
    displayName: 'Field Crew One',
    baseRateCents: 2000,
    inP4pPool: false,
    payMode: 'hourly',
    language: 'en',
    active: true,
    createdAt: NOW.toString(),
    updatedAt: NOW.toString(),
    ...over,
  }) as CrewMember;

describe('resolveCrewCaller', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CREW_LINK_SECRET;
    process.env.CREW_LINK_SECRET = 'test-secret-value-for-crew-links';
    state.member = member();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CREW_LINK_SECRET;
    else process.env.CREW_LINK_SECRET = prev;
  });

  it('names the cookie once, so the route and the page cannot drift apart', () => {
    expect(CREW_COOKIE_NAME).toBe('yll_crew');
  });

  it('resolves a valid session cookie to its crew member', async () => {
    const cookie = mintCrewToken('session', CREW, NOW, 'epoch-1');
    await expect(resolveCrewCaller(cookie, NOW)).resolves.toEqual({ ok: true, member: state.member });
  });

  it('refuses a missing cookie as unauthenticated', async () => {
    await expect(resolveCrewCaller(undefined, NOW)).resolves.toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('refuses an entry LINK presented as a session cookie', async () => {
    const link = mintCrewToken('link', CREW, NOW);
    await expect(resolveCrewCaller(link, NOW)).resolves.toEqual({ ok: false, reason: 'unauthenticated' });
  });

  // Revocation is the whole reason the crew row is re-read on every request
  // rather than trusted from the signed payload.
  it('ends the session the moment the crew member is deactivated', async () => {
    const cookie = mintCrewToken('session', CREW, NOW, 'epoch-1');
    state.member = member({ active: false });
    await expect(resolveCrewCaller(cookie, NOW)).resolves.toEqual({ ok: false, reason: 'inactive' });
  });

  it('ends the session the moment the Telegram account is unlinked', async () => {
    const cookie = mintCrewToken('session', CREW, NOW, 'epoch-1');
    state.member = member({ telegramUserId: null });
    await expect(resolveCrewCaller(cookie, NOW)).resolves.toEqual({ ok: false, reason: 'unlinked' });
  });

  it('refuses a cookie whose crew row is gone entirely', async () => {
    const cookie = mintCrewToken('session', CREW, NOW, 'epoch-1');
    state.member = null;
    await expect(resolveCrewCaller(cookie, NOW)).resolves.toEqual({ ok: false, reason: 'no_crew_row' });
  });

  // Sign-out-everywhere for one person, with no schema change: the session is
  // bound to the Telegram account it was minted for, so unlinking and
  // relinking kills every session issued before, including a stolen one
  // (customer lens, PR #1094).
  // Sign out everywhere. The epoch rotates on link, unlink, deactivation and
  // the explicit admin action, so any of those ends every session that person
  // holds. Binding to the Telegram id did NOT do this: the office's real
  // remediation is unlink then relink the SAME account, which restored the same
  // id and revived the leaked session (delta-verify, PR #1094).
  it('refuses a session whose epoch has been rotated', async () => {
    const cookie = mintCrewToken('session', CREW, NOW, 'epoch-1');
    state.member = member({ sessionEpoch: 'epoch-2' });
    await expect(resolveCrewCaller(cookie, NOW)).resolves.toEqual({ ok: false, reason: 'revoked' });
  });

  it('still refuses after an unlink and relink of the SAME Telegram account', async () => {
    const cookie = mintCrewToken('session', CREW, NOW, 'epoch-1');
    // setStaffTelegram rotates the epoch on both halves of that round trip.
    state.member = member({ telegramUserId: '900001', sessionEpoch: 'epoch-3' });
    await expect(resolveCrewCaller(cookie, NOW)).resolves.toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses a crew row that has no epoch at all rather than treating it as a match', async () => {
    const cookie = mintCrewToken('session', CREW, NOW, 'epoch-1');
    state.member = member({ sessionEpoch: null });
    await expect(resolveCrewCaller(cookie, NOW)).resolves.toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses an unbound session cookie, so a pre-binding token cannot linger', async () => {
    const cookie = mintCrewToken('session', CREW, NOW);
    await expect(resolveCrewCaller(cookie, NOW)).resolves.toEqual({ ok: false, reason: 'revoked' });
  });
});
