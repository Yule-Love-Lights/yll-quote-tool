import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { aggregateCustomers } from '@/lib/dashboard/customers';
import { OperatorShell } from '@/components/OperatorShell';
import { getOperator } from '@/lib/auth/supabaseServer';
import { redirect } from 'next/navigation';
import { CustomersTable } from './CustomersTable';

// Always render fresh — reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  // Defense in depth behind the middleware perimeter — re-check at render so the
  // customer-PII list never serves anonymously even if the perimeter is bypassed.
  // Dormant until the auth gate is live (Slice 4).
  if (process.env.AUTH_GATE_ENABLED === 'true' && !(await getOperator())) {
    redirect('/login?from=/customers');
  }
  const quotes = await listQuotesForDashboard(500);
  const customers = aggregateCustomers(quotes);

  return (
    <OperatorShell active="customers">
      <div className="max-w-6xl mx-auto w-full">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
            Customers
          </p>
          <h1 className="text-3xl font-semibold" style={{ color: 'var(--op-text)' }}>
            {customers.length} customer{customers.length === 1 ? '' : 's'}
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-dim)' }}>
            Grouped from every quote. Click a customer to see their profile + quote history
            (live HighLevel data when they&apos;re linked in the CRM).
          </p>
        </header>

        <CustomersTable customers={customers} />
      </div>
    </OperatorShell>
  );
}
