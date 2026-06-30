'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { OpenInboxItem } from '@/lib/dashboard/inbox/types';
import { formatWaiting } from '@/lib/dashboard/inbox/notify';
import { claimState } from '@/lib/dashboard/inbox/assignment';
import { buildInboxSummary } from '@/lib/dashboard/inbox/summary';
import { InboxSummaryStrip } from './InboxSummaryStrip';

const SOURCE_LABEL: Record<string, string> = {
  ghl: 'GHL',
  gmail: 'Gmail',
  quotetool: 'Quote',
  homeworks: 'Homeworks',
};

function escalation(level: number): { dot: string; label: string } {
  if (level >= 2) return { dot: '#dc2626', label: 'Overdue' }; // red >4h
  if (level >= 1) return { dot: '#d97706', label: 'Waiting' }; // amber >1h
  return { dot: 'var(--op-text-2)', label: '' };
}

function contactName(item: OpenInboxItem): string {
  return item.contact?.displayName || item.contact?.email || item.contact?.phone || 'Unknown contact';
}

export function InboxList({
  initialItems,
  nowMs,
  currentOperatorId = null,
}: {
  initialItems: OpenInboxItem[];
  nowMs: number;
  currentOperatorId?: string | null;
}) {
  const [items, setItems] = useState<OpenInboxItem[]>(initialItems);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState<string | null>(null);
  // `now` is seeded from the server render (stable across hydration) and ticked
  // from an interval callback, so render stays pure and "waiting Xm" stays live.
  const [now, setNow] = useState<number>(nowMs);
  const [channel, setChannel] = useState<'all' | 'ghl' | 'gmail' | 'quotetool' | 'homeworks'>('all');
  const [showFiltered, setShowFiltered] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/inbox', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: OpenInboxItem[] };
      if (Array.isArray(data.items)) setItems(data.items);
    } catch {
      // Keep the current list on a transient network error.
    }
  }, []);

  // Revalidate every ~25s (no realtime in v1).
  useEffect(() => {
    const id = setInterval(refresh, 25_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Tick `now` every 30s (setState lives in the interval callback, not the
  // effect body) so the wait-time labels stay current.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Always-on nudge: surface the count of overdue (red) items in the tab title.
  useEffect(() => {
    const red = items.filter((i) => i.escalationLevel >= 2).length;
    document.title = red > 0 ? `(${red}) Inbox — YLL` : 'Inbox — YLL';
  }, [items]);

  const act = useCallback(async (id: string, path: string) => {
    setBusyId(id);
    setItems((prev) => prev.filter((i) => i.id !== id)); // optimistic removal
    try {
      await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: id }),
      });
    } catch {
      // The next poll re-syncs the true state if the write failed.
    } finally {
      setBusyId(null);
    }
  }, []);

  const claim = useCallback(
    async (contactId: string, action: 'claim' | 'release') => {
      setClaimBusy(contactId);
      // Optimistic: assignment is per-contact, so update every item for it.
      setItems((prev) =>
        prev.map((i) =>
          i.contactId === contactId ? { ...i, assignedTo: action === 'claim' ? currentOperatorId : null } : i,
        ),
      );
      try {
        const res = await fetch('/api/dashboard/claim', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contactId, action }),
        });
        if (!res.ok) await refresh(); // resync the true assignment if it was rejected
      } catch {
        await refresh();
      } finally {
        setClaimBusy(null);
      }
    },
    [currentOperatorId, refresh],
  );

  const summary = buildInboxSummary(items, now);
  const visible = items
    .filter((i) => showFiltered || i.leadKind !== 'automated')
    .filter((i) => channel === 'all' || i.source === channel);

  if (items.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--op-text-2)' }}>
        Nothing unanswered right now. 🎉
      </p>
    );
  }

  return (
    <>
      <InboxSummaryStrip summary={summary} />
      <div className="flex items-center flex-wrap gap-2 mb-4">
        {(['all', 'gmail', 'ghl', 'quotetool'] as const).map((c) => (
          <button key={c} type="button" onClick={() => setChannel(c)}
            className="px-3 py-1.5 rounded-md text-sm"
            style={{ border: c === channel ? '2px solid var(--brand-evergreen)' : '1px solid var(--op-border)', color: 'var(--op-text)' }}>
            {c === 'all' ? `All ${summary.openLeads}` : `${SOURCE_LABEL[c] ?? c} ${summary.byChannel[c] ?? 0}`}
          </button>
        ))}
        <span className="flex-1" />
        {summary.filtered > 0 && (
          <button type="button" onClick={() => setShowFiltered((v) => !v)} className="text-sm underline" style={{ color: 'var(--op-text-2)' }}>
            {showFiltered ? 'Hide filtered' : `Show ${summary.filtered} filtered`}
          </button>
        )}
        <Link href="/inbox/settings" aria-label="Inbox settings" style={{ color: 'var(--op-text-2)' }}>⚙</Link>
      </div>
      {visible.length === 0 ? (
        <p className="text-sm py-6 text-center" style={{ color: 'var(--op-text-2)' }}>
          Nothing in this view — switch channel{summary.filtered > 0 ? ' or Show filtered' : ''}.
        </p>
      ) : (
      <ul className="space-y-3">
        {visible.map((item) => {
        const esc = escalation(item.escalationLevel);
        const waiting = item.lastMessageAt
          ? formatWaiting(now - new Date(item.lastMessageAt).getTime())
          : '';
        const cs = claimState(item.assignedTo, currentOperatorId);
        const cid = item.contactId;
        return (
          <li
            key={item.id}
            className="rounded-lg border p-4"
            style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    style={{ width: 8, height: 8, borderRadius: 9999, background: esc.dot, display: 'inline-block' }}
                  />
                  <span className="font-medium truncate" style={{ color: 'var(--op-text)' }}>
                    {contactName(item)}
                  </span>
                  <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-2)' }}>
                    {SOURCE_LABEL[item.source] ?? item.source}
                  </span>
                  {item.quoteValue ? (
                    <span className="text-xs font-medium" style={{ color: 'var(--op-text)' }}>${Math.round(item.quoteValue).toLocaleString()}</span>
                  ) : null}
                  <span className="text-xs uppercase tracking-wide" style={{ color: item.isReturning ? 'var(--op-text-2)' : 'var(--brand-evergreen-3)' }}>
                    {item.isReturning ? 'Returning' : 'New lead'}
                  </span>
                  {item.leadKind === 'automated' && (
                    <span className="text-xs" style={{ color: 'var(--op-text-2)' }}>· filtered</span>
                  )}
                </div>
                {item.subject && (
                  <p className="text-sm mt-1 truncate" style={{ color: 'var(--op-text)' }}>
                    {item.subject}
                  </p>
                )}
                {item.preview && (
                  <p className="text-sm mt-1 truncate" style={{ color: 'var(--op-text-2)' }}>
                    {item.preview}
                  </p>
                )}
                <p className="text-xs mt-1" style={{ color: 'var(--op-text-2)' }}>
                  {esc.label ? `${esc.label} · ` : ''}
                  {waiting ? `waiting ${waiting}` : ''}
                </p>
                {cid && (
                  <p className="text-xs mt-1">
                    {cs === 'mine' ? (
                      <span style={{ color: 'var(--brand-evergreen-3)' }}>
                        ✓ You’ve got this ·{' '}
                        <button
                          type="button"
                          disabled={claimBusy === cid}
                          onClick={() => claim(cid, 'release')}
                          className="underline disabled:opacity-50"
                          style={{ color: 'var(--op-text-2)' }}
                        >
                          release
                        </button>
                      </span>
                    ) : cs === 'other' ? (
                      <span style={{ color: 'var(--op-text-2)' }}>
                        Claimed ·{' '}
                        <button
                          type="button"
                          disabled={claimBusy === cid}
                          onClick={() => claim(cid, 'claim')}
                          className="underline disabled:opacity-50"
                          style={{ color: 'var(--op-text-2)' }}
                        >
                          take over
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={claimBusy === cid}
                        onClick={() => claim(cid, 'claim')}
                        className="underline disabled:opacity-50"
                        style={{ color: 'var(--brand-evergreen-3)' }}
                      >
                        Claim
                      </button>
                    )}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => act(item.id, '/api/dashboard/handled')}
                  className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50"
                  style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
                >
                  Handled
                </button>
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => act(item.id, '/api/dashboard/dismiss')}
                  className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
                  style={{ color: 'var(--op-text-2)' }}
                >
                  Not a lead
                </button>
              </div>
            </div>
          </li>
        );
        })}
      </ul>
      )}
    </>
  );
}
