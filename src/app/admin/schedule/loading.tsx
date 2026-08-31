import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#171a reconcile — the route had no
// loading.tsx of its own at all, so a transition into it fell through to the
// light, dashboard-shaped root loading.tsx, flashing the top nav out exactly
// like the routes #171a/#662 already fixed).
//
// active="schedule" since 2026-08-31: Schedule has its own nav item and its
// own area now, so this must not light up Jobs while the real page lights up
// Schedule. The wrapper matches the real page's content div (max-w-6xl, two
// columns from lg) — OperatorShell already supplies py-8 px-4.
export default function Loading() {
  return (
    <OperatorShell active="schedule">
      <div role="status" aria-busy="true" className="max-w-6xl mx-auto">
        <div className="mb-6 h-8 w-32 animate-pulse rounded-lg bg-black/10" />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
          <div className="space-y-2">
            <div className="h-14 animate-pulse rounded-md bg-black/10" />
            <div className="h-14 animate-pulse rounded-md bg-black/10" />
            <div className="h-14 animate-pulse rounded-md bg-black/10" />
          </div>
          <div className="space-y-2">
            <div className="h-32 animate-pulse rounded-md bg-black/10" />
            <div className="h-14 animate-pulse rounded-md bg-black/10" />
          </div>
        </div>
      </div>
    </OperatorShell>
  );
}
