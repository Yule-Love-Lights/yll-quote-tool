import { describe, it, expect } from 'vitest';
import {
  gmailNeedsReply,
  normalizeGmailThread,
  normalizeGmailThreadTouches,
  parseEmailAddress,
  gmailMessageFromMe,
  mapGmailThread,
} from './gmail';
import type { GmailMessageLite, GmailThreadLite, RawGmailThread } from './gmail';

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

  // #268 fix round 3 (LOW 1): the top-of-file "residual, accepted risk" note
  // names the worst case as contamination of an EXISTING contact (a forged
  // template whose phone matches a real customer's, paired with an
  // attacker-chosen email). This module's boundary is faithfully reporting
  // what the message says — it never looks up or merges with any existing
  // contact. Whether a phone match against an existing dashboard_contacts
  // row causes a union is identity.ts's resolveIdentity/appendIdentifiers +
  // store.ts's ingestTouch (both out of this module's reach, and store.ts is
  // embargoed this round) — pin that this layer's output IS the forged
  // identity verbatim, not that it's safe end-to-end.
  it('a forged both-legs message whose phone matches a known real customer produces a touch identity that IS the forged data — the union/merge decision is downstream, not here', () => {
    const KNOWN_CUSTOMER_PHONE = '+15551234567'; // stands in for a real existing contact's phone
    const forgedBody = `Here ya go Naldoven: Totally Legit ${KNOWN_CUSTOMER_PHONE} Email: attacker@evil.example.com`;
    const t = normalizeGmailThread(gmlThread({ messages: [msg(false, '2026-08-12T14:00:00Z', forgedBody)] }));
    expect(t.leadKind).toBe('lead');
    expect(t.identity.phones).toEqual([KNOWN_CUSTOMER_PHONE]);
    expect(t.identity.emails).toEqual(['attacker@evil.example.com']);
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

describe('mapGmailThread — per-message id/fromEmail/fromName (#288)', () => {
  it("carries the raw message id and this message's own From address/display name", () => {
    const raw: RawGmailThread = {
      id: 'thr-per-msg',
      messages: [
        gm({
          internalDate: '1782690000000',
          from: 'A Customer <cust@example.com>',
          subject: 'Quote?',
          snippet: 'Can I get a quote?',
        }),
      ],
    };
    const mapped = mapGmailThread(raw, { ourEmail: OUR });
    expect(mapped.messages[0].id).toBe('m-1782690000000');
    expect(mapped.messages[0].fromEmail).toBe('cust@example.com');
    expect(mapped.messages[0].fromName).toBe('A Customer');
  });

  it('leaves fromEmail/fromName null when the message has no From header', () => {
    const raw: RawGmailThread = { id: 'thr-no-from', messages: [{ id: 'm1', internalDate: '1000', payload: { headers: [] } }] };
    const mapped = mapGmailThread(raw, { ourEmail: OUR });
    expect(mapped.messages[0].fromEmail).toBeNull();
    expect(mapped.messages[0].fromName).toBeNull();
  });
});

// #288: Zapier's GML Media relay reuses the exact same subject ("New Lead from
// GML Media!") for EVERY forwarded lead, so Gmail coalesces DISTINCT customers'
// forwards into ONE thread. normalizeGmailThread (above) is thread-level: it
// collapses a multi-customer thread into a single touch keyed by threadId, so
// every customer after the first gets no item/contact, and the surviving item's
// preview/identity drift toward whichever message is thread-latest.
// normalizeGmailThreadTouches is the per-message-aware sibling — see its doc
// comment in gmail.ts for the full design.
describe('normalizeGmailThreadTouches — per-message split for coalesced GML threads (#288)', () => {
  // Synthetic fixtures only — never real customer PII (repo precedent, #268).
  const GML_FROM_EMAIL = 'no-reply.fake123@zapiermail.com';
  const GML_FROM_NAME = 'GML Media';

  function gmlMsg(over: {
    iso: string;
    id?: string;
    body: string;
    fromMe?: boolean;
    fromEmail?: string | null;
    fromName?: string | null;
  }): GmailMessageLite {
    return {
      fromMe: over.fromMe ?? false,
      at: new Date(over.iso),
      snippet: over.body,
      id: over.id,
      fromEmail: over.fromEmail === undefined ? GML_FROM_EMAIL : over.fromEmail,
      fromName: over.fromName === undefined ? GML_FROM_NAME : over.fromName,
    };
  }

  function gmlThreadLite(messages: GmailMessageLite[], over: Partial<GmailThreadLite> = {}): GmailThreadLite {
    return {
      threadId: 'thr-gml',
      subject: 'New Lead from GML Media!',
      from: { email: GML_FROM_EMAIL, name: GML_FROM_NAME },
      hasListUnsubscribe: false,
      messages,
      ...over,
    };
  }

  const ALICE_BODY =
    'Here ya go Naldoven: Alice Anderson +15550001111 Email: alice@example.com Street Address: 1 Test Rd City: Testville Areas to light up: Roofline';
  const BOB_BODY =
    'Here ya go Naldoven: Bob Baker +15550002222 Email: bob@example.com Street Address: 2 Test Rd City: Testville Areas to light up: Roofline';
  const CAROL_BODY =
    'Here ya go Naldoven: Carol Clark +15550003333 Email: carol@example.com Street Address: 3 Test Rd City: Testville Areas to light up: Roofline';

  it('(b) a non-GML thread returns exactly [normalizeGmailThread(thread)] — unchanged single-touch shape', () => {
    const t = thread();
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toEqual([normalizeGmailThread(t)]);
  });

  it('a thread with zero parseable lead-forward messages (no known platform at all) also falls through unchanged', () => {
    const t = thread({ messages: [msg(false, '2026-08-01T10:00:00Z', 'Just a normal reply, thanks!')] });
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toEqual([normalizeGmailThread(t)]);
  });

  it("(c) a single GML forward → one touch, bare threadId, identity from the parsed customer (today's single-customer outcome preserved)", () => {
    const t = gmlThreadLite([gmlMsg({ iso: '2026-08-12T14:00:00Z', id: 'm1', body: ALICE_BODY })]);
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1);
    expect(touches[0].source).toBe('gmail');
    expect(touches[0].externalId).toBe('thr-gml');
    expect(touches[0].direction).toBe('inbound');
    expect(touches[0].channel).toBe('email');
    expect(touches[0].leadKind).toBe('lead');
    expect(touches[0].subject).toBe('New Lead from GML Media!');
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
    expect(touches[0].identity.emails).toEqual(['alice@example.com']);
    expect(touches[0].identity.phones).toEqual(['+15550001111']);
  });

  it('(d) three forwards from three distinct customers coalesced onto one thread → three touches, each independently keyed/identified, sorted chronologically regardless of input order', () => {
    const t = gmlThreadLite([
      // Deliberately out of chronological order to prove the function sorts
      // rather than trusting message array order.
      gmlMsg({ iso: '2026-08-14T09:00:00Z', id: 'm3', body: CAROL_BODY }),
      gmlMsg({ iso: '2026-08-12T09:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({ iso: '2026-08-13T09:00:00Z', id: 'm2', body: BOB_BODY }),
    ]);
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(3);

    // Earliest keeps the bare threadId (continuity with any existing prod row).
    expect(touches[0].externalId).toBe('thr-gml');
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
    expect(touches[0].lastMessageAt.toISOString()).toBe('2026-08-12T09:00:00.000Z');
    expect(touches[0].preview).toBe(ALICE_BODY);
    expect(touches[0].sourceMessageId).toBe('m1');

    // Later ones get a composite external_id, never seen before → new item + new contact.
    expect(touches[1].externalId).toBe('thr-gml:m2');
    expect(touches[1].identity.displayName).toBe('Bob Baker');
    expect(touches[1].identity.emails).toEqual(['bob@example.com']);
    expect(touches[1].lastMessageAt.toISOString()).toBe('2026-08-13T09:00:00.000Z');
    expect(touches[1].preview).toBe(BOB_BODY);

    expect(touches[2].externalId).toBe('thr-gml:m3');
    expect(touches[2].identity.displayName).toBe('Carol Clark');
    expect(touches[2].identity.emails).toEqual(['carol@example.com']);
    expect(touches[2].lastMessageAt.toISOString()).toBe('2026-08-14T09:00:00.000Z');
    expect(touches[2].preview).toBe(CAROL_BODY);

    for (const touch of touches) {
      expect(touch.direction).toBe('inbound');
      expect(touch.leadKind).toBe('lead');
      expect(touch.channel).toBe('email');
      expect(touch.subject).toBe('New Lead from GML Media!');
      expect(touch.source).toBe('gmail');
    }
  });

  it('(e) our own fromMe reaction after a forward is never a split candidate, and does not flip the forward to outbound/answered', () => {
    const REACTION_BODY =
      '🎄 Yule Love Lights Sales reacted via Gmail On Wed, Aug 12, 2026 at 2:46 PM GML Media &lt;no-reply.fake123@zapiermail.com&gt; wrote: ' +
      ALICE_BODY;
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T14:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({
        iso: '2026-08-12T15:00:00Z',
        id: 'm2',
        body: REACTION_BODY,
        fromMe: true,
        fromEmail: 'sales@yulelovelights.com',
        fromName: 'Yule Love Lights Sales',
      }),
    ]);

    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1); // the reaction itself is not a touch
    expect(touches[0].externalId).toBe('thr-gml');
    expect(touches[0].direction).toBe('inbound'); // NOT auto-resolved by the later fromMe message
    expect(touches[0].identity.displayName).toBe('Alice Anderson');

    // Contrast: today's thread-level function, given this SAME thread, marks it
    // outbound/answered because the reaction is chronologically the last
    // message — exactly the bug this split exists to avoid for a real customer.
    expect(normalizeGmailThread(t).direction).toBe('outbound');
  });

  it('(f) a platform message that fails the template parse (a receipt) is not a touch, even alongside a real forward on the same thread', () => {
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T14:00:00Z', id: 'm1', body: ALICE_BODY }),
      gmlMsg({ iso: '2026-08-12T16:00:00Z', id: 'm2', body: 'Thanks for using GML Media! Your monthly statement is attached.' }),
    ]);
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1);
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
  });

  it('a later (non-earliest) parsed message with no id is skipped defensively rather than minting an unstable key', () => {
    const t = gmlThreadLite([
      gmlMsg({ iso: '2026-08-12T09:00:00Z', id: 'm1', body: ALICE_BODY }),
      { fromMe: false, at: new Date('2026-08-13T09:00:00Z'), snippet: BOB_BODY, fromEmail: GML_FROM_EMAIL, fromName: GML_FROM_NAME }, // no id
    ]);
    const touches = normalizeGmailThreadTouches(t);
    expect(touches).toHaveLength(1);
    expect(touches[0].identity.displayName).toBe('Alice Anderson');
  });
});
