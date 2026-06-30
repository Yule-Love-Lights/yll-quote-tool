'use client';

import { useCallback, useState } from 'react';
import type { DueFollowUp } from '@/lib/dashboard/inbox/types';

const REASON_LABEL: Record<string, string> = {
  quote_sent_no_reply: 'Quote sent — no reply',
};

export function FollowUpStrip({ initialItems }: { initialItems: DueFollowUp[] }) {
  const [items, setItems] = useState<DueFollowUp[]>(initialItems);
  const [busyId, setBusyId] = useState<string | null>(null);

  const markDone = useCallback(async (id: string) => {
    setBusyId(id);
    setItems((prev) => prev.filter((i) => i.id !== id)); // optimistic
    try {
      await fetch('/api/dashboard/followup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {
      // Next page load re-syncs the true state if the write failed.
    } finally {
      setBusyId(null);
    }
  }, []);

  if (items.length === 0) return null;

  return (
    <section
      className="mb-5 rounded-lg border p-4"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <h2 className="text-sm font-semibold mb-2" style={{ color: 'var(--op-text)' }}>
        Follow-ups due today ({items.length})
      </h2>
      <ul className="space-y-2">
        {items.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
            <span style={{ color: 'var(--op-text)' }}>
              <strong>{f.contactName ?? 'Unknown contact'}</strong>
              <span style={{ color: 'var(--op-text-2)' }}> · {REASON_LABEL[f.reason] ?? f.reason}</span>
            </span>
            <button
              type="button"
              disabled={busyId === f.id}
              onClick={() => markDone(f.id)}
              className="px-3 py-1 rounded-md text-sm disabled:opacity-50"
              style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
            >
              Done
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
