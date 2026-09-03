// One person's time record — time-tracking plan phase 2. Day-by-day hours
// for a chosen rolling range, the edit and void controls beside each shift,
// and the manual-write trail for that person (ledger row 473).
//
// ADMIN ONLY, gated server-side exactly like its parent /admin/time-tracking:
// unconfigured, signed-out, crew and advertising logins all read as no
// access, and any non-admin is redirected before data loads. The perimeter
// (src/proxy.ts) only proves you are SOME operator; this check is what keeps
// one staff member off another's pay record.
//
// This is also the FIRST editor for an office person's shifts. The two clocks
// page shows field shifts only (fleetDay.ts, Naldo's 2026-08-28 ruling), so
// until this page existed an office clock-out nobody remembered to make could
// not be corrected anywhere in the app. adminUpdateShiftTimes and
// adminVoidShift carry no is_office condition and never did, so no guard is
// relaxed here — the rows were always writable, and had no screen.
//
// Deliberately NOT here: adding a shift from nothing for an office person.
// adminCreateShift refuses that by name ('not-field-crew'), and lifting a
// payroll guard is its own decision with its own review, not a side effect of
// building a page. Ledger row for it, not a quiet change.

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import {
  PersonHoursSection,
  ShiftAuditSection,
  ShiftPaySection,
} from '@/components/admin/PersonHoursSections';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { isRangeKey, loadPersonTime, type RangeKey } from '@/lib/personHours';
import { listSettlements, summarize, unpaidRemainders } from '@/lib/shiftSettlements';

export const dynamic = 'force-dynamic';

const DEFAULT_RANGE: RangeKey = '30';

export default async function PersonTimePage({
  params,
  searchParams,
}: {
  params: Promise<{ crewMemberId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const role = await getSessionRole();
  if (role !== 'admin') redirect('/');

  const { crewMemberId } = await params;
  const query = (await searchParams) ?? {};
  const rawRange = Array.isArray(query.range) ? query.range[0] : query.range;
  const range: RangeKey = isRangeKey(rawRange) ? rawRange : DEFAULT_RANGE;

  const time = await loadPersonTime(crewMemberId, range);
  // Read separately from the hours so a settlement-read failure cannot empty
  // the hours table; the pay section hides itself instead (see
  // settlementsReadable).
  const settlements = time.person
    ? await listSettlements(crewMemberId).catch((e: unknown) => {
        console.error('[time-tracking] settlements read failed:', e);
        return null;
      })
    : null;
  const settlementSummary = summarize(settlements ?? []);
  // NOT scoped to the range on screen. Phase 3 scoped the payable list to the
  // chosen range so an admin paying "the last two weeks" could not settle a
  // shift from March by accident. That reasoning died with the tick-boxes:
  // the server now spends a payment across ALL unpaid shifts oldest first, so
  // a range-scoped preview would describe an allocation that is not the one
  // about to happen — the confirm dialog would name the wrong shifts whenever
  // an older unpaid shift sat outside the window (admin lens on PR #1190).
  const remainders = time.person
    ? await unpaidRemainders(time.person.id).catch((e: unknown) => {
        console.error('[time-tracking] unpaid remainders read failed:', e);
        return null;
      })
    : null;
  const basePath = `/admin/time-tracking/${encodeURIComponent(crewMemberId)}`;

  if (!time.person) {
    return (
      <OperatorShell active="time">
        <main className="max-w-4xl mx-auto">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-gray-900">Nobody by that id</h1>
            <p className="text-sm text-gray-500 mt-1">
              {time.errors.length > 0
                ? // A read FAILURE and a genuinely missing person must not
                  // look the same: one is worth retrying, the other is a bad
                  // link.
                  `This person's record could not be read: ${time.errors.join('; ')}`
                : 'No staff member has this id. They may have been deleted.'}
            </p>
            <p className="text-sm mt-3">
              <Link href="/admin/time-tracking" className="underline">
                Back to everyone&apos;s hours
              </Link>
            </p>
          </div>
        </main>
      </OperatorShell>
    );
  }

  const { person } = time;

  return (
    <OperatorShell active="time">
      <main className="max-w-4xl mx-auto">
        <div className="mb-6">
          <p className="text-xs mb-1">
            <Link href="/admin/time-tracking" className="text-gray-500 underline">
              ← Everyone&apos;s hours
            </Link>
          </p>
          <h1 className="text-xl font-semibold text-gray-900">
            {person.displayName}
            {!person.active && (
              <span className="ml-2 text-sm font-normal text-gray-400">(inactive)</span>
            )}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {person.isOffice ? 'Office' : 'Field crew'} · times are Eastern · only admins see this
            page.
          </p>
        </div>

        <PersonHoursSection
          crewName={person.displayName}
          isOffice={person.isOffice}
          days={time.days}
          range={time.range}
          totalSeconds={time.totalSeconds}
          shiftCount={time.shiftCount}
          autoClosed={time.autoClosed}
          openShift={time.openShift}
          errors={time.errors}
          basePath={basePath}
        />

        <ShiftPaySection
          crewMemberId={person.id}
          crewName={person.displayName}
          rateCentsPerHour={person.baseRateCents}
          remainders={remainders ?? []}
          range={time.range}
          settlements={settlements ?? []}
          settledCents={settlementSummary.settledCents}
          halfUndone={settlementSummary.halfUndone}
          // Both reads have to have worked: the marks say which shifts are
          // already paid, the list says what was paid. Either failing makes
          // the panel misleading rather than merely incomplete.
          // The remainder read is part of the same claim: without it the
          // panel cannot say what is unpaid, so it must hide rather than
          // show a shorter list than the truth.
          settlementsReadable={time.settlementsReadable && settlements !== null && remainders !== null}
        />

        <ShiftAuditSection entries={time.audit} partial={time.auditPartial} />
      </main>
    </OperatorShell>
  );
}
