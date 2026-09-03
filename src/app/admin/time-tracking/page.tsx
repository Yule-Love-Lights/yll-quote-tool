// Time tracking, admin only (Naldo, 2026-08-28: "a page just for admin to see
// to track all time tracking data, but just create a placeholder for now").
// The shell for the crew-time surfaces. Its first content was the
// time-exception queue (row 278's API, given a UI here); the per-person
// HOURS table landed next (Jason S59, time-tracking plan phase 1,
// docs/context/project_time_tracking.md). Hours only: no rate, no money, no
// approval, by the plan's section 4.4.
//
// An earlier version of this comment said hours views waited on the
// seed-rates session because laborPlan.ts blocks payout display on
// placeholder rates. That was never true of hours: laborPlan.ts gates only
// the per-job budget columns (jobs.budgeted_hours / labor_revenue_cents) and
// never touches shifts. Money views DO still wait, on a decision, not a gate.
//
// ADMIN ONLY, gated server-side on the session role exactly like
// /admin/fleet/clocks (#1046): unconfigured, signed-out, and crew logins all
// read as no access, and any non-admin is redirected before data loads.

import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { TimeExceptionsSection } from '@/components/admin/TimeExceptionsSection';
import { HoursSummarySection } from '@/components/admin/HoursSummarySection';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { listTimeExceptions } from '@/lib/opsTimeExceptions';
import { listActiveCrewMembers } from '@/lib/crewMembers';
import { loadHoursSummary } from '@/lib/hoursSummary';

export const dynamic = 'force-dynamic';

export default async function TimeTrackingPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  // Per-request scratch for the crew-lookup failure message (a module-level
  // array here would be shared across requests).
  const errsFromCrew: string[] = [];
  const [hours, { exceptions, errors }, crew] = await Promise.all([
    // Read-only aggregation; its own read failures render as an error card
    // inside the Hours section rather than an all-clear table of zeros.
    loadHoursSummary(),
    listTimeExceptions(),
    // Names for the queue; a since-deactivated member's exception falls back
    // to a short id inside the section. Failures surface as an errors row
    // rather than hiding the queue.
    listActiveCrewMembers().catch((e: unknown) => {
      errsFromCrew.push(e instanceof Error ? e.message : 'crew member lookup failed');
      return [];
    }),
  ]);
  const crewNames = new Map(crew.map((c) => [c.id, c.displayName]));

  return (
    <OperatorShell active="time">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Time tracking</h1>
          <p className="text-sm text-gray-500 mt-1">
            Crew time data in one place. Only admins see this page. Today it holds everyone&apos;s
            hours and the time-exception queue; more views land here as they are built.
          </p>
        </div>

        <HoursSummarySection rows={hours.rows} asOf={hours.asOf} errors={hours.errors} />

        <TimeExceptionsSection
          exceptions={exceptions}
          crewNames={crewNames}
          errors={[...errors, ...errsFromCrew]}
        />
      </main>
    </OperatorShell>
  );
}
