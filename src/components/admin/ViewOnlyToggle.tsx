'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
}: {
  quoteId: string;
  viewOnly: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    const turningOn = !viewOnly;
    const lines = turningOn
      ? [
          'Mark this quote as view-only?',
          '',
          '- The customer portal stays fully viewable (scene, colours, prices).',
          '- Approve, pay, decline, and request-changes are all blocked — the customer can only browse.',
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
      disabled={busy}
      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
    >
      {viewOnly ? 'Remove view-only' : 'Mark as view-only'}
    </button>
  );
}
