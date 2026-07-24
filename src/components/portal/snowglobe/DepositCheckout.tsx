'use client';

// Deposit checkout (#38) — HOSTED-PAGE flow. After the customer clicks Approve
// this overlay asks our server (POST /pay) for a Valor-hosted payment page and
// redirects the browser there. The card is collected on Valor's own secure page
// — it never touches our server or our React state (SAQ-A). Valor returns the
// customer to /portal/[id]/approved on success, and its webhook is what actually
// books the quote.
//
// This component does NOT render card fields itself — it's a brief "taking you
// to secure checkout" interstitial plus visible error handling.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { friendlyPortalError } from '../friendlyError';
import { useModalFocus } from '../useModalFocus';
import type { ServiceType } from '@/lib/serviceType';
import { track } from '@/lib/analytics/posthog';
import { categorizeApproveError } from '@/lib/analytics/errorCategory';

type Props = {
  quoteId: string;
  onClose: () => void;
  /** #93 — a TEST quote. POST to /simulate-deposit (no Valor) and route straight
   *  to the booked page instead of redirecting to a hosted payment page. */
  isTest?: boolean;
  /** PostHog v1 — included on the approve_error event's properties. */
  serviceType?: ServiceType;
};

type Phase = 'starting' | 'redirecting' | 'error' | 'unconfigured';

export function DepositCheckout({ quoteId, onClose, isTest = false, serviceType }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('starting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Guard against double-run (React strict-mode runs effects twice).
  const startedRef = useRef(false);
  // Bug fix (audit W4-002): retry() used to reset startedRef and call
  // router.refresh(), but router.refresh() doesn't remount this component or
  // change any effect dependency, so the POST effect below never re-ran and
  // "Try again" was a dead button. `attempt` is in the effect's deps, so
  // retry() bumping it is what actually re-runs the checkout POST.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    // PostHog v1 Wave 1 — the HTTP status of a received response (undefined
    // means the failure was before any response, i.e. network-level), read by
    // the catch block below to bucket approve_error's `category`.
    let failureStatus: number | undefined;

    (async () => {
      try {
        // #93 — a test quote books via the operator-gated simulate-deposit route
        // (no Valor, no charge); a real quote starts the Valor hosted page.
        const endpoint = isTest ? 'simulate-deposit' : 'pay';
        const res = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        failureStatus = res.status;
        const body = await res.json().catch(() => ({}));

        // 409 covers several distinct server states across /pay and
        // /simulate-deposit (approve-first, not-payable, not-bookable, plus the
        // real already-paid case). Only 'already-paid' is a success case; any
        // other 409 is a dead end that must NOT navigate the customer forward to
        // a phantom booking (PS-D1) — fall through to the shared error handling
        // below instead.
        if (res.status === 409) {
          if (body.code === 'already-paid') {
            router.push(`/portal/${quoteId}/approved`);
            return;
          }
          throw new Error(body.error || `Could not start payment (${res.status})`);
        }

        // #93 — simulated deposit: no redirect, the route booked it server-side.
        if (isTest) {
          if (!res.ok) {
            throw new Error(body.error || `Could not simulate the deposit (${res.status})`);
          }
          if (cancelled) return;
          router.push(`/portal/${quoteId}/approved`);
          return;
        }

        if (res.status === 503 && body.code === 'valor-not-configured') {
          if (!cancelled) setPhase('unconfigured');
          return;
        }
        if (!res.ok || !body.redirectUrl) {
          throw new Error(body.error || `Could not start payment (${res.status})`);
        }

        if (cancelled) return;
        setPhase('redirecting');
        // Hand off to Valor's hosted payment page.
        window.location.href = body.redirectUrl as string;
      } catch (err) {
        if (cancelled) return;
        // Friendly-error convention (audit fix g10): never surface the raw
        // server/network error (Valor/Postgres internals, "Failed to fetch") to
        // the customer. Log it for debugging; show fixed, recoverable copy.
        console.error('deposit checkout start failed', err);
        setErrorMsg(friendlyPortalError('start checkout'));
        setPhase('error');
        // PostHog v1 Wave 1 — category only (never the raw message/err above).
        track('approve_error', {
          quote_id: quoteId,
          service_type: serviceType,
          stage: 'deposit',
          category: categorizeApproveError(failureStatus, err),
        });
      }
    })();

    return () => {
      cancelled = true;
      // #143: React strict mode (dev) mounts → unmounts → remounts. Without
      // resetting the run-once ref here, run 1's response gets swallowed by
      // `cancelled` while run 2 bails on startedRef — the POST lands (quote
      // books) but router.push never fires, stranding the spinner forever.
      // Resetting lets the remount re-run the POST (simulate-deposit is
      // idempotent — alreadyPaid fast-path; /pay just mints a fresh hosted
      // session). A REAL unmount never re-runs the effect, so this changes
      // nothing outside strict mode's double-invoke.
      startedRef.current = false;
    };
  }, [quoteId, router, isTest, attempt, serviceType]);

  const retry = () => {
    startedRef.current = false;
    setErrorMsg(null);
    setPhase('starting');
    setAttempt((a) => a + 1);
  };

  // a11y fix (W4-015): move focus into the dialog on open, trap Tab within
  // it, and restore focus to the trigger ("Complete deposit"/"Approve") on
  // close.
  const dialogRef = useModalFocus<HTMLDivElement>();

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pay your deposit"
    >
      <div className="w-full max-w-md rounded-2xl bg-[#0D1519] border border-[#FFB744]/30 shadow-2xl p-6 text-[#F4ECD8]">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="font-display text-[20px] font-bold">{isTest ? 'Simulate deposit' : 'Pay your deposit'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close payment"
            className="text-[#A89F87] hover:text-[#F4ECD8] text-[13px] underline cursor-pointer"
          >
            Cancel
          </button>
        </div>

        {(phase === 'starting' || phase === 'redirecting') && (
          <div className="py-8 text-center">
            <span
              aria-hidden
              className="inline-block w-6 h-6 rounded-full border-2 border-[#F4ECD8]/25 border-t-[#FFD07A] animate-spin"
            />
            <p className="mt-4 text-[14px] text-[#A89F87]">
              {isTest ? 'Recording your simulated deposit…' : 'Taking you to our secure checkout…'}
            </p>
          </div>
        )}

        {phase === 'unconfigured' && (
          <div className="py-4">
            <p className="text-[14px] text-[#F4ECD8]">
              Online payment isn’t switched on yet. We’ll reach out to collect your 50% deposit
              and lock in your install date — your approval is saved.
            </p>
            <button
              type="button"
              onClick={() => router.push(`/portal/${quoteId}/approved`)}
              className="mt-4 inline-flex items-center justify-center min-h-[44px] px-5 py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[14px] cursor-pointer hover:bg-[#D8434F]"
            >
              Continue
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="py-4">
            <p
              role="alert"
              className="text-[14px] text-[#F4ECD8] bg-[#7A1C24] border border-[#C8313D]/50 rounded-md px-3 py-2"
            >
              {errorMsg || 'Payment could not be started. Please try again.'}
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-4 inline-flex items-center justify-center min-h-[44px] px-5 py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[14px] cursor-pointer hover:bg-[#D8434F]"
            >
              Try again
            </button>
          </div>
        )}

        <p className="mt-4 text-[11px] text-[#A89F87] text-center">
          {isTest
            ? '🧪 Test mode — this records a simulated deposit. No card is charged.'
            : '🔒 Secured by Valor PayTech. Your card details are entered on Valor’s secure page — they never touch our servers.'}
        </p>
        {/* #170(e) card-on-file consent: shown on every real deposit checkout.
            The token capture + Vault registration happen automatically on
            payment (#161), so the authorization language rides the same step. */}
        {!isTest && (
          <p className="mt-2 text-[11px] text-[#A89F87] text-center">
            By paying this deposit you authorize Yule Love Lights to securely save this card and
            charge your remaining balance to it once your installation is complete.
          </p>
        )}
      </div>
    </div>
  );
}
