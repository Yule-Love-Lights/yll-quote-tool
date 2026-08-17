import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { SettingsPanelSkeleton } from './SettingsPanelSkeleton';

// Wrapped in the operator chrome (#207, mirroring the #171a/#662 pattern) so
// a route transition into this page doesn't flash the top nav out — the page
// itself renders OperatorShell active="settings", so this skeleton mirrors
// that instead of replacing it. The wrapper matches the real page's own
// content element (main.max-w-3xl mx-auto, no extra padding) — OperatorShell
// already supplies py-8 px-4.
//
// Renders the REAL SettingsSubNav (a plain link strip — no client hooks, so
// it's safe to mount before the page's own client bundle hydrates) so the
// nav row doesn't jump down when the real page swaps in, matching the real
// page's own element order: SubNav → title row → local tab strip → panel.
// The title row and local-tab-strip placeholders stand in for those two
// (they're inside the 'use client' page, not mounted yet); the panel body
// is the SAME shared component (SettingsPanelSkeleton, #207 review round)
// the page itself renders during its own client-fetch `loading` state — one
// continuous skeleton across the route transition and the data fetch, no
// morph into a bare "Loading settings…" line in between.
//
// This route has TWO extra placeholders (title + local tab strip) that
// SettingsPanelSkeleton doesn't cover, so role="status" lives HERE (wrapping
// all three as one busy region, excluding the real SettingsSubNav links) and
// SettingsPanelSkeleton renders `bare` to avoid nesting a second status
// region inside it (#207 review round 2).
export default function Loading() {
  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="settings" />
        <div role="status" aria-busy="true">
          <div className="mb-6 h-6 w-32 animate-pulse rounded-lg bg-black/10" />
          <div className="mb-5 h-9 w-full animate-pulse rounded-md bg-black/10" />
          <SettingsPanelSkeleton bare />
        </div>
      </main>
    </OperatorShell>
  );
}
