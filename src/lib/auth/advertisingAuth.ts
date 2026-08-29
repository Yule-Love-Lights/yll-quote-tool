import { createRouteSupabase, isAdvertisingAccount } from '@/lib/auth/supabaseServer';
import { getAdvertisingWorkerByAuthUserId, type AdvertisingWorker } from '@/lib/advertising/workers';

// The route-layer half of the advertising population lock (#1043 shipped the
// perimeter half). The perimeter confines an advertising session TO the
// /advertising surface; this confines the /api/advertising surface to
// advertising sessions — operators and admins are refused here on purpose
// (Naldo's ruling: office does not see placement status; admins review
// through /api/admin/advertising, their own door).

export type AdvertisingCaller =
  | { ok: true; worker: AdvertisingWorker }
  | { ok: false; reason: 'unauthenticated' | 'not_advertising' | 'no_worker_row' | 'inactive' };

/**
 * Resolve the current session to its advertising worker, or a named refusal.
 * Fails CLOSED: unconfigured auth reads as unauthenticated.
 */
export async function getAdvertisingCaller(): Promise<AdvertisingCaller> {
  const supabase = await createRouteSupabase();
  if (!supabase) return { ok: false, reason: 'unauthenticated' };

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { ok: false, reason: 'unauthenticated' };
  if (!isAdvertisingAccount(user.app_metadata)) return { ok: false, reason: 'not_advertising' };

  const worker = await getAdvertisingWorkerByAuthUserId(user.id);
  if (!worker) return { ok: false, reason: 'no_worker_row' };
  if (!worker.active) return { ok: false, reason: 'inactive' };
  return { ok: true, worker };
}

/** Map a refusal to its HTTP status: 401 for no session, 403 for a session
 * that is simply not allowed here. */
export function advertisingRefusalStatus(reason: Exclude<AdvertisingCaller, { ok: true }>['reason']): number {
  return reason === 'unauthenticated' ? 401 : 403;
}
