import type { CustomerStatus, CustomerSummary, DashboardQuote } from './types';
import { customerKey } from './metrics';
import { deriveStatus } from '@/lib/quoteStatus';

/**
 * Lifecycle status of a single quote. BUG-1 (S22): this used to read ONLY the
 * timestamp chain (approved > sent > draft), so a quote in a state the
 * timestamps can't express — declined / cancelled / abandoned / changes_requested —
 * kept reading as its stale 'sent'/'approved'. It now delegates to the canonical
 * `deriveStatus` (persisted branch/terminal `status` wins, else the timestamps),
 * so the customers list + detail history badge matches the admin quotes list,
 * the Workflow board, and the data layer. Requires `status`/`viewed_at` on the
 * row — DASHBOARD_QUOTES_SELECT already fetches them.
 */
export function statusOf(q: DashboardQuote): CustomerStatus {
  return deriveStatus(q);
}

function nameOf(q: DashboardQuote): string | null {
  const n = q.customer_name?.trim();
  return n && n.length ? n : null;
}

/**
 * The id used to route to a customer's detail page (`/customers/[id]`).
 * Prefers the HighLevel contact id (preserves the existing URL for CRM-linked
 * customers), falling back to the stable customer_id so a customer WITHOUT a HL
 * link is still clickable to their profile (S22 fix — the backfill populated
 * customer_id but the link was gated on highlevel_contact_id, so only HL-linked
 * customers were clickable). Null only for an identity-less walk-in.
 */
export function customerRouteId(c: {
  contactId: string | null;
  customerId: string | null;
}): string | null {
  return c.contactId ?? c.customerId ?? null;
}

/**
 * Whether a quote belongs to the customer addressed by `routeId` — matching on
 * EITHER the HighLevel contact id or the stable customer_id, so the detail page
 * resolves a customer reached by either kind of route id.
 */
export function matchesCustomerRoute(q: DashboardQuote, routeId: string): boolean {
  return q.highlevel_contact_id === routeId || q.customer_id === routeId;
}

/**
 * Every HighLevel contact id a customer has EVER carried, expanded via
 * customer_id — not just the ids on `matchedQuotes` (the routeId-only match).
 * A merge or re-match can leave a customer's real quotes spread across two
 * different HL ids over time. `matchedQuotes` alone cannot see the second one:
 * when the route id IS an HL id (the dominant case — customerRouteId prefers
 * it), matchesCustomerRoute's OR only ever matches quotes carrying that EXACT
 * id, so the "every HL id" claim was false for a merged customer despite
 * reading one from that narrower set (found by the S85 wrap integration lens
 * — /customers/[contactId]'s call-notes panel silently showed less history
 * than the quote-builder drawer for the identical customer). Mirrors the
 * customer_id round trip the drawer's route (resolveAllContactIds) does
 * server-side — this is the in-memory equivalent, since the profile page
 * already has every quote loaded via `allQuotes`.
 */
export function expandHlContactIds(allQuotes: DashboardQuote[], matchedQuotes: DashboardQuote[]): string[] {
  const customerIds = new Set(matchedQuotes.map(q => q.customer_id).filter((id): id is string => !!id));
  const relevant = customerIds.size
    ? allQuotes.filter(q => q.customer_id != null && customerIds.has(q.customer_id))
    : matchedQuotes;
  return [...new Set(relevant.map(q => q.highlevel_contact_id).filter((id): id is string => !!id))];
}

/**
 * Aggregate the quotes table into one row per customer (#58 Phase 3).
 * A "customer" = all quotes sharing a stable key (HL contact id, else
 * email/phone/name — same precedence as the KPI customer count). No separate
 * customers table; this is a pure fold over what `listQuotesForDashboard`
 * already returns. Sorted most-recent-customer first.
 */
export function aggregateCustomers(quotes: DashboardQuote[]): CustomerSummary[] {
  const groups = new Map<string, DashboardQuote[]>();
  for (const q of quotes) {
    const key = customerKey(q);
    const list = groups.get(key);
    if (list) list.push(q);
    else groups.set(key, [q]);
  }

  const summaries: CustomerSummary[] = [];
  for (const [key, list] of groups) {
    // Most recent quote by created_at drives the headline fields.
    const latest = list.reduce((a, b) =>
      new Date(b.created_at).getTime() > new Date(a.created_at).getTime() ? b : a,
    );

    let bookedSpend = 0;
    let contactId: string | null = null;
    let customerId: string | null = null;
    let name: string | null = nameOf(latest);
    let email: string | null = latest.customer_email;
    let phone: string | null = latest.customer_phone;

    for (const q of list) {
      if (q.customer_approved_at) bookedSpend += q.total ?? 0;
      // Prefer any non-null identity fields found across the group so a blank
      // on the latest quote still shows real contact info.
      contactId = contactId ?? q.highlevel_contact_id;
      customerId = customerId ?? q.customer_id ?? null;
      name = name ?? nameOf(q);
      email = email ?? q.customer_email;
      phone = phone ?? q.customer_phone;
    }

    summaries.push({
      key,
      contactId,
      customerId,
      name: name ?? 'Unknown customer',
      email,
      phone,
      quoteCount: list.length,
      bookedSpend,
      latestQuoteAt: latest.created_at,
      latestStatus: statusOf(latest),
      latestQuoteId: latest.id,
    });
  }

  // Most recently active customer first.
  summaries.sort((a, b) => new Date(b.latestQuoteAt).getTime() - new Date(a.latestQuoteAt).getTime());
  return summaries;
}

/**
 * The HighLevel contact id to load a customer profile from, given that
 * customer's quotes and the route id the page was addressed by.
 *
 * A quote's own HighLevel id wins: it is the id this tool recorded for them.
 * When the customer has NO quotes at all, the route id is used instead,
 * because the route id for a CRM-linked customer IS their HighLevel contact
 * id. Without that fallback the profile page resolved null, never attempted
 * the CRM fetch, and 404'd for every customer who has never been quoted,
 * which is precisely the new lead someone opening a call task wants to read
 * up on. Found by driving a real Office Task link in the browser: HighLevel
 * returned the contact happily and the page 404'd anyway.
 *
 * Returns null for a customer who HAS quotes but no HighLevel id, so the
 * page keeps saying "not linked to HighLevel" for a genuine non-CRM customer
 * rather than attempting a fetch with a customer_id and reporting the more
 * alarming "could not be loaded".
 */
export function resolveHlContactId(quotes: DashboardQuote[], routeId: string): string | null {
  const fromQuotes = quotes.find(q => q.highlevel_contact_id)?.highlevel_contact_id;
  if (fromQuotes) return fromQuotes;
  return quotes.length === 0 ? routeId : null;
}
