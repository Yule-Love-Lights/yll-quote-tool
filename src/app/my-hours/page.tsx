// Your own hours — time-tracking plan phase 4, the staff self-view.
//
// This is the FIRST reduced-own-view page in the app. Every other role gate
// here is a binary redirect: you are an admin and you see everything, or you
// are sent to the homepage. This one shows the same shape of record to
// everyone and changes WHOSE rows are in it, which is a different kind of
// gate and had to be designed rather than copied.
//
// IDENTITY IS RESOLVED SERVER-SIDE AND IS NOT IN THE URL. There is no
// [crewMemberId] segment and no id accepted from the client in any form:
// getOfficeClockCaller reads the session's auth_user_id and looks up the
// crew_members row pointing at it, which is the same resolver the office web
// clock writes payroll through. A staff member cannot ask for someone else's
// hours because there is nowhere to put the request.
//
// IT FAILS CLOSED, WITH A NAMED STATE. Every refusal reason gets its own
// sentence rather than an empty table: an unlinked login (auth_user_id is
// null until an admin links it) must never fall through to "no shifts", which
// is what a person who worked all week would read as their hours being lost.
//
// NO CONTROLS AND NO MONEY (plan phase 4, and section 4.4). The edit, remove
// and pay controls are ABSENT from the markup, not hidden — `controls="none"`
// renders none of it — and the page never reads settlements at all, so no pay
// figure exists on it to leak. Correcting a shift stays an admin action on
// /admin/time-tracking/[crewMemberId], and the copy says so.
//
// NO CLOCK IN/OUT BUTTONS HERE, deliberately: the plan asked for them, and
// they already exist on every operator page. Naldo moved ClockCard into the
// header on 2026-09-01 (desktop) with the mobile hamburger covered too, so
// this page carries the clock in its own nav bar already. A second clock on
// the hours page would be two controls for one state, which is exactly how
// two of them drift apart.

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import { MyHoursSection } from '@/components/time/MyHoursSection';
import { getOfficeClockCaller, type OfficeLookup } from '@/lib/auth/officeClock';
import { isRangeKey, loadPersonTime, type RangeKey } from '@/lib/personHours';

export const dynamic = 'force-dynamic';

const DEFAULT_RANGE: RangeKey = '30';

/**
 * What to say for each way the identity lookup can refuse. One sentence per
 * reason, because "no hours" is the one answer that must never stand in for
 * any of them.
 *
 * KEYED OFF THE UNION, not `Record<string, …>`. A new reason added to
 * `OfficeLookup` later must break the BUILD here, the way it already breaks
 * `officeDenialResponse`'s switch — with a loose key type it would compile
 * happily and then read `copy.title` off `undefined` at request time, so the
 * first person to hit the new reason would get a 500 instead of a sentence.
 * No test can cover a reason that does not exist yet; the type is the only
 * thing that can.
 */
const DENIAL: Record<
  Exclude<Exclude<OfficeLookup, { ok: true }>['reason'], 'unauthenticated'>,
  { title: string; body: string }
> = {
  is_crew: {
    title: 'Crew hours are not on the website',
    body: 'Crew clock in and out through Telegram, and their hours live with the office. Ask the office for your hours.',
  },
  is_advertising: {
    title: 'This login has no time record',
    body: 'Advertising logins do not clock in, so there are no hours attached to this account.',
  },
  unlinked: {
    title: 'This login is not linked to your staff record yet',
    body: 'Your hours are being recorded against a staff record, and this login has not been joined to one, so nothing can be shown here yet. An admin links it from Settings → Accounts.',
  },
  inactive: {
    title: 'This staff record is not active',
    body: 'The record your login points at has been deactivated, so no hours are shown. An admin can reactivate it from Settings → Accounts.',
  },
  unconfigured: {
    title: 'Hours are unavailable right now',
    body: 'The time record could not be reached. This is not about your account — try again in a moment.',
  },
};

function DenialPage({ title, body }: { title: string; body: string }) {
  return (
    <OperatorShell active="time">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
          <p className="text-sm text-gray-500 mt-1">{body}</p>
          <p className="text-sm mt-3">
            <Link href="/" className="underline">
              Back to the dashboard
            </Link>
          </p>
        </div>
      </main>
    </OperatorShell>
  );
}

export default async function MyHoursPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getOfficeClockCaller();
  if (!auth.ok) {
    // A signed-out caller is not a state to explain, it is a sign-in; every
    // other page in the shell sends them the same way.
    if (auth.reason === 'unauthenticated') redirect('/');
    const copy = DENIAL[auth.reason];
    return <DenialPage title={copy.title} body={copy.body} />;
  }

  const query = (await searchParams) ?? {};
  const rawRange = Array.isArray(query.range) ? query.range[0] : query.range;
  const range: RangeKey = isRangeKey(rawRange) ? rawRange : DEFAULT_RANGE;

  // withSettlements: false — this page shows no money and offers no edit, so
  // reading which shifts are paid would buy nothing and its failure message
  // ("nothing can be paid or corrected from this page") would be false copy
  // on a page where nothing ever could be.
  const time = await loadPersonTime(auth.caller.crewMemberId, range, undefined, {
    withSettlements: false,
  });

  // The identity resolved but the record read failed: say that, rather than
  // rendering an empty week under the person's own name.
  if (!time.person) {
    return (
      <DenialPage
        title="Your hours could not be read"
        body={
          time.errors.length > 0
            ? `Something went wrong reading your record: ${time.errors.join('; ')}`
            : 'Your staff record could not be found. Ask an admin to check it.'
        }
      />
    );
  }

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
          <h1 className="text-xl font-semibold text-gray-900">My hours</h1>
          <p className="text-sm text-gray-500 mt-1">
            {time.person.displayName} · times are Eastern · only you and an admin see this.
          </p>
        </div>

        <MyHoursSection
          days={time.days}
          range={time.range}
          totalSeconds={time.totalSeconds}
          shiftCount={time.shiftCount}
          autoClosed={time.autoClosed}
          openShift={time.openShift}
          errors={time.errors}
          basePath="/my-hours"
        />
      </main>
    </OperatorShell>
  );
}
