import type { QuoteBuildTimingStat } from '@/lib/quoteBuildTiming';

function duration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function QuoteBuildTiming({
  stats,
  error = null,
}: {
  stats: QuoteBuildTimingStat[];
  error?: string | null;
}) {
  return (
    <section
      className="mt-8 rounded-lg border p-4"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <h2 className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
        Quote build time
      </h2>
      <p className="mt-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>
        Wall-clock time from first contact selection, or a prefilled builder opening, to the first recorded
        send, grouped by the staff member who started it. Manual Mark as sent counts; test quotes, retries,
        and resends are excluded. Since tracking began.
      </p>

      {error ? (
        <div role="alert" className="mt-4 text-sm" style={{ color: 'var(--op-danger, #b91c1c)' }}>
          Quote timing could not be loaded. Try refreshing.
        </div>
      ) : stats.length === 0 ? (
        <p className="py-6 text-center text-sm" style={{ color: 'var(--op-text-dim)' }}>
          No completed quote sessions yet.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--op-text-dim)' }}>
                <th className="pb-2 pr-4 font-medium">Staff</th>
                <th className="pb-2 px-4 text-right font-medium">Quotes</th>
                <th className="pb-2 px-4 text-right font-medium">Average</th>
                <th className="pb-2 px-4 text-right font-medium">Median</th>
                <th className="pb-2 px-4 text-right font-medium">P90</th>
                <th className="pb-2 pl-4 text-right font-medium" title="Sessions left out of these figures because they ran past the two-hour idle cap. A quote left open over lunch measures interruption, not effort.">Not counted</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((stat) => (
                <tr key={stat.operatorId ?? `former:${stat.operatorLabel}`} className="border-t" style={{ borderColor: 'var(--op-border)' }}>
                  <td className="py-2 pr-4" style={{ color: 'var(--op-text)' }}>{stat.operatorLabel}</td>
                  <td className="py-2 px-4 text-right tabular-nums" style={{ color: 'var(--op-text-2)' }}>{stat.count}</td>
                  <td className="py-2 px-4 text-right tabular-nums" style={{ color: 'var(--op-text-2)' }}>{stat.count === 0 ? '—' : duration(stat.averageSeconds)}</td>
                  <td className="py-2 px-4 text-right tabular-nums" style={{ color: 'var(--op-text-2)' }}>{stat.count === 0 ? '—' : duration(stat.medianSeconds)}</td>
                  <td className="py-2 px-4 text-right tabular-nums" style={{ color: 'var(--op-text-2)' }}>{stat.count === 0 ? '—' : duration(stat.p90Seconds)}</td>
                  <td className="py-2 pl-4 text-right tabular-nums" style={{ color: 'var(--op-text-dim)' }}>{stat.excludedCount || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
