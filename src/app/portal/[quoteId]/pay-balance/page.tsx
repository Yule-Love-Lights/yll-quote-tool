'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { friendlyPortalError, invoiceStaleError, nceBalanceBlockedError } from '@/components/portal/friendlyError';
import { track } from '@/lib/analytics/posthog';
import { categorizeApproveError, type ApproveErrorCategory } from '@/lib/analytics/errorCategory';

// Customer-facing remaining-balance checkout (ledger #83 pay-link). Minimal page:
// the operator sends the customer this link; clicking "Pay balance" starts a Valor
// hosted-page sale (POST /api/quotes/[id]/pay-balance) and redirects there. The
// route is public (gated by the quote UUID) and refuses test quotes / zero balance.
//
// PostHog Wave 4: this page never loads the quote itself (just the UUID from the
// URL), so events here carry quote_id only — no service_type is available
// without a scope-expanding fetch. Observation only: neither event alters the
// pay flow, and pay_balance_error never fires on the success (redirect) path.

/** Pure `pay_balance_opened` properties builder, extracted for unit coverage
 * (no component-render test infra exists in this repo). */
export function buildPayBalanceOpenedProperties(
  quoteId: string | undefined,
): { quote_id: string | undefined } {
  return { quote_id: quoteId };
}

/** Pure `pay_balance_error` properties builder — same category mapping as
 * DepositCheckout's approve_error (stage: 'deposit'), here for stage: 'balance'. */
export function buildPayBalanceErrorProperties(
  quoteId: string | undefined,
  status: number | undefined,
  err: unknown,
): { quote_id: string | undefined; stage: 'balance'; category: ApproveErrorCategory } {
  return { quote_id: quoteId, stage: 'balance', category: categorizeApproveError(status, err) };
}

export default function PayBalancePage() {
  const params = useParams<{ quoteId: string }>();
  const quoteId = params?.quoteId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PostHog Wave 4 — one-shot `pay_balance_opened` on mount (ref-guarded like
  // QuoteViewTracker, so React strict-mode's double-invoke still fires once).
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || !quoteId) return;
    openedRef.current = true;
    track('pay_balance_opened', buildPayBalanceOpenedProperties(quoteId));
  }, [quoteId]);

  const pay = async () => {
    if (!quoteId) return;
    setBusy(true);
    setError(null);
    // PostHog Wave 4 — the HTTP status of a received response (undefined means
    // the failure was before any response), read by the catch block below to
    // bucket pay_balance_error's `category` (same convention as DepositCheckout).
    let failureStatus: number | undefined;
    try {
      const res = await fetch(`/api/quotes/${quoteId}/pay-balance`, { method: 'POST' });
      failureStatus = res.status;
      const body = await res.json();
      // NCE trade-settled balance (#199) — mirrors DepositCheckout's
      // view-only branch: a dead end retrying never fixes, so name the real
      // state instead of falling through to the generic checkout-error copy
      // below. The ONE deliberate NCE mention on the customer portal.
      if (!res.ok && body.code === 'nce') {
        setError(nceBalanceBlockedError());
        setBusy(false);
        return;
      }
      // Row 378 — the invoice no longer reconciles with the order's agreed
      // total, so the server refused rather than charge a figure it can't
      // stand behind. Same dead-end posture as the NCE branch above: retrying
      // can never succeed until a human reconciles the invoice, so name the
      // real state instead of the generic "please try again" copy. Unlike the
      // NCE branch this IS a defect condition rather than an expected one, so
      // it still reports pay_balance_error for the funnel.
      if (!res.ok && body.code === 'invoice-stale') {
        setError(invoiceStaleError());
        setBusy(false);
        track('pay_balance_error', buildPayBalanceErrorProperties(quoteId, res.status, new Error('invoice-stale')));
        return;
      }
      if (!res.ok || !body.redirectUrl) throw new Error('unavailable');
      window.location.href = body.redirectUrl as string;
    } catch (err) {
      // Consistency fix (audit W4-018): route through the shared friendly-error
      // helper (never surface raw backend errors) so wording/phone can't drift
      // from the rest of the portal's error copy.
      setError(friendlyPortalError('start your payment'));
      setBusy(false);
      track('pay_balance_error', buildPayBalanceErrorProperties(quoteId, failureStatus, err));
    }
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0b1220',
        color: '#f8fafc',
        padding: '24px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 440, textAlign: 'center' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Pay your remaining balance</h1>
        <p style={{ color: '#cbd5e1', marginBottom: 24, lineHeight: 1.5 }}>
          Thanks for choosing Yule Love Lights! Click below to securely pay the remaining balance for your
          installation. Your card is processed by our payment provider — it never touches our servers.
        </p>
        {error && (
          <p style={{ color: '#fca5a5', marginBottom: 16, fontSize: 14 }}>{error}</p>
        )}
        <button
          type="button"
          onClick={pay}
          disabled={busy}
          style={{
            background: '#16a34a',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '12px 24px',
            fontSize: 16,
            fontWeight: 600,
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            minHeight: 44,
          }}
        >
          {busy ? 'Starting secure checkout…' : 'Pay balance'}
        </button>
      </div>
    </main>
  );
}
