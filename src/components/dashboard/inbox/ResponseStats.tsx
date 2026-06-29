import type { ResponseMetrics } from '@/lib/dashboard/inbox/responseMetrics';
import { formatWaiting } from '@/lib/dashboard/inbox/notify';

// Server component (display only) — response-time / SLA snapshot for the inbox.
// Measures the "replying too late" pain: how fast we answer + what's overdue now.

const SOURCE_LABEL: Record<string, string> = { ghl: 'GHL', gmail: 'Gmail', quotetool: 'Quote', homeworks: 'Homeworks' };

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

export function ResponseStats({ metrics }: { metrics: ResponseMetrics }) {
  if (metrics.handled === 0 && metrics.open === 0) return null;
  return (
    <section
      className="mt-8 rounded-lg border p-4"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        Response stats — last 30 days
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Stat label="Median reply" value={dur(metrics.medianResponseMs)} />
        <Stat label="Within 4h" value={pct(metrics.withinFourHoursPct)} />
        <Stat label="Handled" value={String(metrics.handled)} />
        <Stat label="Overdue now" value={String(metrics.overdue)} />
      </div>

      {metrics.byRep.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium mb-1" style={{ color: 'var(--op-text-2)' }}>By rep</div>
          <ul className="text-sm space-y-1">
            {metrics.byRep.map((r) => (
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

      {metrics.bySource.length > 0 && (
        <div className="mt-3 text-xs" style={{ color: 'var(--op-text-2)' }}>
          {metrics.bySource.map((s) => `${SOURCE_LABEL[s.source] ?? s.source}: ${s.total}`).join(' · ')}
        </div>
      )}
    </section>
  );
}
