import { OperatorShell } from '@/components/OperatorShell';
import { QuoteDetailSkeleton } from './QuoteDetailSkeleton';

// Wrapped in the operator chrome (#171) so a route transition into this page
// doesn't flash the top nav out — the page itself renders OperatorShell
// active="quotes", so this skeleton mirrors that instead of replacing it.
// The wrapper div matches the real detail page's own content div (max-w-3xl
// mx-auto, no extra padding — the loading skeleton previously used max-w-6xl,
// wider than the real content, which snapped narrower once the page loaded).
//
// The body (the card grid) is the SAME shared component /video's own
// client-fetch `loading` state renders (row 332, mirrors #171b) — see
// QuoteDetailSkeleton for why.
export default function Loading() {
  return (
    <OperatorShell active="quotes">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
        <QuoteDetailSkeleton />
      </div>
    </OperatorShell>
  );
}
