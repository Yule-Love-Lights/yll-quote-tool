'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { InvoiceStatusBadge, INVOICE_STATUS_LABELS } from '@/components/admin/InvoiceStatusBadge';
import type { InvoiceAdminCard } from '@/lib/invoices';
import { INVOICE_STATUSES, type InvoiceStatus } from '@/lib/invoiceStatus';
import { PipelineActionsMenu } from '@/components/admin/PipelineActionsMenu';

// Operator BILLING list of invoices (ledger #83). An invoice is auto-created when
// a job is marked complete (full total, deposit applied → balance). Test invoices
// (#93) are VISIBLE here, badged.

export default function InvoicesAdminPage() {
  const [items, setItems] = useState<InvoiceAdminCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'All' | InvoiceStatus>('All');
  const [search, setSearch] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/invoices');
      if (res.status === 401) {
        window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setItems(data.invoices ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    queueMicrotask(refresh);
  }, []);

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  const money = (n: number | null | undefined) =>
    n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const term = search.trim().toLowerCase();
  const visible = items.filter((inv) => {
    if (statusFilter !== 'All' && inv.status !== statusFilter) return false;
    if (!term) return true;
    return [inv.customerName, inv.customerAddress, inv.invoiceNumber != null ? `#${inv.invoiceNumber}` : null]
      .some((v) => v != null && String(v).toLowerCase().includes(term));
  });

  return (
    <OperatorShell active="invoices">
      <div className="max-w-6xl mx-auto">
        <BillingSubNav active="invoices" />

        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Yule Love Lights — Admin
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
            <p className="text-sm text-gray-500 mt-1">
              Created when a job is marked complete — full total, deposit applied, balance due. Click an invoice for its detail.
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">{error}</div>
        )}

        {loading && <p className="text-sm text-gray-500">Loading…</p>}

        {!loading && items.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No invoices yet — one appears here when a job is marked complete.</p>
          </div>
        )}

        {!loading && items.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex flex-wrap gap-1">
              {(['All', ...INVOICE_STATUSES] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
                    statusFilter === s
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {s === 'All' ? 'All' : INVOICE_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, address, invoice #…"
              className="flex-1 min-w-[12rem] text-sm border border-gray-300 rounded-md px-3 py-1.5"
            />
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {visible.length} of {items.length}
            </span>
          </div>
        )}

        {items.length > 0 && visible.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No invoices match this filter.</p>
          </div>
        )}

        {visible.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">Created</th>
                  <th className="text-left px-3 py-2">Invoice</th>
                  <th className="text-left px-3 py-2">Customer</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="text-right px-3 py-2">Balance</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((inv) => (
                  <tr key={inv.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDate(inv.createdAt)}</td>
                    <td className="px-3 py-2 text-xs font-mono whitespace-nowrap" title={`Invoice ID: ${inv.id}`}>
                      {/* S30 UX ask: the invoice # is a direct link to the invoice detail. */}
                      <Link href={`/admin/invoices/${inv.id}`} className="text-blue-600 hover:underline">
                        {inv.invoiceNumber != null ? `#${inv.invoiceNumber}` : inv.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      <div className="flex items-center gap-2">
                        {/* Customer-name link (mirrors /admin/quotes' idiom, #666):
                            same routing rule as src/lib/dashboard/customers.ts
                            customerRouteId — highlevel_contact_id, else customer_id.
                            A walk-in with neither stays plain text. */}
                        {(() => {
                          const routeId = inv.highlevelContactId ?? inv.customerId;
                          return routeId ? (
                            <Link href={`/customers/${encodeURIComponent(routeId)}`} className="text-blue-600 hover:underline">
                              {inv.customerName ?? '—'}
                            </Link>
                          ) : (
                            <span>{inv.customerName ?? '—'}</span>
                          );
                        })()}
                        {inv.isTest && (
                          <span
                            title="Simulated test invoice — excluded from dashboard metrics"
                            className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700"
                          >
                            Test
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">{money(inv.total)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-gray-900">{money(inv.balance)}</td>
                    <td className="px-3 py-2">
                      <InvoiceStatusBadge status={inv.status} />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Link href={`/admin/invoices/${inv.id}`} className="text-gray-700 hover:bg-gray-100 text-xs px-2 py-1 rounded mr-1">
                        Detail
                      </Link>
                      {inv.quoteId && (
                        <PipelineActionsMenu quoteId={inv.quoteId} onDone={refresh} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
