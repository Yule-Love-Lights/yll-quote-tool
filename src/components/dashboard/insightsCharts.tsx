import type { MonthlyRevenuePoint, ServiceRevenueSlice } from '@/lib/dashboard/insights';
import type { ServiceType } from '@/lib/dashboard/types';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtCompact(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

const CardWrap = ({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) => (
  <section
    className="rounded-lg border p-4"
    style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
  >
    <div className="flex items-baseline justify-between mb-3">
      <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>{title}</h3>
      {sub && <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>{sub}</span>}
    </div>
    {children}
  </section>
);

/** Trailing-12-month booked revenue as vertical bars. Robust to sparse data. */
export function MonthlyRevenueChart({ points }: { points: MonthlyRevenuePoint[] }) {
  const max = Math.max(...points.map(p => p.revenue));
  const hasData = max > 0;
  const n = points.length;

  return (
    <CardWrap title="Monthly revenue" sub="booked · trailing 12 months">
      {!hasData ? (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--op-text-dim)' }}>
          No booked revenue yet — bars fill in as quotes are approved.
        </p>
      ) : (
        <div>
          <div className="flex items-end gap-1.5" style={{ height: 160 }}>
            {points.map(p => {
              const pct = Math.round((p.revenue / max) * 100);
              return (
                <div key={p.key} className="flex-1 flex flex-col justify-end items-center h-full" title={`${p.label}: ${fmtMoney(p.revenue)}`}>
                  <span className="text-[9px] mb-1 tabular-nums" style={{ color: 'var(--op-text-dim)' }}>
                    {p.revenue > 0 ? fmtCompact(p.revenue) : ''}
                  </span>
                  <div
                    className="w-full rounded-t"
                    style={{
                      height: `${Math.max(pct, p.revenue > 0 ? 2 : 0)}%`,
                      background: 'var(--brand-evergreen)',
                      minHeight: p.revenue > 0 ? 2 : 0,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex gap-1.5 mt-1.5">
            {points.map((p, i) => (
              <span key={p.key} className="flex-1 text-center text-[9px]" style={{ color: 'var(--op-text-dim)' }}>
                {/* label every other month to avoid crowding */}
                {i % 2 === n % 2 ? p.label : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </CardWrap>
  );
}

const SERVICE_COLOR: Record<ServiceType, string> = {
  holiday: 'var(--brand-evergreen)',
  permanent: 'var(--brand-gold)',
  event: 'var(--brand-red)',
};

/** Booked revenue split by service line, as a donut + legend. */
export function ServiceDonut({ slices }: { slices: ServiceRevenueSlice[] }) {
  const total = slices.reduce((s, x) => s + x.revenue, 0);
  const cx = 80, cy = 80, r = 58, sw = 22;
  const C = 2 * Math.PI * r;

  // Precompute each visible segment's dash length + start offset functionally
  // (no in-render mutation). offset = cumulative fraction of all earlier slices.
  const drawn = slices.filter(s => s.revenue > 0);
  const fracs = drawn.map(s => s.revenue / total);
  const segments = drawn.map((s, i) => {
    const frac = fracs[i];
    const before = fracs.slice(0, i).reduce((a, b) => a + b, 0);
    return { service: s.service, dash: frac * C, offset: -before * C };
  });

  return (
    <CardWrap title="Revenue by service" sub="booked">
      {total === 0 ? (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--op-text-dim)' }}>
          No booked revenue yet.
        </p>
      ) : (
        <div className="flex items-center gap-5">
          <svg viewBox="0 0 160 160" width={140} height={140} role="img" aria-label="Revenue by service line">
            <circle cx={cx} cy={cy} r={r} fill="none" style={{ stroke: 'var(--op-bg-hover)', strokeWidth: sw }} />
            {segments.map(seg => (
              <circle
                key={seg.service}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                style={{ stroke: SERVICE_COLOR[seg.service], strokeWidth: sw }}
                strokeDasharray={`${seg.dash} ${C - seg.dash}`}
                strokeDashoffset={seg.offset}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            ))}
          </svg>
          <ul className="flex-1 space-y-2">
            {slices.map(s => (
              <li key={s.service} className="flex items-center gap-2 text-sm">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: SERVICE_COLOR[s.service] }} aria-hidden />
                <span className="flex-1" style={{ color: 'var(--op-text-2)' }}>{s.label}</span>
                <span className="tabular-nums" style={{ color: 'var(--op-text)' }}>{fmtMoney(s.revenue)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </CardWrap>
  );
}
