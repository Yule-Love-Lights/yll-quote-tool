// "Rate changed since you placed these" (ops suggestions round). Pending
// money is estimated at the campaign's CURRENT rate, so a rate edit moves a
// worker's pending figure with no explanation; the rate_changed audit rows
// (campaigns.ts) are the signal that makes a one-line explanation honest.
// PURE module: the audit-table read lives in activity.ts
// (listRateChangeEvents), which owns every advertising_activity access —
// the technical lens caught the first cut querying the table from here,
// drifting past that module's stated only-door boundary.

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

