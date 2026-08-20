import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';

// Wrapped in the operator chrome (#171a reconcile — /training and every
// nested sub-route, new/references/archive/examples, had no loading.tsx of
// their own anywhere in the tree, so a transition into any of them fell
// through to the light, dashboard-shaped root loading.tsx, flashing the top
// nav out exactly like the routes #171a/#662 already fixed). One loading.tsx
// at this segment covers the whole /training/* subtree (mirrors how
// inventory/loading.tsx and settings/loading.tsx each cover their own
// differently-shaped children with a single generic skeleton, rather than a
// tailored one per sub-route) — the page itself renders OperatorShell
// active="training" + SettingsSubNav active="training" on every one of these
// pages, so this skeleton mirrors that instead of replacing it.
//
// Renders the REAL SettingsSubNav (a plain link strip — no client hooks, so
// it's safe to mount before the page's own client bundle hydrates) so the
// nav row doesn't jump when the real page swaps in. Width (max-w-5xl) matches
// the majority of the training pages (list/references/archive/examples);
// /training/new's own wider form content still swaps in cleanly, just without
// a pixel-matched skeleton for that one sub-route.
export default function Loading() {
  return (
    <OperatorShell active="training">
      <div className="max-w-5xl mx-auto">
        <SettingsSubNav active="training" />
        <div role="status" aria-busy="true">
          <div className="mb-6 h-8 w-64 animate-pulse rounded-lg bg-black/10" />
          <div className="space-y-2">
            <div className="h-16 animate-pulse rounded-lg bg-black/10" />
            <div className="h-16 animate-pulse rounded-lg bg-black/10" />
            <div className="h-16 animate-pulse rounded-lg bg-black/10" />
          </div>
        </div>
      </div>
    </OperatorShell>
  );
}
