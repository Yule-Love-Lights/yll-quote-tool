import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#171) so a route transition into this page
// doesn't flash the top nav out — QuoteBuilder itself renders OperatorShell
// active="new" (both for the new and edit flows), so this skeleton mirrors
// that instead of replacing it.
// The wrapper div matches QuoteBuilder's own content div (max-w-3xl mx-auto,
// no extra padding — the loading skeleton previously used max-w-6xl, wider
// than the real content, which snapped narrower once the page loaded).
export default function Loading() {
  return (
    <OperatorShell active="new">
      <div
        role="status"
        aria-busy="true"
        className="max-w-3xl mx-auto"
      >
        <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
        <div className="mb-4 h-96 animate-pulse rounded-lg bg-black/10" />
        <div className="grid grid-cols-3 gap-4">
          <div className="h-24 animate-pulse rounded-lg bg-black/10" />
          <div className="h-24 animate-pulse rounded-lg bg-black/10" />
          <div className="h-24 animate-pulse rounded-lg bg-black/10" />
        </div>
      </div>
    </OperatorShell>
  );
}
