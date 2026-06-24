import type { HolidayBreakdown } from '@/lib/dashboard/types';

export function HolidaySection({ data }: { data: HolidayBreakdown }) {
  const pct = data.goal.goal > 0
    ? Math.min(100, Math.round((data.goal.booked / data.goal.goal) * 100))
    : 0;

  return (
    <section
      aria-label="Holiday — season at a glance"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Holiday</h3>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
          Season goal {data.goal.booked}/{data.goal.goal} homes
        </span>
      </div>

      {/* Goal bar */}
      <div
        className="h-2 rounded-full mb-4 overflow-hidden"
        style={{ background: 'var(--op-bg-hover)' }}
        aria-label={`${pct}% of season goal`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: 'var(--brand-evergreen)' }}
        />
      </div>

      {/* By-install-month */}
      {data.byMonth.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
          No bookings yet this season.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {data.byMonth.map(m => {
            const denom = Math.max(m.booked, 1);
            const installPct = Math.round((m.installed / denom) * 100);
            return (
              <li key={m.key} className="text-sm flex items-center gap-3">
                <span className="w-20 shrink-0 tabular-nums" style={{ color: 'var(--op-text-2)' }}>
                  {m.label}
                </span>
                <span className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--op-bg-hover)' }}>
                  <span
                    className="block h-full"
                    style={{ width: `${installPct}%`, background: 'var(--brand-gold)' }}
                    aria-hidden
                  />
                </span>
                <span className="w-24 text-right tabular-nums" style={{ color: 'var(--op-text-dim)' }}>
                  {m.installed} of {m.booked}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-[10px]" style={{ color: 'var(--op-text-dim)' }}>
        Installed = home.works signature received (proxy until Phase 5).
      </p>
    </section>
  );
}
