'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type RebookState = 'idle' | 'loading' | 'no-source' | 'error';

/**
 * "Rebook last season" button (rebook Part D).
 *
 * POSTs to /api/customers/[customerId]/rebook and navigates to the new draft
 * quote on success. On a 404/no-source response shows a brief inline message.
 * The page is a server component so this is a small client island.
 */
export function RebookButton({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [state, setState] = useState<RebookState>('idle');

  async function handleClick() {
    setState('loading');
    try {
      const res = await fetch(`/api/customers/${customerId}/rebook`, { method: 'POST' });
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
        Rebook failed — try again
      </span>
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
