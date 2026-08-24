'use client';

// Referral program growth feature 1 (ledger #41 growth) — one-tap share next
// to the copy-link button. Uses the Web Share API when the device supports it
// (native share sheet, pre-filled text); falls back to an `sms:` deep link
// when it doesn't (desktop browsers, most of them). Client boundary kept
// small, mirroring ReferralLinkCopy.
//
// Message states the FRIEND's real offer (free spritzers on their first
// booked install) — not the referrer's $125 credit, which is a separate,
// unrelated line in the product terms (src/lib/referrals.ts). A share
// message that quoted "$125 off" here would misstate what the referred
// friend actually gets.
//
// naldo/referral-link-preview: "spritzers" is trade jargon with no meaning
// to a homeowner on its own, so the message states the dollar value first
// and names the physical thing (a staked ground spotlight) in plain words.
// spritzerValueUsd is passed in by the caller, derived from the quote
// builder's own per-size rate (src/lib/referralSpritzerValue.ts), never a
// separate hardcoded number.

import { useSyncExternalStore } from 'react';
import { Share2 } from 'lucide-react';
import { formatUsd } from '@/components/portal/format';

// navigator.share's availability never changes during a page's lifetime, so
// there's nothing to subscribe to — an empty unsubscribe is correct here.
function subscribeNoop() {
  return () => {};
}
function getCanShareSnapshot(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}
function getCanShareServerSnapshot(): boolean {
  return false;
}

/** The exact text composed for both the native share sheet and the SMS
 *  fallback, so both paths send an identical message. Exported for direct
 *  testing of the composition (count/size/link all show up correctly). */
export function buildReferralShareMessage(
  link: string,
  spritzerCount: number,
  spritzerSizeInches: number,
  spritzerValueUsd: number,
): string {
  return `Check out the holiday lights I'm getting from Yule Love Lights! Use my link and get ${formatUsd(
    spritzerValueUsd,
  )} in free lighting on your first booked install, ${spritzerCount} staked spotlights for your yard (${spritzerSizeInches}" spritzers): ${link}`;
}

export function ReferralShareButton({
  link,
  spritzerCount,
  spritzerSizeInches,
  spritzerValueUsd,
}: {
  link: string;
  spritzerCount: number;
  spritzerSizeInches: number;
  spritzerValueUsd: number;
}) {
  // Web Share API is a browser capability, unknown at SSR time — the server
  // snapshot forces the SMS-link fallback (a real, functioning <a>) so the
  // server and first client render agree; useSyncExternalStore then reads
  // the real client value once mounted, upgrading to the native Share button
  // when the device supports navigator.share. This is the recommended hook
  // for exactly this "differs between server and client" case (no effect +
  // setState needed, so it doesn't trigger a cascading-render re-render).
  const canShare = useSyncExternalStore(subscribeNoop, getCanShareSnapshot, getCanShareServerSnapshot);

  const message = buildReferralShareMessage(link, spritzerCount, spritzerSizeInches, spritzerValueUsd);

  // Review fix 2: Share is the primary action now (filled gold, loud) --
  // giving people something to share is the entire point of this feature,
  // so it gets the visual weight ReferralLinkCopy's Copy button used to
  // carry. Copy is now the outline secondary (see ReferralLinkCopy.tsx).
  const buttonClass =
    'inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-[#FFB744] text-[#1A1206] font-semibold text-[14px] cursor-pointer transition-colors duration-200 hover:bg-[#FFC565] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFB744] focus-visible:ring-offset-2 focus-visible:ring-offset-[#060B0F]';

  if (canShare) {
    return (
      <button
        type="button"
        className={buttonClass}
        onClick={() => {
          navigator.share({ text: message }).catch(() => {
            // User cancelled the native share sheet, or the share failed —
            // not an error worth surfacing; the copy button next to this
            // one is always available as a fallback.
          });
        }}
      >
        <Share2 className="w-4 h-4" aria-hidden />
        Share
      </button>
    );
  }

  return (
    <a href={`sms:?&body=${encodeURIComponent(message)}`} className={buttonClass}>
      <Share2 className="w-4 h-4" aria-hidden />
      Share
    </a>
  );
}
