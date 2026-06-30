import { describe, it, expect } from 'vitest';
import { normalizeQuoteTouch, quoteFollowUpDecision } from './quotetool';
import { FOLLOWUP_REASONS } from './followups';
import type { DashboardQuote } from '@/lib/dashboard/types';

function quote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: 'q1',
    customer_name: 'Jane Doe',
    customer_email: 'jane@example.com',
    customer_phone: '(631) 555-1234',
    total: 1500,
    created_at: '2026-06-28T14:00:00Z',
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: 'g1',
    service_type: null,
    ...over,
  };
}

describe('normalizeQuoteTouch', () => {
  it('treats a not-yet-sent draft as an inbound (unresponded) lead, timed from created_at', () => {
    const t = normalizeQuoteTouch(quote());
    expect(t.source).toBe('quotetool');
    expect(t.externalId).toBe('q1');
    expect(t.direction).toBe('inbound');
    expect(t.channel).toBe('app');
    expect(t.lastMessageAt.toISOString()).toBe('2026-06-28T14:00:00.000Z');
    expect(t.identity.ghlContactId).toBe('g1');
    expect(t.identity.emails).toEqual(['jane@example.com']);
    expect(t.identity.phones).toEqual(['+16315551234']); // E.164 normalized
    expect(t.identity.displayName).toBe('Jane Doe');
  });

  it('treats a sent quote as outbound (we acted → auto-resolves downstream)', () => {
    const t = normalizeQuoteTouch(quote({ quote_sent_at: '2026-06-29T10:00:00Z' }));
    expect(t.direction).toBe('outbound');
    expect(t.lastMessageAt.toISOString()).toBe('2026-06-29T10:00:00.000Z');
  });

  it('treats an approved (won) quote as outbound even if never marked sent', () => {
    const t = normalizeQuoteTouch(quote({ quote_sent_at: null, customer_approved_at: '2026-06-30T00:00:00Z' }));
    expect(t.direction).toBe('outbound');
  });

  it('omits missing contact fields rather than emitting empties', () => {
    const t = normalizeQuoteTouch(quote({ customer_email: null, customer_phone: null, highlevel_contact_id: null }));
    expect(t.identity.emails).toEqual([]);
    expect(t.identity.phones).toEqual([]);
    expect(t.identity.ghlContactId).toBeNull();
  });
});

describe('normalizeQuoteTouch — leadKind + quoteValue', () => {
  it('stamps leadKind lead and the quote dollar value', () => {
    const touch = normalizeQuoteTouch(quote({ total: 2218.5 }));
    expect(touch.leadKind).toBe('lead');
    expect(touch.quoteValue).toBe(2218.5);
  });

  it('stamps quoteValue null when total is null', () => {
    const touch = normalizeQuoteTouch(quote({ total: null }));
    expect(touch.leadKind).toBe('lead');
    expect(touch.quoteValue).toBeNull();
  });
});

describe('quoteFollowUpDecision', () => {
  it('creates a quote_sent_no_reply follow-up for a sent, unapproved quote', () => {
    const d = quoteFollowUpDecision(quote({ quote_sent_at: '2026-06-29T10:00:00Z' }));
    expect(d.kind).toBe('create');
    if (d.kind === 'create') {
      expect(d.reason).toBe(FOLLOWUP_REASONS.quoteSentNoReply);
      expect(d.sentAt.toISOString()).toBe('2026-06-29T10:00:00.000Z');
    }
  });

  it('closes the follow-up once the quote is approved', () => {
    const d = quoteFollowUpDecision(quote({ quote_sent_at: '2026-06-29T10:00:00Z', customer_approved_at: '2026-07-01T00:00:00Z' }));
    expect(d.kind).toBe('close');
    if (d.kind === 'close') expect(d.reason).toBe(FOLLOWUP_REASONS.quoteSentNoReply);
  });

  it('does nothing for a draft that was never sent', () => {
    expect(quoteFollowUpDecision(quote()).kind).toBe('none');
  });
});
