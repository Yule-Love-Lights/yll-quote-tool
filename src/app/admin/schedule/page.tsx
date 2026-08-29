// Dispatch / day view (P4P Phase 3 — scheduling).
//
// Server component: loads the crew roster once, then hands off to the client
// view for the day picker and the assign/unassign interactions.

import { OperatorShell } from '@/components/OperatorShell';
import { ScheduleDay } from '@/components/ops/ScheduleDay';
import { listActiveFieldCrew } from '@/lib/crewMembers';

export const dynamic = 'force-dynamic';

export default async function SchedulePage() {
  // FIELD crew only — office staff (operators) are not dispatchable to jobs, so
  // they must not appear in the assign/book dropdowns (office/field flag).
  //
  // null means the roster could NOT be read. Until 2026-08-29 a failure here
  // became an empty array, so the assign-crew dropdown rendered empty and
  // nothing on the page that gates ALL scheduling said anything had failed
  // (row 455, the same silent-empty shape PR #1036 fixed on the geocode
  // fix-list). The day's jobs still render; only the roster is missing.
  const crew = await listActiveFieldCrew().catch(() => null);

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

        {crew === null && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            The crew list could not be loaded, so the assign-crew dropdowns are empty even if
            people are available. Reload the page; if this keeps happening, tell whoever
            maintains the tool.
          </div>
        )}

        <ScheduleDay
          crew={(crew ?? []).map((c) => ({ id: c.id, displayName: c.displayName, active: c.active }))}
        />
      </main>
    </OperatorShell>
  );
}
