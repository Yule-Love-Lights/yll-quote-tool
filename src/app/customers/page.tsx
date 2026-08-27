import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { aggregateCustomers } from '@/lib/dashboard/customers';
import { OperatorShell } from '@/components/OperatorShell';
import { authGateEngaged, getOperator } from '@/lib/auth/supabaseServer';
import { redirect } from 'next/navigation';
import { CustomersTable } from './CustomersTable';
import { listCustomerTagsByIds } from '@/lib/customers';

// Always render fresh — reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  // Defense in depth behind the middleware perimeter — re-check at render so the
  // customer-PII list never serves anonymously even if the perimeter is bypassed.
  // Engaged by default; dormant only on the explicit AUTH_GATE_ENABLED=false
  // opt-out (ledger #347).
  if (authGateEngaged() && !(await getOperator())) {
    redirect('/login?from=/customers');
  }
  const quotes = await listQuotesForDashboard(500);
  const customers = aggregateCustomers(quotes);

  // NCE + YLL Neighbor tags (#198), read-only on this list. aggregateCustomers
  // (Naldo's src/lib/dashboard/customers.ts) stays untouched — a pure fold
  // over quotes only, no separate-table read of its own — so the tag lookup
  // happens here instead: one bulk query keyed by customerId, passed down as
  // a plain lookup object (not merged into CustomerSummary/aggregateCustomers,
  // to avoid widening that Naldo-owned pure function's contract for a single
  // consumer). A customer's tag is the persisted customers-table value, which
  // can be true even when NONE of their listed quotes are individually
  // tagged (set directly on the profile, or propagated from an older quote
  // outside this 500-row window) — reading it from `customers` directly is
  // the only correct source, not a fold over the quotes on this page.
  const customerIds = customers.map(c => c.customerId).filter((id): id is string => id != null);
  const tagsById = await listCustomerTagsByIds(customerIds);
  const tagsByIdPlain = Object.fromEntries(tagsById);

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

        <CustomersTable customers={customers} tagsById={tagsByIdPlain} />
      </div>
    </OperatorShell>
  );
}
