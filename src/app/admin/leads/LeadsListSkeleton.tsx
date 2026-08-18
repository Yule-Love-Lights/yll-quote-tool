// Shared placeholder for the /admin/leads list (#207 review round) — used by
// BOTH the route's loading.tsx (shown instantly on a route transition, before
// the page has mounted) and LeadsAdminClient's own `loading` fetch state
// (shown while its client-side GET is in flight). Previously the client's
// pending state rendered a bare "Loading…" line, so a route transition into
// this page showed the rich skeleton, then briefly morphed into that sparse
// line, then morphed again into the real table — this makes it ONE
// continuous skeleton instead (mirrors QuotesListSkeleton's shape/rationale,
// #171b). Filter row + 8 rows only (no title placeholder) — the page's own
// header renders unconditionally above this, so only loading.tsx (which has
// no header yet) adds its own title bar.
//
// `bare` (#207 review round 2): loading.tsx has an EXTRA placeholder (the
// title bar) that also needs to sit inside a busy region, so it supplies its
// own outer role="status" around title + this component and passes
// bare — avoiding a nested status region — while the internal-loading-branch
// usage (LeadsAdminClient) is the ONLY placeholder in its context and keeps
// this component's own role.
export function LeadsListSkeleton({ bare = false }: { bare?: boolean } = {}) {
  return (
    <div role={bare ? undefined : 'status'} aria-busy={bare ? undefined : 'true'}>
      <div className="mb-3 h-8 w-full max-w-xs animate-pulse rounded-md bg-black/10" />
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
