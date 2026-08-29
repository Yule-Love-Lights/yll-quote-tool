import { NextRequest, NextResponse } from 'next/server';

import { verifyCrewToken, mintCrewToken } from '@/lib/auth/crewLink';
import { CREW_COOKIE_NAME, crewCookieOptions } from '@/lib/auth/crewSession';
import { getCrewMember } from '@/lib/crewMembers';

export const dynamic = 'force-dynamic';

/**
 * The crew entry door: exchange a short-lived signed LINK for a session cookie.
 *
 * The link is minted for one crew member and handed to them; this route checks
 * it, re-reads the crew row (an expired link and a deactivated crew member are
 * both refusals here, not at first use), and redirects to My Day carrying a
 * fresh session cookie. The link's own token is never stored.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('t');
  const verified = verifyCrewToken('link', token, Date.now());

  const refuse = (why: string) => {
    const url = req.nextUrl.clone();
    url.pathname = '/crew';
    url.search = '';
    url.searchParams.set('denied', why);
    return NextResponse.redirect(url);
  };

  if (!verified.ok) return refuse(verified.reason === 'expired' ? 'expired' : 'invalid');

  const member = await getCrewMember(verified.crewMemberId);
  if (!member || !member.active || !member.telegramUserId) return refuse('invalid');

  const url = req.nextUrl.clone();
  url.pathname = '/crew';
  url.search = '';
  const res = NextResponse.redirect(url);
  res.cookies.set(CREW_COOKIE_NAME, mintCrewToken('session', member.id, Date.now()), crewCookieOptions());
  return res;
}
