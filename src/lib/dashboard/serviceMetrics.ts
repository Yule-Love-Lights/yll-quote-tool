import { DASHBOARD_CONFIG } from './config';
import type {
  DashboardQuote,
  EventSummary,
  HolidayBreakdown,
  PermanentSummary,
  ServiceType,
} from './types';
import { deriveStatus } from '@/lib/quoteStatus';

/**
 * B7 fix: returns true when a quote is in a terminal state (cancelled/declined/
 * lost). Terminal orders must not count toward booked/inCare/installed counts
 * or revenue even when customer_approved_at or deposit_paid_at is set.
 * Requires `status` to be present on the row (selected by DASHBOARD_QUOTES_SELECT).
 * Exported so insights.ts (#110 W7-006) reuses the exact same revenue-terminal set.
 */
export function isTerminalStatus(q: DashboardQuote): boolean {
  const s = deriveStatus(q);
  return s === 'cancelled' || s === 'declined' || s === 'lost';
}

/** NULL service_type rows are Holiday (the legacy default). */
export function serviceTypeOf(q: DashboardQuote): ServiceType {
  return q.service_type ?? 'holiday';
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function monthKey(iso: string): string {
  // YYYY-MM (UTC) — stable string sort = chronological sort.
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthLabel(key: string): string {
  // key = 'YYYY-MM'; turn into 'Sep 2026'.
  const [y, m] = key.split('-');
  return `${MONTH_LABELS[Number(m) - 1]} ${y}`;
}

export function computeHolidayBreakdown(quotes: DashboardQuote[]): HolidayBreakdown {
  let bookedTotal = 0;
  let installedTotal = 0;
  const buckets = new Map<string, { booked: number; installed: number }>();

  for (const q of quotes) {
    if (serviceTypeOf(q) !== 'holiday') continue;
    if (!q.customer_approved_at) continue;
    if (isTerminalStatus(q)) continue; // B7 fix: exclude cancelled/declined/lost

    bookedTotal += 1;

    // Install-month bucket: prefer the install proxy (homeworks_signed_at)
    // for the month attribution if present; otherwise group by approval month
    // so the section shows the booking even before install is confirmed.
    const monthIso = q.homeworks_signed_at ?? q.customer_approved_at;
    const key = monthKey(monthIso);
    const bucket = buckets.get(key) ?? { booked: 0, installed: 0 };
    bucket.booked += 1;
    if (q.homeworks_signed_at) {
      bucket.installed += 1;
      installedTotal += 1;
    }
    buckets.set(key, bucket);
  }

  const byMonth = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({ key, label: monthLabel(key), booked: v.booked, installed: v.installed }));

  return {
    bookedTotal,
    installedTotal,
    byMonth,
    goal: { booked: bookedTotal, goal: DASHBOARD_CONFIG.holidaySeasonGoalHomes },
  };
}

export function computePermanentSummary(quotes: DashboardQuote[]): PermanentSummary {
  let inCare = 0;
  let pending = 0;
  let bookedRevenue = 0;

  for (const q of quotes) {
    if (serviceTypeOf(q) !== 'permanent') continue;
    if (q.customer_approved_at && !isTerminalStatus(q)) { // B7 fix: exclude cancelled/declined/lost
      inCare += 1;
      bookedRevenue += q.total ?? 0;
    } else if (q.quote_sent_at && !isTerminalStatus(q)) {
      pending += 1;
    }
  }

  return { inCare, pending, bookedRevenue };
}

export function computeEventSummary(quotes: DashboardQuote[]): EventSummary {
  let booked = 0;
  let pending = 0;
  let bookedRevenue = 0;

  for (const q of quotes) {
    if (serviceTypeOf(q) !== 'event') continue;
    if (q.customer_approved_at && !isTerminalStatus(q)) { // B7 fix: exclude cancelled/declined/lost
      booked += 1;
      bookedRevenue += q.total ?? 0;
    } else if (q.quote_sent_at && !isTerminalStatus(q)) {
      pending += 1;
    }
  }

  return { booked, pending, bookedRevenue };
}
