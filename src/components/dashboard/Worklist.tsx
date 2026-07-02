import type { WorklistItem } from '@/lib/dashboard/types';
import { WorklistRow } from './WorklistRow';

export function Worklist({ items }: { items: WorklistItem[] }) {
  return (
    <section aria-label="Drafts & unsent" className="mb-8">
      <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--op-text)' }}>
        Drafts &amp; unsent
      </h2>
      <div
        className="rounded-lg border overflow-hidden"
        style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
      >
        {items.length === 0 ? (
          <div className="p-6 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>
            Inbox zero. Nothing aging out right now.
          </div>
        ) : (
          items.map(item => <WorklistRow key={`${item.kind}:${item.quoteId}`} item={item} />)
        )}
      </div>
    </section>
  );
}
