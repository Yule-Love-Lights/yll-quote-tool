'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { JobStatusBadge } from '@/components/admin/JobStatusBadge';
import { InvoiceStatusBadge } from '@/components/admin/InvoiceStatusBadge';
import { NceBadge } from '@/components/admin/NceBadge';
import { StaffNotesPanel } from '@/components/admin/StaffNotesPanel';
import { reconcileInvoice } from '@/lib/invoices';
import { isSupersededPendingAmendment, resolveAmendmentBasis } from '@/lib/amend';
import type { JobDetail } from '@/lib/jobs';
import { JobsListSkeleton } from '../JobsListSkeleton';

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

// Fix round 3 (Finding LOW, PR #926): pure extraction of the cancel action
// message, mirroring ColorRequestPanel.tsx's applyOutcomeFromResponse — this
// repo's pattern for testing a fetch-response-driven string without
// jsdom/testing-library. Widened to cue on `stockNeedsAttention` (a
// stock-reversal caveat — most importantly the PENDING_STOCK_SNAPSHOT refusal
// note) in addition to `refundNeeded`, mirroring PipelineActionsMenu.tsx's
// cancelAlertMessage.
export function cancelActionMessage(body: {
  alreadyCancelled?: boolean;
  refundNeeded?: boolean;
  stockNeedsAttention?: boolean;
  note?: string;
}): string {
  if (body.alreadyCancelled) return 'Already cancelled.';
  const cue = body.refundNeeded || body.stockNeedsAttention ? '⚠️ ' : '';
  return `${cue}Order cancelled.${body.note ? ` ${body.note}` : ''}`;
}

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
      // Row 313(b) fix: display_delta/display_new_balance are the SAME
      // resolveAmendmentBasis figures the customer notice/portal/trail show
      // (amend/route.ts) — not the raw d.delta/d.new_balance, which on a
      // tax-overridden invoice disagree with what the customer is actually
      // billed.
      setAmendMsg(
        `Amended: ${d.display_delta >= 0 ? '+' : '−'}${money(Math.abs(d.display_delta))} → new balance ${money(d.display_new_balance)}.` +
          (body.requiresReconsent
            ? ' Customer must re-approve the new total before the balance is charged.'
            : '') +
          (d.overpayment ? ' Overpayment — refund manually in Valor.' : '') +
          notifyNote +
          // Row 341 fix round 3 (MED finding): the route computes and returns
          // this flag specifically so a lost invoice re-sync (a losing CAS
          // race, twice) doesn't read as a clean success — before this, no
          // caller ever read it, so the warning it exists to surface never
          // reached anyone. A durable marker also lands on the quote
          // (quoteAmendInvoiceSync.ts's flagInvoiceResyncFailed) for the case
          // nobody sees this response, but THIS is the synchronous one.
          (body.invoiceResyncFailed
            ? ' ⚠️ The linked invoice could not be re-synced — reconcile it manually before charging the balance.'
            : ''),
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
      // #110 W7-001 / fix round 3 (Finding LOW, PR #926): surface the route's
      // refund + stock-reversal notes on every cancel, with a ⚠️ cue — see
      // cancelActionMessage's doc comment above.
      setActionMsg(cancelActionMessage(body));
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

        {/* This detail route has no loading.tsx of its own — it inherits
            ../loading.tsx (the list shape) during a route transition, so
            reusing that SAME shared skeleton here (row 332, mirrors #171b)
            avoids adding a second, mismatched morph on top of the one that
            already exists between the inherited list skeleton and this
            page's own detail content. */}
        {loading && <JobsListSkeleton />}
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
              {/* NCE (#199) — the barter/trade network tag. */}
              {data.isNce && <NceBadge />}
            </div>
            <p className="text-sm text-gray-500 mb-6">
              {data.job.type === 'permanent'
                ? 'Permanent / Glow365'
                : data.quoteServiceType === 'permanent_bistro'
                  ? 'Bistro'
                  : 'Seasonal'}{' '}
              · created{' '}
              {fmtDate(data.job.created_at)}
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

            {data.job.quote_id && <StaffNotesPanel key={data.job.quote_id} quoteId={data.job.quote_id} />}

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
                    {/* S30 wrap review: the balance-collection UI (charge saved card /
                        pay-link / mark-paid-cash) lives on the invoice detail — link
                        there instead of dead-ending staff at a read-only summary. */}
                    <Link
                      href={`/admin/invoices/${data.invoice.id}`}
                      className="text-blue-600 font-medium hover:underline"
                    >
                      {data.invoice.invoice_number != null ? `Invoice #${data.invoice.invoice_number}` : 'Invoice'}
                    </Link>
                    <InvoiceStatusBadge status={data.invoice.status} />
                    <Link
                      href={`/admin/invoices/${data.invoice.id}`}
                      className="ml-auto text-xs text-blue-600 hover:underline"
                    >
                      Collect / manage →
                    </Link>
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
                  {(() => {
                    // #177 fix 4: pass the quote's INTENDED deposit (its own
                    // deposit percent) so short-deposit compares against that,
                    // not a blanket 40%-of-total assumption.
                    const recon = reconcileInvoice(data.invoice, data.intendedDepositUsd);
                    const flagLabels: Record<string, string> = {
                      'overpaid': 'Overpaid — issue a refund in Valor',
                      'short-deposit': 'Deposit below the intended amount — verify with customer',
                      'balance-outstanding': 'Balance outstanding',
                      'inconsistent': 'Data error: invoice marked paid but balance > 0 — contact support',
                    };
                    return recon.flags.length > 0 ? (
                      <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
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
                      <p className="mt-2 text-xs text-gray-400">
                        {money(recon.quoted)} quoted · {money(recon.depositApplied)} deposit received · {money(recon.balanceDue)} balance due
                        {recon.paid ? ' · paid' : ''}
                      </p>
                    );
                  })()}
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

            {/* Ledger #83 follow-up (a real live incident — a customer had no way to
                decline a price change and had to phone in): this page could RECORD an
                amendment but never showed whether an earlier one was still awaiting the
                customer's answer or was declined. Compact history, same consent-status
                badges as /admin/quotes/[id]'s fuller trail. */}
            {data.amendments.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-lg p-4 mt-4">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  Amendment history ({data.amendments.length})
                </h2>
                <ol className="space-y-2 text-sm">
                  {data.amendments.map((a, i) => {
                    // Cosmetic (zero-delta) entries never carry `consent` — mirrors
                    // /admin/quotes/[id]'s badge logic (requiresReconsent gates it).
                    const requiresConsent = Math.abs(a.delta) >= 0.005;
                    const rawStatus = requiresConsent ? (a.consent?.status ?? 'pending') : null;
                    // FIX6 (review MED): relabel a still-'pending' entry that's
                    // been superseded by a later amendment (no route will ever
                    // resolve it — see isSupersededPendingAmendment's doc
                    // comment in lib/amend.ts) so it doesn't read as still
                    // actionable. Real live incident: this order has +342.56
                    // (pending, never resolved) then -342.56 (accepted).
                    const isSuperseded = isSupersededPendingAmendment(a, data.amendments);
                    const status = isSuperseded ? 'superseded' : rawStatus;
                    const badge =
                      status === 'declined'
                        ? { label: 'Declined', cls: 'bg-red-100 text-red-700' }
                        : status === 'accepted'
                          ? { label: 'Approved', cls: 'bg-emerald-100 text-emerald-700' }
                          : status === 'superseded'
                            ? { label: 'Superseded — see latest', cls: 'bg-gray-100 text-gray-500' }
                            : status === 'pending'
                              ? { label: 'Awaiting customer', cls: 'bg-amber-100 text-amber-700' }
                              : null;
                    // Row 313(b) fix: read the SAME resolveAmendmentBasis figure
                    // the portal card / customer notice / /admin/quotes/[id]'s
                    // fuller trail already use — invoice_basis when the amend
                    // route stamped one, else the raw trail — instead of the
                    // raw a.delta/a.new_balance, which disagree with the Linked
                    // invoice card's own invoice.balance on a tax-overridden
                    // invoice (amend.ts's resolveAmendmentBasis doc comment).
                    const { deltaUsd, newBalanceUsd } = resolveAmendmentBasis(a);
                    return (
                      <li key={i} className="border-t border-gray-100 pt-2 first:border-0 first:pt-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-gray-800">{a.reason}</p>
                          {badge && (
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
                              {badge.label}
                            </span>
                          )}
                        </div>
                        <p className="text-gray-500 text-xs">
                          {fmtDate(a.amended_at)} · {deltaUsd >= 0 ? '+' : '−'}{money(Math.abs(deltaUsd))} → balance {money(newBalanceUsd)}
                        </p>
                        {a.consent?.status === 'declined' && (
                          <p className="mt-1 text-xs text-red-700">
                            Customer declined{a.consent.reason ? `: "${a.consent.reason}"` : ' (no reason given)'}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

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
                applied; the balance recomputes. A price change puts a re-approval card on the customer&apos;s
                portal; the order itself stays booked. Until they sign it, collecting the balance is blocked
                for a price INCREASE only (a decrease never blocks, and the invoice page can override).
              </p>
              {/* Jason 2026-08-19: this reason is NOT an internal note — the portal's
                  AmendmentConsentCard renders it verbatim to the customer while the
                  re-consent is pending (src/components/portal/snowglobe/AmendmentConsentCard.tsx).
                  Operators had no way to know that from this screen. Sits ABOVE the
                  field, not below it: a review lens pointed out that a warning under
                  the box is read only after the note has already been typed. */}
              <p className="text-xs text-amber-700 mb-1">
                ⚠️ The customer sees this reason on their portal — write it for them, not as an internal
                note. Line breaks are not preserved.
              </p>
              <textarea
                value={amendReason}
                onChange={(e) => setAmendReason(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="Reason the customer will see (e.g. added a 36&quot; wreath)"
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
