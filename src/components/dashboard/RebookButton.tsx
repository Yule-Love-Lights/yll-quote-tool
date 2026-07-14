'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type RebookState = 'idle' | 'picking' | 'loading' | 'no-source' | 'error';

export type RebookProperty = { id: string; address: string | null };

// PURE: decides what a click on "Rebook last season" should do, given the
// customer's properties (WT-53). A customer with 0 or 1 property has an
// unambiguous source building, so the click posts straight away, scoped to
// that one property when it exists. A customer with 2+ properties has no
// unambiguous source, so the click must open a picker instead of posting a
// system-wide "most recently approved" guess that could clone the wrong
// building. Exported + unit-tested directly (mirrors buildRebookInsert in
// src/lib/rebook.ts).
export function decideRebookClick(
  properties: RebookProperty[],
): { kind: 'post'; propertyId?: string } | { kind: 'pick' } {
  if (properties.length > 1) return { kind: 'pick' };
  return { kind: 'post', propertyId: properties[0]?.id };
}

/**
 * "Rebook last season" button (rebook Part D).
 *
 * POSTs to /api/customers/[customerId]/rebook and navigates to the new draft
 * quote on success. On a 404/no-source response shows a brief inline message.
 * The page is a server component so this is a small client island.
 *
 * Property-aware (WT-53): `properties` is server-computed by the page (via
 * getPropertiesForCustomer) and passed in as a prop. A customer with more
 * than one property must pick WHICH building to rebook before the POST
 * fires, otherwise the backend falls back to the most-recently-approved
 * quote system-wide, which can start a season's draft for the wrong address.
 */
export function RebookButton({
  customerId,
  properties,
}: {
  customerId: string;
  properties: RebookProperty[];
}) {
  const router = useRouter();
  const [state, setState] = useState<RebookState>('idle');
  const [selectedPropertyId, setSelectedPropertyId] = useState('');

  async function doRebook(propertyId?: string) {
    setState('loading');
    try {
      const res = await fetch(`/api/customers/${customerId}/rebook`, {
        method: 'POST',
        headers: propertyId ? { 'Content-Type': 'application/json' } : undefined,
        body: propertyId ? JSON.stringify({ propertyId }) : undefined,
      });
      if (res.ok) {
        const json = (await res.json()) as { quoteId: string };
        router.push(`/quote/${json.quoteId}`);
        return;
      }
      const json = (await res.json()) as { code?: string };
      if (json.code === 'no-source') {
        setState('no-source');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  }

  function handleClick() {
    const decision = decideRebookClick(properties);
    if (decision.kind === 'pick') {
      setState('picking');
      return;
    }
    void doRebook(decision.propertyId);
  }

  if (state === 'no-source') {
    return (
      <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
        No approved quote to rebook
      </span>
    );
  }

  if (state === 'error') {
    return (
      <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
        Rebook failed, try again
      </span>
    );
  }

  if (state === 'picking') {
    return (
      <div className="inline-flex items-center gap-1.5">
        <select
          value={selectedPropertyId}
          onChange={(e) => setSelectedPropertyId(e.target.value)}
          className="text-xs rounded-md px-2 py-1.5"
          style={{ background: 'var(--op-bg-raised)', border: '1px solid var(--op-border)', color: 'var(--op-text)' }}
        >
          <option value="">Choose a property…</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.address ?? p.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            if (selectedPropertyId) void doRebook(selectedPropertyId);
          }}
          disabled={!selectedPropertyId}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs disabled:opacity-50"
          style={{ background: 'var(--op-bg-raised)', border: '1px solid var(--op-border)', color: 'var(--op-text)' }}
        >
          Rebook
        </button>
        <button
          onClick={() => {
            setState('idle');
            setSelectedPropertyId('');
          }}
          className="text-xs hover:underline"
          style={{ color: 'var(--op-text-dim)' }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading'}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs disabled:opacity-50"
      style={{ background: 'var(--op-bg-raised)', border: '1px solid var(--op-border)', color: 'var(--op-text)' }}
    >
      {state === 'loading' ? 'Rebooking…' : 'Rebook last season'}
    </button>
  );
}
