// Shared placeholder rows for the /admin/invoices list (row 332, mirrors
// admin/quotes' QuotesListSkeleton, #171b) — used by BOTH the route's
// loading.tsx (shown instantly on a route transition, before the page has
// mounted) and the page's own `loading` fetch state (shown while its
// client-side GET /api/invoices call is in flight). Previously the page's
// pending state rendered a bare "Loading…" line, so a route transition into
// this page showed the rich skeleton, then briefly morphed into that sparse
// line, then morphed again into the real table — this makes it ONE
// continuous skeleton instead. Also reused (unchanged shape) by
// /admin/invoices/[id]'s own client-fetch loading state, since that detail
// route has no loading.tsx of its own and inherits this one during a route
// transition — reusing the same component here avoids introducing a SECOND
// mismatched morph on top of the one that already exists between this list
// shape and the eventual detail content.
export function InvoicesListSkeleton() {
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
