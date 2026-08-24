import { OperatorShell } from '@/components/OperatorShell';
import { TrainingRowsSkeleton } from './TrainingRowsSkeleton';

// Wrapped in the operator chrome (#171a reconcile — /training and every
// nested sub-route, new/references/archive/examples, had no loading.tsx of
// their own anywhere in the tree, so a transition into any of them fell
// through to the light, dashboard-shaped root loading.tsx, flashing the top
// nav out exactly like the routes #171a/#662 already fixed). One loading.tsx
// at this segment covers the whole /training/* subtree (mirrors how
// inventory/loading.tsx and settings/loading.tsx each cover their own
// differently-shaped children with a single generic skeleton).
//
// Deliberately NO SettingsSubNav here (staff-lens HIGH, #837 review): only 2
// of the 5 covered routes (/training, /training/archive) render it — the
// other three (new/references/examples) use their own headers, so a shared
// skeleton showing the sub-nav would flash it in and then have it VANISH on
// those routes, a worse jump than the one this file exists to fix. The
// settings/loading.tsx precedent is safe only because every /settings/* page
// really does render the sub-nav; that precondition fails here.
export default function Loading() {
  return (
    <OperatorShell active="training">
      <div className="max-w-5xl mx-auto">
        <div className="mb-6 h-8 w-64 animate-pulse rounded-lg bg-black/10" />
        <TrainingRowsSkeleton />
      </div>
    </OperatorShell>
  );
}
