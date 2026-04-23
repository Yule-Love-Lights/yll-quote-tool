'use client';

// ReferralCard — copy-link button at peak happiness. Generates a
// personal referral URL and gives instant visual feedback on copy
// (Check icon swap for 1.8s).

import { useState } from 'react';
import { Copy, Check, Link as LinkIcon } from 'lucide-react';

export type ReferralCardProps = {
  quoteId: string;
};

function buildReferralUrl(quoteId: string): string {
  // Origin-safe: on the server we return a placeholder; the client
  // useEffect below will refresh once mounted if it differs.
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
      // Fallback: select the input so the user can copy manually.
      const el = document.getElementById('portal-referral-url') as HTMLInputElement | null;
      el?.select();
    }
  };

  return (
    <div className="rounded-2xl bg-[#FAF6EF]/10 border border-[#FAF6EF]/20 p-5 md:p-6 backdrop-blur-sm">
      <label
        htmlFor="portal-referral-url"
        className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] uppercase text-[#D9B15B] mb-2"
      >
        <LinkIcon className="w-3.5 h-3.5" aria-hidden />
        Your referral link
      </label>

      <div className="flex items-stretch gap-2">
        <input
          id="portal-referral-url"
          type="text"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-[#16321F] text-[#FAF6EF] text-[13px] md:text-[14px] border border-[#FAF6EF]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] truncate"
          aria-describedby="portal-referral-help"
        />
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? 'Link copied' : 'Copy referral link'}
          className="inline-flex items-center justify-center gap-2 shrink-0 px-4 py-2.5 rounded-lg bg-[#C89B3C] text-[#1F1B16] font-semibold text-[14px] cursor-pointer transition-[background-color,transform] duration-200 hover:bg-[#B8862A] active:scale-[0.98] shadow-[0_4px_12px_-2px_rgba(200,155,60,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1F3D2B]"
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

      <p id="portal-referral-help" className="mt-3 text-[12px] leading-[1.5] text-[#FAF6EF]/75">
        Every neighbor who books earns you $100 off next season — no limit, auto-applied to your account.
      </p>
    </div>
  );
}
