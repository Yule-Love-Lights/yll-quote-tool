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
// lists 3 real behavior changes; NCE lists its OWN real behavior changes now
// too — #199's money behaviors: the 40% deposit default, the balance-
// collection block, invoice mark-paid-NCE) — same precedent as ViewOnlyToggle,
// which is structurally identical to LegacyRebookToggle and was ALSO kept
// separate for the same reason.
export function NceToggle({ quoteId, isNce }: { quoteId: string; isNce: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    const turningOn = !isNce;
    // #199 (wrap-review F5): this copy must match the ROUTE's ACTUAL rule,
    // not the builder chip's — nce/route.ts only fills a BLANK deposit
    // (never overwrites a staff-set override), unlike the chip's
    // unconditional force-set. Kept in sync by hand; see the route's own
    // header comment for the authoritative version of this rule.
    const lines = turningOn
      ? [
          'Mark this quote as NCE?',
          '',
          'NCE = the barter/trade network YLL belongs to.',
          '- Pre-approval, sets the deposit to 40% — but only when the deposit is still blank (a staff-set override is never overwritten).',
          '- The remaining balance can no longer be charged by card or sent a pay-link — it settles through NCE, recorded manually with a trade reference number (the invoice\'s "Mark paid — NCE" panel).',
          '- If this quote is already BOOKED, its "Charge saved card" button locks immediately too (an explicit staff override remains available).',
          "- If this quote is already sent and linked to a customer, the customer's profile is tagged NCE immediately too.",
        ]
      : [
          'Remove the NCE tag from this quote?',
          '',
          '- Pre-approval, an UNTOUCHED 40% deposit (one this toggle itself set) reverts to blank (50%) — any other staff-set percent is left alone.',
          '- Card charges and the balance pay-link work normally again.',
          "- If this already propagated to the customer's profile (the quote was sent while tagged), the customer stays tagged NCE — propagation is one-way. Remove it on the customer's profile directly if that's also wrong.",
        ];
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
