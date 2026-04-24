'use client';

// Portal v2 DARK — Sticky bottom CTA. Always visible. Reads live
// package + total from SelectionContext. This is the ONE place red
// shows up as the primary CTA (because that's when it matters most).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';

export type StickyBottomBarProps = {
  quoteId: string;
};

export function StickyBottomBar({ quoteId }: StickyBottomBarProps) {
  const { activeName, currentTotal, currentDeposit } = useSelection();
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  const onApprove = async () => {
    if (submitting) return;
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 400));
    router.push(`/portal-dark/${quoteId}/approved`);
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 bg-[#0B140F]/92 backdrop-blur-md border-t border-[#243029] shadow-[0_-8px_32px_-8px_rgba(0,0,0,0.65)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 md:py-4">
        <div className="flex items-center justify-between gap-3 md:gap-6">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] truncate">
              {activeName}
            </p>
            <p className="flex items-baseline gap-2 mt-0.5 truncate">
              <span className="font-display text-[22px] md:text-[28px] font-bold text-[#F4ECD8] tabular-nums tracking-[-0.02em]">
                {formatUsd(currentTotal)}
              </span>
              <span className="text-[12px] md:text-[13px] text-[#A89F87] truncate">
                · <span className="tabular-nums text-[#E0D7C1]">{formatUsd(currentDeposit)}</span> deposit
              </span>
            </p>
          </div>

          <div className="flex flex-col items-end">
            <button
              type="button"
              onClick={onApprove}
              disabled={submitting || currentTotal <= 0}
              aria-label={`Approve quote and pay ${formatUsd(currentDeposit)} deposit`}
              className="inline-flex items-center justify-center gap-2 px-5 md:px-7 py-3 md:py-3.5 rounded-xl bg-[#C8313D] text-[#F4ECD8] font-semibold text-[15px] md:text-[16px] cursor-pointer transition-[background-color,box-shadow,transform] duration-200 hover:bg-[#D8434F] active:scale-[0.98] shadow-[0_0_18px_rgba(200,49,61,0.35),0_6px_16px_-4px_rgba(200,49,61,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              {submitting ? (
                <>
                  <span
                    aria-hidden
                    className="inline-block w-4 h-4 rounded-full border-2 border-[#F4ECD8]/30 border-t-[#F4ECD8] animate-spin"
                  />
                  Opening…
                </>
              ) : (
                <>Approve &amp; Pay Deposit</>
              )}
            </button>
            <button
              type="button"
              onClick={() => { /* hook up reminder email later */ }}
              className="mt-1 text-[11px] md:text-[12px] text-[#A89F87] underline underline-offset-2 cursor-pointer hover:text-[#E0D7C1] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F] rounded-sm"
            >
              Save for later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
