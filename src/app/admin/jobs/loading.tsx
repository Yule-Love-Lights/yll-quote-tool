import { OperatorShell } from '@/components/OperatorShell';
import { JobsListSkeleton } from './JobsListSkeleton';

// Wrapped in the operator chrome (#171a review, PR #662 MED) so a route
// transition into this page doesn't flash the top nav out — the page itself
// renders OperatorShell active="jobs", so this skeleton mirrors that instead
// of replacing it. Without this the route fell through to the light,
// dashboard-shaped root loading.tsx, which read as MORE jarring right next
// to the Quotes leg (BillingSubNav is one click away) once that leg's nav
// stopped flickering.
// The wrapper div matches the real page's own content div (max-w-6xl
// mx-auto, no extra padding) — OperatorShell already supplies py-8 px-4.
//
// The body (search bar + rows) is the SAME shared component the page itself
// renders during its own client-fetch `loading` state (row 332, mirrors
// #171b) — one continuous skeleton across the route transition and the data
// fetch, no morph into a bare "Loading…" line in between.
export default function Loading() {
  return (
    <OperatorShell active="jobs">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
        <JobsListSkeleton />
      </div>
    </OperatorShell>
  );
}
