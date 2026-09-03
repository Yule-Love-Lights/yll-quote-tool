'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// What the customer is told about free spritzers, and the switch to stop it.
//
// The portal reads the free-spritzer count out of the LABEL TEXT staff type
// into line items, because that is where the promise actually lives (measured
// 2026-09-03: 91 live quotes promise free spritzers and 94 of 96 such lines
// keep it inside the label of a PAID package line). That makes a staff member's
// typing customer-facing copy, and until this panel existed there was no way to
// see what it produced or to stop it on one quote.
//
// Three states, deliberately distinguished rather than collapsed:
//   - a count was read      → the customer sees that number
//   - a promise, no number  → the customer is told spritzers are included, with
//                             no figure, because guessing one would be worse
//   - nothing               → no thank you anywhere on the portal

type Props = {
  quoteId: string;
  /** Free spritzers the SELECTED labels promise, as the portal computes it. */
  count: number | null;
  present: boolean;
  suppressed: boolean;
  /** The labels the count was read from, so staff can see the actual text. */
  sourceLabels: string[];
  /** Whether this customer reads as returning, which changes the wording. */
  isReturningCustomer: boolean;
  /** Which selection the reading came from, so the heading can be honest:
   *  'approved' is a fact (the order is frozen), 'browsing' is what they had
   *  when they last looked, and 'all' is a prediction that holds only while the
   *  item carrying the promise stays selected. */
  basis: 'approved' | 'browsing' | 'all';
  /** Every recorded change to this switch, newest first. Empty for a quote
   *  nobody has touched, and also for one changed before this record existed. */
  history: Array<{ hidden: boolean; actor: string; at: string; count: number | null }>;
};

export function SpritzerNoticePanel({
  quoteId,
  count,
  present,
  suppressed,
  sourceLabels,
  isReturningCustomer,
  basis,
  history,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setSuppressed(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/spritzer-notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suppressed: next }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? 'Something went wrong');
        return;
      }
      const b = (await res.json().catch(() => ({}))) as { audited?: boolean };
      // Say so rather than implying a record exists. The change itself landed;
      // only the history line did not.
      if (b.audited === false) {
        setError('Saved, but this change could not be added to the record below.');
      }
      router.refresh();
    } catch {
      setError('Network error, please try again');
    } finally {
      setBusy(false);
    }
  }

  // The exact sentence the portal renders, kept in step with the callout in
  // WhatsIncluded.tsx. Staff should not have to open the portal to know what a
  // label produced.
  const headline =
    count === null ? 'Free spritzers, on us this year' : `${count} spritzer${count === 1 ? '' : 's'}, on us this year`;
  const body = isReturningCustomer
    ? 'Thank you for coming back to Yule Love Lights. They are already in your design, at no charge.'
    : 'They are already in your design, at no charge.';

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
        Free spritzer notice
      </h2>

      {/* Suppressed is checked FIRST on purpose. A quote can be switched off
          AND have its labels edited afterwards so nothing promises spritzers
          any more; testing `present` first would then hide the only control
          that turns it back on, stranding the switch where staff cannot reach
          it. */}
      {!present && !suppressed ? (
        <p className="text-sm text-gray-600">
          No line item on this quote mentions free spritzers, so the customer is told nothing about them.
        </p>
      ) : suppressed ? (
        <>
          <p className="text-sm text-gray-600 mb-3">
            {present
              ? 'Turned off for this quote. The customer sees no mention of free spritzers, even though a label still promises them.'
              : 'Turned off for this quote. No label promises free spritzers any more either, so nothing would show even if you turned it back on.'}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setSuppressed(false)}
            className="text-xs font-medium px-2.5 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Show it again'}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-gray-400 mb-2">
            {basis === 'approved'
              ? 'The customer approved this order, and sees this on their portal:'
              : basis === 'browsing'
                ? 'With the selection this customer last saved, they see:'
                : 'While the item below stays in their selection, the customer sees:'}
          </p>
          <div className="rounded-md border border-green-200 bg-green-50 p-3 mb-3">
            <p className="text-sm font-semibold text-green-900">{headline}</p>
            <p className="text-sm text-green-800">{body}</p>
          </div>

          {count === null && (
            <p className="text-xs text-amber-700 mb-3">
              No number could be read from the label, so the customer is told spritzers are included without a
              count. Rewrite the label as, for example, &ldquo;2 FREE Spritzers&rdquo; if you want the number
              shown.
            </p>
          )}

          <p className="text-xs text-gray-400 mb-1">Read from:</p>
          <ul className="mb-3 space-y-1">
            {sourceLabels.map((l) => (
              <li key={l} className="text-xs text-gray-600 break-words">
                {l}
              </li>
            ))}
          </ul>

          <button
            type="button"
            disabled={busy}
            onClick={() => setSuppressed(true)}
            className="text-xs font-medium px-2.5 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Do not show this to the customer'}
          </button>
        </>
      )}

      {history.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <p className="text-xs text-gray-400 mb-1">Record of changes:</p>
          <ul className="space-y-1">
            {history.map((h) => (
              <li key={`${h.at}-${h.actor}`} className="text-xs text-gray-600">
                {h.hidden ? 'Hidden' : 'Shown again'}
                {h.hidden && h.count !== null ? ` (a promise of ${h.count})` : ''} by {h.actor} on{' '}
                {new Date(h.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
