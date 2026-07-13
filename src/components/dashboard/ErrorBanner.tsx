/**
 * Shared "couldn't load the data" banner for a failed dashboard quotes read.
 * AUDIT FIX (dashboard-insights-error-visibility, WT-38/46): extracted from
 * Insights (the original owner of this pattern) so the homepage renders the
 * identical banner instead of silently falling back to a fully-populated-
 * looking but empty dashboard ($0 KPIs, "all caught up") that's
 * indistinguishable from a real quiet day.
 */
export function DashboardErrorBanner({ title, error }: { title: string; error: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border p-4 text-sm mb-6"
      style={{ borderColor: 'var(--op-danger, #b91c1c)', color: 'var(--op-danger, #b91c1c)', background: 'var(--op-danger-bg, rgba(185,28,28,0.08))' }}
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1" style={{ color: 'var(--op-text-dim)' }}>
        The quotes query failed, so no metrics are shown (rather than misleading zeros). Try refreshing; if it persists, check the database connection.
      </p>
      <p className="mt-2 font-mono text-xs" style={{ color: 'var(--op-text-dim)' }}>{error}</p>
    </div>
  );
}

/**
 * WT-47: `listQuotesForDashboardResult` flags `capped` when the read hit the
 * row limit — lifetime aggregates on the page are then based on only the
 * newest `limit` quotes, not the true lifetime set. Shown on both the
 * dashboard and Insights (both compose from the same capped read).
 */
export function CappedCaveat({ limit }: { limit: number }) {
  return (
    <p className="text-xs mb-4" style={{ color: 'var(--op-text-dim)' }}>
      Based on the newest {limit} quotes — lifetime totals may not include everything before that.
    </p>
  );
}
