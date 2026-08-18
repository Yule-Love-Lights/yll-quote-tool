import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#207, mirroring the #171a/#662 pattern) so
// a route transition into this page doesn't flash the top nav out — the page
// itself renders OperatorShell active="insights", so this skeleton mirrors
// that instead of replacing it. The wrapper div matches the real page's own
// content div (max-w-6xl mx-auto w-full, no extra padding) — OperatorShell
// already supplies py-8 px-4. Shape mirrors the real page: a 5-up KPI row,
// then the revenue chart + service-split blocks.
export default function Loading() {
  return (
    <OperatorShell active="insights">
      <div
        role="status"
        aria-busy="true"
        className="max-w-6xl mx-auto w-full"
      >
        <div className="mb-6 h-8 w-40 animate-pulse rounded-lg bg-black/10" />
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
        </div>
        <div className="mb-3 h-64 animate-pulse rounded-lg bg-black/10" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="h-64 animate-pulse rounded-lg bg-black/10" />
        </div>
      </div>
    </OperatorShell>
  );
}
