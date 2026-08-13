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

// Menu width mirrors the `w-52` class below (13rem = 208px) — the position
// math needs the number, Tailwind only has the class.
const MENU_WIDTH = 208;
const VIEWPORT_MARGIN = 8;

// Right-align the menu under the trigger (matching the old `right-0` visual
// result), flipping above the trigger when there isn't room below. Clamped
// to the viewport on every axis so the menu is always fully reachable, never
// partly off-screen (#Options-menu-clipped: the table's overflow-x-auto
// wrapper was clipping an absolutely-positioned menu — see the portal below).
function computeMenuPosition(triggerRect: DOMRect, menuHeight: number): { top: number; left: number } {
  let left = triggerRect.right - MENU_WIDTH;
  left = Math.min(Math.max(left, VIEWPORT_MARGIN), window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN);

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
  // Portal target isn't safe until after client mount (no `document` during
  // SSR); the menu itself only ever renders once `open` is client-triggered,
  // but gate on `mounted` too so this stays correct even if that changes.
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Defer out of the synchronous effect body (project rule:
    // react-hooks/set-state-in-effect is at error in this repo).
    queueMicrotask(() => setMounted(true));
  }, []);

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

  function closeAndReset() {
    // Deferred (see the react-hooks/set-state-in-effect note above) since
    // this is called from listeners registered inside an effect below.
    queueMicrotask(() => {
      setOpen(false);
      setPosition(null);
    });
  }

  // Measure + (re)position after every render of the open menu — its height
  // changes between the "Loading…"/error placeholder and the real action
  // list, so this reruns when `rec`/`fetchError` land, not just on open.
  useEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    // Measure synchronously (accurate layout), defer only the setState call
    // (react-hooks/set-state-in-effect) — a microtask still runs before
    // paint, so there's no visible flash.
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const menuHeight = menuRef.current.offsetHeight;
    queueMicrotask(() => setPosition(computeMenuPosition(triggerRect, menuHeight)));
  }, [open, rec, fetchError]);

  // Close on outside click, Escape, window resize, or a scroll anywhere
  // (capture:true on window catches scroll events fired on a nested
  // scroller — e.g. the table's overflow-x-auto wrapper — even though
  // `scroll` doesn't bubble; the capturing phase still walks window → target).
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeAndReset();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeAndReset();
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
  // scrolling the table. Until `position` is measured, render invisibly (not
  // at all) so there's no flash at the wrong spot.
  const menu = open && mounted && (
    <div
      ref={menuRef}
      style={
        position
          ? { position: 'fixed', top: position.top, left: position.left, visibility: 'visible' }
          : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
      }
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
        className="px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50 text-gray-700"
      >
        Options ▾
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
