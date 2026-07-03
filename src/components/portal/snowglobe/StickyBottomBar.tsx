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
  /** Bug fix (audit W4-013) — the quote's live lifecycle status
   *  (deriveStatus), passed down so the "Complete deposit" bar can be
   *  suppressed once staff cancel/decline an approved-but-unpaid quote. The
   *  page-level dead-quote gate skips itself once `approved` is true (so a
   *  booked-then-cancelled quote still shows its confirmation), so this is
   *  the only place left to catch "approved, unpaid, then killed". Undefined
   *  is treated as actionable (fail-open — matches isPortalActionable). */
  quoteStatus?: string | null;
};

export function StickyBottomBar({
  quoteId,
  approved = false,
  booked = false,
  checkoutEnabled = false,
  approvedDepositUsd,
  isTest = false,
  quoteStatus,
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
  // the captured signature it collects (typed name baseline / drawn canvas).
  const [showSign, setShowSign] = useState(false);
  const [signature, setSignature] = useState<CapturedSignature | null>(null);
  // #83 Slice B — the Decline / Request-changes modal (null = none open).
  const [responseIntent, setResponseIntent] = useState<ResponseIntent | null>(null);
  const router = useRouter();

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

  // Real approval: POST the selection to /api/quotes/[id]/approve, which freezes
  // the snapshot. Then, with the checkout flag ON, open the embedded 50% deposit
  // checkout (payment — not the click — is what books the quote; Valor's webhook
  // flips it to booked + fires the receipt). With the flag OFF, fall back to
  // today's behavior: navigate to the celebration page (the approve route having
  // texted/emailed the customer about collecting the deposit).
  const onApprove = async (sig: CapturedSignature) => {
    if (submitting || !meetsMinimum) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId,
          selectedItemIds: Array.from(selectedItemIds),
          activeName,
          currentTotal,
          currentDeposit,
          rushSelected,
          takedownSelected,
          colorSchemeId,
          customPattern,
          installTiming,
          installDiscountUsd: breakdown.discount,
          // #83 Slice B — the e-signature captured in the "Confirm & sign" step.
          signature: { name: sig.name, kind: sig.kind, value: sig.value },
        }),
      });
      // 409 = already approved. With checkout ON, open the deposit checkout
      // anyway (/pay routes onward if the deposit is already paid); with it OFF,
      // route straight to the celebration page (today's behavior).
      if (res.status === 409) {
        setShowSign(false);
        if (depositFlow) {
          setShowCheckout(true);
          setSubmitting(false);
        } else {
          router.push(`/portal/${quoteId}/approved`);
        }
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      // Approval recorded. Close the sign step, then deposit flow → open the
      // embedded 50% deposit checkout (real Valor, or simulated for a test
      // quote); otherwise → celebration page (the pre-Valor placeholder flow).
      setShowSign(false);
      if (depositFlow) {
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
      const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
      setErrorMsg(
        `We couldn't record your approval just now — please try again, or text us at ${phone}.`,
      );
      setSubmitting(false);
    }
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
          <DepositCheckout quoteId={quoteId} isTest={isTest} onClose={() => setShowCheckout(false)} />
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
            onClick={() => setShowCheckout(true)}
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

  return (
    <>
      {showCheckout && (
        <DepositCheckout quoteId={quoteId} isTest={isTest} onClose={() => setShowCheckout(false)} />
      )}
      {/* #83 Slice B — "Confirm & sign" step. Captures the e-signature, then
          runs the existing approve POST with it. The signature is required
          (typed name baseline; drawn canvas optional). */}
      {showSign && (
        <SignModal
          submitting={submitting}
          errorMsg={errorMsg}
          signature={signature}
          onSignatureChange={setSignature}
          onCancel={() => {
            setShowSign(false);
            setErrorMsg(null);
          }}
          onConfirm={() => {
            if (signature) onApprove(signature);
          }}
          total={currentTotal}
          deposit={currentDeposit}
        />
      )}
      {/* #83 Slice B — Decline / Request-changes modals. */}
      {responseIntent && (
        <QuoteResponseModal
          quoteId={quoteId}
          intent={responseIntent}
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
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="portal-snow-price font-display text-[17px] md:text-[20px] font-bold text-[#F4ECD8]">
          {formatUsd(currentTotal)}
        </span>
        <span className="text-[11px] md:text-[12px] text-[#A89F87] whitespace-nowrap">
          incl. tax · <span className="tabular-nums text-[#FFD07A]">{formatUsd(currentDeposit)}</span> deposit
        </span>
      </div>

      {/* Actions: secondary Decline / Request-changes + the primary Approve.
          The wrapper carries the interest listeners so they fire even when the
          Approve button is disabled (under the $1,000 minimum). */}
      <div className="flex items-center gap-2">
        {/* #83 Slice B — secondary customer responses. Compact, lower-emphasis
            than Approve; always available pre-approval. */}
        <button
          type="button"
          onClick={() => setResponseIntent('request-changes')}
          aria-label="Request changes to this quote"
          className="hidden sm:inline-flex items-center justify-center min-h-[44px] px-3 py-2 rounded-full text-[12px] md:text-[13px] text-[#A89F87] hover:text-[#F4ECD8] underline-offset-2 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744]"
        >
          Request changes
        </button>
        <button
          type="button"
          onClick={() => setResponseIntent('decline')}
          aria-label="Decline this quote"
          className="inline-flex items-center justify-center min-h-[44px] px-3 py-2 rounded-full text-[12px] md:text-[13px] text-[#A89F87] hover:text-[#F4ECD8] underline-offset-2 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744]"
        >
          Decline
        </button>
        <span
          className="inline-flex"
          onMouseEnter={startHoverIntent}
          onMouseLeave={cancelHoverIntent}
          onFocus={flagInterest}
        >
          <button
            type="button"
            onClick={() => {
              setErrorMsg(null);
              setShowSign(true);
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
      </div>
      </div>
    </>
  );
}

// #83 Slice B — the "Confirm & sign" modal. A thin dark-theme shell around the
// SignaturePad. Approve is gated on a captured signature (typed name baseline,
// drawn canvas optional). Errors from the approve POST surface here so the
// customer can retry without losing what they signed.
function SignModal({
  submitting,
  errorMsg,
  signature,
  onSignatureChange,
  onCancel,
  onConfirm,
  total,
  deposit,
}: {
  submitting: boolean;
  errorMsg: string | null;
  signature: CapturedSignature | null;
  onSignatureChange: (sig: CapturedSignature | null) => void;
  onCancel: () => void;
  onConfirm: () => void;
  total: number;
  deposit: number;
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
