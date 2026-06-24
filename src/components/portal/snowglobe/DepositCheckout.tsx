'use client';

// Embedded 50% deposit checkout (#38). Mounted as an overlay after the customer
// clicks Approve. It:
//   1. asks our server for a short-lived Valor clientToken (POST /pay),
//   2. loads Passage.js and mounts Valor's hosted card fields into a container,
//   3. on success, sends the customer to the booked page (the Valor webhook is
//      what actually marks them booked — this navigation is optimistic UI),
//   4. shows every error VISIBLY — nothing is swallowed.
//
// PCI: the card fields belong to Passage.js and post straight to Valor. The
// card never touches our server or our React state — we only ever hold the
// clientToken our backend minted. That keeps us at SAQ-A.
//
// ┌─ CONFIRM at live integration ────────────────────────────────────────────┐
// │ Valor's docs host bot-blocks automated fetch, so the exact Passage.js     │
// │ init call below (method name + option keys) is the documented-but-        │
// │ unconfirmed shape. It is isolated in mountPassage() and tolerant of a few │
// │ likely API shapes; confirm against valorapi.readme.io's Passage.js guide  │
// │ on the first staging run and delete the branches that don't apply.        │
// └───────────────────────────────────────────────────────────────────────────┘

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatUsd } from '../format';

// Passage.js library URL. Defined here (not imported from valor.ts) so this
// client component never pulls the server-only Valor module — which imports
// Node's `crypto` — into the browser bundle. CONFIRM the version path at build.
const PASSAGE_JS_URL = 'https://js.valorpaytech.com/V1/js/Passage.min.js';

type Props = {
  quoteId: string;
  onClose: () => void;
};

type Phase = 'loading' | 'ready' | 'confirming' | 'error' | 'unconfigured';

// Minimal, intentionally loose typing for the third-party global. The real
// surface is confirmed at live integration (see header).
type PassageApi = {
  init?: (opts: PassageOptions) => unknown;
  render?: (opts: PassageOptions) => unknown;
  mount?: (opts: PassageOptions) => unknown;
};
type PassageOptions = {
  clientToken: string;
  container?: string;
  selector?: string;
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
  onFailure?: (err: unknown) => void;
};
declare global {
  interface Window {
    Passage?: PassageApi | (new (opts: PassageOptions) => unknown);
  }
}

// Load the Passage.js script once, resolving when ready.
function loadPassageScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'));
    if (window.Passage) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PASSAGE_JS_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Passage.js failed to load')), {
        once: true,
      });
      return;
    }
    const s = document.createElement('script');
    s.src = PASSAGE_JS_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Passage.js failed to load'));
    document.head.appendChild(s);
  });
}

// Initialize Passage onto our container with the token + callbacks. Tolerant of
// a few likely API shapes — see header CONFIRM note.
function mountPassage(
  containerId: string,
  opts: PassageOptions,
): void {
  const P = window.Passage;
  if (!P) throw new Error('Passage.js not available');
  const full: PassageOptions = { container: `#${containerId}`, selector: `#${containerId}`, ...opts };
  if (typeof P === 'function') {
    // Constructor form: new Passage({...})
    new (P as new (o: PassageOptions) => unknown)(full);
    return;
  }
  if (typeof P.init === 'function') return void P.init(full);
  if (typeof P.render === 'function') return void P.render(full);
  if (typeof P.mount === 'function') return void P.mount(full);
  throw new Error('Passage.js exposed no known init method');
}

export function DepositCheckout({ quoteId, onClose }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [amountUsd, setAmountUsd] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const containerId = 'valor-passage-container';
  // Guard against double-mount (React 18/19 strict-mode runs effects twice).
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        // 1. Get a client token for this quote's deposit.
        const res = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/pay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        if (res.status === 409) {
          // Already paid — just route to the booked page.
          router.push(`/portal/${quoteId}/approved`);
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 503 && body.code === 'valor-not-configured') {
          if (!cancelled) setPhase('unconfigured');
          return;
        }
        if (!res.ok || !body.clientToken) {
          throw new Error(body.error || `Could not start payment (${res.status})`);
        }
        if (cancelled) return;
        setAmountUsd(typeof body.amountUsd === 'number' ? body.amountUsd : null);

        // 2. Load Passage.js + 3. mount the card fields.
        await loadPassageScript();
        if (cancelled) return;
        mountPassage(containerId, {
          clientToken: body.clientToken,
          onSuccess: () => {
            // Webhook is authoritative for "booked"; this is optimistic UI.
            setPhase('confirming');
            router.push(`/portal/${quoteId}/approved`);
          },
          onError: (err) => {
            setErrorMsg(passageErrorMessage(err));
            setPhase('error');
          },
          onFailure: (err) => {
            setErrorMsg(passageErrorMessage(err));
            setPhase('error');
          },
        });
        if (!cancelled) setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : 'Something went wrong starting payment.');
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [quoteId, router]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Pay your deposit"
    >
      <div className="w-full max-w-md rounded-2xl bg-[#0D1519] border border-[#FFB744]/30 shadow-2xl p-6 text-[#F4ECD8]">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="font-display text-[20px] font-bold">
            Pay your deposit
            {amountUsd != null && (
              <span className="text-[#FFD07A]"> · {formatUsd(amountUsd)}</span>
            )}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close payment"
            className="text-[#A89F87] hover:text-[#F4ECD8] text-[13px] underline cursor-pointer"
          >
            Cancel
          </button>
        </div>

        {phase === 'loading' && (
          <p className="text-[14px] text-[#A89F87] py-8 text-center">Loading secure checkout…</p>
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
            <p role="alert" className="text-[14px] text-[#F4ECD8] bg-[#7A1C24] border border-[#C8313D]/50 rounded-md px-3 py-2">
              {errorMsg || 'Payment could not be completed. Please try again.'}
            </p>
            <button
              type="button"
              onClick={() => {
                startedRef.current = false;
                setPhase('loading');
                setErrorMsg(null);
                // Re-run the effect by forcing a remount via key is cleaner, but
                // a simple reload of the flow keeps this component self-contained.
                router.refresh();
              }}
              className="mt-4 inline-flex items-center justify-center min-h-[44px] px-5 py-3 rounded-full bg-[#C8313D] text-[#F4ECD8] font-semibold text-[14px] cursor-pointer hover:bg-[#D8434F]"
            >
              Try again
            </button>
          </div>
        )}

        {phase === 'confirming' && (
          <p className="text-[14px] text-[#A89F87] py-8 text-center">Confirming your payment…</p>
        )}

        {/* Passage.js mounts its card fields here. Kept in the DOM whenever the
            checkout could be active so the SDK has a stable container. */}
        <div
          id={containerId}
          className={phase === 'ready' || phase === 'confirming' ? 'block' : 'hidden'}
        />

        <p className="mt-4 text-[11px] text-[#6E6553] text-center">
          🔒 Secured by Valor PayTech. Your card details go straight to our payment processor.
        </p>
      </div>
    </div>
  );
}

function passageErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const m = o.message ?? o.error ?? o.responseText ?? o.errorMessage;
    if (typeof m === 'string' && m.trim()) return m;
  }
  return 'Your card could not be charged. Please check your details and try again.';
}
