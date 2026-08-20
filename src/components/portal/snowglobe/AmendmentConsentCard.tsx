'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignaturePad, type CapturedSignature } from './SignaturePad';
import type { PortalPendingAmendment } from '@/components/portal/types';
import { portalPhone } from '@/components/portal/friendlyError';

function usd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

const REASON_MAX = 500; // mirrors the amend-decline route's own cap

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
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
  // Declining is a separate mini-flow from signing, not a second field bolted
  // onto the same form: showing the reason box only after "Keep my order as
  // it was" is clicked keeps the default view to two calm buttons, and stops
  // a customer typing into a box they never meant to submit.
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  // Ledger #83 follow-up (a real live incident — a customer had no way to say
  // no and had to phone in): once the customer has already answered NO, show
  // that answer back to them instead of asking the same question again on
  // every portal visit. This is a READ-ONLY confirmation — there is no "undo"
  // here; changing their mind means calling/texting, same as changing an
  // approved order does.
  if (amendment.consentStatus === 'declined') {
    // FIX9 (review MED): the only phone number on the whole portal used to
    // sit ~10 sections down — this screen's own copy ("We'll be in touch")
    // said nothing was actionable, and its comment above says a change of
    // mind means calling. portalPhone() is the same source + fallback every
    // other portal surface reads (friendlyError.ts, ledger #90) — reused
    // here rather than re-duplicating the inline env-read expression a
    // fourth time.
    const phone = portalPhone();
    const telHref = `tel:${phone.replace(/[^0-9+]/g, '')}`;
    return (
      <section className="bg-slate-950 px-4 pt-6 text-slate-100 sm:px-6" aria-labelledby="amendment-declined-title">
        <div className="mx-auto max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-xl sm:p-7">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Updated order</p>
          <h2 id="amendment-declined-title" className="mt-2 text-2xl font-semibold">
            You kept your order as it was
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            {amendment.declinedAt ? `On ${fmtDate(amendment.declinedAt)}, y` : 'Y'}ou told us not to make this
            change. Your order stays at <strong>{usd(amendment.previousTotalUsd)}</strong> — nothing was
            charged for it. We&apos;ll be in touch to sort out the details.
          </p>
          {amendment.declinedReason && (
            <p className="mt-3 rounded-lg bg-slate-950/70 p-3 text-sm text-slate-300">
              <span className="text-slate-400">What you told us: </span>
              {amendment.declinedReason}
            </p>
          )}
          <p className="mt-3 text-sm text-slate-300">
            Change your mind, or want to talk it through sooner? Call or text us at{' '}
            <a href={telHref} className="font-semibold text-amber-300 hover:underline">
              {phone}
            </a>
            .
          </p>
        </div>
      </section>
    );
  }

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

  const decline = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/quotes/${quoteId}/amend-decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amendedAt: amendment.amendedAt,
          ...(declineReason.trim() ? { reason: declineReason.trim() } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not record your response');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record your response');
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

        {error && <p className="mt-3 text-sm text-red-300" role="alert">{error}</p>}

        {!declining ? (
          <>
            <SignaturePad inputId="amend-sig-name" onChange={setSignature} />
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={submit}
                disabled={!signature || submitting}
                className="flex-1 rounded-lg bg-amber-400 px-4 py-3 font-semibold text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Recording signature…' : 'Approve updated order'}
              </button>
              <button
                type="button"
                onClick={() => setDeclining(true)}
                disabled={submitting}
                className="flex-1 rounded-lg border border-slate-600 px-4 py-3 font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Keep my order as it was
              </button>
            </div>
          </>
        ) : (
          <div className="mt-5 rounded-lg border border-slate-700 bg-slate-950/50 p-4">
            <label htmlFor="decline-reason" className="text-sm text-slate-300">
              Optional: let us know why (helps us follow up)
            </label>
            <textarea
              id="decline-reason"
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value.slice(0, REASON_MAX))}
              maxLength={REASON_MAX}
              rows={3}
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-900 p-2 text-sm text-slate-100 placeholder:text-slate-500"
              placeholder="e.g. that's more than I want to spend right now"
            />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={decline}
                disabled={submitting}
                className="flex-1 rounded-lg border border-slate-600 px-4 py-3 font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Recording…' : 'Confirm: keep my order as it was'}
              </button>
              <button
                type="button"
                onClick={() => setDeclining(false)}
                disabled={submitting}
                className="flex-1 rounded-lg px-4 py-3 font-semibold text-slate-400 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Back to review
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
