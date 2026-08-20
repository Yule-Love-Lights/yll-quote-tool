import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#171a reconcile — sibling to
// src/app/quote/[id]/loading.tsx, which already noted "QuoteBuilder itself
// renders OperatorShell active='new' (both for the new and edit flows)" but
// was only placed under quote/[id], so a route transition into the blank-
// slate /quote/new builder still fell through to the light, unwrapped root
// loading.tsx). Same shape as the [id] sibling — both routes render the
// exact same QuoteBuilder component.
// The wrapper div matches QuoteBuilder's own content div (max-w-3xl mx-auto,
// no extra padding).
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
