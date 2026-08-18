import { NextResponse } from 'next/server';

import { createRouteSupabase, isCrewAccount } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';

/**
 * Crew-side authentication for the Flow B time-capture routes.
 *
 * Naldo's ruling (2026-08-16): ONE shared login store, so the same login works in
 * the Quote Tool and in the Operations Hub. This module turns such a login into
 * the crew member's PAY identity (`crew_members.id`), which is what the time
 * ledger keys on.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 * 1. It is NEVER dormant. `requireOperator` returns null (allow) while
 *    `AUTH_GATE_ENABLED` is off, because it was retrofitted onto routes that
 *    predated the gate. These crew routes are new and write PAYROLL data, so
 *    they fail closed from the first commit. There is no dormant use case for
 *    "anonymous clock-in".
 * 2. It does not trust any caller-supplied crew member id. The id comes from the
 *    authenticated session via `auth_user_id`, never from the request body. That
 *    is the difference between "clock myself in" and "clock anyone in".
 */

export type CrewCaller = {
  /** `crew_members.id` — the pay identity the time ledger keys on. */
  crewMemberId: string;
  /** The shared-auth-store user id behind it. */
  authUserId: string;
  displayName: string;
  active: boolean;
};

type CrewRow = {
  id: string;
  display_name: string;
  active: boolean;
};

/**
 * The crew member for the current request, or a reason it is not one.
 *
 * `unauthenticated` — no valid session at all.
 * `not_crew`        — a valid session, but an operator/admin login rather than a
 *                     crew one. Kept distinct so an operator poking a crew route
 *                     gets a truthful 403 rather than a misleading 401.
 * `unlinked`        — a crew login with no `crew_members` row pointing at it.
 *                     Their pay identity does not exist, so there is nothing to
 *                     attach hours to; an admin must link the account first.
 * `inactive`        — linked, but the crew member is deactivated.
 */
export type CrewLookup =
  | { ok: true; caller: CrewCaller }
  | { ok: false; reason: 'unauthenticated' | 'not_crew' | 'unlinked' | 'inactive' | 'unconfigured' };

export async function getCrewCaller(): Promise<CrewLookup> {
  const supabase = await createRouteSupabase();
  if (!supabase) return { ok: false, reason: 'unconfigured' };

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { ok: false, reason: 'unauthenticated' };

  // An operator session must NOT be able to drive crew time-capture routes:
  // those routes write to whoever the session resolves to, and an operator has
  // no crew identity to resolve to. Office-entered time is a separate,
  // deliberately-audited path (`source: 'office'`), not this one.
  if (!isCrewAccount(user.app_metadata)) return { ok: false, reason: 'not_crew' };

  const db = getSupabaseServiceClient();
  if (!db) return { ok: false, reason: 'unconfigured' };

  const { data, error: lookupError } = await db
    .from('crew_members')
    .select('id, display_name, active')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (lookupError) {
    console.error('getCrewCaller: crew_members lookup failed:', lookupError.message);
    return { ok: false, reason: 'unconfigured' };
  }

  const row = data as CrewRow | null;
  if (!row) return { ok: false, reason: 'unlinked' };
  if (!row.active) return { ok: false, reason: 'inactive' };

  return {
    ok: true,
    caller: {
      crewMemberId: row.id,
      authUserId: user.id,
      displayName: row.display_name,
      active: row.active,
    },
  };
}

/** Maps a failed lookup to the response a route should return directly. */
export function crewDenialResponse(reason: Exclude<CrewLookup, { ok: true }>['reason']): NextResponse {
  switch (reason) {
    case 'unauthenticated':
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    case 'not_crew':
      return NextResponse.json(
        { error: 'This endpoint is for crew accounts. Office-entered time uses the operator surface.' },
        { status: 403 },
      );
    case 'unlinked':
      return NextResponse.json(
        { error: 'This login is not linked to a crew member yet. An admin must link it before time can be recorded.' },
        { status: 403 },
      );
    case 'inactive':
      return NextResponse.json({ error: 'This crew member is not active.' }, { status: 403 });
    case 'unconfigured':
      return NextResponse.json({ error: 'Auth is not configured' }, { status: 503 });
  }
}

/**
 * Route guard. Returns the caller, or the response to return directly.
 *
 *   const auth = await requireCrew();
 *   if ('response' in auth) return auth.response;
 *   const { crewMemberId } = auth.caller;
 */
export async function requireCrew(): Promise<{ caller: CrewCaller } | { response: NextResponse }> {
  const lookup = await getCrewCaller();
  if (lookup.ok) return { caller: lookup.caller };
  return { response: crewDenialResponse(lookup.reason) };
}
