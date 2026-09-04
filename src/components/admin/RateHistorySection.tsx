'use client';

// A staff member's PAY RATE HISTORY — ledger row 506.
//
// Until this existed there was nowhere in the app to say "she was on $13.00
// in August and $16.00 from September", so every conversion from money to
// hours used the person's rate TODAY and marked off the wrong number of hours
// for every shift worked before their last raise. This is where the real
// history gets entered.
//
// WHAT AN EDIT HERE CAN AND CANNOT DO, because that is the question anybody
// hesitating over a past date is actually asking. It changes what FUTURE
// payments convert at. It cannot change a payment already recorded: each
// settlement line carries the rate it was paid at, stamped at the time, and
// nothing re-derives it from this table. The panel says so, out loud, rather
// than leaving an admin to guess whether backdating a rate will quietly
// rewrite last month's payroll.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  Card,
  EmptyState,
  ErrorNote,
  Pill,
  btnPrimary,
  btnPrimaryStyle,
  btnTextDanger,
  inputClass,
  labelClass,
} from '@/components/time/timeUi';
import { rateForDay, type CrewMemberRate } from '@/lib/crewMemberRates';
import { dollars } from '@/lib/shiftSettlements';

/** `2026-08-12` as a person reads it, without dragging it through a
 * timezone: the string is already an ET calendar day, so parsing it into a
 * Date and formatting that back would be free to move it a day. */
function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${d} ${months[m - 1]} ${y}`;
}

export function RateHistorySection({
  crewMemberId,
  crewName,
  rates,
  todayEt,
  readable,
}: {
  crewMemberId: string;
  crewName: string;
  /** Every rate row for this person, OLDEST FIRST. */
  rates: CrewMemberRate[];
  /** Today's ET calendar day, `YYYY-MM-DD`, resolved on the SERVER. Passed in
   * rather than computed here so the server render and the client hydration
   * cannot disagree, and so there is one implementation of "what ET day is
   * it" rather than two. */
  todayEt: string;
  /** False when the read FAILED. The panel then says nothing about rates at
   * all rather than showing an empty history, which would read as "this
   * person has never had a rate" — the one thing that is certainly wrong,
   * since the migration seeded a row for everybody. */
  readable: boolean;
}) {
  const router = useRouter();
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>, confirmText?: string) {
    if (busy) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/crew-rates', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewMemberId, ...body }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setBusy(false);
      if (!res.ok) {
        setError(data?.error ?? `Could not save the rate (${res.status}).`);
        return;
      }
      setRate('');
      setFrom('');
      router.refresh();
    } catch {
      setBusy(false);
      setError('Could not reach the server.');
    }
  }

  // "Current" means the rate IN FORCE TODAY, resolved by the same function
  // the money maths uses — NOT simply the newest row. Nothing stops a raise
  // being entered ahead of time, and taking the last row would then badge a
  // future rate as current while `base_rate_cents` and the pay panel both
  // correctly still used the old one: two panels on one page disagreeing
  // about what somebody is paid. Found independently by three review lenses
  // on PR #1214, which is what makes it a class rather than a nit.
  //
  // `todayEt` arrives as a PROP, computed on the server with the same
  // `etDayKey` the money maths uses. Deriving it here from the browser clock
  // meant this component rendered once on the server and again on hydration
  // from two different clocks, which can disagree across ET midnight and
  // produce a hydration mismatch (delta-verify on PR #1214) — and it was a
  // second, private implementation of "what ET day is it" sitting beside the
  // repo's own.
  const currentCents = rateForDay(rates, todayEt);
  // The row that supplies it: the newest one that has already started.
  const currentRow =
    [...rates]
      .filter((r) => r.effectiveFrom <= todayEt)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
      .pop() ?? null;

  return (
    // The word "current" appears in this file's markup ONLY on the badge in
    // the list: rateHistorySection.test orders it against the row dates, so
    // no header, help sentence or attribute above the list may use it.
    <Card
      title="Rate history"
      subtitle={`What ${crewName} is paid per hour, and from when.`}
      helpLabel="What changing a rate does"
      help={
        <p>
          Hours are always converted at the rate in force on the day they were worked — so
          entering a past raise fixes what older shifts are worth. It does not change a payment
          already recorded: those keep the rate they were paid at.
        </p>
      }
      flush
    >
      {!readable ? (
        <div className="p-4 sm:p-5">
          <ErrorNote
            items={[
              'The rate history could not be read, so nothing can be changed here right now. Reload in a moment.',
            ]}
          />
        </div>
      ) : (
        <>
          <div
            className="flex flex-wrap items-end gap-3 border-b px-4 py-4 sm:px-5"
            style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg)' }}
          >
            <label className={labelClass}>
              Hourly rate
              <span className="mt-1 block">
                <input
                  type="text"
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="16.00"
                  className={`${inputClass} w-28`}
                />
              </span>
            </label>
            <label className={labelClass}>
              From (Eastern)
              <span className="mt-1 block">
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className={inputClass}
                />
              </span>
            </label>
            <button
              type="button"
              disabled={busy || !rate.trim() || !from}
              onClick={() =>
                send('POST', { hourlyRate: rate.trim(), effectiveFrom: from }, [
                  `Set ${crewName}'s rate to $${rate.trim()} per hour from ${fmtDay(from)}?`,
                  '',
                  'Every unpaid hour on or after that day will be worth this from now on.',
                  'Payments already recorded keep the rate they were paid at and do not move.',
                ].join('\n'))
              }
              className={btnPrimary}
              style={btnPrimaryStyle}
            >
              {busy ? 'Saving…' : 'Add rate'}
            </button>
            {/* Setting the same day twice CORRECTS it rather than adding a
                second row, so a typo is fixable without a delete. Said here
                because the button reads "Add". */}
            <span className="text-xs text-gray-500">
              Adding a rate for a day that already has one replaces it.
            </span>
            {error && <span className="basis-full text-sm text-red-700">{error}</span>}
          </div>

          {currentCents > 0 && (
            <p
              className="border-b px-4 py-2.5 text-xs text-gray-500 sm:px-5"
              style={{ borderColor: 'var(--op-border)' }}
            >
              Paid <span className="font-semibold tabular-nums text-gray-900">{dollars(currentCents)}/hr</span>{' '}
              today. Entering a history oldest-first will move this figure as you go — it is
              whichever rate has started and is newest, so add the later ones before relying on
              it.
            </p>
          )}
          {rates.length === 0 ? (
            <div className="p-4 sm:p-5">
              <EmptyState>
                No rate on record, so none of {crewName}&apos;s hours can be paid yet. Add one.
              </EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {[...rates].reverse().map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm sm:px-5"
                >
                  <span className="font-semibold tabular-nums text-gray-900">
                    {dollars(r.rateCentsPerHour)}/hr
                  </span>
                  <span className="text-gray-500">from {fmtDay(r.effectiveFrom)}</span>
                  {currentRow && r.id === currentRow.id && (
                    <Pill tone="green" nowrap>
                      current
                    </Pill>
                  )}
                  {/* A rate that has not started yet. Without this it looks
                      identical to a past rate, and the only way to tell
                      them apart is to read the date and do the comparison
                      yourself. */}
                  {r.effectiveFrom > todayEt && (
                    <Pill tone="blue" nowrap>
                      starts later
                    </Pill>
                  )}
                  {r.createdBy && (
                    <span className="text-xs text-gray-400">set by {r.createdBy}</span>
                  )}
                  <button
                    type="button"
                    disabled={busy || rates.length <= 1}
                    onClick={() =>
                      send('DELETE', { rateId: r.id }, [
                        `Remove the ${dollars(r.rateCentsPerHour)}/hr rate from ${fmtDay(r.effectiveFrom)}?`,
                        '',
                        'Those days will fall back to whatever rate came before them, and any day with no earlier rate cannot be paid at all until one is added.',
                        'Payments already recorded do not move.',
                      ].join('\n'))
                    }
                    className={`ml-auto ${btnTextDanger}`}
                    title={
                      rates.length <= 1
                        ? 'The only rate on record cannot be removed — change the figure instead.'
                        : undefined
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
