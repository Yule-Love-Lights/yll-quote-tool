import type { Kpis } from '@/lib/dashboard/types';
import { KpiCard } from './KpiCard';
import { ConversionSplitCard } from './ConversionSplitCard';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtDays(n: number | null): string {
  if (n == null) return '—';
  if (n < 1) return `${(n * 24).toFixed(1)} hr`;
  return `${n.toFixed(1)} d`;
}

/**
 * The turnaround average deliberately skips backlog sends — quotes built weeks
 * before the wave that sent them. Naming the count keeps the average honest:
 * a number quietly computed over fewer rows than the reader assumes is the
 * same lie as a wrong number.
 */
function turnaroundSub(excluded: number): string {
  const base = 'created → sent (avg)';
  if (excluded === 0) return base;
  const noun = excluded === 1 ? 'backlog send' : 'backlog sends';
  return `${base} · ${excluded} ${noun} excluded`;
}

export function KpiStrip({ kpis }: { kpis: Kpis }) {
  return (
    <section aria-label="Key metrics" className="grid grid-cols-2 md:grid-cols-7 gap-3 mb-8">
      <KpiCard
        label="Quote turnaround"
        value={fmtDays(kpis.avgTurnaroundDays)}
        sub={turnaroundSub(kpis.turnaroundExcluded)}
        prominent
      />
      <KpiCard label="Booked (30 days)" value={fmtMoney(kpis.bookedRevenueRecent)} sub="trailing 30 days" />
      <KpiCard label="Booked (lifetime)" value={fmtMoney(kpis.bookedRevenue)} />
      <KpiCard label="Active quotes" value={kpis.activeQuotes.toString()} sub="sent · awaiting customer" />
      <ConversionSplitCard
        neighbor={kpis.conversionNeighbor}
        regular={kpis.conversionRegular}
        overall={kpis.conversionRate}
        pendingRecent={kpis.conversionPendingRecent}
      />
    </section>
  );
}
