// Office is a role-based entry section, not a second operations application.
// It groups the existing operator workflows so the underlying quote, customer,
// dispatch, and time records each keep their one canonical owner.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { authGateEngaged, getOperator } from '@/lib/auth/supabaseServer';

export const dynamic = 'force-dynamic';

const OFFICE_WORK = [
  {
    href: '/',
    title: 'Dashboard and time clock',
    description: 'Check the daily picture and use the existing office clock.',
  },
  {
    href: '/inbox',
    title: 'Customer inbox',
    description: 'Respond to new leads and keep customer conversations moving.',
  },
  {
    href: '/admin/quotes',
    title: 'Quotes',
    description: 'Create, send, and follow the current quote pipeline.',
  },
  {
    href: '/admin/jobs',
    title: 'Jobs',
    description: 'Review booked work and the current job pipeline.',
  },
  {
    href: '/admin/schedule',
    title: 'Schedule',
    description: 'Assign field crew and review the day’s workload.',
  },
  {
    href: '/customers',
    title: 'Customers',
    description: 'Find customer history and linked quotes in one place.',
  },
] as const;

export default async function OfficePage() {
  // The proxy protects the operator surface; keep the same server-rendered
  // defense-in-depth check used by customer and settings pages.
  if (authGateEngaged() && !(await getOperator())) {
    redirect('/login?from=/office');
  }

  return (
    <OperatorShell active="office">
      <main className="max-w-4xl mx-auto w-full">
        <header className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
            Operations Hub
          </p>
          <h1 className="text-3xl font-semibold" style={{ color: 'var(--op-text)' }}>Office workspace</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-dim)' }}>
            Customer, quote, dispatch, and scheduling work from the existing Cool Tool.
          </p>
        </header>

        <section aria-label="Office workflows" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {OFFICE_WORK.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-xl border p-5 transition-colors"
              style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
            >
              <h2 className="font-semibold" style={{ color: 'var(--op-text)' }}>{item.title}</h2>
              <p className="text-sm mt-1" style={{ color: 'var(--op-text-dim)' }}>{item.description}</p>
            </Link>
          ))}
        </section>
      </main>
    </OperatorShell>
  );
}
