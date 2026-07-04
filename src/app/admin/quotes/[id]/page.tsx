import { notFound } from 'next/navigation';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { JobStatusBadge } from '@/components/admin/JobStatusBadge';
import { InvoiceStatusBadge } from '@/components/admin/InvoiceStatusBadge';
import { getQuoteRaw } from '@/lib/quotes';
import { deriveStatus, type QuoteStatus } from '@/lib/quoteStatus';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';
import { getDesignByQuote } from '@/lib/designs';
import { permanentBomFromQuote } from '@/lib/permanent/bomFromQuote';
import { PermanentBomPanel } from '@/components/permanent/PermanentBomPanel';

// Read-only operator detail for a single quote (PR1 of #83 ops console).
// No action buttons here — those land in PR2's PipelineActionsMenu.

const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  approved: 'Approved',
  booked: 'Booked',
  changes_requested: 'Changes requested',
  declined: 'Declined',
  cancelled: 'Cancelled',
  lost: 'Lost',
};

const STATUS_STYLES: Record<QuoteStatus, string> = {
  booked: 'bg-emerald-100 text-emerald-700',
  approved: 'bg-green-100 text-green-700',
  viewed: 'bg-purple-100 text-purple-700',
  sent: 'bg-blue-100 text-blue-700',
  draft: 'bg-amber-100 text-amber-700',
  changes_requested: 'bg-orange-100 text-orange-700',
  declined: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
  lost: 'bg-gray-200 text-gray-600',
};

const money = (n: number | null | undefined) =>
  n == null
    ? '—'
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const quote = await getQuoteRaw(id);
  if (!quote) notFound();

  const status = deriveStatus(quote);

  const job = await getJobByQuote(id);
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  // #13 PR5: small photo thumbnails (base + extras) so staff can see at a
  // glance which angles a quote's design covers. Best-effort — a design
  // lookup failure never blocks the detail page.
  const design = await getDesignByQuote(id).catch(() => null);
  const photoThumbs = design
    ? [
        { key: 'base', url: design.photoUrl, title: design.photoTitle || 'Photo 1' },
        ...design.extraPhotos
          .filter((p) => p.url)
          .map((p, i) => ({ key: p.id, url: p.url, title: p.title || `Photo ${i + 2}` })),
      ].filter((p) => p.url)
    : [];

  const amendments = quote.approval_snapshot?.amendments ?? [];

  // Permanent Lighting (#88 P7): the operator BOM (Ascend/Dauer APL material list
  // + wholesale cost) for ordering. Null for non-permanent quotes. Materials never
  // touch the customer price — this is ordering + margin only.
  const bom = quote.service_type === 'permanent' ? permanentBomFromQuote(quote.inputs) : null;

  return (
    <OperatorShell active="quotes">
      <div className="max-w-3xl mx-auto">
        <BillingSubNav active="quotes" />
        <div className="mb-4">
          <Link href="/admin/quotes" className="text-sm text-gray-500 hover:text-gray-700">
            ← All quotes
          </Link>
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 mb-1 flex-wrap">
          <h1 className="text-2xl font-bold text-gray-900">
            {quote.quote_number != null ? `Quote #${quote.quote_number}` : `Quote ${id.slice(0, 8)}`}
          </h1>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[status]}`}>
            {STATUS_LABELS[status]}
          </span>
          {quote.is_test && (
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
              Test
            </span>
          )}
          <Link
            href={`/portal/${id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-sm text-blue-700 hover:underline"
          >
            Portal ↗
          </Link>
        </div>

        {/* Customer */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 mt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Customer</h2>
          <p className="text-gray-800 font-medium">{quote.customer_name ?? '—'}</p>
          {quote.customer_address && <p className="text-sm text-gray-500">{quote.customer_address}</p>}
          <p className="text-sm text-gray-500">
            {[quote.customer_phone, quote.customer_email].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>

        {/* Design photos (#13 PR5) — read-only thumbnails, base + extras. */}
        {photoThumbs.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Design photos ({photoThumbs.length})
            </h2>
            <div className="flex gap-2 flex-wrap">
              {photoThumbs.map((p) => (
                <figure key={p.key} className="m-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url!} alt={p.title} className="w-24 h-16 object-cover rounded border border-gray-200" />
                  <figcaption className="text-[10px] text-gray-500 mt-0.5 max-w-24 truncate">{p.title}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}

        {/* Timeline */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Lifecycle</h2>
          <dl className="text-sm text-gray-600 space-y-0.5">
            <div className="flex justify-between">
              <dt>Sent</dt>
              <dd className="text-gray-800">{fmtDate(quote.quote_sent_at)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>First viewed</dt>
              <dd className="text-gray-800">{fmtDate(quote.viewed_at)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Approved</dt>
              <dd className="text-gray-800">{fmtDate(quote.customer_approved_at)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Deposit paid / booked</dt>
              <dd className="text-gray-800">{fmtDate(quote.deposit_paid_at)}</dd>
            </div>
          </dl>
        </div>

        {/* Line items */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Line items</h2>
          {!quote.result?.lineItems?.length ? (
            <p className="text-sm text-gray-500">No line items — quote not yet calculated.</p>
          ) : (
            <>
              <table className="w-full text-sm mb-2">
                <tbody>
                  {quote.result.lineItems.map((li, i) => (
                    <tr key={i} className="border-t border-gray-100 first:border-0">
                      <td className="py-1.5 text-gray-700">{li.label}</td>
                      <td className="py-1.5 text-right text-gray-700 whitespace-nowrap">{money(li.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="text-sm text-gray-600 space-y-0.5 border-t border-gray-200 pt-2">
                {quote.result.discountAmount > 0 && (
                  <div className="flex justify-between">
                    <dt>Discount</dt>
                    <dd>−{money(quote.result.discountAmount)}</dd>
                  </div>
                )}
                {quote.result.taxAmount > 0 && (
                  <div className="flex justify-between">
                    <dt>Tax</dt>
                    <dd>{money(quote.result.taxAmount)}</dd>
                  </div>
                )}
                <div className="flex justify-between font-semibold text-gray-900">
                  <dt>Total</dt>
                  <dd>{money(quote.total ?? quote.result.total)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Deposit</dt>
                  <dd>{money(quote.result.depositAmount)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Balance due</dt>
                  <dd>{money(quote.result.balanceDue)}</dd>
                </div>
              </dl>
            </>
          )}
        </div>

        {/* Permanent BOM (#88 P7) — operator ordering material list + wholesale cost. */}
        {bom && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Materials — BOM (ordering)
              </h2>
              <Link
                href={`/admin/quotes/${id}/bom/print`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-700 hover:underline"
              >
                Print order sheet ↗
              </Link>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Ascend/Dauer APL list — ordering + margin only. Materials never affect the customer price.
            </p>
            <PermanentBomPanel bom={bom} />
          </div>
        )}

        {/* Linked job */}
        {job && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Linked job</h2>
            <div className="flex items-center gap-2">
              <Link href={`/admin/jobs/${job.id}`} className="text-blue-700 hover:underline text-sm font-medium">
                {job.job_number != null ? `Job #${job.job_number}` : `Job ${job.id.slice(0, 8)}`} →
              </Link>
              <JobStatusBadge status={job.status} />
            </div>
          </div>
        )}

        {/* Linked invoice */}
        {invoice && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Linked invoice</h2>
            <div className="flex items-center gap-2 mb-2">
              <Link href={`/admin/invoices/${invoice.id}`} className="text-blue-700 hover:underline text-sm font-medium">
                {invoice.invoice_number != null ? `Invoice #${invoice.invoice_number}` : `Invoice ${invoice.id.slice(0, 8)}`} →
              </Link>
              <InvoiceStatusBadge status={invoice.status} />
            </div>
            <dl className="text-sm text-gray-600 space-y-0.5">
              <div className="flex justify-between">
                <dt>Total</dt>
                <dd>{money(invoice.total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Deposit applied</dt>
                <dd>−{money(invoice.deposit_applied)}</dd>
              </div>
              <div className="flex justify-between font-semibold text-gray-900">
                <dt>Balance due</dt>
                <dd>{money(invoice.balance)}</dd>
              </div>
              {invoice.paid_at && (
                <div className="flex justify-between">
                  <dt>Paid at</dt>
                  <dd>{fmtDate(invoice.paid_at)}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* Amendment trail */}
        {amendments.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Amendments ({amendments.length})
            </h2>
            <ol className="space-y-3 text-sm">
              {amendments.map((a, i) => (
                <li key={i} className="border-t border-gray-100 pt-2 first:border-0 first:pt-0">
                  <p className="text-gray-800 font-medium">{a.reason}</p>
                  <p className="text-gray-500 text-xs">
                    {fmtDate(a.amended_at)} · by {a.by} ·{' '}
                    {a.delta >= 0 ? '+' : '−'}{money(Math.abs(a.delta))} → new total{' '}
                    {money(a.new_total)} · balance {money(a.new_balance)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
