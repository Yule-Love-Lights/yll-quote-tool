import type { Kpis } from '@/lib/dashboard/types';
import { KpiCard } from './KpiCard';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtDays(n: number | null): string {
  if (n == null) return '—';
  if (n < 1) return `${(n * 24).toFixed(1)} hr`;
  return `${n.toFixed(1)} d`;
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

export function KpiStrip({ kpis }: { kpis: Kpis }) {
  return (
    <section aria-label="Key metrics" className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8">
      <KpiCard
        label="Quote turnaround"
        value={fmtDays(kpis.avgTurnaroundDays)}
        sub="created → sent (avg)"
        prominent
      />
      <KpiCard label="Booked (30 days)" value={fmtMoney(kpis.bookedRevenueRecent)} sub="trailing 30 days" />
      <KpiCard label="Booked (lifetime)" value={fmtMoney(kpis.bookedRevenue)} />
      <KpiCard label="Active quotes" value={kpis.activeQuotes.toString()} sub="sent · awaiting customer" />
      <KpiCard label="Conversion" value={fmtPct(kpis.conversionRate)} sub="approved / reached" />
    </section>
  );
}
