'use client';

// Recording a payment against someone's shifts — time-tracking plan phase 3,
// ledger row 459. ADMIN ONLY; the page and the route both gate it.
//
// THE TOOL STILL DOES NOT DECIDE WHAT TO PAY. The amount is typed and the box
// starts EMPTY: pre-filling it with the tool's own figure would make a guess
// the default answer, and a week over forty hours would then be underpaid by
// one click, because overtime has no ruling here (ledger row 285).
//
// WHAT CHANGED 2026-09-03. The admin no longer ticks shifts. The typed amount
// is converted to hours at the person's rate and spent OLDEST FIRST, and
// whatever it does not reach stays unpaid and carries over (Jason's rule,
// after $180.00 was recorded against 20h 34m of work and wrote off the odd 34
// minutes). The list below is a PREVIEW of where the money lands, computed
// with the same allocatePayment the server uses; the server re-runs it
// against a fresh read and remains the authority.
//
// The conversion inherits the overtime limit in the other direction: it is
// exact only while every hour is worth the base rate. That is why the panel
// still shows the rate it is converting at, rather than hiding the sum.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { formatHours } from '@/lib/hoursSummary';
import {
  allocatePayment,
  dollars,
  excessOverHours,
  parseAmountCents,
  referenceCentsFor,
  SETTLEMENT_METHODS,
  type SettlementMethod,
} from '@/lib/shiftSettlements';

export type PayableShift = {
  id: string;
  clockInAt: string;
  /** The whole shift. */
  paidSeconds: number;
  /** What is still owing on it — less than `paidSeconds` once a previous
   * payment has part covered it. This is what a new payment can be spent on. */
  unpaidSeconds: number;
  /** True when the midnight sweep closed this shift, so its clock-out is a
   * placeholder and its hours are probably wrong.
   *
   * This travels into the pay panel ON PURPOSE (admin lens on PR #1179). The
   * Hours section above already flags these in amber, but THIS is the panel
   * where ticking one locks those hours into a payment record, and dropping
   * the warning here left the loudest place to say it as the one place that
   * did not. Live today: 5 of 27 real shifts are sweep-closed, averaging 14h
   * against a normal day of about 4h 40m. */
  needsReview: boolean;
};

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export function ShiftPayPanel({
  crewMemberId,
  crewName,
  rateCentsPerHour,
  payable,
}: {
  crewMemberId: string;
  crewName: string;
  /** The person's rate. Since 2026-09-03 this is not decoration: it is what
   * the amount is CONVERTED at, so a wrong rate here buys the wrong hours. */
  rateCentsPerHour: number;
  /** Closed shifts with time still owing on them, OLDEST FIRST — the order a
   * payment is spent in. */
  payable: PayableShift[];
}) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<SettlementMethod>('cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typedCents = parseAmountCents(amount);
  const owedSeconds = payable.reduce((sum, s) => sum + s.unpaidSeconds, 0);
  const maxCents = referenceCentsFor(owedSeconds, rateCentsPerHour);

  // The SAME function the server spends the money with, run here only to show
  // what will happen before it happens. The server re-runs it against a fresh
  // read and is the authority; this is a preview, never the decision.
  const preview = useMemo(() => {
    if (typedCents === null || rateCentsPerHour <= 0) return null;
    return allocatePayment(
      payable.map((s) => ({
        shiftId: s.id,
        clockInAt: s.clockInAt,
        totalSeconds: s.paidSeconds,
        unpaidSeconds: s.unpaidSeconds,
      })),
      typedCents,
      rateCentsPerHour,
    );
  }, [payable, typedCents, rateCentsPerHour]);

  const excessCents = excessOverHours(typedCents, maxCents);
  const tooMuch = excessCents > 0;
  const byId = useMemo(() => new Map(payable.map((s) => [s.id, s])), [payable]);
  const touchedUnverified = (preview?.lines ?? []).filter((l) => byId.get(l.shiftId)?.needsReview);
  const rollover = preview ? owedSeconds - preview.secondsCovered : owedSeconds;

  async function submit() {
    if (busy) return;
    if (typedCents === null) {
      setError('Enter the amount actually paid, like 1350.00.');
      return;
    }
    if (rateCentsPerHour <= 0) {
      setError(`${crewName} has no hourly rate set, so there is no way to work out which hours this covers.`);
      return;
    }
    if (!preview || preview.lines.length === 0) {
      setError('That amount covers no time at all.');
      return;
    }

    const lines = [
      `Record a payment to ${crewName}?`,
      '',
      `${dollars(typedCents)} by ${method}, covering ${formatHours(preview.secondsCovered)} of their unpaid time, oldest first.`,
    ];
    // The rollover, said out loud BEFORE the write. It is the whole reason
    // this works the way it does, and an admin should see it as a promise
    // rather than discover it afterwards.
    lines.push(
      '',
      rollover > 0
        ? `${formatHours(rollover)} stays unpaid and carries over to the next payment.`
        : 'Nothing is left unpaid after this.',
    );
    // Paying MORE than the hours come to at base rate is legitimate —
    // overtime, a bonus, back-pay — and the tool has no standing to refuse
    // it. It does have standing to make sure the admin meant it, because a
    // mistyped amount looks exactly the same (Jason, 2026-09-03).
    if (tooMuch) {
      lines.push(
        '',
        `That is ${dollars(excessCents)} MORE than those hours come to at ${dollars(rateCentsPerHour)}/hr. Fine if it is overtime, a bonus or an advance — but check the amount if it is not.`,
      );
    }
    // Named BEFORE the lock, not discovered after it (admin lens on PR #1179).
    if (touchedUnverified.length > 0) {
      lines.push(
        '',
        touchedUnverified.length === 1
          ? 'One shift it lands on was closed by the midnight sweep, so its clock-out is a placeholder rather than a real time. Correct it first if you can.'
          : `${touchedUnverified.length} of the shifts it lands on were closed by the midnight sweep, so their clock-outs are placeholders rather than real times. Correct them first if you can.`,
      );
    }
    lines.push(
      '',
      'Those shifts become locked: their times cannot be corrected until this payment is undone.',
    );
    if (!window.confirm(lines.join('\n'))) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/shift-settlements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewMemberId, amount, method, note: note.trim() || null }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      setBusy(false);
      if (!res.ok) {
        setError(data?.error ?? `Could not record the payment (${res.status}).`);
        // The refusals that mean THE WORLD MOVED refresh the list right here,
        // so the message can say "brought up to date" truthfully and the
        // admin keeps their typed amount (staff lens on PR #1179).
        if (data?.code === 'already-settled' || data?.code === 'lost-race') {
          router.refresh();
        }
        return;
      }
      setAmount('');
      setNote('');
      router.refresh();
    } catch {
      setBusy(false);
      setError('Could not reach the server.');
    }
  }

  if (payable.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        Nothing to pay in this range. Only closed shifts with time still owing appear here.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-gray-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2 bg-gray-50 px-3 py-2">
        <span className="text-sm text-gray-700">
          <span className="font-semibold tabular-nums">{formatHours(owedSeconds)}</span> unpaid
          across {payable.length} {payable.length === 1 ? 'shift' : 'shifts'}
        </span>
        <span className="text-sm tabular-nums text-gray-500">
          worth {dollars(maxCents)} at {dollars(rateCentsPerHour)}/hr
        </span>
      </div>

      <div className="border-b border-gray-200 px-3 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-gray-600">
            Amount actually paid
            <span className="block mt-1">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="180.00"
                className="rounded border border-gray-300 px-2 py-1 text-sm w-32"
              />
            </span>
          </label>
          <label className="text-xs text-gray-600">
            How
            <span className="block mt-1">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as SettlementMethod)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              >
                {SETTLEMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="text-xs text-gray-600 flex-1 min-w-[12rem]">
            Note (optional)
            <span className="block mt-1">
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="anything worth remembering about this payment"
                className="rounded border border-gray-300 px-2 py-1 text-sm w-full"
              />
            </span>
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !preview || preview.lines.length === 0}
            className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--brand-evergreen-3)' }}
          >
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </div>

        {/* A statement, not a refusal. The amount is allowed to exceed what
            the hours come to — that is what an overtime premium or a bonus
            is — but the admin should see the figure before confirming. */}
        {tooMuch && (
          <p className="mt-2 text-xs text-amber-800">
            {dollars(excessCents)} more than those {formatHours(owedSeconds)} come to at{' '}
            {dollars(rateCentsPerHour)}/hr. That is fine for overtime, a bonus or an advance — the
            extra is recorded as paid, and no hours beyond the ones listed are marked off.
          </p>
        )}

        <p className="mt-2 text-xs text-gray-400">
          Type what you actually handed over. The hours it covers are worked out from it at{' '}
          {dollars(rateCentsPerHour)}/hr and marked off oldest first; whatever it does not reach
          stays unpaid and carries over. The tool never decides what to pay.
        </p>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </div>

      {/* What the money will actually land on, before it is recorded. */}
      <ul className="max-h-64 overflow-y-auto divide-y divide-gray-100">
        {payable.map((s) => {
          const line = preview?.lines.find((l) => l.shiftId === s.id);
          const covers = line?.paidSeconds ?? 0;
          const whole = covers >= s.unpaidSeconds && covers > 0;
          return (
            <li
              key={s.id}
              className={`flex flex-wrap items-baseline gap-3 px-3 py-2 text-sm ${covers > 0 ? '' : 'text-gray-400'}`}
            >
              <span className="tabular-nums">{fmtDay(s.clockInAt)}</span>
              {s.needsReview && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                  times not verified
                </span>
              )}
              {covers > 0 && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${whole ? 'bg-green-50 text-green-800' : 'bg-blue-50 text-blue-800'}`}
                >
                  {whole ? 'this pays it off' : `${formatHours(covers)} of it`}
                </span>
              )}
              <span className="ml-auto tabular-nums text-gray-700">
                {formatHours(s.unpaidSeconds)} owing
                {s.unpaidSeconds < s.paidSeconds && (
                  <span className="text-gray-400"> of {formatHours(s.paidSeconds)}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Undo a payment recorded by mistake. The row stays as the record of what
 * was recorded and who undid it, and its shifts become editable again. */
export function VoidSettlementButton({
  settlementId,
  crewName,
  amountLabel,
  shiftCount,
}: {
  settlementId: string;
  crewName: string;
  amountLabel: string;
  shiftCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    // The prompt NAMES the payment: a person can have several, and a generic
    // confirm is no check at all when the risk is undoing the wrong one.
    const reason = window.prompt(
      `Undo this payment to ${crewName}?\n\n${amountLabel}, covering ${shiftCount} ${shiftCount === 1 ? 'shift' : 'shifts'}.\n\nThe record of it stays, marked undone, and those shifts can be corrected and paid again. Say why:`,
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A reason is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/shift-settlements', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settlementId, reason }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setBusy(false);
      if (!res.ok) {
        setError(data?.error ?? `Could not undo the payment (${res.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setBusy(false);
      setError('Could not reach the server.');
    }
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="underline text-red-700 disabled:opacity-50"
      >
        {busy ? 'Undoing…' : 'Undo'}
      </button>
      {error && <span className="text-red-700">{error}</span>}
    </span>
  );
}
