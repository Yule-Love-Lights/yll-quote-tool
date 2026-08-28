// Portal v2 DARK: compact inline trust row (rating, license, guarantee).
// Extracted from the referral landing page's hero (src/app/refer/[code]/
// ReferHero.tsx, ledger #41) so /referral-link (naldo/referral-link-preview)
// can show the identical signals above its form, without hand-copying the
// JSX into a second place where the two could quietly drift apart. Every
// number here must match the source it was extracted from exactly.

import { Star, ShieldCheck, Wrench } from 'lucide-react';

export function CompactTrustRow() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
      <div className="inline-flex items-center gap-2 text-[14px] text-[#E0D7C1]">
        <Star className="w-4 h-4 fill-[#E8B862] text-[#E8B862]" aria-hidden />
        <span className="font-semibold">5.0</span>
        <span className="text-[#A89F87]">&middot; 166 Google reviews</span>
      </div>
      <div className="inline-flex items-center gap-1.5 text-[13px] text-[#A89F87]">
        <ShieldCheck className="w-4 h-4 text-[#E8B862]" aria-hidden />
        <span>Licensed &amp; insured</span>
      </div>
      <div className="inline-flex items-center gap-1.5 text-[13px] text-[#A89F87]">
        <Wrench className="w-4 h-4 text-[#E8B862]" aria-hidden />
        <span>48-hour fix guarantee</span>
      </div>
    </div>
  );
}
