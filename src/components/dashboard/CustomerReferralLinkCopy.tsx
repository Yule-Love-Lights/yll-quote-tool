'use client';

// Customer profile referral panel (#41) — copy-to-clipboard control for the
// referrer's personal link. Mirrors the interaction of the portal's
// src/components/portal/dark/ReferralLinkCopy.tsx (copy + a 2s "Copied"
// confirmation) but styled with the operator dashboard's CSS variables
// instead of the portal's hardcoded dark palette, so it matches the rest of
// the customer profile page.

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export function CustomerReferralLinkCopy({ link }: { link: string }) {
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
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 max-w-xl">
      <div
        className="flex-1 rounded-md border px-3 py-2 text-xs truncate font-mono"
        style={{ background: 'var(--op-bg)', borderColor: 'var(--op-border)', color: 'var(--op-text)' }}
        title={link}
      >
        {link}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md font-medium text-xs shrink-0"
        style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
      >
        {copied ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}
