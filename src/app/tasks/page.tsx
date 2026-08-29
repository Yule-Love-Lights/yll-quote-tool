// /tasks — the whole Office Tasks list (Naldo, 2026-08-29).
//
// The dashboard card shows the next few due and links here; this page carries
// everything the card deliberately leaves out: the full list, the history of
// completed and dismissed work, and the filter/sort controls. Both render the
// SAME component (OfficeTasksCard, variant="page") so the fetch, action and
// idempotency behaviour cannot drift between the two surfaces.
//
// Operator-gated by the proxy perimeter, like every other internal page: /tasks
// is not in operatorGate's public allowlist, so a signed-out request never
// reaches it. Nothing here is per-person — the everything-is-shared ruling
// means every operator sees the same list.

import { OperatorShell } from '@/components/OperatorShell';
import OfficeTasksCard from '@/components/dashboard/OfficeTasksCard';

export const dynamic = 'force-dynamic';

export default function TasksPage() {
  return (
    <OperatorShell active="tasks">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold" style={{ color: 'var(--op-text)' }}>
            Office Tasks
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-dim)' }}>
            Everything the team owes someone. Shared: anyone can pick up any task, whoever it came from and whoever it
            is assigned to.
          </p>
        </div>
        <OfficeTasksCard variant="page" />
      </main>
    </OperatorShell>
  );
}
