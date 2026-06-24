import Link from 'next/link';
import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { aggregateCustomers } from '@/lib/dashboard/customers';
import type { CustomerSummary } from '@/lib/dashboard/types';
import { OperatorShell } from '@/components/OperatorShell';
import { CustomerStatusBadge } from '@/components/dashboard/CustomerStatusBadge';

// Always render fresh — reflects the live quotes table on every load.
export const dynamic = 'force-dynamic';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function CustomerRow({ c }: { c: CustomerSummary }) {
  const contact = c.email || c.phone || '—';
  return (
    <tr className="border-t" style={{ borderColor: 'var(--op-border)' }}>
      <td className="px-3 py-2.5">
        {/* Only customers with a HighLevel contact id link to a detail page (it
            loads live HL data keyed by that id). Walk-ins with no CRM record
            still appear, just not clickable. */}
        {c.contactId ? (
          <Link
            href={`/customers/${c.contactId}`}
            className="font-medium hover:underline"
            style={{ color: 'var(--op-primary)' }}
          >
            {c.name}
          </Link>
        ) : (
          <span className="font-medium" style={{ color: 'var(--op-text)' }}>{c.name}</span>
        )}
        <div className="text-xs" style={{ color: 'var(--op-text-dim)' }}>{contact}</div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--op-text-2)' }}>{c.quoteCount}</td>
      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--op-text)' }}>{fmtMoney(c.bookedSpend)}</td>
      <td className="px-3 py-2.5"><CustomerStatusBadge status={c.latestStatus} /></td>
      <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: 'var(--op-text-dim)' }}>{fmtDate(c.latestQuoteAt)}</td>
    </tr>
  );
}

export default async function CustomersPage() {
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
            Grouped from every quote. Click a customer to see their live HighLevel profile + history.
          </p>
        </header>

        <div
          className="rounded-lg border overflow-x-auto"
          style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
        >
          {customers.length === 0 ? (
            <div className="p-8 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>
              No customers yet — they appear here once quotes are created.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase" style={{ color: 'var(--op-text-dim)', background: 'var(--op-bg)' }}>
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Customer</th>
                  <th className="text-right px-3 py-2 font-semibold">Quotes</th>
                  <th className="text-right px-3 py-2 font-semibold">Booked</th>
                  <th className="text-left px-3 py-2 font-semibold">Latest</th>
                  <th className="text-left px-3 py-2 font-semibold">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {customers.map(c => <CustomerRow key={c.key} c={c} />)}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </OperatorShell>
  );
}
