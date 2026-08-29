import { NextRequest, NextResponse } from 'next/server';

import { verifyCrewToken, mintCrewToken } from '@/lib/auth/crewLink';
import { CREW_COOKIE_NAME, crewCookieOptions } from '@/lib/auth/crewSession';
import { consumeCrewLinkJti, ensureCrewSessionEpoch, getCrewMember } from '@/lib/crewMembers';
import { logCrewAccess } from '@/lib/crew/accessEvents';

export const dynamic = 'force-dynamic';

/**
 * The crew entry door: exchange a short-lived signed LINK for a session cookie.
 *
 * The link is minted for one crew member and handed to them. This route checks
 * the signature, re-reads the crew row (an expired link and a deactivated crew
 * member are both refusals here, not at first use), CONSUMES the link's
 * single-use id so it cannot be redeemed twice, and redirects to My Day with
 * the token stripped from the URL.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('t');
  const verified = verifyCrewToken('link', token, Date.now());

  const refuse = async (why: string, crewMemberId: string | null, reason: string) => {
    await logCrewAccess({ crewMemberId, actor: 'crew', action: 'entry_refused', detail: { reason } });
    const url = req.nextUrl.clone();
    url.pathname = '/crew';
    url.search = '';
    url.searchParams.set('denied', why);
    return NextResponse.redirect(url);
  };

  if (!verified.ok) {
    return refuse(verified.reason === 'expired' ? 'expired' : 'invalid', null, verified.reason);
  }

  const member = await getCrewMember(verified.crewMemberId);
  if (!member) return refuse('invalid', null, 'no_crew_row');
  if (!member.active) return refuse('invalid', member.id, 'inactive');
  if (!member.telegramUserId) return refuse('invalid', member.id, 'unlinked');

  // Single use, compare-and-set: two taps on the same link race and exactly one
  // wins, and a link superseded by a newer one finds nothing to consume.
  if (!verified.jti || !(await consumeCrewLinkJti(member.id, verified.jti))) {
    return refuse('used', member.id, 'already_used');
  }

  const epoch = await ensureCrewSessionEpoch(member.id);

  const url = req.nextUrl.clone();
  url.pathname = '/crew';
  url.search = '';
  const res = NextResponse.redirect(url);
  res.cookies.set(CREW_COOKIE_NAME, mintCrewToken('session', member.id, Date.now(), epoch), crewCookieOptions());
  await logCrewAccess({ crewMemberId: member.id, actor: 'crew', action: 'entered' });
  return res;
}
