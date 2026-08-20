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

// Row 291 fix: pure read/write helpers over the per-item busyIds/errorIds
// maps, used by act() and dismissError below. InboxList.tsx carries its own
// separate copy of this exact pattern (row 291 hit both files with an
// identical single-global-slot bug — the two files' act()/dismissError
// implementations stay deliberately un-shared, same as before this fix; see
// this file's own act() comment for why). Exported only so the "one row's
// transition never touches another row's key" invariant is directly
// unit-testable without jsdom or a mocked fetch. withRowFlagCleared fully
// removes the key rather than setting it false, and a no-op clear returns
// the SAME object reference.
export function withRowFlagSet(map: Record<string, boolean>, id: string): Record<string, boolean> {
  return { ...map, [id]: true };
}

export function withRowFlagCleared(map: Record<string, boolean>, id: string): Record<string, boolean> {
  if (!map[id]) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

// #307 review fix 1: a flagged row ("Needs a look") is exactly the case
// "Mark completed" must not silently one-click through — completing is
// terminal (store.ts markItemCompleted sets status='completed', which no
// inbox list queries again, and closes any pending follow-up along with it).
// Pure so the "which rows require the confirmation gate" rule is directly
// unit-testable without rendering or mocking fetch.
export function requiresCompleteConfirmation(item: Pick<InWorksItem, 'needsLookReason'>): boolean {
  return item.needsLookReason != null;
}

export function InWorksSection({
  awaiting,
  handled,
  followUpDays,
  nowMs,
  evidenceIncomplete = false,
}: {
  awaiting: InWorksItem[];
  handled: InWorksItem[];
  followUpDays: number;
  nowMs: number;
  // #307 review fix 2: true when a "Needs a look" evidence lookup (quote
  // status or pending follow-up) failed server-side and fell back to empty —
  // see store.ts listInWorks's evidenceIncomplete. Defaulted so existing
  // callers/tests that don't pass it render exactly as before (no banner).
  evidenceIncomplete?: boolean;
}) {
  const [awaitingItems, setAwaitingItems] = useState<InWorksItem[]>(awaiting);
  const [handledItems, setHandledItems] = useState<InWorksItem[]>(handled);
  // Row 291 fix: busyId/errorId were single global slots (`string | null`) —
  // acting on one row stole another row's busy pin and, worse, silently
  // cleared another row's still-true error note (act() unconditionally
  // called setErrorId(null)). Both are now per-item records keyed by item
  // id, mirroring InboxList.tsx's own fix for this identical pattern.
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [errorIds, setErrorIds] = useState<Record<string, boolean>>({});
  const [composerFor, setComposerFor] = useState<string | null>(null);
  // #307: "Handled" starts collapsed; "Needs a look" always renders expanded
  // (there's no toggle for it). Both are views over the SAME handledItems
  // state array (split below by needsLookReason) — no separate state slice,
  // so act()/moveGroup/removeFromGroup keep working unchanged regardless of
  // which subsection a row currently renders in.
  const [handledExpanded, setHandledExpanded] = useState(false);

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
    setBusyIds((prev) => withRowFlagSet(prev, item.id));
    // Row 291 fix: clear only THIS row's own error, never every row's — the
    // old setErrorId(null) here was the single-slot steal (acting on row B
    // silently erased row A's still-true failure note).
    setErrorIds((prev) => withRowFlagCleared(prev, item.id));
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
        setErrorIds((prev) => withRowFlagSet(prev, item.id));
      }
    } catch {
      setErrorIds((prev) => withRowFlagSet(prev, item.id));
    } finally {
      setBusyIds((prev) => withRowFlagCleared(prev, item.id));
    }
  }

  // Row 291 fix: explicit acknowledge control for the error note. Previously
  // the only ways to clear a row's error were retrying that exact row (via
  // act()) or the accidental cross-row steal this fix removes.
  function dismissError(itemId: string) {
    setErrorIds((prev) => withRowFlagCleared(prev, itemId));
  }

  // #307 review fix 1: the "Mark completed" click handler. For a flagged row,
  // requires an explicit window.confirm naming the reason before act() ever
  // runs — cancelling returns before act() is called, so no status write, no
  // follow-up close, and no busy state (act() is what sets busyIds). An
  // unflagged row (requiresCompleteConfirmation false) calls act() directly,
  // identical to the pre-fix one-click behavior.
  function handleMarkCompleted(item: InWorksItem, group: 'awaiting' | 'handled') {
    if (requiresCompleteConfirmation(item)) {
      const ok = window.confirm(
        `${item.needsLookReason} — mark completed anyway?\n\nThis removes it from every inbox list and closes any pending follow-up. To undo it you have to go to the Activity Log and hit Reverse.`,
      );
      if (!ok) return;
    }
    act(item, group, '/api/dashboard/completed', 'remove');
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
              {/* #307: informational marker only — never phrased as an operator
                  error. A row can land here on rule (b) alone (they wrote last),
                  which is an accepted false-positive for a conversation a staffer
                  genuinely closed over the phone; one click on the same action
                  buttons below clears it. */}
              {item.needsLookReason && (
                <span
                  className="text-xs font-medium px-1.5 py-0.5 rounded"
                  style={{ background: '#dbeafe', color: '#1e40af' }}
                >
                  {item.needsLookReason}
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
            {errorIds[item.id] && (
              <p className="text-xs mt-0.5 flex items-center gap-2" style={{ color: '#dc2626' }}>
                <span>Something went wrong — try again.</span>
                <button
                  type="button"
                  onClick={() => dismissError(item.id)}
                  className="underline"
                  style={{ color: '#dc2626' }}
                >
                  Dismiss
                </button>
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2 flex-wrap justify-end">
            {item.source === 'gmail' ? (
              // #268 fix round (sibling-guard check against InboxList.tsx's
              // matching fix), UPDATED round 3: InboxList's real fix is a
              // "call/text directly" affordance driven by
              // parseLeadForwardDisplay(subject, preview) — deliberately
              // MESSAGE-level, not contact-level (round 2's contact.phone
              // gate was a false-positive HIGH: dashboard_contacts.
              // primary_phone is a cross-channel MERGED field, so a
              // returning customer's ordinary reply could carry a phone from
              // an earlier quote). NOT done here — `InWorksItem` (store.ts,
              // embargoed for this fix round) only selects
              // `dashboard_contacts.display_name` via IN_WORKS_SELECT; it has
              // `preview` but NOT `subject`, and parseLeadForwardDisplay
              // needs both (subject carries the platform marker, preview
              // carries the phone/email). Fixing this needs a store.ts
              // change (add `subject` to IN_WORKS_SELECT + InWorksItem)
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
                disabled={!!busyIds[item.id]}
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
              disabled={!!busyIds[item.id]}
              onClick={() => handleMarkCompleted(item, group)}
              className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
              style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
            >
              {busyIds[item.id] ? 'Saving…' : 'Mark completed'}
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

  // #307: a rendering-only split of the SAME handledItems state array (see
  // that state's own comment above) — no third bucket/state slice exists.
  const needsLookItems = handledItems.filter((item) => item.needsLookReason != null);
  const settledHandledItems = handledItems.filter((item) => item.needsLookReason == null);

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

      {/* #307 review fix 2: rendered independent of needsLookItems.length —
          on a lookup failure the "Needs a look" heading below may not render
          at all (empty list), which is exactly the silent-undercount this
          note exists to surface. Non-alarming, plain: it does not claim any
          specific row is missing, only that the check may be incomplete. */}
      {evidenceIncomplete && (
        <p className="text-xs mb-2" style={{ color: '#92400e' }}>
          Some evidence checks didn’t finish — Needs a look may be missing rows.
        </p>
      )}

      {/* #307: a split VIEW over handledItems, not a separate group — both
          subsections act on 'handled' rows the same way (renderRow's group
          param, and thus every action button, is unaffected by the split). */}
      {needsLookItems.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--op-text-2)' }}>
            Needs a look ({needsLookItems.length})
          </p>
          <ul className="space-y-2">
            {needsLookItems.map((item) => renderRow(item, 'handled'))}
          </ul>
        </div>
      )}

      {settledHandledItems.length > 0 && (
        <div>
          {/* #307 review fix 3: label toggles with state (Show/Hide), matching
              InboxList.tsx's "Show N filtered" / "Hide filtered" expander —
              this button previously read "Handled (N)" in both states, giving
              no feedback about whether the list below was open. */}
          <button
            type="button"
            onClick={() => setHandledExpanded((v) => !v)}
            className="text-xs font-medium uppercase tracking-wide mb-2 underline"
            style={{ color: 'var(--op-text-2)' }}
          >
            {handledExpanded ? `Hide Handled (${settledHandledItems.length})` : `Show Handled (${settledHandledItems.length})`}
          </button>
          {handledExpanded && (
            <ul className="space-y-2">
              {settledHandledItems.map((item) => renderRow(item, 'handled'))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
