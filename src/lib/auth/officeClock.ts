import { NextResponse } from 'next/server';

import { createRouteSupabase, isCrewAccount } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';

/**
 * Office-side authentication for the web clock (`source: 'office'`).
 *
 * This is the OFFICE twin of `getCrewCaller` (crewAuth.ts), and the split is
 * deliberate. Crew clock in from their own phones with a CREW login
 * (`isCrewAccount`), tagged `source: 'pwa'`/`'telegram'`. Office staff — Naldo,
 * Kelly, Ann, Khaye — are OPERATORS (they need the dashboard/settings a crew
 * login is refused), so they can never resolve through `getCrewCaller`, which
 * rejects operator sessions by design. Their time is the separate, audited
 * `source: 'office'` lane the crew module's own doc block names.
 *
 * WHY NOT JUST `requireOperator`: that gate is DORMANT while `AUTH_GATE_ENABLED`
 * is off (it was retrofitted onto pre-gate routes and returns null=allow then).
 * This writes PAYROLL, so — exactly like `getCrewCaller` — it fails closed from
 * the first commit: a real authenticated session is required regardless of the
 * perimeter's dormancy.
 *
 * THE ID IS NEVER FROM THE BODY. The pay identity (`crew_members.id`) is
 * resolved from the session's `auth_user_id`, so this is "clock MYSELF in", not
 * "clock anyone in" — the same guarantee the crew and job-segment routes give.
 *
 * A crew login that lands here is refused (`is_crew`): crew have their own path,
 * and letting a crew punch land as `source: 'office'` would mislabel the lane.
 */

export type OfficeCaller = {
  /** `crew_members.id` — the pay identity the time ledger keys on. */
  crewMemberId: string;
  /** The shared-auth-store user id behind it. */
  authUserId: string;
  displayName: string;
};

type CrewRow = {
  id: string;
  display_name: string;
  active: boolean;
};

/**
 * `unauthenticated` — no valid session at all.
 * `is_crew`         — a crew login; it must use the crew clock, not this one.
 * `unlinked`        — an operator login with no `crew_members` row pointing at
 *                     it, so there is no pay identity to attach office hours to.
 *                     An admin links the login to the person first.
 * `inactive`        — linked, but the crew member is deactivated.
 * `unconfigured`    — Supabase/auth not configured (local/dev).
 */
export type OfficeLookup =
  | { ok: true; caller: OfficeCaller }
  | { ok: false; reason: 'unauthenticated' | 'is_crew' | 'unlinked' | 'inactive' | 'unconfigured' };

export async function getOfficeClockCaller(): Promise<OfficeLookup> {
  const supabase = await createRouteSupabase();
  if (!supabase) return { ok: false, reason: 'unconfigured' };

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { ok: false, reason: 'unauthenticated' };

  // Crew logins have their own clock (source 'pwa'/'telegram'); routing them
  // through here would stamp their punch 'office' and double-book the two lanes.
  if (isCrewAccount(user.app_metadata)) return { ok: false, reason: 'is_crew' };

  const db = getSupabaseServiceClient();
  if (!db) return { ok: false, reason: 'unconfigured' };

  const { data, error: lookupError } = await db
    .from('crew_members')
    .select('id, display_name, active')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (lookupError) {
    console.error('getOfficeClockCaller: crew_members lookup failed:', lookupError.message);
    return { ok: false, reason: 'unconfigured' };
  }

  const row = data as CrewRow | null;
  if (!row) return { ok: false, reason: 'unlinked' };
  if (!row.active) return { ok: false, reason: 'inactive' };

  return {
    ok: true,
    caller: { crewMemberId: row.id, authUserId: user.id, displayName: row.display_name },
  };
}

/**
 * Maps a failed lookup to the response the route returns directly.
 *
 * The `reason` is echoed in the body so the client can tell apart the two 403s —
 * `unlinked` (never set up) from `inactive` (set up, then deactivated) — which
 * carry different copy in the header clock. The office-onboarding UI (row 354)
 * made `inactive` reachable, so the distinction now matters.
 */
export function officeDenialResponse(
  reason: Exclude<OfficeLookup, { ok: true }>['reason'],
): NextResponse {
  switch (reason) {
    case 'unauthenticated':
      return NextResponse.json({ error: 'Unauthorized', reason }, { status: 401 });
    case 'is_crew':
      return NextResponse.json(
        { error: 'Crew logins clock in from the crew app, not the office clock.', reason },
        { status: 403 },
      );
    case 'unlinked':
      return NextResponse.json(
        {
          error:
            'This login is not linked to a staff record yet. An admin must link it before time can be recorded.',
          reason,
        },
        { status: 403 },
      );
    case 'inactive':
      return NextResponse.json({ error: 'This staff member is not active.', reason }, { status: 403 });
    case 'unconfigured':
      return NextResponse.json({ error: 'Auth is not configured', reason }, { status: 503 });
  }
}
