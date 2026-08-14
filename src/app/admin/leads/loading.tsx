import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#207, mirroring the #171a/#662 pattern) so
// a route transition into this page doesn't flash the top nav out — the page
// itself renders OperatorShell active="leads", so this skeleton mirrors that
// instead of replacing it. The wrapper div matches the real page's own
// content div (max-w-6xl mx-auto, no extra padding) — OperatorShell already
// supplies py-8 px-4.
export default function Loading() {
  return (
    <OperatorShell active="leads">
      <div
        role="status"
        aria-busy="true"
        className="max-w-6xl mx-auto"
      >
        <div className="mb-6 h-8 w-48 animate-pulse rounded-lg bg-black/10" />
        <div className="mb-3 h-8 w-full max-w-xs animate-pulse rounded-md bg-black/10" />
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
