import { getSupabaseServiceClient } from '@/lib/supabase';

// advertising_activity: the append-only audit trail. This module is the ONLY
// door — insert and select, nothing else, matching dashboard_activity.
//
// ACTOR CONVENTION (who acted, stored as text):
//   * an auth.users id for admin/review actions (accept, reject, rate_changed)
//   * an advertising_workers id for worker actions (submitted, resubmitted) —
//     those rows also carry worker_id, so reports should resolve identity
//     through worker_id and treat actor as corroboration
//   * 'system' for automated writes
// A report that joins actor against auth.users must therefore filter to the
// review actions first; joining every row would silently drop worker actions.

export type AdvertisingActivityEntry = {
  id: string;
  actor: string | null;
  action: string;
  placementId: string | null;
  workerId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

type Row = {
  id: string;
  actor: string | null;
  action: string;
  placement_id: string | null;
  worker_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
};

const SELECT = 'id, actor, action, placement_id, worker_id, detail, created_at';

/** Best-effort audit append. Never throws: the state change it describes has
 * already landed, and failing the caller over a lost audit row would leave a
 * retry hitting "already accepted" (the clockOut auto-close posture). */
export async function logAdvertisingActivity(entry: {
  actor: string;
  action: string;
  placementId?: string | null;
  workerId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const db = getSupabaseServiceClient();
  if (!db) return;
  try {
    const { error } = await db.from('advertising_activity').insert({
      actor: entry.actor,
      action: entry.action,
      placement_id: entry.placementId ?? null,
      worker_id: entry.workerId ?? null,
      detail: entry.detail ?? null,
    });
    if (error) console.error('logAdvertisingActivity error:', error);
  } catch (error) {
    console.error('logAdvertisingActivity error:', error);
  }
}

/** Recent audit rows, newest first, optionally scoped to one placement or
 * worker. Bounded read: this is a trail viewer, not an export. */
export async function listAdvertisingActivity(opts?: {
  placementId?: string;
  workerId?: string;
  limit?: number;
}): Promise<AdvertisingActivityEntry[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
  let query = db.from('advertising_activity').select(SELECT);
  if (opts?.placementId) query = query.eq('placement_id', opts.placementId.trim());
  if (opts?.workerId) query = query.eq('worker_id', opts.workerId.trim());
  const { data, error } = await query.order('created_at', { ascending: false }).range(0, limit - 1);
  if (error) {
    console.error('listAdvertisingActivity error:', error);
    return [];
  }
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    placementId: row.placement_id,
    workerId: row.worker_id,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

/** rate_changed audit events for these campaigns since a floor time, for
 * the worker earnings view's "rate changed since you placed these" note
 * (rateChangeNote.ts holds the pure decision; the table read lives HERE,
 * this module's only-door rule). The campaign id rides the event's detail
 * json (see updateAdvertisingCampaign's log call). Newest-first ordering
 * makes the 200-row bound deterministic if it is ever hit; a failed read
 * returns [] so the money view degrades to "no note", never an error. */
export async function listRateChangeEvents(
  campaignIds: string[],
  sinceIso: string,
): Promise<Array<{ campaignId: string; createdAt: string }>> {
  if (campaignIds.length === 0) return [];
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('advertising_activity')
    .select('detail, created_at')
    .eq('action', 'rate_changed')
    .gt('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    console.error('listRateChangeEvents error:', error);
    return [];
  }
  const wanted = new Set(campaignIds);
  const out: Array<{ campaignId: string; createdAt: string }> = [];
  for (const row of data ?? []) {
    const campaignId = (row.detail as { campaignId?: unknown } | null)?.campaignId;
    if (typeof campaignId === 'string' && wanted.has(campaignId)) {
      out.push({ campaignId, createdAt: row.created_at as string });
    }
  }
  return out;
}
