// Client-side half of the referral prefill prompt: when to ask the server,
// and how to ask it. Split out of the component so both decisions are
// testable without a DOM (this repo renders components with
// renderToStaticMarkup and has no Testing Library).

export type PendingReferralMatch = {
  referralId: string;
  referrerCustomerId: string;
  referrerName: string | null;
  refereeName: string | null;
  createdAt: string;
  matchedOn: 'phone' | 'email';
};

/**
 * Whether the builder should ask at all. Two silent states, both of which
 * would otherwise cost a pointless round trip on every keystroke:
 *  - nothing to match on yet (a walk-in quote with no contact details typed)
 *  - a referrer is already chosen, so the question is answered
 */
export function shouldLookupReferral(input: {
  phone: string;
  email: string;
  alreadySet: boolean;
}): boolean {
  if (input.alreadySet) return false;
  return Boolean(input.phone.trim() || input.email.trim());
}

/**
 * Ask whether this lead arrived through someone's referral link.
 *
 * POST, not GET: the body carries a real person's phone and email, and a GET
 * would put both in the URL, the request log and browser history.
 *
 * Never throws. A lookup hiccup resolves to null, which is the same state as
 * "no referral found" and by far the common case, so a network blip can never
 * break the quote builder.
 */
export async function lookupPendingReferral(input: {
  phone: string;
  email: string;
  excludeCustomerId?: string | null;
  signal?: AbortSignal;
}): Promise<PendingReferralMatch | null> {
  try {
    const res = await fetch('/api/referrals/pending-lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: input.phone.trim(),
        email: input.email.trim(),
        excludeCustomerId: input.excludeCustomerId ?? undefined,
      }),
      signal: input.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.match ? (data.match as PendingReferralMatch) : null;
  } catch {
    return null;
  }
}

/**
 * How the referrer is named in the prompt. A referral row can point at a
 * customer with no name on file, and "  sent them" reads like a bug, so it
 * falls back to a phrase that still makes sense in every sentence the card
 * builds around it.
 */
export function referrerLabel(match: PendingReferralMatch): string {
  return match.referrerName?.trim() || 'Another customer';
}
