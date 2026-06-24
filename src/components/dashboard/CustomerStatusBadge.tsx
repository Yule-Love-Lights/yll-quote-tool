import type { CustomerStatus } from '@/lib/dashboard/types';

const STATUS_STYLE: Record<CustomerStatus, { label: string; bg: string; fg: string }> = {
  draft: { label: 'Draft', bg: 'var(--brand-gold)', fg: 'var(--brand-evergreen)' },
  sent: { label: 'Sent', bg: 'var(--brand-evergreen)', fg: 'var(--brand-cream)' },
  approved: { label: 'Approved', bg: '#1f7a4d', fg: 'var(--brand-cream)' },
};

/** Pill showing a quote's lifecycle status, shared by the customers list +
 *  detail history (#58 Phase 3). */
export function CustomerStatusBadge({ status }: { status: CustomerStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}
