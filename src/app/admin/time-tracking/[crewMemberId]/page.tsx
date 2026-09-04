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
// Adding a shift from nothing for an office person now lives here too (S61).
// adminCreateShift used to refuse that by name ('not-field-crew'), reasoning
// that an office row "would also be invisible on the review page afterward" —
// this IS that review page, and it has shown office shifts since it shipped,
// so the reason the refusal existed no longer holds. Ann (office) not
// clocking in on 2026-08-24 is what surfaced there was no way to record her
// hours anywhere. adminUpdateShiftTimes and adminVoidShift still carry no
// is_office condition and never did, so nothing else here changes.

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { OperatorShell } from '@/components/OperatorShell';
import {
  PersonHoursSection,
  ShiftAuditSection,
  ShiftPaySection,
} from '@/components/admin/PersonHoursSections';
import { RateHistorySection } from '@/components/admin/RateHistorySection';
import { PageHeader, Pill, StatStrip, StatTile } from '@/components/time/timeUi';
import { getSessionRole } from '@/lib/auth/sessionRole';
import { listRates, rateForDay } from '@/lib/crewMemberRates';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { formatHours } from '@/lib/hoursSummary';
import { isRangeKey, loadPersonTime, rangeLabel, type RangeKey } from '@/lib/personHours';
import {
  dollars,
  listSettlements,
  summarize,
  unpaidRemainders,
} from '@/lib/shiftSettlements';

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
  // The rate history, read separately for the same reason the settlements
  // are: a failure here must not empty the hours table above it. The section
  // hides itself instead of rendering an empty history, which would read as
  // "this person has never had a rate" — the one answer that is certainly
  // wrong, since every existing person was seeded a row by the row-506
  // migration.
  const rates = time.person
    ? await listRates(time.person.id).catch((e: unknown) => {
        console.error('[time-tracking] rate history read failed:', e);
        return null;
      })
    : null;
  const basePath = `/admin/time-tracking/${encodeURIComponent(crewMemberId)}`;
  // Resolved once, here, so the Add-a-shift default date and the rate
  // history below it cannot land on different days.
  const todayEt = etDayKey(new Date());

  if (!time.person) {
    return (
      <OperatorShell active="time">
        <main className="max-w-5xl mx-auto">
          <PageHeader
            back={{ href: '/admin/time-tracking', label: "Everyone's hours" }}
            title="Nobody by that id"
            subtitle={
              time.errors.length > 0
                ? // A read FAILURE and a genuinely missing person must not
                  // look the same: one is worth retrying, the other is a bad
                  // link.
                  `This person's record could not be read: ${time.errors.join('; ')}`
                : 'No staff member has this id. They may have been deleted.'
            }
          />
          <p className="text-sm">
            <Link href="/admin/time-tracking" className="underline">
              Back to everyone&apos;s hours
            </Link>
          </p>
        </main>
      </OperatorShell>
    );
  }

  const { person } = time;

  // The strip is the same data the sections below render, summed once here
  // so the tile and the section cannot disagree. Each money figure is
  // present only when its own read worked: a failed read shows a dash and
  // says so, never a zero, because "$0.00 paid" and "could not be read" are
  // different facts and only one of them is true.
  const unpaidSeconds = remainders ? remainders.reduce((s, r) => s + r.unpaidSeconds, 0) : null;
  const unpaidShifts = remainders ? remainders.filter((r) => r.unpaidSeconds > 0).length : null;
  // Resolved by the same function the money maths uses, so a raise entered
  // ahead of time does not read as today's rate (three lenses on PR #1214).
  const rateTodayCents = rates ? rateForDay(rates, todayEt) : null;

  return (
    <OperatorShell active="time">
      <main className="max-w-5xl mx-auto">
        <PageHeader
          back={{ href: '/admin/time-tracking', label: "Everyone's hours" }}
          title={person.displayName}
          badges={
            <>
              <Pill tone={person.isOffice ? 'gold' : 'neutral'} nowrap>
                {person.isOffice ? 'Office' : 'Field crew'}
              </Pill>
              {!person.active && (
                <Pill tone="red" nowrap>
                  inactive
                </Pill>
              )}
            </>
          }
          subtitle="Times are Eastern · only admins see this page."
        />

        <StatStrip>
          <StatTile
            label={rangeLabel(range)}
            value={formatHours(time.totalSeconds)}
            sub={`${time.shiftCount} ${time.shiftCount === 1 ? 'shift' : 'shifts'} clocked`}
          />
          <StatTile
            label="Unpaid hours"
            value={unpaidSeconds === null ? '—' : formatHours(unpaidSeconds)}
            tone={unpaidSeconds === null ? 'muted' : unpaidSeconds > 0 ? 'warn' : 'good'}
            sub={
              unpaidSeconds === null
                ? 'could not be read'
                : `${unpaidShifts} closed ${unpaidShifts === 1 ? 'shift' : 'shifts'}, all time`
            }
          />
          <StatTile
            label="Recorded as paid"
            value={settlements === null ? '—' : dollars(settlementSummary.settledCents)}
            tone={settlements === null ? 'muted' : 'default'}
            sub={settlements === null ? 'could not be read' : 'all time, live payments only'}
          />
          <StatTile
            label="Rate today"
            value={
              rateTodayCents === null
                ? '—'
                : rateTodayCents > 0
                  ? `${dollars(rateTodayCents)}/hr`
                  : 'none set'
            }
            tone={rateTodayCents === null ? 'muted' : rateTodayCents > 0 ? 'default' : 'warn'}
            sub={rateTodayCents === null ? 'could not be read' : 'from the rate history below'}
          />
        </StatStrip>

        <PersonHoursSection
          crewMemberId={person.id}
          crewName={person.displayName}
          isOffice={person.isOffice}
          active={person.active}
          days={time.days}
          range={time.range}
          totalSeconds={time.totalSeconds}
          shiftCount={time.shiftCount}
          autoClosed={time.autoClosed}
          openShift={time.openShift}
          errors={time.errors}
          basePath={basePath}
          todayEt={todayEt}
        />

        <ShiftPaySection
          crewMemberId={person.id}
          crewName={person.displayName}
          remainders={remainders ?? []}
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

        <RateHistorySection
          crewMemberId={person.id}
          crewName={person.displayName}
          rates={rates ?? []}
          // Same value the Add-a-shift default date above uses (resolved
          // once, at the top of this render), so the server render and the
          // browser cannot land on different days.
          todayEt={todayEt}
          readable={rates !== null}
        />

        <ShiftAuditSection entries={time.audit} partial={time.auditPartial} />
      </main>
    </OperatorShell>
  );
}
