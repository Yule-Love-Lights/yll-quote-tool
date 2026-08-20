import { describe, it, expect } from 'vitest';
import { isAutoCompleteTerminalQuote, normalizeQuoteTouch, quoteFollowUpDecision } from './quotetool';
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
    // #252 slice G: the default fixture represents a not-yet-sent draft (the
    // describe block above's own name for it) — the legacy_rebook guard below
    // reads `status`, so it needs a real value here rather than undefined.
    // #266: normalizeQuoteTouch now also reads status for every quote (a dead
    // one is answered whatever its timestamps say), so 'draft' here is what
    // keeps the existing inbound-lead assertions meaning what they say.
    status: 'draft',
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

// #267(a): a quote booked OFFLINE via the deposit webhook alone — money
// moved — with neither customer_approved_at nor quote_sent_at ever stamped
// was previously falling through both `answered` OR-terms and rendering as
// an unanswered inbound lead. 0 prod rows carry this shape today (verified);
// this pins the structural fix rather than an active incident.
describe('normalizeQuoteTouch — deposit_paid_at (#267a)', () => {
  it('treats a deposit-paid quote as outbound even with neither customer_approved_at nor quote_sent_at ever stamped', () => {
    const t = mustTouch(
      normalizeQuoteTouch(
        quote({ quote_sent_at: null, customer_approved_at: null, deposit_paid_at: '2026-07-20T00:00:00Z' }),
      ),
    );
    expect(t.direction).toBe('outbound');
  });
});

describe('normalizeQuoteTouch — dead statuses (#266)', () => {
  // The live shape this closes: a quote declined BEFORE it was ever sent keeps
  // quote_sent_at NULL, so the timestamps alone read it as an untouched draft.
  // Two real prod rows sat in the queue as urgent unanswered leads on exactly
  // this shape (Karen L. Adams #1125, Thomas Humel #1180, both escalation 2).
  it('treats a quote declined before it was ever sent as outbound, not an unanswered lead', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ status: 'declined', quote_sent_at: null, customer_approved_at: null })));
    expect(t.direction).toBe('outbound');
  });

  it('treats a cancelled quote as outbound even with no lifecycle timestamps', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ status: 'cancelled' })));
    expect(t.direction).toBe('outbound');
  });

  // #235's staff-abandon allows abandoning a never-sent draft; without this the
  // brand-new one-click archive would fail on precisely its intended case — the
  // quote would keep re-rendering as an open lead every reconcile.
  it('treats an abandoned never-sent draft as outbound, so #235 Mark-Abandoned sticks', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ status: 'abandoned' })));
    expect(t.direction).toBe('outbound');
  });

  // changes_requested is NOT dead — that quote is being revised and is still
  // owed a response, so it must keep reading as an inbound lead.
  //
  // The fixture state (changes_requested with quote_sent_at NULL) is not
  // reachable in prod — canTransition only allows changes_requested from
  // sent/viewed, both of which have already stamped quote_sent_at. That is
  // deliberate: it isolates the STATUS check from the timestamp check, so this
  // pins the exclusion itself rather than passing on the timestamp OR-clause.
  it('leaves a changes_requested quote inbound (being revised, not closed)', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ status: 'changes_requested' })));
    expect(t.direction).toBe('inbound');
  });

  // Order matters: the legacy_rebook suppression is positive-matched on
  // status==='draft', so a DECLINED Neighbor quote is not a parked draft — it
  // must produce an outbound touch that heals the stuck row, never a null that
  // would leave it open forever.
  it('emits an outbound touch (not null) for a declined, unsent legacy_rebook quote', () => {
    const t = normalizeQuoteTouch(quote({ legacy_rebook: true, status: 'declined', quote_sent_at: null }));
    expect(t).not.toBeNull();
    expect(t!.direction).toBe('outbound');
  });

  // Both consumers read the same shared isDeadQuote(), so they cannot drift.
  // quote_sent_at stays NULL on purpose: with it set, the touch half of this
  // assertion would pass on the timestamp alone and prove nothing about the
  // status check (the pre-#266 implementation would satisfy it too).
  it('reads the status through one shared predicate, so the two consumers cannot drift', () => {
    const q = quote({ status: 'declined', quote_sent_at: null, customer_approved_at: null });
    expect(mustTouch(normalizeQuoteTouch(q)).direction).toBe('outbound');
    expect(quoteFollowUpDecision(q).kind).toBe('close');
  });
});

// #317: the terminal-quote auto-complete allowlist. booked/declined/abandoned
// (only) → true; every other status, including the sibling 'cancelled' Jason
// deliberately left out, → false.
describe('isAutoCompleteTerminalQuote (#317)', () => {
  it('is true for a booked quote (deposit paid)', () => {
    expect(
      isAutoCompleteTerminalQuote(
        quote({ status: 'booked', deposit_paid_at: '2026-08-01T00:00:00Z', customer_approved_at: '2026-07-30T00:00:00Z' }),
      ),
    ).toBe(true);
  });
  it('is true for a declined quote', () => {
    expect(isAutoCompleteTerminalQuote(quote({ status: 'declined' }))).toBe(true);
  });
  it('is true for an abandoned quote', () => {
    expect(isAutoCompleteTerminalQuote(quote({ status: 'abandoned' }))).toBe(true);
  });

  it('is false for a cancelled quote — Jason named booked/declined/abandoned only, twice; cancelled fails safe', () => {
    expect(isAutoCompleteTerminalQuote(quote({ status: 'cancelled' }))).toBe(false);
  });
  it('is false for an untouched draft', () => {
    expect(isAutoCompleteTerminalQuote(quote())).toBe(false);
  });
  it('is false for a sent-but-unanswered quote', () => {
    expect(isAutoCompleteTerminalQuote(quote({ status: 'sent', quote_sent_at: '2026-08-01T00:00:00Z' }))).toBe(false);
  });
  it('is false for a viewed quote', () => {
    expect(
      isAutoCompleteTerminalQuote(
        quote({ status: 'viewed', quote_sent_at: '2026-08-01T00:00:00Z', viewed_at: '2026-08-02T00:00:00Z' }),
      ),
    ).toBe(false);
  });
  it('is false for an approved-but-not-booked quote', () => {
    expect(isAutoCompleteTerminalQuote(quote({ status: 'approved', customer_approved_at: '2026-08-01T00:00:00Z' }))).toBe(
      false,
    );
  });
  it('is false for changes_requested — still being revised, not closed', () => {
    expect(isAutoCompleteTerminalQuote(quote({ status: 'changes_requested' }))).toBe(false);
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
describe('normalizeQuoteTouch — legacy_rebook (#181/#252, YLL Neighbor inbox noise)', () => {
  it('suppresses an unsent, still-DRAFT legacy_rebook quote entirely (no inbox item)', () => {
    expect(normalizeQuoteTouch(quote({ legacy_rebook: true, status: 'draft', quote_sent_at: null }))).toBeNull();
  });

  it('a SENT legacy_rebook quote behaves like any other sent quote (normal outbound item)', () => {
    const t = mustTouch(
      normalizeQuoteTouch(quote({ legacy_rebook: true, status: 'sent', quote_sent_at: '2026-06-29T10:00:00Z' })),
    );
    expect(t.direction).toBe('outbound');
    expect(
      quoteFollowUpDecision(quote({ legacy_rebook: true, status: 'sent', quote_sent_at: '2026-06-29T10:00:00Z' })).kind,
    ).toBe('create');
  });

  // #252 slice G refinement: 3 prod rows are `status='booked'` with
  // `quote_sent_at IS NULL` — a booked quote is never a parked draft however it
  // got there, so `!quote_sent_at` alone (the old, blanket condition) is NOT a
  // safe proxy for "still a draft nobody sent". This is the case a naive
  // "unsent = suppress" implementation would get wrong. #263: deposit_paid_at
  // is what actually backs a booked row now that the shared predicate derives
  // off deriveStatus rather than the raw status column (every real prod row
  // with status='booked' also carries deposit_paid_at, verified 2026-08-13).
  it('does NOT suppress a BOOKED legacy_rebook quote even though quote_sent_at is null', () => {
    const t = mustTouch(
      normalizeQuoteTouch(
        quote({
          legacy_rebook: true,
          status: 'booked',
          quote_sent_at: null,
          customer_approved_at: '2026-07-15T00:00:00Z',
          deposit_paid_at: '2026-07-16T00:00:00Z',
        }),
      ),
    );
    expect(t).not.toBeNull();
  });

  it('an unsent NON-legacy draft is still a normal inbound lead (unchanged behavior)', () => {
    const t = mustTouch(normalizeQuoteTouch(quote({ legacy_rebook: false })));
    expect(t.direction).toBe('inbound');
  });

  // #267(b): a legacy_rebook row that's actually been PAID must never be
  // suppressed to invisible, even if its persisted status column never
  // advanced off 'draft' — the shared predicate derives off deriveStatus, so
  // deposit_paid_at wins over the stale status string and this row falls
  // through the suppression guard to the normal mapping (outbound, since
  // `answered` also reads deposit_paid_at per #267a). 0 prod rows have this
  // shape today; structural fix, not an active incident.
  it('emits an outbound touch (not null) for a PAID legacy_rebook quote whose persisted status is still draft (#267b)', () => {
    const t = normalizeQuoteTouch(
      quote({
        legacy_rebook: true,
        status: 'draft',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: '2026-08-01T00:00:00Z',
      }),
    );
    expect(t).not.toBeNull();
    expect(t!.direction).toBe('outbound');
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

  it('closes an ABANDONED quote', () => {
    const d = quoteFollowUpDecision(quote({ quote_sent_at: '2026-06-29T10:00:00Z', status: 'abandoned' }));
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
