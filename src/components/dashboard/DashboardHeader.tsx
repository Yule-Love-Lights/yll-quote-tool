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
      {/* The office time clock lives here, in the header (row 337, Naldo's placement). */}
      {/* Kept, at Jason's request (2026-09-01), alongside the compact one in
          the nav header. Both are on screen here at once, so they share a
          refresh signal (clockEvents.ts): using either makes the other re-read
          the server, or the two would sit side by side disagreeing about
          whether someone is on the clock. */}
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
