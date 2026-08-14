import { describe, it, expect } from 'vitest';
import {
  gmailNeedsReply,
  normalizeGmailThread,
  parseEmailAddress,
  gmailMessageFromMe,
  mapGmailThread,
} from './gmail';
import type { GmailThreadLite, RawGmailThread } from './gmail';

const msg = (fromMe: boolean, iso: string, snippet?: string) => ({ fromMe, at: new Date(iso), snippet });

function thread(over: Partial<GmailThreadLite> = {}): GmailThreadLite {
  return {
    threadId: 'thr-1',
    subject: 'Holiday lights quote',
    from: { email: 'Cust@Example.com', name: 'A Customer' },
    messages: [msg(false, '2026-06-28T14:00:00Z', 'Can I get a quote?')],
    hasListUnsubscribe: false,
    ...over,
  };
}

describe('gmailNeedsReply — last message not from us', () => {
  it('is true when the customer sent the last message', () => {
    expect(gmailNeedsReply(thread().messages)).toBe(true);
  });
  it('is false when we replied after the customer (SENT after inbound)', () => {
    const messages = [msg(false, '2026-06-28T14:00:00Z'), msg(true, '2026-06-28T15:00:00Z', 'Sure!')];
    expect(gmailNeedsReply(messages)).toBe(false);
  });
});

describe('normalizeGmailThread — thread → NormalizedTouch', () => {
  it('marks an unanswered thread inbound with the customer identity', () => {
    const t = normalizeGmailThread(thread());
    expect(t.source).toBe('gmail');
    expect(t.externalId).toBe('thr-1');
    expect(t.direction).toBe('inbound');
    expect(t.channel).toBe('email');
    expect(t.subject).toBe('Holiday lights quote');
    expect(t.preview).toBe('Can I get a quote?');
    expect(t.lastMessageAt.toISOString()).toBe('2026-06-28T14:00:00.000Z');
    expect(t.identity.emails).toEqual(['cust@example.com']); // normalized
    expect(t.identity.displayName).toBe('A Customer');
  });

  it('marks a replied thread outbound (drives auto-resolve) using the latest message', () => {
    const t = normalizeGmailThread(
      thread({
        messages: [
          msg(false, '2026-06-28T14:00:00Z', 'Can I get a quote?'),
          msg(true, '2026-06-28T15:30:00Z', 'Absolutely — here it is'),
        ],
      }),
    );
    expect(t.direction).toBe('outbound');
    expect(t.preview).toBe('Absolutely — here it is');
    expect(t.lastMessageAt.toISOString()).toBe('2026-06-28T15:30:00.000Z');
  });
});

describe('parseEmailAddress', () => {
  it('extracts + lowercases the address from a "Name <addr>" header', () => {
    expect(parseEmailAddress('Jane Doe <Jane@Example.com>')).toBe('jane@example.com');
  });
  it('handles a bare address', () => {
    expect(parseEmailAddress('jane@example.com')).toBe('jane@example.com');
  });
  it('returns null when there is no address', () => {
    expect(parseEmailAddress('no address here')).toBeNull();
  });
});

const OUR = 'sales@yulelovelights.com';
function gm(over: Partial<{ labelIds: string[]; internalDate: string; snippet: string; from: string; subject: string }> = {}) {
  return {
    id: `m-${over.internalDate ?? '1'}`,
    labelIds: over.labelIds,
    internalDate: over.internalDate ?? '1782693272654',
    snippet: over.snippet,
    payload: {
      headers: [
        { name: 'From', value: over.from ?? 'A Customer <cust@example.com>' },
        { name: 'Subject', value: over.subject ?? 'Holiday lights' },
      ],
    },
  };
}

describe('gmailMessageFromMe', () => {
  it('is true for a SENT-labelled message', () => {
    expect(gmailMessageFromMe(gm({ labelIds: ['SENT'], from: 'cust@example.com' }), { ourEmail: OUR })).toBe(true);
  });
  it('is true when the From address is our mailbox (e.g. an escalation email in sales@)', () => {
    expect(gmailMessageFromMe(gm({ from: 'Yule Love Lights <sales@yulelovelights.com>' }), { ourEmail: OUR })).toBe(true);
  });
  it('is false for a customer message', () => {
    expect(gmailMessageFromMe(gm({ from: 'cust@example.com' }), { ourEmail: OUR })).toBe(false);
  });

  // #252: our own automated mail (marketing sends, "Quote viewed" alerts, the
  // escalation email, the EOD digest) sends from sales@mail.yulelovelights.com
  // — a subdomain of ourDomain, not an exact match.
  it('is true for a sender on a SUBDOMAIN of ourDomain (the live sales@mail.yulelovelights.com shape)', () => {
    expect(
      gmailMessageFromMe(gm({ from: 'Yule Love Lights <sales@mail.yulelovelights.com>' }), {
        ourEmail: OUR,
        ourDomain: 'yulelovelights.com',
      }),
    ).toBe(true);
  });

  // GMAIL_USER is a masked prod env var nobody here can read — the self-ingest
  // filter must hold even when ourDomain never got derived from it (falls back
  // to classify.ts's static internal-domain list).
  it('is true for our subdomain even when ourDomain is unset (GMAIL_USER-unset shape)', () => {
    expect(gmailMessageFromMe(gm({ from: 'sales@mail.yulelovelights.com' }), { ourEmail: 'me' })).toBe(true);
  });

  it('does NOT match a lookalike domain (notyulelovelights.com)', () => {
    expect(
      gmailMessageFromMe(gm({ from: 'anyone@notyulelovelights.com' }), { ourEmail: OUR, ourDomain: 'yulelovelights.com' }),
    ).toBe(false);
  });
});

describe('mapGmailThread — raw Gmail payload → GmailThreadLite', () => {
  it('maps an unanswered customer thread to inbound with the customer identity', () => {
    const raw: RawGmailThread = {
      id: 'thr-1',
      messages: [gm({ internalDate: '1782690000000', from: 'A Customer <cust@example.com>', subject: 'Quote?', snippet: 'Can I get a quote?' })],
    };
    const t = normalizeGmailThread(mapGmailThread(raw, { ourEmail: OUR }));
    expect(t.source).toBe('gmail');
    expect(t.externalId).toBe('thr-1');
    expect(t.direction).toBe('inbound');
    expect(t.subject).toBe('Quote?');
    expect(t.identity.emails).toEqual(['cust@example.com']);
    expect(t.identity.displayName).toBe('A Customer');
  });

  it('maps a replied thread to outbound (our SENT after the customer)', () => {
    const raw: RawGmailThread = {
      id: 'thr-2',
      messages: [
        gm({ internalDate: '1782690000000', from: 'cust@example.com', snippet: 'hi' }),
        gm({ internalDate: '1782693000000', labelIds: ['SENT'], from: OUR, snippet: 'replied' }),
      ],
    };
    expect(normalizeGmailThread(mapGmailThread(raw, { ourEmail: OUR })).direction).toBe('outbound');
  });

  it('never produces an Invalid Date from a malformed internalDate (would crash .toISOString)', () => {
    const raw: RawGmailThread = {
      id: 'thr-bad',
      messages: [gm({ internalDate: 'not-a-number', from: 'cust@example.com', snippet: 'hi' })],
    };
    const t = normalizeGmailThread(mapGmailThread(raw, { ourEmail: OUR }));
    expect(Number.isNaN(t.lastMessageAt.getTime())).toBe(false);
    expect(() => t.lastMessageAt.toISOString()).not.toThrow();
  });

  it('treats any sender on our domain as from-us (kills the escalation self-ingest)', () => {
    const raw = {
      id: 't1',
      messages: [
        { id: 'm1', labelIds: ['INBOX'], internalDate: '1000',
          payload: { headers: [{ name: 'From', value: 'Yule Love Lights <sales@yulelovelights.com>' }, { name: 'Subject', value: 'URGENT: 28 customer messages still unanswered' }] } },
      ],
    };
    const thread = mapGmailThread(raw, { ourEmail: 'info@yulelovelights.com', ourDomain: 'yulelovelights.com', internalAddrs: ['sales@yulelovelights.com'] });
    expect(thread.messages[0].fromMe).toBe(true);
  });

  it('sets hasListUnsubscribe true when any message has that header', () => {
    const raw: RawGmailThread = {
      id: 'thr-unsub',
      messages: [
        {
          id: 'm1',
          internalDate: '1782690000000',
          snippet: 'View online / Unsubscribe',
          payload: {
            headers: [
              { name: 'From', value: 'newsletter@marketing.com' },
              { name: 'Subject', value: 'Your weekly digest' },
              { name: 'List-Unsubscribe', value: '<mailto:unsub@marketing.com>' },
            ],
          },
        },
      ],
    };
    const mapped = mapGmailThread(raw, { ourEmail: OUR });
    expect(mapped.hasListUnsubscribe).toBe(true);
    expect(normalizeGmailThread(mapped).leadKind).toBe('automated');
  });

  it('sets hasListUnsubscribe false and leadKind lead for a normal customer thread', () => {
    const raw: RawGmailThread = {
      id: 'thr-cust',
      messages: [gm({ internalDate: '1782690000000', from: 'A Customer <cust@example.com>', subject: 'Quote request', snippet: 'Hi, can I get a quote?' })],
    };
    const mapped = mapGmailThread(raw, { ourEmail: OUR });
    expect(mapped.hasListUnsubscribe).toBe(false);
    expect(normalizeGmailThread(mapped).leadKind).toBe('lead');
  });
});

describe('normalizeGmailThread — #268 GML-Media lead-forward override', () => {
  // Synthetic — mirrors the real prod body shape (verified via Supabase for
  // #268) with a fake name/phone/email. Never real customer PII in git history.
  const GML_BODY =
    'Here ya go Naldoven: Jamie Test +15551234567 Email: jamie.test@example.com Street Address: 42 Fake Lane City: Faketown Areas to light up: Roof Line + Roof Ridges - (Premium Package)';

  const gmlThread = (over: Partial<GmailThreadLite> = {}) =>
    thread({
      from: { email: 'no-reply.fake123@zapiermail.com', name: 'GML Media' },
      subject: 'New Lead from GML Media - Jamie Test',
      messages: [msg(false, '2026-08-12T14:00:00Z', GML_BODY)],
      ...over,
    });

  it('classifies as lead even when the platform sets List-Unsubscribe (defeats classify.ts\'s bulk-mail heuristic)', () => {
    const t = normalizeGmailThread(gmlThread({ hasListUnsubscribe: true }));
    expect(t.leadKind).toBe('lead');
  });

  it('classifies as lead even when the sender is in the suppression set — the REAL prod blocker for the observed GML address (verified live: no-reply.mj1fi9@zapiermail.com IS in dashboard.suppressedSenders)', () => {
    const t = normalizeGmailThread(gmlThread(), new Set(['no-reply.fake123@zapiermail.com']));
    expect(t.leadKind).toBe('lead');
  });

  it('extracts identity from the PARSED CUSTOMER, not the GML Media forwarder sender', () => {
    const t = normalizeGmailThread(gmlThread());
    expect(t.identity.displayName).toBe('Jamie Test');
    expect(t.identity.emails).toEqual(['jamie.test@example.com']);
    expect(t.identity.phones).toEqual(['+15551234567']);
  });

  it('the SAME forward body from an UNKNOWN sender (not a known platform) is unaffected — falls through to normal classification', () => {
    const t = normalizeGmailThread(
      gmlThread({ from: { email: 'someone@unknown-relay.example.com', name: 'Someone' }, hasListUnsubscribe: true }),
    );
    expect(t.leadKind).toBe('automated'); // hasListUnsubscribe still governs — no platform matched, no override
    expect(t.identity.displayName).toBe('Someone'); // identity stays the sender's — no parse ran
  });

  it('a GML Media message with no parseable phone/email (fail-closed) falls through to unchanged classify/suppression behavior', () => {
    const t = normalizeGmailThread(
      gmlThread({
        messages: [msg(false, '2026-08-12T14:00:00Z', 'Thanks for using GML Media! Your monthly statement is attached.')],
        hasListUnsubscribe: true,
      }),
    );
    expect(t.leadKind).toBe('automated'); // no override fired — same as pre-#268 behavior
  });
});

describe('normalizeGmailThread — sender-suppression set (layer 3)', () => {
  it('classifies a suppressed sender as automated regardless of content', () => {
    const t = normalizeGmailThread(
      thread({ from: { email: 'spam@vendor.com', name: 'Vendor' } }),
      new Set(['spam@vendor.com']),
    );
    expect(t.leadKind).toBe('automated');
  });

  it('is case-insensitive when matching the suppressed email', () => {
    const t = normalizeGmailThread(
      thread({ from: { email: 'Spam@Vendor.com', name: 'Vendor' } }),
      new Set(['spam@vendor.com']),
    );
    expect(t.leadKind).toBe('automated');
  });

  it('classifies as lead when the sender is NOT in the suppressed set', () => {
    const t = normalizeGmailThread(
      thread({ from: { email: 'legit@customer.com', name: 'Legit Customer' } }),
      new Set(['spam@vendor.com']),
    );
    expect(t.leadKind).toBe('lead');
  });

  it('classifies normally (by content) when suppressed set is undefined', () => {
    // no suppressed arg — should fall through to classifyMessage
    const t = normalizeGmailThread(thread({ from: { email: 'spam@vendor.com', name: 'Vendor' } }));
    expect(t.leadKind).toBe('lead'); // no automated signals in the default thread fixture
  });

  it('classifies normally when suppressed set is empty', () => {
    const t = normalizeGmailThread(thread({ from: { email: 'spam@vendor.com', name: 'Vendor' } }), new Set());
    expect(t.leadKind).toBe('lead');
  });
});
