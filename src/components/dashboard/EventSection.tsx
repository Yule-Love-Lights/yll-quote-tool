import type { EventSummary } from '@/lib/dashboard/types';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function EventSection({ data }: { data: EventSummary }) {
  return (
    <section
      aria-label="Event — date-driven jobs"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Event</h3>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>Date-driven</span>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Booked</dt>
          <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {data.booked}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Pending</dt>
          <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {data.pending}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>Revenue</dt>
          <dd className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: 'var(--op-text)' }}>
            {fmtMoney(data.bookedRevenue)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
