'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GmailWritebackFailure } from '@/lib/dashboard/inbox/store';

// Row 342 fix round (staff lens BLOCK, 2 HIGH): round 1 shipped a bare count
// with no drill-down (which customers?) and no exit (nothing ever re-ran a
// failed write-back, so the banner would stay red forever even after the
// token was fixed). This version lists the actual affected items and gives
// each a Retry button that re-runs the same runHandledWriteback the original
// Handled action calls — see getGmailWritebackRetryTarget's doc comment
// (store.ts) for why replaying it is safe (every write-back step is
// independently idempotent).
//
// Not unit-tested end-to-end, same reason as InboxList.tsx's act() (see its
// own header comment): this file's test only exercises renderToStaticMarkup
// (no jsdom, no click simulation), which covers the static render — labels,
// error text, the truncation note — not the click-then-refetch flow.
export function GmailWritebackFailuresBanner({
  items,
  total,
  truncated,
}: {
  items: GmailWritebackFailure[];
  total: number;
  truncated: boolean;
}) {
  const router = useRouter();
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [retryFailedIds, setRetryFailedIds] = useState<Record<string, boolean>>({});
  // Fix round MED 1: at least one item on THIS page whose write-back never
  // even attempted (Gmail had no credentials at all) gets a distinct leading
  // sentence — a total outage reads differently from a handful of per-item
  // errors, and conflating them would bury the worse case in the milder one.
  const anyUnconfigured = items.some((i) => i.status === 'unconfigured');

  async function retry(id: string) {
    setBusyIds((prev) => ({ ...prev, [id]: true }));
    setRetryFailedIds((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch('/api/dashboard/handled/retry-gmail-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: id }),
      });
      const data = (await res.json().catch(() => ({}))) as { sync?: { gmailLabel?: string } };
      if (!res.ok || data.sync?.gmailLabel !== 'ok') {
        setRetryFailedIds((prev) => ({ ...prev, [id]: true }));
        return;
      }
      // Success: re-fetch the server component so this row drops off the list.
      router.refresh();
    } catch {
      setRetryFailedIds((prev) => ({ ...prev, [id]: true }));
    } finally {
      setBusyIds((prev) => ({ ...prev, [id]: false }));
    }
  }

  return (
    <div className="rounded-md border p-3 text-sm mb-4" style={{ borderColor: '#dc2626' }}>
      {anyUnconfigured ? (
        <p className="font-medium mb-2" style={{ color: '#dc2626' }}>
          Gmail isn&apos;t connected right now — {total} Handled item{total === 1 ? '' : 's'} couldn&apos;t
          sync to Gmail AT ALL (no valid token), not a one-off error. Each was still marked Handled here, so
          nothing was lost — just not reflected in the real mailbox. This needs a developer to fix the Gmail
          connection — tell Jason or Naldo. Once it&apos;s fixed, Retry below clears each item.
        </p>
      ) : (
        <p className="font-medium mb-2" style={{ color: '#dc2626' }}>
          Gmail write-back failing — {total} Handled item{total === 1 ? '' : 's'} never got the YLL/Handled
          label in Gmail (each was still marked Handled here, so nothing was lost — just not reflected in the
          real mailbox). This needs a developer to fix the Gmail connection (the API token) — tell Jason or
          Naldo. Once it&apos;s fixed, Retry below clears each item.
        </p>
      )}
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-2">
            <span style={{ color: 'var(--op-text)' }}>
              {item.label}
              {item.status === 'unconfigured' ? (
                <span style={{ color: 'var(--op-text-2)' }}> — Gmail wasn&apos;t connected when this was handled</span>
              ) : (
                item.error && <span style={{ color: 'var(--op-text-2)' }}> — {item.error}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {retryFailedIds[item.id] && <span style={{ color: '#dc2626' }}>Retry failed</span>}
              <button
                type="button"
                disabled={!!busyIds[item.id]}
                onClick={() => retry(item.id)}
                className="underline disabled:opacity-50"
                style={{ color: '#dc2626' }}
              >
                Retry
              </button>
            </span>
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="mt-2" style={{ color: 'var(--op-text-2)' }}>
          Showing the {items.length} most recently handled of {total} — the rest aren&apos;t listed here.
        </p>
      )}
    </div>
  );
}
