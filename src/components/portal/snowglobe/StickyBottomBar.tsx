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
import { DepositCheckout } from './DepositCheckout';

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
};

export function StickyBottomBar({
  quoteId,
  approved = false,
  booked = false,
  checkoutEnabled = false,
  approvedDepositUsd,
}: StickyBottomBarProps) {
  const {
    activeName,
    currentTotal,
    currentDeposit,
    currentSubtotal,
    meetsMinimum,
    amountToMinimum,
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
  const router = useRouter();

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
  const onApprove = async () => {
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
        }),
      });
      // 409 = already approved. With checkout ON, open the deposit checkout
      // anyway (/pay routes onward if the deposit is already paid); with it OFF,
      // route straight to the celebration page (today's behavior).
      if (res.status === 409) {
        if (checkoutEnabled) {
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
      // Approval recorded. ON → open the embedded 50% deposit checkout; OFF →
      // celebration page (the pre-Valor placeholder flow).
      if (checkoutEnabled) {
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
  const pendingPayment = approved && !booked && checkoutEnabled;
  if (pendingPayment) {
    return (
      <>
        {showCheckout && (
          <DepositCheckout quoteId={quoteId} onClose={() => setShowCheckout(false)} />
        )}
        <div className="portal-snow-sticky" role="region" aria-label="Complete your deposit">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="portal-snow-price font-display text-[17px] md:text-[20px] font-bold text-[#F4ECD8]">
              {formatUsd(approvedDepositUsd ?? currentDeposit)}
            </span>
            <span className="text-[11px] md:text-[12px] text-[#A89F87] whitespace-nowrap">
              deposit due to lock in your install
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowCheckout(true)}
            aria-label="Complete your deposit"
            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 md:px-5 py-2.5 md:py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[13px] md:text-[14px] cursor-pointer transition-[background-color,transform] duration-200 hover:bg-[#D8434F] active:scale-[0.98] shadow-[0_0_22px_rgba(200,49,61,0.35),0_6px_18px_-4px_rgba(200,49,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F]"
          >
            Complete deposit
            <ArrowRight className="w-4 h-4" aria-hidden />
          </button>
        </div>
      </>
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
            {checkoutEnabled ? 'your deposit is in' : "we'll be in touch about your deposit"}
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
        <DepositCheckout quoteId={quoteId} onClose={() => setShowCheckout(false)} />
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
       * $1,000 order minimum (the Approve button stays disabled until then). */}
      {!errorMsg && !meetsMinimum && (
        <p className="absolute -top-11 left-0 right-0 mx-auto max-w-fit text-[12px] text-[#F4ECD8] bg-[#0D1519] border border-[#FFB744]/40 rounded-md px-3 py-1.5 shadow-lg whitespace-nowrap">
          {currentSubtotal <= 0
            ? 'Select at least one item to continue'
            : `Add ${formatUsd(amountToMinimum)} more to reach the $1,000 minimum`}
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

      {/* Wrapper carries the interest listeners so they fire even when the
          button is disabled (under the $1,000 minimum). */}
      <span
        className="inline-flex"
        onMouseEnter={startHoverIntent}
        onMouseLeave={cancelHoverIntent}
        onFocus={flagInterest}
      >
      <button
        type="button"
        onClick={onApprove}
        disabled={submitting || !meetsMinimum}
        aria-label="Approve quote"
        className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 md:px-5 py-2.5 md:py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[13px] md:text-[14px] cursor-pointer transition-[background-color,transform] duration-200 hover:bg-[#D8434F] active:scale-[0.98] shadow-[0_0_22px_rgba(200,49,61,0.35),0_6px_18px_-4px_rgba(200,49,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? (
          <>
            <span
              aria-hidden
              className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[#F4ECD8]/30 border-t-[#F4ECD8] animate-spin"
            />
            {/* Audit fix (g10): "Opening" misrepresented a network-bound DB+notify
                request that can fail; "Approving…" reflects what's happening. */}
            Approving…
          </>
        ) : (
          <>
            Approve
            <ArrowRight className="w-4 h-4" aria-hidden />
          </>
        )}
      </button>
      </span>
      </div>
    </>
  );
}
