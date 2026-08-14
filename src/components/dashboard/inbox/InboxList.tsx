'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import type { OpenInboxItem } from '@/lib/dashboard/inbox/types';
import { formatWaiting } from '@/lib/dashboard/inbox/notify';
import { claimState } from '@/lib/dashboard/inbox/assignment';
import { buildInboxSummary } from '@/lib/dashboard/inbox/summary';
import { groupInboxItems, type InboxGroup } from '@/lib/dashboard/inbox/groupInboxItems';
import { InboxSummaryStrip } from './InboxSummaryStrip';
import { ReplyComposer } from './ReplyComposer';

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

// Props threaded down to every per-conversation row, whether it's rendered
// bare (single-conversation contact) or nested inside an expanded GroupRow
// (#252 slice D). Bundled into one object so InboxList/GroupRow don't have to
// repeat the same nine-prop list at every call site.
type RowActions = {
  now: number;
  busyId: string | null;
  claimBusy: string | null;
  composerFor: string | null;
  currentOperatorId: string | null;
  act: (id: string, path: string) => void;
  claim: (contactId: string, action: 'claim' | 'release') => void;
  toggleComposer: (id: string) => void;
  onComposerSent: (id: string) => void;
};

// One conversation's row — exactly what InboxList rendered inline before
// slice D, just lifted out so it can be reused both as a top-level row (the
// common single-conversation case) and as a member row inside an expanded
// GroupRow. Occupants enumerated before restructuring (all preserved here):
// escalation dot, contact name, source label, quote value badge, new/
// returning badge, filtered marker, subject line, preview line, escalation
// label + waiting time, claim/release/take-over control, and the four action
// buttons (Handled / Not a lead / Followed / Mark completed) plus Reply
// (Gmail gets a static "Reply in Gmail" note instead) with its ReplyComposer.
function ItemRow({ item, actions }: { item: OpenInboxItem; actions: RowActions }) {
  const { now, busyId, claimBusy, composerFor, currentOperatorId, act, claim, toggleComposer, onComposerSent } = actions;
  const esc = escalation(item.escalationLevel);
  const waiting = item.lastMessageAt ? formatWaiting(now - new Date(item.lastMessageAt).getTime()) : '';
  const cs = claimState(item.assignedTo, currentOperatorId);
  const cid = item.contactId;
  return (
    <li
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
            title="Closed as answered"
            className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
          >
            Handled
          </button>
          <button
            type="button"
            disabled={busyId === item.id}
            onClick={() => act(item.id, '/api/dashboard/dismiss')}
            title="Permanently hidden as spam"
            className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
            style={{ color: 'var(--op-text-2)' }}
          >
            Not a lead
          </button>
          <button
            type="button"
            disabled={busyId === item.id}
            onClick={() => act(item.id, '/api/dashboard/followed')}
            title="I followed up: snoozed until they reply"
            className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
            style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Followed
          </button>
          <button
            type="button"
            disabled={busyId === item.id}
            onClick={() => act(item.id, '/api/dashboard/completed')}
            title="Closed as done"
            className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
            style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Mark completed
          </button>
          {item.source === 'gmail' ? (
            <span className="px-3 py-1.5 text-sm" style={{ color: 'var(--op-text-2)' }}>
              Reply in Gmail
            </span>
          ) : (
            <button
              type="button"
              onClick={() => toggleComposer(item.id)}
              className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
              style={{ border: '1px solid var(--op-border)', color: 'var(--op-text)' }}
            >
              {composerFor === item.id ? 'Cancel' : 'Reply'}
            </button>
          )}
        </div>
      </div>
      {composerFor === item.id && (
        <ReplyComposer
          itemId={item.id}
          source={item.source}
          onSent={() => onComposerSent(item.id)}
        />
      )}
    </li>
  );
}

// A rolled-up row for a contact with 2+ open conversations (#252 slice D):
// collapsed by default, showing the oldest member's name/escalation/age (the
// flat list is oldest-first so nothing gets buried under a fresher sibling),
// a per-source badge summary, and the newest member's preview line. Expands
// to the same ItemRow markup/actions each conversation has today. A native
// <button> gives keyboard operability (Enter/Space) and aria-expanded for
// free — no nested interactive controls live inside it, only badges/text.
function GroupRow({
  group,
  expanded,
  onToggleExpanded,
  actions,
}: {
  group: InboxGroup;
  expanded: boolean;
  onToggleExpanded: () => void;
  actions: RowActions;
}) {
  const esc = escalation(group.primary.escalationLevel);
  const waiting = group.primary.lastMessageAt
    ? formatWaiting(actions.now - new Date(group.primary.lastMessageAt).getTime())
    : '';
  // Collapsed-row scope is deliberately narrow (name/age/escalation/source
  // counts/newest preview only, per the slice D brief) — quoteValue/
  // isReturning/filtered stay per-member, visible once expanded, rather than
  // cluttering the rollup row this feature exists to keep scannable.
  const previewLine = group.newest.preview || group.newest.subject;
  const panelId = `inbox-group-panel-${group.key}`;
  return (
    <li className="rounded-lg border p-4" style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggleExpanded}
        className="w-full flex items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: 9999, background: esc.dot, display: 'inline-block' }}
            />
            <span className="font-medium truncate" style={{ color: 'var(--op-text)' }}>
              {contactName(group.primary)}
            </span>
            {Object.entries(group.sourceCounts).map(([source, count]) => (
              <span key={source} className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-2)' }}>
                {SOURCE_LABEL[source] ?? source} ×{count ?? 0}
              </span>
            ))}
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--op-text-2)' }}>
            {esc.label ? `${esc.label} · ` : ''}
            {waiting ? `waiting ${waiting}` : ''}
          </p>
          {previewLine && (
            <p className="text-sm mt-1 truncate" style={{ color: 'var(--op-text-2)' }}>
              {previewLine}
            </p>
          )}
        </div>
        <ChevronDown
          aria-hidden
          style={{
            width: 16,
            height: 16,
            color: 'var(--op-text-2)',
            flexShrink: 0,
            marginTop: 2,
            transform: expanded ? 'rotate(180deg)' : undefined,
            transition: 'transform 150ms',
          }}
        />
      </button>
      {expanded && (
        <ul id={panelId} className="mt-3 pl-4 space-y-3 border-l-2" style={{ borderColor: 'var(--op-border)' }}>
          {group.members.map((member) => (
            <ItemRow key={member.id} item={member} actions={actions} />
          ))}
        </ul>
      )}
    </li>
  );
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
  const [composerFor, setComposerFor] = useState<string | null>(null);
  // `now` is seeded from the server render (stable across hydration) and ticked
  // from an interval callback, so render stays pure and "waiting Xm" stays live.
  const [now, setNow] = useState<number>(nowMs);
  const [channel, setChannel] = useState<'all' | 'ghl' | 'gmail' | 'quotetool' | 'homeworks'>('all');
  const [showFiltered, setShowFiltered] = useState(false);
  // Which rolled-up groups (#252 slice D) are expanded, keyed by group.key
  // (contactId, or a per-item synthetic key for unlinked items) rather than
  // array index/position — so a 25s refresh() that reorders or reshapes
  // `items` doesn't collapse a group the operator just opened.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  const toggleComposer = useCallback((id: string) => {
    setComposerFor((prev) => (prev === id ? null : id));
  }, []);

  const onComposerSent = useCallback((id: string) => {
    setComposerFor(null);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const summary = buildInboxSummary(items, now);
  const visibleItems = items
    .filter((i) => showFiltered || i.leadKind !== 'automated')
    .filter((i) => channel === 'all' || i.source === channel);
  // #252 slice D: fold the already-filtered flat items into one row per
  // contact. Filtering BEFORE grouping (not after) means "a group with zero
  // matching members disappears" falls out for free — a filtered-out member
  // was never in `visibleItems`, so it never enters a group in the first
  // place; there's no empty group to separately prune.
  const groups = groupInboxItems(visibleItems);
  const rowActions: RowActions = {
    now, busyId, claimBusy, composerFor, currentOperatorId, act, claim, toggleComposer, onComposerSent,
  };

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
      {groups.length === 0 ? (
        <p className="text-sm py-6 text-center" style={{ color: 'var(--op-text-2)' }}>
          Nothing in this view — switch channel{summary.filtered > 0 ? ' or Show filtered' : ''}.
        </p>
      ) : (
      <ul className="space-y-3">
        {groups.map((group) =>
          // Single-conversation contacts (the common case — most contacts
          // have exactly one open row) render as a bare ItemRow: no group
          // header, no expand affordance noise. Only a contact with 2+ open
          // conversations gets the rolled-up GroupRow treatment.
          group.members.length === 1 ? (
            <ItemRow key={group.members[0].id} item={group.members[0]} actions={rowActions} />
          ) : (
            <GroupRow
              key={group.key}
              group={group}
              expanded={!!expanded[group.key]}
              onToggleExpanded={() => toggleExpanded(group.key)}
              actions={rowActions}
            />
          ),
        )}
      </ul>
      )}
    </>
  );
}
