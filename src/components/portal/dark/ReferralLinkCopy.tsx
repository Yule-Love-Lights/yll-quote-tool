'use client';

// Referral program (#41) — the booked-page referral section's copy-to-
// clipboard control. Client boundary kept as small as possible: the parent
// server component resolves the link (ensureReferralCode + appBaseUrl) and
// hands it down as a plain string prop.

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export function ReferralLinkCopy({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable or permission-denied — the link text
      // is still visible for a manual copy, so this stays a silent no-op.
    }
  }

  return (
    <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 max-w-xl">
      <div
        className="flex-1 rounded-xl bg-[#060B0F] border border-[#1F2A23] px-4 py-3 text-[13px] md:text-[14px] text-[#E0D7C1] truncate font-mono"
        title={link}
      >
        {link}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-[#FFB744] text-[#1A1206] font-semibold text-[14px] cursor-pointer transition-colors duration-200 hover:bg-[#FFC565] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F]"
      >
        {copied ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}
