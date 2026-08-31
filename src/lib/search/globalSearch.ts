// Global operator search (the header search box).
//
// One query string, four groups of results: Customers, Quotes, Jobs, Invoices.
// The caller types a customer name, a phone number, an email, a display number
// ("1262"), or a property address, and every group that can match does.
//
// Ranking rule (Naldo, 2026-08-30): ACTIVE records sort first inside each
// group, but nothing is unfindable. A finished job or a paid invoice still
// appears, below the live ones, because hunting last season's work from the
// header is the other half of why this exists.
//
// Split on purpose: everything above `globalSearch` is pure and unit-tested
// directly. The header and the quote builder have no automated screen
// coverage, so the ranking, the number parsing and the href building all live
// out here where a test can reach them (the AGENTS.md lift-logic-out rule).

import type { SupabaseClient } from '@supabase/supabase-js';

export type SearchKind = 'customer' | 'quote' | 'job' | 'invoice';

export type SearchHit = {
  kind: SearchKind;
  /** Stable React key. Unique across groups. */
  key: string;
  /** Where clicking this hit goes. */
  href: string;
  /** Line one: who this is. */
  title: string;
  /** Line two: the address, the money, whatever else identifies the record. */
  subtitle: string | null;
  /** The display number ("#1262"), or null for a customer. */
  label: string | null;
  /** Lifecycle status, already humanised. Null for a customer. */
  status: string | null;
  /** Open quote, live job, unpaid invoice. Drives the sort, not visibility. */
  active: boolean;
  /** Sort tiebreaker inside a group. ISO timestamp, newest first. */
  sortedAt: string | null;
};

export type SearchResults = {
  customers: SearchHit[];
  quotes: SearchHit[];
  jobs: SearchHit[];
  invoices: SearchHit[];
  /**
   * Which groups had more matches than fit (premerge staff lens, 2026-08-31).
   * Without this the dropdown cannot tell "these are the only six" from "these
   * are six of forty and yours is not among them", which on a common name is
   * the difference between an answer and a wrong answer.
   */
  truncated: Record<SearchKind, boolean>;
};

/** Below this the box does not search at all: one letter matches half the table. */
export const MIN_QUERY_LEN = 2;

/** Per group. The dropdown shows this many; there is no separate results page. */
export const MAX_PER_GROUP = 6;

export function emptyResults(): SearchResults {
  return {
    customers: [],
    quotes: [],
    jobs: [],
    invoices: [],
    truncated: { customer: false, quote: false, job: false, invoice: false },
  };
}

/**
 * Whether a value is safe to interpolate into a PostgREST `.or()` filter.
 * A comma or a parenthesis inside the value would close the current clause and
 * open a second one the caller never intended, so a typed string could rewrite
 * the filter. Mirrors the identical guard in src/app/api/customers/route.ts
 * and src/lib/customers.ts. PURE.
 */
export function safeOrValue(v: string): boolean {
  return !v.includes(',') && !v.includes('(') && !v.includes(')');
}

/**
 * The display number the caller typed, or null when the query is not one.
 * Accepts a bare "1262" and a "#1262", and rejects anything carrying other
 * characters, so "516-555-0123" stays a phone number and never a quote number.
 * PURE.
 */
export function displayNumberToken(q: string): number | null {
  const m = /^#?(\d{1,9})$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The digits of a typed phone number, or null when there are too few for it to
 * be one. Lets "(516) 555-0123" find a row stored as "5165550123". Digits only,
 * so the result is safe for `.or()` by construction. PURE.
 */
export function phoneDigits(q: string): string | null {
  const digits = q.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

/** Quote lifecycle states that are NOT live work. Everything else is active. */
const CLOSED_QUOTE_STATUSES = new Set(['declined', 'cancelled', 'abandoned']);
/** Job lifecycle states that are NOT live work. */
const CLOSED_JOB_STATUSES = new Set(['done', 'cancelled']);
/** Invoice states with nothing left to collect. */
const SETTLED_INVOICE_STATUSES = new Set(['paid', 'cancelled']);

export function isActiveQuote(status: string | null): boolean {
  return !CLOSED_QUOTE_STATUSES.has(status ?? '');
}
export function isActiveJob(status: string | null): boolean {
  return !CLOSED_JOB_STATUSES.has(status ?? '');
}
export function isActiveInvoice(status: string | null): boolean {
  return !SETTLED_INVOICE_STATUSES.has(status ?? '');
}

/** "requires_invoicing" reads as "Requires invoicing" on screen. PURE. */
export function humanStatus(status: string | null): string | null {
  if (!status) return null;
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The customer-profile route id. Prefers the HighLevel contact id and falls
 * back to our own customer uuid, exactly like customerRouteId in
 * src/lib/dashboard/customers.ts, so a search hit lands on the same page every
 * other customer link in the app lands on. PURE.
 */
export function customerHref(row: { id: string; hl_contact_id: string | null }): string {
  return `/customers/${encodeURIComponent(row.hl_contact_id ?? row.id)}`;
}

/**
 * Active first, then newest first. A plain comparison on the ISO timestamps,
 * which sort correctly as strings. PURE.
 */
export function sortHits(hits: SearchHit[]): SearchHit[] {
  return [...hits].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const at = a.sortedAt ?? '';
    const bt = b.sortedAt ?? '';
    if (at === bt) return 0;
    return at > bt ? -1 : 1;
  });
}

/** Every hit in the four groups, in the order the keyboard walks them. PURE. */
export function flattenResults(r: SearchResults): SearchHit[] {
  return [...r.customers, ...r.quotes, ...r.jobs, ...r.invoices];
}

export function totalCount(r: SearchResults): number {
  return flattenResults(r).length;
}

/**
 * Where the arrow keys land next. Wraps at both ends, and -1 (nothing
 * highlighted yet) means Down starts at the first hit and Up starts at the
 * last. Returns -1 for an empty list so the caller never highlights a hit that
 * is not there. PURE.
 */
export function nextIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

type CustomerRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  hl_contact_id: string | null;
  updated_at: string | null;
};

type QuoteRow = {
  id: string;
  quote_number: number | null;
  customer_name: string | null;
  customer_address: string | null;
  status: string | null;
  total: number | null;
  created_at: string | null;
};

type JobRow = {
  id: string;
  job_number: number | null;
  quote_id: string | null;
  status: string | null;
  install_date: string | null;
  created_at: string | null;
};

type InvoiceRow = {
  id: string;
  invoice_number: number | null;
  quote_id: string | null;
  status: string | null;
  balance: number | null;
  total: number | null;
  created_at: string | null;
};

const CUSTOMER_COLUMNS = 'id, name, email, phone, hl_contact_id, updated_at';
const QUOTE_COLUMNS =
  'id, quote_number, customer_name, customer_address, status, total, created_at';
const JOB_COLUMNS = 'id, job_number, quote_id, status, install_date, created_at';
const INVOICE_COLUMNS =
  'id, invoice_number, quote_id, status, balance, total, created_at';

function money(n: number | null): string | null {
  if (n == null) return null;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

/** The `column.ilike.%value%` clauses for one already-safety-checked query. */
function textClauses(q: string, columns: string[]): string {
  return columns.map((c) => `${c}.ilike.%${q}%`).join(',');
}

/** Joins display strings with a middle dot, dropping the empty ones. */
function joinParts(parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => !!p && p.length > 0);
  return kept.length > 0 ? kept.join(' · ') : null;
}

/**
 * Run the search. Every branch is read-only: no inserts, no updates, no RPC.
 *
 * Jobs and invoices carry no customer text of their own (they reference a
 * quote), so they are found two ways: by their own display number, and by
 * belonging to a quote whose text matched. Their customer names come from the
 * quotes they point at, fetched in one extra `in()` read rather than a join,
 * which keeps the whole thing to at most five small queries.
 */
export async function globalSearch(
  sb: SupabaseClient,
  rawQuery: string,
): Promise<SearchResults> {
  const q = rawQuery.trim();
  if (q.length < MIN_QUERY_LEN) return emptyResults();

  const number = displayNumberToken(q);
  const digits = phoneDigits(q);
  // The raw text goes into a filter only when it cannot rewrite one. A phone
  // number typed the way people actually type it, "(516) 555-0123", carries
  // parentheses and fails that check, which is why the digits branch below is
  // NOT merely a nicety: it is the only path that query has. Digits are safe
  // by construction, so the two branches together mean a punctuated query
  // still searches, and an unsafe one with no digits searches nothing.
  const textSafe = safeOrValue(q);
  if (!textSafe && !digits) return emptyResults();

  // --- Customers -----------------------------------------------------------
  const customerClauses: string[] = [];
  if (textSafe) customerClauses.push(textClauses(q, ['name', 'email', 'phone']));
  if (digits) customerClauses.push(`phone.ilike.%${digits}%`);
  const customersRes = await sb
    .from('customers')
    .select(CUSTOMER_COLUMNS)
    .or(customerClauses.join(','))
    .order('updated_at', { ascending: false })
    // One PAST the cap on purpose: the extra row is never rendered, it only
    // answers "is there more than this?" for the dropdown's own honesty.
    .limit(MAX_PER_GROUP + 1);

  // --- Quotes --------------------------------------------------------------
  const quoteClauses: string[] = [];
  if (textSafe) {
    quoteClauses.push(
      textClauses(q, [
        'customer_name',
        'customer_address',
        'customer_email',
        'customer_phone',
      ]),
    );
  }
  if (digits) quoteClauses.push(`customer_phone.ilike.%${digits}%`);
  if (number != null) quoteClauses.push(`quote_number.eq.${number}`);
  const quoteFilter = quoteClauses.join(',');

  // TWO reads, not one (premerge technical lens, 2026-08-31). The database
  // applies `limit` BEFORE this file's active-first sort can run, so a single
  // read ordered by recency can fill all its rows with newer CLOSED quotes and
  // drop an older OPEN one entirely -- which would make "nothing is
  // unfindable" at the top of this file a false claim rather than a design.
  // The second read is restricted to the live states, so an active quote can
  // only ever be crowded out by other ACTIVE quotes. Merged and de-duplicated
  // below.
  //
  // `status.is.null` is part of the live set on purpose: legacy rows predate
  // the status column and isActiveQuote() reads a null status as active, so
  // leaving it out would re-open the same hole one row-shape over.
  const LIVE_QUOTE_FILTER = `status.is.null,status.not.in.(${[...CLOSED_QUOTE_STATUSES].join(',')})`;

  const [quotesRes, liveQuotesRes] = await Promise.all([
    sb
      .from('quotes')
      .select(QUOTE_COLUMNS)
      .eq('is_test', false)
      .or(quoteFilter)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP * 2),
    sb
      .from('quotes')
      .select(QUOTE_COLUMNS)
      .eq('is_test', false)
      .or(quoteFilter)
      .or(LIVE_QUOTE_FILTER)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),
  ]);

  const customerRows = (customersRes.data ?? []) as CustomerRow[];
  const quoteRowsById = new Map<string, QuoteRow>();
  for (const r of [
    ...((liveQuotesRes.data ?? []) as QuoteRow[]),
    ...((quotesRes.data ?? []) as QuoteRow[]),
  ]) {
    if (!quoteRowsById.has(r.id)) quoteRowsById.set(r.id, r);
  }
  const quoteRows = [...quoteRowsById.values()];
  const matchedQuoteIds = quoteRows.map((r) => r.id);
  // Every id here came from a read filtered on is_test=false, which is what
  // lets the job and invoice rows scoped by these ids skip their own check.
  const nonTestQuoteIds = new Set(matchedQuoteIds);

  // --- Jobs and invoices ---------------------------------------------------
  // Two ways in: the record's own display number, or its quote matched the
  // text. An empty `in()` list is a no-op filter in PostgREST rather than a
  // match-nothing one, so the query is skipped outright when neither way
  // applies instead of being allowed to return the whole table.
  const jobClauses: string[] = [];
  if (number != null) jobClauses.push(`job_number.eq.${number}`);
  if (matchedQuoteIds.length > 0) {
    jobClauses.push(`quote_id.in.(${matchedQuoteIds.join(',')})`);
  }
  const jobsRes = jobClauses.length
    ? await sb
        .from('jobs')
        .select(JOB_COLUMNS)
        .or(jobClauses.join(','))
        .order('created_at', { ascending: false })
        .limit(MAX_PER_GROUP * 2)
    : { data: [] as JobRow[] };

  const invoiceClauses: string[] = [];
  if (number != null) invoiceClauses.push(`invoice_number.eq.${number}`);
  if (matchedQuoteIds.length > 0) {
    invoiceClauses.push(`quote_id.in.(${matchedQuoteIds.join(',')})`);
  }
  const invoicesRes = invoiceClauses.length
    ? await sb
        .from('invoices')
        .select(INVOICE_COLUMNS)
        .or(invoiceClauses.join(','))
        .order('created_at', { ascending: false })
        .limit(MAX_PER_GROUP * 2)
    : { data: [] as InvoiceRow[] };

  const jobRows = (jobsRes.data ?? []) as JobRow[];
  const invoiceRows = (invoicesRes.data ?? []) as InvoiceRow[];

  // The quotes behind the jobs and invoices found by NUMBER, whose quote was
  // never in the text match. Two things come from this read, and BOTH matter.
  //
  // The name: without it a "#1000" job hit renders with no customer on it,
  // which is the one thing the searcher was looking for.
  //
  // The is_test flag: the quotes reads above exclude test quotes, but a job or
  // an invoice matched on its OWN display number never went past that filter,
  // and neither table carries an is_test column of its own. So a test quote's
  // job was reachable by number and rendered indistinguishable from real work.
  // Found independently by the premerge technical AND admin lenses, which is
  // what makes it a class rather than a nit (2026-08-31).
  const nameByQuoteId = new Map<string, string>();
  for (const r of quoteRows) {
    if (r.customer_name) nameByQuoteId.set(r.id, r.customer_name);
  }
  const unverifiedQuoteIds = [
    ...new Set(
      [...jobRows, ...invoiceRows]
        .map((r) => r.quote_id)
        .filter((id): id is string => !!id && !nonTestQuoteIds.has(id)),
    ),
  ];
  // Quote ids confirmed to belong to TEST quotes. Anything hanging off one is
  // dropped below.
  const testQuoteIds = new Set<string>();
  if (unverifiedQuoteIds.length > 0) {
    const extra = await sb
      .from('quotes')
      .select('id, customer_name, is_test')
      .in('id', unverifiedQuoteIds);
    const extraRows = (extra.data ?? []) as {
      id: string;
      customer_name: string | null;
      is_test: boolean | null;
    }[];
    for (const r of extraRows) {
      if (r.is_test) {
        testQuoteIds.add(r.id);
        continue;
      }
      if (r.customer_name) nameByQuoteId.set(r.id, r.customer_name);
    }
  }

  // A row with no quote at all cannot belong to a test quote, so it stays.
  const notFromTestQuote = (r: { quote_id: string | null }): boolean =>
    !r.quote_id || !testQuoteIds.has(r.quote_id);
  const visibleJobRows = jobRows.filter(notFromTestQuote);
  const visibleInvoiceRows = invoiceRows.filter(notFromTestQuote);

  const nameFor = (quoteId: string | null): string =>
    (quoteId ? nameByQuoteId.get(quoteId) : null) ?? 'Unknown customer';

  const customers: SearchHit[] = customerRows.map((r) => ({
    kind: 'customer' as const,
    key: `customer:${r.id}`,
    href: customerHref(r),
    title: r.name ?? r.email ?? r.phone ?? 'Unnamed customer',
    subtitle: joinParts([r.email, r.phone]),
    label: null,
    status: null,
    // A customer has no lifecycle of their own, so every customer sorts as
    // active and the group is ordered purely by how recently it changed.
    active: true,
    sortedAt: r.updated_at,
  }));

  const quotes: SearchHit[] = quoteRows.map((r) => ({
    kind: 'quote' as const,
    key: `quote:${r.id}`,
    href: `/admin/quotes/${r.id}`,
    title: r.customer_name ?? 'Unnamed customer',
    subtitle: joinParts([r.customer_address, money(r.total)]),
    label: r.quote_number != null ? `#${r.quote_number}` : null,
    status: humanStatus(r.status),
    active: isActiveQuote(r.status),
    sortedAt: r.created_at,
  }));

  const jobs: SearchHit[] = visibleJobRows.map((r) => ({
    kind: 'job' as const,
    key: `job:${r.id}`,
    href: `/admin/jobs/${r.id}`,
    title: nameFor(r.quote_id),
    subtitle: r.install_date ? `Install ${r.install_date}` : null,
    label: r.job_number != null ? `#${r.job_number}` : null,
    status: humanStatus(r.status),
    active: isActiveJob(r.status),
    sortedAt: r.created_at,
  }));

  const invoices: SearchHit[] = visibleInvoiceRows.map((r) => ({
    kind: 'invoice' as const,
    key: `invoice:${r.id}`,
    href: `/admin/invoices/${r.id}`,
    title: nameFor(r.quote_id),
    // An open invoice is about what is still owed; a settled one is about what
    // it was worth. Showing a balance of zero on a paid invoice reads as a bug.
    subtitle: isActiveInvoice(r.status)
      ? `${money(r.balance) ?? '$0.00'} due`
      : money(r.total),
    label: r.invoice_number != null ? `#${r.invoice_number}` : null,
    status: humanStatus(r.status),
    active: isActiveInvoice(r.status),
    sortedAt: r.created_at,
  }));

  return {
    customers: sortHits(customers).slice(0, MAX_PER_GROUP),
    quotes: sortHits(quotes).slice(0, MAX_PER_GROUP),
    jobs: sortHits(jobs).slice(0, MAX_PER_GROUP),
    invoices: sortHits(invoices).slice(0, MAX_PER_GROUP),
    truncated: {
      customer: customers.length > MAX_PER_GROUP,
      quote: quotes.length > MAX_PER_GROUP,
      job: jobs.length > MAX_PER_GROUP,
      invoice: invoices.length > MAX_PER_GROUP,
    },
  };
}
