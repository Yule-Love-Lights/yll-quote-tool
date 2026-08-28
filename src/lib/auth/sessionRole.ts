import { createRouteSupabase, isCrewAccount, roleOf } from '@/lib/auth/supabaseServer';

/**
 * The signed-in session's operator role, for server components that show or
 * gate ADMIN-ONLY surfaces (first user: the fleet two-clocks page — Naldo,
 * 2026-08-28: only he and Jason see the GPS-versus-payroll comparison).
 *
 * Fails CLOSED: null when auth is unconfigured, nobody is signed in, or the
 * session is a crew login. Callers treat anything but 'admin' as no access.
 */
export async function getSessionRole(): Promise<'admin' | 'operator' | null> {
  const supabase = await createRouteSupabase();
  if (!supabase) return null;
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  if (isCrewAccount(user.app_metadata)) return null;
  return roleOf(user.app_metadata);
}
