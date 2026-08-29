// "Rate changed since you placed these" (ops suggestions round). Pending
// money is estimated at the campaign's CURRENT rate, so a rate edit moves a
// worker's pending figure with no explanation; the rate_changed audit rows
// (campaigns.ts) are the signal that makes a one-line explanation honest.

import { getSupabaseServiceClient } from '@/lib/supabase';

export type PendingRowTime = { campaignId: string; at: string };
export type RateChangeEvent = { campaignId: string; createdAt: string };

/** PURE: did any campaign's rate change AFTER one of these pending rows was
 * captured? Unparseable timestamps disqualify their row/event rather than
 * guessing. */
export function hasPendingRateChange(pending: PendingRowTime[], events: RateChangeEvent[]): boolean {
  if (pending.length === 0 || events.length === 0) return false;
  const earliestByCampaign = new Map<string, number>();
  for (const p of pending) {
    const t = Date.parse(p.at);
    if (Number.isNaN(t)) continue;
    const prev = earliestByCampaign.get(p.campaignId);
    if (prev === undefined || t < prev) earliestByCampaign.set(p.campaignId, t);
  }
  for (const e of events) {
    const t = Date.parse(e.createdAt);
    if (Number.isNaN(t)) continue;
    const earliest = earliestByCampaign.get(e.campaignId);
    if (earliest !== undefined && t > earliest) return true;
  }
  return false;
}

/** rate_changed audit events for these campaigns since a floor time. The
 * campaign id lives in the event's detail json (campaigns.ts writes it
 * there); a failed read returns [] so the earnings view degrades to "no
 * note" instead of an error. */
export async function listRateChangeEvents(
  campaignIds: string[],
  sinceIso: string,
): Promise<RateChangeEvent[]> {
  if (campaignIds.length === 0) return [];
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('advertising_activity')
    .select('detail, created_at')
    .eq('action', 'rate_changed')
    .gt('created_at', sinceIso)
    .limit(200);
  if (error) {
    console.error('listRateChangeEvents error:', error);
    return [];
  }
  const wanted = new Set(campaignIds);
  const out: RateChangeEvent[] = [];
  for (const row of data ?? []) {
    const campaignId = (row.detail as { campaignId?: unknown } | null)?.campaignId;
    if (typeof campaignId === 'string' && wanted.has(campaignId)) {
      out.push({ campaignId, createdAt: row.created_at as string });
    }
  }
  return out;
}
