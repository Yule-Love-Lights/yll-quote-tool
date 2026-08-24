import { OperatorShell } from '@/components/OperatorShell';
import { SiteFormsListSkeleton } from './SiteFormsListSkeleton';

// row 346 — this route previously had no loading.tsx anywhere in its chain,
// so a route transition into it fell through to the light dashboard-shaped
// ROOT skeleton (a generic shape unrelated to this page) instead of the
// operator chrome. Wrapped in OperatorShell so the top nav doesn't flash out
// — the page itself now also renders OperatorShell, so this mirrors that.
//
// No OperatorArea nav entry exists for this page (it's reachable only by a
// direct URL, not linked from the top nav) — 'leads' is used because this
// page reviews external website submissions the same way /admin/leads does,
// and the page's own copy names leads as the sibling surface for actual
// sales leads.
//
// The wrapper div matches the real page's own content div (max-width 1100,
// mx-auto, no extra padding) — OperatorShell already supplies py-8 px-4.
//
// The body (the row cards) is the SAME shared component
// (SiteFormsListSkeleton) the page itself renders during its own
// client-fetch `loading` state (row 346, mirrors row 332/#171b) — one
// continuous skeleton across the route transition and the data fetch, no
// morph into a differently-shaped placeholder in between.
export default function Loading() {
  return (
    <OperatorShell active="leads">
      <div className="mx-auto" style={{ maxWidth: 1100 }}>
        <div className="mb-6 h-8 w-64 animate-pulse rounded-lg bg-black/10" />
        <SiteFormsListSkeleton />
      </div>
    </OperatorShell>
  );
}
