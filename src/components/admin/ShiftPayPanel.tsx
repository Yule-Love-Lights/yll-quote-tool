'use client';

// Recording a payment against someone's shifts — time-tracking plan phase 3,
// ledger row 459. ADMIN ONLY; the page and the route both gate it.
//
// THE TOOL DOES NOT CALCULATE PAY. The reference figure beside the selection
// is what the selected hours come to at this person's current rate, and it is
// there to be sanity-checked, not accepted: overtime has no ruling here
// (ledger row 285), so for a long week the true figure is HIGHER than the
// reference. The amount box starts EMPTY for exactly that reason — pre-filling
// it with the reference would make the tool's guess the default answer, and a
// week over forty hours would then be underpaid by one click.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { formatHours } from '@/lib/hoursSummary';
import {
  dollars,
  parseAmountCents,
  referenceCentsFor,
  SETTLEMENT_METHODS,
  type SettlementMethod,
} from '@/lib/shiftSettlements';

export type PayableShift = {
  id: string;
  clockInAt: string;
  paidSeconds: number;
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
  /** The person's CURRENT rate, for the reference figure only. */
  rateCentsPerHour: number;
  /** Closed, unpaid shifts in the range on screen, newest first. */
  payable: PayableShift[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<SettlementMethod>('cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(() => payable.filter((s) => selected.has(s.id)), [payable, selected]);
  const chosenSeconds = chosen.reduce((sum, s) => sum + s.paidSeconds, 0);
  const referenceCents = referenceCentsFor(chosenSeconds, rateCentsPerHour);
  const typedCents = parseAmountCents(amount);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === payable.length ? new Set() : new Set(payable.map((s) => s.id))));
  }

  async function submit() {
    if (busy) return;
    if (chosen.length === 0) {
      setError('Pick the shifts this payment covers.');
      return;
    }
    if (typedCents === null) {
      setError('Enter the amount actually paid, like 1350.00.');
      return;
    }
    // One plain question when the typed amount is a long way from the hours on
    // the table. NOT a refusal — overtime, an advance and a deduction are all
    // legitimate reasons to differ, and the tool has no standing to say which.
    if (referenceCents > 0) {
      const ratio = typedCents / referenceCents;
      if (ratio < 0.5 || ratio > 2) {
        const ok = window.confirm(
          `You are recording ${dollars(typedCents)} for ${formatHours(chosenSeconds)}, which is ${dollars(referenceCents)} at ${dollars(rateCentsPerHour)}/hr. Record it anyway?`,
        );
        if (!ok) return;
      }
    }
    const ok = window.confirm(
      `Record a payment to ${crewName}?\n\n${dollars(typedCents)} by ${method}, covering ${chosen.length} ${chosen.length === 1 ? 'shift' : 'shifts'} (${formatHours(chosenSeconds)}).\n\nThose shifts become locked: their times cannot be corrected until this payment is undone.`,
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/shift-settlements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          crewMemberId,
          shiftIds: chosen.map((s) => s.id),
          amount,
          method,
          note: note.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setBusy(false);
      if (!res.ok) {
        setError(data?.error ?? `Could not record the payment (${res.status}).`);
        return;
      }
      setSelected(new Set());
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
        Nothing to pay in this range. Only closed shifts that have not been paid appear here.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-gray-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2 bg-gray-50 px-3 py-2">
        <button type="button" onClick={toggleAll} className="text-xs underline text-gray-600">
          {selected.size === payable.length ? 'Clear all' : `Select all ${payable.length}`}
        </button>
        <span className="text-sm tabular-nums text-gray-700">
          {chosen.length} selected · {formatHours(chosenSeconds)}
          {referenceCents > 0 && (
            <span className="text-gray-500">
              {' '}
              · {dollars(referenceCents)} at {dollars(rateCentsPerHour)}/hr
            </span>
          )}
        </span>
      </div>

      <ul className="max-h-64 overflow-y-auto divide-y divide-gray-100">
        {payable.map((s) => (
          <li key={s.id}>
            <label className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
                className="h-4 w-4"
              />
              <span className="tabular-nums">{fmtDay(s.clockInAt)}</span>
              <span className="ml-auto tabular-nums text-gray-700">{formatHours(s.paidSeconds)}</span>
            </label>
          </li>
        ))}
      </ul>

      <div className="border-t border-gray-200 px-3 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-gray-600">
            Amount actually paid
            <span className="block mt-1">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1350.00"
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
            disabled={busy}
            className="rounded px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--brand-evergreen-3)' }}
          >
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          The amount is what you actually handed over — the tool does not work it out. The figure
          beside the selection is those hours at {dollars(rateCentsPerHour)}/hr, for a sanity check
          only; it takes no account of overtime.
        </p>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </div>
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
