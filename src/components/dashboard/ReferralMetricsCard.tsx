import type { ReferralMetrics } from '@/lib/dashboard/referralMetrics';

// Referral program growth feature 3 (ledger #41 growth) — the operator
// dashboard's read-only "Referrals" measurement tile. Matches the existing
// PermanentSection/EventSection card style (--op-* vars, a `dl` stat grid).

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

export function ReferralMetricsCard({ data }: { data: ReferralMetrics }) {
  return (
    <section
      aria-label="Referral program"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Referrals</h3>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>Growth</span>
      </div>

      {data.totalReferrals === 0 ? (
        <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>No referrals generated yet.</p>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-3 mb-4">
            <div>
              <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Generated</dt>
              <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
                {data.totalReferrals}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Booked conversion</dt>
              <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
                {fmtPct(data.bookedConversionRate)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Revenue influenced</dt>
              <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
                {data.revenueInfluenced.kind === 'usd'
                  ? fmtMoney(data.revenueInfluenced.amountUsd)
                  : `${data.revenueInfluenced.count} booked`}
              </dd>
            </div>
          </dl>

          {data.topReferrers.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide mb-2" style={{ color: 'var(--op-text-dim)' }}>
                Top referrers
              </p>
              <ol className="flex flex-col gap-1">
                {data.topReferrers.map((r, i) => (
                  <li
                    key={r.customerId}
                    className="flex items-center justify-between gap-2 text-sm"
                    style={{ color: 'var(--op-text-2)' }}
                  >
                    <span className="truncate">{i + 1}. {r.name}</span>
                    <span className="tabular-nums shrink-0" style={{ color: 'var(--op-text)' }}>
                      {r.convertedCount} booked
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  );
}
