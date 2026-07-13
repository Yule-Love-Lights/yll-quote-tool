import { DASHBOARD_CONFIG } from './config';
import type { DashboardQuote, Kpis } from './types';
import { isTerminalStatus } from './serviceMetrics';

const MS_PER_DAY = 86_400_000;

function daysBetween(later: string, earlier: string): number {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / MS_PER_DAY;
}

/** Stable customer key: HL contact id wins; otherwise email, phone, then name.
 *  Shared with the Customers aggregation (lib/dashboard/customers.ts). */
export function customerKey(q: DashboardQuote): string {
  return q.highlevel_contact_id
    ?? q.customer_email
    ?? q.customer_phone
    ?? q.customer_name
    ?? `__unknown_${q.id}`;
}

/**
 * WT-48 (dashboard-insights reconciliation): the single "reached the customer"
 * rule shared by the homepage KPI strip's conversionRate (computeKpis, below)
 * and Insights' closeRatio (computeInsightStats in insights.ts). Before this
 * fix the two surfaces disagreed — computeKpis counted `customer_approved_at`
 * alone as reached with no terminal check, while computeInsightStats required
 * (approved && !terminal) — so a cancelled-but-once-approved quote could be
 * "reached" on one surface and not the other.
 *
 * A quote reached the customer if it was sent, OR it was approved while not
 * in a terminal state (cancelled/declined/lost). Approval implies it reached
 * them even when quote_sent_at was never stamped (in-person / imported /
 * offline close). A terminal quote that was never sent has NOT reached anyone.
 */
export function reached(q: DashboardQuote): boolean {
  return !!q.quote_sent_at || (!!q.customer_approved_at && !isTerminalStatus(q));
}

export function computeKpis(quotes: DashboardQuote[], now: Date): Kpis {
  const nowMs = now.getTime();
  const recentCutoff = nowMs - DASHBOARD_CONFIG.recentlyBookedWindowDays * MS_PER_DAY;
  const activeCutoff = nowMs - DASHBOARD_CONFIG.activeQuoteWindowDays * MS_PER_DAY;

  let bookedRevenue = 0;
  let bookedRevenueRecent = 0;
  let activeQuotes = 0;
  let reachedCount = 0; // quotes that reached the customer, per `reached()` — conversion denominator
  let approvedCount = 0;
  let turnaroundSum = 0;
  let turnaroundN = 0;
  const activeCustomerKeys = new Set<string>();

  for (const q of quotes) {
    const approvedAt = q.customer_approved_at;
    const sentAt = q.quote_sent_at;
    const total = q.total ?? 0;

    // B7 fix: exclude terminal-state orders (cancelled/declined/lost) from
    // booked revenue even when customer_approved_at or deposit_paid_at is set.
    // isTerminalStatus requires `status` to be selected by DASHBOARD_QUOTES_SELECT.
    const isTerminal = isTerminalStatus(q);

    if (approvedAt && !isTerminal) {
      bookedRevenue += total;
      const approvedMs = new Date(approvedAt).getTime();
      if (approvedMs >= recentCutoff) bookedRevenueRecent += total;
      approvedCount += 1;
    }

    // A quote "reached the customer" — shared rule (WT-48), see `reached()` above.
    if (reached(q)) reachedCount += 1;

    if (sentAt) {
      // Avg turnaround uses created→sent for every sent quote (no window).
      turnaroundSum += daysBetween(sentAt, q.created_at);
      turnaroundN += 1;

      const sentMs = new Date(sentAt).getTime();
      if (!approvedAt && sentMs >= activeCutoff) {
        activeQuotes += 1;
        activeCustomerKeys.add(customerKey(q));
      }
    }
  }

  return {
    bookedRevenue,
    bookedRevenueRecent,
    activeQuotes,
    activeCustomers: activeCustomerKeys.size,
    avgTurnaroundDays: turnaroundN > 0 ? turnaroundSum / turnaroundN : null,
    conversionRate: reachedCount > 0 ? approvedCount / reachedCount : null,
  };
}
