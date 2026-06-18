'use client';

// Portal v6 — StickyBottomBar. Floating-pill variant (not full-width)
// that hovers center-bottom with heavy backdrop-blur. Reads live
// selection from context so the price + deposit stay in sync with
// the InteractiveHero's tabs.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';

export type StickyBottomBarProps = {
  quoteId: string;
};

export function StickyBottomBar({ quoteId }: StickyBottomBarProps) {
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
    installTiming,
    breakdown,
  } = useSelection();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const router = useRouter();

  // Real approval: POST the selection to /api/quotes/[id]/approve, which
  // freezes the snapshot + fires the home.works Zapier webhook + advances
  // the HighLevel pipeline. Navigate to the celebration page on any ok=true
  // (even if home.works delivery failed — the approval is still recorded).
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
          installTiming,
          installDiscountUsd: breakdown.discount,
        }),
      });
      // 409 = already approved — still route to the celebration page.
      if (res.status === 409) {
        router.push(`/portal/${quoteId}/approved`);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      router.push(`/portal/${quoteId}/approved`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong — please try again.');
      setSubmitting(false);
    }
  };

  return (
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
          incl. tax · <span className="tabular-nums text-[#FFD07A]">{formatUsd(currentDeposit)}</span> today
        </span>
      </div>

      <button
        type="button"
        onClick={onApprove}
        disabled={submitting || !meetsMinimum}
        aria-label={`Approve quote and pay ${formatUsd(currentDeposit)} deposit`}
        className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 md:px-5 py-2.5 md:py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[13px] md:text-[14px] cursor-pointer transition-[background-color,transform] duration-200 hover:bg-[#D8434F] active:scale-[0.98] shadow-[0_0_22px_rgba(200,49,61,0.35),0_6px_18px_-4px_rgba(200,49,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? (
          <>
            <span
              aria-hidden
              className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[#F4ECD8]/30 border-t-[#F4ECD8] animate-spin"
            />
            Opening
          </>
        ) : (
          <>
            Approve
            <ArrowRight className="w-4 h-4" aria-hidden />
          </>
        )}
      </button>
    </div>
  );
}
