// Shared placeholder for the /settings tab panel (#207 review round) — used
// by BOTH the route's loading.tsx (shown instantly on a route transition,
// before the page has mounted) and the page's own `loading` fetch state
// (shown while its client-side GET /api/settings call is in flight).
// Previously the client's pending state rendered a bare "Loading settings…"
// line, so a route transition into this page showed the rich skeleton, then
// briefly morphed into that sparse line, then morphed again into the real
// panel — this makes it ONE continuous skeleton instead (mirrors
// QuotesListSkeleton's shape/rationale, #171b). Just the panel rows —
// SettingsSubNav, the h1 row, and the page's own local tab strip all render
// unconditionally above this in both places, so neither needs its own
// placeholder here.
export function SettingsPanelSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-2">
      <div className="h-12 animate-pulse rounded-md bg-black/10" />
      <div className="h-12 animate-pulse rounded-md bg-black/10" />
      <div className="h-12 animate-pulse rounded-md bg-black/10" />
      <div className="h-12 animate-pulse rounded-md bg-black/10" />
    </div>
  );
}
