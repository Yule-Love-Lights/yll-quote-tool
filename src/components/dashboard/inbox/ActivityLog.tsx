'use client';

import { useState } from 'react';
import type { ActivityRow } from '@/lib/dashboard/inbox/store';

const ACTION_LABEL: Record<string, string> = {
  handled: 'Handled',
  followed: 'Followed up',
  completed: 'Completed',
  dismissed: 'Not a lead',
  reopened: 'Reopened',
  reversed: 'Reversed',
  ingested: 'New message',
  // #230(a): a #220 internal-domain follow-up suppression — see
  // recordSuppressedFollowUp's doc (store.ts).
  followup_suppressed: 'Follow-up suppressed (internal)',
  // #252: a pending nag retired because its item reached completed/dismissed —
  // see recordAutoClosedFollowUps' doc (store.ts). Unlabelled actions already
  // fall through to the raw string below; this just reads properly on the page.
  followup_autoclosed: 'Follow-up closed (conversation resolved)',
  // Row 311 fix-round FIX 2: before this, an 'action_failed' row (row 308)
  // rendered as the raw literal string 'action_failed' — no verb, no detail.
  action_failed: 'Action failed',
};

function friendlyAction(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

function friendlyActor(actor: string | null, actorName: string | null): string {
  if (actorName) return actorName;
  if (!actor || actor === 'system') return 'System';
  return actor;
}

export function ActivityLog({ initialRows }: { initialRows: ActivityRow[] }) {
  const [rows, setRows] = useState<ActivityRow[]>(initialRows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [reversedIds, setReversedIds] = useState<Set<string>>(new Set());

  async function handleReverse(activityId: string) {
    setBusyId(activityId);
    setErrorById((prev) => {
      const next = { ...prev };
      delete next[activityId];
      return next;
    });
    try {
      const res = await fetch('/api/dashboard/activity/reverse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activityId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        // Optimistic: mark reversed — strike the button, show tag, disable
        setReversedIds((prev) => new Set(prev).add(activityId));
        // Also push a synthetic 'reversed' row to the top so the log reflects it
        const original = rows.find((r) => r.id === activityId);
        if (original) {
          const syntheticRow: ActivityRow = {
            id: `rev-${activityId}`,
            action: 'reversed',
            actor: null,
            actorName: null,
            itemId: original.itemId,
            customerName: original.customerName,
            at: new Date().toISOString(),
            reversible: false,
          };
          setRows((prev) => [syntheticRow, ...prev]);
        }
      } else {
        setErrorById((prev) => ({ ...prev, [activityId]: data.error ?? 'Failed to reverse.' }));
      }
    } catch {
      setErrorById((prev) => ({ ...prev, [activityId]: 'Network error — try again.' }));
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm py-6" style={{ color: 'var(--op-text-2)' }}>
        No activity recorded yet.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const isReversed = reversedIds.has(row.id);
        const isBusy = busyId === row.id;
        const rowError = errorById[row.id];
        const when = row.at ? new Date(row.at).toLocaleString() : '—';

        return (
          <li
            key={row.id}
            className="rounded-lg border p-4"
            style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm" style={{ color: 'var(--op-text)' }}>
                    {friendlyAction(row.action)}
                  </span>
                  {row.customerName && (
                    <span className="text-sm" style={{ color: 'var(--op-text)' }}>
                      — {row.customerName}
                    </span>
                  )}
                </div>
                <p className="text-xs" style={{ color: 'var(--op-text-2)' }}>
                  {when} · {friendlyActor(row.actor, row.actorName)}
                </p>
                {/* Row 311 fix-round FIX 2: the row's own failure detail — which
                    action failed and why (a guard refusal reads as one, e.g.
                    "Item is completed or dismissed…"; a real DB error reads as
                    the other) — the two error strings already differ, so no
                    separate classifier is needed to tell them apart at a glance. */}
                {row.action === 'action_failed' && row.detail && (
                  <p className="text-xs mt-1" style={{ color: '#dc2626' }}>
                    {friendlyAction(row.detail.action ?? '')} failed: {row.detail.error ?? 'unknown error'}
                  </p>
                )}
                {rowError && (
                  <p className="text-xs mt-1" style={{ color: '#dc2626' }}>
                    {rowError}
                  </p>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {isReversed && (
                  <span
                    className="text-xs px-2 py-0.5 rounded"
                    style={{ background: 'var(--op-border)', color: 'var(--op-text-2)' }}
                  >
                    reversed
                  </span>
                )}
                {row.reversible && !isReversed && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleReverse(row.id)}
                    className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
                    style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
                  >
                    {isBusy ? 'Reversing…' : 'Reverse'}
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
