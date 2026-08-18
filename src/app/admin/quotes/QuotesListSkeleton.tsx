// Shared placeholder rows for the /admin/quotes list (#171b) — used by BOTH
// the route's loading.tsx (shown instantly on a route transition, before the
// page has mounted) and the page's own `loading` fetch state (shown while
// its client-side GET /api/quotes call is in flight). Previously the page's
// pending state rendered a bare "Loading…" line, so a route transition into
// this page showed the rich skeleton, then briefly morphed into that sparse
// line, then morphed again into the real table — this makes it ONE
// continuous skeleton instead. Search-bar + 8 rows only (no title
// placeholder) — the page's own header renders unconditionally above this,
// so only loading.tsx (which has no header yet) adds its own title bar.
export function QuotesListSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <div className="mb-4 h-10 w-full animate-pulse rounded-md bg-black/10" />
      <div className="space-y-2">
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
        <div className="h-12 animate-pulse rounded-md bg-black/10" />
      </div>
    </div>
  );
}
