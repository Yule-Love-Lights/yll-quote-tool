'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { JobStatusBadge } from '@/components/admin/JobStatusBadge';
import { InvoiceStatusBadge } from '@/components/admin/InvoiceStatusBadge';
import { BalanceChargeButton } from '@/components/admin/BalanceChargeButton';
import type { JobDetail } from '@/lib/jobs';

// Operator BILLING detail for one job (ledger #83): customer, the booking-time
// line-item snapshot, and the invoice. "Mark installed & create invoice" runs the
// complete flow (advance the job → auto-create the invoice). Collecting the
// balance (the "Charge remaining balance" button) is gated on the confirmed Valor
// card-on-file capability — see docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md.

const money = (n: number | null | undefined) =>
  n == null
    ? '—'
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [data, setData] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [amendReason, setAmendReason] = useState('');
  const [amendBusy, setAmendBusy] = useState(false);
  const [amendMsg, setAmendMsg] = useState<string | null>(null);
  const [amendNotify, setAmendNotify] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (res.status === 401) {
        window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed');
      setData(body as JobDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const markComplete = async () => {
    if (!id) return;
    if (!window.confirm('Mark this job installed and create its invoice?')) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/jobs/${id}/complete`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed');
      setActionMsg(
        body.settled
          ? 'Invoice created and settled — the deposit covered the full total.'
          : 'Invoice created — a balance is due.',
      );
      await load();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const recordAmendment = async () => {
    const quoteId = data?.job.quote_id;
    if (!quoteId) return;
    const reason = amendReason.trim();
    if (!reason) {
      setAmendMsg('Enter a reason for the amendment.');
      return;
    }
    if (!window.confirm('Record this amendment to the booked order?')) return;
    setAmendBusy(true);
    setAmendMsg(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/amend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, notifyCustomer: amendNotify }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed');
      const d = body.amendment;
      const notifyNote = amendNotify
        ? body.notified
          ? ' Customer notified.'
          : body.notifyError === 'test-quote'
            ? ' (Test quote — no message sent.)'
            : ' (Customer notice not sent — check messaging setup.)'
        : '';
      setAmendMsg(
        `Amended: ${d.delta >= 0 ? '+' : '−'}${money(Math.abs(d.delta))} → new balance ${money(d.new_balance)}.` +
          (body.requiresReconsent
            ? ' Customer must re-approve the new total before the balance is charged.'
            : '') +
          (d.overpayment ? ' Overpayment — refund manually in Valor.' : '') +
          notifyNote,
      );
      setAmendReason('');
      await load();
    } catch (err) {
      setAmendMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setAmendBusy(false);
    }
  };

  const cancelOrder = async () => {
    if (!id) return;
    if (
      !window.confirm(
        'Cancel this booked order? The job, its invoice, and the quote are marked cancelled. Any refund is handled manually in Valor.',
      )
    )
      return;
    setCancelBusy(true);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed');
      setActionMsg(
        body.alreadyCancelled
          ? 'Already cancelled.'
          : 'Order cancelled.' +
              (body.refundedInvoice ? ' A paid invoice was cancelled — refund manually in Valor.' : ''),
      );
      await load();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : 'Failed');
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <OperatorShell active="quotes">
      <div className="max-w-3xl mx-auto">
        <BillingSubNav active="jobs" />
        <div className="mb-4">
          <Link href="/admin/jobs" className="text-sm text-gray-500 hover:text-gray-700">
            ← All jobs
          </Link>
        </div>

        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">{error}</div>
        )}

        {data && (
          <>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-gray-900">
                {data.job.job_number != null ? `Job #${data.job.job_number}` : `Job ${data.job.id.slice(0, 8)}`}
              </h1>
              <JobStatusBadge status={data.job.status} />
              {data.isTest && (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
                  Test
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500 mb-6">
              {data.job.type === 'permanent' ? 'Permanent / Glow365' : 'Seasonal'} · created{' '}
              {fmtDate(data.job.created_at)}
              {data.job.install_date ? ` · install ${fmtDate(data.job.install_date)}` : ''}
            </p>

            <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Customer</h2>
              <p className="text-gray-800 font-medium">{data.customerName ?? '—'}</p>
              {data.customerAddress && <p className="text-sm text-gray-500">{data.customerAddress}</p>}
              <p className="text-sm text-gray-500">
                {[data.customerPhone, data.customerEmail].filter(Boolean).join(' · ') || '—'}
              </p>
              {data.job.quote_id && (
                <div className="mt-2 flex gap-3 text-sm">
                  <Link href={`/quote/${data.job.quote_id}`} className="text-blue-700 hover:underline">
                    Open quote →
                  </Link>
                  <Link
                    href={`/portal/${data.job.quote_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-700 hover:underline"
                  >
                    Portal ↗
                  </Link>
                </div>
              )}
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                Line items (snapshot at booking)
              </h2>
              {(data.job.line_items?.length ?? 0) === 0 ? (
                <p className="text-sm text-gray-500">No line items recorded.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {data.job.line_items!.map((li, i) => (
                      <tr key={i} className="border-t border-gray-100 first:border-0">
                        <td className="py-1.5 text-gray-700">{li.label}</td>
                        <td className="py-1.5 text-right text-gray-700 whitespace-nowrap">{money(li.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                Invoice &amp; balance
              </h2>
              {data.invoice ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-gray-800 font-medium">
                      {data.invoice.invoice_number != null ? `Invoice #${data.invoice.invoice_number}` : 'Invoice'}
                    </span>
                    <InvoiceStatusBadge status={data.invoice.status} />
                  </div>
                  <dl className="text-sm text-gray-600 space-y-0.5">
                    <div className="flex justify-between">
                      <dt>Total</dt>
                      <dd>{money(data.invoice.total)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Deposit applied</dt>
                      <dd>−{money(data.invoice.deposit_applied)}</dd>
                    </div>
                    <div className="flex justify-between font-semibold text-gray-900">
                      <dt>Balance due</dt>
                      <dd>{money(data.invoice.balance)}</dd>
                    </div>
                    {data.invoice.credit_note > 0 && (
                      <div className="flex justify-between text-amber-700">
                        <dt>Overpaid (manual refund)</dt>
                        <dd>{money(data.invoice.credit_note)}</dd>
                      </div>
                    )}
                  </dl>
                  <BalanceChargeButton balance={data.invoice.balance} status={data.invoice.status} />
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-500 mb-3">
                    Not yet invoiced. Marking the job complete creates the invoice (full total, deposit applied →
                    balance due).
                  </p>
                  <button
                    type="button"
                    onClick={markComplete}
                    disabled={busy}
                    className="rounded-md px-3 py-1.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {busy ? 'Working…' : 'Mark installed & create invoice'}
                  </button>
                </>
              )}
              {actionMsg && <p className="text-sm text-gray-600 mt-2">{actionMsg}</p>}
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4 mt-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Amend order</h2>
              <p className="text-sm text-gray-500 mb-2">
                To change a booked order, first{' '}
                {data.job.quote_id ? (
                  <Link href={`/quote/${data.job.quote_id}`} className="text-blue-700 hover:underline">
                    edit it in the builder
                  </Link>
                ) : (
                  'edit it in the builder'
                )}{' '}
                and Calculate to re-price, then record the amendment here. The deposit already paid stays
                applied; the balance recomputes. A price change sends it back for the customer to re-approve.
              </p>
              <textarea
                value={amendReason}
                onChange={(e) => setAmendReason(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="Reason for the amendment (e.g. added an extra wreath)"
                className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 mb-2"
              />
              <label className="flex items-center gap-2 text-sm text-gray-600 mb-2">
                <input
                  type="checkbox"
                  checked={amendNotify}
                  onChange={(e) => setAmendNotify(e.target.checked)}
                />
                Notify the customer of this change (text + email)
              </label>
              <button
                type="button"
                onClick={recordAmendment}
                disabled={amendBusy}
                className="rounded-md px-3 py-1.5 text-sm font-semibold text-white bg-gray-800 hover:bg-gray-900 disabled:opacity-60"
              >
                {amendBusy ? 'Recording…' : 'Record amendment'}
              </button>
              {amendMsg && <p className="text-sm text-gray-600 mt-2">{amendMsg}</p>}
            </div>

            {data.job.status !== 'done' && data.job.status !== 'cancelled' && (
              <div className="border border-red-200 rounded-lg p-4 mt-4">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-red-600 mb-2">Cancel order</h2>
                <p className="text-sm text-gray-500 mb-2">
                  Marks the job, its invoice, and the quote cancelled. Any refund (deposit/balance) is handled
                  manually in Valor.
                </p>
                <button
                  type="button"
                  onClick={cancelOrder}
                  disabled={cancelBusy}
                  className="rounded-md px-3 py-1.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-60"
                >
                  {cancelBusy ? 'Cancelling…' : 'Cancel order'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </OperatorShell>
  );
}
