import { DASHBOARD_CONFIG } from './config';
import type { DashboardQuote, Kpis } from './types';
import { isTerminalStatus, reachedCustomer } from './serviceMetrics';

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

export function computeKpis(quotes: DashboardQuote[], now: Date): Kpis {
  const nowMs = now.getTime();
  const recentCutoff = nowMs - DASHBOARD_CONFIG.recentlyBookedWindowDays * MS_PER_DAY;
  const activeCutoff = nowMs - DASHBOARD_CONFIG.activeQuoteWindowDays * MS_PER_DAY;

  let bookedRevenue = 0;
  let bookedRevenueRecent = 0;
  let activeQuotes = 0;
  let reachedCount = 0; // quotes that reached the customer (sent OR approved) — conversion denominator
  let approvedCount = 0;
  let turnaroundSum = 0;
  let turnaroundN = 0;
  const activeCustomerKeys = new Set<string>();

  for (const q of quotes) {
    const approvedAt = q.customer_approved_at;
    const sentAt = q.quote_sent_at;
    const total = q.total ?? 0;

    // B7 fix: terminal-state orders (cancelled/declined/lost) are excluded
    // from booked revenue even when customer_approved_at or deposit_paid_at
    // is set. Shared with serviceMetrics.ts / insights.ts (isTerminalStatus)
    // so every surface agrees on what counts as a win.
    const isTerminal = isTerminalStatus(q);

    if (approvedAt && !isTerminal) {
      bookedRevenue += total;
      const approvedMs = new Date(approvedAt).getTime();
      if (approvedMs >= recentCutoff) bookedRevenueRecent += total;
      approvedCount += 1;
    }

    // A quote "reached the customer" if it was sent OR approved (shared
    // reachedCustomer() — WT-48: keeps this denominator identical to
    // Insights' Close ratio). See its doc comment for why terminal status
    // doesn't gate this. Using this as the conversion denominator also keeps
    // the rate in [0,1].
    if (reachedCustomer(q)) reachedCount += 1;

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
