import { DASHBOARD_CONFIG } from './config';
import type { ConversionSplit, DashboardQuote, Kpis } from './types';
import { isTerminalStatus } from './serviceMetrics';

const MS_PER_DAY = 86_400_000;

function daysBetween(later: string, earlier: string): number {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / MS_PER_DAY;
}

/** Phone → national digits for grouping. GHL stores E.164 ('+16315550100'),
 *  forms store 10 digits; strip only the 11-digit NANP leading 1 so the two
 *  group as one person (not a blind last-10, which would merge unrelated
 *  international numbers). Null when there are no digits, so it falls through to
 *  name rather than keying on junk. Mirrors normalizePhone in lib/customers.ts. */
function nationalDigits(v: string): string | null {
  const digits = v.replace(/\D/g, '');
  if (!digits.length) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** Stable customer key: HL contact id wins; otherwise email, phone, then name.
 *  Shared with the Customers aggregation (lib/dashboard/customers.ts). Email,
 *  phone, and name are all normalized the same way customerMatchKey does (email
 *  lowercased + trimmed, phone to its national number, name lowercased +
 *  trimmed), so the same person counts once regardless of case or format. It's a
 *  grouping key only, never displayed. */
export function customerKey(q: DashboardQuote): string {
  if (q.highlevel_contact_id) return q.highlevel_contact_id;
  const email = q.customer_email?.trim();
  if (email) return email.toLowerCase();
  const phone = q.customer_phone ? nationalDigits(q.customer_phone) : null;
  if (phone) return phone;
  const name = q.customer_name?.trim();
  return name ? name.toLowerCase() : `__unknown_${q.id}`;
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
 * in a terminal state (cancelled/declined/abandoned). Approval implies it reached
 * them even when quote_sent_at was never stamped (in-person / imported /
 * offline close). A terminal quote that was never sent has NOT reached anyone.
 */
export function reached(q: DashboardQuote): boolean {
  return !!q.quote_sent_at || (!!q.customer_approved_at && !isTerminalStatus(q));
}

/**
 * A quote belongs to a YLL Neighbor when EITHER flag says so (Naldo's rule,
 * 2026-09-03). The two disagree on real data and both are right about
 * something: `is_yll_neighbor` is the staff-editable tag on the customer
 * (#198), so it follows the person into future quotes; `legacy_rebook` is
 * frozen on the quote by last season's Jobber migration (#155/#181), and a
 * lot of older neighbors carry only that one. Taking either avoids reading
 * an untagged returning customer as a cold lead.
 *
 * Undefined reads as false, so a surface that does not select the flags gets
 * "regular" rather than a crash.
 */
export function isNeighbor(q: DashboardQuote): boolean {
  return q.is_yll_neighbor === true || q.legacy_rebook === true;
}

function split(reachedN: number, approvedN: number): ConversionSplit {
  return { reached: reachedN, approved: approvedN, rate: reachedN > 0 ? approvedN / reachedN : null };
}

/**
 * Has this quote had long enough to be answered? Conversion counts outcomes,
 * and a quote sent yesterday has no outcome yet: it is undecided, not lost.
 * Counting it as a miss makes every send wave depress whichever group was
 * just mailed, which is a clock rather than a signal.
 *
 * The window is a COHORT: a quote enters conversion once it was sent at least
 * DASHBOARD_CONFIG.conversionCoolingDays ago, and then whatever happened to it
 * counts, win or lose. Deliberately not "count recent wins, ignore recent
 * losses", which would quietly flatter the rate.
 *
 * A quote approved with no send date is an offline close. It is already
 * decided, so it counts immediately.
 *
 * Shared with computeInsightStats' closeRatio (insights.ts) for the same
 * reason `reached()` is shared: two screens showing the same ratio must not
 * disagree about which quotes it covers (WT-48).
 */
export function settled(q: DashboardQuote, now: Date): boolean {
  if (!q.quote_sent_at) return true;
  const ageMs = now.getTime() - new Date(q.quote_sent_at).getTime();
  return ageMs >= DASHBOARD_CONFIG.conversionCoolingDays * MS_PER_DAY;
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
  let turnaroundExcluded = 0; // sent, but marked a backlog send — see isNeighbor's sibling note below
  let reachedNeighbor = 0;
  let approvedNeighbor = 0;
  let pendingRecent = 0; // reached, but too recently sent to have an outcome yet
  const activeCustomerKeys = new Set<string>();

  for (const q of quotes) {
    const approvedAt = q.customer_approved_at;
    const sentAt = q.quote_sent_at;
    const total = q.total ?? 0;

    // B7 fix: exclude terminal-state orders (cancelled/declined/abandoned) from
    // booked revenue even when customer_approved_at or deposit_paid_at is set.
    // isTerminalStatus requires `status` to be selected by DASHBOARD_QUOTES_SELECT.
    const isTerminal = isTerminalStatus(q);

    if (approvedAt && !isTerminal) {
      bookedRevenue += total;
      const approvedMs = new Date(approvedAt).getTime();
      if (approvedMs >= recentCutoff) bookedRevenueRecent += total;
      // Conversion counts only settled quotes, so an approval inside the
      // cooling window waits with its own cohort rather than being counted
      // while its unanswered siblings are not.
      if (settled(q, now)) {
        approvedCount += 1;
        if (isNeighbor(q)) approvedNeighbor += 1;
      }
    }

    // A quote "reached the customer" — shared rule (WT-48), see `reached()` above.
    if (reached(q)) {
      if (settled(q, now)) {
        reachedCount += 1;
        if (isNeighbor(q)) reachedNeighbor += 1;
      } else {
        pendingRecent += 1;
      }
    }

    if (sentAt) {
      // Avg turnaround uses created→sent for every sent quote (no window),
      // EXCEPT a backlog send: a quote built weeks earlier and held until a
      // send wave measures a scheduling decision, not how fast we answered
      // anyone. Excluding it here and nowhere else keeps it a full member of
      // conversion, revenue and the active-quote count above and below.
      // The excluded count rides along on the KPI so the card can say what it
      // left out. migrations/2026-09-03-quote-backlog-send.sql.
      if (q.backlog_send_at) {
        turnaroundExcluded += 1;
      } else {
        turnaroundSum += daysBetween(sentAt, q.created_at);
        turnaroundN += 1;
      }

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
    turnaroundExcluded,
    conversionPendingRecent: pendingRecent,
    conversionNeighbor: split(reachedNeighbor, approvedNeighbor),
    conversionRegular: split(reachedCount - reachedNeighbor, approvedCount - approvedNeighbor),
  };
}
