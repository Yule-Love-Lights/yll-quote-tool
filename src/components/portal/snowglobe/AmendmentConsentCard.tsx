'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignaturePad, type CapturedSignature } from './SignaturePad';
import type { PortalPendingAmendment } from '@/components/portal/types';

function usd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export function AmendmentConsentCard({
  quoteId,
  amendment,
}: {
  quoteId: string;
  amendment: PortalPendingAmendment;
}) {
  const router = useRouter();
  const [signature, setSignature] = useState<CapturedSignature | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!signature || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/quotes/${quoteId}/amend-consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amendedAt: amendment.amendedAt, signature }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not record your signature');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record your signature');
      setSubmitting(false);
    }
  };

  return (
    <section className="bg-slate-950 px-4 pt-6 text-slate-100 sm:px-6" aria-labelledby="amendment-consent-title">
      <div className="mx-auto max-w-2xl rounded-2xl border border-amber-300/40 bg-slate-900 p-5 shadow-xl sm:p-7">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">Updated order</p>
        <h2 id="amendment-consent-title" className="mt-2 text-2xl font-semibold">
          Review and approve this change
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-300">{amendment.reason}</p>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-slate-950/70 p-3">
            <dt className="text-slate-400">Previous total</dt>
            <dd className="mt-1 text-lg font-semibold">{usd(amendment.previousTotalUsd)}</dd>
          </div>
          <div className="rounded-lg bg-slate-950/70 p-3">
            <dt className="text-slate-400">Updated total</dt>
            <dd className="mt-1 text-lg font-semibold text-amber-200">{usd(amendment.newTotalUsd)}</dd>
          </div>
          <div className="rounded-lg bg-slate-950/70 p-3">
            <dt className="text-slate-400">Deposit already paid</dt>
            <dd className="mt-1 font-semibold">{usd(amendment.depositAppliedUsd)}</dd>
          </div>
          <div className="rounded-lg bg-slate-950/70 p-3">
            <dt className="text-slate-400">Remaining balance</dt>
            <dd className="mt-1 font-semibold">{usd(amendment.newBalanceUsd)}</dd>
          </div>
        </dl>

        <p className="mt-4 text-xs text-slate-400">
          Change in order total: {amendment.deltaUsd >= 0 ? '+' : ''}{usd(amendment.deltaUsd)}. Your existing deposit remains applied.
        </p>
        <SignaturePad inputId="amend-sig-name" onChange={setSignature} />
        {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={!signature || submitting}
          className="mt-5 w-full rounded-lg bg-amber-400 px-4 py-3 font-semibold text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Recording signature…' : 'Approve updated order'}
        </button>
      </div>
    </section>
  );
}
