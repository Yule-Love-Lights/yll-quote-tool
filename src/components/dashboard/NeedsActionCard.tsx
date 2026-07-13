// Needs-Action work queue card — shows the operator a sorted list of items
// that need action today (nudges, deposit collection, balance collection).
// Mirrors the visual style of the existing Worklist / WorklistRow components.

import Link from 'next/link';
import type { NeedsActionItem, NeedsActionKind } from '@/lib/dashboard/needsAction';
import { SERVICE_TYPE_LABELS } from '@/lib/serviceType';

const KIND_LABEL: Record<NeedsActionKind, string> = {
  'nudge': 'Follow up',
  'collect-deposit': 'Deposit',
  'collect-balance': 'Balance',
};

// Each bucket gets a distinct accent so the operator can scan by color.
const KIND_STYLE: Record<NeedsActionKind, { background: string; color: string }> = {
  'nudge': { background: 'var(--op-warning, #b45309)', color: 'var(--brand-cream, #fdf8ef)' },
  'collect-deposit': { background: 'var(--brand-gold, #d4a017)', color: 'var(--brand-evergreen, #1a3c2b)' },
  'collect-balance': { background: 'var(--op-danger, #b91c1c)', color: 'var(--brand-cream, #fdf8ef)' },
};

// WT-40: a customer with several concurrent quotes produced identical-looking
// rows (label = customer name only). Prefix the detail with the quote # +
// service line so each row is distinguishable at a glance.
function rowMeta(item: NeedsActionItem): string {
  return [
    item.quoteNumber != null ? `#${item.quoteNumber}` : null,
    item.serviceType ? SERVICE_TYPE_LABELS[item.serviceType] : null,
  ].filter(Boolean).join(' · ');
}

function NeedsActionRow({ item }: { item: NeedsActionItem }) {
  const badge = KIND_STYLE[item.kind];
  const meta = rowMeta(item);
  return (
    <Link
      href={item.href}
      className="flex items-center gap-4 px-4 py-3 border-t transition-colors hover:opacity-90"
      style={{ borderColor: 'var(--op-border)' }}
    >
      <span
        className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded whitespace-nowrap"
        style={{ background: badge.background, color: badge.color }}
      >
        {KIND_LABEL[item.kind]}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate" style={{ color: 'var(--op-text)' }}>
          {item.label}
        </div>
        <div className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
          {meta && <span className="tabular-nums">{meta} — </span>}
          {item.detail}
        </div>
      </div>
      <span aria-hidden style={{ color: 'var(--op-text-dim)' }}>→</span>
    </Link>
  );
}

export function NeedsActionCard({ items }: { items: NeedsActionItem[] }) {
  return (
    <section aria-label="Overdue / follow-up" className="mb-8">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        Overdue / follow-up
      </h2>
      <div
        className="rounded-lg border overflow-hidden"
        style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
      >
        {items.length === 0 ? (
          <div className="p-6 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>
            All caught up — nothing needs action right now.
          </div>
        ) : (
          items.map((item) => (
            <NeedsActionRow key={`${item.kind}:${item.quoteId}`} item={item} />
          ))
        )}
      </div>
    </section>
  );
}
