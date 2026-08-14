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

  // Move a row to its TRUE group after a mutation, instead of just deleting it —
  // there's no in-works refresh endpoint, so this is how local state stays
  // consistent with the server's actual bucket predicates (store.ts `listInWorks`)
  // without a full page reload. No-op when the row is already in `to`.
  function moveGroup(itemId: string, from: 'awaiting' | 'handled', to: 'awaiting' | 'handled') {
    if (from === to) return;
    const source = from === 'awaiting' ? awaitingItems : handledItems;
    const item = source.find((i) => i.id === itemId);
    if (!item) return;
    if (from === 'awaiting') {
      setAwaitingItems((prev) => prev.filter((i) => i.id !== itemId));
    } else {
      setHandledItems((prev) => prev.filter((i) => i.id !== itemId));
    }
    if (to === 'awaiting') {
      setAwaitingItems((prev) => [...prev, item]);
    } else {
      setHandledItems((prev) => [...prev, item]);
    }
  }

  // Fire a one-shot row action (mark-completed / followed). `outcome` is the row's
  // TRUE resulting group per the server predicates: 'remove' for completed/dismissed
  // (leaves both groups), or the group it now belongs in otherwise — e.g. a
  // "Followed" handled row gets followed_up_at stamped, which flips it into
  // "awaiting" rather than dropping it from the section.
  async function act(
    item: InWorksItem,
    group: 'awaiting' | 'handled',
    path: string,
    outcome: 'awaiting' | 'handled' | 'remove',
  ) {
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
        if (outcome === 'remove') {
          removeFromGroup(item.id, group);
        } else {
          moveGroup(item.id, group, outcome);
        }
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
              // #268 fix round (sibling-guard check against InboxList.tsx's
              // matching fix): a #268 lead-forward's real fix is a
              // "call/text directly" affordance keyed on the contact having a
              // PHONE — NOT done here. `InWorksItem` (store.ts, embargoed for
              // this fix round) only selects `dashboard_contacts.display_name`
              // (IN_WORKS_SELECT), never phone/email, so that marker isn't
              // available at this layer at all. Fixing this needs a store.ts
              // change (add phone/email to IN_WORKS_SELECT + InWorksItem)
              // that's out of scope here — tracked as a follow-up, not
              // silently left both broken AND undocumented.
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
                onClick={() => act(item, group, '/api/dashboard/followed', 'awaiting')}
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
              onClick={() => act(item, group, '/api/dashboard/completed', 'remove')}
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
            channel={item.channel}
            onSent={() => {
              setComposerFor(null);
              // A sent reply stamps the item handled + followed (snoozed awaiting
              // their reply) — its true group is always "awaiting" afterward. On an
              // already-awaiting row this is a no-op (it must NOT disappear); on a
              // handled row it moves there instead of vanishing.
              moveGroup(item.id, group, 'awaiting');
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
