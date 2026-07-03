'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { friendlyPortalError } from '@/components/portal/friendlyError';

// Customer-facing remaining-balance checkout (ledger #83 pay-link). Minimal page:
// the operator sends the customer this link; clicking "Pay balance" starts a Valor
// hosted-page sale (POST /api/quotes/[id]/pay-balance) and redirects there. The
// route is public (gated by the quote UUID) and refuses test quotes / zero balance.

export default function PayBalancePage() {
  const params = useParams<{ quoteId: string }>();
  const quoteId = params?.quoteId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = async () => {
    if (!quoteId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/pay-balance`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok || !body.redirectUrl) throw new Error('unavailable');
      window.location.href = body.redirectUrl as string;
    } catch {
      // Consistency fix (audit W4-018): route through the shared friendly-error
      // helper (never surface raw backend errors) so wording/phone can't drift
      // from the rest of the portal's error copy.
      setError(friendlyPortalError('start your payment'));
      setBusy(false);
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
