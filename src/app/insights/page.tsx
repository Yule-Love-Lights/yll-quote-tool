import { listQuotesForDashboardResult } from '@/lib/dashboard/queries';
import { monthlyRevenue, revenueByService, computeInsightStats } from '@/lib/dashboard/insights';
import { OperatorShell } from '@/components/OperatorShell';
import { KpiCard } from '@/components/dashboard/KpiCard';
import { MonthlyRevenueChart, ServiceDonut } from '@/components/dashboard/insightsCharts';
import { listItemsForMetrics, getReopenCounts, getOperatorLabels } from '@/lib/dashboard/inbox/store';
import { computeResponseAnalytics, withOperatorLabels } from '@/lib/dashboard/inbox/responseMetrics';
import { ResponseAnalytics } from '@/components/dashboard/inbox/ResponseAnalytics';

export const dynamic = 'force-dynamic';

function money(n: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}
function days(n: number | null): string {
  if (n == null) return '—';
  if (n < 1) return `${(n * 24).toFixed(1)} hr`;
  return `${n.toFixed(1)} d`;
}

export default async function InsightsPage() {
  const result = await listQuotesForDashboardResult(500);

  // AUDIT FIX (dashboard-insights-error-visibility): when the quotes read
  // fails, surface a visible banner instead of silently computing every metric
  // over an empty list (which would render "—"/$0/0% as if it were real data).
  if (!result.ok) {
    return (
      <OperatorShell active="insights">
        <div className="max-w-6xl mx-auto w-full">
          <header className="mb-6">
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Insights
            </p>
            <h1 className="text-3xl font-semibold" style={{ color: 'var(--op-text)' }}>Insights</h1>
          </header>
          <div
            role="alert"
            className="rounded-lg border p-4 text-sm"
            style={{ borderColor: 'var(--op-danger, #b91c1c)', color: 'var(--op-danger, #b91c1c)', background: 'var(--op-danger-bg, rgba(185,28,28,0.08))' }}
          >
            <p className="font-semibold">Couldn&apos;t load insights.</p>
            <p className="mt-1" style={{ color: 'var(--op-text-dim)' }}>
              The quotes query failed, so no metrics are shown (rather than misleading zeros). Try refreshing; if it persists, check the database connection.
            </p>
            <p className="mt-2 font-mono text-xs" style={{ color: 'var(--op-text-dim)' }}>{result.error}</p>
          </div>
        </div>
      </OperatorShell>
    );
  }

  const quotes = result.rows;
  const now = new Date();
  const [metricsRes, reopen, repLabels] = await Promise.all([
    listItemsForMetrics(),
    getReopenCounts(now),
    getOperatorLabels(),
  ]);
  const analytics = metricsRes.ok
    ? withOperatorLabels(computeResponseAnalytics(metricsRes.items, reopen, now, metricsRes.truncated), repLabels)
    : null;
  const months = monthlyRevenue(quotes, now, 12);
  const byService = revenueByService(quotes);
  const stats = computeInsightStats(quotes);

  return (
    <OperatorShell active="insights">
      <div className="max-w-6xl mx-auto w-full">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
            Insights
          </p>
          <h1 className="text-3xl font-semibold" style={{ color: 'var(--op-text)' }}>Insights</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-dim)' }}>
            Native metrics from this tool&apos;s quotes. (Operational metrics — collected revenue,
            installs — arrive with the home.works integration.)
          </p>
        </header>

        <section aria-label="Headline metrics" className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <KpiCard label="Close ratio" value={pct(stats.closeRatio)} sub="approved / reached" />
          <KpiCard label="Avg job value" value={money(stats.avgJobValue)} sub="approved quotes" />
          <KpiCard label="Avg quote value" value={money(stats.avgQuoteValue)} sub="all quotes" />
          <KpiCard label="Time to close" value={days(stats.timeToCloseDays)} sub="created → approved" />
          <KpiCard label="Total booked" value={money(stats.totalBooked)} sub="lifetime" />
        </section>

        <div className="mb-3">
          <MonthlyRevenueChart points={months} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ServiceDonut slices={byService} />
        </div>
        {analytics && <ResponseAnalytics data={analytics} />}
      </div>
    </OperatorShell>
  );
}
