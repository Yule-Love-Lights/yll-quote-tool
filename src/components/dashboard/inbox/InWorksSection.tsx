'use client';

import { useState } from 'react';
import type { InWorksItem } from '@/lib/dashboard/inbox/store';
import { formatWaiting } from '@/lib/dashboard/inbox/notify';
import { isStale } from '@/lib/dashboard/inbox/lifecycle';
import { ReplyComposer } from './ReplyComposer';

const SOURCE_LABEL: Record<string, string> = {
  ghl: 'GHL',
  gmail: 'Gmail',
  quotetool: 'Quote',
  homeworks: 'Homeworks',
};

export function InWorksSection({
  awaiting,
  handled,
  followUpDays,
  nowMs,
}: {
  awaiting: InWorksItem[];
  handled: InWorksItem[];
  followUpDays: number;
  nowMs: number;
}) {
  const [awaitingItems, setAwaitingItems] = useState<InWorksItem[]>(awaiting);
  const [handledItems, setHandledItems] = useState<InWorksItem[]>(handled);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [composerFor, setComposerFor] = useState<string | null>(null);

  if (awaitingItems.length === 0 && handledItems.length === 0) return null;

  function removeFromGroup(itemId: string, group: 'awaiting' | 'handled') {
    if (group === 'awaiting') {
      setAwaitingItems((prev) => prev.filter((i) => i.id !== itemId));
    } else {
      setHandledItems((prev) => prev.filter((i) => i.id !== itemId));
    }
  }

  // Fire a one-shot row action (mark-completed / followed). On success the row
  // leaves its current group optimistically — there's no in-works refresh
  // endpoint, so the true state re-syncs on the next full page load. (A "Followed"
  // handled row moves into "awaiting"; it reappears there on reload.)
  async function act(item: InWorksItem, group: 'awaiting' | 'handled', path: string) {
    setBusyId(item.id);
    setErrorId(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: item.id }),
      });
      const data = (await res.json()) as { ok?: boolean };
      if (data.ok) {
        removeFromGroup(item.id, group);
      } else {
        setErrorId(item.id);
      }
    } catch {
      setErrorId(item.id);
    } finally {
      setBusyId(null);
    }
  }

  function renderRow(item: InWorksItem, group: 'awaiting' | 'handled') {
    const waitMs =
      item.lastActivityAt != null ? nowMs - new Date(item.lastActivityAt).getTime() : null;
    const stale = isStale(item.lastActivityAt, followUpDays, new Date(nowMs));
    const staleDays =
      item.lastActivityAt != null
        ? Math.floor((nowMs - new Date(item.lastActivityAt).getTime()) / 86_400_000)
        : 0;

    return (
      <li
        key={item.id}
        className="rounded-lg border p-3"
        style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm" style={{ color: 'var(--op-text)' }}>
                {item.customerName ?? 'Unknown'}
              </span>
              <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-2)' }}>
                {SOURCE_LABEL[item.source] ?? item.source}
                {item.channel ? ` · ${item.channel}` : ''}
              </span>
              {stale && (
                <span
                  className="text-xs font-medium px-1.5 py-0.5 rounded"
                  style={{ background: '#fef3c7', color: '#92400e' }}
                >
                  Follow up — {staleDays}d quiet
                </span>
              )}
            </div>
            {item.preview && (
              <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--op-text-2)' }}>
                {item.preview}
              </p>
            )}
            {waitMs != null && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--op-text-2)' }}>
                {formatWaiting(waitMs)}
              </p>
            )}
            {errorId === item.id && (
              <p className="text-xs mt-0.5" style={{ color: '#dc2626' }}>
                Something went wrong — try again.
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2 flex-wrap justify-end">
            {item.source === 'gmail' ? (
              <span className="px-3 py-1.5 text-sm" style={{ color: 'var(--op-text-2)' }}>
                Reply in Gmail
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setComposerFor(composerFor === item.id ? null : item.id)}
                className="px-3 py-1.5 rounded-md text-sm"
                style={{ border: '1px solid var(--op-border)', color: 'var(--op-text)' }}
              >
                {composerFor === item.id ? 'Cancel' : 'Reply'}
              </button>
            )}
            {group === 'handled' && (
              <button
                type="button"
                disabled={busyId === item.id}
                onClick={() => act(item, group, '/api/dashboard/followed')}
                title="I followed up — snooze until they reply"
                className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
                style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
              >
                Followed
              </button>
            )}
            <button
              type="button"
              disabled={busyId === item.id}
              onClick={() => act(item, group, '/api/dashboard/completed')}
              className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
              style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
            >
              {busyId === item.id ? 'Saving…' : 'Mark completed'}
            </button>
          </div>
        </div>
        {composerFor === item.id && (
          <ReplyComposer
            itemId={item.id}
            source={item.source}
            onSent={() => {
              setComposerFor(null);
              // A sent reply stamps the item handled + followed (snoozed awaiting
              // their reply), so it leaves its current in-works group.
              removeFromGroup(item.id, group);
            }}
          />
        )}
      </li>
    );
  }

  return (
    <section
      className="mt-6 rounded-lg border p-4"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        In the works
      </h2>

      {awaitingItems.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--op-text-2)' }}>
            Awaiting their reply ({awaitingItems.length})
          </p>
          <ul className="space-y-2">
            {awaitingItems.map((item) => renderRow(item, 'awaiting'))}
          </ul>
        </div>
      )}

      {handledItems.length > 0 && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--op-text-2)' }}>
            Handled ({handledItems.length})
          </p>
          <ul className="space-y-2">
            {handledItems.map((item) => renderRow(item, 'handled'))}
          </ul>
        </div>
      )}
    </section>
  );
}
