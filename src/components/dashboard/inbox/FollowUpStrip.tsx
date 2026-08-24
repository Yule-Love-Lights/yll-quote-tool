'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DueFollowUp } from '@/lib/dashboard/inbox/types';

const REASON_LABEL: Record<string, string> = {
  quote_sent_no_reply: 'Quote sent — no reply',
};

// Row 305 (WRAP TECHNICAL LENS widening): a local copy of InboxList.tsx's own
// withRowFlagSet/withRowFlagCleared (kept deliberately un-shared, matching
// this directory's other per-file copies). Fixes this file's single-slot
// `busyId`: marking follow-up A done (in flight), then clicking Done on B
// before A settles, re-enabled A's button mid-flight (the slot now held B's
// id). Since row 323, markFollowUpDone (store.ts) also carries a server-side
// `.eq('status','pending')` CAS, so this per-row lock is defense-in-depth
// rather than the only protection. Per-row record, same shape as row 291's fix.
export function withRowFlagSet(map: Record<string, boolean>, id: string): Record<string, boolean> {
  return { ...map, [id]: true };
}

export function withRowFlagCleared(map: Record<string, boolean>, id: string): Record<string, boolean> {
  if (!map[id]) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** Row 309: this component is seeded ONCE server-side (initialItems) with no
 *  poll of its own. Two different guarantees are at play here, and they are
 *  NOT the same strength:
 *
 *  (a) A row the OPERATOR retires — clicking Done on it in this component —
 *  vanishes immediately. That's the optimistic removal in markDone below; it
 *  doesn't wait on anything.
 *
 *  (b) A row retired by something ELSE (a follow-up auto-closed by #798's
 *  cron sweep or #838's terminal-quote auto-complete, an item moved buckets)
 *  or a row that became newly due since mount is picked up ONLY when
 *  something else on the page actually triggers a server re-render — there
 *  is no live guarantee here. InboxList.tsx/InWorksSection.tsx's act() call
 *  router.refresh() after a dismiss/complete that retires a follow-up (see
 *  each file's own retiresFollowUp), which re-renders InboxPage's server
 *  component and hands this component a FRESH initialItems array — but
 *  useState's initializer only runs on mount, so reacting to that fresh prop
 *  needs an explicit effect (below). Absent one of those triggers, this
 *  strip is simply stale until the operator's next navigation (a fresh page
 *  load re-seeds initialItems) — that's row 309's own accepted scope, which
 *  explicitly rejected adding a poll here.
 *
 *  A bare "resync items to initialItems on every change" would NOT be safe
 *  on its own: a refresh fired by an UNRELATED action elsewhere in the inbox
 *  can land while THIS component's own markDone is still mid-flight for a
 *  DIFFERENT row, and the server's follow_ups row for that in-flight write
 *  may not have committed yet — the fresh list can still legitimately
 *  include it, and resurrecting it would contradict the optimistic removal
 *  markDone already did. Filtering the fresh list against the ids THIS
 *  component currently has busy keeps such a refresh safe (a genuinely
 *  retired or newly-due row is reflected; a row this component is actively
 *  submitting is not resurrected). Once that write actually settles
 *  (success or failure), busyIds clears and this component's own state is
 *  already consistent with the fresh truth either way. Pure and exported so
 *  this is directly unit-testable without rendering. */
export function reconcileDueFollowUps(
  freshItems: DueFollowUp[],
  busyIds: Record<string, boolean>,
): DueFollowUp[] {
  return freshItems.filter((f) => !busyIds[f.id]);
}

export function FollowUpStrip({ initialItems }: { initialItems: DueFollowUp[] }) {
  const [items, setItems] = useState<DueFollowUp[]>(initialItems);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  // Mirrors busyIds for the reconcile effect below, which must fire ONLY when
  // initialItems itself changes (a real server refresh) — not on every
  // busyIds change, or a row's own in-flight markDone completing would
  // re-derive `items` from the stale mount-time initialItems the instant its
  // busy flag clears, undoing its own optimistic removal. Sync runs as a
  // LAYOUT effect (not a passive one) specifically so the reconcile effect
  // below always reads a fresh value regardless of the two effects'
  // declaration order: React always finishes every layout effect in a
  // commit before starting any passive effect in that same commit, so this
  // ordering guarantee holds independent of which is declared first — unlike
  // two useEffects, where declaration order is what decided firing order.
  // (Assigning ref.current directly in the render body — the usual
  // always-fresh-ref shortcut — is banned in this repo: eslint-plugin-
  // react-hooks 7's `refs` rule hard-errors on "Cannot access refs during
  // render" for exactly that pattern; verified via `npm run lint`.)
  const busyIdsRef = useRef(busyIds);
  useLayoutEffect(() => {
    busyIdsRef.current = busyIds;
  }, [busyIds]);

  useEffect(() => {
    setItems(reconcileDueFollowUps(initialItems, busyIdsRef.current));
  }, [initialItems]);

  const router = useRouter();

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
      // Row 365: the route ALSO resolves this follow-up's anchored inbox item
      // server-side (#252 slice E), but nothing told the page — the item sat
      // visibly open in the main list until the next 25s poll. Same idiom as
      // InboxList/InWorksSection: re-render InboxPage's server component so
      // every list on the page reflects the resolution now. Only on success;
      // the restore path above has nothing to re-read.
      else router.refresh();
    } catch {
      setItems((prev) => [item, ...prev]);
    } finally {
      setBusyIds((prev) => withRowFlagCleared(prev, item.id));
    }
  }, [router]);

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
