import Link from 'next/link';
import type { WorklistItem } from '@/lib/dashboard/types';
import { SERVICE_TYPE_LABELS } from '@/lib/serviceType';

const KIND_LABEL: Record<WorklistItem['kind'], string> = {
  'draft-stale': 'Draft',
  'sent-no-reply': 'No reply',
};

// WT-40: a customer with several concurrent quotes produced identical-looking
// rows (title = customer name only). Prefix the subtitle with the quote # +
// service line so each row is distinguishable at a glance.
function rowMeta(item: WorklistItem): string {
  return [
    item.quoteNumber != null ? `#${item.quoteNumber}` : null,
    item.serviceType ? SERVICE_TYPE_LABELS[item.serviceType] : null,
  ].filter(Boolean).join(' · ');
}

export function WorklistRow({ item }: { item: WorklistItem }) {
  const meta = rowMeta(item);
  return (
    <Link
      href={item.href}
      className="flex items-center gap-4 px-4 py-3 border-t transition-colors hover:opacity-90"
      style={{ borderColor: 'var(--op-border)' }}
    >
      <span
        className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded"
        style={{
          background: item.kind === 'sent-no-reply' ? 'var(--op-danger)' : 'var(--brand-gold)',
          color: item.kind === 'sent-no-reply' ? 'var(--brand-cream)' : 'var(--brand-evergreen)',
        }}
      >
        {KIND_LABEL[item.kind]}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate" style={{ color: 'var(--op-text)' }}>{item.title}</div>
        <div className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
          {meta && <span className="tabular-nums">{meta} — </span>}
          {item.subtitle}
        </div>
      </div>
      <span aria-hidden style={{ color: 'var(--op-text-dim)' }}>→</span>
    </Link>
  );
}
