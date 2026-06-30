import { describe, it, expect } from 'vitest';
import { buildInboxSummary } from './summary';
import type { OpenInboxItem } from './types';

const base: OpenInboxItem = {
  id: 'x', source: 'ghl', channel: null, direction: null, lastMessageAt: null, preview: null,
  subject: null, escalationLevel: 0, leadKind: 'lead', quoteValue: null, isReturning: false,
  contactId: null, assignedTo: null, contact: null,
};
const at = (msAgo: number, now: number) => new Date(now - msAgo).toISOString();

describe('buildInboxSummary', () => {
  it('counts leads/filtered, oldest wait, overdue, quote $ and per-channel', () => {
    const now = 1_000_000_000_000;
    const items: OpenInboxItem[] = [
      { ...base, id: 'a', source: 'quotetool', leadKind: 'lead', quoteValue: 2218.5, lastMessageAt: at(5 * 3_600_000, now) },
      { ...base, id: 'b', source: 'ghl', leadKind: 'lead', lastMessageAt: at(2 * 3_600_000, now) },
      { ...base, id: 'c', source: 'gmail', leadKind: 'automated', lastMessageAt: at(9 * 3_600_000, now) },
    ];
    const s = buildInboxSummary(items, now);
    expect(s.openLeads).toBe(2);
    expect(s.filtered).toBe(1);
    expect(s.overdue).toBe(1); // only 'a' (5h) is a lead past 4h; 'c' is automated → excluded
    expect(s.oldestWaitingMs).toBe(5 * 3_600_000); // oldest LEAD, not the automated 9h
    expect(s.quotesWaitingUsd).toBe(2218.5);
    expect(s.byChannel).toEqual({ ghl: 1, gmail: 0, quotetool: 1, homeworks: 0 });
  });
});
