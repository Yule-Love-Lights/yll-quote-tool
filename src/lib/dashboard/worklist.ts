import { DASHBOARD_CONFIG } from './config';
import { deriveStatus, type QuoteStatus } from '../quoteStatus';
import type { DashboardQuote, WorklistItem } from './types';

const MS_PER_DAY = 86_400_000;

// B7 fix (#110 W7-007): terminal / under-revision quotes must never nag in the
// worklist — a declined/cancelled/lost quote still carries quote_sent_at, so
// without this guard it renders as "sent … — no reply" forever, and a cancelled
// never-sent draft nags as draft-stale. Mirrors needsAction.ts / workflowBoard.ts
// (changes_requested included — it's not an unanswered-customer situation).
const TERMINAL_STATUSES: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  'declined',
  'cancelled',
  'lost',
  'changes_requested',
]);

function customerLabel(q: DashboardQuote): string {
  return q.customer_name?.trim() || 'Unknown customer';
}

export function computeWorklist(quotes: DashboardQuote[], now: Date): WorklistItem[] {
  const nowMs = now.getTime();
  const items: WorklistItem[] = [];

  for (const q of quotes) {
    // Terminal / under-revision quotes never nag (B7 class, #110 W7-007).
    if (TERMINAL_STATUSES.has(deriveStatus(q))) continue;

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
