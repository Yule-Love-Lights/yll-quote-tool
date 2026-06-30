import type { FollowedItem } from '@/lib/dashboard/inbox/store';
import { formatWaiting } from '@/lib/dashboard/inbox/notify';

const SOURCE_LABEL: Record<string, string> = {
  ghl: 'GHL',
  gmail: 'Gmail',
  quotetool: 'Quote',
  homeworks: 'Homeworks',
};

export function FollowedSection({ items, nowMs }: { items: FollowedItem[]; nowMs: number }) {
  if (items.length === 0) return null;

  return (
    <section
      className="mt-6 rounded-lg border p-4"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--op-text)' }}>
        Followed ({items.length})
      </h2>
      <p className="text-xs mb-3" style={{ color: 'var(--op-text-2)' }}>
        Snoozed — you&apos;ve followed up; they&apos;ll reappear here when the customer replies.
      </p>
      <ul className="space-y-2">
        {items.map((item) => {
          const agoMs = item.followedUpAt ? nowMs - new Date(item.followedUpAt).getTime() : null;
          const agoLabel = agoMs != null ? `followed ${formatWaiting(agoMs)} ago` : null;
          return (
            <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <span className="font-medium" style={{ color: 'var(--op-text)' }}>
                  {item.customerName ?? 'Unknown'}
                </span>
                <span className="ml-2 text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-2)' }}>
                  {SOURCE_LABEL[item.source] ?? item.source}
                  {item.channel ? ` · ${item.channel}` : ''}
                </span>
                {item.preview && (
                  <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--op-text-2)' }}>
                    {item.preview}
                  </p>
                )}
              </div>
              {agoLabel && (
                <span className="shrink-0 text-xs whitespace-nowrap" style={{ color: 'var(--op-text-2)' }}>
                  {agoLabel}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
