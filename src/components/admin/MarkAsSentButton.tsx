'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Staff-only "Mark as sent" action (admin quote DETAIL page only — ledger
// #182). For a quote staff delivered OUTSIDE the tool (hand-texted the
// portal link, walked through it on a call) — the quote otherwise sits
// 'draft' forever with the wrong status everywhere. DB-only: stamps
// quote_sent_at + status='sent', the same DB end-state a real send produces,
// with NO customer messaging and NO GHL side effects of any kind. Follows
// ViewOnlyToggle's window.confirm + fetch + router.refresh pattern; unlike
// that toggle this is a one-way action (no "unmark"), so the parent only
// renders it while the quote is still markable (draft/unsent).
export function MarkAsSentButton({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    const lines = [
      'Mark this quote as sent?',
      '',
      'No message is sent to the customer — this only records that you delivered it yourself.',
    ];
    if (!window.confirm(lines.join('\n'))) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/mark-sent`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert((body as { error?: string }).error ?? 'Could not mark this quote sent');
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
      Mark as sent
    </button>
  );
}
