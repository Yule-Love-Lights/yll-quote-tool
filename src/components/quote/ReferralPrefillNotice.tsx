'use client';

// "This lead came from someone's referral link" — the one prompt standing
// between a referrer and their $125.
//
// The gap this closes: a referral only ever pays out if a staffer picks the
// referrer in ReferredByPicker while building the referred friend's quote,
// BEFORE the deposit is taken. `accrueOnBooking` matches solely on
// `referee_quote_id`, which nothing but that picker sets, and adding it after
// the quote books does not pay the credit. Until now nothing read back the
// 'link' row the friend created at /refer/<code>, so the whole program rested
// on someone remembering a conversation.
//
// It SUGGESTS and never auto-fills. A phone or email match is strong evidence
// but not proof, and the cost of being wrong is paying the wrong person, so a
// human still presses the button. Dismissible, because a staffer who knows
// better should be able to make it go away and get on with the quote.
//
// Split in two the way ReferralSection is: ReferralPrefillCard is pure and
// prop-driven so it can be asserted with renderToStaticMarkup, and the
// when/how of asking lives in src/lib/referralPrefillClient.ts.

import { useEffect, useRef, useState } from 'react';
import {
  lookupPendingReferral,
  shouldLookupReferral,
  referrerLabel,
  type PendingReferralMatch,
} from '@/lib/referralPrefillClient';

const DEBOUNCE_MS = 400;

export function ReferralPrefillCard({
  match,
  onUse,
  onDismiss,
}: {
  match: PendingReferralMatch;
  onUse: (value: { id: string; name: string }) => void;
  onDismiss: () => void;
}) {
  const referrer = referrerLabel(match);
  const how = match.matchedOn === 'phone' ? 'phone number' : 'email';

  return (
    <div
      className="mt-3 rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 text-sm text-amber-950"
      role="status"
    >
      <p className="font-semibold">This lead came from a referral link.</p>
      <p className="mt-1 leading-relaxed">
        {referrer} sent them, and their {how} matches. Set &ldquo;Referred by&rdquo; below so the credit
        lands when this quote books. If it books without it, the credit cannot be added afterwards.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onUse({ id: match.referrerCustomerId, name: match.referrerName ?? referrer })}
          className="inline-flex min-h-[36px] items-center rounded-md bg-amber-500 px-3 text-[13px] font-semibold text-amber-950 transition-colors hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
        >
          Set {referrer} as the referrer
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex min-h-[36px] items-center rounded-md px-3 text-[13px] font-medium text-amber-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
        >
          Not this one
        </button>
      </div>
    </div>
  );
}

export function ReferralPrefillNotice({
  phone,
  email,
  excludeCustomerId,
  alreadySet,
  onUse,
}: {
  phone: string;
  email: string;
  /** The quote's own linked customer, so we never suggest a self-referral. */
  excludeCustomerId?: string | null;
  /** True once a referrer is set, by this notice or by hand: stop asking. */
  alreadySet: boolean;
  onUse: (value: { id: string; name: string }) => void;
}) {
  const [match, setMatch] = useState<PendingReferralMatch | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!shouldLookupReferral({ phone, email, alreadySet })) {
      queueMicrotask(() => setMatch(null));
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const hit = await lookupPendingReferral({ phone, email, excludeCustomerId, signal: ac.signal });
      setMatch(hit);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [phone, email, excludeCustomerId, alreadySet]);

  if (!match || dismissed || alreadySet) return null;

  return <ReferralPrefillCard match={match} onUse={onUse} onDismiss={() => setDismissed(true)} />;
}
