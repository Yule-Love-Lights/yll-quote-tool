import { OperatorShell } from '@/components/OperatorShell';
import { LeadsListSkeleton } from './LeadsListSkeleton';

// Wrapped in the operator chrome (#207, mirroring the #171a/#662 pattern) so
// a route transition into this page doesn't flash the top nav out — the page
// itself renders OperatorShell active="leads", so this skeleton mirrors that
// instead of replacing it. The wrapper div matches the real page's own
// content div (max-w-6xl mx-auto, no extra padding) — OperatorShell already
// supplies py-8 px-4.
//
// The body (filter bar + rows) is the SAME shared component (LeadsListSkeleton,
// #207 review round) LeadsAdminClient itself renders during its own
// client-fetch `loading` state — one continuous skeleton across the route
// transition and the data fetch, no morph into a bare "Loading…" line in
// between. Only this route boundary adds the title placeholder, since the
// real page's header isn't mounted yet.
//
// This route has an EXTRA placeholder (the title bar) that LeadsListSkeleton
// doesn't cover, so role="status" lives HERE (wrapping title + skeleton as
// one busy region) and LeadsListSkeleton renders `bare` to avoid nesting a
// second status region inside it (#207 review round 2).
export default function Loading() {
  return (
    <OperatorShell active="leads">
      <div className="max-w-6xl mx-auto">
        <div role="status" aria-busy="true">
          <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
          <LeadsListSkeleton bare />
        </div>
      </div>
    </OperatorShell>
  );
}
