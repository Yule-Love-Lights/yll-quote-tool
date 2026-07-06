import type { CustomerStatus } from '@/lib/dashboard/types';

// BUG-1 (S22): widened from the old draft|sent|approved triple to the FULL
// canonical QuoteStatus set, so a terminal/branch quote (declined / cancelled /
// lost / changes_requested) and the mid-lifecycle states (viewed / booked) badge
// correctly here instead of falling back to a stale 'sent'/'approved'. Colours
// mirror the admin quotes list palette (red = declined, gray = cancelled/lost,
// orange = changes, purple = viewed, deep green = booked).
const STATUS_STYLE: Record<CustomerStatus, { label: string; bg: string; fg: string }> = {
  draft: { label: 'Draft', bg: 'var(--brand-gold)', fg: 'var(--brand-evergreen)' },
  sent: { label: 'Sent', bg: 'var(--brand-evergreen)', fg: 'var(--brand-cream)' },
  viewed: { label: 'Viewed', bg: '#6b46c1', fg: 'var(--brand-cream)' },
  approved: { label: 'Approved', bg: '#1f7a4d', fg: 'var(--brand-cream)' },
  booked: { label: 'Booked', bg: '#047857', fg: 'var(--brand-cream)' },
  changes_requested: { label: 'Changes', bg: '#c2410c', fg: 'var(--brand-cream)' },
  declined: { label: 'Declined', bg: '#b91c1c', fg: 'var(--brand-cream)' },
  cancelled: { label: 'Cancelled', bg: '#6b7280', fg: 'var(--brand-cream)' },
  lost: { label: 'Lost', bg: '#6b7280', fg: 'var(--brand-cream)' },
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
