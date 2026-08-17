'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { pipelineActions, type PipelineRecord, type PipelineAction } from '@/lib/pipeline/pipelineActions';
import { decideSendOutcome, type Channel, type SendResponseBody, type RetryGate } from './pipelineSendOutcome';

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Row 270: 'send' is the only action kind that fully owns its own alerting
// (success, partial delivery failure, the 502 delivery-failed case, and
// alreadySent all need their own honest copy — see decideSendOutcome and the
// 'send' case below) — so it returns this sentinel instead of a raw
// Response, telling onPick whether to refresh WITHOUT onPick re-alerting
// body.error itself (a 502 delivery-failed response still means the quote
// got marked sent server-side, so refresh has to be independent of res.ok).
// Every OTHER action kind still returns a plain Response | null.
type Handled = { handled: true; refresh: boolean };

// The full response body shape the 'send' case reads from — SendResponseBody
// (pipelineSendOutcome.ts) covers the delivery-outcome fields; stageUpdated/
// stageError are read here only, for the existing HighLevel stage line.
type SendCaseBody = SendResponseBody & { stageUpdated?: boolean; stageError?: string };

// Row 270 fix round, FIX 1 (technical MED — sibling-guard parity with
// QuoteBuilder.tsx's sendInFlightRef, ~line 629: "state-based guards race —
// the ref flips before any await"). Module-level, not React state or even a
// ref scoped to one row — PipelineActionsMenu renders one instance PER ROW
// in a table, but the send route has no retry idempotency key of its own,
// so two same-tick sends really do text/email the customer twice, whether
// that's a double-click on ONE row or a click on a SECOND row while the
// first row's send/redeliver is still in flight. One operator drives one
// send at a time; blocking a second row's send while one is in flight is
// safe + correct (mirrors QuoteBuilder's ONE guard shared by both its Send
// button and its Force-redeliver button). Checked-and-set synchronously (no
// await between the read and the write) at the top of both entry points
// below — the 'send' case in run(), and redeliverAndReport — and cleared in
// a finally in both; a blocked call no-ops silently.
let sendInFlight = false;

// Shared by the two retry entry points below (the failedChannels-driven
// offer inside the 'send' case, and the alreadySent-driven offer also inside
// the 'send' case) — POSTs the delivery-only retry, classifies the result,
// alerts it, and — if THAT outcome still wants a retry — loops back for
// another gated attempt. Bounded by the operator's own willingness to keep
// responding to each attempt's dialog (see `gate` below), never automatic:
// every iteration requires a fresh explicit response, so there is no
// unbounded auto-retry.
//
// `gate` comes straight from decideSendOutcome's own retryGate field (see
// RetryGate's doc comment in pipelineSendOutcome.ts) — the pure helper is
// the single source of truth for which UI gate a given retry needs; this
// function only reads it and shows the matching dialog kind.
async function redeliverAndReport(
  quoteId: string,
  channel: Channel,
  prompt: string,
  gate: RetryGate,
): Promise<void> {
  // Row 270 fix round, FIX 3 (customer MED): a plain window.confirm here
  // for the fresh-send alreadySent retry used to chain directly after the
  // 'send' case's own alert() below — both alert() and confirm() dismiss/
  // accept under the Enter key, so a reflexive Enter-Enter right after
  // seeing the "already sent" alert could fire a REAL duplicate SMS/email
  // to a customer who already has the quote (the exact reflex class this
  // file already eliminated once — see the removed-auto-focus comment near
  // handleKeyDown, above). A 'typed-yes' gate breaks that chain:
  // window.prompt requires the operator to actually TYPE "YES"
  // (case-insensitive) — a reflexive Enter alone submits '' and aborts. A
  // 'confirm' gate stays plain for a partial-failure/502 path whose failure
  // was CONFIRMED (a duplicate really is impossible — the customer got
  // nothing from THIS attempt). Row 290: a GHL-TIMEOUT partial-failure/502
  // path is NOT confirmed (GHL may have delivered it anyway) and now gets
  // 'typed-yes' too — decideSendOutcome (pipelineSendOutcome.ts) is the one
  // place that tells them apart; this function only reads the gate it picks.
  if (gate === 'typed-yes') {
    const typed = window.prompt(prompt);
    if (typed === null || typed.trim().toUpperCase() !== 'YES') return;
  } else if (!window.confirm(prompt)) {
    return;
  }
  // FIX 1: see sendInFlight's declaration above. Checked-and-set right
  // before this function's own fetch (its only await).
  if (sendInFlight) return;
  sendInFlight = true;
  let retryChannel: Channel | null = null;
  let retryPrompt: string | null = null;
  let retryGate: RetryGate | null = null;
  try {
    const res = await fetch(`/api/quotes/${quoteId}/send?retryDelivery=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel }),
    });
    const body = (await res.json().catch(() => ({}))) as SendResponseBody;
    const outcome = decideSendOutcome(res.ok, body, channel, true);
    alert(outcome.message || 'Delivered.');
    retryChannel = outcome.retryChannel;
    retryPrompt = outcome.retryPrompt;
    retryGate = outcome.retryGate;
  } catch {
    // Row 270 fix round, FIX 2 (staff MED): this fetch previously had no
    // try/catch — a NETWORK-level rejection (dropped connection, not an
    // HTTP error status) propagated unhandled through run() -> onPick's
    // try/finally (finally only clears `busy`) -> an unhandled promise
    // rejection: no alert, no menu close, no list refresh. This is the one
    // flow in the file where a SECOND fetch can throw AFTER the first
    // fetch already changed server state (the quote got stamped sent), so
    // the stale un-refreshed list actively lies rather than merely being
    // behind. Alert honestly and return normally (not rethrow) so the
    // 'send' case's own `{ handled: true, refresh: true }` still fires —
    // menu closes, list refreshes.
    alert(
      'Redeliver could not be sent — network error. The quote is already marked sent; you can retry from this menu or the quote page.',
    );
    return;
  } finally {
    // Released before the next retry offer below (not held for the whole
    // recursive chain) — the recursive self-call acquires this SAME flag
    // for its own fetch, so holding it any longer would deadlock that call
    // against itself.
    sendInFlight = false;
  }
  if (retryChannel && retryPrompt && retryGate) {
    await redeliverAndReport(quoteId, retryChannel, retryPrompt, retryGate);
  }
}

async function run(action: PipelineAction, rec: PipelineRecord): Promise<Response | Handled | null> {
  const q = rec.quoteId;
  switch (action.kind) {
    case 'send': {
      // Row 270 fix round, FIX 1 (technical MED): see sendInFlight's
      // declaration above. Checked-and-set synchronously here, before this
      // case's first await (the clipboard write) — a blocked second
      // invocation no-ops silently (returns null), matching every other
      // cancelled-prompt branch in this switch.
      if (sendInFlight) return null;
      sendInFlight = true;
      // PS-G4: this is now the ONE way to send a quote (the admin quotes list's
      // inline Send/Resend button was dropped as a duplicate that offered no
      // channel choice). Carries over that button's UX — copy the portal URL to
      // the clipboard and confirm what happened, including the HighLevel stage —
      // so picking a channel here doesn't feel like a silent action.
      const portalUrl = `${window.location.origin}/portal/${q}`;
      let copied = false;
      let res: Response;
      let body: SendCaseBody;
      try {
        try {
          await navigator.clipboard.writeText(portalUrl);
          copied = true;
        } catch {
          // Some browsers block clipboard outside HTTPS — fall through.
        }
        res = await fetch(`/api/quotes/${q}/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: action.channel }),
        });
        // Row 270: read via .clone() (leaves `res` itself unconsumed) so a
        // response this case doesn't specially handle can still be returned
        // raw below for onPick's existing generic path to read again.
        body = (await res.clone().json().catch(() => ({}))) as SendCaseBody;
      } finally {
        // FIX 1: released here, before the alert/retry-offer below (not
        // held for the whole case) — redeliverAndReport (above) acquires
        // this SAME flag for its own fetch, so holding it any longer would
        // deadlock that call against itself.
        sendInFlight = false;
      }
      // Untouched error paths (empty-quote, no-contact, view-only,
      // deposit-paid, send-conflict, ...): not delivery-related, no server
      // state changed, no retry applies. Falling through to onPick's
      // existing generic `!res.ok` handler keeps these byte-identical to
      // pre-row-270 behavior (bare `alert(body.error)`, menu stays open) —
      // only a 502 delivery-failed (code below) and any res.ok shape
      // (success / partial / alreadySent) get this case's OWN honesty
      // handling.
      if (!res.ok && body.code !== 'delivery-failed') {
        return res;
      }
      const stage = body.stageUpdated
        ? '\nHighLevel: card moved to Bid Sent.'
        : body.stageError
          ? `\nHighLevel: ${body.stageError}`
          : '';
      const already = body.alreadySent ? ' (already sent earlier)' : '';
      const outcome = decideSendOutcome(res.ok, body, action.channel, false);
      alert(
        `Portal URL${copied ? ' copied to clipboard' : ''}${already}:\n\n${portalUrl}${stage}${outcome.message ? `\n\n${outcome.message}` : ''}`,
      );
      if (outcome.retryChannel && outcome.retryPrompt && outcome.retryGate) {
        await redeliverAndReport(q, outcome.retryChannel, outcome.retryPrompt, outcome.retryGate);
      }
      // Both remaining branches here change (or may have changed) server
      // state: res.ok (success/partial/alreadySent — alreadySent changes
      // nothing NEW, but refreshing is harmless and matches this case's
      // pre-existing behavior of always refreshing on res.ok) and the 502
      // delivery-failed case (the quote WAS stamped sent locally — see
      // route.ts's `locallySent`), which never refreshed before this fix.
      return { handled: true, refresh: true };
    }
    case 'mark-sent': {
      // #182: the quote was delivered outside the tool (hand-texted the
      // portal link, walked through it on a call). DB-only stamp — no
      // message is sent, no GHL card is touched.
      if (
        !window.confirm(
          'Mark this quote as sent? No message is sent to the customer — this only records that you delivered it yourself.',
        )
      )
        return null;
      return fetch(`/api/quotes/${q}/mark-sent`, { method: 'POST' });
    }
    case 'mark-approved':
      return fetch(`/api/quotes/${q}/staff-approve`, { method: 'POST' });
    case 'staff-decline': {
      // Record a decline the customer gave outside the tool (phone/text). Reason
      // is optional — Cancel on the prompt aborts; an empty reason is allowed.
      const entered = window.prompt(
        'Mark this quote declined (customer declined outside the tool). Optional reason:',
        '',
      );
      if (entered === null) return null; // user cancelled
      return fetch(`/api/quotes/${q}/staff-decline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: entered.trim() }),
      });
    }
    case 'mark-abandoned': {
      // #235: archive a quote that went cold — never approved, never
      // declined. Optional note — Cancel on the prompt aborts; an empty note
      // is allowed.
      const entered = window.prompt(
        'Mark this quote abandoned (gone cold — no reply, never approved or declined)? Optional note:',
        '',
      );
      if (entered === null) return null; // user cancelled
      return fetch(`/api/quotes/${q}/staff-abandon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: entered.trim() }),
      });
    }
    case 'convert-to-job': {
      const entered = window.prompt('Deposit received (USD)? Enter 0 if none.', '');
      if (entered === null) return null; // user cancelled
      const depositUsd = Number(entered);
      if (!Number.isFinite(depositUsd) || depositUsd < 0) {
        alert('Enter a number >= 0');
        return null;
      }
      const post = (force: boolean) =>
        fetch(`/api/quotes/${q}/convert-to-job`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(force ? { depositUsd, force: true } : { depositUsd }),
        });
      const res = await post(false);
      // Abandoned-checkout override: if a customer Valor checkout is flagged in
      // flight, the operator can confirm no payment landed and book anyway.
      if (res.status === 409) {
        const body = await res.clone().json().catch(() => ({}));
        if ((body as { code?: string }).code === 'payment-in-flight') {
          const ok = window.confirm(
            'A customer card payment may be in progress for this quote. Only book manually if you’ve confirmed no payment was taken. Book anyway?',
          );
          if (!ok) return null;
          return post(true);
        }
      }
      return res;
    }
    case 'create-job':
      // Booked but job auto-create failed: re-run it via convert-to-job's
      // already-booked branch (idempotent createJobFromQuote). depositUsd is
      // ignored on an already-booked quote; force:true clears any stale
      // valor_order_ref in-flight guard. No prompt needed.
      return fetch(`/api/quotes/${q}/convert-to-job`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ depositUsd: 0, force: true }),
      });
    case 'mark-complete':
      return rec.job ? fetch(`/api/jobs/${rec.job.id}/complete`, { method: 'POST' }) : null;
    case 'collect-payment': {
      if (!rec.invoice) return null;
      if (
        !window.confirm(
          `Collect payment for this invoice? This marks the full balance of ${money(rec.invoice.balance)} as paid. Only confirm if the full amount was received: this cannot record a partial payment.`,
        )
      )
        return null;
      return fetch(`/api/invoices/${rec.invoice.id}/mark-paid`, { method: 'POST' });
    }
    case 'close':
      if (!rec.job) return null;
      if (!window.confirm('Close this job/invoice? Marks it paid + done.')) return null;
      return fetch(`/api/jobs/${rec.job.id}/close`, { method: 'POST' });
    case 'cancel':
      if (!rec.job) return null;
      if (!window.confirm('Cancel this booking? Refunds are handled manually in Valor.')) return null;
      return fetch(`/api/jobs/${rec.job.id}/cancel`, { method: 'POST' });
    case 'amend':
      // Navigate to the quote builder (edit page) — no fetch needed.
      window.location.assign(`/quote/${q}`);
      return null;
    case 'rebook': {
      // #116: clone a dead quote into a fresh draft, then open the new draft in
      // the builder. The original terminal quote is left untouched.
      if (!window.confirm('Rebook this quote into a fresh draft? The original stays unchanged.')) return null;
      const res = await fetch(`/api/quotes/${q}/rebook`, { method: 'POST' });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { quoteId?: string };
        if (body.quoteId) {
          window.location.assign(`/quote/${body.quoteId}`);
          return null; // navigation handles the "done"
        }
      }
      return res; // let onPick surface any error
    }
    default:
      return null;
  }
}

const VIEWPORT_MARGIN = 8;

// Right-align the menu under the trigger (matching the old `right-0` visual
// result), flipping above the trigger when there isn't room below. Clamped
// to the viewport on every axis so the menu is always fully reachable, never
// partly off-screen (#Options-menu-clipped: the table's overflow-x-auto
// wrapper was clipping an absolutely-positioned menu — see the portal below).
// Width/height are MEASURED (offsetWidth/offsetHeight) by the caller rather
// than hard-coded here — a hard-coded width constant previously mirrored the
// `w-52` class below with nothing tying the two together, so they could
// silently drift if either one changed alone.
function computeMenuPosition(
  triggerRect: DOMRect,
  menuSize: { width: number; height: number },
): { top: number; left: number } {
  const { width: menuWidth, height: menuHeight } = menuSize;
  let left = triggerRect.right - menuWidth;
  left = Math.min(Math.max(left, VIEWPORT_MARGIN), window.innerWidth - menuWidth - VIEWPORT_MARGIN);

  const spaceBelow = window.innerHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  let top: number;
  if (spaceBelow >= menuHeight + VIEWPORT_MARGIN || spaceBelow >= spaceAbove) {
    top = triggerRect.bottom + 4;
  } else {
    top = triggerRect.top - menuHeight - 4;
  }
  // Final clamp: whichever side was picked, keep the whole menu on-screen.
  top = Math.min(Math.max(top, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerHeight - menuHeight - VIEWPORT_MARGIN));
  return { top, left };
}

// Narrowed form of the selector `useModalFocus` (src/components/portal/
// useModalFocus.ts) uses for its own dialogs — this menu only ever renders
// <button>/<a href> action items, never a text input, so the wider selector
// isn't needed here.
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled])';

// A literal union, not `string` — shared by `contentKey` and `position.key`
// so a future rename of one of these three values can't silently break the
// `position.key === contentKey` comparison the content-keyed reveal depends
// on (a typo'd string literal in only one place would still type-check).
type MenuContentKey = 'loading' | 'ready' | 'error';

export function PipelineActionsMenu({
  quoteId,
  onDone,
}: {
  quoteId: string;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rec, setRec] = useState<PipelineRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // `key` is the contentKey (below) the position was MEASURED for — see the
  // measure effect and `isVisible`. Lets the render distinguish "measured
  // and ready to show" from "measured for content that has since changed."
  const [position, setPosition] = useState<{ top: number; left: number; key: MenuContentKey } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // What the menu is CURRENTLY showing. Drives both the content-keyed reveal
  // (`isVisible` below — a position measured for a different key stays
  // hidden) and the measure effect's re-run trigger.
  const contentKey: MenuContentKey = fetchError ? 'error' : rec ? 'ready' : 'loading';
  // True only once `position` was measured FOR the content currently being
  // rendered. A stale measurement (e.g. taken for the "Loading…" placeholder,
  // now showing the full action list) stays hidden rather than painting at
  // the wrong size/position for one frame — see the `menu` comment below.
  const isVisible = !!position && position.key === contentKey;

  async function toggle() {
    if (open) {
      // Same close path as every other close reason, so `position` can't be
      // left stale on a manual close (harmless today — the effect recomputes
      // on the next open — but one close path that skips the reset is exactly
      // the kind of asymmetry that stops being harmless after the next edit).
      closeAndReset();
      return;
    }
    setOpen(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/pipeline/${quoteId}`);
      if (res.ok) {
        setRec(await res.json());
      } else {
        setFetchError('Could not load actions');
      }
    } catch {
      setFetchError('Could not load actions');
    }
  }

  // `skipFocusRestore` is for a close that's actually a navigation (the
  // Details link, below) — forcing focus back onto a trigger that's about
  // to be navigated away from fights the click the user just made.
  function closeAndReset(opts?: { skipFocusRestore?: boolean }) {
    // Deferred (see the react-hooks/set-state-in-effect note above) since
    // this is called from listeners registered inside an effect below.
    queueMicrotask(() => {
      setOpen(false);
      setPosition(null);
      // Clear the cached fetch outcome too, not just position — `rec`
      // otherwise survives a close, so a REOPEN's very first render already
      // has contentKey 'ready' (or 'error') from the PREVIOUS fetch, before
      // the fresh fetch this reopen just kicked off has landed. The
      // content-keyed reveal only guards a mismatched key; it can't see a
      // stale 'ready' → fresh 'ready' swap, since both sides say 'ready'.
      // Net effect without this: reopening shows the old, fully-clickable
      // action list (wrong balance/ids if the underlying record moved on)
      // for the entire duration of the new fetch. `toggle`'s open path
      // already clears `fetchError` for the same reason; this covers the
      // close side, which was the gap, and covers `rec` either way.
      setRec(null);
      setFetchError(null);
      if (opts?.skipFocusRestore) return;
      // Only reclaim focus if nothing else has already claimed it. Clicking
      // a DIFFERENT row's trigger to switch menus fires THIS row's
      // outside-mousedown close too, and by the time this microtask runs the
      // browser has already moved focus onto that other trigger (the
      // browser's default mousedown-focus behavior runs before our deferred
      // callback) — force-focusing our own trigger here would yank focus
      // back off the button the user just clicked.
      const active = document.activeElement;
      if (active === document.body || active === null || menuRef.current?.contains(active)) {
        // preventScroll: a bare focus() auto-scrolls the trigger into view
        // if it isn't already — exactly wrong on the scroll-close path
        // (closeOnScrollOrResize, below), where the user is actively
        // scrolling and a forced scroll-to-trigger fights their own wheel
        // gesture. The other close paths (Escape, outside click, action
        // picked) all land here with the trigger already in view, so this
        // is a no-op difference for them.
        triggerRef.current?.focus({ preventScroll: true });
      }
    });
  }

  // Measure + (re)position after every render of the open menu — its height
  // changes between the "Loading…"/error placeholder and the real action
  // list, so this reruns when `rec`/`fetchError` land, not just on open.
  // Stamps the `contentKey` it measured FOR onto `position` so the render
  // below can tell a stale measurement (computed for different content)
  // apart from a current one — see `isVisible` and the two-phase-reveal
  // note on `menu`.
  useEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    // Measure synchronously (accurate layout), defer only the setState call
    // (react-hooks/set-state-in-effect) — a microtask still runs before
    // paint, so there's no visible flash.
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuWidth = menuRef.current.offsetWidth;
    const menuHeight = menuRef.current.offsetHeight;
    const measuredKey = contentKey;
    queueMicrotask(() =>
      setPosition({
        ...computeMenuPosition(triggerRect, { width: menuWidth, height: menuHeight }),
        key: measuredKey,
      }),
    );
  }, [open, rec, fetchError, contentKey]);

  // Close on outside click, Escape, window resize, or a scroll anywhere
  // (capture:true on window catches scroll events fired on a nested
  // scroller — e.g. the table's overflow-x-auto wrapper — even though
  // `scroll` doesn't bubble; the capturing phase still walks window → target).
  // Escape/Tab also live here (not a separate effect) since they need the
  // same open-gated add/remove lifecycle as the rest.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeAndReset();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeAndReset();
        return;
      }
      // Tab handling. The menu never auto-focuses itself on open (there is
      // no reveal-time focus effect — see the removal note where one used
      // to be, below) — opening via keyboard leaves focus ON THE TRIGGER,
      // the standard WAI menu-button pattern. That matters beyond style:
      // nothing is pre-armed under Enter. A reflexive second Enter right
      // after opening just re-activates the trigger (closes the menu, see
      // `toggle`), not the FIRST ACTION IN THE LIST — which, for a
      // draft/sent/viewed/changes-requested/declined/abandoned row, is
      // "Send (email + text)" with no confirmation gate. An earlier version
      // of this fix auto-focused that button the instant it existed; a
      // customer-lens review reproduced it live (activeElement sitting on
      // Send with zero deliberate keystrokes — Tab to Options, Enter to
      // open, reflexive second Enter or OS key-repeat sends a real email
      // and text). This trap is what now owns getting focus INTO the menu,
      // deliberately, instead of a separate effect doing it automatically.
      //
      // From the trigger, Tab steps IN (to the first item); from the first
      // item, Shift+Tab steps back OUT (to the trigger) — undoing exactly
      // that step; from the last item, Tab wraps to the first (never
      // escapes the portal to the row behind it — the reason this trap
      // exists at all, the portal being the LAST node in document.body).
      // A middle item's Tab/Shift+Tab is left alone; native order already
      // stays within the menu's own items there. Roving arrow-key
      // navigation is deliberately NOT added — Tab-through is enough here.
      if (e.key !== 'Tab' || !menuRef.current) return;
      const items = Array.from(menuRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const active = document.activeElement;
      if (items.length === 0) {
        // Loading, or the error state (which has no focusable items either,
        // and never self-heals into one). Nothing to step into yet, but
        // this listener is document-wide — only pin Tab when it would
        // otherwise escape FROM the trigger or the menu itself (the "don't
        // skip to the next row" case). If focus is anywhere else on the
        // page — the user tabbed on to something unrelated while this menu
        // sat open in the background — this menu has no business
        // intercepting that Tab press at all.
        if (active === triggerRef.current || menuRef.current.contains(active)) {
          e.preventDefault();
        }
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!e.shiftKey && active === triggerRef.current) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        triggerRef.current?.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    function closeOnScrollOrResize() {
      closeAndReset();
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', closeOnScrollOrResize, true);
    window.addEventListener('resize', closeOnScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', closeOnScrollOrResize, true);
      window.removeEventListener('resize', closeOnScrollOrResize);
    };
  }, [open]);

  // REMOVED: an effect used to live here that auto-focused the menu's
  // first item (or the container, in an earlier iteration still) the
  // instant it became visible. Deleted, not just reworked — a menu that
  // pre-arms an unconfirmed customer send under the Enter key cannot ship;
  // see `handleKeyDown`'s Tab handling, above, for what replaced it. Focus
  // now moves into the menu ONLY on an explicit Tab from the trigger, never
  // automatically on reveal.

  async function onPick(action: PipelineAction) {
    if (action.kind === 'details') return; // rendered as a <Link>, not a button
    if (!rec) return;
    setBusy(true);
    try {
      const res = await run(action, rec);
      // Row 270: 'send' already did its own alerting inside run() (see
      // Handled's doc comment above) — this branch only decides whether to
      // refresh, and returns before either of the two generic branches below
      // can double-alert. Every other action kind returns a plain
      // Response | null (a real fetch Response has no `handled` property),
      // so this check never fires for them and they fall through unchanged.
      if (res && 'handled' in res) {
        if (res.refresh) {
          closeAndReset();
          onDone?.();
        }
        return;
      }
      if (res && !res.ok) {
        const body = await res.json().catch(() => ({}));
        alert((body as { error?: string }).error ?? 'Action failed');
      }
      if (res && res.ok) {
        closeAndReset();
        onDone?.();
      }
    } finally {
      setBusy(false);
    }
  }

  // The open menu (Task 1 fix): portaled to document.body with position:fixed
  // instead of an absolutely-positioned child of the trigger. An
  // absolutely-positioned descendant can't escape an ancestor's
  // overflow-x-auto — every one of this component's real render sites wraps
  // its table in exactly that (admin/quotes, admin/jobs, admin/invoices,
  // customers/[contactId]) — so the old menu was clipped, only reachable by
  // scrolling the table.
  //
  // Gated on `open` alone — no separate SSR-safety `mounted` flag. `open`
  // starts false and can only ever become true from a user click, which
  // can't happen until after client hydration, so SSR always renders
  // `open === false` (no portal, no `document` access) and the first
  // client render matches it byte-for-byte; a `mounted` flag was one more
  // state + effect + re-render per row (182 of them on a full quotes table)
  // enforcing a guarantee `open` already gives for free.
  //
  // Visible only when `isVisible` (position was measured FOR the content
  // currently rendered) — otherwise hidden, never at the wrong spot. This
  // covers TWO reveals, not just the first: the initial open (nothing
  // measured yet, `position === null`) AND every later content swap (e.g.
  // "Loading…" -> the real action list, which is a different height and
  // sometimes flips the menu from below the trigger to above it). Without
  // the second case, the already-visible "Loading…" menu would repaint at
  // the real list's size at the STALE position for at least one frame
  // before the re-measure effect moved it — a visible jump, worst on a
  // bottom-of-viewport row where the flip direction also reverses.
  const menu = open && (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        // Keeps VIEWPORT_MARGIN the single source for "how close to the
        // screen edge" — a menu taller than the viewport (not reachable
        // today, but not impossible as actions grow) would otherwise clamp
        // to VIEWPORT_MARGIN from the top with its bottom run off-screen,
        // unreachable (position:fixed ignores page scroll).
        maxHeight: `calc(100vh - ${2 * VIEWPORT_MARGIN}px)`,
        overflowY: 'auto',
        ...(isVisible && position
          ? { top: position.top, left: position.left, visibility: 'visible' as const }
          : { top: 0, left: 0, visibility: 'hidden' as const }),
      }}
      className="z-50 w-52 rounded-md border border-gray-200 bg-white shadow-lg py-1"
    >
      {fetchError ? (
        <p className="px-3 py-2 text-xs text-red-600">{fetchError}</p>
      ) : !rec ? (
        <p className="px-3 py-2 text-xs text-gray-400">Loading…</p>
      ) : (
        pipelineActions(rec).map((a, i) =>
          a.kind === 'details' ? (
            <Link
              key={i}
              href={a.href}
              // Bypassed closeAndReset entirely before (this is a <Link>,
              // not a button routed through onPick) — left `open === true`
              // and all four listeners above attached until unmount.
              // skipFocusRestore: true because this closes the menu by
              // NAVIGATING; force-focusing the trigger back would fight
              // that navigation instead of letting it proceed.
              onClick={() => closeAndReset({ skipFocusRestore: true })}
              className="block px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              {a.label}
            </Link>
          ) : (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={() => onPick(a)}
              className="block w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {a.label}
            </button>
          ),
        )
      )}
    </div>
  );

  return (
    <div className="inline-block text-left">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50 text-gray-700"
      >
        Options ▾
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
