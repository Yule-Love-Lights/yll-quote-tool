// Portal — booked banner (#43). Shown at the top of /portal/[quoteId] once the
// customer has approved, so a returning customer (e.g. via the "View your quote"
// link on the confirmation page) lands on a clear "you're booked" state instead
// of the editable pre-approval quote. Server component — no client JS.
//
// Pre-Valor: the trigger is approval (customer_approved_at), and the copy says
// we'll reach out for the deposit. With online payment (#38) "booked" can also
// mean the deposit was already PAID — `depositFlow` (mirrors StickyBottomBar's
// booked-branch copy) tells us which sentence applies.

import Link from 'next/link';
import { CheckCircle2, ArrowRight } from 'lucide-react';

export type BookedBannerProps = {
  quoteId: string;
  approvedAt?: string; // ISO timestamp from the approval snapshot
  /** #38 — true when the deposit checkout flow applies (real checkout on, or a
   *  test quote) and `isBooked` therefore means the deposit was already PAID,
   *  not just approved. Defaults to false (the pre-Valor "we'll reach out"
   *  copy) so a caller that hasn't been updated yet keeps today's behavior. */
  depositFlow?: boolean;
};

export function BookedBanner({ quoteId, approvedAt, depositFlow = false }: BookedBannerProps) {
  const dateLabel = approvedAt
    ? new Date(approvedAt).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div className="sticky top-0 z-50 w-full bg-[#0D1519]/95 backdrop-blur border-b border-[#FFB744]/30">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center">
        <CheckCircle2 className="w-5 h-5 text-[#FFB744] shrink-0" aria-hidden />
        <p className="text-[13px] md:text-[14px] text-[#F4ECD8]">
          You&apos;re booked{dateLabel ? ` — approved ${dateLabel}` : ''}.{' '}
          {depositFlow
            ? 'Your deposit is in.'
            : "We'll reach out to collect your 50% deposit."}
        </p>
        <Link
          href={`/portal/${quoteId}/approved`}
          className="inline-flex items-center gap-1 text-[13px] md:text-[14px] font-semibold text-[#FFB744] hover:text-[#FFD07A] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] rounded-sm"
        >
          View confirmation
          <ArrowRight className="w-4 h-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
