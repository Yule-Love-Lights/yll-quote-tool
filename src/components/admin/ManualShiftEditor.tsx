'use client';

// Manual payroll entry (2026-08-29, Naldo's ruling): an admin reconstructs a
// forgotten shift by reading the GPS timeline BESIDE this form and typing the
// times. Nothing here reads GPS data — that separation is the point. The
// server refuses overlaps, backwards times, office staffers, stale edits, and
// a clock-out earlier than a running break, each with a plain reason. Every
// save is stamped, logged to the activity trail, and the crew member gets a
// Telegram note when their account is linked.
//
// All times are ET regardless of the device's timezone (etClock), because
// payroll means Eastern time even when an admin is traveling.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs underline text-gray-500"
      >
        Edit
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs">
      <input
        type="datetime-local"
        value={inAt}
        onChange={(e) => setInAt(e.target.value)}
        className="rounded border border-gray-300 px-1 py-0.5"
      />
      <span className="text-gray-400">to</span>
      <input
        type="datetime-local"
        value={outAt}
        onChange={(e) => setOutAt(e.target.value)}
        className="rounded border border-gray-300 px-1 py-0.5"
      />
      {wasOpen && (
        <span className="text-gray-400">(leave the second time empty to keep it open)</span>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="rounded border border-gray-300 px-2 py-0.5 font-medium text-gray-700 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="underline text-gray-500">
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
      <button type="button" onClick={submit} disabled={busy} className="underline text-red-700 disabled:opacity-50">
        {busy ? 'Removing…' : 'Remove'}
      </button>
      {error && <span className="text-red-700">{error}</span>}
    </span>
  );
}
