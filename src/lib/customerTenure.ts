import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { getCustomer } from './customers';

// Customer tenure ("years with YLL", #178): staff want to see, at a glance,
// how many and which years a customer has worked with YLL — it informs the
// returning-customer free-spritzers offer and call tone.
//
// years = AUTO-DERIVED ∪ MANUAL (customers.manual_years, migrations/2026-07-
// 28-customers-manual-years.sql). Derived years come from real evidence (a
// paid deposit, or a migrated legacy-rebook row) and are never removable via
// the manual-years editor; manual years are staff-entered for history this
// tool has no quote row for and stay editable/removable.

export type TenureQuoteSource = {
  deposit_paid_at: string | null;
  /** Optional: a source that can't select it (shouldn't happen in practice —
   *  getTenureQuotes always selects it) is treated as no legacy-rebook evidence. */
  legacy_rebook?: boolean | null;
};

export type TenureResult = {
  /** Every tenure year, ascending, derived ∪ manual, deduped. */
  years: number[];
  count: number;
  /** Years in `years` backed ONLY by a manual entry — removable (no derived evidence). */
  manualYears: number[];
  /** Years in `years` backed by real quote evidence — never removable. */
  derivedYears: number[];
};

// No customer of ours predates this; nothing here is real tenure evidence.
// YLL started business in 2022 (Jason locked, ledger #200) — was 2015 until
// #200 moved it. Exported so the tenure-years write route (POST /api/
// customers/[customerId]/tenure-years) enforces the SAME floor on input,
// instead of a second magic number. CustomerTenureEditor.tsx (a 'use client'
// component) can't import this const — importing anything from this module
// would drag getSupabaseServiceClient's SUPABASE_SERVICE_ROLE_KEY read into
// the client bundle (the #52 sharp-in-client-bundle pitfall) — so its two
// literal 2022s must be kept in sync with this value by hand.
export const MIN_TENURE_YEAR = 2022;

// Legacy rebook rows (#155) are unsent drafts the #155-158 bulk migration
// created FROM last year's real Jobber invoices — the row itself never went
// through send/approve/deposit, so its own timestamps (created_at etc.) are
// just when the 2026 migration ran, NOT when the job happened. They always
// stand in for a 2025-season job (migrations/2026-07-16-legacy-rebook.sql).
const LEGACY_REBOOK_YEAR = 2025;

/**
 * Pure: derive this customer's tenure year set from their quotes + the
 * customers.manual_years jsonb override (validated here — an untrusted DB
 * value could be old/hand-edited junk). `now` is injected (never a bare
 * `new Date()` in the core logic) so callers/tests stay deterministic,
 * mirroring src/lib/dashboard/metrics.ts's computeKpis(quotes, now).
 */
export function deriveTenureYears(
  quotes: TenureQuoteSource[],
  manualYearsRaw: unknown,
  now: Date,
): TenureResult {
  // getUTCFullYear (not getFullYear) — same convention as
  // src/lib/dashboard/insights.ts / serviceMetrics.ts, so the derived year
  // doesn't drift with the server/dev machine's local timezone.
  const currentYear = now.getUTCFullYear();
  const derived = new Set<number>();

  for (const q of quotes) {
    if (q.deposit_paid_at) {
      const y = new Date(q.deposit_paid_at).getUTCFullYear();
      if (Number.isFinite(y)) derived.add(y);
    }
    if (q.legacy_rebook === true) derived.add(LEGACY_REBOOK_YEAR);
  }

  const manual = validManualYears(manualYearsRaw, currentYear);
  const manualSet = new Set(manual);

  const years = Array.from(new Set<number>([...derived, ...manualSet])).sort((a, b) => a - b);
  // A year staff also manually added is still evidence-backed (not removable)
  // once derived evidence exists for it — "manual" here means ONLY removable.
  const manualYears = years.filter((y) => manualSet.has(y) && !derived.has(y));
  const derivedYears = years.filter((y) => derived.has(y));

  return { years, count: years.length, manualYears, derivedYears };
}

// Keep only integers in a plausible range (MIN_TENURE_YEAR..currentYear —
// never a future year); drop anything else (strings, floats, out-of-range)
// rather than rejecting the whole array — a stray junk entry shouldn't hide
// the rest.
function validManualYears(raw: unknown, currentYear: number): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= MIN_TENURE_YEAR && v <= currentYear) {
      out.push(v);
    }
  }
  return out;
}

// Standard English ordinal suffix (1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st…).
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Compact display for the QuoteBuilder header chip — null when there's no
 *  tenure history yet (chip hidden entirely, per #178 spec). */
export function tenureChipLabel(result: TenureResult): string | null {
  if (result.years.length === 0) return null;
  return `${ordinal(result.count)} year — ${result.years.join(' · ')}`;
}

/** Header line for the customer profile page — "New customer" when empty. */
export function tenureHeaderLabel(result: TenureResult): string {
  if (result.years.length === 0) return 'New customer';
  return `${result.count} year${result.count === 1 ? '' : 's'} with YLL — ${result.years.join(' · ')}`;
}

function svc() {
  return getSupabaseServiceClient() ?? getSupabaseClient();
}

/**
 * This customer's tenure-relevant quote rows (deposit + legacy-rebook flag
 * only — nothing else is needed to compute years). Matches EITHER id kind,
 * same precedence as matchesCustomerRoute (src/lib/dashboard/customers.ts),
 * so a quote that predates the customer-id backfill (HL-linked only) still
 * counts. Excludes is_test/view_only rows — same chokepoint filter as
 * listQuotesForDashboardResult (ledger #93 / #176): neither is real
 * operational history. Two plain `.eq()` reads + a dedupe-by-id, rather than
 * a hand-built `.or()` filter string, so there's no PostgREST-injection
 * surface for the id values.
 */
export async function getTenureQuotes(
  customerId: string | null,
  hlContactId: string | null,
): Promise<TenureQuoteSource[]> {
  if (!customerId && !hlContactId) return [];
  const sb = svc();
  if (!sb) return [];

  const byId = new Map<string, TenureQuoteSource>();
  const base = () =>
    sb.from('quotes').select('id, deposit_paid_at, legacy_rebook').eq('is_test', false).eq('view_only', false);

  // Both id branches are independent reads (different filter columns) — run
  // them concurrently rather than sequentially awaiting one before the other.
  const [byCustomerId, byHlContactId] = await Promise.all([
    customerId ? base().eq('customer_id', customerId) : Promise.resolve({ data: [], error: null }),
    hlContactId ? base().eq('highlevel_contact_id', hlContactId) : Promise.resolve({ data: [], error: null }),
  ]);

  if (byCustomerId.error) console.error('getTenureQuotes (customer_id) error:', byCustomerId.error);
  for (const row of (byCustomerId.data ?? []) as Array<{ id: string; deposit_paid_at: string | null; legacy_rebook: boolean | null }>) {
    byId.set(row.id, row);
  }
  if (byHlContactId.error) console.error('getTenureQuotes (highlevel_contact_id) error:', byHlContactId.error);
  for (const row of (byHlContactId.data ?? []) as Array<{ id: string; deposit_paid_at: string | null; legacy_rebook: boolean | null }>) {
    byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

/**
 * Combines the quotes read + the customers.manual_years read + the pure
 * derivation, so every surface (customer profile page, QuoteBuilder header
 * chip) agrees on the same tenure math. Returns the empty result (not an
 * error) when neither id is known — "no linked customer" isn't a failure.
 */
export async function getCustomerTenure(
  customerId: string | null,
  hlContactId: string | null,
  now: Date,
): Promise<TenureResult> {
  const [quotes, customer] = await Promise.all([
    getTenureQuotes(customerId, hlContactId),
    customerId ? getCustomer(customerId) : Promise.resolve(null),
  ]);
  return deriveTenureYears(quotes, customer?.manual_years, now);
}
