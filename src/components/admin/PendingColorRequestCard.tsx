'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Ledger #163 — staff apply/dismiss a booked customer's requested colour
// change (approval_snapshot.pendingColorRequest, written by
// color-change-request/route.ts when the customer clicks "Request colour
// change" on the portal). Apply re-freezes customerSelection to the requested
// colour (re-validated live server-side) and notifies the customer; dismiss
// requires a note explaining why and leaves the booked selection untouched.
// Posts to /api/quotes/[id]/color-change-apply and refreshes the
// server-rendered detail page on success.

type PendingColorRequest = {
  colorSchemeId: string;
  customPattern: string[];
  colorIds: string[] | null;
  label: string;
  requestedAt: string;
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export function PendingColorRequestCard({
  quoteId,
  request,
}: {
  quoteId: string;
  request: PendingColorRequest;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingApply, setConfirmingApply] = useState(false);
  const [showDismiss, setShowDismiss] = useState(false);
  const [note, setNote] = useState('');

  async function post(body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/color-change-apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? 'Something went wrong');
        return false;
      }
      return true;
    } catch {
      setError('Network error, please try again');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (await post({ action: 'apply' })) {
      router.refresh();
    }
  }

  async function dismiss() {
    const trimmed = note.trim();
    if (!trimmed) {
      setError('Enter a note explaining why this request is dismissed');
      return;
    }
    if (await post({ action: 'dismiss', note: trimmed })) {
      router.refresh();
    }
  }

  return (
    <div className="bg-white border border-amber-300 rounded-lg p-4 mb-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">
        Pending colour change request
      </h2>
      <p className="text-sm text-gray-700 mb-1">
        Requested: <span className="font-medium">{request.label}</span>
      </p>
      <p className="text-xs text-gray-400 mb-3">Requested {fmtDate(request.requestedAt)}</p>

      {!confirmingApply && !showDismiss && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setConfirmingApply(true)}
            disabled={busy}
            className="bg-gray-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setShowDismiss(true)}
            disabled={busy}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      )}

      {confirmingApply && (
        <div className="border border-gray-200 rounded p-3 bg-gray-50">
          <p className="text-sm text-gray-700 mb-2">
            Apply <span className="font-medium">{request.label}</span> to this order? The customer will be
            notified by text and email.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={apply}
              disabled={busy}
              className="bg-gray-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50"
            >
              {busy ? 'Applying…' : 'Confirm apply'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingApply(false)}
              disabled={busy}
              className="text-sm text-gray-500 hover:underline disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showDismiss && (
        <div className="border border-gray-200 rounded p-3 bg-gray-50">
          <label className="block mb-2">
            <span className="block text-xs text-gray-500 mb-1">Why is this being dismissed? (required)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
              placeholder="e.g. Customer changed their mind on a call"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={dismiss}
              disabled={busy || !note.trim()}
              className="bg-red-600 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50"
            >
              {busy ? 'Dismissing…' : 'Confirm dismiss'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowDismiss(false);
                setNote('');
              }}
              disabled={busy}
              className="text-sm text-gray-500 hover:underline disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
