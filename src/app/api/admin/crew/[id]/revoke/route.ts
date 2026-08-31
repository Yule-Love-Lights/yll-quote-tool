import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getCrewMember, rotateCrewSessionEpoch } from '@/lib/crewMembers';

export const dynamic = 'force-dynamic';

/**
 * Sign one crew member out of My Day everywhere (delta-verify on PR #1094).
 *
 * Rotating their session epoch invalidates every session they hold, including a
 * leaked one, and touches nobody else. This exists because the obvious
 * remediation, unlinking and relinking the same Telegram account, is not by
 * itself a revocation lever the office should have to reason about.
 *
 * Not audited yet: crew_access_events' CHECK lists three actions and adding a
 * fourth is a constraint change, which is ask-first under the migration rules.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const { id } = await params;
  const member = await getCrewMember(id);
  if (!member) return NextResponse.json({ error: 'Crew member not found' }, { status: 404 });

  await rotateCrewSessionEpoch(member.id);
  return NextResponse.json({ ok: true, crewMember: { id: member.id, displayName: member.displayName } });
}
