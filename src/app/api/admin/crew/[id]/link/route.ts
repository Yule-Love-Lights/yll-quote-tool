import { NextResponse } from 'next/server';

import { randomUUID } from 'node:crypto';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { mintCrewToken, CREW_LINK_TTL_MS } from '@/lib/auth/crewLink';
import { getCrewMember, stampCrewLinkJti } from '@/lib/crewMembers';
import { logCrewAccess } from '@/lib/crew/accessEvents';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';

export const dynamic = 'force-dynamic';

/**
 * Mint a My Day entry link for one crew member (row 466, the Telegram door).
 *
 * Admin only, and it refuses a crew member who is inactive or has no Telegram
 * account linked: the link IS their identity, so handing one to an unlinked
 * person would create a door the office cannot revoke by unlinking.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const { id } = await params;
  const member = await getCrewMember(id);
  if (!member) return NextResponse.json({ error: 'Crew member not found' }, { status: 404 });
  if (!member.active) return NextResponse.json({ error: 'That crew member is not active' }, { status: 409 });
  if (!member.telegramUserId) {
    return NextResponse.json(
      { error: 'Link their Telegram account first: the link is how they are identified.' },
      { status: 409 },
    );
  }

  // Single use: the id below is stamped on the crew row and spent by the entry
  // route, so this link can be redeemed once and minting a new one revokes any
  // link still in someone's chat history.
  const jti = randomUUID();
  let token: string;
  try {
    token = mintCrewToken('link', member.id, Date.now(), member.telegramUserId, jti);
  } catch {
    return NextResponse.json({ error: 'CREW_LINK_SECRET is not set: the crew door is closed' }, { status: 503 });
  }
  await stampCrewLinkJti(member.id, jti);
  await logCrewAccess({
    crewMemberId: member.id,
    actor: auth.operator.id,
    action: 'link_minted',
    detail: { expiresInMinutes: Math.round(CREW_LINK_TTL_MS / 60000) },
  });

  return NextResponse.json({
    url: `${appBaseUrl()}/crew/enter?t=${encodeURIComponent(token)}`,
    expiresInMinutes: Math.round(CREW_LINK_TTL_MS / 60000),
    crewMember: { id: member.id, displayName: member.displayName },
  });
}
