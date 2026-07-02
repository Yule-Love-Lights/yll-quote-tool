'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { InvoiceStatusBadge } from '@/components/admin/InvoiceStatusBadge';
import { reconcileInvoice } from '@/lib/invoices';
import type { InvoiceDetail } from '@/lib/invoices';

// Operator BILLING detail for one invoice (ledger #83): the money breakdown
// (total, deposit applied → balance), status, the linked job, and the customer.
// Collecting the balance (the "Charge remaining balance" button) is gated on the
// confirmed Valor card-on-file capability — see VALOR-AUTOCHARGE-FOR-JASON.md.

const money = (n: number | null | undefined) =>
  n == null
    ? '—'
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [data, setData] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/invoices/${id}`);
      if (res.status === 401) {
        window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed');
      setData(body as InvoiceDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const toggleTax = async () => {
    const invoice = data?.invoice;
    if (!invoice) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/invoices/${invoice.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taxOverridden: !invoice.tax_overridden }),
      });
      if (res.status === 401) {
        window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tax');
    } finally {
      setBusy(false);
    }
  };

  const copyPayLink = () => {
    const invoice = data?.invoice;
    if (!invoice?.quote_id) return;
    const url = `${window.location.origin}/portal/${invoice.quote_id}/pay-balance`;
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(url)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {});
    }
  };

  const inv = data?.invoice;

  return (
    <OperatorShell active="quotes">
      <div className="max-w-3xl mx-auto">
        <BillingSubNav active="invoices" />
        <div className="mb-4">
          <Link href="/admin/invoices" className="text-sm text-gray-500 hover:text-gray-700">
            ← All invoices
          </Link>
        </div>

        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">{error}</div>
        )}

        {data && inv && (
          <>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-gray-900">
                {inv.invoice_number != null ? `Invoice #${inv.invoice_number}` : `Invoice ${inv.id.slice(0, 8)}`}
              </h1>
              <InvoiceStatusBadge status={inv.status} />
              {data.isTest && (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
                  Test
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500 mb-6">
              Created {fmtDate(inv.created_at)}
              {inv.paid_at ? ` · paid ${fmtDate(inv.paid_at)}` : ''}
            </p>

            <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Customer</h2>
              <p className="text-gray-800 font-medium">{data.customerName ?? '—'}</p>
              {data.customerAddress && <p className="text-sm text-gray-500">{data.customerAddress}</p>}
              <p className="text-sm text-gray-500">
                {[data.customerPhone, data.customerEmail].filter(Boolean).join(' · ') || '—'}
              </p>
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {inv.job_id && (
                  <Link href={`/admin/jobs/${inv.job_id}`} className="text-blue-700 hover:underline">
                    {data.jobNumber != null ? `Job #${data.jobNumber}` : 'Linked job'}
                    {data.jobStatus ? ` (${data.jobStatus.replace('_', ' ')})` : ''} →
                  </Link>
                )}
                {inv.quote_id && (
                  <Link href={`/quote/${inv.quote_id}`} className="text-blue-700 hover:underline">
                    Open quote →
                  </Link>
                )}
                {inv.valor_receipt_url && (
                  <a
                    href={inv.valor_receipt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-700 hover:underline"
                  >
                    Receipt ↗
                  </a>
                )}
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Balance</h2>
              <dl className="text-sm text-gray-600 space-y-1">
                <div className="flex justify-between">
                  <dt>Subtotal</dt>
                  <dd>{money(inv.subtotal)}</dd>
                </div>
                {inv.discount > 0 && (
                  <div className="flex justify-between">
                    <dt>Discount</dt>
                    <dd>−{money(inv.discount)}</dd>
                  </div>
                )}
                {(() => {
                  // B4 fix: rush-install + premium-takedown fees are included in
                  // the total but were previously invisible in the breakdown, causing
                  // Subtotal − Discount + Tax ≠ Total. Derive the fees from the
                  // stored fields (no DB column needed — total is the source of truth).
                  const fees = Math.round((inv.total - (inv.subtotal - inv.discount + inv.tax)) * 100) / 100;
                  return fees > 0 ? (
                    <div className="flex justify-between">
                      <dt>Rush / takedown fees</dt>
                      <dd>{money(fees)}</dd>
                    </div>
                  ) : null;
                })()}
                <div className="flex justify-between">
                  <dt>Tax{inv.tax_overridden ? ' (overridden)' : ''}</dt>
                  <dd>{money(inv.tax)}</dd>
                </div>
                <div className="flex justify-between border-t border-gray-100 pt-1 font-medium text-gray-800">
                  <dt>Total</dt>
                  <dd>{money(inv.total)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Deposit applied</dt>
                  <dd>−{money(inv.deposit_applied)}</dd>
                </div>
                <div className="flex justify-between border-t border-gray-200 pt-1 text-base font-semibold text-gray-900">
                  <dt>Balance due</dt>
                  <dd>{money(inv.balance)}</dd>
                </div>
                {inv.credit_note > 0 && (
                  <div className="flex justify-between text-amber-700">
                    <dt>Overpaid (manual refund in Valor)</dt>
                    <dd>{money(inv.credit_note)}</dd>
                  </div>
                )}
              </dl>

              {(() => {
                const recon = reconcileInvoice(inv);
                const flagLabels: Record<string, string> = {
                  'overpaid': 'Overpaid — issue a refund in Valor',
                  'short-deposit': 'Deposit below 40% of total — verify with customer',
                  'balance-outstanding': 'Balance outstanding',
                  'inconsistent': 'Data error: invoice marked paid but balance > 0 — contact support',
                };
                return recon.flags.length > 0 ? (
                  <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-red-700 mb-1">
                      Reconciliation issues
                    </p>
                    <ul className="text-sm text-red-700 space-y-0.5 list-disc list-inside">
                      {recon.flags.map((f) => (
                        <li key={f}>{flagLabels[f] ?? f}</li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-xs text-red-600">
                      {money(recon.quoted)} quoted · {money(recon.depositApplied)} deposit received · {money(recon.balanceDue)} balance due
                      {recon.creditNote > 0 ? ` · ${money(recon.creditNote)} credit` : ''}
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-gray-400">
                    {money(recon.quoted)} quoted · {money(recon.depositApplied)} deposit received · {money(recon.balanceDue)} balance due
                    {recon.paid ? ' · paid' : ''}
                  </p>
                );
              })()}

              <div className="mt-3">
                <button
                  type="button"
                  onClick={toggleTax}
                  disabled={busy || inv.status === 'cancelled' || inv.status === 'paid'}
                  className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-60"
                >
                  {inv.tax_overridden ? 'Restore tax' : 'Mark tax-exempt (override)'}
                </button>
              </div>

              {inv.quote_id && inv.balance > 0 && inv.status !== 'paid' && inv.status !== 'cancelled' && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={copyPayLink}
                    className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50"
                  >
                    {copied ? 'Link copied ✓' : 'Copy customer pay-link'}
                  </button>
                  <p className="text-xs text-gray-400 mt-1">
                    Send this to the customer to pay their remaining balance online.
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </OperatorShell>
  );
}
