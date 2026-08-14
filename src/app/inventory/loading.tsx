import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';

// Wrapped in the operator chrome (#207, mirroring the #171a/#662 pattern) so
// a route transition into this page doesn't flash the top nav out — the page
// itself renders OperatorShell active="inventory", so this skeleton mirrors
// that instead of replacing it. The wrapper matches the real page's own
// content element (main.max-w-[1100px] mx-auto, no extra padding) —
// OperatorShell already supplies py-8 px-4.
//
// Renders the REAL InventorySubNav (a plain link strip — no client hooks, so
// it's safe to mount before the page's own data fetch resolves) so the tab
// row doesn't jump down when the real page swaps in, matching the real
// page's own element order. role="status" is scoped to just the placeholder
// region below it (not the real, navigable sub-nav). Shape mirrors the real
// Overview page: a job-pipeline tile row, then a two-card "needs attention"
// grid.
export default function Loading() {
  return (
    <OperatorShell active="inventory">
      <main className="max-w-[1100px] mx-auto">
        <InventorySubNav active="overview" />
        <div role="status" aria-busy="true">
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
        </div>
      </main>
    </OperatorShell>
  );
}
