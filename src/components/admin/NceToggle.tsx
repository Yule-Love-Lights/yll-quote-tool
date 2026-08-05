'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Staff-only "Mark as NCE" control (admin quote DETAIL page only — mirrors
// LegacyRebookToggle exactly). Flips quotes.is_nce (#198). Follows
// PipelineActionsMenu's window.confirm + fetch pattern; refreshes the
// server-rendered page via router.refresh() on success so the NceBadge above
// it reflects the new value immediately.
//
// Kept as its own component rather than a shared parameterized toggle with
// LegacyRebookToggle: the two flags' confirm-copy genuinely diverges (Neighbor
// lists 3 real behavior changes today; NCE currently has none of its own —
// #199's money behaviors aren't built yet) — same precedent as
// ViewOnlyToggle, which is structurally identical to LegacyRebookToggle and
// was ALSO kept separate for the same reason.
export function NceToggle({ quoteId, isNce }: { quoteId: string; isNce: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    const turningOn = !isNce;
    const lines = turningOn
      ? [
          'Mark this quote as NCE?',
          '',
          'NCE = the barter/trade network YLL belongs to.',
          '- This sets the tag only — deposit percent, balance-collection, and invoice mark-paid behaviors are a separate update (ledger #199) and are unaffected by this toggle today.',
          "- If this quote is already sent and linked to a customer, the customer's profile is tagged NCE immediately too.",
        ]
      : ['Remove the NCE tag from this quote?'];
    if (!window.confirm(lines.join('\n'))) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/nce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isNce: turningOn }),
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
      {isNce ? 'Remove NCE' : 'Mark as NCE'}
    </button>
  );
}
