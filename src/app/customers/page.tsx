import Link from 'next/link';
import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { aggregateCustomers, customerRouteId } from '@/lib/dashboard/customers';
import type { CustomerSummary } from '@/lib/dashboard/types';
import { OperatorShell } from '@/components/OperatorShell';
import { CustomerStatusBadge } from '@/components/dashboard/CustomerStatusBadge';
import { getOperator } from '@/lib/auth/supabaseServer';
import { redirect } from 'next/navigation';

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
  // Link to the detail page whenever we have a stable route id — the HighLevel
  // contact id when present, else the backfilled customer_id. Only a truly
  // identity-less walk-in (neither id) stays unclickable. (S22 fix: the link used
  // to require highlevel_contact_id, so backfilled non-CRM customers were shown
  // but never clickable.)
  const routeId = customerRouteId(c);
  return (
    <tr className="border-t" style={{ borderColor: 'var(--op-border)' }}>
      <td className="px-3 py-2.5">
        {routeId ? (
          <Link
            href={`/customers/${encodeURIComponent(routeId)}`}
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
