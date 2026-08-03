import { OperatorShell } from '@/components/OperatorShell';
import { QuotesListSkeleton } from './QuotesListSkeleton';

// Wrapped in the operator chrome (#171a) so a route transition into this page
// doesn't flash the top nav out — the page itself renders OperatorShell
// active="quotes", so this skeleton mirrors that instead of replacing it.
// The wrapper div matches the real page's own content div (max-w-none
// mx-auto, no extra padding) — OperatorShell already supplies py-8 px-4, so
// the skeleton lines up with where the real content lands instead of
// double-padding or resizing when the page swaps in.
//
// The body (search bar + rows) is the SAME shared component the page itself
// renders during its own client-fetch `loading` state (#171b) — one
// continuous skeleton across the route transition and the data fetch, no
// morph into a bare "Loading…" line in between. Only this route boundary
// adds the title placeholder, since the real page's header isn't mounted yet.
export default function Loading() {
  return (
    <OperatorShell active="quotes">
      <div className="max-w-none mx-auto">
        <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
        <QuotesListSkeleton />
      </div>
    </OperatorShell>
  );
}
