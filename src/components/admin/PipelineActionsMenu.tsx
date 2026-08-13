'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { pipelineActions, type PipelineRecord, type PipelineAction } from '@/lib/pipeline/pipelineActions';

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function run(action: PipelineAction, rec: PipelineRecord): Promise<Response | null> {
  const q = rec.quoteId;
  switch (action.kind) {
    case 'send': {
      // PS-G4: this is now the ONE way to send a quote (the admin quotes list's
      // inline Send/Resend button was dropped as a duplicate that offered no
      // channel choice). Carries over that button's UX — copy the portal URL to
      // the clipboard and confirm what happened, including the HighLevel stage —
      // so picking a channel here doesn't feel like a silent action.
      const portalUrl = `${window.location.origin}/portal/${q}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(portalUrl);
        copied = true;
      } catch {
        // Some browsers block clipboard outside HTTPS — fall through.
      }
      const res = await fetch(`/api/quotes/${q}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: action.channel }),
      });
      if (res.ok) {
        const body = (await res.clone().json().catch(() => ({}))) as {
          stageUpdated?: boolean;
          stageError?: string;
          alreadySent?: boolean;
        };
        const stage = body.stageUpdated
          ? '\nHighLevel: card moved to Bid Sent.'
          : body.stageError
            ? `\nHighLevel: ${body.stageError}`
            : '';
        const already = body.alreadySent ? ' (already sent earlier)' : '';
        alert(`Portal URL${copied ? ' copied to clipboard' : ''}${already}:\n\n${portalUrl}${stage}`);
      }
      return res;
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
  const [position, setPosition] = useState<{ top: number; left: number; key: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // What the menu is CURRENTLY showing. Drives both the content-keyed reveal
  // (`isVisible` below — a position measured for a different key stays
  // hidden) and the measure effect's re-run trigger.
  const contentKey = fetchError ? 'error' : rec ? 'ready' : 'loading';
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
        triggerRef.current?.focus();
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
      // Trap Tab/Shift+Tab within the menu — the portal appends it as the
      // LAST node in document.body, so without this, Tab from the trigger
      // (focus never otherwise moves off it) skips the menu entirely and
      // lands on the NEXT ROW's trigger, and a keyboard-opened menu never
      // closes on the way past (Tab doesn't fire mousedown) — two menus
      // end up open with independent, ambiguous state. Roving arrow-key
      // navigation is deliberately NOT added — Tab-through is enough here.
      if (e.key !== 'Tab' || !menuRef.current) return;
      const items = Array.from(menuRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (items.length === 0) {
        // Still "Loading…" — nothing to wrap Tab between yet. Pin focus in
        // place instead of letting it escape the portal into the row below.
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
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

  // Move focus into the menu whenever it's visible but focus isn't already
  // inside it — self-healing rather than a one-shot "focused this open"
  // flag, and that's load-bearing, not just simpler: the "Loading…"
  // placeholder has nothing focusable, so the first reveal falls back to
  // focusing the CONTAINER (tabindex=-1, like useModalFocus does) — and a
  // browser auto-blurs whatever currently holds focus to <body> the moment
  // that element goes `visibility:hidden`, which is exactly what happens to
  // the container for one commit when the placeholder swaps for the real
  // action list (the content-key mismatch frame on `menu`, below). A
  // one-shot flag would never notice focus had escaped to <body> and leave
  // it stranded there; checking "is focus already inside the menu" on every
  // reveal instead notices and recovers, landing on the first REAL action
  // once the list exists. Safe to re-run like this because Tab is fully
  // trapped (see `handleKeyDown`'s items.length===0 case) whenever there's
  // nothing focusable yet, so the user can't have tabbed elsewhere in the
  // meantime. Gated on `isVisible`, not just `open`, so this can't try to
  // focus an element that's still `visibility:hidden` (focus() is a no-op
  // on a non-rendered element) — it only runs on the render where the DOM
  // has actually committed the visible style.
  useEffect(() => {
    if (!open || !isVisible || !menuRef.current) return;
    const menuEl = menuRef.current;
    if (menuEl.contains(document.activeElement)) return;
    const first = menuEl.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (first) {
      first.focus();
    } else {
      menuEl.setAttribute('tabindex', '-1');
      menuEl.focus();
    }
  }, [open, isVisible]);

  async function onPick(action: PipelineAction) {
    if (action.kind === 'details') return; // rendered as a <Link>, not a button
    if (!rec) return;
    setBusy(true);
    try {
      const res = await run(action, rec);
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
