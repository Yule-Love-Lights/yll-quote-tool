import { OperatorShell } from '@/components/OperatorShell';

// Wrapped in the operator chrome (#207, mirroring the #171a/#662 pattern) so
// a route transition into this page doesn't flash the top nav out — the page
// itself renders OperatorShell active="settings", so this skeleton mirrors
// that instead of replacing it. The wrapper div matches the real page's own
// content element (main.max-w-3xl mx-auto, no extra padding) — OperatorShell
// already supplies py-8 px-4. Shape mirrors the real page: the tab strip,
// then a handful of form-row placeholders.
export default function Loading() {
  return (
    <OperatorShell active="settings">
      <main
        role="status"
        aria-busy="true"
        className="max-w-3xl mx-auto"
      >
        <div className="mb-6 h-6 w-32 animate-pulse rounded-lg bg-black/10" />
        <div className="mb-5 h-9 w-full animate-pulse rounded-md bg-black/10" />
        <div className="space-y-2">
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
          <div className="h-12 animate-pulse rounded-md bg-black/10" />
        </div>
      </main>
    </OperatorShell>
  );
}
