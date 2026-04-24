'use client';

// Sticky Bottom Bar — the primary conversion surface. Always visible.
// Reads current package + total from SelectionContext so it updates
// live as items toggle.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSelection } from './SelectionContext';
import { formatUsd } from './format';

export type StickyBottomBarProps = {
  quoteId: string;
};

export function StickyBottomBar({ quoteId }: StickyBottomBarProps) {
  const { activeName, currentTotal, currentDeposit, packageId, selectedItemIds } = useSelection();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const router = useRouter();

  const onApprove = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);

    // Send the customer's current selection to the approval endpoint.
    // The server freezes the snapshot + fires the Zapier webhook to
    // home.works. Response shape:
    //   { ok: true, homeworksOk: boolean, homeworksReason?: string }
    // We navigate to the celebration page on any ok=true — even if
    // homeworksOk=false (approval saved, delivery failed). The admin
    // panel will surface undelivered approvals for manual resend.
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
        }),
      });

      // 409 = already approved. That's fine — route to approved page.
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
      const msg = err instanceof Error ? err.message : 'Something went wrong — please try again.';
      setErrorMsg(msg);
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 bg-[#FAF6EF]/96 backdrop-blur-md border-t border-[#E8DFCC] shadow-[0_-6px_24px_-8px_rgba(31,27,22,0.15)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 md:py-4">
        {errorMsg && (
          <p
            role="alert"
            className="mb-2 text-[12px] md:text-[13px] text-[#8B2A1F] bg-[#F8E8E3] border border-[#E8C9BF] rounded-md px-3 py-1.5"
          >
            {errorMsg}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 md:gap-6">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] truncate">
              {activeName}
            </p>
            <p className="flex items-baseline gap-2 mt-0.5 truncate">
              <span className="font-display text-[20px] md:text-[26px] font-bold text-[#1F1B16] tabular-nums">
                {formatUsd(currentTotal)}
              </span>
              <span className="text-[12px] md:text-[13px] text-[#6B5F52] truncate">
                · <span className="tabular-nums">{formatUsd(currentDeposit)}</span> deposit
              </span>
            </p>
          </div>

          <div className="flex flex-col items-end">
            <button
              type="button"
              onClick={onApprove}
              disabled={submitting || currentTotal <= 0}
              aria-label={`Approve quote and pay ${formatUsd(currentDeposit)} deposit`}
              className="inline-flex items-center justify-center gap-2 px-5 md:px-7 py-3 md:py-3.5 rounded-xl bg-[#C89B3C] text-[#1F1B16] font-semibold text-[15px] md:text-[16px] cursor-pointer transition-[background-color,box-shadow,transform] duration-200 hover:bg-[#B8862A] active:scale-[0.98] shadow-[0_4px_12px_-2px_rgba(200,155,60,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <span
                    aria-hidden
                    className="inline-block w-4 h-4 rounded-full border-2 border-[#1F1B16]/30 border-t-[#1F1B16] animate-spin"
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
              className="mt-1 text-[11px] md:text-[12px] text-[#6B5F52] underline underline-offset-2 cursor-pointer hover:text-[#1F1B16] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF] rounded-sm"
            >
              Save for later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
