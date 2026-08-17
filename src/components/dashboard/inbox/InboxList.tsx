'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import type { OpenInboxItem } from '@/lib/dashboard/inbox/types';
import { parseLeadForwardDisplay } from '@/lib/dashboard/inbox/leadForward';
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
// bare (single-conversation contact) or nested inside an expanded ContactRow
// (#252 slice D). Bundled into one object so InboxList/ContactRow don't have
// to repeat the same nine-prop list at every call site.
type RowActions = {
  now: number;
  busyId: string | null;
  // #224 delta-verify fix (staff + customer lenses converged): the response
  // read act() now does can fail (a status-guard block, or any other non-2xx)
  // — errorId surfaces that visibly, mirroring InWorksSection.tsx's identical
  // pattern for this same /api/dashboard/* route family.
  errorId: string | null;
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
// ContactRow. Occupants enumerated before restructuring (all preserved here):
// escalation dot, contact name, source label, quote value badge, new/
// returning badge, filtered marker, subject line, preview line, escalation
// label + waiting time, claim/release/take-over control, a lost-race error
// note (#224 delta-verify fix), and the four action buttons (Handled / Not a
// lead / Followed / Mark completed) plus Reply (Gmail gets a static "Reply in
// Gmail" note instead — or, for a #268 lead-forward row, an honest
// "call/text directly" affordance instead, see the source==='gmail' branch
// below) with its ReplyComposer.
function ItemRow({ item, actions }: { item: OpenInboxItem; actions: RowActions }) {
  const { now, busyId, errorId, claimBusy, composerFor, currentOperatorId, act, claim, toggleComposer, onComposerSent } = actions;
  const esc = escalation(item.escalationLevel);
  const waiting = item.lastMessageAt ? formatWaiting(now - new Date(item.lastMessageAt).getTime()) : '';
  const cs = claimState(item.assignedTo, currentOperatorId);
  const cid = item.contactId;
  // #268 fix round 3 (technical HIGH, fix-introduced by round 2): MUST be
  // message-level (subject+preview), never `item.contact.phone` —
  // `dashboard_contacts.primary_phone` is a cross-channel MERGED field, so a
  // returning customer who submitted a quote earlier (which carries a phone)
  // and later emails sales@ normally would show a phone on a genuine,
  // replyable Gmail thread and falsely trigger this. parseLeadForwardDisplay
  // never reads the contact at all — see its doc comment in leadForward.ts.
  const forwarded = item.source === 'gmail' ? parseLeadForwardDisplay(item.subject, item.preview) : null;
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
          {errorId === item.id && (
            <p className="text-xs mt-1" style={{ color: '#dc2626' }}>
              Something went wrong — try again.
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
            forwarded ? (
              // #268 fix round (staff HIGH): resolveReplyTarget (reply.ts)
              // sends EVERY gmail-source row to "Reply in Gmail" — structurally
              // wrong for a #268 lead-forward, whose Gmail thread's addressable
              // party is the platform's no-reply relay (replying there reaches
              // nobody). `forwarded` (computed above via
              // parseLeadForwardDisplay) is a MESSAGE-level re-derivation of
              // the row's own subject+preview — see its doc comment for why
              // this must never be contact-level (a returning customer's
              // merged contact.phone false-triggered this in round 2).
              // Display + copy only — no new mutating controls.
              <span className="px-3 py-1.5 text-sm text-right max-w-[220px]" style={{ color: 'var(--op-text-2)' }}>
                Forwarded lead — email replies go to the platform&apos;s no-reply relay. Call or text the customer directly:{' '}
                {forwarded.phone && <span style={{ color: 'var(--op-text)' }}>{forwarded.phone}</span>}
                {forwarded.phone && forwarded.email ? ' · ' : null}
                {forwarded.email && <span style={{ color: 'var(--op-text)' }}>{forwarded.email}</span>}
              </span>
            ) : (
              <span className="px-3 py-1.5 text-sm" style={{ color: 'var(--op-text-2)' }}>
                Reply in Gmail
              </span>
            )
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

// #270 fix (staff HIGH — see the finding this comment is attached to): a
// group whose members include the item currently being composed to must
// never render collapsed, or the operator's live ReplyComposer gets hidden
// behind a collapsed header the instant a poll adds a sibling conversation.
// Pure and exported so this decision is unit-testable without rendering.
export function isGroupExpanded(
  group: InboxGroup,
  expandedMap: Record<string, boolean>,
  composerFor: string | null,
): boolean {
  if (composerFor !== null && group.members.some((m) => m.id === composerFor)) return true;
  return !!expandedMap[group.key];
}

// #270 delta-verify fix (MED, fix-introduced by isGroupExpanded's own pin):
// while composerFor pins a group open, its header toggle must not be allowed
// to mutate the underlying expandedMap. Without this, a click during the pin
// LOOKS like a no-op (the pin visually overrides the display either way) but
// silently flips expandedMap[group.key] underneath it — and the instant the
// reply sends and composerFor clears, isGroupExpanded falls back to that
// stale flipped value, snapping the group collapsed with zero visible
// operator action. Suppressing the toggle while pinned keeps expandedMap
// exactly as it was BEFORE the pin, so releasing the pin restores the
// pre-pin state instead of the swallowed click's retroactive one. Pure and
// exported so both the header's `disabled` state and the toggle-suppression
// share one decision (and it's unit-testable without rendering).
//
// #289 fix (staff MED, cross-wave #769x#776 composition): composerFor was
// the only pin here, predating #776's busyId/errorId state on this same
// list. Collapsing a group unmounts its members <ul> entirely (ContactRow's
// showMembers), so collapsing while a member's action is in flight (busyId)
// or just failed (errorId, the "Something went wrong — try again." note)
// hides that row the instant it's collapsed — the optimistic removal in
// act() already makes the row appear to vanish, and if the group is
// collapsed before/while the action resolves, the row (and any error note)
// comes back on the next refresh() INSIDE a collapsed, unrendered members
// list, visible nowhere. State stays correct (refresh() resyncs); this was
// a visibility-only bug. busyId/errorId now pin exactly like composerFor: a
// member mid-action or showing its error keeps the group un-collapsible
// until that state clears.
export function canToggleGroup(
  group: InboxGroup,
  composerFor: string | null,
  busyId: string | null,
  errorId: string | null,
): boolean {
  const pinnedBy = (id: string | null): boolean => id !== null && group.members.some((m) => m.id === id);
  return !(pinnedBy(composerFor) || pinnedBy(busyId) || pinnedBy(errorId));
}

// A stable-identity row for ONE CONTACT, covering both shapes a contact can
// take: a single open conversation (rendered bare, identical to a plain
// ItemRow) or 2+ conversations (#252 slice D's collapsible header+members
// rollup). EVERY contact renders through this one component now, keyed by
// `group.key` (contactId, or a per-item synthetic key — stable across a
// poll either way) — see the reconciliation trace below for why that's the
// point.
//
// #270 fix round (staff HIGH): the 25s poll (InboxList's `refresh`) can move
// a contact across the 1<->2+ boundary in either direction (a second channel
// reaches out, or a sibling conversation resolves). Before this fix, the
// caller picked between `<ItemRow key={member.id}/>` and `<GroupRow
// key={group.key}/>` for the same contact across two polls — different
// component TYPE *and* different key at that tree position — so React tore
// down and rebuilt the whole subtree on every crossing, silently wiping
// ReplyComposer's local `draftText` (ReplyComposer.tsx, unlifted useState)
// mid-reply. React reconciles by (type, key) at each tree position; this
// component keeps every level from its own root <li> down to each
// ItemRow's nested <ReplyComposer> at a CONSTANT type+key across the
// boundary:
//   - the root is always one <li> (never swaps to/from ItemRow's own <li>,
//     which only ever appears NESTED inside this one, same as it did for
//     the pre-existing 2+-member case)
//   - the header button and the members <ul> are pushed into ONE explicit
//     array as keyed entries ("header" / "members"), so the header
//     appearing/disappearing (isMulti flipping) is an insert/remove at the
//     FRONT of a keyed list — the textbook case React keys exist to make
//     safe for the OTHER entries
//   - the members <ul> keeps key="members" regardless of isMulti, and each
//     member keeps key={member.id} inside it — so a member gaining or
//     losing a sibling is an ordinary keyed-list insert/remove, which never
//     disturbs the REMAINING members' mounted state (including an open
//     ReplyComposer)
// Net effect: a contact's ReplyComposer instance sits at the same tree path
// (ContactRow[key=group.key] -> <li> -> <ul key="members"> ->
// ItemRow[key=member.id] -> ReplyComposer) whether the group has 1 or 2+
// members, so React updates it in place instead of remounting it. The
// members <ul> is only ever OMITTED (not merely hidden) when the group is
// both multi-member AND collapsed AND has no open composer inside it —
// `isGroupExpanded` guarantees that never happens while composerFor points
// at one of this group's members, so the one case that would lose state
// never arises.
function ContactRow({
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
  const isMulti = group.members.length > 1;
  // #270 fix (staff MED): the dot/label reflect the group's WORST member,
  // not just the oldest (`primary`). `automated` members freeze near
  // escalationLevel 0 (store.ts's listEscalatableItems excludes
  // lead_kind='automated' from rescoring), so an older automated member as
  // primary would otherwise mask a genuinely red sibling under
  // Show-filtered. Waiting time still reads from `primary` (the oldest) —
  // that's the honest "how long has someone been waiting" number.
  const maxEscalation = Math.max(...group.members.map((m) => m.escalationLevel));
  const esc = escalation(maxEscalation);
  const waiting = group.primary.lastMessageAt
    ? formatWaiting(actions.now - new Date(group.primary.lastMessageAt).getTime())
    : '';
  // Collapsed-row scope is deliberately narrow (name/age/escalation/source
  // counts/newest preview only, per the slice D brief) — quoteValue/
  // isReturning/filtered stay per-member, visible once expanded, rather than
  // cluttering the rollup row this feature exists to keep scannable.
  const previewLine = group.newest.preview || group.newest.subject;
  // #270 fix (admin MED): prefix the preview with the NEWEST member's own
  // age. Without it, "Overdue · waiting 5h" (the oldest thread's badge) sits
  // directly above the newest thread's preview text and can read as "overdue
  // but already resolved" (e.g. "ok thanks, will call tomorrow") — this cue
  // makes clear the preview is a DIFFERENT, fresher thread than the one the
  // urgency badge is about.
  const previewAge = group.newest.lastMessageAt
    ? formatWaiting(actions.now - new Date(group.newest.lastMessageAt).getTime())
    : '';
  const panelId = `inbox-group-panel-${group.key}`;
  // Members render whenever there's no collapse concept at all (a lone
  // conversation is always fully visible, same as today's bare row) or the
  // group is actually expanded — never gated on `isMulti` alone, or a
  // single-conversation contact would render an empty <li>.
  const showMembers = !isMulti || expanded;
  // #270 delta-verify fix: disabling the button (rather than only guarding
  // the click handler) makes the "you can't collapse this while replying"
  // state VISIBLE, not just structurally safe — see canToggleGroup's doc.
  const canToggle = canToggleGroup(group, actions.composerFor, actions.busyId, actions.errorId);

  const rowChildren: ReactNode[] = [];
  if (isMulti) {
    rowChildren.push(
      <button
        key="header"
        type="button"
        disabled={!canToggle}
        title={canToggle ? undefined : 'Finish the open reply or pending action on a member here before collapsing this group'}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggleExpanded}
        className="w-full flex items-start justify-between gap-3 text-left disabled:opacity-60 disabled:cursor-not-allowed"
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
              {previewAge ? `${previewAge} ago · ` : ''}
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
      </button>,
    );
  }
  if (showMembers) {
    rowChildren.push(
      <ul
        key="members"
        id={panelId}
        className={isMulti ? 'mt-3 pl-4 space-y-3 border-l-2' : ''}
        style={isMulti ? { borderColor: 'var(--op-border)' } : undefined}
      >
        {group.members.map((member) => (
          <ItemRow key={member.id} item={member} actions={actions} />
        ))}
      </ul>,
    );
  }
  return (
    <li
      className={isMulti ? 'rounded-lg border p-4' : ''}
      style={isMulti ? { borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' } : undefined}
    >
      {rowChildren}
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
  // #224 delta-verify fix (staff + customer lenses converged): act() used to
  // never read the response at all — see act()'s own doc comment below.
  const [errorId, setErrorId] = useState<string | null>(null);
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

  // #224 delta-verify fix (staff + customer lenses converged on this — the
  // sibling-parity class between act()'s two callers): this used to fire the
  // POST and never read res.status or the JSON body — only a network throw
  // was caught. #224's new status guard on markItemCompleted makes ok:false a
  // DESIGNED outcome (a two-operator/two-tab race the guard exists to catch),
  // and every other /api/dashboard/* route here CAN 200 with a logical
  // failure the same way (handled/dismiss already carry their own guards).
  // Before this fix, that response was silently discarded: the optimistic
  // removal above had already taken the row off screen, with no toast, no
  // re-insertion, nothing — a silent no-op on this page (the PRIMARY inbox
  // surface), while InWorksSection.tsx's identical act() (its own local
  // copy, not shared) already read the response correctly.
  //
  // Fix: read res.ok AND the JSON body's `ok` field. On failure, DON'T
  // re-insert the optimistically-removed row — after a lost race, the row's
  // real current state is whatever the OTHER actor set (could be handled,
  // dismissed, completed, or unchanged), never simply "still open as
  // before". refresh() pulls that authoritative state immediately, mirroring
  // claim()'s own `if (!res.ok) await refresh()` pattern a few lines below —
  // the same file already established this exact reconciliation shape.
  // errorId also surfaces a visible note (parity with InWorksSection's
  // errorId/"Something went wrong" pattern) in case the row is still on
  // screen after refresh() (e.g. a real server error, not a lost race).
  //
  // The network-throw catch path is UNCHANGED (still passive, "next poll
  // re-syncs") — a thrown fetch means the request may never have reached the
  // server at all, so there's no fresher truth to pull yet; an immediate
  // refresh() would likely hit the same network failure. That's a different
  // failure mode than "the server responded and said no", which this fix
  // targets.
  //
  // Not unit-tested: InboxList.test.tsx only exercises
  // renderToStaticMarkup (no jsdom, no click/fetch simulation, no effects) —
  // it cannot drive this async click-then-refetch flow. There's no non-
  // trivial PURE decision here to extract either (the check is a two-field
  // boolean read); this comment is the trace, matching ContactRow's own
  // doc-comment-as-proof pattern elsewhere in this file for behavior static
  // rendering can't observe.
  const act = useCallback(async (id: string, path: string) => {
    setBusyId(id);
    setErrorId(null);
    setItems((prev) => prev.filter((i) => i.id !== id)); // optimistic removal
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: id }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !data?.ok) {
        setErrorId(id);
        await refresh();
      }
    } catch {
      // The next poll re-syncs the true state if the write failed.
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

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
    now, busyId, errorId, claimBusy, composerFor, currentOperatorId, act, claim, toggleComposer, onComposerSent,
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
        {groups.map((group) => (
          // #270 fix: every group — single-conversation or 2+ — renders
          // through the SAME component (ContactRow) at the SAME key
          // (group.key), so a 25s poll that moves a contact across the
          // 1<->2+ boundary never swaps component type/key at this position.
          // See ContactRow's own doc comment for the full reconciliation
          // trace this fixes.
          <ContactRow
            key={group.key}
            group={group}
            expanded={isGroupExpanded(group, expanded, composerFor)}
            // #270 delta-verify fix, extended #289: no-op while composerFor/
            // busyId/errorId pins this group open — see canToggleGroup's doc
            // comment for why a swallowed toggle during the pin must not
            // mutate expandedMap.
            onToggleExpanded={() => {
              if (canToggleGroup(group, composerFor, busyId, errorId)) toggleExpanded(group.key);
            }}
            actions={rowActions}
          />
        ))}
      </ul>
      )}
    </>
  );
}
