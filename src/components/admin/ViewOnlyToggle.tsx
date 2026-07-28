'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { QuoteStatus } from '@/lib/quoteStatus';

// Staff-only "Mark as View-Only" control (admin quote DETAIL page only —
// mirrors LegacyRebookToggle exactly). Flips quotes.view_only (#176) for a
// quote staff spun up purely so a customer can browse a designed scene (scene/
// colours/prices stay live) WITHOUT being able to approve or pay a real
// deposit — the common case is a second quote built just to let a customer
// play with the colour picker. Follows PipelineActionsMenu's window.confirm +
// fetch pattern; refreshes the server-rendered page via router.refresh() on
// success so the pill above it reflects the new value immediately.
export function ViewOnlyToggle({
  quoteId,
  viewOnly,
  status,
}: {
  quoteId: string;
  viewOnly: boolean;
  /** The quote's canonical lifecycle status (deriveStatus) — gates the toggle
   *  itself: a booked (paid) quote can never go view-only (the server 409s
   *  this with code 'already-booked'), and deriveStatus reads 'approved' only
   *  while the deposit is still owed, so that's exactly "approved, unpaid". */
  status: QuoteStatus;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const bookedLocked = status === 'booked';
  const approvedUnpaid = status === 'approved';

  async function onClick() {
    const turningOn = !viewOnly;
    const lines = turningOn
      ? [
          'Mark this quote as view-only?',
          '',
          '- The customer portal stays fully viewable (scene, colours, prices).',
          '- Approving, paying, sending, and responses are all blocked — the customer can only browse.',
          ...(approvedUnpaid
            ? [
                '',
                "This quote is approved but not yet paid — the customer's \"Complete deposit\" bar will be replaced by the browsing strip until this is turned off.",
              ]
            : []),
        ]
      : [
          'Remove view-only from this quote?',
          '',
          '- The customer portal will go back to a normal, fully approvable + payable quote.',
        ];
    if (!window.confirm(lines.join('\n'))) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/view-only`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ viewOnly: turningOn }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert((body as { error?: string }).error ?? 'Could not update this quote');
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || bookedLocked}
      title={bookedLocked ? 'Not available on a booked quote' : undefined}
      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
    >
      {viewOnly ? 'Remove view-only' : 'Mark as view-only'}
    </button>
  );
}
