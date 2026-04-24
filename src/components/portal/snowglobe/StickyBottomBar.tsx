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
  const { currentTotal, currentDeposit } = useSelection();
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  const onApprove = async () => {
    if (submitting) return;
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 400));
    router.push(`/portal-snowglobe/${quoteId}/approved`);
  };

  return (
    <div
      className="portal-snow-sticky"
      role="region"
      aria-label="Approval bar with live total"
    >
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="portal-snow-price font-display text-[17px] md:text-[20px] font-bold text-[#F4ECD8]">
          {formatUsd(currentTotal)}
        </span>
        <span className="text-[11px] md:text-[12px] text-[#A89F87] whitespace-nowrap">
          · <span className="tabular-nums text-[#FFD07A]">{formatUsd(currentDeposit)}</span> today
        </span>
      </div>

      <button
        type="button"
        onClick={onApprove}
        disabled={submitting || currentTotal <= 0}
        aria-label={`Approve quote and pay ${formatUsd(currentDeposit)} deposit`}
        className="inline-flex items-center gap-1.5 px-4 md:px-5 py-2.5 md:py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[13px] md:text-[14px] cursor-pointer transition-[background-color,transform] duration-200 hover:bg-[#D8434F] active:scale-[0.98] shadow-[0_0_22px_rgba(200,49,61,0.35),0_6px_18px_-4px_rgba(200,49,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F] disabled:opacity-50 disabled:cursor-not-allowed"
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
