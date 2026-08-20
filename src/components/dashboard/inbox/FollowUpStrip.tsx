'use client';

import { useCallback, useState } from 'react';
import type { DueFollowUp } from '@/lib/dashboard/inbox/types';

const REASON_LABEL: Record<string, string> = {
  quote_sent_no_reply: 'Quote sent — no reply',
};

// Row 305 (WRAP TECHNICAL LENS widening): a local copy of InboxList.tsx's own
// withRowFlagSet/withRowFlagCleared (kept deliberately un-shared, matching
// this directory's other per-file copies). Fixes this file's single-slot
// `busyId`: marking follow-up A done (in flight), then clicking Done on B
// before A settles, re-enabled A's button mid-flight (the slot now held B's
// id) — markFollowUpDone (store.ts) has no server-side guard, so a second
// concurrent POST for A was one more click away (worst case: a duplicate
// activity row). Per-row record, same shape as row 291's fix.
export function withRowFlagSet(map: Record<string, boolean>, id: string): Record<string, boolean> {
  return { ...map, [id]: true };
}

export function withRowFlagCleared(map: Record<string, boolean>, id: string): Record<string, boolean> {
  if (!map[id]) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

export function FollowUpStrip({ initialItems }: { initialItems: DueFollowUp[] }) {
  const [items, setItems] = useState<DueFollowUp[]>(initialItems);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});

  const markDone = useCallback(async (item: DueFollowUp) => {
    setBusyIds((prev) => withRowFlagSet(prev, item.id));
    setItems((prev) => prev.filter((i) => i.id !== item.id)); // optimistic
    try {
      const res = await fetch('/api/dashboard/followup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      // Restore the item if the write was rejected, so a failure is visible
      // rather than silently vanishing (mirrors DuplicatesList's merge()).
      if (!res.ok) setItems((prev) => [item, ...prev]);
    } catch {
      setItems((prev) => [item, ...prev]);
    } finally {
      setBusyIds((prev) => withRowFlagCleared(prev, item.id));
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
              disabled={!!busyIds[f.id]}
              onClick={() => markDone(f)}
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
