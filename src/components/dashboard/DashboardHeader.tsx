import Link from 'next/link';

import { ClockCard } from '@/components/dashboard/ClockCard';

export function DashboardHeader() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 mb-8">
      <div>
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-1"
          style={{ color: 'var(--brand-evergreen-3)' }}
        >
          Operator dashboard
        </p>
        <h1 className="text-3xl font-semibold" style={{ color: 'var(--op-text)' }}>
          Good morning.
        </h1>
      </div>
      {/* The office time clock lives here, in the header (row 337, Naldo's placement). */}
      <ClockCard />
      <Link
        href="/quote/new"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm"
        style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
      >
        + New quote
      </Link>
    </header>
  );
}
