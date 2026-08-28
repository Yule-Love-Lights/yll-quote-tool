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

/** Row 390: the marker rendered next to a due follow-up whose `reChaseSince`
 *  is set — row 385's re-arm of a "quote sent, no reply" nudge after 7 quiet
 *  days on an item staff already marked handled. Before this, a re-chase
 *  rendered identically to a brand-new nudge, so staff had no way to tell
 *  "we never chased this" from "we chased once and they went quiet again" —
 *  which changes what they'd actually say to the customer. Returns null for
 *  an ordinary first-time nudge (reChaseSince null) or an unparseable
 *  timestamp — same "no basis, stay conservative" read as followups.ts's
 *  mayReChaseHandled, so a bad value degrades to "no badge" rather than a
 *  garbled one. Pure and exported, mirroring this file's other exported pure
 *  helpers. */
export function reChaseLabel(reChaseSince: string | null, now: Date): string | null {
  if (!reChaseSince) return null;
  const since = Date.parse(reChaseSince);
  if (!Number.isFinite(since)) return null;
  const quietDays = Math.max(0, Math.floor((now.getTime() - since) / 86_400_000));
  return `Re-chase — quiet ${quietDays}d`;
}

/** Row 391: the notice under a capped list. PURE and exported so the wording is
 *  unit-testable without rendering, and so the "how many are missing" arithmetic
 *  lives in exactly one place. `shown` is the strip's CURRENT list length, which
 *  shrinks as staff clear rows — but `totalDue` was measured at page load, so
 *  the difference is only trustworthy as "at least this many more", never as a
 *  live number. Returns null when nothing is hidden. */
export function hiddenFollowUpNotice(shown: number, totalDue: number): string | null {
  const hidden = totalDue - shown;
  if (hidden <= 0) return null;
  return `Showing the oldest ${shown} — ${hidden} more due and not shown yet.`;
}

export function FollowUpStrip({
  initialItems,
  totalDue,
}: {
  initialItems: DueFollowUp[];
  /** Row 391: the real count of due follow-ups, which can exceed the page cap. */
  totalDue: number;
}) {
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
        {/* Row 391 fix round (staff lens MED): when the page is capped, a bare
            live count reads as the whole job and drifts against the notice
            below as staff clear rows. "N of TOTAL" keeps both honest — the
            first number is what is on screen right now, the second is how many
            are actually due. Uncapped, it stays the single number it was. */}
        Follow-ups due today ({hiddenFollowUpNotice(initialItems.length, totalDue) ? `${items.length} of ${totalDue}` : items.length})
      </h2>
      <ul className="space-y-2">
        {items.map((f) => {
          // Row 390: computed per row, per render — day-granularity, no live
          // ticking needed (unlike InboxList's "waiting Xm" labels), so a
          // plain Date.now() snapshot is enough and keeps this component free
          // of an extra interval/state pair.
          const rechase = reChaseLabel(f.reChaseSince, new Date());
          return (
            <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
              <span style={{ color: 'var(--op-text)' }}>
                <strong>{f.contactName ?? 'Unknown contact'}</strong>
                <span style={{ color: 'var(--op-text-2)' }}> · {REASON_LABEL[f.reason] ?? f.reason}</span>
                {rechase && (
                  <span
                    className="ml-2 px-1.5 py-0.5 rounded text-xs font-medium"
                    style={{ background: 'var(--op-bg)', color: 'var(--op-text-2)', border: '1px solid var(--op-border)' }}
                    title="Staff already replied once; the customer went quiet again after this many days."
                  >
                    {rechase}
                  </span>
                )}
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
          );
        })}
      </ul>
      {/* Row 391: anchored on initialItems.length (the page as SERVED), not the
          live list — clearing rows must not make the "N more" figure climb. */}
      {hiddenFollowUpNotice(initialItems.length, totalDue) && (
        <p className="mt-2 text-xs" style={{ color: 'var(--op-text-2)' }}>
          {hiddenFollowUpNotice(initialItems.length, totalDue)}
        </p>
      )}
    </section>
  );
}
