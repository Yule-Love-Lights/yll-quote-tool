import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#207, mirroring the #171a/#662 pattern) so
// a route transition into this page doesn't flash the top nav out — the page
// itself renders OperatorShell active="inventory", so this skeleton mirrors
// that instead of replacing it. The wrapper matches the real page's own
// content element (main.max-w-[1100px] mx-auto, no extra padding) —
// OperatorShell already supplies py-8 px-4. Shape mirrors the real Overview
// page: a job-pipeline tile row, then a two-card "needs attention" grid.
export default function Loading() {
  return (
    <OperatorShell active="inventory">
      <main
        role="status"
        aria-busy="true"
        className="max-w-[1100px] mx-auto"
      >
        <div className="mb-5 h-6 w-44 animate-pulse rounded-lg bg-black/10" />
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
          <div className="h-20 animate-pulse rounded-lg bg-black/10" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="h-40 animate-pulse rounded-lg bg-black/10" />
          <div className="h-40 animate-pulse rounded-lg bg-black/10" />
        </div>
      </main>
    </OperatorShell>
  );
}
