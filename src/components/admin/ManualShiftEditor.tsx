'use client';

// Manual payroll entry (2026-08-29, Naldo's ruling): an admin reconstructs a
// forgotten shift by reading the GPS timeline BESIDE this form and typing the
// times. Nothing here reads GPS data — that separation is the point. The
// server refuses overlaps, backwards times, an inactive crew member, stale
// edits, and a clock-out earlier than a running break, each with a plain
// reason. (Office staffers were refused here too, until S61: the one-person
// review page now shows office shifts exactly like field ones, so the reason
// to refuse them expired.) Every save is stamped, logged to the activity
// trail, and the crew member gets a Telegram note when their account is
// linked.
//
// All times are ET regardless of the device's timezone (etClock), because
// payroll means Eastern time even when an admin is traveling.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  btnPrimary,
  btnPrimaryStyle,
  btnSecondary,
  btnTextDanger,
  btnTextQuiet,
  inputClass,
  labelClass,
} from '@/components/time/timeUi';
import { etInputToIso, isoToEtInput } from '@/lib/etClock';

type CrewOption = { id: string; displayName: string };

async function postManual(body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch('/api/admin/shifts/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) return { ok: false, message: data?.error ?? `Save failed (${res.status}).` };
    return { ok: true, message: '' };
  } catch {
    return { ok: false, message: 'Could not reach the server.' };
  }
}

/** A duration a human probably did not mean gets one plain question before it
 * becomes payroll (staff lens: a PM/AM slip makes a silent 20-hour shift). */
function confirmSanity(clockInIso: string, clockOutIso: string | null): boolean {
  if (!clockOutIso) return true;
  const hours = (Date.parse(clockOutIso) - Date.parse(clockInIso)) / 3_600_000;
  if (hours > 12) {
    return window.confirm(`That shift is ${hours.toFixed(1)} hours long. Save anyway?`);
  }
  if (hours < 0.25) {
    return window.confirm(
      `That shift is only ${Math.round(hours * 60)} minutes long. Save anyway?`,
    );
  }
  return true;
}

/** The "Add a shift" form under the crew clock, admins only. */
export function AddShiftForm({ crew, defaultDate }: { crew: CrewOption[]; defaultDate: string }) {
  const router = useRouter();
  const [crewMemberId, setCrewMemberId] = useState(crew[0]?.id ?? '');
  const [inAt, setInAt] = useState(`${defaultDate}T07:00`);
  const [outAt, setOutAt] = useState(`${defaultDate}T15:00`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    const clockInAt = etInputToIso(inAt);
    const clockOutAt = etInputToIso(outAt);
    if (!crewMemberId || !clockInAt || !clockOutAt) {
      setError('Pick a crew member and both times.');
      return;
    }
    if (!confirmSanity(clockInAt, clockOutAt)) return;
    setBusy(true);
    setError(null);
    const res = await postManual({ crewMemberId, clockInAt, clockOutAt });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    router.refresh();
  }

  if (crew.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-3 text-sm">
      <p className="font-medium text-gray-900 mb-2">Add a shift (manual entry)</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={crewMemberId}
          onChange={(e) => setCrewMemberId(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1"
        >
          {crew.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={inAt}
          onChange={(e) => setInAt(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1"
        />
        <span className="text-gray-400">to</span>
        <input
          type="datetime-local"
          value={outAt}
          onChange={(e) => setOutAt(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded px-3 py-1 font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--brand-evergreen-3)' }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Times are Eastern. Read the GPS timeline on the right, then type the times. The entry is
        stamped with your name, logged, and the crew member gets a Telegram note when linked.
      </p>
      {error && <p className="text-xs text-red-700 mt-1">{error}</p>}
    </div>
  );
}

/**
 * "Add a shift" on ONE person's own record — /admin/time-tracking/[id]. This
 * is where an office shift gets typed in: this page's crew member is already
 * chosen (it's the person the page is about), so there is no dropdown, and
 * the times come as a date plus two clock faces rather than one combined
 * datetime-local pair, because that is how an admin reading "Ann didn't
 * clock in Monday" actually thinks about the gap — one day, a start, an end.
 * Same confirm-then-POST shape as AddShiftForm above; same route, same
 * refusals.
 *
 * Draws no box of its own: it sits in the Hours card's footer band (S62), so
 * the frame is the card's.
 */
export function AddPersonShiftForm({
  crewMemberId,
  crewName,
  defaultDate,
  visibleFromDay,
}: {
  crewMemberId: string;
  crewName: string;
  defaultDate: string;
  /** Earliest ET day the list above is showing, or null for "All time". Used
   * only to say when a saved shift landed OUTSIDE the range on screen. */
  visibleFromDay: string | null;
}) {
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState('07:00');
  const [endTime, setEndTime] = useState('15:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ day: string; visible: boolean } | null>(null);

  async function submit() {
    if (busy) return;
    if (!date || !startTime || !endTime) {
      setError('Pick a date and both times.');
      return;
    }
    const clockInAt = etInputToIso(`${date}T${startTime}`);
    const clockOutAt = etInputToIso(`${date}T${endTime}`);
    if (!clockInAt || !clockOutAt) {
      setError('Pick a date and both times.');
      return;
    }
    if (!confirmSanity(clockInAt, clockOutAt)) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const res = await postManual({ crewMemberId, clockInAt, clockOutAt });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    // SAY SO. Without this the only signal a save worked is spotting the new
    // row in the list above — and that list is scoped to the range on screen,
    // so backfilling an older day showed nothing anywhere and invited a
    // well-meaning retry with slightly different times: a duplicate shift on
    // somebody's payroll. Both halves found by the S61 staff lens.
    setSaved({ day: date, visible: visibleFromDay === null || date >= visibleFromDay });
    router.refresh();
  }

  return (
    <div className="text-sm">
      <p className="mb-2 font-semibold text-gray-900">Add a shift for {crewName}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          Date
          <span className="mt-1 block">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputClass}
            />
          </span>
        </label>
        <label className={labelClass}>
          Start
          <span className="mt-1 block">
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={inputClass}
            />
          </span>
        </label>
        <label className={labelClass}>
          End
          <span className="mt-1 block">
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className={inputClass}
            />
          </span>
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className={btnPrimary}
          style={btnPrimaryStyle}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Times are Eastern. Use this for a day nobody clocked in at all — a shift that started but
        was never corrected has its own Edit control on the row above. The entry is stamped with
        your name, logged, and {crewName} gets a Telegram note when linked.
      </p>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      {saved && (
        <p className="mt-1 text-xs text-green-800">
          Saved {fmtDay(saved.day)}.{' '}
          {saved.visible
            ? 'It is in the list above.'
            : 'It is OUTSIDE the range shown above — switch to All time to see it.'}
        </p>
      )}
    </div>
  );
}

/** `2026-08-24` the way a person reads it. The string is already an ET
 * calendar day, so it is split rather than parsed: building a Date from it and
 * formatting that back is free to move it a day. */
function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

/** Inline time editor on one shift row, admins only. An OPEN shift can have
 * its clock-in corrected while STAYING open — closing someone's running shift
 * from the office would flip their bot to "not clocked in" mid-workday. */
export function EditShiftTimes({
  shiftId,
  clockInAt,
  clockOutAt,
}: {
  shiftId: string;
  clockInAt: string;
  clockOutAt: string | null;
}) {
  const router = useRouter();
  const wasOpen = clockOutAt === null;
  const [open, setOpen] = useState(false);
  const [inAt, setInAt] = useState(isoToEtInput(clockInAt));
  const [outAt, setOutAt] = useState(clockOutAt ? isoToEtInput(clockOutAt) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    const nextIn = etInputToIso(inAt);
    if (!nextIn) {
      setError('The clock-in time is required.');
      return;
    }
    let nextOut: string | null = null;
    if (outAt) {
      nextOut = etInputToIso(outAt);
      if (!nextOut) {
        setError('The clock-out time is not a valid time.');
        return;
      }
    } else if (!wasOpen) {
      setError('A closed shift needs a clock-out time.');
      return;
    }
    if (!confirmSanity(nextIn, nextOut)) return;
    setBusy(true);
    setError(null);
    const res = await postManual({ shiftId, clockInAt: nextIn, clockOutAt: nextOut });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={btnSecondary}>
        Edit
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      <input
        type="datetime-local"
        value={inAt}
        onChange={(e) => setInAt(e.target.value)}
        className={`${inputClass} px-1.5 py-0.5 text-xs`}
      />
      <span className="text-gray-400">to</span>
      <input
        type="datetime-local"
        value={outAt}
        onChange={(e) => setOutAt(e.target.value)}
        className={`${inputClass} px-1.5 py-0.5 text-xs`}
      />
      {wasOpen && (
        <span className="text-gray-400">(leave the second time empty to keep it open)</span>
      )}
      <button type="button" onClick={submit} disabled={busy} className={btnSecondary}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className={btnTextQuiet}>
        cancel
      </button>
      {error && <span className="text-red-700">{error}</span>}
    </span>
  );
}

/** A shift time as an admin reads it: Eastern, because payroll is Eastern. */
function etStamp(iso: string | null): string {
  if (!iso) return 'still open';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Remove a manual entry that should never have existed (row 458). Only shown
 * on rows the office typed itself, mirroring the server guard; the server
 * refuses everything else, including any shift carrying a break or job time.
 *
 * The confirm says what actually happens: the row leaves payroll, and the
 * activity log keeps the record of what was removed and who removed it.
 */
export function VoidShiftButton({
  shiftId,
  crewName,
  clockInAt,
  clockOutAt,
}: {
  shiftId: string;
  crewName: string;
  clockInAt: string;
  clockOutAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    // The confirm NAMES the shift. A day with several manual entries gives an
    // admin several identical Remove links, and a generic prompt is no check
    // at all when the risk is removing the wrong person's pay (S78 wrap,
    // staff lens).
    const ok = window.confirm(
      `Remove this shift from payroll?

${crewName}: ${etStamp(clockInAt)} to ${etStamp(clockOutAt)}

The activity log keeps a record of what was removed, but the shift itself is gone. Use this only for an entry that should never have existed.`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/shifts/manual', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shiftId }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setBusy(false);
      if (!res.ok) {
        setError(data?.error ?? `Could not remove the shift (${res.status}).`);
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
      <button type="button" onClick={submit} disabled={busy} className={btnTextDanger}>
        {busy ? 'Removing…' : 'Remove'}
      </button>
      {error && <span className="text-red-700">{error}</span>}
    </span>
  );
}
