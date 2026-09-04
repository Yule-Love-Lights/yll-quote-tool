import type { DashboardQuote, ServiceType } from './types';
import { SERVICE_TYPES } from './types';
import { serviceTypeOf, isTerminalStatus } from './serviceMetrics';
import { reached, settled } from './metrics';

const MS_PER_DAY = 86_400_000;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SERVICE_LABEL: Record<ServiceType, string> = {
  holiday: 'Holiday',
  permanent: 'Permanent',
  event: 'Event',
  permanent_bistro: 'Bistro',
};

function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export type MonthlyRevenuePoint = { key: string; label: string; revenue: number };

/**
 * Booked revenue per month for the trailing `months` window ending at `now`'s
 * month (approved quotes, attributed to their approval month). Always returns
 * exactly `months` buckets in chronological order — empty months are 0 so a
 * chart has a continuous x-axis.
 */
export function monthlyRevenue(quotes: DashboardQuote[], now: Date, months = 12): MonthlyRevenuePoint[] {
  const buckets: MonthlyRevenuePoint[] = [];
  const index = new Map<string, MonthlyRevenuePoint>();
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
    const point = { key, label: `${MONTH_ABBR[m.getUTCMonth()]} '${String(m.getUTCFullYear()).slice(2)}`, revenue: 0 };
    buckets.push(point);
    index.set(key, point);
  }
  for (const q of quotes) {
    if (!q.customer_approved_at || isTerminalStatus(q)) continue; // B7: skip cancelled/declined/abandoned
    const point = index.get(monthKey(q.customer_approved_at));
    if (point) point.revenue += q.total ?? 0;
  }
  return buckets;
}

export type ServiceRevenueSlice = { service: ServiceType; label: string; revenue: number };

/** Booked revenue split by service line (NULL service_type → holiday). Always
 *  returns all three services in canonical order (0 when none). */
export function revenueByService(quotes: DashboardQuote[]): ServiceRevenueSlice[] {
  const totals: Record<ServiceType, number> = { holiday: 0, permanent: 0, event: 0, permanent_bistro: 0 };
  for (const q of quotes) {
    if (!q.customer_approved_at || isTerminalStatus(q)) continue; // B7: skip cancelled/declined/abandoned
    totals[serviceTypeOf(q)] += q.total ?? 0;
  }
  return SERVICE_TYPES.map(s => ({ service: s, label: SERVICE_LABEL[s], revenue: totals[s] }));
}

export type InsightStats = {
  /** approved ÷ (sent-or-approved); always in [0,1]; null if none reached a customer. */
  closeRatio: number | null;
  /** avg total across APPROVED quotes; null if none approved. */
  avgJobValue: number | null;
  /** avg total across ALL quotes; null if no quotes. */
  avgQuoteValue: number | null;
  /** avg days created→approved across approved quotes; null if none approved. */
  timeToCloseDays: number | null;
  /** lifetime booked revenue. */
  totalBooked: number;
};

/** `now` is a parameter so the cooling window is testable; it defaults so
 *  existing callers keep working unchanged. */
export function computeInsightStats(quotes: DashboardQuote[], now: Date = new Date()): InsightStats {
  let reachedCount = 0;
  let approved = 0; // settled approvals — the closeRatio numerator
  let approvedForAverages = 0; // every approval — money and time-to-close
  let approvedTotalSum = 0;
  let allTotalSum = 0;
  let ttcSum = 0;
  let totalBooked = 0;

  for (const q of quotes) {
    allTotalSum += q.total ?? 0;
    // B7 (#110 W7-006): a cancelled/declined/abandoned quote is NOT a win even if it
    // once carried customer_approved_at — exclude it from the booked/approved
    // rollups. Whether it still counts as `reached` is decided by the shared
    // `reached()` helper (WT-48) below, so closeRatio agrees with the
    // homepage KPI strip's conversionRate for the exact same quotes.
    const isApproved = !!q.customer_approved_at && !isTerminalStatus(q);
    // The close ratio counts SETTLED quotes only, the same cohort the homepage
    // KPI strip uses (`settled` in metrics.ts). Sharing this rule is the same
    // reason `reached()` is shared: two screens showing one ratio must not
    // disagree about which quotes it covers.
    const isSettled = settled(q, now);
    if (reached(q) && isSettled) reachedCount += 1;
    if (isApproved) {
      // Money and time-to-close count every approval immediately. Only the
      // RATIO waits for the cohort, because a ratio needs a denominator that
      // has had the same chance to answer.
      if (isSettled) approved += 1;
      approvedTotalSum += q.total ?? 0;
      totalBooked += q.total ?? 0;
      approvedForAverages += 1;
      ttcSum += (new Date(q.customer_approved_at as string).getTime() - new Date(q.created_at).getTime()) / MS_PER_DAY;
    }
  }

  return {
    closeRatio: reachedCount > 0 ? approved / reachedCount : null,
    avgJobValue: approvedForAverages > 0 ? approvedTotalSum / approvedForAverages : null,
    avgQuoteValue: quotes.length > 0 ? allTotalSum / quotes.length : null,
    timeToCloseDays: approvedForAverages > 0 ? ttcSum / approvedForAverages : null,
    totalBooked,
  };
}
