'use client';

import { useState } from 'react';
import Link from 'next/link';
import { customerRouteId } from '@/lib/dashboard/customers';
import type { CustomerSummary } from '@/lib/dashboard/types';
import { CustomerStatusBadge } from '@/components/dashboard/CustomerStatusBadge';

// Smallest client boundary for the customers page (this task): the search
// input needs client state, so the table + search move here while the server
// page keeps doing the data fetch (listQuotesForDashboard + aggregateCustomers).

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

export function CustomersTable({ customers }: { customers: CustomerSummary[] }) {
  const [search, setSearch] = useState('');

  // Case-insensitive substring on name/email/phone; phone ALSO compares
  // digits-only so a search like "631555" matches a formatted "(631) 555-…".
  const term = search.trim().toLowerCase();
  const digitsTerm = search.replace(/\D/g, '');
  const visible = customers.filter(c => {
    if (!term) return true;
    if (c.name.toLowerCase().includes(term)) return true;
    if (c.email?.toLowerCase().includes(term)) return true;
    if (c.phone?.toLowerCase().includes(term)) return true;
    if (digitsTerm && c.phone?.replace(/\D/g, '').includes(digitsTerm)) return true;
    return false;
  });

  return (
    <>
      {customers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, email, phone…"
            className="flex-1 min-w-[12rem] text-sm border border-gray-300 rounded-md px-3 py-1.5"
          />
          <span className="text-xs whitespace-nowrap" style={{ color: 'var(--op-text-dim)' }}>
            {visible.length} of {customers.length}
          </span>
        </div>
      )}

      <div
        className="rounded-lg border overflow-x-auto"
        style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
      >
        {customers.length === 0 ? (
          <div className="p-8 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>
            No customers yet — they appear here once quotes are created.
          </div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>
            No customers match this search.
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
              {visible.map(c => <CustomerRow key={c.key} c={c} />)}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
