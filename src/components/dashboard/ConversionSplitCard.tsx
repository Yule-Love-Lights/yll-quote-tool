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
 * how "0%" from a single quote gets read as a collapse, and how a rate built
 * on quotes sent hours ago gets read as a verdict.
 */
export function ConversionSplitCard({
  neighbor,
  regular,
  overall,
}: {
  neighbor: ConversionSplit;
  regular: ConversionSplit;
  overall: number | null;
}) {
  const totalReached = neighbor.reached + regular.reached;
  const totalApproved = neighbor.approved + regular.approved;

  const rows: Array<{ name: string; s: ConversionSplit }> = [
    { name: 'Neighbors', s: neighbor },
    { name: 'Regular', s: regular },
  ];

  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
        Conversion
      </div>
      <dl className="mt-1 space-y-1">
        {rows.map(({ name, s }) => (
          <div key={name} className="flex items-baseline justify-between gap-2">
            <dt className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
              {name}
            </dt>
            <dd className="flex items-baseline gap-1.5">
              <span
                className="text-xl font-semibold tabular-nums"
                style={{ color: 'var(--op-text)' }}
              >
                {fmtRate(s.rate)}
              </span>
              <span className="text-xs tabular-nums" style={{ color: 'var(--op-text-dim)' }}>
                {s.approved}/{s.reached}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-1 text-xs tabular-nums" style={{ color: 'var(--op-text-dim)' }}>
        {fmtRate(overall)} overall · {totalApproved}/{totalReached} reached
      </div>
    </div>
  );
}
