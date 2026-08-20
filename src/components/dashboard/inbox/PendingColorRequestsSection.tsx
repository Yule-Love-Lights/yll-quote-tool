import Link from 'next/link';
import type { PendingColorRequestItem } from '@/lib/dashboard/inbox/types';

// Row 321: server-seeded, no client interactivity — this list is read
// straight off `quotes.approval_snapshot.pendingColorRequest` (store.ts's
// listPendingColorRequests), independent of any inbox_items row, so marking
// the inbox item Handled/Mark completed/dismissed can never make a request
// vanish from here. Staff act on it from the linked quote admin page
// (ColorRequestPanel) — this section is read-only by design, unlike
// FollowUpStrip/InWorksSection which mutate inbox_items directly.
function daysWaiting(requestedAt: string | null, nowMs: number): number | null {
  if (!requestedAt) return null;
  const ms = nowMs - new Date(requestedAt).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : null;
}

export function PendingColorRequestsSection({
  items,
  nowMs,
}: {
  items: PendingColorRequestItem[];
  nowMs: number;
}) {
  if (items.length === 0) return null;

  return (
    <section
      className="mb-5 rounded-lg border p-4"
      style={{ borderColor: '#f59e0b', background: '#fffbeb' }}
    >
      <h2 className="text-sm font-semibold mb-1" style={{ color: '#92400e' }}>
        Pending colour requests ({items.length})
      </h2>
      <p className="text-xs mb-3" style={{ color: '#92400e' }}>
        Read straight off the quote — this can&apos;t be hidden by marking an inbox row Handled,
        completed, or dismissed. Apply or dismiss each from the quote&apos;s admin page.
      </p>
      <ul className="space-y-2">
        {items.map((item) => {
          const age = daysWaiting(item.requestedAt, nowMs);
          return (
            <li key={item.quoteId} className="flex items-center justify-between gap-3 text-sm">
              <span style={{ color: '#78350f' }}>
                <strong>{item.customerName ?? 'Unknown'}</strong>
                {item.quoteNumber != null && <span> · #{item.quoteNumber}</span>}
                <span> — wants {item.label}</span>
                {age != null && <span> · {age === 0 ? 'today' : `${age}d ago`}</span>}
              </span>
              <Link
                href={`/admin/quotes/${item.quoteId}`}
                className="px-3 py-1 rounded-md text-sm shrink-0 font-medium"
                style={{ background: '#b45309', color: 'white' }}
              >
                Review →
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
