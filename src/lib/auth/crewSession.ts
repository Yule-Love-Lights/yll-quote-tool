import { getCrewMember, type CrewMember } from '@/lib/crewMembers';
import { verifyCrewToken, CREW_SESSION_TTL_MS } from '@/lib/auth/crewLink';

/**
 * The session half of the crew door (see crewLink.ts for the token format).
 *
 * The signed cookie carries only a crew member id: every request re-reads the
 * crew row, so deactivating a crew member or unlinking their Telegram account
 * ends their session immediately instead of at the cookie's expiry. That is the
 * only revocation this door has, so it is not optional.
 */

export const CREW_COOKIE_NAME = 'yll_crew';
export const CREW_COOKIE_MAX_AGE_SECONDS = Math.floor(CREW_SESSION_TTL_MS / 1000);

export type CrewCaller =
  | { ok: true; member: CrewMember }
  | { ok: false; reason: 'unauthenticated' | 'no_crew_row' | 'inactive' | 'unlinked' };

/**
 * Resolve a session cookie value to its crew member, or a named refusal.
 * Every failure mode outside the crew row itself reads as unauthenticated on
 * purpose: an expired cookie, a forged one, and an entry link replayed as a
 * cookie are the same answer to the caller.
 */
export async function resolveCrewCaller(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<CrewCaller> {
  const verified = verifyCrewToken('session', cookieValue, nowMs);
  if (!verified.ok) return { ok: false, reason: 'unauthenticated' };

  const member = await getCrewMember(verified.crewMemberId);
  if (!member) return { ok: false, reason: 'no_crew_row' };
  if (!member.active) return { ok: false, reason: 'inactive' };
  if (!member.telegramUserId) return { ok: false, reason: 'unlinked' };
  return { ok: true, member };
}

/** 401 for no session, 403 for a session that exists and is not allowed here. */
export function crewRefusalStatus(reason: Exclude<CrewCaller, { ok: true }>['reason']): number {
  return reason === 'unauthenticated' ? 401 : 403;
}

/** The cookie attributes, in one place so the entry route and any future
 * sign-out route cannot drift. */
export function crewCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: CREW_COOKIE_MAX_AGE_SECONDS,
  };
}
