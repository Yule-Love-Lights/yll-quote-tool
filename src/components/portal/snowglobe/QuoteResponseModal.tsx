'use client';

// Portal customer-response modals (#83 Phase 1, Slice B). One component, two
// intents:
//   - 'decline'         → reason textarea → POST /api/quotes/[id]/decline
//   - 'request-changes' → note textarea   → POST /api/quotes/[id]/request-changes
// On success it swaps to a friendly confirmation (reusing the portal's
// friendly-error copy convention — we never surface a raw server error). The
// Approve+signature step lives in StickyBottomBar's own checkout flow, not here.
//
// Dark portal theme, mobile-first, 44px tap targets, 16px+ inputs.

import { useState } from 'react';

export type ResponseIntent = 'decline' | 'request-changes';

type Props = {
  quoteId: string;
  intent: ResponseIntent;
  onClose: () => void;
};

const COPY: Record<
  ResponseIntent,
  {
    title: string;
    label: string;
    placeholder: string;
    cta: string;
    endpoint: string;
    bodyKey: 'reason' | 'note';
    confirmTitle: string;
    confirmBody: string;
  }
> = {
  decline: {
    title: 'Decline this quote',
    label: 'Let us know why (optional context helps us improve)',
    placeholder: 'e.g. went with another option, budget, timing…',
    cta: 'Decline quote',
    endpoint: 'decline',
    bodyKey: 'reason',
    confirmTitle: 'Thanks for letting us know',
    confirmBody:
      "We've recorded that this quote was declined. If anything changes, just reach out — we'd love to light up your home.",
  },
  'request-changes': {
    title: 'Request changes',
    label: 'What would you like us to change?',
    placeholder: 'e.g. add the garage roofline, different color, fewer trees…',
    cta: 'Send request',
    endpoint: 'request-changes',
    bodyKey: 'note',
    confirmTitle: 'Got it — we’re on it',
    confirmBody:
      "We've sent your note to our team. We'll tweak your quote and send you an updated version shortly.",
  },
};

const MAX = 2000;

export function QuoteResponseModal({ quoteId, intent, onClose }: Props) {
  const copy = COPY[intent];
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const phone = process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || '(631) 517-0186';
  // Decline allows an empty reason in the UI (we send a friendly default so the
  // required-reason route still gets a value); request-changes needs a real note.
  const trimmed = text.trim();
  const canSubmit =
    !submitting && (intent === 'decline' ? true : trimmed.length > 0) && trimmed.length <= MAX;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);
    const value =
      intent === 'decline' && !trimmed ? 'No reason given' : trimmed;
    try {
      const res = await fetch(
        `/api/quotes/${encodeURIComponent(quoteId)}/${copy.endpoint}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [copy.bodyKey]: value }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // 409 = the quote already moved on (booked/approved/declined). Tell the
        // customer plainly rather than leaking a status code.
        if (res.status === 409) {
          throw new Error(
            "This quote can't be updated anymore — it may already be approved or booked. Text us if that's not right.",
          );
        }
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setDone(true);
    } catch (err) {
      // Friendly-error convention (audit fix g10): never surface raw internals.
      console.error(`${copy.endpoint} failed`, err);
      const friendly =
        err instanceof Error && /can't be updated anymore/.test(err.message)
          ? err.message
          : `We couldn't send that just now — please try again, or text us at ${phone}.`;
      setErrorMsg(friendly);
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
    >
      <div className="w-full max-w-md rounded-2xl bg-[#0D1519] border border-[#FFB744]/30 shadow-2xl p-6 text-[#F4ECD8]">
        {done ? (
          <div>
            <h2 className="font-display text-[20px] font-bold mb-2">{copy.confirmTitle}</h2>
            <p className="text-[14px] text-[#A89F87]">{copy.confirmBody}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 inline-flex items-center justify-center min-h-[44px] px-5 py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[14px] cursor-pointer hover:bg-[#D8434F]"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-display text-[20px] font-bold">{copy.title}</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Cancel"
                className="text-[#A89F87] hover:text-[#F4ECD8] text-[13px] underline cursor-pointer min-h-[44px] inline-flex items-center"
              >
                Cancel
              </button>
            </div>

            {errorMsg && (
              <p
                role="alert"
                className="mb-3 text-[13px] text-[#F4ECD8] bg-[#7A1C24] border border-[#C8313D]/50 rounded-md px-3 py-2"
              >
                {errorMsg}
              </p>
            )}

            <label htmlFor="response-text" className="block text-[13px] text-[#A89F87] mb-1.5">
              {copy.label}
            </label>
            <textarea
              id="response-text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX))}
              rows={4}
              placeholder={copy.placeholder}
              className="w-full rounded-lg bg-[#060B0F] border border-[#FFB744]/30 px-3 py-2.5 text-[16px] text-[#F4ECD8] placeholder-[#6E6553] focus:outline-none focus:ring-2 focus:ring-[#FFB744] resize-none"
            />
            <div className="mt-1 text-right text-[11px] text-[#6E6553]">
              {trimmed.length}/{MAX}
            </div>

            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="mt-3 w-full inline-flex items-center justify-center gap-1.5 min-h-[44px] px-5 py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[14px] cursor-pointer hover:bg-[#D8434F] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <span
                    aria-hidden
                    className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[#F4ECD8]/30 border-t-[#F4ECD8] animate-spin"
                  />
                  Sending…
                </>
              ) : (
                copy.cta
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
