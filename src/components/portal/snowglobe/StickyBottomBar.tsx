'use client';

// Portal v6 — StickyBottomBar. Floating-pill variant (not full-width)
// that hovers center-bottom with heavy backdrop-blur. Reads live
// selection from context so the price + deposit stay in sync with
// the InteractiveHero's tabs.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';
import { useModalFocus } from '../useModalFocus';
import { DepositCheckout } from './DepositCheckout';
import { SignaturePad, type CapturedSignature } from './SignaturePad';
import { QuoteResponseModal, type ResponseIntent } from './QuoteResponseModal';
import { isPortalActionable } from '@/lib/quoteStatus';
import type { InstallTiming, PackageId } from '../types';
import { DEFAULT_PERMANENT_EFFECT, type SceneEffect } from '@/lib/design/permanentScenes';
import type { ServiceType } from '@/lib/serviceType';
import { track } from '@/lib/analytics/posthog';
import { categorizeApproveError } from '@/lib/analytics/errorCategory';
import { FinancingCta } from '../FinancingCta';
import { financedBalanceUsd, isFinancingEligible } from '@/lib/financing/eligibility';

// Pure gate for the Approve action (extracted for test coverage — audit
// W4-031). Mirrors the `disabled` prop on the Approve button AND the early
// return at the top of onApprove exactly: submitting in flight or the
// selection is still under the order minimum.
export function canSubmitApproval(submitting: boolean, meetsMinimum: boolean): boolean {
  return !submitting && meetsMinimum;
}

// Pure payload builder for the /approve POST body (extracted for test
// coverage — audit W4-031). Mirrors onApprove's fetch body exactly — every
// field maps 1:1 from the live SelectionContext fields + the captured
// signature. Kept as a plain function (no fetch/router/state) so the
// field-mapping is unit-testable without React/DOM.
export function buildApprovePayload(
  selection: {
    packageId: PackageId;
    selectedItemIds: Set<string>;
    activeName: string;
    currentTotal: number;
    currentDeposit: number;
    rushSelected: boolean;
    takedownSelected: boolean;
    colorSchemeId: string;
    customPattern: string[];
    permanentEffect?: SceneEffect;
    installTiming: InstallTiming;
    breakdown: { discount: number };
  },
  sig: CapturedSignature,
) {
  return {
    packageId: selection.packageId,
    selectedItemIds: Array.from(selection.selectedItemIds),
    activeName: selection.activeName,
    currentTotal: selection.currentTotal,
    currentDeposit: selection.currentDeposit,
    rushSelected: selection.rushSelected,
    takedownSelected: selection.takedownSelected,
    colorSchemeId: selection.colorSchemeId,
    customPattern: selection.customPattern,
    permanentEffect: selection.permanentEffect ?? DEFAULT_PERMANENT_EFFECT,
    installTiming: selection.installTiming,
    installDiscountUsd: selection.breakdown.discount,
    // #83 Slice B — the e-signature captured in the "Confirm & sign" step.
    signature: { name: sig.name, kind: sig.kind, value: sig.value },
  };
}

// Pure once-per-open guard for the `approve_abandoned` event (PostHog Wave 1,
// extracted for test coverage — same reasoning as buildApprovePayload). The
// sign modal ("Confirm & sign") and the deposit-checkout modal each need
// identical semantics: reset when the modal opens, and fire at most once per
// open — never after a confirmed success/409 in that same open, and never
// twice for the same open. A plain mutable object (not React state), read and
// written from event handlers between renders rather than rendered itself.
export type AbandonGuard = { resolved: boolean };

export function openAbandonGuard(): AbandonGuard {
  return { resolved: false };
}

/** Marks the current open as resolved by something other than a close (a
 *  confirmed approval / already-approved 409) so a later close won't fire. */
export function resolveAbandonGuard(guard: AbandonGuard): void {
  guard.resolved = true;
}

/** True the first time this is consumed after an open (and marks the guard
 *  resolved so it won't fire again this open); false otherwise. */
export function consumeAbandonOnClose(guard: AbandonGuard): boolean {
  if (guard.resolved) return false;
  guard.resolved = true;
  return true;
}

// Bug fix (PS-D1, extracted for test coverage): a 409 from POST /approve
// covers two different server states (approve/route.ts) — 'already-approved'
// (idempotent re-click, a genuine success case) and 'illegal-transition' (the
// quote moved to declined/cancelled/changes_requested since the page loaded).
// Only the former should navigate the customer forward; treating every 409 as
// success dead-ended a declined/changes-requested customer on /approved with
// no approval on record.
export function isAlreadyApprovedCode(code: unknown): boolean {
  return code === 'already-approved';
}

// View-only portal (#176) — the "just browsing" strip copy + tel href, pure
// so it's testable without the render infra this file already lacks (see
// StickyBottomBar.test.ts's header note). Mirrors the tel: normalization used
// elsewhere in the portal (e.g. PersonalContact.tsx).
export function viewOnlyBrowsingCopy(phone: string): { label: string; phone: string; telHref: string } {
  return {
    label: 'Just browsing — text us your favourite look:',
    phone,
    telHref: `tel:${phone.replace(/[^0-9+]/g, '')}`,
  };
}

export type StickyBottomBarProps = {
  quoteId: string;
  /** #43 — the customer has approved (the snapshot is frozen). When checkout is
   *  ON this alone is NOT "booked" — they still owe the deposit (see `booked`). */
  approved?: boolean;
  /** #38 — the END state: deposit paid (checkout on) or simply approved (checkout
   *  off). Drives the "You're booked" bar. */
  booked?: boolean;
  /** #38 — whether the deposit checkout is enabled. Computed on the SERVER
   *  (portal page) and passed in, so it's never a stale build-time value. */
  checkoutEnabled?: boolean;
  /** #38 — the frozen deposit amount from the approval snapshot (what /pay will
   *  actually charge). Shown in the "complete your deposit" bar so it matches. */
  approvedDepositUsd?: number;
  /** #93 — this is a TEST quote. The deposit step becomes "Simulate deposit
   *  paid" (→ /simulate-deposit, no Valor) and the deposit flow is available
   *  regardless of whether the real Valor checkout is enabled. */
  isTest?: boolean;
  /** #176 — a staff-flagged browse-only quote. Overrides every other bar
   *  state: renders a neutral "just browsing" strip and never mounts the
   *  approve/pay/decline/request-changes UI (DepositCheckout, SignModal,
   *  QuoteResponseModal). The server independently 409s the same four
   *  actions — this is the UI half, never the guard on its own. */
  viewOnly?: boolean;
  /** Bug fix (audit W4-013) — the quote's live lifecycle status
   *  (deriveStatus), passed down so the "Complete deposit" bar can be
   *  suppressed once staff cancel/decline an approved-but-unpaid quote. The
   *  page-level dead-quote gate skips itself once `approved` is true (so a
   *  booked-then-cancelled quote still shows its confirmation), so this is
   *  the only place left to catch "approved, unpaid, then killed". Undefined
   *  is treated as actionable (fail-open — matches isPortalActionable). */
  quoteStatus?: string | null;
  /** PostHog v1 — included on the quote_approved event's properties. */
  serviceType?: ServiceType;
  /** #154 interim — the merchant's Wisetack prequal URL, threaded from the
   *  SERVER (PortalQuote.financing, set only when the flag is exactly on AND a
   *  URL is configured). Undefined = financing is off and nothing here changes.
   *  Eligibility against the LIVE selection balance is checked at the sign
   *  modal's render site below. */
  financingPrequalUrl?: string;
};

export function StickyBottomBar({
  quoteId,
  approved = false,
  booked = false,
  checkoutEnabled = false,
  approvedDepositUsd,
  isTest = false,
  viewOnly = false,
  quoteStatus,
  serviceType,
  financingPrequalUrl,
}: StickyBottomBarProps) {
  const {
    activeName,
    currentTotal,
    currentDeposit,
    currentSubtotal,
    meetsMinimum,
    amountToMinimum,
    minimumOrderSubtotal,
    rushSelected,
    takedownSelected,
    packageId,
    selectedItemIds,
    colorSchemeId,
    customPattern,
    permanentEffect,
    installTiming,
    breakdown,
  } = useSelection();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // #38 — when the customer-checkout flag is on (server-computed, passed as a
  // prop), Approve opens the embedded deposit checkout instead of routing to the
  // booked page. Off by default (the code ships dark; flipped on after testing).
  const [showCheckout, setShowCheckout] = useState(false);
  // #83 Slice B — the "Confirm & sign" step shown before the approve POST, and
  // the captured signature it collects (the customer's typed full name).
  const [showSign, setShowSign] = useState(false);
  const [signature, setSignature] = useState<CapturedSignature | null>(null);
  // #83 Slice B — the Decline / Request-changes modal (null = none open).
  const [responseIntent, setResponseIntent] = useState<ResponseIntent | null>(null);
  const router = useRouter();

  // PostHog v1 Wave 1 — once-per-open guards for approve_abandoned. Reset
  // whenever the corresponding modal opens; resolved by a confirmed
  // success/409 so closing afterward doesn't count as an abandon.
  const signAbandonGuard = useRef<AbandonGuard>(openAbandonGuard());
  const depositAbandonGuard = useRef<AbandonGuard>(openAbandonGuard());

  // #93 — a test quote ALWAYS uses the deposit-checkout flow (which posts to
  // /simulate-deposit), even when the real Valor checkout is off. For a real
  // quote this is exactly `checkoutEnabled`, so existing behavior is unchanged.
  const depositFlow = checkoutEnabled || isTest;

  // Fire a one-shot "interested" signal when the customer DELIBERATELY engages
  // the Approve button — a sustained hover (desktop) or a focus/tap (mobile) —
  // without necessarily approving. Surfaces as an "Interested" row on the staff
  // activity feed. Fire-and-forget + ref-guarded so it posts at most once.
  // The listeners live on a wrapper span (below), not the button, so they still
  // fire when the button is DISABLED (selection under the $1,000 minimum) — the
  // strongest "leaning in" signal. A ~500ms dwell on hover avoids false-positives
  // from a cursor incidentally passing over the always-present sticky bar; focus
  // (deliberate keyboard/tap) fires immediately.
  const interestFiredRef = useRef(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagInterest = () => {
    if (interestFiredRef.current) return;
    interestFiredRef.current = true;
    fetch(`/api/quotes/${encodeURIComponent(quoteId)}/interested`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      keepalive: true,
    }).catch(() => {
      /* best-effort — must never disrupt the customer */
    });
  };
  const startHoverIntent = () => {
    if (interestFiredRef.current || hoverTimerRef.current) return;
    hoverTimerRef.current = setTimeout(flagInterest, 500);
  };
  const cancelHoverIntent = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };
  useEffect(() => cancelHoverIntent, []);

  // #176 — view-only takes precedence over every other bar state (pending
  // payment / dead approval / booked / the live approve bar below). A
  // view-only quote can never reach any of those states server-side (the
  // /approve, /pay, /decline, /request-changes routes all 409 first), but
  // this checks it directly rather than relying on that invariant, and it
  // must never mount DepositCheckout/SignModal/QuoteResponseModal.
  if (viewOnly) {
    const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
    const { label, telHref } = viewOnlyBrowsingCopy(phone);
    return (
      <div className="portal-snow-sticky" role="region" aria-label="Browsing only">
        <span className="text-[13px] md:text-[14px] text-[#A89F87]">
          {label}{' '}
          <a href={telHref} className="text-[#FFD07A] font-semibold hover:underline">
            {phone}
          </a>
        </span>
      </div>
    );
  }

  // Real approval: POST the selection to /api/quotes/[id]/approve, which freezes
  // the snapshot. Then, with the checkout flag ON, open the embedded 50% deposit
  // checkout (payment — not the click — is what books the quote; Valor's webhook
  // flips it to booked + fires the receipt). With the flag OFF, fall back to
  // today's behavior: navigate to the celebration page (the approve route having
  // texted/emailed the customer about collecting the deposit).
  const onApprove = async (sig: CapturedSignature) => {
    if (!canSubmitApproval(submitting, meetsMinimum)) return;
    setSubmitting(true);
    setErrorMsg(null);
    // PostHog v1 Wave 1 — the HTTP status of a received response (undefined
    // means the failure was before any response, i.e. network-level), read by
    // the catch block below to bucket approve_error's `category`.
    let failureStatus: number | undefined;
    try {
      const res = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildApprovePayload(
            {
              packageId,
              selectedItemIds,
              activeName,
              currentTotal,
              currentDeposit,
              rushSelected,
              takedownSelected,
              colorSchemeId,
              customPattern,
              permanentEffect,
              installTiming,
              breakdown,
            },
            sig,
          ),
        ),
      });
      failureStatus = res.status;
      // 409 covers two different server states (approve/route.ts): 'already-approved'
      // (idempotent re-click — the customer really did already approve this
      // selection) and 'illegal-transition' (the quote moved to declined/
      // cancelled/changes_requested since the page loaded). Only the former is a
      // success case; treating every 409 as "already approved" and navigating
      // forward dead-ended a declined/changes-requested customer on /approved
      // with no approval on record (PS-D1). Fall through to the generic error
      // handling below for any other code.
      if (res.status === 409) {
        const body409 = await res.json().catch(() => ({}) as { code?: string; error?: string });
        if (isAlreadyApprovedCode(body409.code)) {
          // PostHog v1 Wave 1 — resolves the sign-modal guard so this doesn't
          // read as an abandon; not a fresh approval either, so no quote_approved.
          resolveAbandonGuard(signAbandonGuard.current);
          setShowSign(false);
          if (depositFlow) {
            depositAbandonGuard.current = openAbandonGuard();
            setShowCheckout(true);
            setSubmitting(false);
          } else {
            router.push(`/portal/${quoteId}/approved`);
          }
          return;
        }
        throw new Error(body409.error ?? `Request failed: ${res.status}`);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      // Approval recorded. Close the sign step, then deposit flow → open the
      // embedded 50% deposit checkout (real Valor, or simulated for a test
      // quote); otherwise → celebration page (the pre-Valor placeholder flow).
      // PostHog v1 Wave 1 — resolves the sign-modal guard before it closes, so
      // the close doesn't read as an abandon.
      resolveAbandonGuard(signAbandonGuard.current);
      setShowSign(false);
      // PostHog v1 — fires once per confirmed approval (the 409 "already
      // approved" branch above does NOT fire this, since it isn't a fresh
      // approval from this submission).
      track('quote_approved', { quote_id: quoteId, service_type: serviceType, total: currentTotal });
      if (depositFlow) {
        depositAbandonGuard.current = openAbandonGuard();
        setShowCheckout(true);
        setSubmitting(false);
      } else {
        router.push(`/portal/${quoteId}/approved`);
      }
    } catch (err) {
      // Audit fix (g10): never surface the raw server/network error to the
      // customer — it leaks internals like "Supabase service role not configured",
      // Postgres messages, or "Failed to fetch". Log for debugging, show fixed
      // friendly copy that helps them recover (retry or text us).
      console.error('approve failed', err);
      // PostHog v1 Wave 1 — category only (never the raw message/err above).
      track('approve_error', {
        quote_id: quoteId,
        service_type: serviceType,
        stage: 'approve',
        category: categorizeApproveError(failureStatus, err),
      });
      const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
      setErrorMsg(
        `We couldn't record your approval just now — please try again, or text us at ${phone}.`,
      );
      setSubmitting(false);
    }
  };

  // PostHog v1 Wave 1 — shared close handler for both DepositCheckout render
  // sites below: fires approve_abandoned (reached_deposit: true) once per open
  // when the customer backs out before a completed payment. DepositCheckout's
  // own success paths (redirect to Valor, simulated-deposit booked, already-paid
  // 409) all navigate away directly and never call onClose, so there's no
  // "resolve" call to make here — every real invocation of this is an abandon.
  const closeDepositCheckout = () => {
    if (consumeAbandonOnClose(depositAbandonGuard.current)) {
      track('approve_abandoned', { quote_id: quoteId, service_type: serviceType, reached_deposit: true });
    }
    setShowCheckout(false);
  };

  // #38 — approved but the deposit isn't paid yet (online checkout on). Show a
  // "complete your deposit" bar that re-opens the hosted checkout. The selection
  // is already frozen, so we go straight to the checkout (no re-approve).
  // Bug fix (audit W4-013): also require the quote's LIVE status to still be
  // actionable. Without this, an approved-but-unpaid quote that staff then
  // cancel/decline still rendered this actionable "Complete deposit" button —
  // clicking it hit the /pay 409 guard, whose handler treats every 409 as
  // "already paid" and routes the customer to the booked celebration page for
  // a dead order. isPortalActionable(undefined) is true (fail-open), so this
  // is a no-op for quotes that don't pass quoteStatus down.
  const pendingPayment = approved && !booked && depositFlow && isPortalActionable(quoteStatus);
  if (pendingPayment) {
    return (
      <>
        {showCheckout && (
          <DepositCheckout
            quoteId={quoteId}
            isTest={isTest}
            serviceType={serviceType}
            onClose={closeDepositCheckout}
          />
        )}
        <div className="portal-snow-sticky" role="region" aria-label="Complete your deposit">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="portal-snow-price font-display text-[17px] md:text-[20px] font-bold text-[#F4ECD8]">
              {formatUsd(approvedDepositUsd ?? currentDeposit)}
            </span>
            <span className="text-[11px] md:text-[12px] text-[#A89F87] whitespace-nowrap">
              {isTest ? 'simulated deposit to test the booking flow' : 'deposit due to lock in your install'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              // PostHog v1 Wave 1 — this re-opens the deposit checkout fresh
              // (e.g. after a page reload), so it's its own "open" for the
              // abandon-once guard.
              depositAbandonGuard.current = openAbandonGuard();
              setShowCheckout(true);
            }}
            aria-label={isTest ? 'Simulate deposit paid' : 'Complete your deposit'}
            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 md:px-5 py-2.5 md:py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[13px] md:text-[14px] cursor-pointer transition-[background-color,transform] duration-200 hover:bg-[#D8434F] active:scale-[0.98] shadow-[0_0_22px_rgba(200,49,61,0.35),0_6px_18px_-4px_rgba(200,49,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F]"
          >
            {isTest ? 'Simulate deposit paid' : 'Complete deposit'}
            <ArrowRight className="w-4 h-4" aria-hidden />
          </button>
        </div>
      </>
    );
  }

  // Bug fix (audit W4-013): approved, never paid, and now cancelled/declined —
  // the case pendingPayment above just excluded. Show a plain non-actionable
  // notice instead of falling through to the full interactive Approve/Decline
  // bar below (which would let the customer "approve" a quote staff already
  // killed). Booked (deposit already paid) quotes are unaffected — money
  // already moved, so cancellation afterward still shows the booked bar.
  const deadApproval = approved && !booked && depositFlow && !isPortalActionable(quoteStatus);
  if (deadApproval) {
    return (
      <div className="portal-snow-sticky" role="region" aria-label="Quote no longer available">
        <span className="text-[13px] md:text-[14px] text-[#A89F87]">
          This quote is no longer available. Questions? Just reach out.
        </span>
      </div>
    );
  }

  // #43/#38 — booked: deposit paid (checkout on) or simply approved (checkout
  // off). Show a non-actionable "booked" state with a link to the confirmation
  // page. (Hooks above still run unconditionally; this just swaps the bar.)
  if (booked) {
    return (
      <div className="portal-snow-sticky" role="region" aria-label="Booking confirmation">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-display text-[15px] md:text-[17px] font-bold text-[#F4ECD8]">
            ✓ You&apos;re booked
          </span>
          <span className="text-[11px] md:text-[12px] text-[#A89F87] whitespace-nowrap">
            {depositFlow ? 'your deposit is in' : "we'll be in touch about your deposit"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => router.push(`/portal/${quoteId}/approved`)}
          aria-label="View your booking confirmation"
          className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 md:px-5 py-2.5 md:py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[13px] md:text-[14px] cursor-pointer transition-[background-color,transform] duration-200 hover:bg-[#D8434F] active:scale-[0.98] shadow-[0_0_22px_rgba(200,49,61,0.35),0_6px_18px_-4px_rgba(200,49,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F]"
        >
          View confirmation
          <ArrowRight className="w-4 h-4" aria-hidden />
        </button>
      </div>
    );
  }

  // Shared bar pieces, placed into a mobile (taller, two-row) and a desktop
  // (single-row) layout below (S22, per Jason: on phones the totals sit on top,
  // Request-changes + Decline below, and Approve to the right). Only one layout
  // is visible at a time (the sm breakpoint), and the component-level interest
  // ref-guard keeps the "interested" ping single regardless of which Approve fires.
  const totalsBlock = (
    <div className="flex items-baseline gap-x-2 gap-y-0.5 min-w-0 flex-wrap">
      <span className="portal-snow-price font-display text-[17px] md:text-[20px] font-bold text-[#F4ECD8]">
        {formatUsd(currentTotal)}
      </span>
      <span className="text-[11px] md:text-[12px] text-[#A89F87]">
        incl. tax · <span className="tabular-nums text-[#FFD07A]">{formatUsd(currentDeposit)}</span> deposit
      </span>
    </div>
  );
  const requestChangesBtn = (
    <button
      type="button"
      onClick={() => setResponseIntent('request-changes')}
      aria-label="Request changes to this quote"
      className="inline-flex items-center justify-center min-h-[44px] px-2 sm:px-3 py-2 rounded-full text-[12px] md:text-[13px] text-[#A89F87] hover:text-[#F4ECD8] underline-offset-2 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] whitespace-nowrap"
    >
      Request changes
    </button>
  );
  const declineBtn = (
    <button
      type="button"
      onClick={() => setResponseIntent('decline')}
      aria-label="Decline this quote"
      className="inline-flex items-center justify-center min-h-[44px] px-2 sm:px-3 py-2 rounded-full text-[12px] md:text-[13px] text-[#A89F87] hover:text-[#F4ECD8] underline-offset-2 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744]"
    >
      Decline
    </button>
  );
  const approveBtn = (
    <span
      className="inline-flex shrink-0"
      onMouseEnter={startHoverIntent}
      onMouseLeave={cancelHoverIntent}
      onFocus={flagInterest}
    >
      <button
        type="button"
        onClick={() => {
          setErrorMsg(null);
          // PostHog v1 Wave 1 — fresh guard for this open, then the funnel event.
          signAbandonGuard.current = openAbandonGuard();
          setShowSign(true);
          track('approve_started', { quote_id: quoteId, service_type: serviceType });
        }}
        disabled={submitting || !meetsMinimum}
        aria-label="Approve quote"
        aria-describedby={!errorMsg && !meetsMinimum ? 'approve-minimum-nudge' : undefined}
        className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 md:px-5 py-2.5 md:py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[13px] md:text-[14px] cursor-pointer transition-[background-color,transform] duration-200 hover:bg-[#D8434F] active:scale-[0.98] shadow-[0_0_22px_rgba(200,49,61,0.35),0_6px_18px_-4px_rgba(200,49,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Approve
        <ArrowRight className="w-4 h-4" aria-hidden />
      </button>
    </span>
  );

  return (
    <>
      {showCheckout && (
        <DepositCheckout
          quoteId={quoteId}
          isTest={isTest}
          serviceType={serviceType}
          onClose={closeDepositCheckout}
        />
      )}
      {/* #83 Slice B — "Confirm & sign" step. Captures the e-signature, then
          runs the existing approve POST with it. The signature is required
          (the customer's typed full name). */}
      {showSign && (
        <SignModal
          submitting={submitting}
          errorMsg={errorMsg}
          signature={signature}
          onSignatureChange={setSignature}
          onCancel={() => {
            // PostHog v1 Wave 1 — closed without a successful approval this
            // open → approve_abandoned once; a success/409 already resolved
            // the guard above, so this is a no-op fire in that case.
            if (consumeAbandonOnClose(signAbandonGuard.current)) {
              track('approve_abandoned', {
                quote_id: quoteId,
                service_type: serviceType,
                reached_deposit: false,
              });
            }
            setShowSign(false);
            setErrorMsg(null);
          }}
          onConfirm={() => {
            if (signature) onApprove(signature);
          }}
          total={currentTotal}
          deposit={currentDeposit}
          // #154 interim — Wisetack financing CTA under the deposit line.
          // Positive gate on the LIVE selection: the server-threaded prequal
          // URL must exist (flag on + URL configured), the service type must
          // be holiday, permanent, or permanent_bistro, the job total at
          // least $1,500 (YLL floor,
          // Naldo 2026-07-18), and the live balance (total − deposit, the
          // SAME numbers the modal displays) must sit in [$500, $25,000].
          // Informational link only — the pay flow and money math are untouched.
          financingUrl={
            isFinancingEligible({
              enabled: financingPrequalUrl != null,
              serviceType,
              totalUsd: currentTotal,
              balanceUsd: financedBalanceUsd(currentTotal, currentDeposit),
            })
              ? financingPrequalUrl
              : undefined
          }
        />
      )}
      {/* #83 Slice B — Decline / Request-changes modals. */}
      {responseIntent && (
        <QuoteResponseModal
          quoteId={quoteId}
          intent={responseIntent}
          serviceType={serviceType}
          onClose={() => setResponseIntent(null)}
        />
      )}
      <div
        className="portal-snow-sticky"
        role="region"
        aria-label="Approval bar with live total"
      >
      {errorMsg && (
        <p
          role="alert"
          className="absolute -top-11 left-0 right-0 mx-auto max-w-fit text-[12px] text-[#F4ECD8] bg-[#7A1C24] border border-[#C8313D]/50 rounded-md px-3 py-1.5 shadow-lg"
        >
          {errorMsg}
        </p>
      )}
      {/* Minimum-order gate nudge — shown until the selection reaches the
       * order minimum (the Approve button stays disabled until then).
       * a11y fix (W4-014): role="status"/aria-live so screen-reader users are
       * told why Approve is disabled (a disabled button can't be focused, so
       * this is the only way they'd otherwise learn it); id + the Approve
       * button's aria-describedby ties the two together. */}
      {!errorMsg && !meetsMinimum && (
        <p
          id="approve-minimum-nudge"
          role="status"
          aria-live="polite"
          className="absolute -top-11 left-0 right-0 mx-auto max-w-fit text-[12px] text-[#F4ECD8] bg-[#0D1519] border border-[#FFB744]/40 rounded-md px-3 py-1.5 shadow-lg whitespace-nowrap"
        >
          {currentSubtotal <= 0
            ? 'Select at least one item to continue'
            : `Add ${formatUsd(amountToMinimum)} more to reach the ${formatUsd(minimumOrderSubtotal)} minimum`}
        </p>
      )}
      {/* Mobile (< sm): a taller bar — totals on top, Request-changes + Decline
          below, Approve to the right (S22, per Jason). The full-width + squared
          shape comes from the .portal-snow-sticky mobile media query. */}
      <div className="flex sm:hidden items-center gap-3 w-full">
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {totalsBlock}
          <div className="flex items-center gap-1">
            {requestChangesBtn}
            {declineBtn}
          </div>
        </div>
        {approveBtn}
      </div>

      {/* Desktop (sm+): the original single-row pill — totals, then the secondary
          responses + the primary Approve. */}
      <div className="hidden sm:flex items-center gap-3">
        {totalsBlock}
        <div className="flex items-center gap-2">
          {requestChangesBtn}
          {declineBtn}
          {approveBtn}
        </div>
      </div>
      </div>
    </>
  );
}

// #83 Slice B — the "Confirm & sign" modal. A thin dark-theme shell around the
// SignaturePad. Approve is gated on a captured signature (the customer's typed
// full name). Errors from the approve POST surface here so the customer can
// retry without losing what they signed.
function SignModal({
  submitting,
  errorMsg,
  signature,
  onSignatureChange,
  onCancel,
  onConfirm,
  total,
  deposit,
  financingUrl,
}: {
  submitting: boolean;
  errorMsg: string | null;
  signature: CapturedSignature | null;
  onSignatureChange: (sig: CapturedSignature | null) => void;
  onCancel: () => void;
  onConfirm: () => void;
  total: number;
  deposit: number;
  /** #154 interim — the Wisetack prequal link, present only when this quote's
   *  live selection is financing-eligible (gated by the caller). */
  financingUrl?: string;
}) {
  // a11y fix (W4-015): move focus into the dialog on open, trap Tab within
  // it, and restore focus to the Approve button (the trigger) on close.
  const dialogRef = useModalFocus<HTMLDivElement>();
  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm and sign"
    >
      <div className="w-full max-w-md rounded-2xl bg-[#0D1519] border border-[#FFB744]/30 shadow-2xl p-6 text-[#F4ECD8] max-h-[90vh] overflow-y-auto">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="font-display text-[20px] font-bold">Approve &amp; sign</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="text-[#A89F87] hover:text-[#F4ECD8] text-[13px] underline cursor-pointer min-h-[44px] inline-flex items-center"
          >
            Cancel
          </button>
        </div>
        <p className="text-[13px] text-[#A89F87]">
          You&apos;re approving <span className="text-[#F4ECD8] font-semibold">{formatUsd(total)}</span>{' '}
          (incl. tax) with a{' '}
          <span className="text-[#FFD07A] font-semibold">{formatUsd(deposit)}</span> deposit. Sign
          below to confirm.
        </p>

        {/* #154 interim — financing option for the balance, under the deposit
            line. Renders ONLY when the caller found this selection eligible;
            purely informational (the approve/pay flow is untouched). */}
        {financingUrl && <FinancingCta url={financingUrl} />}

        <SignaturePad onChange={onSignatureChange} />

        {errorMsg && (
          <p
            role="alert"
            className="mt-3 text-[13px] text-[#F4ECD8] bg-[#7A1C24] border border-[#C8313D]/50 rounded-md px-3 py-2"
          >
            {errorMsg}
          </p>
        )}

        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting || !signature}
          className="mt-4 w-full inline-flex items-center justify-center gap-1.5 min-h-[44px] px-5 py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[14px] cursor-pointer hover:bg-[#D8434F] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <span
                aria-hidden
                className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[#F4ECD8]/30 border-t-[#F4ECD8] animate-spin"
              />
              Approving…
            </>
          ) : (
            <>
              Confirm approval
              <ArrowRight className="w-4 h-4" aria-hidden />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
