import type { ConversionSplit } from '@/lib/dashboard/types';

function fmtRate(n: number | null): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

/**
 * Conversion, split into YLL Neighbors and everyone else (Naldo, 2026-09-03).
 * One blended rate hid two very different funnels: a returning neighbour and a
 * cold lead do not behave alike, and averaging them describes neither.
 *
 * Every rate ships with its own counts. A percentage with no denominator is
 * how "0%" from a single quote gets read as a collapse.
 *
 * The rates cover settled quotes only: those sent long enough ago to have been
 * answered (DASHBOARD_CONFIG.conversionCoolingDays). Anything newer is counted
 * separately as "still out" rather than silently as a loss. Measured on live
 * data 2026-09-04: without that rule a 51-quote send wave read as Neighbors
 * 27% against Regular 39%, when the settled figures were 71% and 49% - the
 * opposite conclusion, from a clock rather than from customer behaviour.
 */
export function ConversionSplitCard({
  neighbor,
  regular,
  overall,
  pendingRecent,
}: {
  neighbor: ConversionSplit;
  regular: ConversionSplit;
  overall: number | null;
  pendingRecent: number;
}) {
  const totalReached = neighbor.reached + regular.reached;
  const totalApproved = neighbor.approved + regular.approved;

  const rows: Array<{ name: string; s: ConversionSplit }> = [
    { name: 'Neighbors', s: neighbor },
    { name: 'Regular', s: regular },
  ];

  return (
    <div
      // Spans two of the strip's seven columns, like the turnaround card.
      // This card carries four numbers where a KpiCard carries one; measured
      // in a single column, its counts rendered past the card border between
      // roughly 768px and 1100px, which is exactly the window a laptop
      // browser sits in and exactly the digits the card exists to show.
      className="rounded-lg border p-4 md:col-span-2"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
        Conversion
      </div>
      <dl className="mt-1 space-y-1">
        {rows.map(({ name, s }) => (
          <div key={name} className="flex items-baseline justify-between gap-2">
            {/* Fixed label width so both rows leave their value the SAME room.
                Without it "Neighbors" is two characters longer than "Regular",
                so on a phone one row wraps its count and the other does not,
                and the two rates stop lining up. */}
            <dt className="w-16 shrink-0 text-xs" style={{ color: 'var(--op-text-dim)' }}>
              {name}
            </dt>
            <dd className="flex flex-wrap items-baseline justify-end gap-x-1.5">
              <span
                className="text-xl font-semibold tabular-nums"
                style={{ color: 'var(--op-text)' }}
              >
                {fmtRate(s.rate)}
              </span>
              {/* Read aloud as "21 of 79 approved" rather than "21 79" — the
                  slash carries the whole meaning visually and none of it to a
                  screen reader. */}
              <span className="text-xs tabular-nums" style={{ color: 'var(--op-text-dim)' }}>
                <span aria-hidden="true">
                  {s.approved}/{s.reached}
                </span>
                <span className="sr-only">
                  {s.approved} of {s.reached} approved
                </span>
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-1 text-xs tabular-nums" style={{ color: 'var(--op-text-dim)' }}>
        {fmtRate(overall)} overall · {totalApproved}/{totalReached} reached
      </div>
      {/* Named, never silent. These quotes are in none of the three rates
          above, and after a send wave they can be most of the pipeline.
          Deliberately NOT "still out": this bucket also holds quotes already
          won or cancelled inside the window, which wait for their own cohort
          rather than being counted while their siblings cannot be. */}
      {pendingRecent > 0 && (
        <div className="mt-0.5 text-xs tabular-nums" style={{ color: 'var(--op-text-dim)' }}>
          {pendingRecent} sent too recently to count yet
        </div>
      )}
    </div>
  );
}
