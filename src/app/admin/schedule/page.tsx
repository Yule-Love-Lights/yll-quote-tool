// Dispatch / day view (P4P Phase 3 — scheduling).
//
// Server component: loads the crew roster once, then hands off to the client
// view for the day picker and the assign/unassign interactions.

import { OperatorShell } from '@/components/OperatorShell';
import { ScheduleDay } from '@/components/ops/ScheduleDay';
import { listActiveCrewMembers } from '@/lib/crewMembers';

export const dynamic = 'force-dynamic';

export default async function SchedulePage() {
  const crew = await listActiveCrewMembers().catch(() => []);

  return (
    <OperatorShell active="jobs">
      <main className="max-w-3xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Schedule</h1>
          <p className="text-sm text-gray-500 mt-1">
            Who is on which job, and how many hours that puts on each person for the day.
          </p>
        </div>

        <ScheduleDay
          crew={crew.map((c) => ({ id: c.id, displayName: c.displayName, active: c.active }))}
        />
      </main>
    </OperatorShell>
  );
}
