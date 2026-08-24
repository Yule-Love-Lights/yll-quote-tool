// Shared placeholder body for the /admin/quotes/[id] detail route (row 332,
// mirrors admin/quotes' QuotesListSkeleton, #171b) — used by BOTH the
// route's loading.tsx (shown instantly on a route transition, before the
// page has mounted) and /admin/quotes/[id]/video's own client-fetch
// `loading` state. That video sub-route has no loading.tsx of its own, so it
// inherits this one during a route transition; reusing the SAME component
// for its own pending state (previously a bare "Loading…" line) means the
// route-transition skeleton doesn't morph into that sparse line before
// morphing again into the real content once its client-side GET resolves.
export function QuoteDetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="grid gap-6 lg:grid-cols-2">
      <div className="h-40 animate-pulse rounded-lg bg-black/10" />
      <div className="h-40 animate-pulse rounded-lg bg-black/10" />
      <div className="h-40 animate-pulse rounded-lg bg-black/10" />
      <div className="h-40 animate-pulse rounded-lg bg-black/10" />
    </div>
  );
}
