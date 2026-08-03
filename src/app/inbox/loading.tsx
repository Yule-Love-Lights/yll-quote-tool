import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#171) so a route transition into this page
// doesn't flash the top nav out — the page itself renders OperatorShell
// active="inbox", so this skeleton mirrors that instead of replacing it.
// The wrapper div matches the real page's own content div (max-w-4xl mx-auto
// w-full, no extra padding — the loading skeleton previously used max-w-6xl,
// wider than the real content, which snapped narrower once the page loaded).
export default function Loading() {
  return (
    <OperatorShell active="inbox">
      <div
        role="status"
        aria-busy="true"
        className="max-w-4xl mx-auto w-full"
      >
        <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
        <div className="space-y-2">
          <div className="h-16 animate-pulse rounded-md bg-black/10" />
          <div className="h-16 animate-pulse rounded-md bg-black/10" />
          <div className="h-16 animate-pulse rounded-md bg-black/10" />
          <div className="h-16 animate-pulse rounded-md bg-black/10" />
          <div className="h-16 animate-pulse rounded-md bg-black/10" />
          <div className="h-16 animate-pulse rounded-md bg-black/10" />
          <div className="h-16 animate-pulse rounded-md bg-black/10" />
          <div className="h-16 animate-pulse rounded-md bg-black/10" />
        </div>
      </div>
    </OperatorShell>
  );
}
