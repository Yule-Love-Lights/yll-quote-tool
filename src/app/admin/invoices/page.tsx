'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { InvoiceStatusBadge, INVOICE_STATUS_LABELS } from '@/components/admin/InvoiceStatusBadge';
import { NceBadge } from '@/components/admin/NceBadge';
import { ServiceTypeBadge } from '@/components/admin/ServiceTypeBadge';
import type { InvoiceAdminCard } from '@/lib/invoices';
import { INVOICE_STATUSES, type InvoiceStatus } from '@/lib/invoiceStatus';
import { isStaleInvoiceSnapshot } from '@/lib/quoteAmendInvoiceSync';
import { PipelineActionsMenu } from '@/components/admin/PipelineActionsMenu';
import { InvoicesListSkeleton } from './InvoicesListSkeleton';

// Operator BILLING list of invoices (ledger #83). An invoice is auto-created when
// a job is marked complete (full total, deposit applied → balance). Test invoices
// (#93) are VISIBLE here, badged.

function InvoicesAdminPageContent() {
  // Row 396 (MED): the dashboard workflow board's ⚠ badge (isStaleInvoiceSnapshot,
  // row 389) used to link here unfiltered — a bucket reading "3 unreconciled"
  // gave the owner no way to find WHICH three. WorkflowBoard.tsx now appends
  // ?stale=1 to its href when a bucket has a stale count; this page reads it
  // and filters to just those rows (isStaleInvoiceSnapshot, same derivation
  // the board itself uses — see quoteApprovalSnapshot's own comment in
  // invoices.ts for why the check isn't precomputed server-side).
  const searchParams = useSearchParams();
  const staleOnly = searchParams.get('stale') === '1';
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
  // Same derivation the per-row ⚠ and the workflow board use.
  const staleCount = items.filter((inv) => isStaleInvoiceSnapshot(inv.quoteApprovalSnapshot)).length;
  const visible = items.filter((inv) => {
    if (statusFilter !== 'All' && inv.status !== statusFilter) return false;
    if (staleOnly && !isStaleInvoiceSnapshot(inv.quoteApprovalSnapshot)) return false;
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

        {/* Same rich skeleton the route's loading.tsx shows (row 332, mirrors
            #171b) — was a bare "Loading…" line, which made the route-transition
            skeleton morph into something sparser before morphing again into the
            real table once the client-side GET /api/invoices fetch resolved. */}
        {loading && <InvoicesListSkeleton />}

        {!loading && items.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500">No invoices yet — one appears here when a job is marked complete.</p>
          </div>
        )}

        {staleOnly && (
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 font-medium text-amber-800">
              ⚠ Unreconciled only
            </span>
            <Link href="/admin/invoices" className="text-gray-500 hover:underline">
              Clear filter
            </Link>
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
              {/* Ops hub workstream A, stale-invoice discoverability: rows
                  396/414 built the whole chain (board link with ?stale=1, the
                  per-row ⚠ in the Status cell below, detail markers, Mark
                  reconciled) but the ONLY door into the filter was the
                  workflow board's bucket link. This chip is the on-page door.
                  Its count covers THIS page's list, which includes test
                  invoices (shown here badged by design), while the board's
                  bucket count excludes them — so the two numbers can differ
                  by exactly the stale TEST invoices (admin-lens MED on this
                  PR; measured 0 stale invoices of any kind in prod at review
                  time). The chip's number always equals the rows its click
                  reveals, which is the consistency this page owes the reader.
                  URL param stays the single source of truth (deep links and
                  the banner keep working). */}
              {(staleCount > 0 || staleOnly) && (
                <Link
                  href={staleOnly ? '/admin/invoices' : '/admin/invoices?stale=1'}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
                    staleOnly
                      ? 'bg-amber-600 text-white border-amber-600'
                      : 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
                  }`}
                >
                  ⚠ Unreconciled ({staleCount})
                </Link>
              )}
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
                  {/* Row 419: service line, consistent across the admin lists. */}
                  <th className="text-left px-3 py-2">Service</th>
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
                    {/* Row 419: em dash when the invoice has no linked quote —
                        nothing else carries the service line. */}
                    <td className="px-3 py-2">
                      {inv.serviceType != null ? <ServiceTypeBadge serviceType={inv.serviceType} /> : <span className="text-gray-400">—</span>}
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
                            <Link href={`/customers/${encodeURIComponent(routeId)}`} className="font-medium hover:underline" style={{ color: 'var(--op-primary)' }}>
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
                        {/* NCE (#199) — the barter/trade network tag. */}
                        {inv.isNce && <NceBadge />}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">{money(inv.total)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-gray-900">{money(inv.balance)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <InvoiceStatusBadge status={inv.status} />
                        {isStaleInvoiceSnapshot(inv.quoteApprovalSnapshot) && (
                          // Staff-lens finding (row 396 delta-verify): the old copy said
                          // "See the amend panel on the linked order" — a promised remedy
                          // that doesn't always exist. /amend 409s "no-change" when there's
                          // no real price delta, so an invoiceResyncFailed marker with
                          // nothing left to re-price can't be cleared there at all.
                          // Row 414 built that clearing path: the detail page's
                          // Mark reconciled override. Say what the ⚠ MEANS and
                          // where the remedy lives.
                          <span
                            title="Unreconciled — this invoice may not match the agreed total. Verify against the linked order before collecting the balance. Once verified, clear it with Mark reconciled on the invoice detail page (row 414)."
                            aria-label="Unreconciled invoice"
                            className="text-amber-600"
                          >
                            ⚠
                          </span>
                        )}
                      </div>
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

// useSearchParams() (staleOnly, above) requires a Suspense boundary around
// its consumer — same pattern as src/app/login/page.tsx's LoginForm.
export default function InvoicesAdminPage() {
  return (
    <Suspense fallback={null}>
      <InvoicesAdminPageContent />
    </Suspense>
  );
}
