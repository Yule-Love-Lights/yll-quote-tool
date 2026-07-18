'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { QuoteStatus } from '@/lib/quoteStatus';

// Staff-only "Mark as YLL Neighbor" control (admin quote DETAIL page only —
// deliberately NOT on the /admin/quotes list). Flips quotes.legacy_rebook for
// the rare hand-built quote that missed the #155-158 migration flag (e.g.
// quote #1191). Follows PipelineActionsMenu's window.confirm + fetch pattern;
// refreshes the server-rendered page via router.refresh() on success so the
// YllNeighborBadge above it reflects the new value immediately.
export function LegacyRebookToggle({
  quoteId,
  legacyRebook,
  status,
}: {
  quoteId: string;
  legacyRebook: boolean;
  status: QuoteStatus;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    const turningOn = !legacyRebook;
    const lines = turningOn
      ? [
          'Mark this quote as a YLL Neighbor?',
          '',
          '- The customer portal will show the "Last Year\'s Design" rebook variant (read-only items, rebook copy).',
          '- The quote will be hidden from the operator inbox.',
          '- Any GHL sync will route to the Yule Love Lights Neighbors pipeline instead of Christmas Lights.',
        ]
      : [
          'Remove YLL Neighbor from this quote?',
          '',
          '- The customer portal will go back to the normal quote view.',
          '- The quote will show up in the operator inbox again.',
          '- Any GHL sync will route to the normal service-type pipeline instead of Neighbors.',
        ];
    // Already left draft (sent/viewed/approved/booked/etc.) — flipping the flag
    // now doesn't touch anything already synced to GHL, only what happens next.
    if (turningOn && status !== 'draft') {
      lines.push('', 'This only affects future renders and syncs — it will NOT move any existing GHL card.');
    }
    if (!window.confirm(lines.join('\n'))) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/legacy-rebook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ legacyRebook: turningOn }),
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
      {legacyRebook ? 'Remove YLL Neighbor' : 'Mark as YLL Neighbor'}
    </button>
  );
}
