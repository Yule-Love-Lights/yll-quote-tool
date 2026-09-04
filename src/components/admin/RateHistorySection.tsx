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

import type { CrewMemberRate } from '@/lib/crewMemberRates';
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
  readable,
}: {
  crewMemberId: string;
  crewName: string;
  /** Every rate row for this person, OLDEST FIRST. */
  rates: CrewMemberRate[];
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

  const newest = rates.length > 0 ? rates[rates.length - 1] : null;

  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Rate history</h2>
      <p className="text-sm text-gray-500 mb-4">
        What {crewName} is paid per hour, and from when. Hours are always converted at the rate in
        force on the day they were worked — so entering a past raise fixes what older shifts are
        worth. It does not change a payment already recorded: those keep the rate they were paid
        at.
      </p>

      {!readable ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          The rate history could not be read, so nothing can be changed here right now. Reload in a
          moment.
        </div>
      ) : (
        <>
          <div className="rounded-md border border-gray-200">
            <div className="flex flex-wrap items-end gap-3 border-b border-gray-200 px-3 py-3">
              <label className="text-xs text-gray-600">
                Hourly rate
                <span className="block mt-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    placeholder="16.00"
                    className="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </span>
              </label>
              <label className="text-xs text-gray-600">
                From (Eastern)
                <span className="block mt-1">
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
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
                className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--brand-evergreen-3)' }}
              >
                {busy ? 'Saving…' : 'Add rate'}
              </button>
              {/* Setting the same day twice CORRECTS it rather than adding a
                  second row, so a typo is fixable without a delete. Said here
                  because the button reads "Add". */}
              <span className="text-xs text-gray-400">
                Adding a rate for a day that already has one replaces it.
              </span>
            </div>

            {rates.length === 0 ? (
              <p className="px-3 py-3 text-sm text-gray-500">
                No rate on record, so none of {crewName}&apos;s hours can be paid yet. Add one.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {[...rates].reverse().map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline gap-3 px-3 py-2 text-sm">
                    <span className="font-medium tabular-nums">{dollars(r.rateCentsPerHour)}/hr</span>
                    <span className="text-gray-500">from {fmtDay(r.effectiveFrom)}</span>
                    {newest && r.id === newest.id && (
                      <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800">
                        current
                      </span>
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
                      className="ml-auto text-xs text-red-700 underline disabled:opacity-40 disabled:no-underline"
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
          </div>
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        </>
      )}
    </section>
  );
}
