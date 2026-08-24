'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Ledger #163 Slice B — staff act on a customer's pending colour-change request.
// Shown on the admin quote detail page when approval_snapshot.pendingColorRequest
// is set (by the portal "Request colour change" button). Apply re-freezes the
// booked order's colour (the crew's materials follow); the total never changes.
// Dismiss rejects it with a required reason. Posts to
// /api/quotes/[id]/apply-color-request and refreshes the page on success.

// #169: the apply outcome staff must SEE before the panel refreshes away —
// the route reports the customer-notify legs (smsSent/emailSent) and whether
// notify was skipped entirely (test quote / no linked contact). A failed send
// means the colour changed but the customer doesn't know — staff calls them.
export type ApplyOutcome = {
  label: string;
  smsSent: boolean;
  emailSent: boolean;
  notifySkipped: boolean;
};

export function applyOutcomeFromResponse(
  body: Partial<ApplyOutcome>,
  fallbackLabel: string,
): ApplyOutcome {
  return {
    label: typeof body.label === 'string' ? body.label : fallbackLabel,
    smsSent: body.smsSent === true,
    emailSent: body.emailSent === true,
    notifySkipped: body.notifySkipped === true,
  };
}

export function ColorRequestPanel({ quoteId, label }: { quoteId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyOutcome | null>(null);

  async function act(action: 'apply' | 'dismiss', reason?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/apply-color-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reason != null ? { action, reason } : { action }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? 'Something went wrong');
        return;
      }
      if (action === 'apply') {
        // #169: hold the panel open to show the notify outcome — a refresh
        // would unmount it (pendingColorRequest is cleared server-side) and
        // staff would never learn a send failed.
        const b = (await res.json().catch(() => ({}))) as Partial<ApplyOutcome>;
        setApplied(applyOutcomeFromResponse(b, label));
        return;
      }
      router.refresh();
    } catch {
      setError('Network error, please try again');
    } finally {
      setBusy(false);
    }
  }

  function onDismiss() {
    const reason = window.prompt('Why are you dismissing this colour change request?');
    if (reason == null) return; // cancelled the prompt
    if (!reason.trim()) {
      setError('A reason is required to dismiss');
      return;
    }
    void act('dismiss', reason.trim());
  }

  // #169: post-apply outcome view — the colour is locked in; tell staff whether
  // the customer actually heard about it, then Done refreshes the page.
  if (applied) {
    const bothFailed = !applied.notifySkipped && !applied.smsSent && !applied.emailSent;
    const partlyFailed = !applied.notifySkipped && !bothFailed && (!applied.smsSent || !applied.emailSent);
    return (
      <div className="bg-white border border-amber-300 rounded-lg p-4 mb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">Colour change applied</h2>
        <p className="text-sm text-gray-700 mb-2">
          The order&apos;s colour is now <span className="font-medium">{applied.label}</span>.
        </p>
        {applied.notifySkipped && (
          <p className="text-xs text-gray-500 mb-3">
            No customer notification was sent (test quote or no linked HighLevel contact) — expected.
          </p>
        )}
        {!applied.notifySkipped && applied.smsSent && applied.emailSent && (
          <p className="text-xs text-green-700 mb-3">Customer notified ✓ (text + email).</p>
        )}
        {partlyFailed && (
          <p className="text-xs text-amber-700 mb-3">
            Customer partly notified — text {applied.smsSent ? 'sent ✓' : 'FAILED'}, email{' '}
            {applied.emailSent ? 'sent ✓' : 'FAILED'}.
          </p>
        )}
        {bothFailed && (
          <p className="text-xs font-semibold text-red-700 mb-3" role="alert">
            The customer was NOT notified — text and email both failed. Call them so the change
            doesn&apos;t surprise them at install.
          </p>
        )}
        <button
          type="button"
          onClick={() => router.refresh()}
          className="bg-gray-900 text-white text-sm rounded px-3 py-1.5"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white border border-amber-300 rounded-lg p-4 mb-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">Colour change requested</h2>
      <p className="text-sm text-gray-700 mb-3">
        The customer asked to change their light colour to <span className="font-medium">{label}</span>. Applying
        updates the booked order&apos;s colour and the crew&apos;s materials list. The total does not change.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => act('apply')}
          disabled={busy}
          className="bg-gray-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Apply colour change'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="text-sm text-gray-600 hover:underline disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
