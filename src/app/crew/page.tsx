import { cookies } from 'next/headers';

import { CREW_COOKIE_NAME, resolveCrewCaller } from '@/lib/auth/crewSession';
import { businessToday, getMyDay } from '@/lib/crew/myDay';

export const dynamic = 'force-dynamic';

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
      denied === 'expired'
        ? 'That link has expired. Links last 15 minutes, so ask the office for a fresh one.'
        : 'This link is not valid any more. Ask the office to send you a new one.';
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
          {items.map((item) => (
            <li key={item.assignmentId} className="rounded-lg border border-gray-200 px-4 py-3">
              <p className="text-sm font-semibold text-gray-900">
                {item.jobNumber === null ? 'Job' : `Job #${item.jobNumber}`}
              </p>
              <p className="mt-1 text-sm text-gray-700">{item.address ?? 'Address not on file, ask the office'}</p>
              {item.status && <p className="mt-1 text-xs uppercase tracking-wide text-gray-500">{item.status}</p>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
