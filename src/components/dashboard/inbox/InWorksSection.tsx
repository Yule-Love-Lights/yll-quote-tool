'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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

/** Row 311: withRowFlagCleared's sibling for the string-valued unreachableActions
 *  map (it records WHICH action was attempted, not merely that one was) — a
 *  local copy of InboxList.tsx's own `omitKey` (#302), kept deliberately
 *  un-shared like the rest of this file's helpers. Same contract: returns the
 *  SAME reference when the key is absent, so clearing on an unaffected row
 *  never forces a needless re-render. */
export function omitKey<T>(map: Record<string, T>, id: string): Record<string, T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** Row 311 fix-round FIX 3: picks the error note's text — a local copy of
 *  InboxList.tsx's own `errorNoteFor`, kept deliberately un-shared like the
 *  rest of this file's helpers (see the doc comment on `omitKey` above). A
 *  thrown fetch (no answer received) takes priority — its copy is unchanged
 *  by this fix, and it's the more consequential case (drives the row's action
 *  lock below). A definite server rejection's own `data.error` is more
 *  specific than the generic fallback and now renders when the route provided
 *  one. Pure and exported so this is directly unit-testable without rendering. */
export function errorNoteFor(unreachableAction: string | undefined, rejectionError: string | undefined): string {
  if (unreachableAction) {
    return `Couldn't reach the server — this may or may not have gone through. Click ${unreachableAction} again to confirm.`;
  }
  return rejectionError || 'Something went wrong — try again.';
}

/** Row 309: a local copy of InboxList.tsx's own retiresFollowUp (kept
 *  deliberately un-shared like the rest of this file's helpers). Only 'Mark
 *  completed' (path === '/api/dashboard/completed') can retire a pending
 *  "due today" follow-up — closeFollowUpsForResolvedItem (store.ts) is
 *  called ONLY from dismissItem and markItemCompleted; 'Followed' (this
 *  file's other act() caller) never does. Pure and exported so this is
 *  directly unit-testable without rendering. */
export function retiresFollowUp(path: string): boolean {
  return path === '/api/dashboard/completed';
}

/** Row 311 fold-in (LOW): a row moved client-side by moveGroup carries its OLD
 *  needsLookReason along with it unless cleared — moveGroup only ever fires as
 *  the RESULT of a real operator action (a "Followed" click, or a sent reply),
 *  both of which resolve the flag: the operator has just looked at and acted
 *  on the row. Without this, the "Needs a look" badge (and
 *  requiresCompleteConfirmation's confirm gate) stay stamped on a row now
 *  sitting in a different bucket until the next full page load re-derives it
 *  from the server. Pure so the transform is directly unit-testable. */
export function clearNeedsLookOnMove<T extends { needsLookReason: string | null }>(item: T): T {
  return item.needsLookReason == null ? item : { ...item, needsLookReason: null };
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

// Row 304: the earlier copy said "To undo it you have to go to the Activity
// Log and hit Reverse", which is true for the item's status but false for the
// follow-up nag the same sentence warns about — reverseItemState (store.ts)
// updates inbox_items only and never touches follow_ups, so #798's auto-close
// stays closed even after a Reverse. Worded honestly instead of promising a
// re-arm the code doesn't do. Pure + exported so the wording is directly
// unit-testable (this project has no jsdom — see this file's other pure
// exports / their own doc comments).
export function completeConfirmMessage(item: Pick<InWorksItem, 'needsLookReason'>): string {
  return `${item.needsLookReason} — mark completed anyway?\n\nThis removes it from every inbox list and closes any pending follow-up. Reverse (Activity Log) undoes the status change, but does not re-open the follow-up nag.`;
}

/** Row 321: an independent, higher-priority confirm gate for "Mark
 *  completed" on a `:color-request` item (item.isColorRequest) — separate
 *  from requiresCompleteConfirmation/completeConfirmMessage above because the
 *  two signals are independent (a color-request row can read as "settled" on
 *  needsLookReason — e.g. staff already replied, flipping direction to
 *  outbound — while its quote's pendingColorRequest is still live). A local
 *  copy of InboxList.tsx's own colorRequestConfirmMessage, kept deliberately
 *  un-shared like this file's other duplicated helpers (see withRowFlagSet's
 *  own doc comment above). Does NOT hard-block. */
export function requiresColorRequestConfirmation(item: Pick<InWorksItem, 'isColorRequest'>): boolean {
  return !!item.isColorRequest;
}

/** Row 321 fix-round FIX 3 (staff LOW): named "(Colour request panel)" —
 *  ColorRequestPanel.tsx has no such label anywhere; its real on-page heading
 *  is "Colour change requested" (pre-apply) / "Colour change applied"
 *  (post-apply). Fixed to name what staff will actually see. */
export function colorRequestConfirmMessage(): string {
  return "This customer is waiting on a colour change — mark it handled anyway?\n\nThe requested colour is still pending on the quote. Review or apply it from the quote's admin page (the \"Colour change requested\" section) first, or Cancel and do that now.";
}

/** Row 321 fix-round FIX 2 (staff MED): requiresColorRequestConfirmation and
 *  requiresCompleteConfirmation are independent signals (see the former's own
 *  doc above) — firing them as two SEQUENTIAL window.confirm() calls stacked
 *  two native dialogs on one click whenever both applied. This composes both
 *  concerns into ONE dialog, asked once; handleMarkCompleted below only calls
 *  this when BOTH gates are true — an item flagged on just one axis still gets
 *  its existing standalone message, unchanged. */
export function combinedCompleteConfirmMessage(item: Pick<InWorksItem, 'needsLookReason'>): string {
  return (
    `This customer is waiting on a colour change, and this row is also flagged "${item.needsLookReason}" — mark it completed anyway?\n\n` +
    'The requested colour is still pending on the quote. Review or apply it from the quote\'s admin page (the "Colour change requested" section) first, or Cancel and do that now.\n\n' +
    'Marking completed also removes this item from every inbox list and closes any pending follow-up. Reverse (Activity Log) undoes the status change, but does not re-open the follow-up nag.'
  );
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
  const router = useRouter();
  const [awaitingItems, setAwaitingItems] = useState<InWorksItem[]>(awaiting);
  const [handledItems, setHandledItems] = useState<InWorksItem[]>(handled);
  // Row 291 fix: busyId/errorId were single global slots (`string | null`) —
  // acting on one row stole another row's busy pin and, worse, silently
  // cleared another row's still-true error note (act() unconditionally
  // called setErrorId(null)). Both are now per-item records keyed by item
  // id, mirroring InboxList.tsx's own fix for this identical pattern.
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  const [errorIds, setErrorIds] = useState<Record<string, boolean>>({});
  // Row 311: the LABEL of the action attempted when a fetch THROWS (no answer
  // received, unlike a server rejection) — mirrors InboxList.tsx's own
  // unreachableActions (#302). Drives both the error copy and the lock below.
  const [unreachableActions, setUnreachableActions] = useState<Record<string, string>>({});
  // Row 311 fix-round FIX 3: a definite server rejection's own error text —
  // mirrors InboxList.tsx's own rejectionErrors. See errorNoteFor above.
  const [rejectionErrors, setRejectionErrors] = useState<Record<string, string>>({});
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
    // Row 311 fold-in (LOW): clear a stale needsLookReason on the way in — see
    // clearNeedsLookOnMove's own doc comment above.
    const moved = clearNeedsLookOnMove(item);
    if (to === 'awaiting') {
      setAwaitingItems((prev) => [...prev, moved]);
    } else {
      setHandledItems((prev) => [...prev, moved]);
    }
  }

  // Fire a one-shot row action (mark-completed / followed). `outcome` is the row's
  // TRUE resulting group per the server predicates: 'remove' for completed/dismissed
  // (leaves both groups), or the group it now belongs in otherwise — e.g. a
  // "Followed" handled row gets followed_up_at stamped, which flips it into
  // "awaiting" rather than dropping it from the section.
  //
  // Row 311 (10th sibling-parity instance — the LOCK half of #806/#302 that
  // InboxList.tsx got but this file never did): a THROWN fetch means no answer
  // was received, so the write may or may not have landed server-side. Every
  // OTHER action button on this row staying enabled is not harmless — concrete
  // harm: Mark completed throws (the write lands), operator clicks Followed
  // instead, and (pre-row-306) markItemFollowed would silently stamp
  // followed_up_at on a really-completed row; row 306 now guards the store
  // side too, but this lock is the first line of defense, mirroring
  // InboxList.tsx's ItemRow lockedOut. `label` is the button's own visible
  // text ('Followed' / 'Mark completed'), recorded in unreachableActions so
  // the row can be locked to retrying THAT one action.
  async function act(
    item: InWorksItem,
    group: 'awaiting' | 'handled',
    path: string,
    outcome: 'awaiting' | 'handled' | 'remove',
    label: string,
  ) {
    setBusyIds((prev) => withRowFlagSet(prev, item.id));
    // Row 291 fix: clear only THIS row's own error, never every row's — the
    // old setErrorId(null) here was the single-slot steal (acting on row B
    // silently erased row A's still-true failure note).
    setErrorIds((prev) => withRowFlagCleared(prev, item.id));
    setUnreachableActions((prev) => omitKey(prev, item.id));
    setRejectionErrors((prev) => omitKey(prev, item.id));
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: item.id }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (data?.ok) {
        if (outcome === 'remove') {
          removeFromGroup(item.id, group);
        } else {
          moveGroup(item.id, group, outcome);
        }
        // Row 309: this row's own optimistic transition above already keeps
        // THIS section correct — router.refresh() exists purely to reach the
        // sibling FollowUpStrip, whose initialItems prop is otherwise only
        // ever read once (useState's initializer is mount-only, see
        // FollowUpStrip's own reconcile effect). See retiresFollowUp's doc
        // comment for why this is scoped to 'Mark completed' only.
        if (retiresFollowUp(path)) router.refresh();
      } else {
        // A definite server answer (a rejection, not a throw) — the write is
        // known NOT to have happened, so no lock: every button stays usable.
        setErrorIds((prev) => withRowFlagSet(prev, item.id));
        // Row 311 fix-round FIX 3: surface the route's own error text (e.g.
        // "Already marked followed") instead of only the generic fallback.
        setRejectionErrors((prev) => (data?.error ? { ...prev, [item.id]: data.error } : omitKey(prev, item.id)));
      }
    } catch {
      setErrorIds((prev) => withRowFlagSet(prev, item.id));
      setUnreachableActions((prev) => ({ ...prev, [item.id]: label }));
    } finally {
      setBusyIds((prev) => withRowFlagCleared(prev, item.id));
    }
  }

  // Row 291 fix: explicit acknowledge control for the error note. Previously
  // the only ways to clear a row's error were retrying that exact row (via
  // act()) or the accidental cross-row steal this fix removes. Row 311: also
  // clears the lock, matching InboxList.tsx's dismissError.
  function dismissError(itemId: string) {
    setErrorIds((prev) => withRowFlagCleared(prev, itemId));
    setUnreachableActions((prev) => omitKey(prev, itemId));
    setRejectionErrors((prev) => omitKey(prev, itemId));
  }

  // #307 review fix 1: the "Mark completed" click handler. For a flagged row,
  // requires an explicit window.confirm naming the reason before act() ever
  // runs — cancelling returns before act() is called, so no status write, no
  // follow-up close, and no busy state (act() is what sets busyIds). An
  // unflagged row (requiresCompleteConfirmation false) calls act() directly,
  // identical to the pre-fix one-click behavior.
  function handleMarkCompleted(item: InWorksItem, group: 'awaiting' | 'handled') {
    // Row 321 fix-round FIX 2: the two gates are independent (a colour-request
    // row can read as "settled" on needsLookReason while its quote's
    // pendingColorRequest is still live, and vice versa) — checked
    // independently, but fired as exactly ONE window.confirm() when BOTH
    // apply, instead of stacking two sequential native dialogs on one click.
    const needsColor = requiresColorRequestConfirmation(item);
    const needsLook = requiresCompleteConfirmation(item);
    if (needsColor && needsLook) {
      if (!window.confirm(combinedCompleteConfirmMessage(item))) return;
    } else if (needsColor) {
      if (!window.confirm(colorRequestConfirmMessage())) return;
    } else if (needsLook) {
      if (!window.confirm(completeConfirmMessage(item))) return;
    }
    act(item, group, '/api/dashboard/completed', 'remove', 'Mark completed');
  }

  function renderRow(item: InWorksItem, group: 'awaiting' | 'handled') {
    const waitMs =
      item.lastActivityAt != null ? nowMs - new Date(item.lastActivityAt).getTime() : null;
    const stale = isStale(item.lastActivityAt, followUpDays, new Date(nowMs));
    const staleDays =
      item.lastActivityAt != null
        ? Math.floor((nowMs - new Date(item.lastActivityAt).getTime()) / 86_400_000)
        : 0;
    // Row 311: mirrors InboxList.tsx's ItemRow lockedTo/lockedOut — after a
    // thrown fetch, every button OTHER than the one attempted is locked.
    const lockedTo = unreachableActions[item.id] ?? null;
    const lockedOut = (label: string) => lockedTo !== null && lockedTo !== label;

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
              {/* Row 321: so the row is visually distinct before Mark
                  completed can silently bury a still-pending colour request. */}
              {item.isColorRequest && (
                <span
                  className="text-xs font-medium px-1.5 py-0.5 rounded"
                  style={{ background: '#fce7f3', color: '#9d174d' }}
                >
                  Colour request pending
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
                {/* Row 311: mirrors InboxList.tsx's two-kind failure copy — a
                    THROWN fetch (no answer received) is not the same claim as
                    a server REJECTION (a definite answer that nothing wrote).
                    Fix-round FIX 3: a rejection's own `data.error` (e.g.
                    "Already marked followed") now renders when present — see
                    errorNoteFor above. */}
                <span>{errorNoteFor(unreachableActions[item.id], rejectionErrors[item.id])}</span>
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
                disabled={!!busyIds[item.id] || lockedOut('Followed')}
                onClick={() => act(item, group, '/api/dashboard/followed', 'awaiting', 'Followed')}
                title={lockedOut('Followed') ? `Locked until the ${lockedTo} attempt is confirmed` : 'I followed up — snooze until they reply'}
                className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
                style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
              >
                Followed
              </button>
            )}
            <button
              type="button"
              disabled={!!busyIds[item.id] || lockedOut('Mark completed')}
              onClick={() => handleMarkCompleted(item, group)}
              title={lockedOut('Mark completed') ? `Locked until the ${lockedTo} attempt is confirmed` : undefined}
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
          {/* #252 slice H: this list and the main "Open leads" queue above both
              read as "awaiting reply" at a glance — spell out who owes whom so
              they're unambiguous side by side. */}
          <p className="text-xs mb-2" style={{ color: 'var(--op-text-2)' }}>
            You’ve followed up on these — nothing to do until they write back.
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
