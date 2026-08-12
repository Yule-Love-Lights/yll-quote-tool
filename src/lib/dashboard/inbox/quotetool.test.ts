import { describe, it, expect } from 'vitest';
import { normalizeQuoteTouch, quoteFollowUpDecision } from './quotetool';
import { FOLLOWUP_REASONS } from './followups';
import type { DashboardQuote } from '@/lib/dashboard/types';

// #181: normalizeQuoteTouch is now nullable (an unsent legacy_rebook draft
// suppresses to null) — this asserts non-null for tests exercising the
// unaffected normal-quote paths, so their existing assertions stay unchanged.
function mustTouch(t: ReturnType<typeof normalizeQuoteTouch>) {
  if (!t) throw new Error('expected a touch, got null');
  return t;
}

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
    const t = mustTouch(normalizeQuoteTouch(quote()));
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
    const t = mustTouch(normalizeQuoteTouch(quote({ quote_sent_at: '2026-06-29T10:00:00Z' })));
    expect(t.direction).toBe('outbound');
    expect(t.lastMessageAt.toISOString()).toBe('2026-06-29T10:00:00.000Z');
  });

  it('treats an approved (won) quote as outbound even if never marked sent', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ quote_sent_at: null, customer_approved_at: '2026-06-30T00:00:00Z' })));
    expect(t.direction).toBe('outbound');
  });

  it('omits missing contact fields rather than emitting empties', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ customer_email: null, customer_phone: null, highlevel_contact_id: null })));
    expect(t.identity.emails).toEqual([]);
    expect(t.identity.phones).toEqual([]);
    expect(t.identity.ghlContactId).toBeNull();
  });
});

describe('normalizeQuoteTouch — leadKind + quoteValue', () => {
  it('stamps leadKind lead and the quote dollar value', () => {
    const touch = mustTouch(normalizeQuoteTouch(quote({ total: 2218.5 })));
    expect(touch.leadKind).toBe('lead');
    expect(touch.quoteValue).toBe(2218.5);
  });

  it('stamps quoteValue null when total is null', () => {
    const touch = mustTouch(normalizeQuoteTouch(quote({ total: null })));
    expect(touch.leadKind).toBe('lead');
    expect(touch.quoteValue).toBeNull();
  });
});

// These exercise the guard under EXCLUDE_LEGACY_REBOOK_FROM_INBOX = true (the
// current prod value, imported from store.ts). Mirrors store.test.ts's own
// #157 suite: that suite doesn't flip the flag to false either (it asserts
// the const's current value and tests the pure exclusion predicate directly
// instead) — the hardcoded-const coupling makes a true false-path test here
// no more straightforward than it is there.
describe('normalizeQuoteTouch — legacy_rebook (#181, YLL Neighbor inbox noise)', () => {
  it('suppresses an unsent legacy_rebook draft entirely (no inbox item)', () => {
    expect(normalizeQuoteTouch(quote({ legacy_rebook: true, quote_sent_at: null }))).toBeNull();
  });

  it('a SENT legacy_rebook quote behaves like any other sent quote (normal outbound item)', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ legacy_rebook: true, quote_sent_at: '2026-06-29T10:00:00Z' })));
    expect(t.direction).toBe('outbound');
    expect(quoteFollowUpDecision(quote({ legacy_rebook: true, quote_sent_at: '2026-06-29T10:00:00Z' })).kind).toBe('create');
  });

  it('an unsent NON-legacy draft is still a normal inbound lead (unchanged behavior)', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ legacy_rebook: false })));
    expect(t.direction).toBe('inbound');
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

// #220: internal recipients must never mint a quote_sent_no_reply
// follow-up. Positive-match only: explicit internal signals suppress;
// ordinary customer emails must keep creating as before.
describe('quoteFollowUpDecision — internal recipient suppression (#220)', () => {
  it('suppresses a sent, unapproved quote sent to the company mail subdomain (the live quote 1262 shape)', () => {
    const d = quoteFollowUpDecision(
      quote({
        quote_sent_at: '2026-06-29T10:00:00Z',
        customer_email: 'sales@mail.yulelovelights.com',
      }),
    );
    expect(d).toEqual({ kind: 'suppress', suppression: 'internal_email_domain' });
  });

  it('suppresses a sent, unapproved quote sent to the bare yulelovelights.com domain', () => {
    const d = quoteFollowUpDecision(
      quote({
        quote_sent_at: '2026-06-29T10:00:00Z',
        customer_email: 'someone@yulelovelights.com',
      }),
    );
    expect(d).toEqual({ kind: 'suppress', suppression: 'internal_email_domain' });
  });

  it('still creates for a normal customer recipient (the regression guard that matters)', () => {
    const d = quoteFollowUpDecision(
      quote({
        quote_sent_at: '2026-06-29T10:00:00Z',
        customer_email: 'yelena.nossa@gmail.com',
      }),
    );
    expect(d.kind).toBe('create');
    if (d.kind === 'create') expect(d.reason).toBe(FOLLOWUP_REASONS.quoteSentNoReply);
  });

  // #252: the shared isInternalDomain match must stay '.'-bounded — a
  // lookalike domain must not falsely suppress a real customer's follow-up.
  it('still creates for a lookalike domain that merely starts with ours (notyulelovelights.com)', () => {
    const d = quoteFollowUpDecision(
      quote({
        quote_sent_at: '2026-06-29T10:00:00Z',
        customer_email: 'someone@notyulelovelights.com',
      }),
    );
    expect(d.kind).toBe('create');
  });

  it('still creates when customer_email is null (missing email is not internal)', () => {
    const d = quoteFollowUpDecision(
      quote({
        quote_sent_at: '2026-06-29T10:00:00Z',
        customer_email: null,
      }),
    );
    expect(d.kind).toBe('create');
  });
});

// #183 BUG 2: a quote in a terminal/dead state must close its "sent, no
// reply" follow-up, not just re-create it forever. The live case: a DECLINED
// quote (christina piacquadio) whose follow-up kept resurrecting daily
// because only customer_approved_at closed it, and WT-43's ensureFollowUp
// upsert flips a 'done' row back to 'pending' every reconcile.
describe('quoteFollowUpDecision — dead-quote close (#183 BUG 2)', () => {
  it('closes a DECLINED sent-but-unapproved quote (the christina scenario: done -> would have re-armed, now stays closed)', () => {
    const d = quoteFollowUpDecision(quote({ quote_sent_at: '2026-06-29T10:00:00Z', status: 'declined' }));
    expect(d.kind).toBe('close');
    if (d.kind === 'close') expect(d.reason).toBe(FOLLOWUP_REASONS.quoteSentNoReply);
  });

  it('closes a CANCELLED quote', () => {
    const d = quoteFollowUpDecision(quote({ quote_sent_at: '2026-06-29T10:00:00Z', status: 'cancelled' }));
    expect(d.kind).toBe('close');
  });

  it('closes a LOST quote', () => {
    const d = quoteFollowUpDecision(quote({ quote_sent_at: '2026-06-29T10:00:00Z', status: 'lost' }));
    expect(d.kind).toBe('close');
  });

  it('does NOT close a changes_requested quote — it is being revised, not dead, so the nudge stays live', () => {
    const d = quoteFollowUpDecision(quote({ quote_sent_at: '2026-06-29T10:00:00Z', status: 'changes_requested' }));
    expect(d.kind).toBe('create');
  });

  it('a declined quote that was never sent still resolves to close (harmless no-op downstream — closeFollowUp matches zero rows when none exists)', () => {
    const d = quoteFollowUpDecision(quote({ status: 'declined' }));
    expect(d.kind).toBe('close');
  });

  it('still creates for a normal sent+open quote with no persisted status (unchanged)', () => {
    const d = quoteFollowUpDecision(quote({ quote_sent_at: '2026-06-29T10:00:00Z' }));
    expect(d.kind).toBe('create');
  });
});
