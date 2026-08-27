import Link from 'next/link';

import { ClockCard } from '@/components/dashboard/ClockCard';
import { getOperator } from '@/lib/auth/supabaseServer';

export async function DashboardHeader() {
  // The greeting names whoever is signed in. getOperator() is null when the gate
  // is dormant / nobody is signed in, so the name is simply omitted then.
  const operator = await getOperator();
  const name = operator?.name ?? null;

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
          Happy Holidays{name ? `, ${name}` : ''}.
        </h1>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* The office time clock lives here, in the header (row 337, Naldo's placement). */}
        <ClockCard />
        <Link
          href="/office"
          className="inline-flex items-center px-3 py-2 rounded-md font-medium text-sm"
          style={{ color: 'var(--brand-evergreen)' }}
        >
          Office
        </Link>
        {operator?.role === 'admin' && (
          <Link
            href="/management"
            className="inline-flex items-center px-3 py-2 rounded-md font-medium text-sm"
            style={{ color: 'var(--brand-evergreen)' }}
          >
            Management
          </Link>
        )}
        <Link
          href="/quote/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm"
          style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
        >
          + New quote
        </Link>
      </div>
    </header>
  );
}
