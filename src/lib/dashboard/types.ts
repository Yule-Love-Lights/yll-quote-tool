// Shared types for the dashboard. Kept in one place so metrics, worklist,
// queries, and components all agree on the shape of a dashboard quote row.

// ServiceType is owned by the canonical src/lib/serviceType.ts (so the quote
// builder + data layer + dashboard share one definition). Re-exported here so
// existing dashboard imports from './types' keep working.
export { type ServiceType, SERVICE_TYPES } from '@/lib/serviceType';
import type { ServiceType } from '@/lib/serviceType';
import type { QuoteStatus } from '@/lib/quoteStatus';

/** A `quotes` row trimmed to the columns the dashboard actually reads. */
export type DashboardQuote = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  /** Property/service address (WT-52). Optional, since not all surfaces
   *  select it; the dashboard chokepoint (DASHBOARD_QUOTES_SELECT) does. */
  customer_address?: string | null;
  total: number | null;
  created_at: string;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  /** Valor deposit-paid timestamp — set = "booked" (the #38 deposit flow). */
  deposit_paid_at: string | null;
  homeworks_sent_at: string | null;
  homeworks_signed_at: string | null;
  highlevel_contact_id: string | null;
  /** Property address for this quote. Optional: not every surface selects it;
   *  the customer detail page adds it via DASHBOARD_QUOTES_SELECT (WT-52) to
   *  show + group a multi-property customer's history by address. */
  customer_address?: string | null;
  /** Holiday/permanent/event. NULL on legacy rows; treat NULL as 'holiday'. */
  service_type: ServiceType | null;
  /**
   * Persisted status column (B7 fix: required so deriveStatus can identify
   * terminal states like 'cancelled' that timestamps alone can't express).
   * Optional for backward-compat with tests that don't set it.
   */
  status?: QuoteStatus | null;
  /** Customer first-viewed timestamp (#68). Optional — not all surfaces select it. */
  viewed_at?: string | null;
  /** Stable customer id (rebook Part D). Optional — surfaces that don't select it
   *  (e.g. the dashboard KPI path) leave it undefined; the customer detail page
   *  adds it via DASHBOARD_QUOTES_SELECT. */
  customer_id?: string | null;
  /** Sequential display number (#83, SPEC §4.6) — the human-friendly `#1010`.
   *  Optional: NULL on legacy rows / surfaces that don't select it; the customers
   *  detail page adds it via DASHBOARD_QUOTES_SELECT and falls back to the
   *  truncated UUID when absent. */
  quote_number?: number | null;
};

/** The 5 KPIs shown in the header strip. */
export type Kpis = {
  /** Lifetime booked revenue: sum of `total` where customer_approved_at is set. */
  bookedRevenue: number;
  /** Revenue booked in the trailing N days (config.recentlyBookedWindowDays). */
  bookedRevenueRecent: number;
  /** Count of quotes that are sent but not yet approved AND sent within the active window. */
  activeQuotes: number;
  /** Distinct customers (by HL contact id, falling back to email/phone/name) with an active quote. */
  activeCustomers: number;
  /** Average days between created_at and quote_sent_at across all sent quotes; null if no sent quotes. */
  avgTurnaroundDays: number | null;
  /** Conversion = approved ÷ (quotes that reached a customer = sent OR approved),
   *  all-time. Always in [0,1]; null if no quote has reached a customer. Counting
   *  approved-but-never-sent quotes in the denominator avoids a >100% rate. */
  conversionRate: number | null;
};

/** Kinds of worklist rows. Phase 1 ships two; more added in later phases. */
export type WorklistKind =
  | 'draft-stale'      // not approved, never sent, age ≥ config.draftStaleDays
  | 'sent-no-reply';   // sent, not approved, age ≥ config.sentNoReplyStaleDays

export type WorklistItem = {
  kind: WorklistKind;
  quoteId: string;
  title: string;        // e.g. "Smith family — 1234 Main St"
  subtitle: string;     // e.g. "Drafted 3 days ago"
  ageDays: number;
  href: string;         // deep link that resolves the row
};

/** Holiday section: bookings/installs by install-month bucket. */
export type HolidayBreakdown = {
  /** Total approved holiday quotes (lifetime). */
  bookedTotal: number;
  /** Total holiday quotes whose home.works signature is recorded (proxy for "installed"). */
  installedTotal: number;
  /** Holiday quotes sent but not yet approved (still in the funnel). */
  pending: number;
  /** Bookings + installed per install-month for the current season (Sep–Feb window). */
  byMonth: ReadonlyArray<{
    /** Month label, e.g. "Sep 2026". */
    label: string;
    /** YYYY-MM key for stable sorting. */
    key: string;
    booked: number;
    installed: number;
  }>;
  /** Season goal (configurable) and current count toward it. */
  goal: { booked: number; goal: number };
};

/** Permanent section: in-care recurring base. */
export type PermanentSummary = {
  /** All approved permanent quotes (treated as the recurring base — Permanent never archives). */
  inCare: number;
  /** Permanent quotes sent but not yet approved (still in the funnel). */
  pending: number;
  /** Lifetime revenue from approved permanent quotes. */
  bookedRevenue: number;
};

/** Event section: simple funnel + revenue. */
export type EventSummary = {
  /** Approved event quotes. */
  booked: number;
  /** Sent + not-yet-approved event quotes. */
  pending: number;
  /** Lifetime approved event revenue. */
  bookedRevenue: number;
};

/** Bistro section (#117): same simple funnel + revenue shape as event —
 *  permanent bistro is a one-off install product, not a recurring base. */
export type BistroSummary = {
  /** Approved bistro quotes. */
  booked: number;
  /** Sent + not-yet-approved bistro quotes. */
  pending: number;
  /** Lifetime approved bistro revenue. */
  bookedRevenue: number;
};

/** The latest lifecycle state of a customer's most recent quote. Now the FULL
 *  canonical status set (BUG-1, S22): the old draft|sent|approved triple came
 *  from a timestamp-only `statusOf`, so a declined/cancelled/booked quote read
 *  as a stale 'sent'/'approved'. Aliased to QuoteStatus so the customers list +
 *  detail history show the same badge the admin list + Workflow board do. */
export type CustomerStatus = QuoteStatus;

/** One customer = all quotes that share a stable customer key (#58 Phase 3).
 *  Aggregated from the quotes table — no separate customers table. */
export type CustomerSummary = {
  /** Stable grouping key (HL contact id, else email/phone/name). */
  key: string;
  /** HL contact id when present — the preferred detail-route id; null when this
   *  customer was never linked to HighLevel. */
  contactId: string | null;
  /** Stable customer_id (from the rebook backfill) — the detail-route id fallback
   *  so a customer with no HL link is STILL clickable to their profile. Null on
   *  pre-backfill legacy quotes that carry neither id. */
  customerId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  /** How many quotes this customer has. */
  quoteCount: number;
  /** Lifetime booked spend = sum of `total` across this customer's APPROVED quotes. */
  bookedSpend: number;
  /** ISO timestamp of their most recent quote (by created_at). */
  latestQuoteAt: string;
  /** Lifecycle status of that most recent quote. */
  latestStatus: CustomerStatus;
  /** Id of that most recent quote (for a deep link). */
  latestQuoteId: string;
};
