import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#171a reconcile — the route had no
// loading.tsx of its own at all, so a transition into it fell through to the
// light, dashboard-shaped root loading.tsx, flashing the top nav out exactly
// like the routes #171a/#662 already fixed). The page itself renders
// OperatorShell active="jobs" (Schedule lives under the Jobs nav item), so
// this skeleton mirrors that instead of replacing it.
// The wrapper div matches the real page's own content div (max-w-3xl
// mx-auto, no extra padding) — OperatorShell already supplies py-8 px-4.
export default function Loading() {
  return (
    <OperatorShell active="jobs">
      <div
        role="status"
        aria-busy="true"
        className="max-w-3xl mx-auto"
      >
        <div className="mb-6 h-8 w-32 animate-pulse rounded-lg bg-black/10" />
        <div className="space-y-2">
          <div className="h-14 animate-pulse rounded-md bg-black/10" />
          <div className="h-14 animate-pulse rounded-md bg-black/10" />
          <div className="h-14 animate-pulse rounded-md bg-black/10" />
        </div>
      </div>
    </OperatorShell>
  );
}
