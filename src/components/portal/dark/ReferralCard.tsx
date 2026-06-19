'use client';

// Portal v2 DARK — ReferralCard. Dark raised surface, gold CTA, cream
// input. Lives inside the approved page's "refer a neighbor" band and
// is the one section where gold is the primary button color (because
// this isn't the main CTA — it's a delight moment).

import { useState } from 'react';
import { Copy, Check, Link as LinkIcon } from 'lucide-react';

export type ReferralCardProps = {
  quoteId: string;
};

function buildReferralUrl(quoteId: string): string {
  if (typeof window === 'undefined') {
    return `https://yulelovelights.com/refer/${quoteId}`;
  }
  return `${window.location.origin}/refer/${quoteId}`;
}

export function ReferralCard({ quoteId }: ReferralCardProps) {
  const [copied, setCopied] = useState(false);
  const [url] = useState(() => buildReferralUrl(quoteId));

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const el = document.getElementById('portal-dark-referral-url') as HTMLInputElement | null;
      el?.select();
    }
  };

  return (
    <div className="rounded-2xl bg-[#18221C] border border-[#243029] p-5 md:p-6 shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]">
      <label
        htmlFor="portal-dark-referral-url"
        className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] uppercase text-[#E8B862] mb-2.5"
      >
        <LinkIcon className="w-3.5 h-3.5" aria-hidden />
        Your referral link
      </label>

      <div className="flex items-stretch gap-2">
        <input
          id="portal-dark-referral-url"
          type="text"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-[#0B140F] text-[#E0D7C1] text-[13px] md:text-[14px] border border-[#243029] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:border-[#E8B862]/50 truncate"
          aria-describedby="portal-dark-referral-help"
        />
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? 'Link copied' : 'Copy referral link'}
          className="inline-flex items-center justify-center gap-2 shrink-0 px-4 py-2.5 rounded-lg bg-[#E8B862] text-[#18221C] font-semibold text-[14px] cursor-pointer transition-[background-color,box-shadow,transform] duration-200 hover:bg-[#F5CC7A] active:scale-[0.98] shadow-[0_0_18px_rgba(232,184,98,0.35),0_6px_16px_-4px_rgba(232,184,98,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#18221C]"
        >
          {copied ? (
            <>
              <Check className="w-4 h-4" aria-hidden />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-4 h-4" aria-hidden />
              Copy
            </>
          )}
        </button>
      </div>

      <p id="portal-dark-referral-help" className="mt-3 text-[12px] leading-[1.55] text-[#A89F87]">
        Every neighbor who books earns you $150 off next season — no limit, auto-applied to your account.
      </p>
    </div>
  );
}
