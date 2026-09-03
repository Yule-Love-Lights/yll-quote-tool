'use client';

import { summarizeFreeSpritzers } from '@/lib/portal/freeSpritzers';

// What the customer will be told about free spritzers, shown in the BUILDER,
// where the labels that decide it are actually typed.
//
// The portal reads the free-spritzer count out of line-item label text, because
// that is where staff record the gift (measured 2026-09-03: 91 live quotes
// promise free spritzers and 94 of 96 such lines keep the promise inside the
// label of a PAID package line). A pre-merge staff review called it out: a
// staffer's typing had become customer-facing copy, and the only place to see
// the result was a different page they had no reason to open between typing the
// label and clicking Send. This closes that loop.
//
// Read-only on purpose. The switch that suppresses the notice lives on the
// admin quote page next to the record of who changed it; putting a second
// control here would give staff two places to change one thing.

type Props = {
  /** Resolved line-item labels exactly as the customer will read them, i.e.
   *  AFTER any staff rename is applied (resolveLineItemLabel). */
  labels: string[];
  /** True when the notice is switched off for this quote. */
  suppressed: boolean;
};

export function BuilderSpritzerNotice({ labels, suppressed }: Props) {
  const summary = summarizeFreeSpritzers(labels);
  if (!summary.present) return null;

  if (suppressed) {
    return (
      <div className="mb-4 p-2.5 bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-600">
        A label here promises free spritzers, but the notice is switched off for this quote, so the
        customer is told nothing about them.
      </div>
    );
  }

  return (
    <div className="mb-4 p-2.5 bg-green-50 border border-green-200 rounded-md">
      <p className="text-sm text-green-900">
        <span className="font-medium">The customer will see:</span>{' '}
        {summary.count === null
          ? 'free spritzers are included, with no number'
          : `${summary.count} spritzer${summary.count === 1 ? '' : 's'}, on us this year`}
        .
      </p>
      {summary.count === null && (
        <p className="mt-1 text-xs text-amber-700">
          No number could be read from the label. Write it as, for example, &ldquo;2 FREE Spritzers&rdquo;
          if you want the customer to see the count.
        </p>
      )}
    </div>
  );
}
