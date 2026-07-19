'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Ledger #163 Slice B — staff act on a customer's pending colour-change request.
// Shown on the admin quote detail page when approval_snapshot.pendingColorRequest
// is set (by the portal "Request colour change" button). Apply re-freezes the
// booked order's colour (the crew's materials follow); the total never changes.
// Dismiss rejects it with a required reason. Posts to
// /api/quotes/[id]/apply-color-request and refreshes the page on success.

export function ColorRequestPanel({ quoteId, label }: { quoteId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
