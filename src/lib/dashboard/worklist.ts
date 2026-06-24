import { DASHBOARD_CONFIG } from './config';
import type { DashboardQuote, WorklistItem } from './types';

const MS_PER_DAY = 86_400_000;

function customerLabel(q: DashboardQuote): string {
  return q.customer_name?.trim() || 'Unknown customer';
}

export function computeWorklist(quotes: DashboardQuote[], now: Date): WorklistItem[] {
  const nowMs = now.getTime();
  const items: WorklistItem[] = [];

  for (const q of quotes) {
    // A won (approved) quote is never a worklist item — skip it before the
    // draft/sent branches so an offline-closed deal that never had
    // quote_sent_at stamped isn't nagged as a stale "never sent" draft.
    if (q.customer_approved_at) continue;

    if (!q.quote_sent_at) {
      // Draft: never sent. Age = days since created.
      const ageDays = (nowMs - new Date(q.created_at).getTime()) / MS_PER_DAY;
      if (ageDays >= DASHBOARD_CONFIG.draftStaleDays) {
        items.push({
          kind: 'draft-stale',
          quoteId: q.id,
          title: customerLabel(q),
          subtitle: `Drafted ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? '' : 's'} ago — never sent`,
          ageDays,
          href: `/quote/${q.id}`,
        });
      }
      continue;
    }

    // Sent but no reply (approved quotes already skipped above).
    const ageDays = (nowMs - new Date(q.quote_sent_at).getTime()) / MS_PER_DAY;
    if (ageDays >= DASHBOARD_CONFIG.sentNoReplyStaleDays) {
      items.push({
        kind: 'sent-no-reply',
        quoteId: q.id,
        title: customerLabel(q),
        subtitle: `Sent ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? '' : 's'} ago — no reply`,
        ageDays,
        href: `/portal/${q.id}`,
      });
    }
  }

  // Oldest first (most overdue at top).
  items.sort((a, b) => b.ageDays - a.ageDays);
  return items.slice(0, DASHBOARD_CONFIG.worklistMaxRows);
}
