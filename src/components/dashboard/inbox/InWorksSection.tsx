'use client';

import { useState } from 'react';
import { parseLeadForwardDisplay } from '@/lib/dashboard/inbox/leadForward';
import { useRouter } from 'next/navigation';
import type { InWorksItem } from '@/lib/dashboard/inbox/store';
import { formatWaiting } from '@/lib/dashboard/inbox/notify';
import { isStale } from '@/lib/dashboard/inbox/lifecycle';
import { followBackingLabel } from '@/lib/dashboard/inbox/followBacking';
import { ReplyComposer, type ReplySentOutcome } from './ReplyComposer';

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
/**
 * The "I followed up" button for a row, per bucket. PURE and exported because
 * this file has no jsdom coverage (see this component's test header) — a static
 * render cannot drive a click, so the decision that click encodes is lifted out
 * where it can be pinned directly.
 *
 * The two buckets need genuinely different buttons, which is the whole reason
 * this exists:
 *   • handled  — the row has never been followed up. A plain first stamp.
 *   • awaiting — the row is ALREADY followed and has gone quiet again (every
 *     row carrying the amber "Nd quiet" / blue "Follow-up due" tags). A plain
 *     stamp here is a silent no-op: markItemFollowed refuses a second one and
 *     the route reports success anyway, so the row would never move. It has to
 *     ask for the restamp explicitly, and it has to SAY "again", because on an
 *     already-followed row a bare "Followed" claims nothing new.
 */
/**
 * Optimistically mark ONE row as just-followed: restart its quiet counter and
 * drop the follow-up-due marker the click has now answered.
 *
 * "Followed again" acts on a row already in the awaiting bucket, so
 * moveGroup(id, 'awaiting', 'awaiting') returns immediately (`if (from === to)
 * return`) and changes nothing. router.refresh() does not rescue it either:
 * this component seeds its lists with useState(awaiting) and never syncs the
 * props again, so fresh server data does not reach these rows. Without this
 * the click was invisible — the amber "45d quiet" tag still read 45d, which
 * reads as a broken button. Found by the pre-merge staff lens.
 *
 * Returns the SAME array when the id is absent, so an unrelated row's action
 * never forces a re-render (the withRowFlagCleared / omitKey convention above).
 */
export function withRowFollowedNow(
  items: InWorksItem[],
  itemId: string,
  nowIso: string,
): InWorksItem[] {
  if (!items.some((i) => i.id === itemId)) return items;
  return items.map((i) =>
    i.id === itemId ? { ...i, lastActivityAt: nowIso, needsLookReason: null } : i,
  );
}

export function followedButtonFor(group: 'awaiting' | 'handled'): {
  label: string;
  title: string;
  body?: Record<string, unknown>;
} {
  if (group === 'awaiting') {
    return {
      label: 'Followed again',
      title: 'I chased them again — restart the quiet counter',
      body: { again: true },
    };
  }
  return { label: 'Followed', title: 'I followed up — snooze until they reply' };
}

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

/** Fix round 2 (MED): what to DO with a row for each ReplySentOutcome
 *  (ReplyComposer.tsx) — pure so this decision (previously untested — the
 *  whole reason this fix round exists) is directly unit-testable without
 *  jsdom, same as this file's other pure exports.
 *  'move' — the ordinary case: the row's true bucket is now "awaiting".
 *  'flag-and-remove' — a genuine CAS refusal (real evidence the item was
 *    resolved elsewhere): the row DOES leave the section, but only once the
 *    operator has seen why and dismissed the note — never silently.
 *  'flag-and-keep' — an unknown failure (not a refusal): removing the row
 *    would hide work that may still be open, so it stays in place, flagged. */
export function replyRowAction(outcome: ReplySentOutcome): 'move' | 'flag-and-remove' | 'flag-and-keep' {
  switch (outcome) {
    case 'resolved':
      return 'move';
    case 'refused':
      return 'flag-and-remove';
    case 'error':
      return 'flag-and-keep';
  }
}

/** Fix round 2 (MED): the dismissable note's wording for the two non-'move'
 *  outcomes — deliberately worded differently (see replyRowAction's doc): a
 *  refusal is a settled fact ("already resolved"), an error is a genuine
 *  unknown ("couldn't confirm"). Pure + exported for the same no-jsdom reason
 *  as this file's other message helpers (completeConfirmMessage etc). */
export function replyOutcomeMessage(outcome: 'refused' | 'error'): string {
  return outcome === 'refused'
    ? 'Reply sent — but this item was already resolved by someone else in the meantime. Dismiss to remove it from this list.'
    : "Reply sent, but we couldn't confirm this item's status update — it may still need attention. Check it directly.";
}

/** Row 309: a local copy of InboxList.tsx's own retiresFollowUp (kept
 *  deliberately un-shared like the rest of this file's helpers). 'Mark
 *  completed' retires a pending "due today" follow-up through
 *  closeFollowUpsForResolvedItem (store.ts).
 *
 *  PR #1005 ADDED 'Followed', this file's other act() caller: markItemFollowed
 *  now closes the item's quote_sent_no_reply nag itself (see its own doc). The
 *  sentence here used to end "'Followed' never does" and went false the moment
 *  that landed. The refresh is what updates the awaiting bucket's
 *  server-rendered "N follow-ups due" count; this row's own pill is already
 *  cleared client-side by clearNeedsLookOnMove.
 *
 *  Pure and exported so this is directly unit-testable without rendering. */
export function retiresFollowUp(path: string): boolean {
  return path === '/api/dashboard/completed' || path === '/api/dashboard/followed';
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

/**
 * Whether a row is asking for something TODAY (Naldo, 2026-09-04).
 *
 * ONE test: has it been quiet longer than the threshold. Nothing else.
 *
 * It used to be an OR: quiet, or carrying a reason tag, or a pending colour
 * request. Naldo watched that land and cut it back himself, and his reasoning
 * is the rule rather than a preference, so it belongs here: "we want to give
 * them 3 days to get in contact with us, at minimum". A quote that went out
 * this morning and a customer who wrote an hour ago are BOTH working exactly
 * as intended, and putting them on the chase list said the opposite. The list
 * exists to name the people nobody has come back to, and a reason tag on a
 * fresh row is a fact about the row, not a job for today.
 *
 * WHAT THIS COSTS, stated because it is a real change and not free: a pending
 * colour request no longer holds a fresh row on screen. Row 321 added that
 * badge so a colour request could not be buried, and it is still not buried,
 * it is delayed: the row returns on day three, and the request also shows on
 * the quote page and the job page, which are where it gets actioned. Naldo was
 * told this before it shipped.
 *
 * The threshold itself is the lever, not this function. It reads
 * `dashboard.followUpDays` and is 3 today.
 */
export function needsAttentionNow(
  item: Pick<InWorksItem, 'lastActivityAt'>,
  followUpDays: number,
  nowMs: number,
): boolean {
  return isStale(item.lastActivityAt, followUpDays, new Date(nowMs));
}

/** Kept as the old name so nothing outside this file has to change. */
export const awaitingNeedsAttention = needsAttentionNow;

/** Split awaiting rows into what to show and what to park. PURE, order kept.
 *
 *  Note what is deliberately NOT a reason to show: row 502's "no call or
 *  text on record" marker. That is information about a stamp already made,
 *  not a job waiting to be done, and most stamps are manual, so treating it
 *  as an ask would park almost nothing and undo the point of this split. */
export function splitAwaitingByAttention<T extends Pick<InWorksItem, 'lastActivityAt'>>(
  items: T[],
  followUpDays: number,
  nowMs: number,
): { attention: T[]; parked: T[] } {
  const attention: T[] = [];
  const parked: T[] = [];
  for (const item of items) {
    (needsAttentionNow(item, followUpDays, nowMs) ? attention : parked).push(item);
  }
  // Nothing is ever dropped: every row lands in exactly one of the two.
  return { attention, parked };
}

export function InWorksSection({
  awaiting,
  handled,
  followUpDays,
  nowMs,
  evidenceIncomplete = false,
  followUpsDue = null,
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
  /** PR #1005 (premerge staff + customer lenses, MED, converged): the deleted
   *  "Follow-ups due today" strip carried a COUNT in its heading, and the pills
   *  that replaced it carry none — so staff lost the one-glance "how many am I
   *  behind on". This is listDueFollowUps' exact, UNCAPPED totalDue, the same
   *  number the morning digest prints, deliberately not derived by counting
   *  pills: the pills come from listInWorks' capped fetch, and a handled row
   *  whose quote also reads unanswered shows "Quote unanswered" instead by
   *  needsLookReason's priority, so a pill count would under-report for two
   *  unrelated reasons. null when the read failed — render nothing rather than
   *  a wrong or zero-looking number. */
  followUpsDue?: number | null;
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
  // Fix round 2 (MED): marks a row flagged via a reply's 'refused' outcome
  // (replyRowAction === 'flag-and-remove') — dismissError checks this to
  // decide whether dismissing the note should ALSO remove the row (a genuine
  // CAS refusal, so the row really is terminal) or just clear the note and
  // leave the row in place (every other errorIds use, including a reply's
  // 'error' outcome, where the row's true state is unknown, not resolved).
  const [refusedIds, setRefusedIds] = useState<Record<string, boolean>>({});
  const [composerFor, setComposerFor] = useState<string | null>(null);
  // #307: "Handled" starts collapsed; "Needs a look" always renders expanded
  // (there's no toggle for it). Both are views over the SAME handledItems
  // state array (split below by needsLookReason) — no separate state slice,
  // so act()/moveGroup/removeFromGroup keep working unchanged regardless of
  // which subsection a row currently renders in.
  const [handledExpanded, setHandledExpanded] = useState(false);
  // Row 502 sibling: the same expander idiom as handled, for awaiting rows
  // that carry neither tag. Collapsed by default, which is the whole ask.
  const [parkedExpanded, setParkedExpanded] = useState(false);

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
    extraBody?: Record<string, unknown>,
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
        body: JSON.stringify({ itemId: item.id, ...extraBody }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (data?.ok) {
        if (outcome === group) {
          // Same-bucket action (the awaiting row's "Followed again"): moveGroup
          // is a no-op here, so update the row in place or the click shows
          // nothing. See withRowFollowedNow.
          const nowIso = new Date().toISOString();
          if (group === 'awaiting') setAwaitingItems((prev) => withRowFollowedNow(prev, item.id, nowIso));
          else setHandledItems((prev) => withRowFollowedNow(prev, item.id, nowIso));
        } else if (outcome === 'remove') {
          removeFromGroup(item.id, group);
        } else {
          moveGroup(item.id, group, outcome);
        }
        // Row 309: this row's own optimistic transition above already keeps
        // THIS section correct — router.refresh() exists to reach the rest of
        // the page. PR #1005: the sibling that used to need it was the
        // FollowUpStrip (now deleted); today it is this section's own
        // server-rendered "N follow-ups due" count. See retiresFollowUp's doc
        // comment for which actions are scoped in.
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
  function dismissError(itemId: string, group?: 'awaiting' | 'handled') {
    // Fix round 2 (MED): capture BEFORE clearing — a row flagged
    // 'flag-and-remove' (a reply's genuine CAS refusal) never got removed at
    // send-time; it waits for the operator to see the note and dismiss it,
    // which is when the delayed removal actually happens. Every other
    // dismissError caller (a thrown/rejected act() call, or a reply's
    // 'error' outcome) never sets refusedIds, so this is a no-op for them —
    // the row just stays put with its note cleared, exactly as before.
    const shouldRemove = !!refusedIds[itemId];
    setErrorIds((prev) => withRowFlagCleared(prev, itemId));
    setUnreachableActions((prev) => omitKey(prev, itemId));
    setRejectionErrors((prev) => omitKey(prev, itemId));
    setRefusedIds((prev) => omitKey(prev, itemId));
    if (shouldRemove && group) removeFromGroup(itemId, group);
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
              {/* Row 502: says what is true of the RECORD, never what the
                  staffer did. A call from a personal phone looks identical from
                  here, so this must never read as an accusation. Shown only for
                  a stamp explicitly recorded as manual: a row stamped before the
                  column existed carries null and stays silent, because claiming
                  it was unbacked would invent a fact. */}
              {followBackingLabel(item.followedVia) && (
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--op-bg)', color: 'var(--op-text-2)' }}
                  title="The follow-up was marked by hand. Nothing in the system records a call or a message, which is also what a call from a personal phone looks like."
                >
                  {followBackingLabel(item.followedVia)}
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
                  onClick={() => dismissError(item.id, group)}
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
              // #268 fix round's documented follow-up, done 2026-09-02.
              // InboxList shows a "call or text them directly" affordance for
              // a forwarded lead, driven by parseLeadForwardDisplay(subject,
              // preview) -- deliberately MESSAGE-level, not contact-level
              // (round 2's contact.phone gate was a false-positive HIGH:
              // dashboard_contacts.primary_phone is a cross-channel MERGED
              // field, so a returning customer's ordinary reply could carry a
              // phone from an earlier quote). This section could not do the
              // same because IN_WORKS_SELECT never selected `subject`, which
              // the parser needs alongside `preview`; it does now.
              //
              // It matters more here than it looks: an outbound touch can
              // auto-clear a forwarded lead into this very section, so this is
              // where staff meet the row after the system moved it, and
              // "Reply in Gmail" is the one instruction guaranteed to reach
              // nobody -- the thread's addressable party is the platform's
              // no-reply relay.
              (() => {
                const forwarded = parseLeadForwardDisplay(item.subject, item.preview);
                if (!forwarded) {
                  return (
                    <span className="px-3 py-1.5 text-sm" style={{ color: 'var(--op-text-2)' }}>
                      Reply in Gmail
                    </span>
                  );
                }
                return (
                  <span
                    className="px-3 py-1.5 text-sm text-right max-w-[220px]"
                    style={{ color: 'var(--op-text-2)' }}
                  >
                    Forwarded lead — call or text the customer directly:{' '}
                    {forwarded.phone && <span style={{ color: 'var(--op-text)' }}>{forwarded.phone}</span>}
                    {forwarded.phone && forwarded.email ? ' · ' : null}
                    {forwarded.email && <span style={{ color: 'var(--op-text)' }}>{forwarded.email}</span>}
                  </span>
                );
              })()
            ) : (
              // Fix round 2 delta-verify LOW (decided, not fixed): after an
              // 'error' outcome (onSent below) this button stays live and
              // un-disabled — the operator CAN reopen the composer and send a
              // second message before the first send's status write is
              // confirmed. Left live on purpose rather than adding a
              // dedicated per-row lock: (1) the note's own copy leads with
              // "Reply sent" — a careful reader has no reason to read this as
              // "try again"; (2) the server's REPLY_CLAIM_WINDOW_MS 20s claim
              // guard (reply/route.ts) already blocks a genuine rapid
              // double-click regardless of this button's disabled state; (3)
              // reopening always mounts a FRESH, blank composer (composerFor
              // toggling to null unmounts it) — there is no pre-filled
              // duplicate text one click away, only real re-typing/re-AI-draft
              // friction; (4) the residual — an inattentive operator
              // deliberately re-sending after >20s — costs the customer one
              // extra text, not money or data corruption, and a dedicated
              // lock flag would add real machinery (a new per-row map, wiring
              // in two files) for a narrow, already-mitigated risk.
              <button
                type="button"
                onClick={() => setComposerFor(composerFor === item.id ? null : item.id)}
                className="px-3 py-1.5 rounded-md text-sm"
                style={{ border: '1px solid var(--op-border)', color: 'var(--op-text)' }}
              >
                {composerFor === item.id ? 'Cancel' : 'Reply'}
              </button>
            )}
            {/* Naldo 2026-09-02: this used to render for the 'handled' group
                only, so every row in "Awaiting their reply" — the ones carrying
                the amber "Nd quiet" and blue "Follow-up due" tags — offered no
                way to say "I chased them again". A staffer who rang somebody had
                to either reply by text or mark the whole conversation completed.

                The awaiting row is ALREADY followed, so a plain click is a no-op
                (the store refuses a second stamp and the route reports success),
                which is why it passes `again` — the explicit restamp opt-in. The
                label says "again" for the same reason: on a row that is already
                followed, a bare "Followed" claims nothing new. */}
            {(() => {
              const fb = followedButtonFor(group);
              return (
                <button
                  type="button"
                  disabled={!!busyIds[item.id] || lockedOut(fb.label)}
                  onClick={() =>
                    act(item, group, '/api/dashboard/followed', 'awaiting', fb.label, fb.body)
                  }
                  title={
                    lockedOut(fb.label)
                      ? `Locked until the ${lockedTo} attempt is confirmed`
                      : fb.title
                  }
                  className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
                  style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
                >
                  {fb.label}
                </button>
              );
            })()}
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
            onSent={(outcome) => {
              setComposerFor(null);
              if (outcome === 'resolved') {
                // A sent reply stamps the item handled + followed (snoozed awaiting
                // their reply) — its true group is always "awaiting" afterward. On an
                // already-awaiting row this is a no-op (it must NOT disappear); on a
                // handled row it moves there instead of vanishing.
                moveGroup(item.id, group, 'awaiting');
                return;
              }
              // Fix round 2 (MED): the message went out and can't be unsent either
              // way, but 'refused' (a genuine CAS refusal — real evidence the item
              // was resolved elsewhere) and 'error' (an unknown failure) get
              // different treatment — see replyRowAction's own doc. Neither
              // silently disappears the row: both use this section's existing
              // error/dismiss idiom (errorIds/rejectionErrors + the Dismiss
              // button) so the operator sees WHY, instead of the row just
              // vanishing (or, for 'error', staying invisible as still-open work).
              setErrorIds((prev) => withRowFlagSet(prev, item.id));
              setRejectionErrors((prev) => ({ ...prev, [item.id]: replyOutcomeMessage(outcome) }));
              if (replyRowAction(outcome) === 'flag-and-remove') {
                // 'refused' only: the row DOES leave the section, but only once
                // the operator dismisses the note (dismissError's shouldRemove
                // branch) — never synchronously/silently here.
                setRefusedIds((prev) => withRowFlagSet(prev, item.id));
              }
            }}
          />
        )}
      </li>
    );
  }

  // #307: a rendering-only split of the SAME handledItems state array (see
  // that state's own comment above) — no third bucket/state slice exists.
  // Row 502 sibling: the awaiting list gets the same treatment the handled
  // list has had since #307 — only rows asking for something render, the
  // rest sit behind a count. A rendering-only split of the SAME state array.
  const { attention: awaitingAttention, parked: awaitingParked } = splitAwaitingByAttention(
    awaitingItems,
    followUpDays,
    nowMs,
  );
  // Naldo 2026-09-04: the same three-day gate applies here. "Quote unanswered"
  // and "They wrote last" are the two reasons he named, and they render on this
  // list as well as the awaiting one, so gating only one of them would leave
  // the page half-changed and still full. A flagged row handled this morning
  // waits its three days in the collapsed group below, keeping its badge, and
  // comes back on day three.
  const needsLookItems = handledItems.filter(
    (item) => item.needsLookReason != null && needsAttentionNow(item, followUpDays, nowMs),
  );
  // Everything else handled: never flagged, or flagged and not yet due. Both
  // mean "nothing to do today", which is what this collapsed group is for.
  const settledHandledItems = handledItems.filter(
    (item) => item.needsLookReason == null || !needsAttentionNow(item, followUpDays, nowMs),
  );

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
            {/* Row 502 sibling follow-up: this counted EVERY awaiting row while
                the list below renders only the ones wanting a chase, so the
                heading read 71 above about 50 rows. A count has to describe
                what is on screen; the parked rows carry their own count on
                the expander below. */}
            Awaiting their reply ({awaitingAttention.length})
            {typeof followUpsDue === 'number' && followUpsDue > 0 && (
              <span style={{ color: 'var(--op-text-2)' }}>
                {' · '}
                {/* PR #1005: "across the inbox" is load-bearing. This is the
                    inbox-wide due total, so it can legitimately exceed the
                    pills visible in THIS bucket — live today it reads 33
                    beside 31 pills, because the other two due items sit in
                    "Needs a look" below, where a handled row's sharper "Quote
                    unanswered" reason wins by needsLookReason's priority. */}
                {followUpsDue} follow-up{followUpsDue === 1 ? '' : 's'} due across the inbox
              </span>
            )}
          </p>
          {/* #252 slice H: this list and the main "Open leads" queue above both
              read as "awaiting reply" at a glance — spell out who owes whom so
              they're unambiguous side by side. */}
          {/* PR #1005: the qualifier is load-bearing now that the deleted
              "Follow-ups due today" strip's signal lives on these rows as a
              "Follow-up due" pill — a flat "nothing to do" would contradict a
              pill sitting two lines below it. */}
          {/* Row 502 sibling: this sentence described a list that showed
              EVERY followed row. It now shows only the rows carrying a tag, so
              the old wording ("nothing to do until they write back") would be
              exactly backwards about what is on screen. A guard and the copy
              that narrates it are one change. */}
          {/* Both are suppressed when nothing needs a chase, or the screen
              says "these have gone quiet" above an empty list. Found while
              writing the explainer: the heading-count fix turned that state
              from invisible into reachable. */}
          {awaitingAttention.length > 0 ? (
            <>
              <p className="text-xs mb-2" style={{ color: 'var(--op-text-2)' }}>
                Nobody has come back to these in {followUpDays} days, so they want a chase. The
                rest are not due yet and come back on their own.
              </p>
              <ul className="space-y-2">
                {awaitingAttention.map((item) => renderRow(item, 'awaiting'))}
              </ul>
            </>
          ) : (
            <p className="text-xs mb-2" style={{ color: 'var(--op-text-2)' }}>
              Nobody here needs chasing today.
            </p>
          )}
          {awaitingParked.length > 0 && (
            <div className="mt-3">
              {/* Same expander idiom as "Show Handled" below, deliberately: one
                  learned control, not two. Nothing is hidden permanently and
                  the count is always visible, so the page can be quiet without
                  the parked rows becoming unreachable. */}
              <button
                type="button"
                onClick={() => setParkedExpanded((v) => !v)}
                className="text-xs font-medium underline"
                style={{ color: 'var(--op-text-2)' }}
              >
                {parkedExpanded
                  ? `Hide ${awaitingParked.length} not due yet`
                  : `Show ${awaitingParked.length} not due yet`}
              </button>
              {parkedExpanded && (
                <ul className="space-y-2 mt-2">
                  {awaitingParked.map((item) => renderRow(item, 'awaiting'))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* #307 review fix 2: rendered independent of needsLookItems.length —
          on a lookup failure the "Needs a look" heading below may not render
          at all (empty list), which is exactly the silent-undercount this
          note exists to surface. Non-alarming, plain: it does not claim any
          specific row is missing, only that the check may be incomplete. */}
      {evidenceIncomplete && (
        <p className="text-xs mb-2" style={{ color: '#92400e' }}>
          Some evidence checks didn’t finish — Needs a look and “Follow-up due” may be missing rows.
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
