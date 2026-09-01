// Time tracking, admin only (Naldo, 2026-08-28: "a page just for admin to see
// to track all time tracking data, but just create a placeholder for now").
// The placeholder shell for the crew-time surfaces; its first real content is
// the time-exception queue, whose API shipped in row 278 with no UI. Payroll
// and hours views stay out until the seed-rates session lands real labor
// rates (laborPlan.ts blocks payout display on placeholders by design).
//
// ADMIN ONLY, gated server-side on the session role exactly like
// /admin/fleet/clocks (#1046): unconfigured, signed-out, and crew logins all
// read as no access, and any non-admin is redirected before data loads.

import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { TimeExceptionsSection } from '@/components/admin/TimeExceptionsSection';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { listTimeExceptions } from '@/lib/opsTimeExceptions';
import { listActiveCrewMembers } from '@/lib/crewMembers';

export const dynamic = 'force-dynamic';

export default async function TimeTrackingPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  // Per-request scratch for the crew-lookup failure message (a module-level
  // array here would be shared across requests).
  const errsFromCrew: string[] = [];
  const [{ exceptions, errors }, crew] = await Promise.all([
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
            Crew time data in one place. Only admins see this page. More views land here as they
            are built; today it holds the time-exception queue.
          </p>
        </div>

        <TimeExceptionsSection
          exceptions={exceptions}
          crewNames={crewNames}
          errors={[...errors, ...errsFromCrew]}
        />
      </main>
    </OperatorShell>
  );
}
