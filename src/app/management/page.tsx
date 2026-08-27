// Management is an admin-only entry section over existing Cool Tool workflows.
// It intentionally adds no new role type or parallel Operations Hub datastore.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { authGateEngaged, getOperator } from '@/lib/auth/supabaseServer';

export const dynamic = 'force-dynamic';

const MANAGEMENT_WORK = [
  {
    href: '/',
    title: 'Dashboard',
    description: 'Review the live quote, job, invoice, and needs-action picture.',
  },
  {
    href: '/insights',
    title: 'Insights',
    description: 'Review conversion, revenue, response, and quote-build timing metrics.',
  },
  {
    href: '/admin/schedule',
    title: 'Scheduling',
    description: 'Review assignments and daily field-crew workload.',
  },
  {
    href: '/settings/accounts',
    title: 'Staff accounts',
    description: 'Manage the existing office and field staff accounts.',
  },
  {
    href: '/inventory',
    title: 'Inventory',
    description: 'Review stock, purchase orders, and job materials.',
  },
] as const;

export default async function ManagementPage() {
  // Management maps to the already-enforced admin role. Do not use the
  // presentation-only crew_members.is_office flag as an authorization signal.
  const operator = await getOperator();
  if (!operator) {
    if (authGateEngaged()) redirect('/login?from=/management');
    redirect('/office');
  }
  if (operator.role !== 'admin') {
    redirect('/office');
  }

  return (
    <OperatorShell active="management">
      <main className="max-w-4xl mx-auto w-full">
        <header className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
            Operations Hub
          </p>
          <h1 className="text-3xl font-semibold" style={{ color: 'var(--op-text)' }}>Management workspace</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-dim)' }}>
            Admin-only shortcuts for the business picture, staffing, operations, and inventory.
          </p>
        </header>

        <section aria-label="Management workflows" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {MANAGEMENT_WORK.map((item) => (
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
