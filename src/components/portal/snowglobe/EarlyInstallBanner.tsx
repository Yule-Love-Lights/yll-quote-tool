'use client';

// Portal — early-install savings banner.
//
// The Sep/Oct early-install picker (WhatsIncluded, "Install early & save")
// sits far below the fold, after the design, the line items and the add-ons,
// so a customer who never scrolls never learns the discount exists. This is a
// sticky strip at the top of the page, in the same slot and the same treatment
// as BookedBanner, that states the offer and jumps to the picker.
//
// It renders ONLY when clicking it leads to a control that works. The
// eligibility test below mirrors WhatsIncluded's own render condition for that
// section, plus `locked`: a banner that pitches a discount the server refuses
// is the failure this repo keeps writing down (AGENTS.md, "a guard and the
// COPY THAT NARRATES IT are one change"). On a locked quote BookedBanner
// already owns this slot, so this one stays away rather than stacking a second
// sticky bar on a phone.
//
// Second line: the returning-customer thank you. Free spritzers are read out
// of the quote's own line-item labels (src/lib/portal/freeSpritzers.ts) rather
// than counted as $0 lines, because prod keeps them in the label text of a
// PAID package line. The count can be null when a label promises spritzers
// without a readable number, and the copy then states no figure.

import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';
import { track } from '@/lib/analytics/posthog';
import type { ServiceType } from '@/lib/serviceType';
import { ArrowDown, ArrowRight, CheckCircle2, Gift, PiggyBank } from 'lucide-react';

/** The id the picker section carries, so the jump has somewhere to land. */
export const EARLY_INSTALL_ANCHOR_ID = 'portal-early-install';

export type EarlyInstallBannerProps = {
  serviceType?: ServiceType | null;
  /** True when this customer has at least one season with YLL BEFORE this one.
   *  Gates the "thank you for coming back" wording: a referral friend gets free
   *  spritzers on their FIRST install, and thanking them for returning would be
   *  a lie. False falls back to neutral wording. */
  isReturningCustomer: boolean;
  /** True when a signed-in operator is previewing the customer's page. The
   *  banner then renders in normal flow instead of sticking to the top.
   *
   *  StaffPreselectBar is also `sticky top-0` and sits BELOW this in the DOM,
   *  so with both pinned this banner (z-50) covers the staff bar (z-40) the
   *  moment the page scrolls: measured on the real page at scrollY 2000, the
   *  centre of "Save as customer's starting selection" resolved to this
   *  banner's link, meaning the button could not be clicked at all. Customers
   *  never see that bar, so they keep the sticky banner; staff keep their tool.
   *  Found by the PR #1192 staff lens. */
  staffPreview?: boolean;
};

export function EarlyInstallBanner({ serviceType, isReturningCustomer, staffPreview = false }: EarlyInstallBannerProps) {
  const {
    installTiming,
    breakdown,
    hasManualDiscount,
    earlyInstallHidden,
    locked,
    septemberDiscountRate,
    octoberDiscountRate,
    freeSpritzers,
    quoteId,
  } = useSelection();

  // Positive holiday match, never `!== 'permanent'` — a future vertical must
  // not inherit the holiday promo by default (AGENTS.md seam-gate rule). Same
  // shape as WhatsIncluded's own isHoliday.
  const isHoliday = !serviceType || serviceType === 'holiday';

  // Exactly WhatsIncluded's condition for rendering the picker, plus locked.
  const discountAvailable = isHoliday && !hasManualDiscount && !earlyInstallHidden && !locked;

  // The thank you rides this banner too, but never on a locked quote: the
  // booked banner is already pinned there. The in-page callout still carries it.
  const showThanks = freeSpritzers.present && !locked;

  if (!discountAvailable && !showThanks) return null;

  const chosen = installTiming === 'september' || installTiming === 'october';
  const monthLabel = installTiming === 'september' ? 'September' : 'October';
  const savings = breakdown.discount;
  const septemberPct = Math.round(septemberDiscountRate * 100);
  const octoberPct = Math.round(octoberDiscountRate * 100);

  const goToPicker = () => {
    // Without this the owner has no way to tell whether the banner moved
    // discount uptake, which is the whole reason it exists (PR #1192 admin
    // lens). Click only, not an impression: the banner is above the fold by
    // construction, so an impression event would just count page loads.
    track('early_install_banner_clicked', {
      quote_id: quoteId,
      service_type: serviceType ?? 'holiday',
      install_timing: installTiming,
      already_chosen: chosen,
    });
    const el = document.getElementById(EARLY_INSTALL_ANCHOR_ID);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Same pattern as InteractiveHero's goToIncluded: move keyboard and screen
    // reader focus with the scroll, without a second jump.
    el.focus({ preventScroll: true });
  };

  return (
    <div
      className={`${
        staffPreview ? 'relative' : 'sticky top-0'
      } z-50 w-full bg-[#0D1519]/95 backdrop-blur border-b border-[#FFB744]/30`}
    >
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-2 sm:py-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 sm:gap-y-1 text-center">
        {discountAvailable && (
          <>
            {chosen ? (
              <CheckCircle2 className="w-5 h-5 text-[#FFB744] shrink-0" aria-hidden />
            ) : (
              <PiggyBank className="w-5 h-5 text-[#FFB744] shrink-0" aria-hidden />
            )}
            <p className="text-[13px] md:text-[14px] text-[#F4ECD8]">
              {chosen ? (
                <>
                  {monthLabel} install locked in.{' '}
                  {savings > 0 ? (
                    <>
                      You are saving{' '}
                      <span className="font-semibold text-[#FFB744] whitespace-nowrap">{formatUsd(savings)}</span>.
                    </>
                  ) : (
                    <>Your discount is applied below.</>
                  )}
                </>
              ) : (
                <>
                  {/* Phones get the same two numbers in fewer words: measured at
                      375px the full sentence wrapped the sticky bar to 19% of the
                      screen. Both variants state September AND October, so the
                      short one is not a weaker promise, just a shorter sentence. */}
                  <span className="sm:hidden">
                    <span className="font-semibold text-[#FFB744] whitespace-nowrap">{septemberPct}% off</span> in
                    September,{' '}
                    <span className="font-semibold text-[#FFB744] whitespace-nowrap">{octoberPct}% off</span> in
                    October.
                  </span>
                  <span className="hidden sm:inline">
                    Save on this year&apos;s install.{' '}
                    <span className="font-semibold text-[#FFB744] whitespace-nowrap">{septemberPct}% off</span> for a
                    September install,{' '}
                    <span className="font-semibold text-[#FFB744] whitespace-nowrap">{octoberPct}% off</span> for
                    October.
                  </span>
                </>
              )}
            </p>
            <button
              type="button"
              onClick={goToPicker}
              className="inline-flex items-center gap-1 text-[13px] md:text-[14px] font-semibold text-[#FFB744] hover:text-[#FFD07A] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] rounded-sm cursor-pointer"
            >
              {chosen ? 'Change month' : 'See the savings'}
              {chosen ? (
                <ArrowRight className="w-4 h-4" aria-hidden />
              ) : (
                <ArrowDown className="w-4 h-4" aria-hidden />
              )}
            </button>
          </>
        )}

        {showThanks && (
          <span
            className={`flex items-center justify-center gap-2 text-[12px] md:text-[13px] text-[#A89F87] ${
              discountAvailable ? 'basis-full' : ''
            }`}
          >
            <Gift className="w-4 h-4 text-[#86C9A0] shrink-0" aria-hidden />
            <span>
              {isReturningCustomer ? <span className="hidden sm:inline">Thank you for coming back, </span> : null}
              <span className="font-semibold text-[#86C9A0]">
                {freeSpritzers.count === null
                  ? 'free spritzers are included'
                  : `${freeSpritzers.count} spritzer${freeSpritzers.count === 1 ? '' : 's'} ${
                      freeSpritzers.count === 1 ? 'is' : 'are'
                    } on us`}
              </span>{' '}
              this season.
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
