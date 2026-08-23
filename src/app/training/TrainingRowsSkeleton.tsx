// Shared placeholder rows for the /training/* subtree (row 332, mirrors
// admin/quotes' QuotesListSkeleton, #171b) — used by BOTH the route's
// loading.tsx (shown instantly on a route transition, before the page has
// mounted; covers /training and every nested sub-route, see that file's own
// comment) and each page's own client-fetch `loading` state (shown while its
// initial GET is in flight). Previously each page's pending state rendered a
// bare "Loading…" line, so a route transition into one of these pages showed
// the rich skeleton, then briefly morphed into that sparse line, then
// morphed again into the real content — this makes it ONE continuous
// skeleton instead. Generic (3 rows, no title) since /training/loading.tsx
// covers 5 differently-shaped routes with one skeleton — see that file's
// comment for why a per-page exact shape isn't used here. Each page's own
// header renders unconditionally above this, so this is body-only, same as
// the loading.tsx usage.
export function TrainingRowsSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <div className="h-16 animate-pulse rounded-lg bg-black/10" />
      <div className="h-16 animate-pulse rounded-lg bg-black/10" />
      <div className="h-16 animate-pulse rounded-lg bg-black/10" />
    </div>
  );
}
