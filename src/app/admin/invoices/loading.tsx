import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#171a review, PR #662 MED) so a route
// transition into this page doesn't flash the top nav out — the page itself
// renders OperatorShell active="invoices", so this skeleton mirrors that
// instead of replacing it. Without this the route fell through to the light,
// dashboard-shaped root loading.tsx, which read as MORE jarring right next
// to the Quotes leg (BillingSubNav is one click away) once that leg's nav
// stopped flickering.
// The wrapper div matches the real page's own content div (max-w-6xl
// mx-auto, no extra padding) — OperatorShell already supplies py-8 px-4.
export default function Loading() {
  return (
    <OperatorShell active="invoices">
      <div
        role="status"
        aria-busy="true"
        className="max-w-6xl mx-auto"
      >
        <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
        <div className="mb-4 h-10 w-full animate-pulse rounded-md bg-black/10" />
        <div className="space-y-2">
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
        </div>
      </div>
    </OperatorShell>
  );
}
