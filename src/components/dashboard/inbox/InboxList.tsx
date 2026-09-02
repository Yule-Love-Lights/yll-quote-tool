'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import type { OpenInboxItem } from '@/lib/dashboard/inbox/types';
import { parseLeadForwardDisplay } from '@/lib/dashboard/inbox/leadForward';
import { formatWaiting } from '@/lib/dashboard/inbox/notify';
import { claimState } from '@/lib/dashboard/inbox/assignment';
import { buildInboxSummary } from '@/lib/dashboard/inbox/summary';
import { groupInboxItems, type InboxGroup } from '@/lib/dashboard/inbox/groupInboxItems';
import { highLevelContactUrl } from '@/lib/highLevelLinks';
import { InboxSummaryStrip } from './InboxSummaryStrip';
import { ReplyComposer, type ReplySentOutcome } from './ReplyComposer';

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

/**
 * The two ways into a customer's history from an inbox row: the quote tool's
 * own profile page (quotes, jobs, invoices, activity, call notes) and the
 * HighLevel record itself.
 *
 * Rendered as its own line rather than by turning the name into a link,
 * because the grouped-contact header is a <button> (the expand toggle) and an
 * anchor cannot legally nest inside one.
 *
 * Renders nothing at all when the contact was never linked to HighLevel:
 * /customers/[contactId] is addressed BY the HighLevel id, so without one
 * there is no profile to point at and a link would be a dead end. The
 * HighLevel link additionally needs a configured location id, and is simply
 * left out when this environment has none.
 */
/**
 * Just the HighLevel link, for a row whose customer NAME is already the
 * profile link (the per-conversation row). Renders nothing without a
 * HighLevel id or a configured location id.
 */
function HighLevelOnlyLink({
  ghlContactId,
  hlLocationId,
}: {
  ghlContactId: string | null | undefined;
  hlLocationId: string | null;
}) {
  if (!ghlContactId || !hlLocationId) return null;
  return (
    <a
      href={highLevelContactUrl(hlLocationId, ghlContactId)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs underline"
      style={{ color: 'var(--op-text-2)' }}
    >
      HighLevel
    </a>
  );
}

function CustomerLinks({
  ghlContactId,
  hlLocationId,
}: {
  ghlContactId: string | null | undefined;
  hlLocationId: string | null;
}) {
  if (!ghlContactId) return null;
  return (
    <span className="flex items-center gap-2">
      <Link
        href={`/customers/${encodeURIComponent(ghlContactId)}`}
        className="text-xs font-medium underline"
        style={{ color: 'var(--op-primary)' }}
      >
        Customer
      </Link>
      {hlLocationId ? (
        <a
          href={highLevelContactUrl(hlLocationId, ghlContactId)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline"
          style={{ color: 'var(--op-text-2)' }}
        >
          HighLevel
        </a>
      ) : null}
    </span>
  );
}

// Props threaded down to every per-conversation row, whether it's rendered
// bare (single-conversation contact) or nested inside an expanded ContactRow
// (#252 slice D). Bundled into one object so InboxList/ContactRow don't have
// to repeat the same nine-prop list at every call site.
type RowActions = {
  now: number;
  /** The configured HighLevel location id, handed down from the server
   *  (src/app/inbox/page.tsx) because building a CRM URL needs it and this
   *  is a client component. null when unconfigured, and the HighLevel link
   *  is then left out while the quote tool profile link still works. */
  hlLocationId: string | null;
  // Row 291 fix: busyId/errorId were single global slots (`string | null`) —
  // acting on row B stole row A's busy pin and, worse, silently cleared row
  // A's error note (act() unconditionally called setErrorId(null)) even
  // though row A's underlying failure was untouched on the server. Both are
  // now per-item records keyed by item id, so each row's busy/error state is
  // independent of every other row's.
  busyIds: Record<string, boolean>;
  // #224 delta-verify fix (staff + customer lenses converged): the response
  // read act() now does can fail (a status-guard block, or any other non-2xx)
  // — errorIds surfaces that visibly, mirroring InWorksSection.tsx's
  // identical pattern for this same /api/dashboard/* route family.
  errorIds: Record<string, boolean>;
  /** #302: for an error from a THROWN fetch (no answer received, unlike a
   *  server rejection), the LABEL of the action that was attempted — e.g.
   *  'Handled'. Drives both the wording and the lock below. */
  unreachableActions: Record<string, string>;
  /** Row 311 fix-round FIX 3: for a definite server REJECTION (a real answer,
   *  never a throw), the route's own `data.error` text — e.g. "Already marked
   *  followed". Before this, act() read `data?.ok` but discarded the rest of
   *  the body, so the specific reason (a guard refusal vs. a generic failure)
   *  never reached the operator. See errorNoteFor's own doc comment below for
   *  how this and unreachableActions combine into one note. */
  rejectionErrors: Record<string, string>;
  // Row 291 fix: explicit acknowledge control for a persistent error note —
  // previously the ONLY ways to clear one were retrying that exact row or
  // the accidental cross-row steal above.
  dismissError: (id: string) => void;
  // Row 305: was a single global slot (`string | null`, keyed by contactId) —
  // claiming contact A (in flight), then claiming contact B before A settled,
  // re-enabled A's claim/release control mid-flight (the slot now held B's
  // id) and a second concurrent POST to /api/dashboard/claim for A was only
  // one more click away. Same shape as row 291's busyIds/errorIds fix, now
  // applied to this file's other single-slot holdout — per-contact record,
  // read/written with this file's own withRowFlagSet/withRowFlagCleared.
  claimBusyIds: Record<string, boolean>;
  composerFor: string | null;
  currentOperatorId: string | null;
  act: (id: string, path: string, label: string) => void;
  claim: (contactId: string, action: 'claim' | 'release') => void;
  toggleComposer: (id: string) => void;
  onComposerSent: (id: string, outcome: ReplySentOutcome) => void;
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
  const { now, busyIds, errorIds, unreachableActions, rejectionErrors, dismissError, claimBusyIds, composerFor, currentOperatorId, act, claim, toggleComposer, onComposerSent, hlLocationId } = actions;
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
  // #302 review (customer lens HIGH-value find): after a THROWN fetch the write
  // may already have committed server-side, so the row's true status is unknown.
  // Every other action stays enabled at that moment, and picking a DIFFERENT one
  // is not harmless: dismissItem's guard is `.neq('status','dismissed')`, so on a
  // row that is really already 'handled' it passes, flips a genuinely answered
  // lead to dismissed, and calls addSuppressedSenders — the customer's future
  // messages get auto-filtered out of the default view. Lock the row to the one
  // action actually attempted until it is retried or dismissed.
  const lockedTo = unreachableActions[item.id] ?? null;
  const lockedOut = (label: string) => lockedTo !== null && lockedTo !== label;
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
            {/* The name itself is the link here, matching the Office Tasks row.
                Only the grouped header below has to keep a separate
                "Customer" link, because there the name lives inside the
                expand <button> and an anchor cannot nest in one. */}
            {item.ghlContactId ? (
              <Link
                href={`/customers/${encodeURIComponent(item.ghlContactId)}`}
                className="font-medium truncate underline"
                style={{ color: 'var(--op-text)' }}
              >
                {contactName(item)}
              </Link>
            ) : (
              <span className="font-medium truncate" style={{ color: 'var(--op-text)' }}>
                {contactName(item)}
              </span>
            )}
            <HighLevelOnlyLink ghlContactId={item.ghlContactId} hlLocationId={hlLocationId} />
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
            {/* Row 321: so the row is visually distinct before Handled/Mark
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
                    disabled={!!claimBusyIds[cid]}
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
                    disabled={!!claimBusyIds[cid]}
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
                  disabled={!!claimBusyIds[cid]}
                  onClick={() => claim(cid, 'claim')}
                  className="underline disabled:opacity-50"
                  style={{ color: 'var(--brand-evergreen-3)' }}
                >
                  Claim
                </button>
              )}
            </p>
          )}
          {errorIds[item.id] && (
            <p className="text-xs mt-1 flex items-center gap-2" style={{ color: '#dc2626' }}>
              {/* #302 review (three lenses converged): a THROWN fetch and a
                  server REJECTION are not the same claim, and saying "went
                  wrong" for both overstates the first. A throw means we never
                  got an answer — the write may well have landed and only the
                  reply been lost — so the copy says exactly that, and stops
                  short of inviting the confident retry the rejection copy
                  does. (`followed` is the one action whose retry is not
                  idempotent — it re-stamps followed_up_at and resets the
                  customer's waiting clock — which is why this wording
                  matters rather than being cosmetic.) */}
              {/* Row 311 fix-round FIX 3: a rejection's own `data.error` (e.g.
                  "Already marked followed") is more specific than the generic
                  fallback and now renders when present — see errorNoteFor. */}
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
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={!!busyIds[item.id] || lockedOut('Handled')}
            onClick={() => {
              // Row 321: does NOT hard-block — the operator may legitimately
              // have handled this by phone.
              if (item.isColorRequest && !window.confirm(colorRequestConfirmMessage())) return;
              act(item.id, '/api/dashboard/handled', 'Handled');
            }}
            title={lockedOut('Handled') ? `Locked until the ${lockedTo} attempt is confirmed` : 'Closed as answered'}
            className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
          >
            Handled
          </button>
          <button
            type="button"
            disabled={!!busyIds[item.id] || lockedOut('Not a lead')}
            onClick={() => act(item.id, '/api/dashboard/dismiss', 'Not a lead')}
            title={lockedOut('Not a lead') ? `Locked until the ${lockedTo} attempt is confirmed` : 'Permanently hidden as spam'}
            className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
            style={{ color: 'var(--op-text-2)' }}
          >
            Not a lead
          </button>
          <button
            type="button"
            disabled={!!busyIds[item.id] || lockedOut('Followed')}
            onClick={() => act(item.id, '/api/dashboard/followed', 'Followed')}
            title={lockedOut('Followed') ? `Locked until the ${lockedTo} attempt is confirmed` : 'I followed up: snoozed until they reply'}
            className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
            style={{ border: '1px solid var(--op-border)', color: 'var(--op-text-2)' }}
          >
            Followed
          </button>
          <button
            type="button"
            disabled={!!busyIds[item.id] || lockedOut('Mark completed')}
            onClick={() => {
              if (item.isColorRequest && !window.confirm(colorRequestConfirmMessage())) return;
              act(item.id, '/api/dashboard/completed', 'Mark completed');
            }}
            title={lockedOut('Mark completed') ? `Locked until the ${lockedTo} attempt is confirmed` : 'Closed as done'}
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
            // Fix round 2 delta-verify LOW (decided, not fixed — same
            // reasoning as InWorksSection.tsx's identical button, kept
            // deliberately un-shared like this file's other duplicated
            // helpers): stays live and un-disabled after an 'error' outcome,
            // on purpose. See InWorksSection.tsx's Reply button doc comment
            // for the full reasoning (the note's own "Reply sent" copy, the
            // server's 20s claim guard, a fresh blank composer on reopen, and
            // the residual being a low-cost duplicate text rather than money
            // or data corruption).
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
          onSent={(outcome) => onComposerSent(item.id, outcome)}
        />
      )}
    </li>
  );
}

// Shared by isGroupExpanded and canToggleGroup below for the composerFor
// pin: does `id` name one of this group's CURRENT members?
function memberMatches(group: InboxGroup, id: string | null): boolean {
  return id !== null && group.members.some((m) => m.id === id);
}

// Row 291 fix: errorId used to be a single id, tested with memberMatches
// above. Now that errors are per-item (errorIds, keyed by item id), the
// group-pin question is "does ANY current member of this group have an
// error", not "does one specific id match" — this is the errorIds
// equivalent of memberMatches.
function groupHasError(group: InboxGroup, errorIds: Record<string, boolean>): boolean {
  return group.members.some((m) => !!errorIds[m.id]);
}

// Row 291 fix: pure read/write helpers over the per-item busyIds/errorIds
// maps, used by both act() and dismissError below. Pulled out (mirroring
// isGroupExpanded/canToggleGroup's own pure-and-exported pattern in this
// file) so the "one row's transition can never touch another row's key"
// invariant — the actual bug — is directly unit-testable without jsdom or a
// mocked fetch. withRowFlagCleared fully removes the key rather than setting
// it false, so a dismissed/resolved row is indistinguishable from one that
// was never touched, and a no-op clear returns the SAME object reference
// (skips an unnecessary state update when there's nothing to clear).
export function withRowFlagSet(map: Record<string, boolean>, id: string): Record<string, boolean> {
  return { ...map, [id]: true };
}

export function withRowFlagCleared(map: Record<string, boolean>, id: string): Record<string, boolean> {
  if (!map[id]) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** #302: withRowFlagCleared's sibling for the string-valued unreachableActions
 *  map (it records WHICH action was attempted, not merely that one was). Same
 *  contract: returns the SAME reference when the key is absent, so clearing on
 *  an unaffected row never forces a needless re-render. */
export function omitKey<T>(map: Record<string, T>, id: string): Record<string, T> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** Row 311 fix-round FIX 3: picks the error note's text. A thrown fetch (no
 *  answer received) takes priority — its copy is unchanged by this fix, and
 *  it's the more consequential case (drives the row's action lock above). A
 *  definite server rejection's own `data.error` is more specific than the
 *  generic fallback (e.g. "Already marked followed" vs. "Something went
 *  wrong") and now renders when the route provided one; the generic copy only
 *  shows for a rejection that carried no error text. Pure and exported so
 *  this is directly unit-testable without rendering, mirroring this file's
 *  other exported pure helpers. */
export function errorNoteFor(unreachableAction: string | undefined, rejectionError: string | undefined): string {
  if (unreachableAction) {
    return `Couldn't reach the server — this may or may not have gone through. Click ${unreachableAction} again to confirm.`;
  }
  return rejectionError || 'Something went wrong — try again.';
}

/** Row 392: a 409 is act()'s signal that a write's own compare-and-swap guard
 *  refused it — the row's status genuinely moved out from under the
 *  optimistic removal (e.g. dismiss/route.ts: "refused means the CAS matched
 *  zero rows"), not a transient backend failure. Only this case needs act()
 *  to restore + refusedIds the row instead of letting refresh() silently drop
 *  it: on any OTHER failure (503, a throw) the item's server-side state is
 *  unchanged, so the existing refresh()/restore paths already bring it back
 *  correctly. Pure and exported, mirroring this file's other small named
 *  gates (retiresFollowUp above). */
export function isRefusalStatus(status: number): boolean {
  return status === 409;
}

/** Fix round 3 (MED — this file was the THIRD, unaudited ReplyComposer
 *  consumer left on the old flatten-everything-into-remove `onComposerSent`;
 *  InWorksSection.tsx and the reply route were fixed in earlier rounds, this
 *  one was missed): a local copy of InWorksSection.tsx's own replyRowAction
 *  (kept deliberately un-shared, same as this file's other duplicated
 *  helpers — see withRowFlagSet's own doc comment above). This file's open
 *  queue has no second bucket to move a row INTO (unlike InWorksSection's
 *  awaiting/handled split) — 'move' here means "leaves the open queue
 *  immediately, no note", since 'resolved' and a genuine 'refused' both mean
 *  the item is no longer 'unresponded' either way. 'error' still means the
 *  write's outcome is UNCONFIRMED — most likely the item is still genuinely
 *  'unresponded' (the write never landed) — so removing it would hide an
 *  open lead from the PRIMARY place staff look for one; it stays, flagged. */
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

/** Fix round 3: a local copy of InWorksSection.tsx's own replyOutcomeMessage
 *  (same un-shared convention). Identical wording on purpose — same
 *  real-world event, same operator-facing claim, regardless of which list
 *  the row happened to be sitting in when it fired. */
export function replyOutcomeMessage(outcome: 'refused' | 'error'): string {
  return outcome === 'refused'
    ? 'Reply sent — but this item was already resolved by someone else in the meantime. Dismiss to remove it from this list.'
    : "Reply sent, but we couldn't confirm this item's status update — it may still need attention. Check it directly.";
}

/** Row 321: the Handled/Mark-completed confirm for a `:color-request` item
 *  (item.isColorRequest — see OpenInboxItem's own doc). Mirrors
 *  InWorksSection.tsx's completeConfirmMessage precedent (a local, pure,
 *  exported message so the wording is directly unit-testable), kept
 *  deliberately un-shared like this file's other duplicated helpers (see
 *  omitKey's own doc above). Does NOT hard-block — the operator may
 *  legitimately have already handled this by phone; it just names what's
 *  outstanding before either button proceeds.
 *
 *  Row 321 fix-round FIX 3 (staff LOW): named "(Colour request panel)" —
 *  ColorRequestPanel.tsx has no such label anywhere; its real on-page heading
 *  is "Colour change requested" (pre-apply) / "Colour change applied"
 *  (post-apply). Fixed to name what staff will actually see. */
export function colorRequestConfirmMessage(): string {
  return "This customer is waiting on a colour change — mark it handled anyway?\n\nThe requested colour is still pending on the quote. Review or apply it from the quote's admin page (the \"Colour change requested\" section) first, or Cancel and do that now.";
}

/** Row 309: 'Not a lead' (dismiss) and 'Mark completed' retire a pending
 *  "due today" follow-up via closeFollowUpsForResolvedItem (store.ts), which
 *  dismissItem and markItemCompleted call and markItemHandled does not.
 *  router.refresh() re-renders the whole InboxPage server component (every one
 *  of its sub-fetches), so gating it to the actions that actually move a
 *  follow-up — rather than firing after every successful act() — keeps a
 *  Handled click from paying that cost for a nag it cannot have touched.
 *
 *  PR #1005 ADDED 'Followed': markItemFollowed now closes the item's
 *  quote_sent_no_reply nag itself (see its own doc for why "I followed up"
 *  answers that nag). This sentence used to read "never from markItemHandled
 *  or markItemFollowed" and went false the moment that landed. The refresh
 *  matters because the awaiting bucket's "N follow-ups due" count is rendered
 *  server-side from listDueFollowUps' exact total.
 *
 *  Pure and exported so this is directly unit-testable without rendering. */
export function retiresFollowUp(path: string): boolean {
  return (
    path === '/api/dashboard/dismiss' ||
    path === '/api/dashboard/completed' ||
    path === '/api/dashboard/followed'
  );
}

// #302 fix: pure helper mirroring withRowFlagSet/withRowFlagCleared's own
// pattern above — restores a row act() optimistically removed from `items`,
// used by act()'s catch (a thrown fetch: network down, DNS failure, a
// dropped connection) below. `removedItem` is the row's own pre-removal
// snapshot, captured before the optimistic filter ran; `undefined` (nothing
// was captured, e.g. the id was already absent) is a no-op. Guards against
// duplicating the row if a concurrent refresh() (the 25s poll) already
// brought it back — or replaced it with a fresher copy — in the window
// before the throw resolves: an id already present in `items` always wins
// over the stale pre-removal snapshot.
export function withItemRestored<T extends { id: string }>(
  items: T[],
  id: string,
  removedItem: T | undefined,
): T[] {
  if (!removedItem) return items;
  if (items.some((i) => i.id === id)) return items;
  return [...items, removedItem];
}

// #270 fix (staff HIGH — see the finding this comment is attached to): a
// group whose members include the item currently being composed to must
// never render collapsed, or the operator's live ReplyComposer gets hidden
// behind a collapsed header the instant a poll adds a sibling conversation.
//
// #289 fix round 2 (HIGH, delta-verify on round 1's own MED fix — three
// review lenses independently converged on this): round 1 taught
// canToggleGroup (below) to BLOCK collapsing while errorId names a member,
// but never taught this function to FORCE the group open — so a group that
// was already collapsed when its busy member's action failed (operator
// collapses while busy, since busyId pins nothing — see canToggleGroup's
// doc comment for why; action then fails; errorId is set and refresh()
// restores the member) stayed collapsed with its "Something went wrong —
// try again." note unrendered, AND its header was now DISABLED by
// canToggleGroup's own errorId guard — no render path showed the error, and
// the one control that could have re-opened it was locked. Same failure
// mode reaches a group that turns multi for the very FIRST time while a
// member is already errored (e.g. a poll adds a sibling under an error
// note): expandedMap has no entry for a group key it's never seen, which
// defaults to collapsed. errorId now forces this open exactly like
// composerFor, closing both paths — see canToggleGroup's doc comment for
// why that also makes ITS errorId-driven disable safe rather than a
// lockout. Pure and exported so this decision is unit-testable without
// rendering.
//
// Row 291 fix: errorId was a single global slot (string | null) — this
// function now takes errorIds, a per-item record, and asks "does any CURRENT
// member of this group have an error" (groupHasError) rather than "does one
// specific id match" (memberMatches). See canToggleGroup's doc comment below
// for what that single-slot shape used to break.
export function isGroupExpanded(
  group: InboxGroup,
  expandedMap: Record<string, boolean>,
  composerFor: string | null,
  errorIds: Record<string, boolean>,
): boolean {
  if (memberMatches(group, composerFor) || groupHasError(group, errorIds)) return true;
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
// #289 fix, corrected in round 2 (staff MED, cross-wave #769x#776
// composition): composerFor was the only pin here, predating #776's
// errorId/busyId state on this same list. Round 1 ALSO gated on busyId —
// REVERTED: act() (below, in InboxList) calls setBusyId(id) and
// optimistically filters that same id out of `items` in the same
// synchronous batch (React's automatic batching — both setState calls
// apply in one render), and `groups` is derived fresh from `items` on every
// render, so a member whose id equals the CURRENT busyId can never actually
// be present in that render's group.members — a busyId check here was
// provably always false in every reachable render (traced and confirmed by
// three independent review lenses). The busy window needs no pin: the busy
// item is already absent from what's rendered, so there's nothing there to
// hide. errorId is the real signal — on failure, refresh() restores the
// item WITH errorId set, and collapsing the group at that point would hide
// its error note. Keeping errorId's pin here is safe BECAUSE isGroupExpanded
// (see its own doc comment) forces this same group open whenever errorId
// names a member — this disable can therefore only ever block a collapse
// that would re-hide a group already guaranteed to render expanded; it can
// no longer strand the group collapsed-with-no-way-out the way round 1 did.
//
// Row 291 fix (was a known limitation, pre-existing #224-family behavior):
// errorId used to be a single global slot on InboxList, not per-item — any
// unrelated act() call elsewhere in the inbox cleared it (and with it, this
// note), regardless of whether THIS group's error was ever seen or resolved.
// errorIds is now a per-item record, so act() on one row only ever touches
// that row's own entry — see act()'s own doc comment in the InboxList
// component below. An operator can also explicitly clear a persistent error
// via the new Dismiss control on the row (dismissError), rather than only by
// retrying that exact row or via the old accidental cross-row steal.
export function canToggleGroup(group: InboxGroup, composerFor: string | null, errorIds: Record<string, boolean>): boolean {
  return !(memberMatches(group, composerFor) || groupHasError(group, errorIds));
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
  const canToggle = canToggleGroup(group, actions.composerFor, actions.errorIds);

  const rowChildren: ReactNode[] = [];
  if (isMulti) {
    rowChildren.push(
      <button
        key="header"
        type="button"
        disabled={!canToggle}
        title={canToggle ? undefined : 'Resolve the open reply or the failed action on a member here before collapsing this group'}
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
    // Outside the button on purpose: an anchor cannot nest inside one, and
    // the whole group header IS the expand toggle.
    rowChildren.push(
      <div key="customer-links" className="mt-1">
        <CustomerLinks ghlContactId={group.primary.ghlContactId} hlLocationId={actions.hlLocationId} />
      </div>,
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
  hlLocationId = null,
}: {
  initialItems: OpenInboxItem[];
  nowMs: number;
  currentOperatorId?: string | null;
  /** The configured HighLevel location id, read on the server and handed
   *  down. Defaults to null so existing render sites and fixtures that do
   *  not pass it simply render no HighLevel link. */
  hlLocationId?: string | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState<OpenInboxItem[]>(initialItems);
  // Row 291 fix: busyId/errorId were single global slots (string | null) —
  // acting on one row stole another row's busy pin, and worse, silently
  // cleared another row's error note even though its underlying failure was
  // untouched server-side. Both are now per-item records keyed by item id.
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});
  // #224 delta-verify fix (staff + customer lenses converged): act() used to
  // never read the response at all — see act()'s own doc comment below.
  const [errorIds, setErrorIds] = useState<Record<string, boolean>>({});
  // #302: parallel to errorIds and always cleared with it — see the note copy.
  const [unreachableActions, setUnreachableActions] = useState<Record<string, string>>({});
  // Row 311 fix-round FIX 3: parallel to errorIds/unreachableActions, always
  // cleared alongside them — see errorNoteFor's own doc comment above.
  const [rejectionErrors, setRejectionErrors] = useState<Record<string, string>>({});
  // Fix round 3 (MED): marks a row flagged via a reply's 'refused' outcome
  // (replyRowAction === 'flag-and-remove') — dismissError checks this to
  // decide whether dismissing the note should ALSO remove the row from the
  // open queue (a genuine CAS refusal, the row really is no longer
  // 'unresponded') or just clear the note and leave the row in place (every
  // other errorIds use, including a reply's 'error' outcome, where the row's
  // true state is unknown, not resolved). Mirrors InWorksSection.tsx's own
  // refusedIds (same un-shared convention as this file's other local copies).
  const [refusedIds, setRefusedIds] = useState<Record<string, boolean>>({});
  // Row 305: was a single global slot (`string | null`) — see RowActions'
  // claimBusyIds doc comment above for the exact race this per-contact record
  // fixes, mirroring row 291's busyIds/errorIds treatment on this same file.
  const [claimBusyIds, setClaimBusyIds] = useState<Record<string, boolean>>({});
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
  // DESIGNED outcome (a two-operator/two-tab race the guard exists to catch).
  // Row 308 correction: NOT because any of these routes can 200 with a
  // logical failure — verified none does. handled/route.ts turns a store
  // ok:false into a 409; dismiss/followed/completed/route.ts each turn it into
  // a 503; nothing here ever pairs a 200 with an ok:false body, so `!data?.ok`
  // below is defensive-only against a route that doesn't exist today (kept in
  // case a future one pairs 200 with a logical failure — `!res.ok` alone
  // already catches every CURRENT case).
  //
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
  // errorIds also surfaces a visible note (parity with InWorksSection's
  // errorIds/"Something went wrong" pattern) in case the row is still on
  // screen after refresh() (e.g. a real server error, not a lost race).
  //
  // Not unit-tested end-to-end: InboxList.test.tsx only exercises
  // renderToStaticMarkup (no jsdom, no click/fetch simulation, no effects) —
  // it cannot drive this async click-then-refetch flow. The two map
  // transitions below (clear this row's own error on the way in; set it on
  // failure) delegate to withRowFlagSet/withRowFlagCleared specifically so
  // THAT non-trivial part — "one row's action never touches another row's
  // key" (row 291's actual bug) — is unit-tested directly, even though the
  // surrounding fetch/refresh choreography is still only a trace, matching
  // ContactRow's own doc-comment-as-proof pattern elsewhere in this file for
  // behavior static rendering can't observe.
  //
  // #302 fix (sibling-parity divergence vs. InWorksSection.tsx's act(),
  // found by a real device check with DevTools set to Offline): the
  // network-throw catch below used to be passive — just a comment claiming
  // "the next poll re-syncs the true state if the write failed" — and set no
  // error state at all. That comment was never accurate for THIS file: the
  // errorIds note a few lines up only renders for a row that's still present
  // in `items` (ItemRow is built from `groups`, built from `visibleItems`,
  // built from `items` — see the render below), and the optimistic removal
  // two lines above already takes the row out of `items` before the fetch
  // even starts. So on a throw, setting errorIds alone would have been
  // INERT — there'd be no row left to render the note on. If it was the
  // operator's last open item, `items.length === 0` even swaps in the
  // celebratory "Nothing unanswered right now" empty state. Nor can the poll
  // actually be trusted to fix it: refresh()'s own catch (above) is a silent
  // no-op, so while genuinely offline — the exact scenario a thrown fetch
  // signals — the 25s poll fails the identical way and never brings the row
  // back either.
  //
  // Fix: snapshot the row being removed (via `removedItem` below) before the
  // optimistic filter, and on a throw, set errorIds AND put it back if it
  // isn't already present (a concurrent refresh() from the poll could have
  // already restored — or further changed — this exact row in the window
  // before the throw resolves). Unlike the not-ok branch above, there's no
  // reason to prefer refresh()'s authoritative state here: a throw means the
  // request may never have reached the server at all, so "unchanged" is the
  // honest read, not a guess. `items` is now a dependency of this callback
  // specifically so `removedItem`'s lookup is never a stale closure (every
  // other read of `items` in this component goes through a functional
  // setState updater for the same reason, which is why `act` never needed
  // `items` as a dependency until now). Recreating `act` on every `items`
  // change is safe: `act` is not referenced in any other dependency array in
  // this file, and `rowActions` (below) is a plain object rebuilt fresh every
  // render regardless — nothing here relies on `act`'s referential identity.
  const act = useCallback(async (id: string, path: string, label: string) => {
    setBusyIds((prev) => withRowFlagSet(prev, id));
    // Row 291 fix: clear only THIS row's own error, never every row's — the
    // old setErrorId(null) here was the single-slot steal (acting on row B
    // silently erased row A's still-true failure note).
    setErrorIds((prev) => withRowFlagCleared(prev, id));
    setUnreachableActions((prev) => omitKey(prev, id));
    setRejectionErrors((prev) => omitKey(prev, id));
    // Row 392: clear a stale refusedIds flag from an EARLIER attempt on this
    // same row before this new attempt runs — otherwise a retry that later
    // fails for an unrelated reason (a real 503, item unchanged, refresh()
    // legitimately brings the row back) would inherit the old refusal's
    // shouldRemove=true and dismissError would wrongly delete a row that was
    // never actually refused this time. Only THIS attempt's own outcome
    // (below) sets it again.
    setRefusedIds((prev) => withRowFlagCleared(prev, id));
    const removedItem = items.find((i) => i.id === id);
    setItems((prev) => prev.filter((i) => i.id !== id)); // optimistic removal
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: id }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setErrorIds((prev) => withRowFlagSet(prev, id));
        setUnreachableActions((prev) => omitKey(prev, id));
        // Row 311 fix-round FIX 3: surface the route's own error text (e.g.
        // "Already marked followed") instead of only the generic fallback.
        setRejectionErrors((prev) => (data?.error ? { ...prev, [id]: data.error } : omitKey(prev, id)));
        if (isRefusalStatus(res.status)) {
          // Row 392: a 409 means the write's own CAS guard refused it — real
          // evidence this row already left its expected status server-side
          // (see dismiss/route.ts's own doc comment), not a backend failure.
          // Left alone, refresh() below would silently drop this row from
          // `items` (the server's fresh "needs_reply" bucket no longer
          // contains it) — orphaning the errorIds/rejectionErrors note we
          // just set, since ItemRow only renders for ids present in `items`.
          // The operator would then see the row simply vanish, indistinguishable
          // from the action having SUCCEEDED, and for Dismiss specifically
          // could wrongly conclude the sender is now suppressed when the CAS
          // guard means addSuppressedSenders never ran.
          //
          // Mirrors onComposerSent's existing 'refused' handling EXACTLY
          // (same file, below): restore the row and mark refusedIds so it
          // stays visible with its note until the operator dismisses it —
          // dismissError's shouldRemove branch (below) already does the
          // deferred removal, unchanged. No refresh() here, same as that
          // precedent — the rest of the list can catch up on the next poll.
          setRefusedIds((prev) => withRowFlagSet(prev, id));
          setItems((prev) => withItemRestored(prev, id, removedItem));
        } else {
          await refresh();
        }
      } else if (retiresFollowUp(path)) {
        // Row 309: this row's own optimistic removal above already keeps
        // THIS list correct — router.refresh() exists to reach the rest of the
        // page. PR #1005: the sibling that used to need it was the FollowUpStrip
        // (now deleted); today it is the awaiting bucket's server-rendered
        // "N follow-ups due" count. See retiresFollowUp's doc comment for
        // which actions are scoped in (dismiss, completed, and — since row
        // 430 — followed).
        router.refresh();
      }
    } catch {
      // #302 fix: restore the optimistically-removed row (if it isn't
      // already back — see withItemRestored's own doc comment) and flag it,
      // so the "Something went wrong" note and its Dismiss control render
      // immediately — see the doc comment above act() for why neither
      // errorIds alone nor waiting on refresh() would have been enough.
      setErrorIds((prev) => withRowFlagSet(prev, id));
      setUnreachableActions((prev) => ({ ...prev, [id]: label }));
      setItems((prev) => withItemRestored(prev, id, removedItem));
    } finally {
      setBusyIds((prev) => withRowFlagCleared(prev, id));
    }
  }, [refresh, items, router]);

  // Row 291 fix: explicit acknowledge control for the error note. Previously
  // the only ways to clear a row's error were retrying that exact row (via
  // act()) or the accidental cross-row steal this fix removes.
  const dismissError = useCallback((id: string) => {
    // Fix round 3 (MED): capture BEFORE clearing — a row flagged
    // 'flag-and-remove' (a reply's genuine CAS refusal) never got removed at
    // send-time; it waits for the operator to see the note and dismiss it,
    // which is when the delayed removal actually happens. Every other
    // dismissError caller (a thrown/rejected act() call, or a reply's
    // 'error' outcome) never sets refusedIds, so this is a no-op for them —
    // the row just stays put with its note cleared, exactly as before.
    const shouldRemove = !!refusedIds[id];
    setErrorIds((prev) => withRowFlagCleared(prev, id));
    setUnreachableActions((prev) => omitKey(prev, id));
    setRejectionErrors((prev) => omitKey(prev, id));
    setRefusedIds((prev) => omitKey(prev, id));
    if (shouldRemove) setItems((prev) => prev.filter((i) => i.id !== id));
  }, [refusedIds]);

  const claim = useCallback(
    async (contactId: string, action: 'claim' | 'release') => {
      setClaimBusyIds((prev) => withRowFlagSet(prev, contactId));
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
        setClaimBusyIds((prev) => withRowFlagCleared(prev, contactId));
      }
    },
    [currentOperatorId, refresh],
  );

  const toggleComposer = useCallback((id: string) => {
    setComposerFor((prev) => (prev === id ? null : id));
  }, []);

  const onComposerSent = useCallback((id: string, outcome: ReplySentOutcome) => {
    setComposerFor(null);
    if (outcome === 'resolved') {
      setItems((prev) => prev.filter((i) => i.id !== id));
      return;
    }
    // Fix round 3 (MED): 'refused' and 'error' get different treatment, same
    // as InWorksSection.tsx — see replyRowAction's own doc above. Neither
    // silently disappears the row: both use this file's existing
    // error/dismiss idiom (errorIds/rejectionErrors + the Dismiss button) so
    // the operator sees WHY, instead of the row just vanishing (or, for
    // 'error', staying invisible as still-open, still-'unresponded' work in
    // the PRIMARY open-lead queue).
    setErrorIds((prev) => withRowFlagSet(prev, id));
    setRejectionErrors((prev) => ({ ...prev, [id]: replyOutcomeMessage(outcome) }));
    if (replyRowAction(outcome) === 'flag-and-remove') {
      // 'refused' only: the row DOES leave the queue, but only once the
      // operator dismisses the note (dismissError's shouldRemove branch) —
      // never synchronously/silently here.
      setRefusedIds((prev) => withRowFlagSet(prev, id));
    }
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
    now, busyIds, errorIds, unreachableActions, rejectionErrors, dismissError, claimBusyIds, composerFor, currentOperatorId, act, claim, toggleComposer, onComposerSent, hlLocationId,
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
            expanded={isGroupExpanded(group, expanded, composerFor, errorIds)}
            // #270 delta-verify fix, extended #289 round 2: no-op while
            // composerFor/errorIds pins this group open — see
            // canToggleGroup's doc comment for why a swallowed toggle during
            // the pin must not mutate expandedMap.
            onToggleExpanded={() => {
              if (canToggleGroup(group, composerFor, errorIds)) toggleExpanded(group.key);
            }}
            actions={rowActions}
          />
        ))}
      </ul>
      )}
    </>
  );
}
