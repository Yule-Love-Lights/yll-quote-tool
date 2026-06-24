// Shared types for the dashboard. Kept in one place so metrics, worklist,
// queries, and components all agree on the shape of a dashboard quote row.

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
  /** approved / sent ratio across all-time, as a 0–1 number; null if no sent quotes. */
  conversionRate: number | null;
};

/** Kinds of worklist rows. Phase 1 ships two; more added in later phases. */
export type WorklistKind =
  | 'draft-stale'      // quote created, never sent, > config.draftStaleDays
  | 'sent-no-reply';   // quote sent, not yet approved, > config.sentNoReplyStaleDays

export type WorklistItem = {
  kind: WorklistKind;
  quoteId: string;
  title: string;        // e.g. "Smith family — 1234 Main St"
  subtitle: string;     // e.g. "Drafted 3 days ago"
  ageDays: number;
  href: string;         // deep link that resolves the row
};
