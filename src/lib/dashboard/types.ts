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
  total: number | null;
  created_at: string;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  /** Valor deposit-paid timestamp — set = "booked" (the #38 deposit flow). */
  deposit_paid_at: string | null;
  homeworks_sent_at: string | null;
  homeworks_signed_at: string | null;
  highlevel_contact_id: string | null;
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
  /** YLL Neighbor migrated-rebook flag (#155/#181). Optional: not every surface
   *  selects it. The quotetool inbox adapter reads it to suppress the parked
   *  send-wave drafts (legacy_rebook=true, unsent) from the inbox — every other
   *  dashboard surface still counts these as real pipeline. */
  legacy_rebook?: boolean | null;
  /** YLL Neighbor tag on the CUSTOMER row (customers.is_yll_neighbor, #198),
   *  flattened onto the quote by the dashboard read. Optional: surfaces that
   *  do not join customers leave it undefined, which reads as not a neighbor.
   *  Naldo's rule (2026-09-03): this OR legacy_rebook makes a quote a
   *  neighbor quote — see isNeighbor in metrics.ts. */
  is_yll_neighbor?: boolean | null;
  /** Set when this quote was built, held, and sent later as part of a wave —
   *  the created→sent gap was a scheduling decision, not a response time.
   *  Excluded from the turnaround average ONLY; counted everywhere else.
   *  migrations/2026-09-03-quote-backlog-send.sql. */
  backlog_send_at?: string | null;
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
  /** Conversion = approved ÷ (quotes that reached a customer = sent OR approved).
   *  Always in [0,1]; null if no quote qualifies. Counting approved-but-never-sent
   *  quotes in the denominator avoids a >100% rate.
   *
   *  Covers SETTLED quotes only: those sent at least
   *  DASHBOARD_CONFIG.conversionCoolingDays ago, plus offline closes that were
   *  approved without a send date. A quote sent yesterday is undecided, not
   *  lost. See `settled` in metrics.ts. */
  conversionRate: number | null;
  /** How many sent quotes the turnaround average left out because they were
   *  marked as backlog sends. Shown on the KPI card so the average is never
   *  quietly narrower than the population it claims to describe. */
  turnaroundExcluded: number;
  /** Quotes that reached a customer too recently to have an outcome yet, so
   *  they are in none of the three rates above. Shown on the card, because a
   *  rate that silently ignores part of the pipeline invites the same misread
   *  it was built to prevent. */
  conversionPendingRecent: number;
  /** Conversion for quotes belonging to YLL Neighbors (isNeighbor). */
  conversionNeighbor: ConversionSplit;
  /** Conversion for everyone else. Neighbor + regular reconcile exactly to
   *  the overall conversionRate's numerator and denominator. */
  conversionRegular: ConversionSplit;
};

/** One side of the neighbor/regular conversion split. `rate` is
 *  approved/reached, or null when nobody in this group was reached — a null
 *  says "no data", which a bare 0% would misreport as a total failure. */
export type ConversionSplit = {
  reached: number;
  approved: number;
  rate: number | null;
};

/** Kinds of worklist rows. Phase 1 ships two; more added in later phases. */
export type WorklistKind =
  | 'draft-stale'      // not approved, never sent, age ≥ config.draftStaleDays
  | 'sent-no-reply';   // sent, not approved, age ≥ config.sentNoReplyStaleDays

export type WorklistItem = {
  kind: WorklistKind;
  quoteId: string;
  /** Human-friendly quote # (#83) so a customer with several concurrent quotes
   *  is distinguishable at a glance (WT-40). Null on legacy rows with no
   *  allocated number. */
  quoteNumber: number | null;
  /** Service line (holiday/permanent/event/...) — same disambiguation reason
   *  as quoteNumber (WT-40). */
  serviceType: ServiceType | null;
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
  /** Holiday quotes sent but not yet approved (still in the funnel) — same
   *  sent-not-approved definition Permanent/Event/Bistro already track (WT-39). */
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
