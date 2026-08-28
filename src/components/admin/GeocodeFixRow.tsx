'use client';

// One row of the geocode fix-list: edit the address, save, and learn
// immediately whether the correction actually verified. The distinction
// matters — a save that "worked" but still refused would otherwise look
// fixed while the job stays unschedulable.

import { useState } from 'react';

type Props = {
  propertyId: string;
  customerId: string;
  customerName: string;
  nickname: string | null;
  address: string;
};

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'verified' }
  | { kind: 'still_refused' }
  | { kind: 'archiving' }
  | { kind: 'archived' }
  | { kind: 'error'; message: string };

export function GeocodeFixRow({ propertyId, customerId, customerName, nickname, address }: Props) {
  const [value, setValue] = useState(address);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  async function save() {
    if (!value.trim() || state.kind === 'saving') return;
    setState({ kind: 'saving' });
    try {
      // POST, not PATCH: the property route's single mutating handler is POST
      // (S68 lens round — the first draft used PATCH and every save 405'd, a
      // verb mismatch nothing type-checks).
      const res = await fetch(`/api/customers/${customerId}/properties/${propertyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: value.trim() }),
      });
      const body = (await res.json().catch(() => null)) as
        | { property?: { lat?: number | null }; lat?: number | null; error?: string }
        | null;
      if (!res.ok) {
        setState({ kind: 'error', message: body?.error ?? `Save failed (${res.status}).` });
        return;
      }
      // The route returns the updated row; a null lat means Google still could
      // not verify the corrected address to a specific house.
      const lat = body?.property?.lat ?? body?.lat ?? null;
      setState(lat != null ? { kind: 'verified' } : { kind: 'still_refused' });
    } catch {
      setState({ kind: 'error', message: 'Could not reach the server.' });
    }
  }

  // Archive (never a hard delete): the property drops off this list and every
  // picker; the customer row stays. For the test/garbage entries the import
  // left behind (Naldo, 2026-08-28). The route refuses if a job references
  // this property, so a real job's address cannot be hidden by mistake.
  async function archive() {
    if (state.kind === 'saving' || state.kind === 'archiving') return;
    if (!window.confirm(`Remove "${customerName}" from this list? Nothing is deleted; the address is archived.`)) {
      return;
    }
    setState({ kind: 'archiving' });
    try {
      const res = await fetch(`/api/customers/${customerId}/properties/${propertyId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setState({ kind: 'error', message: body?.error ?? `Archive failed (${res.status}).` });
        return;
      }
      setState({ kind: 'archived' });
    } catch {
      setState({ kind: 'error', message: 'Could not reach the server.' });
    }
  }

  if (state.kind === 'archived') {
    return (
      <li className="rounded-lg border border-gray-200 p-4 text-sm text-gray-400">
        {customerName} — archived. It will not appear here again.
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-gray-200 p-4">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <p className="text-sm font-medium text-gray-900">
          {customerName}
          {nickname ? <span className="text-gray-500 font-normal"> · {nickname}</span> : null}
        </p>
        {state.kind === 'verified' && (
          <span className="text-xs font-semibold" style={{ color: 'var(--brand-evergreen-3)' }}>
            Verified — this job can be scheduled now
          </span>
        )}
        {state.kind === 'still_refused' && (
          <span className="text-xs font-semibold text-amber-700">
            Saved, but still not a specific house — check the street number and town
          </span>
        )}
        {state.kind === 'error' && (
          <span className="text-xs font-semibold text-red-700">{state.message}</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (state.kind !== 'idle' && state.kind !== 'saving') setState({ kind: 'idle' });
          }}
          placeholder="Street number, street, town, NY, ZIP"
        />
        <button
          type="button"
          onClick={save}
          disabled={state.kind === 'saving' || state.kind === 'archiving' || !value.trim()}
          className="rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--brand-evergreen-3)' }}
        >
          {state.kind === 'saving' ? 'Checking…' : 'Save and re-check'}
        </button>
        <button
          type="button"
          onClick={archive}
          disabled={state.kind === 'saving' || state.kind === 'archiving'}
          className="rounded px-3 py-2 text-sm font-medium border border-gray-300 text-gray-600 disabled:opacity-50"
          title="Remove this test or garbage entry from the list. Nothing is deleted."
        >
          {state.kind === 'archiving' ? 'Archiving…' : 'Archive'}
        </button>
      </div>
    </li>
  );
}
