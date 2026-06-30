'use client';

import { useState } from 'react';
import type {
  ResponseAnalyticsData,
  WindowKey,
  BucketSlice,
  TrendDirection,
} from '@/lib/dashboard/inbox/responseMetrics';
import { formatWaiting } from '@/lib/dashboard/inbox/notify';

// Client component — richer response-time analytics with an All-time / 90d / 30d
// window toggle. Purely presentational: the server pre-computes every window, this
// just toggles between them. Rendered on /inbox, /insights, and the home dashboard.

const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'all', label: 'All-time' },
  { key: '90', label: '90 days' },
  { key: '30', label: '30 days' },
];

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}
function dur(ms: number | null): string {
  return ms == null ? '—' : formatWaiting(ms);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-lg font-semibold" style={{ color: 'var(--op-text)' }}>{value}</div>
      <div className="text-xs" style={{ color: 'var(--op-text-2)' }}>{label}</div>
    </div>
  );
}

function BucketBars({ buckets }: { buckets: BucketSlice[] }) {
  return (
    <ul className="space-y-1">
      {buckets.map((b) => (
        <li key={b.key} className="flex items-center gap-2 text-xs" style={{ color: 'var(--op-text)' }}>
          <span className="w-16 shrink-0" style={{ color: 'var(--op-text-2)' }}>{b.label}</span>
          <span className="flex-1 h-3 rounded overflow-hidden" style={{ background: 'var(--op-border)' }}>
            <span
              className="block h-3 rounded"
              style={{ width: `${Math.round((b.pct ?? 0) * 100)}%`, background: 'var(--brand-evergreen-3)' }}
            />
          </span>
          <span className="w-20 shrink-0 text-right" style={{ color: 'var(--op-text-2)' }}>
            {b.count} · {pct(b.pct)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TrendArrow({ direction }: { direction: TrendDirection }) {
  if (direction === 'faster') return <span style={{ color: '#15803d' }}>▼ faster</span>;
  if (direction === 'slower') return <span style={{ color: '#b91c1c' }}>▲ slower</span>;
  if (direction === 'flat') return <span style={{ color: 'var(--op-text-2)' }}>— flat</span>;
  return <span style={{ color: 'var(--op-text-2)' }}>—</span>;
}

export function ResponseAnalytics({ data }: { data: ResponseAnalyticsData }) {
  const [win, setWin] = useState<WindowKey>('30');
  const m = data.windows[win];
  // Nothing to show if we've never handled or opened anything.
  if (data.windows.all.handled === 0 && data.windows.all.open === 0) return null;

  return (
    <section
      className="mt-8 rounded-lg border p-4"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
          Response time{data.truncated ? ' (most recent 2,000)' : ''}
        </h2>
        <div className="flex gap-1 text-xs">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => setWin(w.key)}
              className="px-2 py-1 rounded"
              style={{
                background: win === w.key ? 'var(--brand-evergreen-3)' : 'transparent',
                color: win === w.key ? 'white' : 'var(--op-text-2)',
                border: '1px solid var(--op-border)',
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Median reply" value={dur(m.medianResponseMs)} />
        <Stat label="Within 1h" value={pct(m.withinOneHourPct)} />
        <Stat label="Within 4h" value={pct(m.withinFourHoursPct)} />
        <Stat label="Handled" value={String(m.handled)} />
      </div>

      <div className="mt-4">
        <div className="text-xs font-medium mb-1" style={{ color: 'var(--op-text-2)' }}>How fast we reply</div>
        <BucketBars buckets={m.buckets} />
      </div>

      <div className="mt-4 text-sm" style={{ color: 'var(--op-text)' }}>
        <div className="text-xs font-medium mb-1" style={{ color: 'var(--op-text-2)' }}>
          Trend (median reply, regardless of window)
        </div>
        <div className="flex flex-wrap gap-4">
          <span>This week: <strong>{dur(data.trend.thisWeekMs)}</strong></span>
          <span>Last week: <strong>{dur(data.trend.lastWeekMs)}</strong></span>
          <span>This month: <strong>{dur(data.trend.thisMonthMs)}</strong></span>
          <span><TrendArrow direction={data.trend.direction} /></span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Stat label="Median time to completed" value={dur(m.timeToCompletedMedianMs)} />
        <Stat label="Reopen rate" value={pct(data.reopen[win])} />
      </div>
      {m.completedBuckets.some((b) => b.count > 0) && (
        <div className="mt-3">
          <div className="text-xs font-medium mb-1" style={{ color: 'var(--op-text-2)' }}>Time to completed</div>
          <BucketBars buckets={m.completedBuckets} />
        </div>
      )}

      {m.byRep.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium mb-1" style={{ color: 'var(--op-text-2)' }}>By rep</div>
          <ul className="text-sm space-y-1">
            {m.byRep.map((r) => (
              <li key={r.rep} className="flex justify-between gap-3" style={{ color: 'var(--op-text)' }}>
                <span>{r.rep === 'system' ? 'Auto-resolved' : r.rep}</span>
                <span style={{ color: 'var(--op-text-2)' }}>
                  {r.handled} handled · median {dur(r.medianResponseMs)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
