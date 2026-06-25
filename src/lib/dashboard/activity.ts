// Customer activity feed (view history). Merges a customer's quote lifecycle
// events (Created / Sent / Approved — derived from the quote row's timestamps)
// with the per-view event log (quote_view_events) into one timeline, newest
// first. Pure + testable; the page fetches the rows and renders the result.

export type ActivityKind = 'created' | 'sent' | 'approved' | 'viewed';

export type ActivityEvent = {
  kind: ActivityKind;
  at: string; // ISO timestamp
  quoteId: string;
  total: number | null;
};

// The quote fields the timeline needs (a subset of DashboardQuote).
export type ActivityQuote = {
  id: string;
  created_at: string;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  total: number | null;
};

// A row from the quote_view_events log.
export type ViewEventRow = { quote_id: string; viewed_at: string };

// Tie-break when two events share an exact timestamp. The comparator below
// applies this DESCENDING (newest stage first), so a same-instant tie emits
// approved -> viewed -> sent -> created — the right order for a newest-first feed.
const KIND_ORDER: Record<ActivityKind, number> = {
  created: 0,
  sent: 1,
  viewed: 2,
  approved: 3,
};

export function buildCustomerActivity(
  quotes: ActivityQuote[],
  views: ViewEventRow[],
): ActivityEvent[] {
  const totalByQuote = new Map<string, number | null>(quotes.map((q) => [q.id, q.total]));
  const knownQuote = new Set(quotes.map((q) => q.id));
  const events: ActivityEvent[] = [];

  for (const q of quotes) {
    events.push({ kind: 'created', at: q.created_at, quoteId: q.id, total: q.total });
    if (q.quote_sent_at) events.push({ kind: 'sent', at: q.quote_sent_at, quoteId: q.id, total: q.total });
    if (q.customer_approved_at)
      events.push({ kind: 'approved', at: q.customer_approved_at, quoteId: q.id, total: q.total });
  }

  for (const v of views) {
    // Defensive: ignore a view row that isn't one of this customer's quotes.
    if (!knownQuote.has(v.quote_id)) continue;
    events.push({
      kind: 'viewed',
      at: v.viewed_at,
      quoteId: v.quote_id,
      total: totalByQuote.get(v.quote_id) ?? null,
    });
  }

  return events.sort((a, b) => {
    const d = new Date(b.at).getTime() - new Date(a.at).getTime();
    if (d !== 0) return d;
    return KIND_ORDER[b.kind] - KIND_ORDER[a.kind];
  });
}
