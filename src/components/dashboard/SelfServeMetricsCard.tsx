import type { SelfServeMetrics } from '@/lib/dashboard/selfServeMetrics';

// Self-serve estimate accuracy — the operator dashboard's Phase A→B go/no-go
// tile (ledger self-serve slice 2b). Matches the ReferralMetricsCard style
// (--op-* vars, a `dl` stat grid). "In range" is the headline: how often the
// staff-verified final landed inside the range the customer was shown.

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

export function SelfServeMetricsCard({ data }: { data: SelfServeMetrics }) {
  return (
    <section
      aria-label="Self-serve estimate accuracy"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Self-serve estimates</h3>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>Phase A accuracy</span>
      </div>

      {data.totalEstimates === 0 ? (
        <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>No self-serve estimates yet.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Estimates</dt>
              <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
                {data.totalEstimates}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Verified</dt>
              <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
                {data.verifiedCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Final in range</dt>
              <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
                {fmtPct(data.inRangeRate)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Median miss</dt>
              <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
                {fmtPct(data.medianMissPct)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs" style={{ color: 'var(--op-text-dim)' }}>
            How often the staff-confirmed price landed inside the range the customer was shown. Phase A→B gate.
          </p>
        </>
      )}
    </section>
  );
}
