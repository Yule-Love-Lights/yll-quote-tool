// Customer activity feed (view history). Merges a customer's quote lifecycle
// events (Created / Sent / Approved — derived from the quote row's timestamps)
// with the per-view event log (quote_view_events) into one timeline, newest
// first. Pure + testable; the page fetches the rows and renders the result.

export type ActivityKind = 'created' | 'sent' | 'approved' | 'viewed' | 'interested';

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

// A row from the quote_view_events log. `kind` is 'viewed' or 'interested'
// (absent on rows written before the kind column existed → treated as 'viewed').
export type ViewEventRow = { quote_id: string; viewed_at: string; kind?: string | null };

// Tie-break when two events share an exact timestamp. The comparator below
// applies this DESCENDING (newest stage first), so a same-instant tie emits
// approved -> interested -> viewed -> sent -> created — the order for a
// newest-first feed (a customer views, gets interested, then approves).
const KIND_ORDER: Record<ActivityKind, number> = {
  created: 0,
  sent: 1,
  viewed: 2,
  interested: 3,
  approved: 4,
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

  // Viewed: one event per row (every open). Interested: collapse to ONE event
  // per quote (the earliest), so if the best-effort route ever raced and wrote
  // two 'interested' rows, the feed still shows a single "Interested" marker.
  const earliestInterested = new Map<string, string>();
  for (const v of views) {
    // Defensive: ignore a view row that isn't one of this customer's quotes.
    if (!knownQuote.has(v.quote_id)) continue;
    if (v.kind === 'interested') {
      const prev = earliestInterested.get(v.quote_id);
      if (!prev || new Date(v.viewed_at).getTime() < new Date(prev).getTime()) {
        earliestInterested.set(v.quote_id, v.viewed_at);
      }
    } else {
      events.push({
        kind: 'viewed',
        at: v.viewed_at,
        quoteId: v.quote_id,
        total: totalByQuote.get(v.quote_id) ?? null,
      });
    }
  }
  for (const [quoteId, at] of earliestInterested) {
    events.push({ kind: 'interested', at, quoteId, total: totalByQuote.get(quoteId) ?? null });
  }

  return events.sort((a, b) => {
    const d = new Date(b.at).getTime() - new Date(a.at).getTime();
    if (d !== 0) return d;
    return KIND_ORDER[b.kind] - KIND_ORDER[a.kind];
  });
}
