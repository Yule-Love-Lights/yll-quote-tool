// Pure at-a-glance numbers for the /inbox summary strip (#58). Derived entirely
// from the already-fetched open-item list, so the strip tracks the client poll
// with no extra server round-trip. "Filtered" = automated noise; everything else
// here is computed over LEADS only (the work that actually needs a reply).

import type { OpenInboxItem, InboxSource } from './types';
import { INBOX_SOURCES } from './types';
import { ESCALATION } from './escalation';

export type InboxSummary = {
  openLeads: number;
  filtered: number;
  overdue: number;
  oldestWaitingMs: number;
  quotesWaitingUsd: number;
  byChannel: Record<InboxSource, number>;
};

export function buildInboxSummary(items: OpenInboxItem[], nowMs: number): InboxSummary {
  const leads = items.filter((i) => i.leadKind !== 'automated');
  const byChannel = Object.fromEntries(INBOX_SOURCES.map((s) => [s, 0])) as Record<InboxSource, number>;
  let oldestWaitingMs = 0;
  let overdue = 0;
  let quoteCents = 0;
  for (const i of leads) {
    byChannel[i.source] += 1;
    if (i.quoteValue) quoteCents += Math.round(i.quoteValue * 100);
    if (i.lastMessageAt) {
      const wait = nowMs - new Date(i.lastMessageAt).getTime();
      if (wait > oldestWaitingMs) oldestWaitingMs = wait;
      if (wait >= ESCALATION.redAfterMs) overdue += 1;
    }
  }
  return {
    openLeads: leads.length,
    filtered: items.length - leads.length,
    overdue,
    oldestWaitingMs,
    quotesWaitingUsd: quoteCents / 100,
    byChannel,
  };
}
