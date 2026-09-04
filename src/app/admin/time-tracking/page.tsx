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
import { PageHeader, StatStrip, StatTile } from '@/components/time/timeUi';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { listTimeExceptions } from '@/lib/opsTimeExceptions';
import { listActiveCrewMembers } from '@/lib/crewMembers';
import { formatHours, loadHoursSummary } from '@/lib/hoursSummary';

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

  // The strip at the top is the same rows the table below shows, summed:
  // nothing is read twice, so the two cannot disagree. It is HOURS, like the
  // table — nothing on this page is approved or paid. When some rows could
  // not be read the sums are short by exactly those rows, and the tile says
  // so rather than presenting a smaller number as the whole.
  const clockedIn = hours.rows.filter((r) => r.openShift);
  const todaySeconds = hours.rows.reduce((s, r) => s + r.todaySeconds, 0);
  const last7Seconds = hours.rows.reduce((s, r) => s + r.last7Seconds, 0);
  const incomplete = hours.errors.length > 0;
  const clockedInNames = clockedIn.map((r) => r.displayName);
  // Direction-neutral on purpose (technical lens on PR #1218): a shifts read
  // failure leaves these SHORT, a breaks read failure leaves them too HIGH
  // (hoursSummary.ts names both), so "incomplete" would be wrong half the
  // time. The card below says exactly which read failed.
  const readFailed = 'a read failed — this figure may be wrong, see below';
  // The queue's own read, not the crew-name lookup: a missing name falls
  // back to a short id inside the section, the queue itself is still whole.
  const exceptionsFailed = errors.length > 0;

  return (
    <OperatorShell active="time">
      <main className="max-w-5xl mx-auto">
        <PageHeader title="Time tracking" subtitle="Only admins see this page." />

        <StatStrip>
          {/* All four flip on a failed read, not just the two that sum
              (admin lens on PR #1218): a confident "0 — nobody on the
              clock" over a failed shifts read is the tile lying. */}
          <StatTile
            label="Clocked in now"
            value={String(clockedIn.length)}
            tone={incomplete ? 'muted' : clockedIn.length > 0 ? 'good' : 'muted'}
            sub={
              incomplete
                ? readFailed
                : clockedInNames.length === 0
                  ? 'nobody on the clock'
                  : clockedInNames.length <= 3
                    ? clockedInNames.join(', ')
                    : `${clockedInNames.slice(0, 2).join(', ')} and ${clockedInNames.length - 2} more`
            }
          />
          <StatTile
            label="Today"
            value={formatHours(todaySeconds)}
            tone={incomplete ? 'muted' : 'default'}
            sub={incomplete ? readFailed : 'all staff, still counting'}
          />
          <StatTile
            label="Last 7 days"
            value={formatHours(last7Seconds)}
            tone={incomplete ? 'muted' : 'default'}
            sub={incomplete ? readFailed : 'all staff, today included'}
          />
          <StatTile
            label="Open exceptions"
            value={exceptionsFailed ? '—' : String(exceptions.length)}
            tone={exceptionsFailed || exceptions.length > 0 ? 'warn' : 'muted'}
            sub={
              exceptionsFailed
                ? 'could not be read — see below'
                : exceptions.length > 0
                  ? 'need a human — see below'
                  : 'nothing stuck'
            }
          />
        </StatStrip>

        <HoursSummarySection rows={hours.rows} errors={hours.errors} />

        <TimeExceptionsSection
          exceptions={exceptions}
          crewNames={crewNames}
          errors={[...errors, ...errsFromCrew]}
        />
      </main>
    </OperatorShell>
  );
}
