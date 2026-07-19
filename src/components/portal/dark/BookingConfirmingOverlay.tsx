'use client';

// #166 — post-deposit "Confirming your payment…" overlay.
//
// After a real Valor deposit the customer is redirected to /approved with
// `?confirming=1` the instant Valor returns — a beat BEFORE the async webhook
// writes deposit_paid_at. Without this, /approved (a server component keyed on
// deposit_paid_at) briefly renders the pre-booked "we'll collect your deposit"
// variant. This overlay covers that window: while just-paid-but-not-yet-booked,
// it shows a pending state and polls (router.refresh re-runs the server
// component) until the webhook lands and isPaid flips — then it unmounts and the
// real booked page shows through. It is NOT a money path (the booking already
// happened on Valor's side); it only fixes the display race.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// Poll cadence + how long before we soften the copy to "payment received,
// finalizing" (we keep polling after — a late webhook still resolves it).
const POLL_MS = 2500;
const SOFTEN_AFTER_MS = 45000;

/** Show the overlay only when the customer just returned from the deposit page
 * (`?confirming=1`) and the webhook hasn't marked the deposit paid yet. */
export function shouldConfirmBooking(confirming: string | undefined, isPaid: boolean): boolean {
  return confirming === '1' && !isPaid;
}

export function BookingConfirmingOverlay({
  confirming,
  isPaid,
}: {
  confirming: string | undefined;
  isPaid: boolean;
}) {
  const router = useRouter();
  const active = shouldConfirmBooking(confirming, isPaid);
  const [softened, setSoftened] = useState(false);

  useEffect(() => {
    if (!active) return;
    const poll = setInterval(() => router.refresh(), POLL_MS);
    const soften = setTimeout(() => setSoftened(true), SOFTEN_AFTER_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(soften);
    };
  }, [active, router]);

  if (!active) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#060B0F]/95 px-6 text-center"
    >
      <div className="max-w-md">
        <div
          className="mx-auto mb-6 h-10 w-10 animate-spin rounded-full border-2 border-[#FFB744]/30 border-t-[#FFB744]"
          aria-hidden
        />
        <h2 className="font-display text-[24px] font-semibold text-[#F4ECD8]">
          {softened ? 'Payment received' : 'Confirming your payment…'}
        </h2>
        <p className="mt-3 text-[15px] text-[#A89F87] leading-[1.6]">
          {softened
            ? "We've got your deposit and we're finalizing your booking. This can take a moment. Feel free to refresh, or we'll be in touch shortly."
            : 'Hang tight while we lock in your booking. This only takes a few seconds.'}
        </p>
      </div>
    </div>
  );
}
