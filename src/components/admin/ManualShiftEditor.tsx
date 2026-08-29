'use client';

// Manual payroll entry (2026-08-29, Naldo's ruling): an admin reconstructs a
// forgotten shift by reading the GPS timeline BESIDE this form and typing the
// times. Nothing here reads GPS data — that separation is the point, and the
// server refuses overlaps, backwards times, and stale edits with plain
// reasons. Every save is stamped with who did it.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type CrewOption = { id: string; displayName: string };

/** ISO → the datetime-local input format, in the admin's local time (ET). */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIsoOrNull(local: string): string | null {
  if (!local) return null;
  const ms = Date.parse(local);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

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
    const clockInAt = toIsoOrNull(inAt);
    const clockOutAt = toIsoOrNull(outAt);
    if (!crewMemberId || !clockInAt || !clockOutAt) {
      setError('Pick a crew member and both times.');
      return;
    }
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
        Read the GPS timeline on the right, then type the times. The entry is stamped with your
        name.
      </p>
      {error && <p className="text-xs text-red-700 mt-1">{error}</p>}
    </div>
  );
}

/** Inline time editor on one shift row, admins only. */
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
  const [open, setOpen] = useState(false);
  const [inAt, setInAt] = useState(toLocalInput(clockInAt));
  const [outAt, setOutAt] = useState(toLocalInput(clockOutAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    const nextIn = toIsoOrNull(inAt);
    const nextOut = toIsoOrNull(outAt);
    if (!nextIn || !nextOut) {
      setError('Both times are required (a manual correction always closes the shift).');
      return;
    }
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
