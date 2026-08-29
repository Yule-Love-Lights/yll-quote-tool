import { cookies } from 'next/headers';

import { JOB_STATUS_LABELS } from '@/components/admin/JobStatusBadge';
import { CREW_COOKIE_NAME, resolveCrewCaller } from '@/lib/auth/crewSession';
import { businessToday, getMyDay } from '@/lib/crew/myDay';
import type { JobStatus } from '@/lib/jobStatus';

export const dynamic = 'force-dynamic';

// Jobs a crew member must NOT drive to. They are shown rather than hidden,
// because a job vanishing from the list reads as an app fault when someone was
// told this morning to be there (staff lens, PR #1094).
const CALLED_OFF: ReadonlySet<string> = new Set<JobStatus>(['cancelled', 'done']);

function statusLabel(status: string | null): string | null {
  if (!status) return null;
  return JOB_STATUS_LABELS[status as JobStatus] ?? status;
}

const DENIED_MESSAGE: Record<string, string> = {
  expired: 'That link has expired. Links last 15 minutes, so ask the office for a fresh one.',
  used: 'That link has already been used. Ask the office for a new one.',
};

/**
 * My Day: the crew member's own list for today, opened from the signed link the
 * office sends them (row 466). No login form, because crew logins were retired:
 * a crew member with no valid session is told to ask for a new link, which is
 * the only way back in.
 *
 * Read-only and money-free by construction (see lib/crew/myDay.ts).
 */
export default async function CrewMyDayPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const { denied } = await searchParams;
  const store = await cookies();
  const caller = await resolveCrewCaller(store.get(CREW_COOKIE_NAME)?.value);

  if (!caller.ok) {
    const message =
      (denied && DENIED_MESSAGE[denied]) ??
      'You need a link from the office to open this page. Ask them to send you one.';
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-semibold text-gray-900">My Day</h1>
        <p className="mt-4 text-sm text-gray-600">{message}</p>
      </main>
    );
  }

  const date = businessToday();
  const items = await getMyDay(caller.member.id, date);

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <header>
        <h1 className="text-xl font-semibold text-gray-900">My Day</h1>
        <p className="mt-1 text-sm text-gray-600">
          {caller.member.displayName} · {date}
        </p>
      </header>

      {items.length === 0 ? (
        <p className="mt-8 rounded-lg bg-gray-50 px-4 py-6 text-center text-sm text-gray-600">
          Nothing scheduled for you today.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((item) => {
            const calledOff = item.status !== null && CALLED_OFF.has(item.status);
            return (
              <li
                key={item.assignmentId}
                className={`rounded-lg border px-4 py-3 ${
                  calledOff ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
                }`}
              >
                <p className="text-sm font-semibold text-gray-900">
                  {item.jobNumber === null ? 'Job' : `Job #${item.jobNumber}`}
                </p>
                <p className="mt-1 text-sm text-gray-700">
                  {item.address ?? 'Address not on file, ask the office'}
                </p>
                {calledOff && (
                  <p className="mt-2 text-sm font-semibold text-amber-800">
                    Do not go: this job is {item.status === 'cancelled' ? 'cancelled' : 'finished'}. Check with the
                    office.
                  </p>
                )}
                {!calledOff && statusLabel(item.status) && (
                  <p className="mt-1 text-xs uppercase tracking-wide text-gray-500">{statusLabel(item.status)}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
