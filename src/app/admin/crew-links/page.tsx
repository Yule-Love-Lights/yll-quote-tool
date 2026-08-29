// My Day links, admin only (ledger row 466, Naldo's 2026-08-29 Telegram ruling).
//
// Crew logins were retired, so a crew member reaches My Day through a signed
// link the office sends them. This page is where that link is made. It lives
// here rather than in Settings because Settings is Jason's area and the
// placement was Naldo's call; the route it uses is admin-gated on its own.
//
// ADMIN ONLY, gated server-side exactly like /admin/time-tracking: unconfigured,
// signed-out and non-admin all redirect before any data loads.

import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { CrewLinkButton } from '@/components/admin/CrewLinkButton';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { listActiveFieldCrew } from '@/lib/crewMembers';

export const dynamic = 'force-dynamic';

export default async function CrewLinksPage() {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  // listActiveFieldCrew returns NULL when the roster could not be read, never
  // an empty array, precisely so a page cannot render "nobody is set up yet"
  // over a broken query (row 455). Say which one it is.
  let crew: Awaited<ReturnType<typeof listActiveFieldCrew>> = null;
  let loadError: string | null = null;
  try {
    crew = await listActiveFieldCrew();
    if (crew === null) loadError = 'Could not load the crew list. This is a read failure, not an empty roster.';
  } catch {
    loadError = 'Could not load the crew list.';
  }

  const linked = (crew ?? []).filter((c) => c.telegramUserId);
  const unlinked = (crew ?? []).filter((c) => !c.telegramUserId);

  return (
    <OperatorShell active="time">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-xl font-semibold text-gray-900">My Day links</h1>
        <p className="mt-1 text-sm text-gray-600">
          Send a crew member their own link to today&apos;s jobs. Each link works for 15 minutes and one use, and
          making a new one cancels the last.
        </p>

        {loadError && <p className="mt-6 text-sm text-red-700">{loadError}</p>}

        {!loadError && linked.length === 0 && (
          <p className="mt-6 rounded-lg bg-gray-50 px-4 py-6 text-sm text-gray-600">
            Nobody is set up yet. Link a crew member&apos;s Telegram account in Settings, Accounts first.
          </p>
        )}

        {linked.length > 0 && (
          <ul className="mt-6 space-y-4">
            {linked.map((member) => (
              <li key={member.id} className="rounded-lg border border-gray-200 px-4 py-3">
                <p className="text-sm font-semibold text-gray-900">{member.displayName}</p>
                <CrewLinkButton crewMemberId={member.id} displayName={member.displayName} />
              </li>
            ))}
          </ul>
        )}

        {unlinked.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-gray-900">Not set up yet</h2>
            <p className="mt-1 text-sm text-gray-600">
              These crew members have no Telegram account linked, so there is nothing to identify them by and no link
              can be made. Link them in Settings, Accounts.
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm text-gray-700">
              {unlinked.map((member) => (
                <li key={member.id}>{member.displayName}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </OperatorShell>
  );
}
