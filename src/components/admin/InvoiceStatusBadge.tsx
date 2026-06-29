import type { InvoiceStatus } from '@/lib/invoiceStatus';

// Display labels + badge styles for invoice status (ledger #83). Shared by the
// /admin/invoices list + detail and the job detail so the three never drift.
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

const STYLES: Record<InvoiceStatus, string> = {
  draft: 'bg-amber-100 text-amber-700',
  awaiting_payment: 'bg-orange-100 text-orange-700',
  paid: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-gray-200 text-gray-600',
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${STYLES[status]}`}
    >
      {INVOICE_STATUS_LABELS[status]}
    </span>
  );
}
