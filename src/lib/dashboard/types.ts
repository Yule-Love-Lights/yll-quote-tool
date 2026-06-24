// Shared types for the dashboard. Kept in one place so metrics, worklist,
// queries, and components all agree on the shape of a dashboard quote row.

/** Service line a quote belongs to (per docs/dashboard/VISION.md §4). */
export type ServiceType = 'holiday' | 'permanent' | 'event';

/** All known service types in canonical display order. */
export const SERVICE_TYPES: readonly ServiceType[] = ['holiday', 'permanent', 'event'] as const;

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
  homeworks_sent_at: string | null;
  homeworks_signed_at: string | null;
  highlevel_contact_id: string | null;
  /** Holiday/permanent/event. NULL on legacy rows; treat NULL as 'holiday'. */
  service_type: ServiceType | null;
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
