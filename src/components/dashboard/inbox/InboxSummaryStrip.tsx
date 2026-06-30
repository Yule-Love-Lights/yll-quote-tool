import type { InboxSummary } from '@/lib/dashboard/inbox/summary';

function fmtWait(ms: number): string {
  if (ms <= 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Tile({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-md p-3" style={{ background: 'var(--op-bg-raised)' }}>
      <div className="text-xs" style={{ color: 'var(--op-text-2)' }}>{label}</div>
      <div className="text-2xl font-semibold" style={{ color: danger ? '#dc2626' : 'var(--op-text)' }}>{value}</div>
    </div>
  );
}

export function InboxSummaryStrip({ summary }: { summary: InboxSummary }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      <Tile label="Oldest waiting" value={fmtWait(summary.oldestWaitingMs)} danger={summary.overdue > 0} />
      <Tile label="Overdue over 4h" value={String(summary.overdue)} danger={summary.overdue > 0} />
      <Tile label="In quotes waiting" value={`$${Math.round(summary.quotesWaitingUsd).toLocaleString()}`} />
      <Tile label="Open leads" value={`${summary.openLeads}${summary.filtered ? ` · ${summary.filtered} filtered` : ''}`} />
    </div>
  );
}
